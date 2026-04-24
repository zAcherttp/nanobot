import {
	type Api,
	getEnvApiKey,
	getModel,
	getModels,
	type KnownProvider,
	type Model,
} from "@mariozechner/pi-ai";
import type { AppConfig, ProviderOverrideConfig } from "../config/schema.js";
import { ensureNanobotFauxProvider, isNanobotFauxProvider } from "./faux.js";

export const OLLAMA_PROVIDER = "ollama";
export const OLLAMA_DEFAULT_BASE_URL = "https://ollama.com/v1";
export const OLLAMA_DEFAULT_MAX_TOKENS = 32_000;

const API_KEY_REQUIRED_PROVIDERS = new Set<AppConfig["agent"]["provider"]>([
	"anthropic",
	"google",
	"openai",
	"azure-openai-responses",
	"xai",
	"groq",
	"cerebras",
	"openrouter",
	"vercel-ai-gateway",
	"zai",
	"mistral",
	"minimax",
	"minimax-cn",
	"huggingface",
	"kimi-coding",
	OLLAMA_PROVIDER,
]);

export interface ResolvedProviderConfig {
	apiKey?: string;
	apiKeySource: "config" | "env" | "none";
	apiBase?: string;
	headers?: Record<string, string>;
}

export function providerRequiresApiKey(
	provider: AppConfig["agent"]["provider"],
): boolean {
	if (isNanobotFauxProvider(provider)) {
		return false;
	}

	return API_KEY_REQUIRED_PROVIDERS.has(provider);
}

export function getProviderOverride(
	config: AppConfig,
	provider: string,
): ProviderOverrideConfig {
	return config.providers[provider] ?? {};
}

export function resolveProviderConfig(
	config: AppConfig,
	provider: AppConfig["agent"]["provider"],
): ResolvedProviderConfig {
	const override = getProviderOverride(config, provider);
	const configuredApiKey =
		typeof override.apiKey === "string" ? override.apiKey.trim() : "";
	const envApiKey = getEnvApiKey(provider);
	const apiKey = configuredApiKey || envApiKey;
	const apiBase =
		typeof override.apiBase === "string" ? override.apiBase.trim() : "";
	const headers = {
		...(override.headers ?? {}),
		...(override.extraHeaders ?? {}),
	};

	return {
		...(apiKey ? { apiKey } : {}),
		apiKeySource: configuredApiKey ? "config" : envApiKey ? "env" : "none",
		...(apiBase ? { apiBase } : {}),
		...(Object.keys(headers).length > 0 ? { headers } : {}),
	};
}

export function resolveProviderModel(
	config: AppConfig,
	provider: AppConfig["agent"]["provider"],
	modelId: string,
): {
	model: Model<Api>;
	providerConfig: ResolvedProviderConfig;
} {
	if (isNanobotFauxProvider(provider)) {
		const registration = ensureNanobotFauxProvider();
		const fauxModel = registration.getModel(modelId);
		if (!fauxModel) {
			throw new Error(
				`Unknown modelId '${modelId}' for provider '${provider}'.`,
			);
		}

		return {
			model: fauxModel as Model<Api>,
			providerConfig: {
				apiKeySource: "none",
			},
		};
	}

	if (provider === OLLAMA_PROVIDER) {
		const providerConfig = resolveProviderConfig(config, provider);
		return {
			model: applyProviderOverrides(
				createOllamaModel(modelId),
				providerConfig.apiBase
					? providerConfig
					: {
							...providerConfig,
							apiBase: OLLAMA_DEFAULT_BASE_URL,
						},
			),
			providerConfig,
		};
	}

	const builtInProvider = provider as KnownProvider;
	const availableModel = getModels(builtInProvider).find(
		(candidate) => candidate.id === modelId,
	);
	if (!availableModel) {
		throw new Error(`Unknown modelId '${modelId}' for provider '${provider}'.`);
	}

	const baseModel = getModel(builtInProvider, modelId as never) as Model<Api>;
	const providerConfig = resolveProviderConfig(config, provider);

	return {
		model: applyProviderOverrides(baseModel, providerConfig),
		providerConfig,
	};
}

function createOllamaModel(modelId: string): Model<"openai-completions"> {
	return {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: OLLAMA_PROVIDER,
		baseUrl: OLLAMA_DEFAULT_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 131_072,
		maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		},
	};
}

function applyProviderOverrides(
	model: Model<Api>,
	providerConfig: ResolvedProviderConfig,
): Model<Api> {
	return {
		...model,
		...(providerConfig.apiBase ? { baseUrl: providerConfig.apiBase } : {}),
		...(providerConfig.headers
			? {
					headers: {
						...(model.headers ?? {}),
						...providerConfig.headers,
					},
				}
			: {}),
	};
}
