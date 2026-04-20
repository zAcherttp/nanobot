import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	fauxAssistantMessage,
	type Message,
	registerFauxProvider,
	streamSimple,
} from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
	createSessionAgent,
	FileSessionStore,
	getLatestAssistantText,
	resolveAgentRuntimeConfig,
} from "../src/agent/loop.js";
import { InMemoryMessageBus } from "../src/channels/bus.js";
import { buildHelpText } from "../src/command/index.js";
import { DEFAULT_CONFIG } from "../src/config/loader.js";
import {
	GATEWAY_RUNTIME_ERROR_MESSAGE,
	GatewayRuntime,
	resolveChannelSessionKey,
} from "../src/gateway/index.js";
import {
	getNanobotFauxTools,
	NANOBOT_FAUX_MODEL_ID,
	NANOBOT_FAUX_PROVIDER,
} from "../src/providers/faux.js";
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

function createFauxRuntimeConfig(sessionStorePath: string) {
	return resolveAgentRuntimeConfig({
		...DEFAULT_CONFIG,
		workspace: {
			path: path.dirname(sessionStorePath),
		},
		agent: {
			...DEFAULT_CONFIG.agent,
			provider: NANOBOT_FAUX_PROVIDER,
			modelId: NANOBOT_FAUX_MODEL_ID,
			sessionStore: {
				...DEFAULT_CONFIG.agent.sessionStore,
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

function createMapSessionStore(
	initial: Array<{ key: string; messages?: Message[] }> = [],
) {
	const records = new Map(
		initial.map((entry) => [
			entry.key,
			{
				key: entry.key,
				createdAt: "2026-04-19T08:00:00.000Z",
				updatedAt: "2026-04-19T08:00:00.000Z",
				metadata: {},
				messages: entry.messages ?? [],
			},
		]),
	);

	return {
		load: async (key: string) => records.get(key) ?? null,
		save: async (session: {
			key: string;
			createdAt: string;
			updatedAt: string;
			metadata: Record<string, unknown>;
			messages: Message[];
		}) => {
			records.set(session.key, session);
		},
		list: async () => [],
		delete: async (key: string) => {
			records.delete(key);
		},
		records,
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
				abort: () => undefined,
				reset: () => {
					agentMessages.length = 0;
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

	it("emits stream delta and end markers for native assistant text streaming", async () => {
		const bus = new InMemoryMessageBus();
		const published: Array<{
			content: string;
			metadata?: Record<string, unknown>;
		}> = [];
		let listener:
			| ((event: {
					type: string;
					message?: Message;
					assistantMessageEvent?: { type: string; delta?: string };
			  }) => Promise<void> | void)
			| undefined;
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: {
					messages: [],
				},
				subscribe: (nextListener) => {
					listener = nextListener as typeof listener;
					return () => {
						listener = undefined;
					};
				},
				abort: () => undefined,
				reset: () => undefined,
				prompt: async () => {
					await listener?.({
						type: "message_update",
						assistantMessageEvent: {
							type: "text_delta",
							delta: "Hello",
						},
					});
					await listener?.({
						type: "message_update",
						assistantMessageEvent: {
							type: "text_delta",
							delta: " world",
						},
					});
					await listener?.({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Hello world" }],
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
						},
					});
				},
			}),
		});

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
			expect(published).toHaveLength(3);
		});
		await runtime.stop();

		expect(published[0]).toEqual(
			expect.objectContaining({
				content: "Hello",
				metadata: expect.objectContaining({
					_stream_delta: true,
				}),
			}),
		);
		expect(published[1]).toEqual(
			expect.objectContaining({
				content: " world",
				metadata: expect.objectContaining({
					_stream_delta: true,
				}),
			}),
		);
		expect(published[2]).toEqual(
			expect.objectContaining({
				content: "",
				metadata: expect.objectContaining({
					_stream_end: true,
					_streamed: true,
				}),
			}),
		);
	});

	it("emits tool hint progress markers from tool execution events", async () => {
		const bus = new InMemoryMessageBus();
		const published: Array<{
			content: string;
			metadata?: Record<string, unknown>;
		}> = [];
		let listener:
			| ((event: {
					type: string;
					toolName?: string;
					args?: unknown;
			  }) => Promise<void> | void)
			| undefined;
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: {
					messages: [],
				},
				subscribe: (nextListener) => {
					listener = nextListener as typeof listener;
					return () => {
						listener = undefined;
					};
				},
				abort: () => undefined,
				reset: () => undefined,
				prompt: async () => {
					await listener?.({
						type: "tool_execution_start",
						toolName: "read_file",
						args: {
							path: "README.md",
						},
					});
				},
			}),
		});

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

		expect(published[0]).toEqual(
			expect.objectContaining({
				content: 'read_file({"path":"README.md"})',
				metadata: expect.objectContaining({
					_progress: true,
					_tool_hint: true,
				}),
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
				abort: () => undefined,
				reset: () => {
					messages.length = 0;
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
				abort: () => undefined,
				reset: () => undefined,
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
							streamSimple(registration.getModel(), context, streamOptions),
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
				expect(published.at(-1)).toBe("");
				expect(published.filter((message) => message !== "").join("")).toBe(
					"gateway reply",
				);
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

	it("restores persisted checkpoints before processing the next gateway prompt", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-gateway-"));
		const store = new FileSessionStore(path.join(dir, "sessions"), {
			maxMessages: 500,
			maxPersistedTextChars: 16_000,
			quarantineCorruptFiles: true,
		});
		const registration = registerFauxProvider();
		const published: string[] = [];

		try {
			await store.save({
				key: "telegram:42",
				createdAt: "2026-04-19T08:00:00.000Z",
				updatedAt: "2026-04-19T08:00:00.000Z",
				messages: [],
				metadata: {
					runtimeCheckpoint: {
						assistantMessage: {
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "tool-1",
									name: "probe",
									arguments: { prompt: "staging" },
								},
							],
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
							timestamp: Date.now(),
						},
						completedToolResults: [],
						pendingToolCalls: [
							{
								id: "tool-1",
								name: "probe",
							},
						],
						updatedAt: "2026-04-19T08:00:01.000Z",
					},
				},
			});
			registration.setResponses([fauxAssistantMessage("after restore")]);

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
							streamSimple(registration.getModel(), context, streamOptions),
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
				expect(published.at(-1)).toBe("");
				expect(published.filter((message) => message !== "").join("")).toBe(
					"after restore",
				);
			});
			await runtime.stop();

			expect(
				(await store.load("telegram:42"))?.messages.map(
					(message) => message.role,
				),
			).toEqual(["assistant", "toolResult", "user", "assistant"]);
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
				abort: () => undefined,
				reset: () => undefined,
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
				abort: () => undefined,
				reset: () => undefined,
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

	it("runs the nanobot faux provider through streaming and tool hints", async () => {
		const bus = new InMemoryMessageBus();
		const published: Array<{
			content: string;
			metadata?: Record<string, unknown>;
		}> = [];
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createFauxRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			tools: getNanobotFauxTools(),
		});

		bus.subscribeOutbound(async (message) => {
			published.push(message);
		});

		await runtime.start();
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "inspect staging state",
			timestamp: new Date(),
		});

		await waitUntil(() => {
			expect(
				published.some(
					(message) =>
						message.metadata?._tool_hint === true &&
						message.content.includes("nanobot_faux_probe"),
				),
			).toBe(true);
			expect(
				published.some(
					(message) =>
						message.metadata?._stream_delta === true &&
						message.content.includes("Faux"),
				),
			).toBe(true);
			expect(
				published.filter((message) => message.metadata?._stream_end === true)
					.length,
			).toBeGreaterThanOrEqual(1);
		});
		await runtime.stop();

		const streamedText = published
			.filter((message) => message.metadata?._stream_delta === true)
			.map((message) => message.content)
			.join("");

		expect(streamedText).toContain("Faux stream start.");
		expect(streamedText).toContain("resumed after tool execution");
		expect(
			published.some(
				(message) => message.content === GATEWAY_RUNTIME_ERROR_MESSAGE,
			),
		).toBe(false);
	});

	it("does not publish a duplicate settled reply after a streamed turn", async () => {
		const bus = new InMemoryMessageBus();
		const published: Array<{
			content: string;
			metadata?: Record<string, unknown>;
		}> = [];
		let listener:
			| ((event: {
					type: string;
					message?: Message;
					assistantMessageEvent?: { type: string; delta?: string };
			  }) => Promise<void> | void)
			| undefined;
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
							content: [{ type: "text", text: "final" }],
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
							timestamp: 1,
						},
					],
				},
				subscribe: (nextListener) => {
					listener = nextListener as typeof listener;
					return () => {
						listener = undefined;
					};
				},
				abort: () => undefined,
				reset: () => undefined,
				prompt: async () => {
					await listener?.({
						type: "message_update",
						assistantMessageEvent: {
							type: "text_delta",
							delta: "final",
						},
					});
					await listener?.({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "final" }],
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
						},
					});
				},
			}),
		});

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
			expect(published).toHaveLength(2);
		});
		await runtime.stop();

		expect(published.map((message) => message.content)).toEqual(["final", ""]);
		expect(published.some((message) => message.content === "reply:hello")).toBe(
			false,
		);
	});

	it("finalizes an open stream on abort without publishing the generic error reply", async () => {
		const bus = new InMemoryMessageBus();
		const published: Array<{
			content: string;
			metadata?: Record<string, unknown>;
		}> = [];
		let rejectPrompt: ((reason?: unknown) => void) | undefined;
		let listener:
			| ((event: {
					type: string;
					assistantMessageEvent?: { type: string; delta?: string };
			  }) => Promise<void> | void)
			| undefined;
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: {
					messages: [],
				},
				subscribe: (nextListener) => {
					listener = nextListener as typeof listener;
					return () => {
						listener = undefined;
					};
				},
				abort: () => {
					rejectPrompt?.(new DOMException("Aborted", "AbortError"));
				},
				reset: () => undefined,
				prompt: async () => {
					await listener?.({
						type: "message_update",
						assistantMessageEvent: {
							type: "text_delta",
							delta: "partial",
						},
					});
					return new Promise<void>((_resolve, reject) => {
						rejectPrompt = reject;
					});
				},
			}),
		});

		bus.subscribeOutbound(async (message) => {
			published.push(message);
		});

		await runtime.start();
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "long task",
			timestamp: new Date(),
		});
		await waitUntil(() => {
			expect(published).toHaveLength(1);
		});

		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "/stop",
			timestamp: new Date(),
		});
		await waitUntil(() => {
			expect(published).toHaveLength(3);
		});
		await runtime.stop();

		expect(published[0]).toEqual(
			expect.objectContaining({
				content: "partial",
				metadata: expect.objectContaining({
					_stream_delta: true,
				}),
			}),
		);
		expect(
			published.some((message) => message.content === "Stopped 1 task(s)."),
		).toBe(true);
		expect(
			published.some((message) => message.metadata?._stream_end === true),
		).toBe(true);
		expect(
			published.some(
				(message) => message.content === GATEWAY_RUNTIME_ERROR_MESSAGE,
			),
		).toBe(false);
	});

	it("handles /help without invoking the agent", async () => {
		const bus = new InMemoryMessageBus();
		const published: string[] = [];
		let created = false;
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => {
				created = true;
				return {
					state: {
						messages: [],
					},
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
		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "/help",
			timestamp: new Date(),
		});

		await waitUntil(() => {
			expect(published).toEqual([buildHelpText()]);
		});
		await runtime.stop();

		expect(created).toBe(false);
	});

	it("returns TS runtime status for /status without invoking the agent", async () => {
		const bus = new InMemoryMessageBus();
		const published: string[] = [];
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMapSessionStore([
				{
					key: "telegram:42",
					messages: [
						{
							role: "user",
							content: "earlier",
							timestamp: 1,
						},
					],
				},
			]),
			createAgent: async () => {
				throw new Error("agent should not be created for /status");
			},
		});

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

		expect(published[0]).toContain("Provider: anthropic");
		expect(published[0]).toContain("Model: claude-opus-4-5");
		expect(published[0]).toContain("Provider auth: config");
		expect(published[0]).toContain("Session: telegram:42");
		expect(published[0]).toContain("Messages: 1");
		expect(published[0]).toContain("Channel: telegram");
		expect(published[0]).toContain("Chat: 42");
	});

	it("clears the session on /new and starts future prompts from a fresh transcript", async () => {
		const bus = new InMemoryMessageBus();
		const store = createMapSessionStore([
			{
				key: "telegram:42",
				messages: [
					{
						role: "user",
						content: "earlier",
						timestamp: 1,
					},
				],
			},
		]);
		const published: string[] = [];
		const initialMessageCounts: number[] = [];
		let agentFactoryCalls = 0;
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: store,
			createAgent: async ({ sessionKey, sessionStore }) => {
				agentFactoryCalls += 1;
				const loaded = await sessionStore.load(sessionKey);
				const messages = [...(loaded?.messages ?? [])];
				return {
					state: {
						messages,
					},
					abort: () => undefined,
					reset: () => {
						messages.length = 0;
					},
					prompt: async (input: string) => {
						initialMessageCounts.push(messages.length);
						messages.push({
							role: "user",
							content: input,
							timestamp: Date.now(),
						});
						messages.push({
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
						await sessionStore.save({
							key: sessionKey,
							createdAt: loaded?.createdAt ?? "2026-04-19T08:00:00.000Z",
							updatedAt: new Date().toISOString(),
							metadata: loaded?.metadata ?? {},
							messages,
						});
					},
				};
			},
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
			expect(published).toContain("reply:hello");
		});

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

		expect((await store.load("telegram:42"))?.messages).toEqual([]);

		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "again",
			timestamp: new Date(),
		});
		await waitUntil(() => {
			expect(published).toContain("reply:again");
		});
		await runtime.stop();

		expect(initialMessageCounts).toEqual([1, 0]);
		expect(agentFactoryCalls).toBe(2);
	});

	it("cancels an active prompt for /stop without publishing a fallback error", async () => {
		const bus = new InMemoryMessageBus();
		const published: string[] = [];
		let rejectPrompt: ((reason?: unknown) => void) | undefined;
		let started = false;
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: createRuntimeConfig("E:\\tmp\\sessions"),
			sessionStore: createMemorySessionStore(),
			createAgent: async () => ({
				state: {
					messages: [],
				},
				abort: () => {
					rejectPrompt?.(new DOMException("Aborted", "AbortError"));
				},
				reset: () => undefined,
				prompt: async () =>
					new Promise<void>((_resolve, reject) => {
						started = true;
						rejectPrompt = reject;
					}),
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
			content: "long task",
			timestamp: new Date(),
		});
		await waitUntil(() => {
			expect(started).toBe(true);
		});

		await bus.publishInbound({
			channel: "telegram",
			senderId: "99",
			chatId: "42",
			content: "/stop",
			timestamp: new Date(),
		});

		await waitUntil(() => {
			expect(published).toEqual(["Stopped 1 task(s)."]);
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		await runtime.stop();

		expect(published).toEqual(["Stopped 1 task(s)."]);
	});

	it("returns an idle response for /stop when no prompt is active", async () => {
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
				abort: () => undefined,
				reset: () => undefined,
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
			content: "/stop",
			timestamp: new Date(),
		});

		await waitUntil(() => {
			expect(published).toEqual(["No active task to stop."]);
		});
		await runtime.stop();
	});
});
