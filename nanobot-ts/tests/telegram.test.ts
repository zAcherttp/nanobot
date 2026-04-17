import { describe, expect, it, vi } from "vitest";

import {
	handleStart,
	handleTextMessage,
	handleUnsupportedMessage,
	START_MESSAGE,
	SYSTEM_ROLE,
	sendSystemMessage,
	UNSUPPORTED_MESSAGE,
} from "../src/channels/telegram.js";

describe("telegram channel", () => {
	it("replies to /start with onboarding text", async () => {
		const reply = vi.fn(async () => undefined);
		await handleStart({ reply });

		expect(reply).toHaveBeenCalledWith(START_MESSAGE);
	});

	it("does not echo plain text messages", async () => {
		const reply = vi.fn(async () => undefined);
		await handleTextMessage(
			{
				chat: { id: 42, type: "private" },
				from: { id: 99 },
				message: { text: "hello" },
				reply,
			},
			{ enabled: true, token: "123:abc", allowFrom: ["*"], chatIds: [] },
		);

		expect(reply).not.toHaveBeenCalled();
	});

	it("replies once for unsupported message types", async () => {
		const reply = vi.fn(async () => undefined);
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
			{ enabled: true, token: "123:abc", allowFrom: ["*"], chatIds: [] },
		);

		expect(reply).toHaveBeenCalledWith(UNSUPPORTED_MESSAGE);
	});

	it("ignores blocked sender ids", async () => {
		const reply = vi.fn(async () => undefined);
		await handleTextMessage(
			{
				chat: { id: 42, type: "private" },
				from: { id: 999 },
				message: { text: "hello" },
				reply,
			},
			{ enabled: true, token: "123:abc", allowFrom: ["123"], chatIds: [] },
		);

		expect(reply).not.toHaveBeenCalled();
	});

	it("ignores group chat text messages", async () => {
		const reply = vi.fn(async () => undefined);
		await handleTextMessage(
			{
				chat: { id: 42, type: "group" },
				from: { id: 99 },
				message: { text: "hello" },
				reply,
			},
			{ enabled: true, token: "123:abc", allowFrom: ["*"], chatIds: [] },
		);

		expect(reply).not.toHaveBeenCalled();
	});

	it("delivers system messages to every configured chat id", async () => {
		const sendMessage = vi.fn(async () => undefined);

		await expect(
			sendSystemMessage(
				{
					enabled: true,
					token: "123:abc",
					allowFrom: ["*"],
					chatIds: ["111", "222"],
				},
				{ role: SYSTEM_ROLE, content: "deploy finished" },
				{ sendMessage },
			),
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
		await expect(
			sendSystemMessage(
				{
					enabled: true,
					token: "123:abc",
					allowFrom: ["*"],
					chatIds: [],
				},
				{ role: SYSTEM_ROLE, content: "deploy finished" },
			),
		).rejects.toThrow("no configured chatIds");
	});

	it("fails system delivery when message content is empty", async () => {
		await expect(
			sendSystemMessage(
				{
					enabled: true,
					token: "123:abc",
					allowFrom: ["*"],
					chatIds: ["111"],
				},
				{ role: SYSTEM_ROLE, content: "   " },
			),
		).rejects.toThrow("cannot be empty");
	});
});
