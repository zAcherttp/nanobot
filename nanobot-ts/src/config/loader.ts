import { promises as fs } from "node:fs";
import path from "node:path";
import { getProviders } from "@mariozechner/pi-ai";
import dotenv from "dotenv";
import { z } from "zod";
import {
	DEFAULT_CONFIG_FILENAME,
	DEFAULT_WORKSPACE_PATH,
	resolveConfigPath,
	resolveWorkspacePath,
} from "./paths.js";
import type { AppConfig, LogLevel } from "./schema.js";

dotenv.config({ quiet: true });

export const DEFAULT_GATEWAY_PORT = 18790;
export const DEFAULT_AGENT_PROVIDER = "anthropic";
export const DEFAULT_AGENT_MODEL_ID = "claude-opus-4-5";
export const DEFAULT_AGENT_SYSTEM_PROMPT =
	"You are nanobot, a personal AI assistant.";
export const DEFAULT_AGENT_THINKING_LEVEL = "off";
export const DEFAULT_AGENT_TEMPERATURE = 0.1;
export const DEFAULT_AGENT_MAX_TOKENS = 8192;
export const DEFAULT_AGENT_TOOL_EXECUTION = "parallel";
export const DEFAULT_AGENT_TRANSPORT = "sse";
export const DEFAULT_AGENT_MAX_RETRY_DELAY_MS = 60_000;
export const DEFAULT_AGENT_SESSION_STORE_PATH = "sessions";

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

const appConfigSchema = z.object({
	workspace: z
		.object({
			path: z.string().default(DEFAULT_WORKSPACE_PATH),
		})
		.default({ path: DEFAULT_WORKSPACE_PATH }),
	gateway: z
		.object({
			port: z.number().int().positive().default(DEFAULT_GATEWAY_PORT),
		})
		.default({ port: DEFAULT_GATEWAY_PORT }),
	channels: z
		.object({
			telegram: z
				.object({
					enabled: z.boolean().default(false),
					token: z.string().default(""),
					allowFrom: z.array(z.string()).default([]),
					chatIds: z.array(z.string()).default([]),
				})
				.default({
					enabled: false,
					token: "",
					allowFrom: [],
					chatIds: [],
				}),
		})
		.default({
			telegram: {
				enabled: false,
				token: "",
				allowFrom: [],
				chatIds: [],
			},
		}),
	agent: z
		.object({
			provider: z
				.string()
				.refine(
					(value) => PROVIDERS.includes(value as (typeof PROVIDERS)[number]),
					{
						message: "Unsupported agent provider.",
					},
				)
				.default(DEFAULT_AGENT_PROVIDER),
			modelId: z.string().default(DEFAULT_AGENT_MODEL_ID),
			systemPrompt: z.string().default(DEFAULT_AGENT_SYSTEM_PROMPT),
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
				})
				.default({
					type: "file",
					path: DEFAULT_AGENT_SESSION_STORE_PATH,
				}),
		})
		.default({
			provider: DEFAULT_AGENT_PROVIDER,
			modelId: DEFAULT_AGENT_MODEL_ID,
			systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
			thinkingLevel: DEFAULT_AGENT_THINKING_LEVEL,
			temperature: DEFAULT_AGENT_TEMPERATURE,
			maxTokens: DEFAULT_AGENT_MAX_TOKENS,
			toolExecution: DEFAULT_AGENT_TOOL_EXECUTION,
			transport: DEFAULT_AGENT_TRANSPORT,
			maxRetryDelayMs: DEFAULT_AGENT_MAX_RETRY_DELAY_MS,
			sessionStore: {
				type: "file",
				path: DEFAULT_AGENT_SESSION_STORE_PATH,
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
	},
	channels: {
		telegram: {
			enabled: false,
			token: "",
			allowFrom: [],
			chatIds: [],
		},
	},
	agent: {
		provider: DEFAULT_AGENT_PROVIDER,
		modelId: DEFAULT_AGENT_MODEL_ID,
		systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
		thinkingLevel: DEFAULT_AGENT_THINKING_LEVEL,
		temperature: DEFAULT_AGENT_TEMPERATURE,
		maxTokens: DEFAULT_AGENT_MAX_TOKENS,
		toolExecution: DEFAULT_AGENT_TOOL_EXECUTION,
		transport: DEFAULT_AGENT_TRANSPORT,
		maxRetryDelayMs: DEFAULT_AGENT_MAX_RETRY_DELAY_MS,
		sessionStore: {
			type: "file",
			path: DEFAULT_AGENT_SESSION_STORE_PATH,
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
	const parsed = appConfigSchema.parse(JSON.parse(raw));

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
		!PROVIDERS.includes(config.agent.provider as (typeof PROVIDERS)[number])
	) {
		throw new Error(`Unsupported agent provider: ${config.agent.provider}`);
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
