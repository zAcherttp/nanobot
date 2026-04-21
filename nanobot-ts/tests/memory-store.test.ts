import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../src/memory/index.js";

describe("memory store - basic I/O", () => {
	let store: MemoryStore;

	beforeEach(async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-memory-"),
		);
		store = new MemoryStore(workspace);
		await store.init();
	});

	it("read_memory returns empty string when file is missing", async () => {
		await expect(store.readMemory()).resolves.toBe("");
	});

	it("write and read memory round-trips", async () => {
		await store.writeMemory("hello");
		await expect(store.readMemory()).resolves.toBe("hello");
	});

	it("read_soul returns empty string when file is missing", async () => {
		await expect(store.readSoul()).resolves.toBe("");
	});

	it("write and read soul round-trips", async () => {
		await store.writeSoul("soul config");
		await expect(store.readSoul()).resolves.toBe("soul config");
	});

	it("read_user returns empty string when file is missing", async () => {
		await expect(store.readUser()).resolves.toBe("");
	});

	it("write and read user round-trips", async () => {
		await store.writeUser("user rules");
		await expect(store.readUser()).resolves.toBe("user rules");
	});

	it("read_goals returns empty string when file is missing", async () => {
		await expect(store.readGoals()).resolves.toBe("");
	});

	it("write and read goals round-trips", async () => {
		await store.writeGoals("new goals");
		await expect(store.readGoals()).resolves.toBe("new goals");
	});

	it("get_memory_context returns empty string when no memory written", async () => {
		await expect(store.getMemoryContext()).resolves.toBe("");
	});

	it("get_memory_context returns formatted content with heading", async () => {
		await store.writeMemory("I like apples.");
		await expect(store.getMemoryContext()).resolves.toBe(
			"## Long-term Memory\nI like apples.",
		);
	});
});

describe("memory store — history with cursor", () => {
	let store: MemoryStore;
	let workspace: string;

	beforeEach(async () => {
		workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-memory-"));
		store = new MemoryStore(workspace, { maxHistoryEntries: 3 });
		await store.init();
	});

	it("append_history returns an incrementing cursor", async () => {
		expect(await store.appendHistory("event 1")).toBe(1);
		expect(await store.appendHistory("event 2")).toBe(2);
	});

	it("append_history includes the cursor in the persisted file", async () => {
		await store.appendHistory("my event");
		const content = await readFile(
			path.join(workspace, "memory", "history.jsonl"),
			"utf8",
		);
		const parsed = JSON.parse(content.trim());
		expect(parsed.cursor).toBe(1);
		expect(parsed.content).toBe("my event");
	});

	it("append_history persists signal metadata", async () => {
		await store.appendHistory("hi", { emotion: "happy" });
		const content = await readFile(
			path.join(workspace, "memory", "history.jsonl"),
			"utf8",
		);
		const parsed = JSON.parse(content.trim());
		expect(parsed.signals).toEqual({ emotion: "happy" });
	});

	it("cursor persists across appends", async () => {
		await store.appendHistory("first");
		await store.appendHistory("second");
		expect(await store.appendHistory("third")).toBe(3);
	});

	it("read_unprocessed_history returns entries after cursor", async () => {
		await store.appendHistory("A");
		await store.appendHistory("B");
		await store.appendHistory("C");
		const entries = await store.readUnprocessedHistory(1);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.content).toBe("B");
		expect(entries[1]?.content).toBe("C");
	});

	it("read_unprocessed_history returns all when cursor is zero", async () => {
		await store.appendHistory("A");
		await store.appendHistory("B");
		const entries = await store.readUnprocessedHistory(0);
		expect(entries).toHaveLength(2);
	});

	it("compact_history drops the oldest entries", async () => {
		await store.appendHistory("A");
		await store.appendHistory("B");
		await store.appendHistory("C");
		await store.appendHistory("D");
		await store.compactHistory();
		const entries = await store.readUnprocessedHistory(0);
		expect(entries).toHaveLength(3);
		expect(entries[0]?.content).toBe("B");
	});

	it("initial cursor is zero", async () => {
		expect(await store.getLastDreamCursor()).toBe(0);
	});

	it("set and get cursor round-trips", async () => {
		await store.setLastDreamCursor(42);
		expect(await store.getLastDreamCursor()).toBe(42);
	});

	it("cursor persists across store instances", async () => {
		await store.setLastDreamCursor(13);
		const store2 = new MemoryStore(workspace);
		expect(await store2.getLastDreamCursor()).toBe(13);
	});

	it("read_unprocessed_history handles entries without cursor field", async () => {
		await writeFile(
			path.join(workspace, "memory", "history.jsonl"),
			`${JSON.stringify({ content: "no cursor" })}\n`,
			"utf8",
		);
		const entries = await store.readUnprocessedHistory(0);
		expect(entries[0]?.cursor).toBe(1);
		expect(entries[0]?.content).toBe("no cursor");
	});
});
