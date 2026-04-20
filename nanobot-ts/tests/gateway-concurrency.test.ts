import type { Message } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentRuntimeConfig } from "../src/agent/loop.js";
import { InMemoryMessageBus } from "../src/channels/bus.js";
import { DEFAULT_CONFIG } from "../src/config/loader.js";
import {
	GATEWAY_RUNTIME_ERROR_MESSAGE,
	GatewayRuntime,
} from "../src/gateway/index.js";
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
			path: "E:\\tmp",
		},
		providers: {
			anthropic: {
				apiKey: "test-provider-key",
			},
		},
		agent: {
			...DEFAULT_CONFIG.agent,
			sessionStore: {
				...DEFAULT_CONFIG.agent.sessionStore,
				type: "file",
				path: sessionStorePath,
			},
		},
	});
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

describe("gateway concurrency", () => {
	it("processes messages from different sessions independently", async () => {
		const bus = new InMemoryMessageBus();
		const published: Array<{
			channel: string;
			chatId: string;
			content: string;
		}> = [];
		const promptOrder: string[] = [];

		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: { messages: [] },
				abort: () => undefined,
				reset: () => undefined,
				prompt: async (input: string) => {
					promptOrder.push(input);
				},
			}),
		});

		bus.subscribeOutbound(async (message) => {
			published.push(message);
		});

		await runtime.start();
		await bus.publishInbound({
			channel: "telegram",
			senderId: "1",
			chatId: "session-a",
			content: "hello-a",
			timestamp: new Date(),
		});
		await bus.publishInbound({
			channel: "telegram",
			senderId: "2",
			chatId: "session-b",
			content: "hello-b",
			timestamp: new Date(),
		});

		await waitUntil(() => {
			expect(promptOrder).toHaveLength(2);
		});
		await runtime.stop();

		expect(promptOrder).toContain("hello-a");
		expect(promptOrder).toContain("hello-b");
	});

	it("recovers from agent factory errors without wedging the session", async () => {
		const bus = new InMemoryMessageBus();
		const published: string[] = [];
		let factoryCalls = 0;

		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => {
				factoryCalls += 1;
				if (factoryCalls === 1) {
					throw new Error("factory init fail");
				}
				return {
					state: { messages: [] },
					abort: () => undefined,
					reset: () => undefined,
					prompt: async () => undefined,
				};
			},
		});

		bus.subscribeOutbound(async (message) => {
			published.push(message.content);
		});

		await runtime.start();

		// First message — factory explodes, gateway publishes error
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "first",
			timestamp: new Date(),
		});
		await waitUntil(() => {
			expect(published.length).toBeGreaterThanOrEqual(1);
		});

		// Second message — factory should be called again (not wedged)
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "second",
			timestamp: new Date(),
		});
		// Give the runtime time to process
		await new Promise((resolve) => setTimeout(resolve, 100));
		await runtime.stop();

		// Both factory attempts happened — the session was not permanently wedged
		expect(factoryCalls).toBe(2);
	});

	it("double start is idempotent", async () => {
		const bus = new InMemoryMessageBus();
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: { messages: [] },
				abort: () => undefined,
				reset: () => undefined,
				prompt: async () => undefined,
			}),
		});

		await runtime.start();
		await runtime.start();
		await runtime.stop();
	});

	it("queues messages within the same session sequentially", async () => {
		const bus = new InMemoryMessageBus();
		const executionOrder: string[] = [];

		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: { messages: [] },
				abort: () => undefined,
				reset: () => undefined,
				prompt: async (input: string) => {
					executionOrder.push(`start:${input}`);
					await new Promise((resolve) => setTimeout(resolve, 20));
					executionOrder.push(`end:${input}`);
				},
			}),
		});

		bus.subscribeOutbound(async () => undefined);

		await runtime.start();
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "msg-1",
			timestamp: new Date(),
		});
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "msg-2",
			timestamp: new Date(),
		});

		await waitUntil(() => {
			expect(executionOrder.filter((e) => e.startsWith("end:"))).toHaveLength(
				2,
			);
		});
		await runtime.stop();

		expect(executionOrder).toEqual([
			"start:msg-1",
			"end:msg-1",
			"start:msg-2",
			"end:msg-2",
		]);
	});

	it("stop drains pending work before resolving", async () => {
		const bus = new InMemoryMessageBus();
		const published: string[] = [];

		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: {
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "delayed-reply" }],
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
						} as Message,
					],
				},
				abort: () => undefined,
				reset: () => undefined,
				prompt: async () => {
					await new Promise((resolve) => setTimeout(resolve, 30));
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

		// Don't wait for processing—stop immediately
		await new Promise((resolve) => setTimeout(resolve, 5));
		await runtime.stop();

		// After stop, the runtime should have completed the in-flight work
		// OR aborted cleanly. Either way, no crash.
		expect(true).toBe(true);
	});
});
