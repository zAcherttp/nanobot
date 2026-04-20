import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	type Message,
	registerFauxProvider,
	streamSimple,
} from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	AutoCompactor,
	type ConsolidatorArchiveResult,
	createSessionAgent,
	FileSessionStore,
	getLatestAssistantText,
	resolveAgentRuntimeConfig,
	type SessionRecord,
	type SessionStore,
} from "../src/agent/loop.js";
import {
	DEFAULT_CONFIG,
	DEFAULT_CONFIG_FILENAME,
	loadConfig,
	saveConfig,
} from "../src/config/loader.js";
import {
	NANOBOT_FAUX_MODEL_ID,
	NANOBOT_FAUX_PROVIDER,
} from "../src/providers/faux.js";

const NOW = new Date("2026-04-20T10:00:00.000Z");

function user(content: string, timestamp = 1): Message {
	return {
		role: "user",
		content,
		timestamp,
	};
}

function assistant(content: string, timestamp = 1): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
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
		stopReason: "endTurn",
		timestamp,
	};
}

function session(
	key: string,
	messages: Message[],
	overrides: Partial<SessionRecord> = {},
): SessionRecord {
	return {
		key,
		createdAt: "2026-04-20T08:00:00.000Z",
		updatedAt: "2026-04-20T08:30:00.000Z",
		lastConsolidated: 0,
		metadata: {},
		messages,
		...overrides,
	};
}

class MapSessionStore implements SessionStore {
	readonly records = new Map<string, SessionRecord>();

	constructor(initial: SessionRecord[] = []) {
		for (const record of initial) {
			this.records.set(record.key, structuredClone(record));
		}
	}

	async load(key: string): Promise<SessionRecord | null> {
		const record = this.records.get(key);
		return record ? structuredClone(record) : null;
	}

	async save(record: SessionRecord): Promise<void> {
		this.records.set(record.key, structuredClone(record));
	}

	async list() {
		return [...this.records.values()]
			.map((record) => ({
				key: record.key,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
				path: record.key,
				messageCount: record.messages.length,
				hasRuntimeCheckpoint: Boolean(record.metadata.runtimeCheckpoint),
			}))
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	async delete(key: string): Promise<void> {
		this.records.delete(key);
	}
}

function createCompactor(options: {
	store: SessionStore;
	idleCompactAfterMinutes?: number;
	archive?: (
		messages: readonly Message[],
	) => Promise<ConsolidatorArchiveResult | null>;
	isSessionActive?: (sessionKey: string) => boolean | Promise<boolean>;
	now?: Date;
}) {
	const archive =
		options.archive ??
		vi.fn(async () => ({
			content: "archived summary",
			signals: {},
		}));
	return {
		archive,
		compactor: new AutoCompactor({
			sessionStore: options.store,
			consolidator: { archive },
			idleCompactAfterMinutes: options.idleCompactAfterMinutes ?? 30,
			...(options.isSessionActive
				? { isSessionActive: options.isSessionActive }
				: {}),
			now: () => options.now ?? NOW,
		}),
	};
}

describe("auto-compact - session TTL config", () => {
	it("defaults idleCompactAfterMinutes to zero", () => {
		expect(DEFAULT_CONFIG.agent.idleCompactAfterMinutes).toBe(0);
	});

	it("accepts a custom idleCompactAfterMinutes value", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-autocfg-"));
		const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
		await writeFile(
			configPath,
			JSON.stringify({
				...DEFAULT_CONFIG,
				agent: {
					...DEFAULT_CONFIG.agent,
					idleCompactAfterMinutes: 15,
				},
			}),
			"utf8",
		);

		const loaded = await loadConfig({ cliConfigPath: configPath });

		expect(loaded.config.agent.idleCompactAfterMinutes).toBe(15);
	});

	it("rejects the legacy sessionTtlMinutes key", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-autocfg-"));
		const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
		await writeFile(
			configPath,
			JSON.stringify({
				...DEFAULT_CONFIG,
				agent: {
					...DEFAULT_CONFIG.agent,
					sessionTtlMinutes: 15,
				},
			}),
			"utf8",
		);

		await expect(loadConfig({ cliConfigPath: configPath })).rejects.toThrow(
			/sessionTtlMinutes|unrecognized/i,
		);
	});

	it("serializes only idleCompactAfterMinutes", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-autocfg-"));
		const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
		await saveConfig(
			{
				...DEFAULT_CONFIG,
				agent: {
					...DEFAULT_CONFIG.agent,
					idleCompactAfterMinutes: 5,
				},
			},
			configPath,
		);

		const raw = JSON.parse(await readFile(configPath, "utf8")) as {
			agent: Record<string, unknown>;
		};
		expect(raw.agent.idleCompactAfterMinutes).toBe(5);
		expect(raw.agent.sessionTtlMinutes).toBeUndefined();
	});
});

describe("auto-compact - idle detection and sweep", () => {
	it("expires exactly at the TTL boundary", () => {
		const store = new MapSessionStore();
		const { compactor } = createCompactor({
			store,
			idleCompactAfterMinutes: 30,
			now: new Date("2026-04-20T10:30:00.000Z"),
		});

		expect(compactor.isExpired("2026-04-20T10:00:00.000Z")).toBe(true);
		expect(compactor.isExpired("2026-04-20T10:00:01.000Z")).toBe(false);
		expect(compactor.isExpired("")).toBe(false);
	});

	it("does not sweep when TTL is disabled", async () => {
		const store = new MapSessionStore([
			session("telegram:1", [user("old")], {
				updatedAt: "2026-04-20T08:00:00.000Z",
			}),
		]);
		const { compactor, archive } = createCompactor({
			store,
			idleCompactAfterMinutes: 0,
		});

		await compactor.sweepOnce();

		expect(archive).not.toHaveBeenCalled();
		expect((await store.load("telegram:1"))?.messages).toHaveLength(1);
	});

	it("skips active sessions during proactive sweep", async () => {
		const store = new MapSessionStore([
			session("telegram:1", [user("old")], {
				updatedAt: "2026-04-20T08:00:00.000Z",
			}),
		]);
		const { compactor, archive } = createCompactor({
			store,
			isSessionActive: (key) => key === "telegram:1",
		});

		await compactor.sweepOnce();

		expect(archive).not.toHaveBeenCalled();
		expect((await store.load("telegram:1"))?.updatedAt).toBe(
			"2026-04-20T08:00:00.000Z",
		);
	});

	it("does not duplicate an archive already in progress", async () => {
		const store = new MapSessionStore([
			session(
				"telegram:1",
				[
					user("a", 1),
					assistant("b", 2),
					user("c", 3),
					assistant("d", 4),
					user("e", 5),
					assistant("f", 6),
					user("g", 7),
					assistant("h", 8),
					user("i", 9),
					assistant("j", 10),
				],
				{ updatedAt: "2026-04-20T08:00:00.000Z" },
			),
		]);
		let release!: () => void;
		const { compactor, archive } = createCompactor({
			store,
			archive: vi.fn(
				() =>
					new Promise((resolve) => {
						release = () =>
							resolve({
								content: "summary",
								signals: {},
							});
					}),
			),
		});

		const first = compactor.sweepOnce();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = compactor.sweepOnce();
		release();
		await Promise.all([first, second]);

		expect(archive).toHaveBeenCalledTimes(1);
	});
});

describe("auto-compact - archival behavior", () => {
	it("archives prefix messages and keeps a legal recent suffix", async () => {
		const messages = Array.from({ length: 12 }, (_entry, index) =>
			index % 2 === 0
				? user(`u${index}`, index)
				: assistant(`a${index}`, index),
		);
		const store = new MapSessionStore([
			session("telegram:1", messages, {
				updatedAt: "2026-04-20T08:00:00.000Z",
			}),
		]);
		const { compactor, archive } = createCompactor({ store });

		await compactor.sweepOnce();

		expect(archive).toHaveBeenCalledWith(messages.slice(0, 4));
		const compacted = await store.load("telegram:1");
		expect(compacted?.messages.map((message) => message.timestamp)).toEqual([
			4, 5, 6, 7, 8, 9, 10, 11,
		]);
		expect(compacted?.lastConsolidated).toBe(0);
		expect(compacted?.updatedAt).toBe(NOW.toISOString());
		expect(compacted?.metadata._last_summary).toEqual({
			text: "archived summary",
			last_active: "2026-04-20T08:00:00.000Z",
		});
	});

	it("respects lastConsolidated when choosing the archive prefix", async () => {
		const messages = Array.from({ length: 14 }, (_entry, index) =>
			index % 2 === 0
				? user(`u${index}`, index)
				: assistant(`a${index}`, index),
		);
		const store = new MapSessionStore([
			session("telegram:1", messages, {
				lastConsolidated: 4,
				updatedAt: "2026-04-20T08:00:00.000Z",
			}),
		]);
		const { compactor, archive } = createCompactor({ store });

		await compactor.sweepOnce();

		expect(archive).toHaveBeenCalledWith(messages.slice(4, 6));
		expect(
			(await store.load("telegram:1"))?.messages.map((m) => m.timestamp),
		).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
	});

	it("suppresses exact '(nothing)' summaries", async () => {
		const store = new MapSessionStore([
			session(
				"telegram:1",
				Array.from({ length: 10 }, (_entry, index) =>
					index % 2 === 0
						? user(`u${index}`, index)
						: assistant(`a${index}`, index),
				),
				{ updatedAt: "2026-04-20T08:00:00.000Z" },
			),
		]);
		const { compactor } = createCompactor({
			store,
			archive: async () => ({
				content: "(nothing)",
				signals: {},
			}),
		});

		await compactor.sweepOnce();

		expect(
			(await store.load("telegram:1"))?.metadata._last_summary,
		).toBeUndefined();
	});

	it("keeps the recent suffix if archival throws", async () => {
		const messages = Array.from({ length: 10 }, (_entry, index) =>
			index % 2 === 0
				? user(`u${index}`, index)
				: assistant(`a${index}`, index),
		);
		const store = new MapSessionStore([
			session("telegram:1", messages, {
				updatedAt: "2026-04-20T08:00:00.000Z",
			}),
		]);
		const { compactor } = createCompactor({
			store,
			archive: async () => {
				throw new Error("archive failed");
			},
		});

		await compactor.sweepOnce();

		expect(
			(await store.load("telegram:1"))?.messages.map((m) => m.timestamp),
		).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("preserves runtime checkpoint metadata", async () => {
		const store = new MapSessionStore([
			session(
				"telegram:1",
				Array.from({ length: 10 }, (_entry, index) =>
					index % 2 === 0
						? user(`u${index}`, index)
						: assistant(`a${index}`, index),
				),
				{
					updatedAt: "2026-04-20T08:00:00.000Z",
					metadata: {
						runtimeCheckpoint: {
							completedToolResults: [],
							pendingToolCalls: [{ id: "tc-1", name: "probe" }],
							updatedAt: "2026-04-20T08:01:00.000Z",
						},
					},
				},
			),
		]);
		const { compactor } = createCompactor({ store });

		await compactor.sweepOnce();

		expect(
			(await store.load("telegram:1"))?.metadata.runtimeCheckpoint,
		).toEqual(
			expect.objectContaining({
				pendingToolCalls: [{ id: "tc-1", name: "probe" }],
			}),
		);
	});
});

describe("auto-compact - resume lifecycle", () => {
	it("prepares a one-shot summary context and removes stale metadata", async () => {
		const store = new MapSessionStore([
			session("telegram:1", [user("recent")], {
				updatedAt: NOW.toISOString(),
				metadata: {
					_last_summary: {
						text: "Earlier useful facts.",
						last_active: "2026-04-20T09:00:00.000Z",
					},
				},
			}),
		]);
		const { compactor } = createCompactor({ store });

		const prepared = await compactor.prepareSession("telegram:1");

		expect(prepared?.summaryContext).toContain("Inactive for 60 minutes.");
		expect(prepared?.summaryContext).toContain("Earlier useful facts.");
		expect(
			(await store.load("telegram:1"))?.metadata._last_summary,
		).toBeUndefined();
		expect(
			(await compactor.prepareSession("telegram:1"))?.summaryContext,
		).toBeUndefined();
	});

	it("injects summary context into direct agent runs without persisting it", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-autort-"));
		const store = new FileSessionStore(path.join(dir, "sessions"));
		const registration = registerFauxProvider();
		const capturedContexts: Context[] = [];

		try {
			await store.save(
				session("cli:direct", [user("recent")], {
					updatedAt: NOW.toISOString(),
					metadata: {
						_last_summary: {
							text: "The old topic was staging.",
							last_active: "2026-04-20T09:00:00.000Z",
						},
					},
				}),
			);
			registration.setResponses([fauxAssistantMessage("new reply")]);
			const config = resolveAgentRuntimeConfig({
				...DEFAULT_CONFIG,
				workspace: {
					path: dir,
				},
				agent: {
					...DEFAULT_CONFIG.agent,
					provider: NANOBOT_FAUX_PROVIDER,
					modelId: NANOBOT_FAUX_MODEL_ID,
					sessionStore: {
						...DEFAULT_CONFIG.agent.sessionStore,
						path: path.join(dir, "sessions"),
					},
				},
			});
			const agent = await createSessionAgent({
				config,
				sessionKey: "cli:direct",
				sessionStore: store,
				streamFn: (_model, context, options) => {
					capturedContexts.push(structuredClone(context));
					return streamSimple(registration.getModel(), context, options);
				},
			});

			await agent.prompt("continue");

			expect(getLatestAssistantText(agent.state.messages)).toBe("new reply");
			expect(JSON.stringify(capturedContexts[0]?.messages)).toContain(
				"The old topic was staging.",
			);
			const persisted = await store.load("cli:direct");
			expect(JSON.stringify(persisted?.messages)).not.toContain(
				"The old topic was staging.",
			);
			expect(persisted?.metadata._last_summary).toBeUndefined();
		} finally {
			registration.unregister();
		}
	});
});

describe("auto-compact - background service", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("schedules repeated sweeps on start", async () => {
		const store = new MapSessionStore();
		const { compactor } = createCompactor({ store });
		vi.spyOn(compactor, "sweepOnce").mockResolvedValue();

		await compactor.start();
		expect(compactor.isRunning()).toBe(true);

		await vi.advanceTimersByTimeAsync(1100);
		expect(compactor.sweepOnce).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1000);
		expect(compactor.sweepOnce).toHaveBeenCalledTimes(2);

		await compactor.stop();
	});

	it("halts sweeps exactly when stopped", async () => {
		const store = new MapSessionStore();
		const { compactor } = createCompactor({ store });
		vi.spyOn(compactor, "sweepOnce").mockResolvedValue();

		await compactor.start();
		await vi.advanceTimersByTimeAsync(1100);
		expect(compactor.sweepOnce).toHaveBeenCalledTimes(1);

		await compactor.stop();
		expect(compactor.isRunning()).toBe(false);

		await vi.advanceTimersByTimeAsync(2000);
		expect(compactor.sweepOnce).toHaveBeenCalledTimes(1); // did not increase
	});

	it("does not start if idleCompactAfterMinutes is missing or 0", async () => {
		const store = new MapSessionStore();
		const { compactor } = createCompactor({
			store,
			idleCompactAfterMinutes: 0,
		});

		await compactor.start();
		expect(compactor.isRunning()).toBe(false);
	});

	it("continues timer loop even if a sweep throws an error", async () => {
		const store = new MapSessionStore();
		const { compactor } = createCompactor({ store });
		let errorThrown = false;
		vi.spyOn(compactor, "sweepOnce").mockImplementation(async () => {
			if (!errorThrown) {
				errorThrown = true;
				throw new Error("Transient error");
			}
		});

		await compactor.start();

		await vi.advanceTimersByTimeAsync(1100);
		expect(compactor.sweepOnce).toHaveBeenCalledTimes(1);
		expect(errorThrown).toBe(true);

		await vi.advanceTimersByTimeAsync(1000);
		expect(compactor.sweepOnce).toHaveBeenCalledTimes(2);

		await compactor.stop();
	});
});
