import type {
	InboundChannelMessage,
	OutboundChannelMessage,
} from "../channels/types.js";

export interface CommandSessionSummary {
	messageCount: number;
	promptTokens: number;
}

export interface CommandContext {
	msg: InboundChannelMessage;
	key: string;
	raw: string;
	session: CommandSessionSummary | null;
	runtime: {
		provider: string;
		modelId: string;
		providerAuthSource: "config" | "env" | "none";
		contextWindowTokens: number;
	};
	stopActiveTask: () => Promise<boolean>;
	clearSession: () => Promise<void>;
	triggerDream?: () => Promise<boolean>;
}

export type CommandHandler = (
	context: CommandContext,
) => Promise<OutboundChannelMessage | null>;

export class CommandRouter {
	private readonly priorityHandlers = new Map<string, CommandHandler>();
	private readonly exactHandlers = new Map<string, CommandHandler>();
	private readonly prefixHandlers = new Map<string, CommandHandler>();

	priority(command: string, handler: CommandHandler): void {
		this.priorityHandlers.set(normalizeCommand(command), handler);
	}

	exact(command: string, handler: CommandHandler): void {
		this.exactHandlers.set(normalizeCommand(command), handler);
	}

	prefix(command: string, handler: CommandHandler): void {
		this.prefixHandlers.set(normalizeCommand(command), handler);
	}

	isPriority(text: string): boolean {
		return this.priorityHandlers.has(normalizeCommand(text));
	}

	async dispatchPriority(
		context: CommandContext,
	): Promise<OutboundChannelMessage | null> {
		const handler = this.priorityHandlers.get(normalizeCommand(context.raw));
		if (!handler) {
			return null;
		}
		return handler(context);
	}

	async dispatch(
		context: CommandContext,
	): Promise<OutboundChannelMessage | null> {
		const handler = this.exactHandlers.get(normalizeCommand(context.raw));
		if (handler) {
			return handler(context);
		}

		const normalized = normalizeCommand(context.raw);
		for (const [command, prefixHandler] of this.prefixHandlers) {
			if (normalized === command || normalized.startsWith(`${command} `)) {
				return prefixHandler(context);
			}
		}
		return null;
	}
}

function normalizeCommand(text: string): string {
	return text.trim().toLowerCase();
}
