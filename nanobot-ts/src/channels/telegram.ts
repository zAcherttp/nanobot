import { Bot, type Context } from "grammy";

import type { AppConfig, TelegramConfig } from "../config/schema.js";
import type { Logger } from "../utils/logging.js";
import { BaseChannel, type BaseChannelOptions } from "./base.js";
import type { MessageBus } from "./bus.js";
import type { ChannelFactory } from "./manager.js";
import type { OutboundChannelMessage } from "./types.js";

export const TELEGRAM_CHANNEL_NAME = "telegram";
export const SYSTEM_ROLE = "system";
export const START_MESSAGE = "nanobot-ts is running.";
export const UNSUPPORTED_MESSAGE = "Text only for now.";

export interface TelegramBotDeps {
	onError?: (error: unknown) => void;
	sendMessage?: (chatId: string, text: string) => Promise<unknown>;
	now?: () => Date;
}

export interface TelegramReplyContext {
	chat?: { id: string | number; type?: string };
	from?: { id: string | number };
	message?: { text?: string; photo?: unknown[] };
	reply: (text: string) => Promise<unknown>;
}

export class TelegramChannel extends BaseChannel<TelegramConfig> {
	private bot: Bot | null = null;
	private startPromise: Promise<void> | null = null;

	constructor(
		options: BaseChannelOptions<TelegramConfig>,
		private readonly deps: TelegramBotDeps = {},
	) {
		super(options);
	}

	protected override getAllowFrom(): string[] {
		return this.config.allowFrom;
	}

	protected override getDefaultInboundMetadata(): Record<string, unknown> {
		return {
			source: TELEGRAM_CHANNEL_NAME,
		};
	}

	async start(): Promise<void> {
		if (
			this.currentStatus() === "starting" ||
			this.currentStatus() === "running"
		) {
			return;
		}

		this.setStatus("starting");
		const bot = createTelegramBot(this.config, this, this.deps);
		this.bot = bot;
		this.setStatus("running");

		this.startPromise = bot.start().then(
			() => {
				if (this.currentStatus() !== "stopping") {
					this.setStatus("idle");
				}
			},
			(error) => {
				this.setStatus("error", getErrorMessage(error));
			},
		);
	}

	async stop(): Promise<void> {
		if (!this.bot) {
			return;
		}

		this.setStatus("stopping");
		this.bot.stop();

		try {
			await this.startPromise;
		} finally {
			this.bot = null;
			this.startPromise = null;
			this.setStatus("idle");
		}
	}

	async send(message: OutboundChannelMessage): Promise<number> {
		const text = message.content.trim();
		if (!text) {
			throw new Error("Message content cannot be empty.");
		}

		const targetChatIds = message.chatId
			? [message.chatId]
			: this.config.chatIds;

		if (targetChatIds.length === 0) {
			throw new Error(
				"Telegram channel has no configured chatIds for outbound delivery.",
			);
		}

		for (const chatId of targetChatIds) {
			await this.sendMessage(chatId, formatOutboundMessage(message));
		}

		return targetChatIds.length;
	}

	async receiveTextMessage(ctx: TelegramReplyContext): Promise<void> {
		if (!isPrivateChat(ctx)) {
			return;
		}

		const senderId = getSenderId(ctx);
		if (!senderId) {
			return;
		}

		const chatId = getChatId(ctx);
		const text = ctx.message?.text?.trim();
		if (!chatId || !text) {
			return;
		}

		await this.publishInbound({
			senderId,
			chatId,
			content: text,
			timestamp: this.deps.now?.() ?? new Date(),
			sessionKeyOverride: `${TELEGRAM_CHANNEL_NAME}:${chatId}`,
			metadata: {
				chatType: ctx.chat?.type ?? "unknown",
			},
		});
	}

	async receiveUnsupportedMessage(
		ctx: TelegramReplyContext,
	): Promise<void> {
		if (!isPrivateChat(ctx)) {
			return;
		}

		if (typeof ctx.message?.text === "string") {
			return;
		}

		const senderId = getSenderId(ctx);
		if (!senderId || !this.canAcceptSender(senderId)) {
			return;
		}

		await ctx.reply(UNSUPPORTED_MESSAGE);
	}

	private async sendMessage(chatId: string, text: string): Promise<unknown> {
		if (this.deps.sendMessage) {
			return this.deps.sendMessage(chatId, text);
		}

		if (this.bot) {
			return this.bot.api.sendMessage(chatId, text);
		}

		const bot = new Bot(this.config.token);
		return bot.api.sendMessage(chatId, text);
	}
}

export function createTelegramChannelFactory(
	deps: TelegramBotDeps = {},
): ChannelFactory {
	return {
		name: TELEGRAM_CHANNEL_NAME,
		displayName: "Telegram",
		isEnabled: (config: AppConfig) => config.channels.telegram.enabled,
		createChannel: (config: AppConfig, bus: MessageBus, logger: Logger) =>
			new TelegramChannel(
				{
					name: TELEGRAM_CHANNEL_NAME,
					displayName: "Telegram",
					config: config.channels.telegram,
					bus,
				},
				{
					...deps,
					onError: (error) => {
						logger.error("Telegram channel error", error);
						deps.onError?.(error);
					},
				},
			),
	};
}

export function createTelegramBot(
	config: TelegramConfig,
	channel: TelegramChannel,
	deps: TelegramBotDeps,
): Bot {
	const bot = new Bot(config.token);

	bot.command("start", async (ctx) => {
		await handleStart(ctx);
	});

	bot.on("message:text", async (ctx) => {
		await handleTextMessage(ctx, channel);
	});

	bot.on("message", async (ctx) => {
		await handleUnsupportedMessage(ctx, channel);
	});

	if (deps.onError) {
		bot.catch((error) => {
			deps.onError?.(error);
		});
	}

	return bot;
}

export async function handleStart(
	ctx: Pick<TelegramReplyContext, "reply">,
): Promise<void> {
	await ctx.reply(START_MESSAGE);
}

export async function handleTextMessage(
	ctx: TelegramReplyContext,
	channel: TelegramChannel,
): Promise<void> {
	await channel.receiveTextMessage(ctx);
}

export async function handleUnsupportedMessage(
	ctx: TelegramReplyContext,
	channel: TelegramChannel,
): Promise<void> {
	await channel.receiveUnsupportedMessage(ctx);
}

function getSenderId(
	ctx: Pick<TelegramReplyContext, "from"> | Context,
): string | null {
	return ctx.from ? String(ctx.from.id) : null;
}

function getChatId(
	ctx: Pick<TelegramReplyContext, "chat"> | Context,
): string | null {
	return ctx.chat ? String(ctx.chat.id) : null;
}

function isPrivateChat(
	ctx: Pick<TelegramReplyContext, "chat"> | Context,
): boolean {
	return ctx.chat?.type === "private";
}

function formatOutboundMessage(message: OutboundChannelMessage): string {
	if (message.role) {
		return `[${message.role}] ${message.content}`;
	}

	return message.content;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
