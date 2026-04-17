import { describe, expect, it, vi } from "vitest";

import { AgentLoop } from "../src/agent/loop.js";
import {
	handleStart,
	handleTextMessage,
	handleUnsupportedMessage,
	START_MESSAGE,
	UNSUPPORTED_MESSAGE,
} from "../src/channels/telegram.js";

describe("telegram bot", () => {
	it("replies to /start with onboarding text", async () => {
		const reply = vi.fn(async () => undefined);
		await handleStart({ reply });

		expect(reply).toHaveBeenCalledWith(START_MESSAGE);
	});

	it("replies to plain text with stub echo", async () => {
		const reply = vi.fn(async () => undefined);
		await handleTextMessage(
			{
				chat: { id: 42, type: "private" },
				from: { id: 99 },
				message: { text: "hello" },
				reply,
			},
			{ enabled: true, token: "123:abc", allowFrom: ["*"] },
			new AgentLoop(),
		);

		expect(reply).toHaveBeenCalledWith("you said : hello");
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
			{ enabled: true, token: "123:abc", allowFrom: ["*"] },
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
			{ enabled: true, token: "123:abc", allowFrom: ["123"] },
			new AgentLoop(),
		);

		expect(reply).not.toHaveBeenCalled();
	});
});
