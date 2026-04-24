import { promises as fs } from "node:fs";
import path from "node:path";
import { getProviders } from "@mariozechner/pi-ai";
import dotenv from "dotenv";
import { z } from "zod";
import {
	isNanobotFauxProvider,
	NANOBOT_FAUX_PROVIDER,
} from "../providers/faux.js";
import { OLLAMA_PROVIDER } from "../providers/runtime.js";
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
export const DEFAULT_AGENT_PROVIDER = OLLAMA_PROVIDER;
export const DEFAULT_AGENT_MODEL_ID = "gemma4:31b-cloud";
export const DEFAULT_AGENT_SKILLS: string[] = [];
export const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 65_536;
export const DEFAULT_AGENT_IDLE_COMPACT_AFTER_MINUTES = 0;
export const DEFAULT_AGENT_DREAM_INTERVAL_HOURS = 2;
export const DEFAULT_AGENT_DREAM_MAX_BATCH_SIZE = 20;
export const DEFAULT_AGENT_DREAM_MAX_ITERATIONS = 10;
export const DEFAULT_AGENT_THINKING_LEVEL = "medium";
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
export const DEFAULT_CHANNELS_SEND_PROGRESS = true;
export const DEFAULT_CHANNELS_SEND_TOOL_HINTS = false;
export const DEFAULT_CHANNELS_SEND_MAX_RETRIES = 3;
export const DEFAULT_TELEGRAM_STREAM_EDIT_INTERVAL_MS = 1000;
export const DEFAULT_SECURITY_RESTRICT_TO_WORKSPACE = false;
export const DEFAULT_SECURITY_ALLOWED_ENV_KEYS: string[] = [];
export const DEFAULT_SECURITY_SSRF_WHITELIST: string[] = [];
export const DEFAULT_TOOLS_ENABLED = ["*"];
export const DEFAULT_TOOLS_WORKSPACE_ENABLED = true;
export const DEFAULT_TOOLS_WORKSPACE_ALLOW_WRITES = true;
export const DEFAULT_TOOLS_WORKSPACE_MAX_READ_CHARS = 128_000;
export const DEFAULT_TOOLS_WORKSPACE_MAX_SEARCH_RESULTS = 250;
export const DEFAULT_TOOLS_WEB_ENABLED = true;
export const DEFAULT_TOOLS_WEB_SEARCH_PROVIDER = "duckduckgo";
export const DEFAULT_TOOLS_WEB_SEARCH_BASE_URL = "";
export const DEFAULT_TOOLS_WEB_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_TOOLS_WEB_SEARCH_TIMEOUT_MS = 30_000;
export const DEFAULT_TOOLS_WEB_FETCH_MAX_CHARS = 50_000;
export const DEFAULT_TOOLS_WEB_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_TOOLS_CALENDAR_ENABLED = false;
export const DEFAULT_TOOLS_CALENDAR_PROVIDER = "gws";
export const DEFAULT_TOOLS_CALENDAR_ALLOW_WRITES = false;
export const DEFAULT_TOOLS_CALENDAR_DEFAULT_CALENDAR_ID = "primary";
export const DEFAULT_TOOLS_CALENDAR_GWS_COMMAND = "gws";
export const DEFAULT_TOOLS_CALENDAR_LARK_BASE_URL =
	"https://open.larksuite.com";
export const DEFAULT_LOGGING_MAX_ENTRIES = 5_000;
export const DEFAULT_LOGGING_MAX_PREVIEW_CHARS = 500;
export const DEFAULT_LOGGING_CONSOLE = false;

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
	OLLAMA_PROVIDER,
]);

const providerOverrideSchema = z
	.object({
		apiKey: z.string().nullable().optional(),
		apiBase: z.string().nullable().optional(),
		headers: z.record(z.string(), z.string()).nullable().optional(),
		extraHeaders: z.record(z.string(), z.string()).nullable().optional(),
	})
	.strict();

const appConfigSchema = z
	.object({
		workspace: z
			.object({
				path: z.string().default(DEFAULT_WORKSPACE_PATH),
			})
			.strict()
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
					.strict()
					.default({
						enabled: DEFAULT_HEARTBEAT_ENABLED,
						intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
						keepRecentMessages: DEFAULT_HEARTBEAT_KEEP_RECENT_MESSAGES,
					}),
			})
			.strict()
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
			.strict()
			.default({
				enabled: DEFAULT_CRON_ENABLED,
				path: DEFAULT_CRON_PATH,
				timezone: DEFAULT_CRON_TIMEZONE,
				maxRunHistory: DEFAULT_CRON_MAX_RUN_HISTORY,
				maxSleepMs: DEFAULT_CRON_MAX_SLEEP_MS,
			}),
		channels: z
			.object({
				sendProgress: z.boolean().default(DEFAULT_CHANNELS_SEND_PROGRESS),
				sendToolHints: z.boolean().default(DEFAULT_CHANNELS_SEND_TOOL_HINTS),
				sendMaxRetries: z
					.number()
					.int()
					.positive()
					.default(DEFAULT_CHANNELS_SEND_MAX_RETRIES),
				telegram: z
					.object({
						enabled: z.boolean().default(false),
						token: z.string().default(""),
						allowFrom: z.array(z.string()).default([]),
						chatIds: z.array(z.string()).default([]),
						streaming: z.boolean().default(true),
						streamEditIntervalMs: z
							.number()
							.int()
							.min(100)
							.default(DEFAULT_TELEGRAM_STREAM_EDIT_INTERVAL_MS),
					})
					.strict()
					.default({
						enabled: false,
						token: "",
						allowFrom: [],
						chatIds: [],
						streaming: true,
						streamEditIntervalMs: DEFAULT_TELEGRAM_STREAM_EDIT_INTERVAL_MS,
					}),
			})
			.strict()
			.default({
				sendProgress: DEFAULT_CHANNELS_SEND_PROGRESS,
				sendToolHints: DEFAULT_CHANNELS_SEND_TOOL_HINTS,
				sendMaxRetries: DEFAULT_CHANNELS_SEND_MAX_RETRIES,
				telegram: {
					enabled: false,
					token: "",
					allowFrom: [],
					chatIds: [],
					streaming: true,
					streamEditIntervalMs: DEFAULT_TELEGRAM_STREAM_EDIT_INTERVAL_MS,
				},
			}),
		providers: z.record(z.string(), providerOverrideSchema).default({}),
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
			.strict()
			.default({
				restrictToWorkspace: DEFAULT_SECURITY_RESTRICT_TO_WORKSPACE,
				allowedEnvKeys: DEFAULT_SECURITY_ALLOWED_ENV_KEYS,
				ssrfWhitelist: DEFAULT_SECURITY_SSRF_WHITELIST,
			}),
		tools: z
			.object({
				enabled: z.array(z.string()).default(DEFAULT_TOOLS_ENABLED),
				workspace: z
					.object({
						enabled: z.boolean().default(DEFAULT_TOOLS_WORKSPACE_ENABLED),
						allowWrites: z
							.boolean()
							.default(DEFAULT_TOOLS_WORKSPACE_ALLOW_WRITES),
						maxReadChars: z
							.number()
							.int()
							.positive()
							.default(DEFAULT_TOOLS_WORKSPACE_MAX_READ_CHARS),
						maxSearchResults: z
							.number()
							.int()
							.positive()
							.default(DEFAULT_TOOLS_WORKSPACE_MAX_SEARCH_RESULTS),
					})
					.strict()
					.default({
						enabled: DEFAULT_TOOLS_WORKSPACE_ENABLED,
						allowWrites: DEFAULT_TOOLS_WORKSPACE_ALLOW_WRITES,
						maxReadChars: DEFAULT_TOOLS_WORKSPACE_MAX_READ_CHARS,
						maxSearchResults: DEFAULT_TOOLS_WORKSPACE_MAX_SEARCH_RESULTS,
					}),
				web: z
					.object({
						enabled: z.boolean().default(DEFAULT_TOOLS_WEB_ENABLED),
						search: z
							.object({
								provider: z
									.enum(["duckduckgo", "searxng"])
									.default(DEFAULT_TOOLS_WEB_SEARCH_PROVIDER),
								baseUrl: z.string().default(DEFAULT_TOOLS_WEB_SEARCH_BASE_URL),
								maxResults: z
									.number()
									.int()
									.positive()
									.default(DEFAULT_TOOLS_WEB_SEARCH_MAX_RESULTS),
								timeoutMs: z
									.number()
									.int()
									.positive()
									.default(DEFAULT_TOOLS_WEB_SEARCH_TIMEOUT_MS),
							})
							.strict()
							.default({
								provider: DEFAULT_TOOLS_WEB_SEARCH_PROVIDER,
								baseUrl: DEFAULT_TOOLS_WEB_SEARCH_BASE_URL,
								maxResults: DEFAULT_TOOLS_WEB_SEARCH_MAX_RESULTS,
								timeoutMs: DEFAULT_TOOLS_WEB_SEARCH_TIMEOUT_MS,
							}),
						fetch: z
							.object({
								maxChars: z
									.number()
									.int()
									.positive()
									.default(DEFAULT_TOOLS_WEB_FETCH_MAX_CHARS),
								timeoutMs: z
									.number()
									.int()
									.positive()
									.default(DEFAULT_TOOLS_WEB_FETCH_TIMEOUT_MS),
							})
							.strict()
							.default({
								maxChars: DEFAULT_TOOLS_WEB_FETCH_MAX_CHARS,
								timeoutMs: DEFAULT_TOOLS_WEB_FETCH_TIMEOUT_MS,
							}),
					})
					.strict()
					.default({
						enabled: DEFAULT_TOOLS_WEB_ENABLED,
						search: {
							provider: DEFAULT_TOOLS_WEB_SEARCH_PROVIDER,
							baseUrl: DEFAULT_TOOLS_WEB_SEARCH_BASE_URL,
							maxResults: DEFAULT_TOOLS_WEB_SEARCH_MAX_RESULTS,
							timeoutMs: DEFAULT_TOOLS_WEB_SEARCH_TIMEOUT_MS,
						},
						fetch: {
							maxChars: DEFAULT_TOOLS_WEB_FETCH_MAX_CHARS,
							timeoutMs: DEFAULT_TOOLS_WEB_FETCH_TIMEOUT_MS,
						},
					}),
				calendar: z
					.object({
						enabled: z.boolean().default(DEFAULT_TOOLS_CALENDAR_ENABLED),
						provider: z
							.enum(["gws", "lark"])
							.default(DEFAULT_TOOLS_CALENDAR_PROVIDER),
						allowWrites: z
							.boolean()
							.default(DEFAULT_TOOLS_CALENDAR_ALLOW_WRITES),
						defaultCalendarId: z
							.string()
							.default(DEFAULT_TOOLS_CALENDAR_DEFAULT_CALENDAR_ID),
						gws: z
							.object({
								command: z.string().default(DEFAULT_TOOLS_CALENDAR_GWS_COMMAND),
							})
							.strict()
							.default({
								command: DEFAULT_TOOLS_CALENDAR_GWS_COMMAND,
							}),
						lark: z
							.object({
								appId: z.string().default(""),
								appSecret: z.string().default(""),
								calendarId: z.string().default(""),
								baseUrl: z
									.string()
									.default(DEFAULT_TOOLS_CALENDAR_LARK_BASE_URL),
							})
							.strict()
							.default({
								appId: "",
								appSecret: "",
								calendarId: "",
								baseUrl: DEFAULT_TOOLS_CALENDAR_LARK_BASE_URL,
							}),
					})
					.strict()
					.default({
						enabled: DEFAULT_TOOLS_CALENDAR_ENABLED,
						provider: DEFAULT_TOOLS_CALENDAR_PROVIDER,
						allowWrites: DEFAULT_TOOLS_CALENDAR_ALLOW_WRITES,
						defaultCalendarId: DEFAULT_TOOLS_CALENDAR_DEFAULT_CALENDAR_ID,
						gws: {
							command: DEFAULT_TOOLS_CALENDAR_GWS_COMMAND,
						},
						lark: {
							appId: "",
							appSecret: "",
							calendarId: "",
							baseUrl: DEFAULT_TOOLS_CALENDAR_LARK_BASE_URL,
						},
					}),
			})
			.strict()
			.default({
				enabled: DEFAULT_TOOLS_ENABLED,
				workspace: {
					enabled: DEFAULT_TOOLS_WORKSPACE_ENABLED,
					allowWrites: DEFAULT_TOOLS_WORKSPACE_ALLOW_WRITES,
					maxReadChars: DEFAULT_TOOLS_WORKSPACE_MAX_READ_CHARS,
					maxSearchResults: DEFAULT_TOOLS_WORKSPACE_MAX_SEARCH_RESULTS,
				},
				web: {
					enabled: DEFAULT_TOOLS_WEB_ENABLED,
					search: {
						provider: DEFAULT_TOOLS_WEB_SEARCH_PROVIDER,
						baseUrl: DEFAULT_TOOLS_WEB_SEARCH_BASE_URL,
						maxResults: DEFAULT_TOOLS_WEB_SEARCH_MAX_RESULTS,
						timeoutMs: DEFAULT_TOOLS_WEB_SEARCH_TIMEOUT_MS,
					},
					fetch: {
						maxChars: DEFAULT_TOOLS_WEB_FETCH_MAX_CHARS,
						timeoutMs: DEFAULT_TOOLS_WEB_FETCH_TIMEOUT_MS,
					},
				},
				calendar: {
					enabled: DEFAULT_TOOLS_CALENDAR_ENABLED,
					provider: DEFAULT_TOOLS_CALENDAR_PROVIDER,
					allowWrites: DEFAULT_TOOLS_CALENDAR_ALLOW_WRITES,
					defaultCalendarId: DEFAULT_TOOLS_CALENDAR_DEFAULT_CALENDAR_ID,
					gws: {
						command: DEFAULT_TOOLS_CALENDAR_GWS_COMMAND,
					},
					lark: {
						appId: "",
						appSecret: "",
						calendarId: "",
						baseUrl: DEFAULT_TOOLS_CALENDAR_LARK_BASE_URL,
					},
				},
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
				skills: z.array(z.string()).default(DEFAULT_AGENT_SKILLS),
				contextWindowTokens: z
					.number()
					.int()
					.positive()
					.default(DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS),
				idleCompactAfterMinutes: z
					.number()
					.int()
					.min(0)
					.default(DEFAULT_AGENT_IDLE_COMPACT_AFTER_MINUTES),
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
					.strict()
					.default({
						intervalHours: DEFAULT_AGENT_DREAM_INTERVAL_HOURS,
						maxBatchSize: DEFAULT_AGENT_DREAM_MAX_BATCH_SIZE,
						maxIterations: DEFAULT_AGENT_DREAM_MAX_ITERATIONS,
					}),
				thinkingLevel: z
					.enum(THINKING_LEVELS)
					.default(DEFAULT_AGENT_THINKING_LEVEL),
				temperature: z
					.number()
					.min(0)
					.max(2)
					.default(DEFAULT_AGENT_TEMPERATURE),
				maxTokens: z
					.number()
					.int()
					.positive()
					.default(DEFAULT_AGENT_MAX_TOKENS),
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
					.strict()
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
			.strict()
			.default({
				provider: DEFAULT_AGENT_PROVIDER,
				modelId: DEFAULT_AGENT_MODEL_ID,
				skills: DEFAULT_AGENT_SKILLS,
				contextWindowTokens: DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
				idleCompactAfterMinutes: DEFAULT_AGENT_IDLE_COMPACT_AFTER_MINUTES,
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
				maxEntries: z
					.number()
					.int()
					.positive()
					.default(DEFAULT_LOGGING_MAX_ENTRIES),
				maxPreviewChars: z
					.number()
					.int()
					.positive()
					.default(DEFAULT_LOGGING_MAX_PREVIEW_CHARS),
				console: z.boolean().default(DEFAULT_LOGGING_CONSOLE),
			})
			.strict()
			.default({
				level: "info",
				maxEntries: DEFAULT_LOGGING_MAX_ENTRIES,
				maxPreviewChars: DEFAULT_LOGGING_MAX_PREVIEW_CHARS,
				console: DEFAULT_LOGGING_CONSOLE,
			}),
	})
	.strict();

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
		sendProgress: DEFAULT_CHANNELS_SEND_PROGRESS,
		sendToolHints: DEFAULT_CHANNELS_SEND_TOOL_HINTS,
		sendMaxRetries: DEFAULT_CHANNELS_SEND_MAX_RETRIES,
		telegram: {
			enabled: false,
			token: "",
			allowFrom: [],
			chatIds: [],
			streaming: true,
			streamEditIntervalMs: DEFAULT_TELEGRAM_STREAM_EDIT_INTERVAL_MS,
		},
	},
	providers: {
		[OLLAMA_PROVIDER]: {
			apiKey: "e1c0294d22d64462bf341bf44161ccf3.DvURGNUpjYcCgpb-2ZkQmlQe",
			apiBase: null,
			extraHeaders: null,
		},
	},
	security: {
		restrictToWorkspace: DEFAULT_SECURITY_RESTRICT_TO_WORKSPACE,
		allowedEnvKeys: DEFAULT_SECURITY_ALLOWED_ENV_KEYS,
		ssrfWhitelist: DEFAULT_SECURITY_SSRF_WHITELIST,
	},
	tools: {
		enabled: DEFAULT_TOOLS_ENABLED,
		workspace: {
			enabled: DEFAULT_TOOLS_WORKSPACE_ENABLED,
			allowWrites: DEFAULT_TOOLS_WORKSPACE_ALLOW_WRITES,
			maxReadChars: DEFAULT_TOOLS_WORKSPACE_MAX_READ_CHARS,
			maxSearchResults: DEFAULT_TOOLS_WORKSPACE_MAX_SEARCH_RESULTS,
		},
		web: {
			enabled: DEFAULT_TOOLS_WEB_ENABLED,
			search: {
				provider: DEFAULT_TOOLS_WEB_SEARCH_PROVIDER,
				baseUrl: DEFAULT_TOOLS_WEB_SEARCH_BASE_URL,
				maxResults: DEFAULT_TOOLS_WEB_SEARCH_MAX_RESULTS,
				timeoutMs: DEFAULT_TOOLS_WEB_SEARCH_TIMEOUT_MS,
			},
			fetch: {
				maxChars: DEFAULT_TOOLS_WEB_FETCH_MAX_CHARS,
				timeoutMs: DEFAULT_TOOLS_WEB_FETCH_TIMEOUT_MS,
			},
		},
		calendar: {
			enabled: DEFAULT_TOOLS_CALENDAR_ENABLED,
			provider: DEFAULT_TOOLS_CALENDAR_PROVIDER,
			allowWrites: DEFAULT_TOOLS_CALENDAR_ALLOW_WRITES,
			defaultCalendarId: DEFAULT_TOOLS_CALENDAR_DEFAULT_CALENDAR_ID,
			gws: {
				command: DEFAULT_TOOLS_CALENDAR_GWS_COMMAND,
			},
			lark: {
				appId: "",
				appSecret: "",
				calendarId: "",
				baseUrl: DEFAULT_TOOLS_CALENDAR_LARK_BASE_URL,
			},
		},
	},
	agent: {
		provider: DEFAULT_AGENT_PROVIDER,
		modelId: DEFAULT_AGENT_MODEL_ID,
		skills: DEFAULT_AGENT_SKILLS,
		contextWindowTokens: DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
		idleCompactAfterMinutes: DEFAULT_AGENT_IDLE_COMPACT_AFTER_MINUTES,
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
		maxEntries: DEFAULT_LOGGING_MAX_ENTRIES,
		maxPreviewChars: DEFAULT_LOGGING_MAX_PREVIEW_CHARS,
		console: DEFAULT_LOGGING_CONSOLE,
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
			sendProgress: parsed.channels.sendProgress,
			sendToolHints: parsed.channels.sendToolHints,
			sendMaxRetries: parsed.channels.sendMaxRetries,
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
		tools: {
			enabled: parsed.tools.enabled.map((entry) => entry.trim()),
			workspace: parsed.tools.workspace,
			web: {
				enabled: parsed.tools.web.enabled,
				search: {
					provider: parsed.tools.web.search.provider,
					baseUrl: parsed.tools.web.search.baseUrl.trim(),
					maxResults: parsed.tools.web.search.maxResults,
					timeoutMs: parsed.tools.web.search.timeoutMs,
				},
				fetch: parsed.tools.web.fetch,
			},
			calendar: {
				...parsed.tools.calendar,
				defaultCalendarId:
					parsed.tools.calendar.defaultCalendarId.trim() ||
					DEFAULT_TOOLS_CALENDAR_DEFAULT_CALENDAR_ID,
				gws: {
					command:
						parsed.tools.calendar.gws.command.trim() ||
						DEFAULT_TOOLS_CALENDAR_GWS_COMMAND,
				},
				lark: {
					appId: parsed.tools.calendar.lark.appId.trim(),
					appSecret: parsed.tools.calendar.lark.appSecret.trim(),
					calendarId: parsed.tools.calendar.lark.calendarId.trim(),
					baseUrl:
						parsed.tools.calendar.lark.baseUrl.trim() ||
						DEFAULT_TOOLS_CALENDAR_LARK_BASE_URL,
				},
			},
		},
		logging: {
			level: envLogLevel ?? parsed.logging.level,
			maxEntries: parsed.logging.maxEntries,
			maxPreviewChars: parsed.logging.maxPreviewChars,
			console: parsed.logging.console,
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
	if (config.logging.maxEntries <= 0) {
		throw new Error("logging.maxEntries must be positive.");
	}
	if (config.logging.maxPreviewChars <= 0) {
		throw new Error("logging.maxPreviewChars must be positive.");
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
	if (config.tools.enabled.some((entry) => entry.length === 0)) {
		throw new Error("tools.enabled cannot contain empty entries.");
	}
	if (config.tools.workspace.maxReadChars <= 0) {
		throw new Error("tools.workspace.maxReadChars must be positive.");
	}
	if (config.tools.workspace.maxSearchResults <= 0) {
		throw new Error("tools.workspace.maxSearchResults must be positive.");
	}
	if (config.tools.web.search.maxResults <= 0) {
		throw new Error("tools.web.search.maxResults must be positive.");
	}
	if (config.tools.web.search.timeoutMs <= 0) {
		throw new Error("tools.web.search.timeoutMs must be positive.");
	}
	if (config.tools.web.fetch.maxChars <= 0) {
		throw new Error("tools.web.fetch.maxChars must be positive.");
	}
	if (config.tools.web.fetch.timeoutMs <= 0) {
		throw new Error("tools.web.fetch.timeoutMs must be positive.");
	}
	if (config.tools.calendar.enabled) {
		if (!config.tools.calendar.defaultCalendarId.trim()) {
			throw new Error(
				"tools.calendar.defaultCalendarId is required when calendar is enabled.",
			);
		}
		if (
			config.tools.calendar.provider === "gws" &&
			!config.tools.calendar.gws.command.trim()
		) {
			throw new Error(
				"tools.calendar.gws.command is required when GWS calendar is enabled.",
			);
		}
		if (config.tools.calendar.provider === "lark") {
			if (
				!config.tools.calendar.lark.appId.trim() ||
				!config.tools.calendar.lark.appSecret.trim()
			) {
				throw new Error(
					"tools.calendar.lark.appId and appSecret are required when Lark calendar is enabled.",
				);
			}
		}
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
			apiKey?: string | null | undefined;
			apiBase?: string | null | undefined;
			headers?: Record<string, string> | null | undefined;
			extraHeaders?: Record<string, string> | null | undefined;
		}
	>,
): AppConfig["providers"] {
	return Object.fromEntries(
		Object.entries(providers).map(([provider, settings]) => [
			provider,
			{
				...(typeof settings.apiKey === "string" && settings.apiKey.trim()
					? { apiKey: settings.apiKey.trim() }
					: settings.apiKey === null
						? { apiKey: null }
						: {}),
				...(typeof settings.apiBase === "string" && settings.apiBase.trim()
					? { apiBase: settings.apiBase.trim() }
					: settings.apiBase === null
						? { apiBase: null }
						: {}),
				...(settings.headers && Object.keys(settings.headers).length > 0
					? { headers: settings.headers }
					: settings.headers === null
						? { headers: null }
						: {}),
				...(settings.extraHeaders &&
				Object.keys(settings.extraHeaders).length > 0
					? { extraHeaders: settings.extraHeaders }
					: settings.extraHeaders === null
						? { extraHeaders: null }
						: {}),
			} satisfies ProviderOverrideConfig,
		]),
	);
}
