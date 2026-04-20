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
	const configuredApiKey = override.apiKey?.trim();
	const envApiKey = getEnvApiKey(provider);
	const apiKey = configuredApiKey || envApiKey;

	return {
		...(apiKey ? { apiKey } : {}),
		apiKeySource: configuredApiKey ? "config" : envApiKey ? "env" : "none",
		...(override.apiBase?.trim() ? { apiBase: override.apiBase.trim() } : {}),
		...(override.headers && Object.keys(override.headers).length > 0
			? { headers: override.headers }
			: {}),
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
