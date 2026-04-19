import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import { FileSessionStore } from "../src/agent/session-store.js";

function createMessages(): Message[] {
	return [
		{
			role: "user",
			content: "hello",
			timestamp: 1,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4.1-mini",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: 2,
		},
	];
}

describe("file session store", () => {
	it("round-trips sessions while preserving timestamps", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-sessions-"));
		const store = new FileSessionStore(dir);

		await store.save({
			key: "cli:alice",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T08:00:01.000Z",
			metadata: {
				scope: "test",
			},
			messages: createMessages(),
		});

		await expect(store.load("cli:alice")).resolves.toEqual({
			key: "cli:alice",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T08:00:01.000Z",
			metadata: {
				scope: "test",
			},
			messages: createMessages(),
		});
	});

	it("keeps session keys isolated and lists the newest first", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-sessions-"));
		const store = new FileSessionStore(dir);

		await store.save({
			key: "cli:alice",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T08:00:00.000Z",
			metadata: {},
			messages: createMessages(),
		});
		await store.save({
			key: "cli:bob",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T08:00:02.000Z",
			metadata: {},
			messages: createMessages(),
		});

		const sessions = await store.list();

		expect(sessions.map((session) => session.key)).toEqual([
			"cli:bob",
			"cli:alice",
		]);
		expect(await store.load("cli:carol")).toBeNull();
	});
});
