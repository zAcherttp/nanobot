import { promises as fs } from "node:fs";
import path from "node:path";
import { getProviders } from "@mariozechner/pi-ai";
import dotenv from "dotenv";
import { z } from "zod";
import {
	isNanobotFauxProvider,
	NANOBOT_FAUX_PROVIDER,
} from "../providers/faux.js";
import {
	DEFAULT_CONFIG_FILENAME,
	DEFAULT_WORKSPACE_PATH,
	resolveConfigPath,
	resolveWorkspacePath,
} from "./paths.js";
import type { AppConfig, LogLevel, ProviderOverrideConfig } from "./schema.js";

dotenv.config({ quiet: true });

export const DEFAULT_GATEWAY_PORT = 18790;
export const DEFAULT_HEARTBEAT_ENABLED = true;
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30 * 60;
export const DEFAULT_HEARTBEAT_KEEP_RECENT_MESSAGES = 8;
export const DEFAULT_AGENT_PROVIDER = "anthropic";
export const DEFAULT_AGENT_MODEL_ID = "claude-opus-4-5";
export const DEFAULT_AGENT_SYSTEM_PROMPT =
	"You are nanobot, a personal AI assistant.";
export const DEFAULT_AGENT_SKILLS: string[] = [];
export const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 65_536;
export const DEFAULT_AGENT_DREAM_INTERVAL_HOURS = 2;
export const DEFAULT_AGENT_DREAM_MAX_BATCH_SIZE = 20;
export const DEFAULT_AGENT_DREAM_MAX_ITERATIONS = 10;
export const DEFAULT_AGENT_THINKING_LEVEL = "off";
export const DEFAULT_AGENT_TEMPERATURE = 0.1;
export const DEFAULT_AGENT_MAX_TOKENS = 8192;
export const DEFAULT_AGENT_TOOL_EXECUTION = "parallel";
export const DEFAULT_AGENT_TRANSPORT = "sse";
export const DEFAULT_AGENT_MAX_RETRY_DELAY_MS = 60_000;
export const DEFAULT_AGENT_SESSION_STORE_PATH = "sessions";
export const DEFAULT_AGENT_SESSION_STORE_MAX_MESSAGES = 500;
export const DEFAULT_AGENT_SESSION_STORE_MAX_PERSISTED_TEXT_CHARS = 16_000;
export const DEFAULT_AGENT_SESSION_STORE_QUARANTINE_CORRUPT_FILES = true;
export const DEFAULT_CRON_ENABLED = true;
export const DEFAULT_CRON_PATH = path.join("cron", "jobs.json");
export const DEFAULT_CRON_TIMEZONE = "UTC";
export const DEFAULT_CRON_MAX_RUN_HISTORY = 20;
export const DEFAULT_CRON_MAX_SLEEP_MS = 300_000;
export const DEFAULT_SECURITY_RESTRICT_TO_WORKSPACE = false;
export const DEFAULT_SECURITY_ALLOWED_ENV_KEYS: string[] = [];
export const DEFAULT_SECURITY_SSRF_WHITELIST: string[] = [];

const LOG_LEVELS = [
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace",
] as const;
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
const TOOL_EXECUTION_MODES = ["parallel", "sequential"] as const;
const TRANSPORTS = ["sse", "websocket", "auto"] as const;
const PROVIDERS = getProviders();
const SUPPORTED_AGENT_PROVIDERS = new Set<string>([
	...PROVIDERS,
	NANOBOT_FAUX_PROVIDER,
]);

const appConfigSchema = z.object({
	workspace: z
		.object({
			path: z.string().default(DEFAULT_WORKSPACE_PATH),
		})
		.default({ path: DEFAULT_WORKSPACE_PATH }),
	gateway: z
		.object({
			port: z.number().int().positive().default(DEFAULT_GATEWAY_PORT),
			heartbeat: z
				.object({
					enabled: z.boolean().default(DEFAULT_HEARTBEAT_ENABLED),
					intervalSeconds: z
						.number()
						.int()
						.positive()
						.default(DEFAULT_HEARTBEAT_INTERVAL_SECONDS),
					keepRecentMessages: z
						.number()
						.int()
						.positive()
						.default(DEFAULT_HEARTBEAT_KEEP_RECENT_MESSAGES),
				})
				.default({
					enabled: DEFAULT_HEARTBEAT_ENABLED,
					intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
					keepRecentMessages: DEFAULT_HEARTBEAT_KEEP_RECENT_MESSAGES,
				}),
		})
		.default({
			port: DEFAULT_GATEWAY_PORT,
			heartbeat: {
				enabled: DEFAULT_HEARTBEAT_ENABLED,
				intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
				keepRecentMessages: DEFAULT_HEARTBEAT_KEEP_RECENT_MESSAGES,
			},
		}),
	cron: z
		.object({
			enabled: z.boolean().default(DEFAULT_CRON_ENABLED),
			path: z.string().default(DEFAULT_CRON_PATH),
			timezone: z.string().default(DEFAULT_CRON_TIMEZONE),
			maxRunHistory: z
				.number()
				.int()
				.positive()
				.default(DEFAULT_CRON_MAX_RUN_HISTORY),
			maxSleepMs: z
				.number()
				.int()
				.positive()
				.default(DEFAULT_CRON_MAX_SLEEP_MS),
		})
		.default({
			enabled: DEFAULT_CRON_ENABLED,
			path: DEFAULT_CRON_PATH,
			timezone: DEFAULT_CRON_TIMEZONE,
			maxRunHistory: DEFAULT_CRON_MAX_RUN_HISTORY,
			maxSleepMs: DEFAULT_CRON_MAX_SLEEP_MS,
		}),
	channels: z
		.object({
			telegram: z
				.object({
					enabled: z.boolean().default(false),
					token: z.string().default(""),
					allowFrom: z.array(z.string()).default([]),
					chatIds: z.array(z.string()).default([]),
					streaming: z.boolean().default(true),
				})
				.default({
					enabled: false,
					token: "",
					allowFrom: [],
					chatIds: [],
					streaming: true,
				}),
		})
		.default({
			telegram: {
				enabled: false,
				token: "",
				allowFrom: [],
				chatIds: [],
				streaming: true,
			},
		}),
	providers: z
		.record(
			z.string(),
			z.object({
				apiKey: z.string().optional(),
				apiBase: z.string().optional(),
				headers: z.record(z.string(), z.string()).optional(),
			}),
		)
		.default({}),
	security: z
		.object({
			restrictToWorkspace: z
				.boolean()
				.default(DEFAULT_SECURITY_RESTRICT_TO_WORKSPACE),
			allowedEnvKeys: z
				.array(z.string())
				.default(DEFAULT_SECURITY_ALLOWED_ENV_KEYS),
			ssrfWhitelist: z
				.array(z.string())
				.default(DEFAULT_SECURITY_SSRF_WHITELIST),
		})
		.default({
			restrictToWorkspace: DEFAULT_SECURITY_RESTRICT_TO_WORKSPACE,
			allowedEnvKeys: DEFAULT_SECURITY_ALLOWED_ENV_KEYS,
			ssrfWhitelist: DEFAULT_SECURITY_SSRF_WHITELIST,
		}),
	agent: z
		.object({
			provider: z
				.string()
				.refine((value) => SUPPORTED_AGENT_PROVIDERS.has(value), {
					message: "Unsupported agent provider.",
				})
				.default(DEFAULT_AGENT_PROVIDER),
			modelId: z.string().default(DEFAULT_AGENT_MODEL_ID),
			systemPrompt: z.string().default(DEFAULT_AGENT_SYSTEM_PROMPT),
			skills: z.array(z.string()).default(DEFAULT_AGENT_SKILLS),
			contextWindowTokens: z
				.number()
				.int()
				.positive()
				.default(DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS),
			dream: z
				.object({
					intervalHours: z
						.number()
						.int()
						.positive()
						.default(DEFAULT_AGENT_DREAM_INTERVAL_HOURS),
					maxBatchSize: z
						.number()
						.int()
						.positive()
						.default(DEFAULT_AGENT_DREAM_MAX_BATCH_SIZE),
					maxIterations: z
						.number()
						.int()
						.positive()
						.default(DEFAULT_AGENT_DREAM_MAX_ITERATIONS),
				})
				.default({
					intervalHours: DEFAULT_AGENT_DREAM_INTERVAL_HOURS,
					maxBatchSize: DEFAULT_AGENT_DREAM_MAX_BATCH_SIZE,
					maxIterations: DEFAULT_AGENT_DREAM_MAX_ITERATIONS,
				}),
			thinkingLevel: z
				.enum(THINKING_LEVELS)
				.default(DEFAULT_AGENT_THINKING_LEVEL),
			temperature: z.number().min(0).max(2).default(DEFAULT_AGENT_TEMPERATURE),
			maxTokens: z.number().int().positive().default(DEFAULT_AGENT_MAX_TOKENS),
			toolExecution: z
				.enum(TOOL_EXECUTION_MODES)
				.default(DEFAULT_AGENT_TOOL_EXECUTION),
			transport: z.enum(TRANSPORTS).default(DEFAULT_AGENT_TRANSPORT),
			maxRetryDelayMs: z
				.number()
				.int()
				.min(0)
				.default(DEFAULT_AGENT_MAX_RETRY_DELAY_MS),
			sessionStore: z
				.object({
					type: z.literal("file").default("file"),
					path: z.string().default(DEFAULT_AGENT_SESSION_STORE_PATH),
					maxMessages: z
						.number()
						.int()
						.positive()
						.default(DEFAULT_AGENT_SESSION_STORE_MAX_MESSAGES),
					maxPersistedTextChars: z
						.number()
						.int()
						.positive()
						.default(DEFAULT_AGENT_SESSION_STORE_MAX_PERSISTED_TEXT_CHARS),
					quarantineCorruptFiles: z
						.boolean()
						.default(DEFAULT_AGENT_SESSION_STORE_QUARANTINE_CORRUPT_FILES),
				})
				.default({
					type: "file",
					path: DEFAULT_AGENT_SESSION_STORE_PATH,
					maxMessages: DEFAULT_AGENT_SESSION_STORE_MAX_MESSAGES,
					maxPersistedTextChars:
						DEFAULT_AGENT_SESSION_STORE_MAX_PERSISTED_TEXT_CHARS,
					quarantineCorruptFiles:
						DEFAULT_AGENT_SESSION_STORE_QUARANTINE_CORRUPT_FILES,
				}),
		})
		.default({
			provider: DEFAULT_AGENT_PROVIDER,
			modelId: DEFAULT_AGENT_MODEL_ID,
			systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
			skills: DEFAULT_AGENT_SKILLS,
			contextWindowTokens: DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
			dream: {
				intervalHours: DEFAULT_AGENT_DREAM_INTERVAL_HOURS,
				maxBatchSize: DEFAULT_AGENT_DREAM_MAX_BATCH_SIZE,
				maxIterations: DEFAULT_AGENT_DREAM_MAX_ITERATIONS,
			},
			thinkingLevel: DEFAULT_AGENT_THINKING_LEVEL,
			temperature: DEFAULT_AGENT_TEMPERATURE,
			maxTokens: DEFAULT_AGENT_MAX_TOKENS,
			toolExecution: DEFAULT_AGENT_TOOL_EXECUTION,
			transport: DEFAULT_AGENT_TRANSPORT,
			maxRetryDelayMs: DEFAULT_AGENT_MAX_RETRY_DELAY_MS,
			sessionStore: {
				type: "file",
				path: DEFAULT_AGENT_SESSION_STORE_PATH,
				maxMessages: DEFAULT_AGENT_SESSION_STORE_MAX_MESSAGES,
				maxPersistedTextChars:
					DEFAULT_AGENT_SESSION_STORE_MAX_PERSISTED_TEXT_CHARS,
				quarantineCorruptFiles:
					DEFAULT_AGENT_SESSION_STORE_QUARANTINE_CORRUPT_FILES,
			},
		}),
	logging: z
		.object({
			level: z.enum(LOG_LEVELS).default("info"),
		})
		.default({
			level: "info",
		}),
});

export {
	DEFAULT_CONFIG_FILENAME,
	DEFAULT_WORKSPACE_PATH,
	resolveConfigPath,
	resolveWorkspacePath,
};

export const DEFAULT_CONFIG: AppConfig = {
	workspace: {
		path: DEFAULT_WORKSPACE_PATH,
	},
	gateway: {
		port: DEFAULT_GATEWAY_PORT,
		heartbeat: {
			enabled: DEFAULT_HEARTBEAT_ENABLED,
			intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
			keepRecentMessages: DEFAULT_HEARTBEAT_KEEP_RECENT_MESSAGES,
		},
	},
	cron: {
		enabled: DEFAULT_CRON_ENABLED,
		path: DEFAULT_CRON_PATH,
		timezone: DEFAULT_CRON_TIMEZONE,
		maxRunHistory: DEFAULT_CRON_MAX_RUN_HISTORY,
		maxSleepMs: DEFAULT_CRON_MAX_SLEEP_MS,
	},
	channels: {
		telegram: {
			enabled: false,
			token: "",
			allowFrom: [],
			chatIds: [],
			streaming: true,
		},
	},
	providers: {},
	security: {
		restrictToWorkspace: DEFAULT_SECURITY_RESTRICT_TO_WORKSPACE,
		allowedEnvKeys: DEFAULT_SECURITY_ALLOWED_ENV_KEYS,
		ssrfWhitelist: DEFAULT_SECURITY_SSRF_WHITELIST,
	},
	agent: {
		provider: DEFAULT_AGENT_PROVIDER,
		modelId: DEFAULT_AGENT_MODEL_ID,
		systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
		skills: DEFAULT_AGENT_SKILLS,
		contextWindowTokens: DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
		dream: {
			intervalHours: DEFAULT_AGENT_DREAM_INTERVAL_HOURS,
			maxBatchSize: DEFAULT_AGENT_DREAM_MAX_BATCH_SIZE,
			maxIterations: DEFAULT_AGENT_DREAM_MAX_ITERATIONS,
		},
		thinkingLevel: DEFAULT_AGENT_THINKING_LEVEL,
		temperature: DEFAULT_AGENT_TEMPERATURE,
		maxTokens: DEFAULT_AGENT_MAX_TOKENS,
		toolExecution: DEFAULT_AGENT_TOOL_EXECUTION,
		transport: DEFAULT_AGENT_TRANSPORT,
		maxRetryDelayMs: DEFAULT_AGENT_MAX_RETRY_DELAY_MS,
		sessionStore: {
			type: "file",
			path: DEFAULT_AGENT_SESSION_STORE_PATH,
			maxMessages: DEFAULT_AGENT_SESSION_STORE_MAX_MESSAGES,
			maxPersistedTextChars:
				DEFAULT_AGENT_SESSION_STORE_MAX_PERSISTED_TEXT_CHARS,
			quarantineCorruptFiles:
				DEFAULT_AGENT_SESSION_STORE_QUARANTINE_CORRUPT_FILES,
		},
	},
	logging: {
		level: "info",
	},
};

export async function initConfigFile(targetPath?: string): Promise<string> {
	return saveConfig(DEFAULT_CONFIG, targetPath);
}

export async function loadConfig(
	options: { cliConfigPath?: string; telegramTokenOverride?: string } = {},
): Promise<{ config: AppConfig; path: string }> {
	const resolvedPath = resolveConfigPath(options.cliConfigPath);
	const raw = await fs.readFile(resolvedPath, "utf8");
	const parsedRaw = JSON.parse(raw) as Record<string, unknown>;
	const parsed = appConfigSchema.parse(resolveConfigEnvVars(parsedRaw));

	const envToken = process.env.NANOBOT_TS_TELEGRAM_TOKEN;
	const envLogLevel = process.env.NANOBOT_TS_LOG_LEVEL as LogLevel | undefined;

	const config: AppConfig = {
		...parsed,
		workspace: {
			path: resolveWorkspacePath(
				parsed.workspace.path,
				path.dirname(resolvedPath),
			),
		},
		cron: {
			...parsed.cron,
			path: resolveWorkspacePath(
				parsed.cron.path,
				resolveWorkspacePath(parsed.workspace.path, path.dirname(resolvedPath)),
			),
		},
		agent: {
			...parsed.agent,
			provider: parsed.agent.provider as AppConfig["agent"]["provider"],
			sessionStore: {
				...parsed.agent.sessionStore,
				path: resolveWorkspacePath(
					parsed.agent.sessionStore.path,
					resolveWorkspacePath(
						parsed.workspace.path,
						path.dirname(resolvedPath),
					),
				),
			},
		},
		channels: {
			telegram: {
				...parsed.channels.telegram,
				token:
					options.telegramTokenOverride ??
					envToken ??
					parsed.channels.telegram.token,
			},
		},
		providers: normalizeProviderOverrides(parsed.providers),
		security: {
			restrictToWorkspace: parsed.security.restrictToWorkspace,
			allowedEnvKeys: parsed.security.allowedEnvKeys.map((key) => key.trim()),
			ssrfWhitelist: parsed.security.ssrfWhitelist.map((cidr) => cidr.trim()),
		},
		logging: {
			level: envLogLevel ?? parsed.logging.level,
		},
	};

	validateRuntimeConfig(config);
	return { config, path: resolvedPath };
}

export function isSenderAllowed(
	allowFrom: string[],
	senderId: string,
): boolean {
	return allowFrom.includes("*") || allowFrom.includes(senderId);
}

export function validateRuntimeConfig(config: AppConfig): void {
	if (
		config.channels.telegram.enabled &&
		!config.channels.telegram.token.trim()
	) {
		throw new Error(
			"Telegram token is required when channels.telegram.enabled=true",
		);
	}
	if (!LOG_LEVELS.includes(config.logging.level)) {
		throw new Error(`Invalid log level: ${config.logging.level}`);
	}
	if (
		!SUPPORTED_AGENT_PROVIDERS.has(config.agent.provider) &&
		!isNanobotFauxProvider(config.agent.provider)
	) {
		throw new Error(`Unsupported agent provider: ${config.agent.provider}`);
	}
	if (!config.cron.timezone.trim()) {
		throw new Error("Cron timezone is required.");
	}
	if (
		config.channels.telegram.enabled &&
		config.channels.telegram.allowFrom.length === 0
	) {
		throw new Error(
			'Enabled channel "telegram" has empty allowFrom (denies all). Set ["*"] to allow everyone, or add specific sender IDs.',
		);
	}
	if (config.gateway.heartbeat.intervalSeconds <= 0) {
		throw new Error("Heartbeat intervalSeconds must be positive.");
	}
	if (config.security.allowedEnvKeys.some((key) => key.length === 0)) {
		throw new Error("security.allowedEnvKeys cannot contain empty entries.");
	}
	if (config.security.ssrfWhitelist.some((cidr) => cidr.length === 0)) {
		throw new Error("security.ssrfWhitelist cannot contain empty entries.");
	}
}

export async function saveConfig(
	config: AppConfig,
	targetPath?: string,
): Promise<string> {
	const resolvedPath = resolveConfigPath(targetPath);
	validateRuntimeConfig(config);
	await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
	await fs.writeFile(
		resolvedPath,
		`${JSON.stringify(config, null, 2)}\n`,
		"utf8",
	);
	return resolvedPath;
}

function resolveConfigEnvVars(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return resolveEnvVars(value) as Record<string, unknown>;
}

function resolveEnvVars(value: unknown): unknown {
	if (typeof value === "string") {
		return value.replace(
			/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
			(_match, name: string) => {
				const resolved = process.env[name];
				if (resolved === undefined) {
					throw new Error(
						`Environment variable '${name}' referenced in config is not set.`,
					);
				}
				return resolved;
			},
		);
	}

	if (Array.isArray(value)) {
		return value.map((entry) => resolveEnvVars(entry));
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, resolveEnvVars(entry)]),
		);
	}

	return value;
}

function normalizeProviderOverrides(
	providers: Record<
		string,
		{
			apiKey?: string | undefined;
			apiBase?: string | undefined;
			headers?: Record<string, string> | undefined;
		}
	>,
): AppConfig["providers"] {
	return Object.fromEntries(
		Object.entries(providers).map(([provider, settings]) => [
			provider,
			{
				...(settings.apiKey?.trim() ? { apiKey: settings.apiKey.trim() } : {}),
				...(settings.apiBase?.trim()
					? { apiBase: settings.apiBase.trim() }
					: {}),
				...(settings.headers && Object.keys(settings.headers).length > 0
					? { headers: settings.headers }
					: {}),
			} satisfies ProviderOverrideConfig,
		]),
	);
}
