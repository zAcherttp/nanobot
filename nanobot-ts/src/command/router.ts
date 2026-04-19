import type { InboundChannelMessage, OutboundChannelMessage } from "../channels/types.js";

export interface CommandSessionSummary {
	messageCount: number;
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
	};
	stopActiveTask: () => Promise<boolean>;
	clearSession: () => Promise<void>;
}

export type CommandHandler = (
	context: CommandContext,
) => Promise<OutboundChannelMessage | null>;

export class CommandRouter {
	private readonly priorityHandlers = new Map<string, CommandHandler>();
	private readonly exactHandlers = new Map<string, CommandHandler>();

	priority(command: string, handler: CommandHandler): void {
		this.priorityHandlers.set(normalizeCommand(command), handler);
	}

	exact(command: string, handler: CommandHandler): void {
		this.exactHandlers.set(normalizeCommand(command), handler);
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
		if (!handler) {
			return null;
		}
		return handler(context);
	}
}

function normalizeCommand(text: string): string {
	return text.trim().toLowerCase();
}
