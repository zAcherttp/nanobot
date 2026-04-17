import { Bot, type Context } from "grammy";

import { isSenderAllowed } from "../config/loader.js";
import type { TelegramConfig } from "../config/schema.js";

export const START_MESSAGE = "nanobot-ts is running.";
export const UNSUPPORTED_MESSAGE = "Text only for now.";
export const SYSTEM_ROLE = "system";

export interface ChannelOutboundMessage {
	role: typeof SYSTEM_ROLE;
	content: string;
}

export interface TelegramBotDeps {
	onError?: (error: unknown) => void;
}

export interface TelegramReplyContext {
	chat?: { id: string | number; type?: string };
	from?: { id: string | number };
	message?: { text?: string };
	reply: (text: string) => Promise<unknown>;
}

export function createTelegramBot(
	config: TelegramConfig,
	deps: TelegramBotDeps,
): Bot {
	const bot = new Bot(config.token);

	bot.command("start", async (ctx) => {
		await handleStart(ctx);
	});

	bot.on("message:text", async (ctx) => {
		await handleTextMessage(ctx, config);
	});

	bot.on("message", async (ctx) => {
		await handleUnsupportedMessage(ctx, config);
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
	config: TelegramConfig,
): Promise<void> {
	if (!isPrivateChat(ctx)) {
		return;
	}

	const senderId = getSenderId(ctx);
	if (!senderId || !isSenderAllowed(config.allowFrom, senderId)) {
		return;
	}

	const text = ctx.message?.text;
	if (!text) {
		return;
	}
}

export async function handleUnsupportedMessage(
	ctx: TelegramReplyContext,
	config: TelegramConfig,
): Promise<void> {
	if (!isPrivateChat(ctx)) {
		return;
	}

	if (typeof ctx.message?.text === "string") {
		return;
	}

	const senderId = getSenderId(ctx);
	if (!senderId || !isSenderAllowed(config.allowFrom, senderId)) {
		return;
	}

	await ctx.reply(UNSUPPORTED_MESSAGE);
}

export async function sendSystemMessage(
	config: TelegramConfig,
	message: ChannelOutboundMessage,
	deps: {
		sendMessage?: (chatId: string, text: string) => Promise<unknown>;
	} = {},
): Promise<number> {
	const text = message.content.trim();
	if (!text) {
		throw new Error("System message content cannot be empty.");
	}

	if (config.chatIds.length === 0) {
		throw new Error(
			"Telegram channel has no configured chatIds for system delivery.",
		);
	}

	const sendMessage =
		deps.sendMessage ??
		((chatId: string, outboundText: string) => {
			const bot = new Bot(config.token);
			return bot.api.sendMessage(chatId, outboundText);
		});

	for (const chatId of config.chatIds) {
		await sendMessage(chatId, formatOutboundMessage(message));
	}

	return config.chatIds.length;
}

function getSenderId(
	ctx: Pick<TelegramReplyContext, "from"> | Context,
): string | null {
	return ctx.from ? String(ctx.from.id) : null;
}

function isPrivateChat(
	ctx: Pick<TelegramReplyContext, "chat"> | Context,
): boolean {
	return ctx.chat?.type === "private";
}

function formatOutboundMessage(message: ChannelOutboundMessage): string {
	return `[${message.role}] ${message.content}`;
}
