import { describe, expect, it, vi } from "vitest";

import { InMemoryMessageBus } from "../src/channels/bus.js";
import {
	handleStart,
	handleTextMessage,
	handleUnsupportedMessage,
	START_MESSAGE,
	SYSTEM_ROLE,
	TELEGRAM_CHANNEL_NAME,
	TelegramChannel,
	UNSUPPORTED_MESSAGE,
} from "../src/channels/telegram.js";

describe("telegram channel", () => {
	function createChannel(
		sendMessage = vi.fn(async () => undefined),
		now = () => new Date("2026-04-17T08:00:00.000Z"),
	) {
		const bus = new InMemoryMessageBus();
		const channel = new TelegramChannel(
			{
				name: TELEGRAM_CHANNEL_NAME,
				displayName: "Telegram",
				config: {
					enabled: true,
					token: "123:abc",
					allowFrom: ["*"],
					chatIds: ["111", "222"],
				},
				bus,
			},
			{ sendMessage, now },
		);

		return { channel, bus };
	}

	it("replies to /start with onboarding text", async () => {
		const reply = vi.fn(async () => undefined);
		await handleStart({ reply });

		expect(reply).toHaveBeenCalledWith(START_MESSAGE);
	});

	it("publishes private text messages to the inbound bus without echoing", async () => {
		const reply = vi.fn(async () => undefined);
		const { channel, bus } = createChannel();
		const inbound: unknown[] = [];

		bus.subscribeInbound(async (message) => {
			inbound.push(message);
		});

		await handleTextMessage(
			{
				chat: { id: 42, type: "private" },
				from: { id: 99 },
				message: { text: "hello" },
				reply,
			},
			channel,
		);

		expect(reply).not.toHaveBeenCalled();
		expect(inbound).toEqual([
			expect.objectContaining({
				channel: "telegram",
				senderId: "99",
				chatId: "42",
				content: "hello",
				sessionKeyOverride: "telegram:42",
				metadata: {
					source: "telegram",
					chatType: "private",
				},
			}),
		]);
	});

	it("replies once for unsupported message types", async () => {
		const reply = vi.fn(async () => undefined);
		const { channel } = createChannel();
		await handleUnsupportedMessage(
			{
				chat: { id: 42, type: "private" },
				from: { id: 99 },
				message: {
					photo: [
						{
							file_id: "file-1",
						},
					],
				},
				reply,
			},
			channel,
		);

		expect(reply).toHaveBeenCalledWith(UNSUPPORTED_MESSAGE);
	});

	it("ignores blocked sender ids", async () => {
		const reply = vi.fn(async () => undefined);
		const bus = new InMemoryMessageBus();
		const channel = new TelegramChannel({
			name: TELEGRAM_CHANNEL_NAME,
			displayName: "Telegram",
			config: {
				enabled: true,
				token: "123:abc",
				allowFrom: ["123"],
				chatIds: [],
			},
			bus,
		});
		let published = false;

		bus.subscribeInbound(async () => {
			published = true;
		});

		await handleTextMessage(
			{
				chat: { id: 42, type: "private" },
				from: { id: 999 },
				message: { text: "hello" },
				reply,
			},
			channel,
		);

		expect(reply).not.toHaveBeenCalled();
		expect(published).toBe(false);
	});

	it("ignores group chat text messages", async () => {
		const reply = vi.fn(async () => undefined);
		const bus = new InMemoryMessageBus();
		const channel = new TelegramChannel({
			name: TELEGRAM_CHANNEL_NAME,
			displayName: "Telegram",
			config: {
				enabled: true,
				token: "123:abc",
				allowFrom: ["*"],
				chatIds: [],
			},
			bus,
		});
		let published = false;

		bus.subscribeInbound(async () => {
			published = true;
		});

		await handleTextMessage(
			{
				chat: { id: 42, type: "group" },
				from: { id: 99 },
				message: { text: "hello" },
				reply,
			},
			channel,
		);

		expect(reply).not.toHaveBeenCalled();
		expect(published).toBe(false);
	});

	it("ignores private messages when sender id is missing", async () => {
		const reply = vi.fn(async () => undefined);
		const { channel, bus } = createChannel();
		let published = false;

		bus.subscribeInbound(async () => {
			published = true;
		});

		await handleTextMessage(
			{
				chat: { id: 42, type: "private" },
				message: { text: "hello" },
				reply,
			},
			channel,
		);

		expect(reply).not.toHaveBeenCalled();
		expect(published).toBe(false);
	});

	it("delivers system messages to every configured chat id", async () => {
		const sendMessage = vi.fn(async () => undefined);
		const { channel } = createChannel(sendMessage);

		await expect(
			channel.send({
				channel: "telegram",
				role: SYSTEM_ROLE,
				content: "deploy finished",
			}),
		).resolves.toBe(2);

		expect(sendMessage).toHaveBeenNthCalledWith(
			1,
			"111",
			"[system] deploy finished",
		);
		expect(sendMessage).toHaveBeenNthCalledWith(
			2,
			"222",
			"[system] deploy finished",
		);
	});

	it("fails system delivery when no target chats are configured", async () => {
		const channel = new TelegramChannel({
			name: TELEGRAM_CHANNEL_NAME,
			displayName: "Telegram",
			config: {
				enabled: true,
				token: "123:abc",
				allowFrom: ["*"],
				chatIds: [],
			},
			bus: new InMemoryMessageBus(),
		});

		await expect(
			channel.send({
				channel: "telegram",
				role: SYSTEM_ROLE,
				content: "deploy finished",
			}),
		).rejects.toThrow("no configured chatIds");
	});

	it("fails system delivery when message content is empty", async () => {
		const { channel } = createChannel();

		await expect(
			channel.send({
				channel: "telegram",
				role: SYSTEM_ROLE,
				content: "   ",
			}),
		).rejects.toThrow("cannot be empty");
	});
});
