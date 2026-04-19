import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	fauxAssistantMessage,
	registerFauxProvider,
	streamSimple,
	type Message,
} from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
	createSessionAgent,
	FileSessionStore,
	getLatestAssistantText,
	resolveAgentRuntimeConfig,
} from "../src/agent/loop.js";
import { InMemoryMessageBus } from "../src/channels/bus.js";
import {
	GATEWAY_RUNTIME_ERROR_MESSAGE,
	GatewayRuntime,
	resolveChannelSessionKey,
} from "../src/gateway/index.js";
import { DEFAULT_CONFIG } from "../src/config/loader.js";
import type { Logger } from "../src/utils/logging.js";

const LOGGER: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
};

function createRuntimeConfig(sessionStorePath: string) {
	return resolveAgentRuntimeConfig({
		...DEFAULT_CONFIG,
		workspace: {
			path: path.dirname(sessionStorePath),
		},
		agent: {
			...DEFAULT_CONFIG.agent,
			sessionStore: {
				type: "file",
				path: sessionStorePath,
			},
		},
	});
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return {
		promise,
		resolve,
		reject,
	};
}

function createMemorySessionStore() {
	return {
		load: async () => null,
		save: async () => undefined,
		list: async () => [],
		delete: async () => undefined,
	};
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

describe("gateway runtime", () => {
	it("resolves session keys from override first and channel/chat second", () => {
		expect(
			resolveChannelSessionKey({
				channel: "telegram",
				chatId: "42",
				sessionKeyOverride: "topic:7",
			}),
		).toBe("topic:7");
		expect(
			resolveChannelSessionKey({
				channel: "telegram",
				chatId: "42",
				sessionKeyOverride: undefined,
			}),
		).toBe("telegram:42");
	});

	it("subscribes to inbound bus traffic and publishes assistant replies", async () => {
		const bus = new InMemoryMessageBus();
		const prompts: string[] = [];
		const agentMessages: Message[] = [];
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: {
					messages: agentMessages,
				},
				prompt: async (input: string) => {
					prompts.push(input);
					agentMessages.push({
						role: "user",
						content: input,
						timestamp: Date.now(),
					});
					agentMessages.push({
						role: "assistant",
						content: [{ type: "text", text: `reply:${input}` }],
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
						timestamp: Date.now(),
					});
				},
			}),
		});

		const published: Array<{
			channel: string;
			chatId?: string;
			content: string;
			role?: string;
		}> = [];
		bus.subscribeOutbound(async (message) => {
			published.push(message);
		});

		await runtime.start();
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "hello",
			timestamp: new Date(),
		});

		await waitUntil(() => {
			expect(published).toHaveLength(1);
		});
		await runtime.stop();

		expect(prompts).toEqual(["hello"]);
		expect(published[0]).toEqual(
			expect.objectContaining({
				channel: "telegram",
				chatId: "42",
				content: "reply:hello",
				role: "assistant",
			}),
		);
	});

	it("serializes processing per session key", async () => {
		const bus = new InMemoryMessageBus();
		const firstTurn = createDeferred<void>();
		const secondTurn = createDeferred<void>();
		const started: string[] = [];
		const prompts: string[] = [];
		const messages: Message[] = [];
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: {
					messages,
				},
				prompt: async (input: string) => {
					started.push(input);
					if (input === "first") {
						await firstTurn.promise;
					} else {
						await secondTurn.promise;
					}
					prompts.push(input);
					messages.push({
						role: "assistant",
						content: [{ type: "text", text: input }],
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
						timestamp: Date.now(),
					});
				},
			}),
		});

		await runtime.start();
		await bus.publishInbound({
			channel: "telegram",
			senderId: "1",
			chatId: "42",
			content: "first",
			timestamp: new Date(),
		});
		await waitUntil(() => {
			expect(started).toEqual(["first"]);
		});

		await bus.publishInbound({
			channel: "telegram",
			senderId: "1",
			chatId: "42",
			content: "second",
			timestamp: new Date(),
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(started).toEqual(["first"]);

		firstTurn.resolve();
		await waitUntil(() => {
			expect(started).toEqual(["first", "second"]);
		});

		secondTurn.resolve();
		await runtime.stop();

		expect(prompts).toEqual(["first", "second"]);
	});

	it("allows different sessions to run in parallel", async () => {
		const bus = new InMemoryMessageBus();
		const firstTurn = createDeferred<void>();
		const secondTurn = createDeferred<void>();
		const started: string[] = [];
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async ({ sessionKey }) => ({
				state: {
					messages: [],
				},
				prompt: async () => {
					started.push(sessionKey);
					if (sessionKey === "telegram:1") {
						await firstTurn.promise;
					} else {
						await secondTurn.promise;
					}
				},
			}),
		});

		await runtime.start();
		await Promise.all([
			bus.publishInbound({
				channel: "telegram",
				senderId: "1",
				chatId: "1",
				content: "a",
				timestamp: new Date(),
			}),
			bus.publishInbound({
				channel: "telegram",
				senderId: "2",
				chatId: "2",
				content: "b",
				timestamp: new Date(),
			}),
		]);

		await waitUntil(() => {
			expect(started.sort()).toEqual(["telegram:1", "telegram:2"]);
		});

		firstTurn.resolve();
		secondTurn.resolve();
		await runtime.stop();
	});

	it("loads existing transcript history and persists the settled reply", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-gateway-"));
		const store = new FileSessionStore(path.join(dir, "sessions"));
		const registration = registerFauxProvider();
		const published: string[] = [];

		try {
			await store.save({
				key: "telegram:42",
				createdAt: "2026-04-19T08:00:00.000Z",
				updatedAt: "2026-04-19T08:00:00.000Z",
				metadata: {},
				messages: [
					{
						role: "user",
						content: "earlier",
						timestamp: 1,
					},
				],
			});
			registration.setResponses([fauxAssistantMessage("gateway reply")]);

			const bus = new InMemoryMessageBus();
			bus.subscribeOutbound(async (message) => {
				published.push(message.content);
			});

			const runtime = new GatewayRuntime({
				bus,
				logger: LOGGER,
				config: createRuntimeConfig(path.join(dir, "sessions")),
				sessionStore: store,
				createAgent: (options) =>
					createSessionAgent({
						config: options.config,
						sessionKey: options.sessionKey,
						sessionStore: options.sessionStore,
						tools: options.tools,
						streamFn: (_model, context, streamOptions) =>
							streamSimple(
								registration.getModel(),
								context,
								streamOptions,
							),
					}),
			});

			await runtime.start();
			await bus.publishInbound({
				channel: "telegram",
				senderId: "99",
				chatId: "42",
				content: "hello",
				timestamp: new Date(),
			});

			await waitUntil(() => {
				expect(published).toEqual(["gateway reply"]);
			});
			await runtime.stop();

			const persisted = await store.load("telegram:42");
			expect(persisted?.messages).toHaveLength(3);
			expect(getLatestAssistantText(persisted?.messages ?? [])).toBe(
				"gateway reply",
			);
		} finally {
			registration.unregister();
		}
	});

	it("does not emit a fallback reply when no new assistant message exists", async () => {
		const bus = new InMemoryMessageBus();
		const published: string[] = [];
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: {
					messages: [],
				},
				prompt: async () => undefined,
			}),
		});

		bus.subscribeOutbound(async (message) => {
			published.push(message.content);
		});

		await runtime.start();
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "hello",
			timestamp: new Date(),
		});
		await runtime.stop();

		expect(published).toEqual([]);
	});

	it("publishes a generic error reply when prompt execution fails", async () => {
		const bus = new InMemoryMessageBus();
		const published: string[] = [];
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: {
					messages: [],
				},
				prompt: async () => {
					throw new Error("boom");
				},
			}),
		});

		bus.subscribeOutbound(async (message) => {
			published.push(message.content);
		});

		await runtime.start();
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "hello",
			timestamp: new Date(),
		});

		await waitUntil(() => {
			expect(published).toEqual([GATEWAY_RUNTIME_ERROR_MESSAGE]);
		});
		await runtime.stop();
	});
});
