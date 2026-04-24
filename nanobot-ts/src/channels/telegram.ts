import { Bot, type Context } from "grammy";

import { isSenderAllowed } from "../config/loader.js";
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
const TELEGRAM_MESSAGE_MAX_CHARS = 4000;
const TELEGRAM_SAFE_MESSAGE_CHARS = 3900;

export interface TelegramBotDeps {
	logger?: Logger;
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
	from?: { id: string | number; username?: string };
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
		this.deps.logger?.info("Starting Telegram bot (polling mode)", {
			component: "telegram",
			event: "polling_start",
			streaming: this.config.streaming,
			allowFrom: this.config.allowFrom,
			chatIds: this.config.chatIds.length,
		});
		const bot = createTelegramBot(this.config, this, this.deps);
		this.bot = bot;
		this.setStatus("running");

		this.startPromise = bot.start().then(
			() => {
				if (this.currentStatus() !== "stopping") {
					this.setStatus("idle");
				}
				this.deps.logger?.info("Telegram bot polling stopped", {
					component: "telegram",
					event: "polling_stop",
				});
			},
			(error) => {
				this.setStatus("error", getErrorMessage(error));
				this.deps.logger?.error("Telegram bot polling failed", {
					component: "telegram",
					event: "polling_error",
					error,
				});
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
		this.deps.logger?.debug("Telegram outbound requested", {
			component: "telegram",
			event: "outbound",
			chatId: message.chatId,
			targets: targetChatIds.length,
			role: message.role,
			streaming: Boolean(
				isStreamDeltaMessage(message) || isStreamEndMessage(message),
			),
			contentPreview: message.content,
		});

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
			this.deps.logger?.debug("Telegram tool hint delivered", {
				component: "telegram",
				event: "tool_hint",
				targets: targetChatIds.length,
				contentPreview: message.content,
			});
			return targetChatIds.length;
		}

		const text = message.content.trim();
		if (!text) {
			throw new Error("Message content cannot be empty.");
		}

		for (const chatId of targetChatIds) {
			await this.sendTelegramChunks(chatId, formatOutboundMessage(message));
		}
		this.deps.logger?.info("Telegram outbound delivered", {
			component: "telegram",
			event: "outbound_delivered",
			targets: targetChatIds.length,
			role: message.role,
			contentPreview: message.content,
		});

		return targetChatIds.length;
	}

	async receiveTextMessage(ctx: TelegramReplyContext): Promise<void> {
		if (!isPrivateChat(ctx)) {
			this.deps.logger?.debug(
				"Telegram message ignored from non-private chat",
				{
					component: "telegram",
					event: "inbound_ignored",
					reason: "non_private_chat",
					chatType: ctx.chat?.type ?? "unknown",
				},
			);
			return;
		}

		const senderId = getSenderId(ctx);
		if (!senderId) {
			this.deps.logger?.debug("Telegram message ignored without sender id", {
				component: "telegram",
				event: "inbound_ignored",
				reason: "missing_sender",
			});
			return;
		}

		const chatId = getChatId(ctx);
		const text = normalizeTelegramCommandText(ctx.message?.text?.trim() ?? "");
		if (!chatId || !text) {
			this.deps.logger?.debug(
				"Telegram message ignored without text or chat id",
				{
					component: "telegram",
					event: "inbound_ignored",
					reason: "missing_text_or_chat",
					senderId,
				},
			);
			return;
		}

		this.deps.logger?.debug("Telegram message received", {
			component: "telegram",
			event: "inbound",
			chatId,
			senderId,
			username: getSenderUsername(ctx),
			contentPreview: text,
		});
		if (!this.canAcceptTelegramSender(ctx)) {
			this.deps.logger?.debug("Telegram message blocked by allowlist", {
				component: "telegram",
				event: "inbound_blocked",
				chatId,
				senderId,
				username: getSenderUsername(ctx),
			});
			return;
		}

		await this.publishAcceptedInbound({
			senderId,
			chatId,
			content: text,
			timestamp: this.deps.now?.() ?? new Date(),
			sessionKeyOverride: `${TELEGRAM_CHANNEL_NAME}:${chatId}`,
			metadata: {
				chatType: ctx.chat?.type ?? "unknown",
				...(getSenderUsername(ctx) ? { username: getSenderUsername(ctx) } : {}),
			},
		});
	}

	async receiveUnsupportedMessage(ctx: TelegramReplyContext): Promise<void> {
		if (!isPrivateChat(ctx)) {
			this.deps.logger?.debug(
				"Telegram unsupported message ignored from non-private chat",
				{
					component: "telegram",
					event: "unsupported_ignored",
					reason: "non_private_chat",
					chatType: ctx.chat?.type ?? "unknown",
				},
			);
			return;
		}

		if (typeof ctx.message?.text === "string") {
			return;
		}

		const senderId = getSenderId(ctx);
		if (!senderId || !this.canAcceptTelegramSender(ctx)) {
			this.deps.logger?.debug("Telegram unsupported message blocked", {
				component: "telegram",
				event: "unsupported_blocked",
				senderId,
				username: getSenderUsername(ctx),
			});
			return;
		}

		await ctx.reply(UNSUPPORTED_MESSAGE);
		this.deps.logger?.debug("Telegram unsupported message reply sent", {
			component: "telegram",
			event: "unsupported",
			senderId,
			username: getSenderUsername(ctx),
		});
	}

	private canAcceptTelegramSender(ctx: TelegramReplyContext): boolean {
		const senderId = getSenderId(ctx);
		if (!senderId) {
			return false;
		}
		return isTelegramSenderAllowed(
			this.config.allowFrom,
			senderId,
			getSenderUsername(ctx),
		);
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
			const renderedText = formatTelegramStreamText(buffer.text);

			if (!renderedText.trim()) {
				continue;
			}

			if (buffer.messageId === undefined) {
				const sent = await this.sendMessage(
					chatId,
					firstTelegramChunk(renderedText),
				);
				const messageId = getTelegramMessageId(sent);
				if (messageId !== undefined) {
					buffer.messageId = messageId;
				}
				buffer.renderedText = firstTelegramChunk(renderedText);
				buffer.lastEditedAt = this.deps.now?.().getTime() ?? Date.now();
				delivered += 1;
				this.deps.logger?.debug("Telegram stream message sent", {
					component: "telegram",
					event: "stream_start",
					chatId,
					streamId,
					contentPreview: renderedText,
				});
				continue;
			}

			const now = this.deps.now?.().getTime() ?? Date.now();
			if (
				renderedText !== buffer.renderedText &&
				now - buffer.lastEditedAt >= this.config.streamEditIntervalMs
			) {
				const edited = await this.tryEditStreamMessage(
					chatId,
					streamId,
					buffer,
					firstTelegramChunk(renderedText),
					"stream_edit",
					now,
				);
				if (!edited) {
					buffer.lastEditedAt = now;
				}
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

			const finalText = formatTelegramStreamText(buffer.text);
			const chunks = splitTelegramMessage(finalText);
			if (chunks.length === 0) {
				continue;
			}

			if (buffer.messageId === undefined) {
				await this.sendTelegramChunks(chatId, finalText);
				delivered += 1;
				this.deps.logger?.debug("Telegram stream finalized via send", {
					component: "telegram",
					event: "stream_end",
					chatId,
					streamId,
					contentPreview: finalText,
				});
				continue;
			}

			const firstChunk = chunks[0] ?? "";
			if (firstChunk && firstChunk !== buffer.renderedText) {
				const edited = await this.tryEditStreamMessage(
					chatId,
					streamId,
					buffer,
					firstChunk,
					"stream_end",
					this.deps.now?.().getTime() ?? Date.now(),
				);
				if (!edited) {
					await this.sendTelegramChunks(chatId, finalText);
					this.deps.logger?.warn(
						"Telegram stream final edit failed; sent final text as a new message",
						{
							component: "telegram",
							event: "stream_final_fallback",
							chatId,
							streamId,
							contentPreview: finalText,
						},
					);
				} else if (chunks.length > 1) {
					for (const chunk of chunks.slice(1)) {
						await this.sendMessage(chatId, chunk);
					}
				}
			} else if (chunks.length > 1) {
				for (const chunk of chunks.slice(1)) {
					await this.sendMessage(chatId, chunk);
				}
			}
			this.deps.logger?.debug("Telegram stream finalized", {
				component: "telegram",
				event: "stream_end",
				chatId,
				streamId,
			});
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

	private async tryEditStreamMessage(
		chatId: string,
		streamId: string,
		buffer: TelegramStreamBuffer,
		text: string,
		event: "stream_edit" | "stream_end",
		now: number,
	): Promise<boolean> {
		if (buffer.messageId === undefined) {
			return false;
		}

		try {
			await this.editMessage(chatId, buffer.messageId, text);
		} catch (error) {
			if (isTelegramMessageNotModifiedError(error)) {
				buffer.renderedText = text;
				buffer.lastEditedAt = now;
				this.deps.logger?.debug("Telegram stream edit was already current", {
					component: "telegram",
					event: "stream_edit_unchanged",
					chatId,
					streamId,
				});
				return true;
			}

			this.deps.logger?.warn("Telegram stream edit failed", {
				component: "telegram",
				event: "stream_edit_failed",
				chatId,
				streamId,
				error,
			});
			return false;
		}

		buffer.renderedText = text;
		buffer.lastEditedAt = now;
		this.deps.logger?.debug("Telegram stream message edited", {
			component: "telegram",
			event,
			chatId,
			streamId,
			contentPreview: text,
		});
		return true;
	}

	private async sendTelegramChunks(
		chatId: string,
		text: string,
	): Promise<number> {
		const chunks = splitTelegramMessage(text);
		for (const chunk of chunks) {
			await this.sendMessage(chatId, chunk);
		}
		return chunks.length;
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
					logger,
					onError: (error) => {
						logger.error("Telegram channel error", {
							component: "telegram",
							event: "error",
							error,
						});
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

function getSenderUsername(
	ctx: Pick<TelegramReplyContext, "from"> | Context,
): string | null {
	return ctx.from?.username ? String(ctx.from.username) : null;
}

function isTelegramSenderAllowed(
	allowFrom: string[],
	senderId: string,
	username: string | null,
): boolean {
	if (isSenderAllowed(allowFrom, senderId)) {
		return true;
	}

	const normalizedUsername = normalizeTelegramUsername(username);
	if (!normalizedUsername) {
		return false;
	}

	return allowFrom.some(
		(entry) => normalizeTelegramUsername(entry) === normalizedUsername,
	);
}

function normalizeTelegramUsername(
	username: string | null | undefined,
): string {
	return username?.trim().replace(/^@/, "").toLowerCase() ?? "";
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

function formatTelegramStreamText(text: string): string {
	return stripTelegramMarkdown(text).trimEnd();
}

function stripTelegramMarkdown(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/^```[a-zA-Z0-9_-]*\s*$/gm, "")
		.replace(/```/g, "")
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s{0,3}>\s?/gm, "")
		.replace(/\*\*([^*\n]+)\*\*/g, "$1")
		.replace(/__([^_\n]+)__/g, "$1")
		.replace(/~~([^~\n]+)~~/g, "$1")
		.replace(/\*([^*\n]+)\*/g, "$1");
}

function firstTelegramChunk(text: string): string {
	return splitTelegramMessage(text)[0] ?? "";
}

function splitTelegramMessage(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) {
		return [];
	}

	const chunks: string[] = [];
	let remaining = trimmed;
	while (remaining.length > TELEGRAM_SAFE_MESSAGE_CHARS) {
		const cutAt = findTelegramSplitIndex(remaining);
		chunks.push(remaining.slice(0, cutAt).trimEnd());
		remaining = remaining.slice(cutAt).trimStart();
	}
	if (remaining) {
		chunks.push(remaining);
	}
	return chunks;
}

function findTelegramSplitIndex(text: string): number {
	const newlineIndex = text.lastIndexOf("\n", TELEGRAM_SAFE_MESSAGE_CHARS);
	if (newlineIndex >= TELEGRAM_SAFE_MESSAGE_CHARS / 2) {
		return newlineIndex + 1;
	}

	const spaceIndex = text.lastIndexOf(" ", TELEGRAM_SAFE_MESSAGE_CHARS);
	if (spaceIndex >= TELEGRAM_SAFE_MESSAGE_CHARS / 2) {
		return spaceIndex + 1;
	}

	return Math.min(TELEGRAM_SAFE_MESSAGE_CHARS, TELEGRAM_MESSAGE_MAX_CHARS);
}

function isTelegramMessageNotModifiedError(error: unknown): boolean {
	return getErrorMessage(error)
		.toLowerCase()
		.includes("message is not modified");
}
