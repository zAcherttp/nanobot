export type ChannelName = string;
export type ChannelRole = "system" | "user" | "assistant";
export type ChannelStatus = "idle" | "starting" | "running" | "stopping" | "error";

export interface ChannelMediaAttachment {
	kind: string;
	url?: string;
	fileId?: string;
	mimeType?: string;
	metadata?: Record<string, unknown>;
}

export interface InboundChannelMessage {
	channel: ChannelName;
	senderId: string;
	chatId: string;
	content: string;
	timestamp: Date;
	media?: ChannelMediaAttachment[];
	metadata?: Record<string, unknown>;
	sessionKeyOverride?: string;
}

export interface OutboundChannelMessage {
	channel: ChannelName;
	chatId?: string;
	content: string;
	media?: ChannelMediaAttachment[];
	replyTo?: string;
	metadata?: Record<string, unknown>;
	role?: ChannelRole;
}

export interface ChannelSnapshot {
	name: ChannelName;
	displayName: string;
	enabled: boolean;
	status: ChannelStatus;
	errorMessage?: string;
}
