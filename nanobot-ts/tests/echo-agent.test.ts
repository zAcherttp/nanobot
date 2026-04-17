import { describe, expect, it } from "vitest";

import { AgentLoop } from "../src/agent/loop.js";

describe("AgentLoop", () => {
	it("reuses the same session for the same chat id", async () => {
		const agent = new AgentLoop();

		await agent.reply("chat-1", "hello");
		await agent.reply("chat-1", "again");

		expect(agent.getSessionCount()).toBe(1);
		expect(agent.hasSession("chat-1")).toBe(true);
	});

	it("isolates sessions per chat id", async () => {
		const agent = new AgentLoop();

		await agent.reply("chat-1", "hello");
		await agent.reply("chat-2", "world");

		expect(agent.getSessionCount()).toBe(2);
	});

	it("returns deterministic stub response", async () => {
		const agent = new AgentLoop();

		await expect(agent.reply("chat-1", "ping")).resolves.toBe(
			"you said : ping",
		);
	});
});
