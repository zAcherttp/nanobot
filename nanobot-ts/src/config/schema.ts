import type {
	ThinkingLevel,
	ToolExecutionMode,
} from "@mariozechner/pi-agent-core";
import type { KnownProvider, Transport } from "@mariozechner/pi-ai";
import type { NANOBOT_FAUX_PROVIDER } from "../providers/faux.js";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface WorkspaceConfig {
	path: string;
}

export interface TelegramConfig {
	enabled: boolean;
	token: string;
	allowFrom: string[];
	chatIds: string[];
	streaming: boolean;
}

export interface ProviderOverrideConfig {
	apiKey?: string;
	apiBase?: string;
	headers?: Record<string, string>;
}

export type ProvidersConfig = Record<string, ProviderOverrideConfig>;
export type AppProvider = KnownProvider | typeof NANOBOT_FAUX_PROVIDER;

export interface AgentConfig {
	provider: AppProvider;
	modelId: string;
	skills: string[];
	contextWindowTokens: number;
	idleCompactAfterMinutes: number;
	dream: {
		intervalHours: number;
		maxBatchSize: number;
		maxIterations: number;
	};
	thinkingLevel: ThinkingLevel;
	temperature: number;
	maxTokens: number;
	toolExecution: ToolExecutionMode;
	transport: Transport;
	maxRetryDelayMs: number;
	sessionStore: {
		type: "file";
		path: string;
		maxMessages: number;
		maxPersistedTextChars: number;
		quarantineCorruptFiles: boolean;
	};
}

export interface GatewayConfig {
	port: number;
	heartbeat: {
		enabled: boolean;
		intervalSeconds: number;
		keepRecentMessages: number;
	};
}

export interface CronConfig {
	enabled: boolean;
	path: string;
	timezone: string;
	maxRunHistory: number;
	maxSleepMs: number;
}

export interface LoggingConfig {
	level: LogLevel;
	maxEntries: number;
	maxPreviewChars: number;
	console: boolean;
}

export interface SecurityConfig {
	restrictToWorkspace: boolean;
	allowedEnvKeys: string[];
	ssrfWhitelist: string[];
}

export interface ToolsConfig {
	enabled: string[];
	workspace: {
		enabled: boolean;
		allowWrites: boolean;
		maxReadChars: number;
		maxSearchResults: number;
	};
	web: {
		enabled: boolean;
		search: {
			provider: "duckduckgo" | "searxng";
			baseUrl: string;
			maxResults: number;
			timeoutMs: number;
		};
		fetch: {
			maxChars: number;
			timeoutMs: number;
		};
	};
	calendar: {
		enabled: boolean;
		provider: "gws" | "lark";
		allowWrites: boolean;
		defaultCalendarId: string;
		gws: {
			command: string;
		};
		lark: {
			appId: string;
			appSecret: string;
			calendarId: string;
			baseUrl: string;
		};
	};
}

export interface AppConfig {
	workspace: WorkspaceConfig;
	gateway: GatewayConfig;
	cron: CronConfig;
	channels: {
		telegram: TelegramConfig;
	};
	providers: ProvidersConfig;
	agent: AgentConfig;
	security: SecurityConfig;
	tools: ToolsConfig;
	logging: LoggingConfig;
}
