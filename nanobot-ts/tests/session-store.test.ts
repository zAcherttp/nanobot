import { mkdtemp, readdir, writeFile } from "node:fs/promises";
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
			lastConsolidated: 0,
			metadata: {
				scope: "test",
			},
			messages: createMessages(),
		});

		await expect(store.load("cli:alice")).resolves.toEqual({
			key: "cli:alice",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T08:00:01.000Z",
			lastConsolidated: 0,
			metadata: {
				scope: "test",
				persistence: expect.objectContaining({
					lastSavedMessageCount: 2,
				}),
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
			lastConsolidated: 0,
			metadata: {},
			messages: createMessages(),
		});
		await store.save({
			key: "cli:bob",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T08:00:02.000Z",
			lastConsolidated: 0,
			metadata: {},
			messages: createMessages(),
		});

		const sessions = await store.list();

		expect(sessions.map((session) => session.key)).toEqual([
			"cli:bob",
			"cli:alice",
		]);
		expect(sessions[0]?.hasRuntimeCheckpoint).toBe(false);
		expect(await store.load("cli:carol")).toBeNull();
	});

	it("quarantines corrupt files and continues", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-sessions-"));
		const store = new FileSessionStore(dir, {
			maxMessages: 500,
			maxPersistedTextChars: 16_000,
			quarantineCorruptFiles: true,
		});
		const corruptedKey = "cli:broken";
		const corruptedPath = path.join(
			dir,
			`${Buffer.from(corruptedKey, "utf8").toString("base64url")}.json`,
		);
		await writeFile(corruptedPath, "{this is not valid json", "utf8");

		await expect(store.load(corruptedKey)).resolves.toBeNull();

		const entries = await readdir(dir);
		expect(entries.some((entry) => entry.endsWith(".corrupt."))).toBe(false);
		expect(
			entries.some(
				(entry) =>
					entry.startsWith("Y2xpOmJyb2tlbg") && entry.includes(".corrupt."),
			),
		).toBe(true);
		expect(entries).not.toContain(path.basename(corruptedPath));
	});

	it("overwrites the same key without creating duplicates", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-sessions-"));
		const store = new FileSessionStore(dir);

		await store.save({
			key: "cli:alice",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T08:00:00.000Z",
			lastConsolidated: 0,
			metadata: {},
			messages: createMessages(),
		});
		await store.save({
			key: "cli:alice",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T09:00:00.000Z",
			lastConsolidated: 0,
			metadata: { updated: true },
			messages: createMessages(),
		});

		const sessions = await store.list();
		expect(sessions.filter((s) => s.key === "cli:alice")).toHaveLength(1);
		expect(sessions[0]?.updatedAt).toBe("2026-04-17T09:00:00.000Z");
	});

	it("saves and loads a session with an empty messages array", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-sessions-"));
		const store = new FileSessionStore(dir);

		await store.save({
			key: "cli:empty",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T08:00:00.000Z",
			lastConsolidated: 0,
			metadata: {},
			messages: [],
		});

		const loaded = await store.load("cli:empty");
		expect(loaded).not.toBeNull();
		expect(loaded?.messages).toEqual([]);
	});

	it("round-trips across separate store instances with the same root", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-sessions-"));
		const store1 = new FileSessionStore(dir);

		await store1.save({
			key: "cli:persist",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T08:00:00.000Z",
			lastConsolidated: 0,
			metadata: { foo: "bar" },
			messages: createMessages(),
		});

		const store2 = new FileSessionStore(dir);
		const loaded = await store2.load("cli:persist");
		expect(loaded).not.toBeNull();
		expect(loaded?.key).toBe("cli:persist");
		expect((loaded?.metadata as Record<string, unknown>)?.foo).toBe("bar");
		expect(loaded?.messages).toHaveLength(2);
	});

	it("preserves hasRuntimeCheckpoint in list summaries", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-sessions-"));
		const store = new FileSessionStore(dir);

		await store.save({
			key: "cli:checkpoint",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T08:00:00.000Z",
			lastConsolidated: 0,
			metadata: {
				runtimeCheckpoint: {
					assistantMessage: {
						role: "assistant",
						content: [{ type: "text", text: "partial" }],
						api: "test",
						provider: "anthropic",
						model: "claude-opus-4-5",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						stopReason: "toolUse",
						timestamp: 1,
					},
					completedToolResults: [],
					pendingToolCalls: [{ id: "tc-1", name: "probe" }],
					updatedAt: "2026-04-17T08:00:01.000Z",
				},
			},
			messages: createMessages(),
		});
		await store.save({
			key: "cli:nocheckpoint",
			createdAt: "2026-04-17T08:00:00.000Z",
			updatedAt: "2026-04-17T08:00:00.000Z",
			lastConsolidated: 0,
			metadata: {},
			messages: createMessages(),
		});

		const sessions = await store.list();
		const withCheckpoint = sessions.find((s) => s.key === "cli:checkpoint");
		const noCheckpoint = sessions.find((s) => s.key === "cli:nocheckpoint");
		expect(withCheckpoint?.hasRuntimeCheckpoint).toBe(true);
		expect(noCheckpoint?.hasRuntimeCheckpoint).toBe(false);
	});
});
