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
const STREAM_EDIT_INTERVAL_MS = 300;

export interface TelegramBotDeps {
	onError?: (error: unknown) => void;
	sendMessage?: (chatId: string, text: string) => Promise<unknown>;
	editMessage?: (
		chatId: string,
		messageId: number,
		text: string,
	) => Promise<unknown>;
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
	private readonly streamBuffers = new Map<string, TelegramStreamBuffer>();

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
			this.streamBuffers.clear();
			this.setStatus("idle");
		}
	}

	override supportsStreaming(): boolean {
		return this.config.streaming;
	}

	async send(message: OutboundChannelMessage): Promise<number> {
		const targetChatIds = message.chatId
			? [message.chatId]
			: this.config.chatIds;

		if (targetChatIds.length === 0) {
			throw new Error(
				"Telegram channel has no configured chatIds for outbound delivery.",
			);
		}

		if (isStreamDeltaMessage(message) && this.config.streaming) {
			return this.sendStreamDelta(targetChatIds, message);
		}

		if (isStreamEndMessage(message) && this.config.streaming) {
			return this.sendStreamEnd(targetChatIds, message);
		}

		if (isToolHintMessage(message) && this.config.streaming) {
			for (const chatId of targetChatIds) {
				await this.sendMessage(chatId, message.content);
			}
			return targetChatIds.length;
		}

		const text = message.content.trim();
		if (!text) {
			throw new Error("Message content cannot be empty.");
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
		const text = normalizeTelegramCommandText(ctx.message?.text?.trim() ?? "");
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

	async receiveUnsupportedMessage(ctx: TelegramReplyContext): Promise<void> {
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

	private async editMessage(
		chatId: string,
		messageId: number,
		text: string,
	): Promise<unknown> {
		if (this.deps.editMessage) {
			return this.deps.editMessage(chatId, messageId, text);
		}

		if (this.bot) {
			return this.bot.api.editMessageText(chatId, messageId, text);
		}

		const bot = new Bot(this.config.token);
		return bot.api.editMessageText(chatId, messageId, text);
	}

	private async sendStreamDelta(
		targetChatIds: string[],
		message: OutboundChannelMessage,
	): Promise<number> {
		const streamId = getStreamId(message);
		if (!streamId) {
			throw new Error("Telegram stream delta is missing metadata._stream_id.");
		}

		let delivered = 0;
		for (const chatId of targetChatIds) {
			const buffer = this.getOrCreateStreamBuffer(chatId, streamId);
			buffer.text += message.content;

			if (!buffer.text.trim()) {
				continue;
			}

			if (buffer.messageId === undefined) {
				const sent = await this.sendMessage(chatId, buffer.text);
				const messageId = getTelegramMessageId(sent);
				if (messageId !== undefined) {
					buffer.messageId = messageId;
				}
				buffer.renderedText = buffer.text;
				buffer.lastEditedAt = this.deps.now?.().getTime() ?? Date.now();
				delivered += 1;
				continue;
			}

			const now = this.deps.now?.().getTime() ?? Date.now();
			if (
				buffer.text !== buffer.renderedText &&
				now - buffer.lastEditedAt >= STREAM_EDIT_INTERVAL_MS
			) {
				await this.editMessage(chatId, buffer.messageId, buffer.text);
				buffer.renderedText = buffer.text;
				buffer.lastEditedAt = now;
			}
			delivered += 1;
		}

		return delivered;
	}

	private async sendStreamEnd(
		targetChatIds: string[],
		message: OutboundChannelMessage,
	): Promise<number> {
		const streamId = getStreamId(message);
		if (!streamId) {
			throw new Error("Telegram stream end is missing metadata._stream_id.");
		}

		let delivered = 0;
		for (const chatId of targetChatIds) {
			const key = getTelegramStreamKey(chatId, streamId);
			const buffer = this.streamBuffers.get(key);
			if (!buffer) {
				continue;
			}

			this.streamBuffers.delete(key);
			if (!buffer.text.trim()) {
				continue;
			}

			if (buffer.messageId === undefined) {
				await this.sendMessage(chatId, buffer.text);
				delivered += 1;
				continue;
			}

			if (buffer.text !== buffer.renderedText) {
				await this.editMessage(chatId, buffer.messageId, buffer.text);
			}
			delivered += 1;
		}

		return delivered;
	}

	private getOrCreateStreamBuffer(
		chatId: string,
		streamId: string,
	): TelegramStreamBuffer {
		const key = getTelegramStreamKey(chatId, streamId);
		let buffer = this.streamBuffers.get(key);
		if (!buffer) {
			buffer = {
				text: "",
				renderedText: "",
				lastEditedAt: 0,
			};
			this.streamBuffers.set(key, buffer);
		}
		return buffer;
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

export function normalizeTelegramCommandText(text: string): string {
	if (!text.startsWith("/")) {
		return text;
	}

	const [rawCommand = "", ...rest] = text.split(/\s+/);
	const command = rawCommand.replace(/@[^@\s]+$/, "");
	const normalizedCommand =
		command === "/dream_log"
			? "/dream-log"
			: command === "/dream_restore"
				? "/dream-restore"
				: command;
	return [normalizedCommand, ...rest].join(" ").trim();
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

interface TelegramStreamBuffer {
	text: string;
	renderedText: string;
	messageId?: number;
	lastEditedAt: number;
}

function isStreamDeltaMessage(message: OutboundChannelMessage): boolean {
	return message.metadata?._stream_delta === true;
}

function isStreamEndMessage(message: OutboundChannelMessage): boolean {
	return message.metadata?._stream_end === true;
}

function isToolHintMessage(message: OutboundChannelMessage): boolean {
	return (
		message.metadata?._progress === true &&
		message.metadata?._tool_hint === true
	);
}

function getStreamId(message: OutboundChannelMessage): string | null {
	const streamId = message.metadata?._stream_id;
	return typeof streamId === "string" && streamId ? streamId : null;
}

function getTelegramStreamKey(chatId: string, streamId: string): string {
	return `${chatId}:${streamId}`;
}

function getTelegramMessageId(result: unknown): number | undefined {
	if (!result || typeof result !== "object") {
		return undefined;
	}

	if ("message_id" in result && typeof result.message_id === "number") {
		return result.message_id;
	}

	if ("messageId" in result && typeof result.messageId === "number") {
		return result.messageId;
	}

	return undefined;
}
