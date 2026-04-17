export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface WorkspaceConfig {
	path: string;
}

export interface TelegramConfig {
	enabled: boolean;
	token: string;
	allowFrom: string[];
}

export interface AgentConfig {
	mode: "stub";
	model: string;
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
	agent: AgentConfig;
	logging: LoggingConfig;
}
