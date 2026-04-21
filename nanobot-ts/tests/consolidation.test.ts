import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
	Consolidator,
	FileSessionStore,
	type SessionRecord,
	type SessionStore,
} from "../src/agent/loop.js";
import { resolveAgentRuntimeConfig } from "../src/agent/runtime.js";
import { InMemoryMessageBus } from "../src/channels/bus.js";
import {
	DEFAULT_CONFIG,
	DEFAULT_CONFIG_FILENAME,
} from "../src/config/loader.js";
import { GatewayRuntime } from "../src/gateway/index.js";
import { MemoryStore } from "../src/memory/index.js";
import type { Logger } from "../src/utils/logging.js";

const LOGGER: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
};

class MapSessionStore implements SessionStore {
	constructor(private readonly records = new Map<string, SessionRecord>()) {}

	async load(key: string): Promise<SessionRecord | null> {
		const record = this.records.get(key);
		return record ? structuredClone(record) : null;
	}

	async save(session: SessionRecord): Promise<void> {
		this.records.set(session.key, structuredClone(session));
	}

	async list() {
		return [];
	}

	async delete(key: string): Promise<void> {
		this.records.delete(key);
	}
}

function createRuntimeConfig(workspacePath: string) {
	return resolveAgentRuntimeConfig({
		...DEFAULT_CONFIG,
		workspace: {
			path: workspacePath,
		},
		providers: {
			anthropic: {
				apiKey: "test-provider-key",
			},
		},
		agent: {
			...DEFAULT_CONFIG.agent,
			contextWindowTokens: 64,
			sessionStore: {
				...DEFAULT_CONFIG.agent.sessionStore,
				type: "file",
				path: path.join(workspacePath, "sessions"),
			},
		},
	});
}

function createSession(
	key: string,
	messages: Message[],
	lastConsolidated = 0,
): SessionRecord {
	return {
		key,
		createdAt: "2026-04-20T08:00:00.000Z",
		updatedAt: "2026-04-20T08:00:00.000Z",
		lastConsolidated,
		metadata: {},
		messages: structuredClone(messages),
	};
}

function user(content: string, timestamp: number): Message {
	return {
		role: "user",
		content,
		timestamp,
	};
}

function assistant(content: string, timestamp: number): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "anthropic-messages",
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
		stopReason: "stop",
		timestamp,
	};
}

function createAssistantReply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createConsolidator(
	workspacePath: string,
	sessionStore: SessionStore,
	overrides: Partial<{
		contextWindowTokens: number;
		complete: (
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		) => Promise<AssistantMessage>;
		getTools: () => AgentTool[] | Promise<AgentTool[]>;
	}> = {},
): Consolidator {
	const config = {
		...createRuntimeConfig(workspacePath),
		...(overrides.contextWindowTokens
			? { contextWindowTokens: overrides.contextWindowTokens }
			: {}),
	};

	return new Consolidator({
		memoryStore: new MemoryStore(workspacePath),
		sessionStore,
		config,
		buildSystemPrompt: async () => "system prompt",
		...(overrides.complete ? { complete: overrides.complete } : {}),
		...(overrides.getTools ? { getTools: overrides.getTools } : {}),
	});
}

async function createConfigFile(workspacePath: string): Promise<string> {
	const configDir = path.join(workspacePath, ".nanobot");
	await mkdir(configDir, { recursive: true });
	const configPath = path.join(configDir, DEFAULT_CONFIG_FILENAME);
	await writeFile(
		configPath,
		JSON.stringify({
			...DEFAULT_CONFIG,
			workspace: {
				path: workspacePath,
			},
			providers: {
				anthropic: {
					apiKey: "test-provider-key",
				},
			},
			agent: {
				...DEFAULT_CONFIG.agent,
				contextWindowTokens: 64,
				sessionStore: {
					...DEFAULT_CONFIG.agent.sessionStore,
					type: "file",
					path: path.join(workspacePath, "sessions"),
				},
			},
		}),
		"utf8",
	);
	return configPath;
}

async function waitUntil(assertion: () => void): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			assertion();
			return;
		} catch (error) {
			if (attempt === 49) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

describe("consolidator - summary generation", () => {
	it("appends a summary to the history store after consolidation", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const sessionStore = new MapSessionStore(
			new Map([
				[
					"telegram:42",
					createSession("telegram:42", [
						user("alpha", 1),
						assistant("beta", 2),
						user("gamma", 3),
						assistant("delta", 4),
					]),
				],
			]),
		);
		const consolidator = createConsolidator(workspace, sessionStore, {
			contextWindowTokens: 32,
			complete: async () =>
				createAssistantReply(
					JSON.stringify({
						content: "archived summary",
						signals: { topic: "project" },
					}),
				),
		});

		await consolidator.maybeConsolidateByTokens("telegram:42", "telegram");

		const history = await new MemoryStore(workspace).readUnprocessedHistory(0);
		expect(history).toHaveLength(1);
		expect(history[0]?.content).toBe("archived summary");
		expect(history[0]?.signals).toEqual({ topic: "project" });
		expect((await sessionStore.load("telegram:42"))?.lastConsolidated).toBe(2);
	});

	it("parses plain text archive responses when JSON parsing fails", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const sessionStore = new MapSessionStore();
		const consolidator = createConsolidator(workspace, sessionStore, {
			complete: async () => createAssistantReply("plain archive summary"),
		});

		const archived = await consolidator.archive([
			user("alpha", 1),
			assistant("beta", 2),
		]);

		expect(archived).toEqual({
			content: "plain archive summary",
			signals: {},
		});
		const history = await new MemoryStore(workspace).readUnprocessedHistory(0);
		expect(history[0]?.content).toBe("plain archive summary");
	});

	it("falls back to raw dump when LLM summary fails", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const sessionStore = new MapSessionStore();
		const consolidator = createConsolidator(workspace, sessionStore, {
			complete: async () => {
				throw new Error("boom");
			},
		});

		const archived = await consolidator.archive([
			user("alpha", 1),
			assistant("beta", 2),
		]);

		expect(archived).toBeNull();
		const history = await new MemoryStore(workspace).readUnprocessedHistory(0);
		expect(history[0]?.content).toContain("[RAW] 2 messages");
		expect(history[0]?.content).toContain("USER: alpha");
		expect(history[0]?.content).toContain("ASSISTANT: beta");
	});

	it("skips consolidation when there are no messages to summarize", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const sessionStore = new MapSessionStore();
		const consolidator = createConsolidator(workspace, sessionStore);

		const archived = await consolidator.archive([]);

		expect(archived).toBeNull();
		expect(await new MemoryStore(workspace).readUnprocessedHistory(0)).toEqual(
			[],
		);
	});
});

describe("consolidator - threshold and chunking", () => {
	it("does not consolidate when prompt is below token threshold", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const session = createSession("telegram:42", [
			user("short", 1),
			assistant("tiny", 2),
		]);
		const sessionStore = new MapSessionStore(
			new Map([["telegram:42", session]]),
		);
		const archiveSpy = vi.fn(async () =>
			createAssistantReply("should not run"),
		);
		const consolidator = createConsolidator(workspace, sessionStore, {
			contextWindowTokens: 10_000,
			complete: archiveSpy,
		});

		await consolidator.maybeConsolidateByTokens("telegram:42", "telegram");

		expect(archiveSpy).not.toHaveBeenCalled();
		expect((await sessionStore.load("telegram:42"))?.lastConsolidated).toBe(0);
	});

	it("chunk cap preserves user turn boundary", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const sessionStore = new MapSessionStore();
		const consolidator = createConsolidator(workspace, sessionStore);
		const boundary = consolidator.pickConsolidationBoundary(
			createSession("telegram:42", [
				user("alpha", 1),
				assistant("beta", 2),
				assistant("gamma", 3),
				user("delta", 4),
				assistant("epsilon", 5),
			]),
			1,
		);

		expect(boundary).toBe(3);
	});

	it("chunk cap skips when no user boundary exists within cap", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const sessionStore = new MapSessionStore();
		const consolidator = createConsolidator(workspace, sessionStore);
		const longTail = [
			user("alpha", 1),
			...Array.from({ length: 65 }, (_value, index) =>
				assistant(`reply-${index}`, index + 2),
			),
		];

		const boundary = consolidator.pickConsolidationBoundary(
			createSession("telegram:42", longTail),
			10,
		);

		expect(boundary).toBe(0);
	});

	it("does not mutate the message list in place while consolidating", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const messages = [
			user("alpha", 1),
			assistant("beta", 2),
			user("gamma", 3),
			assistant("delta", 4),
		];
		const originalSnapshot = structuredClone(messages);
		const sessionStore = new MapSessionStore(
			new Map([["telegram:42", createSession("telegram:42", messages)]]),
		);
		const consolidator = createConsolidator(workspace, sessionStore, {
			contextWindowTokens: 32,
			complete: async () =>
				createAssistantReply(
					JSON.stringify({ content: "summary", signals: {} }),
				),
		});

		await consolidator.maybeConsolidateByTokens("telegram:42", "telegram");

		expect(messages).toEqual(originalSnapshot);
	});
});

describe("consolidation offset tracking", () => {
	it("initial last_consolidated is zero and invalid stored values do not crash", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const store = new FileSessionStore(dir);
		const encoded = Buffer.from("telegram:42", "utf8").toString("base64url");
		await writeFile(
			path.join(dir, `${encoded}.json`),
			JSON.stringify({
				key: "telegram:42",
				createdAt: "2026-04-20T08:00:00.000Z",
				updatedAt: "2026-04-20T08:00:00.000Z",
				lastConsolidated: -10,
				metadata: {},
				messages: [user("hello", 1)],
			}),
			"utf8",
		);

		const loaded = await store.load("telegram:42");

		expect(loaded?.lastConsolidated).toBe(0);
	});

	it("last_consolidated persists across store instances", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const store1 = new FileSessionStore(dir);
		await store1.save(createSession("telegram:42", [user("hello", 1)], 1));

		const store2 = new FileSessionStore(dir);
		const loaded = await store2.load("telegram:42");

		expect(loaded?.lastConsolidated).toBe(1);
	});
});

describe("consolidation offset - /new command integration", () => {
	it("/new clears session immediately even if archive fails", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const store = new MapSessionStore(
			new Map([
				[
					"telegram:42",
					createSession(
						"telegram:42",
						[user("earlier", 1), assistant("reply", 2)],
						0,
					),
				],
			]),
		);
		const archiveSpy = vi.fn(async () => {
			throw new Error("archive failed");
		});
		const bus = new InMemoryMessageBus();
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig(workspace),
			sessionStore: store,
			createAgent: async () => ({
				state: { messages: [] },
				abort: () => undefined,
				reset: () => undefined,
				prompt: async () => undefined,
			}),
			createConsolidator: () =>
				({
					archive: archiveSpy,
					estimateSessionPromptTokens: async () => 12,
				}) as unknown as Consolidator,
		});
		const published: string[] = [];
		bus.subscribeOutbound(async (message) => {
			published.push(message.content);
		});

		await runtime.start();
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "/new",
			timestamp: new Date(),
		});
		await waitUntil(() => {
			expect(published).toContain("New session started.");
		});
		await runtime.stop();

		expect((await store.load("telegram:42"))?.messages).toEqual([]);
		expect((await store.load("telegram:42"))?.lastConsolidated).toBe(0);
		expect(archiveSpy).toHaveBeenCalledOnce();
	});

	it("/new archives only unconsolidated messages", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const store = new MapSessionStore(
			new Map([
				[
					"telegram:42",
					createSession(
						"telegram:42",
						[
							user("old", 1),
							assistant("already archived", 2),
							user("fresh", 3),
							assistant("keep me", 4),
						],
						2,
					),
				],
			]),
		);
		const archivedChunks: Message[][] = [];
		const bus = new InMemoryMessageBus();
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig(workspace),
			sessionStore: store,
			createAgent: async () => ({
				state: { messages: [] },
				abort: () => undefined,
				reset: () => undefined,
				prompt: async () => undefined,
			}),
			createConsolidator: () =>
				({
					archive: async (messages: Message[]) => {
						archivedChunks.push(structuredClone(messages));
						return { content: "summary", signals: {} };
					},
					estimateSessionPromptTokens: async () => 18,
				}) as unknown as Consolidator,
		});

		await runtime.start();
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "/new",
			timestamp: new Date(),
		});
		await waitUntil(() => {
			expect(archivedChunks).toHaveLength(1);
		});
		await runtime.stop();

		expect(archivedChunks[0]?.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect((archivedChunks[0]?.[0] as Message | undefined)?.role).toBe("user");
		expect((await store.load("telegram:42"))?.messages).toEqual([]);
	});
});

describe("consolidator - /status integration", () => {
	it("/status reports estimator-backed prompt token counts", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cons-"));
		const configPath = await createConfigFile(workspace);
		const store = new MapSessionStore(
			new Map([
				["telegram:42", createSession("telegram:42", [user("hello", 1)], 0)],
			]),
		);
		const bus = new InMemoryMessageBus();
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: resolveAgentRuntimeConfig({
				...DEFAULT_CONFIG,
				workspace: { path: workspace },
				providers: { anthropic: { apiKey: "test-provider-key" } },
				agent: {
					...DEFAULT_CONFIG.agent,
					contextWindowTokens: 64,
					sessionStore: {
						...DEFAULT_CONFIG.agent.sessionStore,
						type: "file",
						path: path.join(workspace, "sessions"),
					},
				},
			}),
			sessionStore: store,
			createAgent: async () => {
				throw new Error("agent should not be created for /status");
			},
			createConsolidator: () =>
				({
					estimateSessionPromptTokens: async () => 27,
				}) as unknown as Consolidator,
		});
		const published: string[] = [];
		bus.subscribeOutbound(async (message) => {
			published.push(message.content);
		});

		await runtime.start();
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "/status",
			timestamp: new Date(),
		});
		await waitUntil(() => {
			expect(published).toHaveLength(1);
		});
		await runtime.stop();

		expect(configPath).toContain(DEFAULT_CONFIG_FILENAME);
		expect(published[0]).toContain("Prompt tokens: 27/64");
	});
});
