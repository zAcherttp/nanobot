import { mkdtemp } from "node:fs/promises";
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

	it.todo("write and read soul round-trips");
	it.todo("read_user returns empty string when file is missing");
	it.todo("write and read user round-trips");
	it.todo("read_goals returns empty string when file is missing");
	it.todo("write and read goals round-trips");
	it.todo("get_memory_context returns empty string when no memory written");
	it.todo("get_memory_context returns formatted content with heading");
});

describe("memory store — history with cursor", () => {
	it.todo("append_history returns an incrementing cursor");
	it.todo("append_history includes the cursor in the persisted file");
	it.todo("append_history persists signal metadata");
	it.todo("cursor persists across appends");
	it.todo("read_unprocessed_history returns entries after cursor");
	it.todo("read_unprocessed_history returns all when cursor is zero");
	it.todo("compact_history drops the oldest entries");
	it.todo("initial cursor is zero");
	it.todo("set and get cursor round-trips");
	it.todo("cursor persists across store instances");
	it.todo("read_unprocessed_history handles entries without cursor field");
});

describe("memory store — legacy migration", () => {
	it.todo("migrates legacy HISTORY.md preserving partial entries");
	it.todo("migrates consecutive entries without blank lines");
	it.todo("raw archive stays as single entry while following events split");
	it.todo("non-standard date headers still start new entries");
	it.todo("existing history.jsonl skips legacy migration");
	it.todo("empty history.jsonl still allows legacy migration");
	it.todo("migrates legacy history with invalid UTF-8 bytes");
});
