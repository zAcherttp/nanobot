import { promises as fs } from "node:fs";
import path from "node:path";

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
export const DEFAULT_AGENT_MODEL = "nanobot-ts-stub";

const LOG_LEVELS = [
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace",
] as const;

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
					allowFrom: z.array(z.string()).min(1).default(["*"]),
				})
				.default({
					enabled: false,
					token: "",
					allowFrom: ["*"],
				}),
		})
		.default({
			telegram: {
				enabled: false,
				token: "",
				allowFrom: ["*"],
			},
		}),
	agent: z
		.object({
			mode: z.literal("stub").default("stub"),
			model: z.string().default(DEFAULT_AGENT_MODEL),
		})
		.default({
			mode: "stub",
			model: DEFAULT_AGENT_MODEL,
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
			allowFrom: ["*"],
		},
	},
	agent: {
		mode: "stub",
		model: DEFAULT_AGENT_MODEL,
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
