import { Bot, type Context } from "grammy";

import type { AgentLoop } from "../agent/loop.js";
import { isSenderAllowed } from "../config/loader.js";
import type { TelegramConfig } from "../config/schema.js";

export const START_MESSAGE =
	"nanobot-ts is running.\nSend a text message and I will echo it back.";
export const UNSUPPORTED_MESSAGE = "Text only for now.";

export interface TelegramBotDeps {
	agent: AgentLoop;
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
		await handleTextMessage(ctx, config, deps.agent);
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
	agent: AgentLoop,
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

	const reply = await agent.reply(String(ctx.chat?.id), text);
	await ctx.reply(reply);
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
