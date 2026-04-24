import { describe, expect, it, vi } from "vitest";

import { InMemoryMessageBus } from "../src/channels/bus.js";
import {
	handleStart,
	handleTextMessage,
	handleUnsupportedMessage,
	normalizeTelegramCommandText,
	START_MESSAGE,
	SYSTEM_ROLE,
	TELEGRAM_CHANNEL_NAME,
	TelegramChannel,
	UNSUPPORTED_MESSAGE,
} from "../src/channels/telegram.js";
import type { Logger } from "../src/utils/logging.js";

describe("telegram channel", () => {
	function createMockLogger(): Logger {
		return {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			trace: vi.fn(),
			fatal: vi.fn(),
		};
	}

	function createChannel(
		sendMessage = vi.fn(async () => undefined),
		editMessage = vi.fn(async () => undefined),
		now = () => new Date("2026-04-17T08:00:00.000Z"),
		logger?: Logger,
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
					streaming: true,
					streamEditIntervalMs: 1000,
				},
				bus,
			},
			{ sendMessage, editMessage, now, ...(logger ? { logger } : {}) },
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
		const logger = createMockLogger();
		const { channel, bus } = createChannel(
			undefined,
			undefined,
			undefined,
			logger,
		);
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
		expect(logger.debug).toHaveBeenCalledWith(
			"Telegram message received",
			expect.objectContaining({
				component: "telegram",
				event: "inbound",
				chatId: "42",
				senderId: "99",
				contentPreview: "hello",
			}),
		);
	});

	it("allows private text messages by Telegram username with or without @", async () => {
		for (const allowFrom of [["ttuanphat"], ["@ttuanphat"], ["@TTUANPHAT"]]) {
			const reply = vi.fn(async () => undefined);
			const bus = new InMemoryMessageBus();
			const channel = new TelegramChannel({
				name: TELEGRAM_CHANNEL_NAME,
				displayName: "Telegram",
				config: {
					enabled: true,
					token: "123:abc",
					allowFrom,
					chatIds: [],
					streaming: true,
					streamEditIntervalMs: 1000,
				},
				bus,
			});
			const inbound: unknown[] = [];

			bus.subscribeInbound(async (message) => {
				inbound.push(message);
			});

			await handleTextMessage(
				{
					chat: { id: 42, type: "private" },
					from: { id: 99, username: "ttuanphat" },
					message: { text: "hello" },
					reply,
				},
				channel,
			);

			expect(reply).not.toHaveBeenCalled();
			expect(inbound).toEqual([
				expect.objectContaining({
					senderId: "99",
					chatId: "42",
					content: "hello",
					metadata: expect.objectContaining({
						username: "ttuanphat",
					}),
				}),
			]);
		}
	});

	it("normalizes Telegram-safe Dream aliases before publishing inbound commands", async () => {
		expect(
			normalizeTelegramCommandText("/dream_log@nanobot_test deadbeef"),
		).toBe("/dream-log deadbeef");
		expect(
			normalizeTelegramCommandText("/dream_restore@nanobot_test deadbeef"),
		).toBe("/dream-restore deadbeef");
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
		const logger = createMockLogger();
		const channel = new TelegramChannel(
			{
				name: TELEGRAM_CHANNEL_NAME,
				displayName: "Telegram",
				config: {
					enabled: true,
					token: "123:abc",
					allowFrom: ["123"],
					chatIds: [],
					streaming: true,
					streamEditIntervalMs: 1000,
				},
				bus,
			},
			{ logger },
		);
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
		expect(logger.debug).toHaveBeenCalledWith(
			"Telegram message blocked by allowlist",
			expect.objectContaining({
				component: "telegram",
				event: "inbound_blocked",
				chatId: "42",
				senderId: "999",
			}),
		);
	});

	it("blocks username allowlist entries when Telegram does not provide a username", async () => {
		const reply = vi.fn(async () => undefined);
		const bus = new InMemoryMessageBus();
		const logger = createMockLogger();
		const channel = new TelegramChannel(
			{
				name: TELEGRAM_CHANNEL_NAME,
				displayName: "Telegram",
				config: {
					enabled: true,
					token: "123:abc",
					allowFrom: ["ttuanphat"],
					chatIds: [],
					streaming: true,
					streamEditIntervalMs: 1000,
				},
				bus,
			},
			{ logger },
		);
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
		expect(logger.debug).toHaveBeenCalledWith(
			"Telegram message blocked by allowlist",
			expect.objectContaining({
				component: "telegram",
				event: "inbound_blocked",
				chatId: "42",
				senderId: "999",
			}),
		);
	});

	it("ignores group chat text messages", async () => {
		const reply = vi.fn(async () => undefined);
		const bus = new InMemoryMessageBus();
		const logger = createMockLogger();
		const channel = new TelegramChannel(
			{
				name: TELEGRAM_CHANNEL_NAME,
				displayName: "Telegram",
				config: {
					enabled: true,
					token: "123:abc",
					allowFrom: ["*"],
					chatIds: [],
					streaming: true,
					streamEditIntervalMs: 1000,
				},
				bus,
			},
			{ logger },
		);
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
		expect(logger.debug).toHaveBeenCalledWith(
			"Telegram message ignored from non-private chat",
			expect.objectContaining({
				component: "telegram",
				event: "inbound_ignored",
				reason: "non_private_chat",
				chatType: "group",
			}),
		);
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
		const logger = createMockLogger();
		const { channel } = createChannel(
			sendMessage,
			undefined,
			undefined,
			logger,
		);

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
		expect(logger.info).toHaveBeenCalledWith(
			"Telegram outbound delivered",
			expect.objectContaining({
				component: "telegram",
				event: "outbound_delivered",
				targets: 2,
				contentPreview: "deploy finished",
			}),
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
				streaming: true,
				streamEditIntervalMs: 1000,
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

	it("streams assistant text by sending first and editing later deltas", async () => {
		const sendMessage = vi.fn(async () => ({ message_id: 7 }));
		const editMessage = vi.fn(async () => undefined);
		const logger = createMockLogger();
		let currentTime = Date.parse("2026-04-17T08:00:00.000Z");
		const { channel } = createChannel(
			sendMessage,
			editMessage,
			() => new Date(currentTime),
			logger,
		);

		await channel.send({
			channel: "telegram",
			chatId: "111",
			content: "Hello",
			role: "assistant",
			metadata: {
				_stream_delta: true,
				_stream_id: "stream-1",
			},
		});
		currentTime += 1100;
		await channel.send({
			channel: "telegram",
			chatId: "111",
			content: " world",
			role: "assistant",
			metadata: {
				_stream_delta: true,
				_stream_id: "stream-1",
			},
		});
		await channel.send({
			channel: "telegram",
			chatId: "111",
			content: "",
			role: "assistant",
			metadata: {
				_stream_end: true,
				_stream_id: "stream-1",
			},
		});

		expect(sendMessage).toHaveBeenCalledOnce();
		expect(sendMessage).toHaveBeenCalledWith("111", "Hello");
		expect(editMessage).toHaveBeenCalledWith("111", 7, "Hello world");
		expect(logger.debug).toHaveBeenCalledWith(
			"Telegram stream message sent",
			expect.objectContaining({
				component: "telegram",
				event: "stream_start",
				streamId: "stream-1",
			}),
		);
		expect(logger.debug).toHaveBeenCalledWith(
			"Telegram stream message edited",
			expect.objectContaining({
				component: "telegram",
				event: "stream_edit",
				streamId: "stream-1",
			}),
		);
		expect(logger.debug).toHaveBeenCalledWith(
			"Telegram stream finalized",
			expect.objectContaining({
				component: "telegram",
				event: "stream_end",
				streamId: "stream-1",
			}),
		);
	});

	it("does not fail the stream when Telegram edits fail", async () => {
		const sendMessage = vi
			.fn()
			.mockResolvedValueOnce({ message_id: 7 })
			.mockResolvedValueOnce({ message_id: 8 });
		const editMessage = vi.fn(async () => {
			throw new Error("network timeout");
		});
		const logger = createMockLogger();
		let currentTime = Date.parse("2026-04-17T08:00:00.000Z");
		const { channel } = createChannel(
			sendMessage,
			editMessage,
			() => new Date(currentTime),
			logger,
		);

		await channel.send({
			channel: "telegram",
			chatId: "111",
			content: "Hello",
			role: "assistant",
			metadata: {
				_stream_delta: true,
				_stream_id: "stream-fail",
			},
		});
		currentTime += 1100;
		await expect(
			channel.send({
				channel: "telegram",
				chatId: "111",
				content: " world",
				role: "assistant",
				metadata: {
					_stream_delta: true,
					_stream_id: "stream-fail",
				},
			}),
		).resolves.toBe(1);
		await expect(
			channel.send({
				channel: "telegram",
				chatId: "111",
				content: "",
				role: "assistant",
				metadata: {
					_stream_end: true,
					_stream_id: "stream-fail",
				},
			}),
		).resolves.toBe(1);

		expect(editMessage).toHaveBeenCalled();
		expect(sendMessage).toHaveBeenNthCalledWith(1, "111", "Hello");
		expect(sendMessage).toHaveBeenNthCalledWith(2, "111", "Hello world");
		expect(logger.warn).toHaveBeenCalledWith(
			"Telegram stream edit failed",
			expect.objectContaining({
				component: "telegram",
				event: "stream_edit_failed",
				streamId: "stream-fail",
			}),
		);
		expect(logger.warn).toHaveBeenCalledWith(
			"Telegram stream final edit failed; sent final text as a new message",
			expect.objectContaining({
				component: "telegram",
				event: "stream_final_fallback",
				streamId: "stream-fail",
			}),
		);
	});

	it("treats Telegram message-is-not-modified edit errors as harmless", async () => {
		const sendMessage = vi.fn(async () => ({ message_id: 7 }));
		const editMessage = vi.fn(async () => {
			throw new Error("Bad Request: message is not modified");
		});
		const logger = createMockLogger();
		let currentTime = Date.parse("2026-04-17T08:00:00.000Z");
		const { channel } = createChannel(
			sendMessage,
			editMessage,
			() => new Date(currentTime),
			logger,
		);

		await channel.send({
			channel: "telegram",
			chatId: "111",
			content: "Hello",
			role: "assistant",
			metadata: {
				_stream_delta: true,
				_stream_id: "stream-unchanged",
			},
		});
		currentTime += 1100;
		await channel.send({
			channel: "telegram",
			chatId: "111",
			content: " world",
			role: "assistant",
			metadata: {
				_stream_delta: true,
				_stream_id: "stream-unchanged",
			},
		});
		await channel.send({
			channel: "telegram",
			chatId: "111",
			content: "",
			role: "assistant",
			metadata: {
				_stream_end: true,
				_stream_id: "stream-unchanged",
			},
		});

		expect(sendMessage).toHaveBeenCalledOnce();
		expect(logger.debug).toHaveBeenCalledWith(
			"Telegram stream edit was already current",
			expect.objectContaining({
				component: "telegram",
				event: "stream_edit_unchanged",
				streamId: "stream-unchanged",
			}),
		);
	});

	it("strips markdown from streamed previews", async () => {
		const sendMessage = vi.fn(async () => ({ message_id: 7 }));
		const { channel } = createChannel(sendMessage);

		await channel.send({
			channel: "telegram",
			chatId: "111",
			content: "## **Hello** [docs](https://example.test)",
			role: "assistant",
			metadata: {
				_stream_delta: true,
				_stream_id: "stream-markdown",
			},
		});

		expect(sendMessage).toHaveBeenCalledWith("111", "Hello docs");
	});

	it("splits long streamed final text instead of truncating it", async () => {
		const sendMessage = vi.fn(async () => ({ message_id: 7 }));
		const { channel } = createChannel(sendMessage);
		const longText = "x ".repeat(2100);

		await channel.send({
			channel: "telegram",
			chatId: "111",
			content: longText,
			role: "assistant",
			metadata: {
				_stream_delta: true,
				_stream_id: "stream-long",
			},
		});
		await channel.send({
			channel: "telegram",
			chatId: "111",
			content: "",
			role: "assistant",
			metadata: {
				_stream_end: true,
				_stream_id: "stream-long",
			},
		});

		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(
			sendMessage.mock.calls.every(([, text]) => text.length <= 3900),
		).toBe(true);
		expect(sendMessage.mock.calls.map(([, text]) => text).join(" ")).toBe(
			longText.trim(),
		);
	});

	it("does not create a streamed message for whitespace-only deltas", async () => {
		const sendMessage = vi.fn(async () => ({ message_id: 7 }));
		const { channel } = createChannel(sendMessage);

		await expect(
			channel.send({
				channel: "telegram",
				chatId: "111",
				content: "   ",
				role: "assistant",
				metadata: {
					_stream_delta: true,
					_stream_id: "stream-2",
				},
			}),
		).resolves.toBe(0);

		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("sends tool hints as lightweight progress messages when streaming is enabled", async () => {
		const sendMessage = vi.fn(async () => undefined);
		const { channel } = createChannel(sendMessage);

		await expect(
			channel.send({
				channel: "telegram",
				chatId: "111",
				content: 'read_file({"path":"README.md"})',
				role: "assistant",
				metadata: {
					_progress: true,
					_tool_hint: true,
					_stream_id: "stream-3",
				},
			}),
		).resolves.toBe(1);

		expect(sendMessage).toHaveBeenCalledWith(
			"111",
			'read_file({"path":"README.md"})',
		);
	});
});
