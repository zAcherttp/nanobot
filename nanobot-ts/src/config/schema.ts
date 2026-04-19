import type {
	ThinkingLevel,
	ToolExecutionMode,
} from "@mariozechner/pi-agent-core";
import type { KnownProvider, Transport } from "@mariozechner/pi-ai";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface WorkspaceConfig {
	path: string;
}

export interface TelegramConfig {
	enabled: boolean;
	token: string;
	allowFrom: string[];
	chatIds: string[];
}

export interface ProviderOverrideConfig {
	apiKey?: string;
	apiBase?: string;
	headers?: Record<string, string>;
}

export type ProvidersConfig = Record<string, ProviderOverrideConfig>;

export interface AgentConfig {
	provider: KnownProvider;
	modelId: string;
	systemPrompt: string;
	thinkingLevel: ThinkingLevel;
	temperature: number;
	maxTokens: number;
	toolExecution: ToolExecutionMode;
	transport: Transport;
	maxRetryDelayMs: number;
	sessionStore: {
		type: "file";
		path: string;
	};
}

export interface GatewayConfig {
	port: number;
}

export interface LoggingConfig {
	level: LogLevel;
}

export interface AppConfig {
	workspace: WorkspaceConfig;
	gateway: GatewayConfig;
	channels: {
		telegram: TelegramConfig;
	};
	providers: ProvidersConfig;
	agent: AgentConfig;
	logging: LoggingConfig;
}
