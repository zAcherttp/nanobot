import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
	registerFauxProvider,
	streamSimple,
	Type,
} from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import {
	createSessionAgent,
	getLatestAssistantText,
	resolveAgentRuntimeConfig,
	sanitizeMessagesForPersistence,
} from "../src/agent/loop.js";
import { FileSessionStore } from "../src/agent/session-store.js";
import {
	DEFAULT_AGENT_MODEL_ID,
	DEFAULT_AGENT_PROVIDER,
	DEFAULT_CONFIG,
} from "../src/config/loader.js";
import {
	getNanobotFauxTools,
	NANOBOT_FAUX_MODEL_ID,
	NANOBOT_FAUX_PROVIDER,
} from "../src/providers/faux.js";

describe("agent runtime", () => {
	it("resolves provider and modelId into a pi-ai model", () => {
		const resolved = resolveAgentRuntimeConfig(DEFAULT_CONFIG);

		expect(resolved.provider).toBe(DEFAULT_AGENT_PROVIDER);
		expect(resolved.modelId).toBe(DEFAULT_AGENT_MODEL_ID);
		expect(resolved.model.provider).toBe(DEFAULT_AGENT_PROVIDER);
		expect(resolved.model.id).toBe(DEFAULT_AGENT_MODEL_ID);
		expect(resolved.providerAuthSource).toBe("config");
		expect(resolved.sessionStore.maxMessages).toBe(500);
		expect(resolved.sessionStore.maxPersistedTextChars).toBe(16_000);
		expect(resolved.sessionStore.quarantineCorruptFiles).toBe(true);
	});

	it("prefers config provider settings over env and applies model overrides", () => {
		process.env.ANTHROPIC_API_KEY = "env-key";

		const resolved = resolveAgentRuntimeConfig({
			...DEFAULT_CONFIG,
			providers: {
				anthropic: {
					apiKey: "config-key",
					apiBase: "https://anthropic.example.test",
					headers: {
						"x-app": "nanobot-ts",
					},
				},
			},
			agent: {
				...DEFAULT_CONFIG.agent,
				provider: "anthropic",
				modelId: "claude-opus-4-5",
			},
		});

		expect(resolved.apiKey).toBe("config-key");
		expect(resolved.model.baseUrl).toBe("https://anthropic.example.test");
		expect(resolved.model.headers).toMatchObject({
			"x-app": "nanobot-ts",
		});
	});

	it("falls back to the provider env variable when config omits apiKey", () => {
		process.env.ANTHROPIC_API_KEY = "env-key";

		const resolved = resolveAgentRuntimeConfig({
			...DEFAULT_CONFIG,
			providers: {},
			agent: {
				...DEFAULT_CONFIG.agent,
				provider: "anthropic",
				modelId: "claude-opus-4-5",
			},
		});

		expect(resolved.apiKey).toBe("env-key");
	});

	it("fails clearly when the modelId does not exist for the provider", () => {
		const invalidConfig = {
			...DEFAULT_CONFIG,
			agent: {
				...DEFAULT_CONFIG.agent,
				provider: "anthropic",
				modelId: "not-a-real-model",
			},
		};

		expect(() => resolveAgentRuntimeConfig(invalidConfig)).toThrow(
			"Unknown modelId",
		);
	});

	it("resolves the nanobot faux provider without requiring an api key", () => {
		const resolved = resolveAgentRuntimeConfig({
			...DEFAULT_CONFIG,
			agent: {
				...DEFAULT_CONFIG.agent,
				provider: NANOBOT_FAUX_PROVIDER,
				modelId: NANOBOT_FAUX_MODEL_ID,
			},
		});

		expect(resolved.provider).toBe(NANOBOT_FAUX_PROVIDER);
		expect(resolved.modelId).toBe(NANOBOT_FAUX_MODEL_ID);
		expect(resolved.providerAuthSource).toBe("none");
		expect(resolved.model.provider).toBe(NANOBOT_FAUX_PROVIDER);
		expect(resolved.model.id).toBe(NANOBOT_FAUX_MODEL_ID);
		expect(resolved.apiKey).toBeUndefined();
	});

	it("hydrates transcript, persists prompt results, and exposes native agent events", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-agent-"));
		const store = new FileSessionStore(path.join(dir, "sessions"));
		const registration = registerFauxProvider();
		const seenEvents: string[] = [];
		const seenOptions: Array<{ temperature?: number; maxTokens?: number }> = [];

		try {
			registration.setResponses([fauxAssistantMessage("hello from faux")]);
			const initialMessages: Message[] = [
				{
					role: "user",
					content: "earlier",
					timestamp: 1,
				},
			];
			await store.save({
				key: "cli:direct",
				createdAt: "2026-04-17T08:00:00.000Z",
				updatedAt: "2026-04-17T08:00:00.000Z",
				metadata: {},
				messages: initialMessages,
			});

			const agent = await createSessionAgent({
				config: resolveAgentRuntimeConfig({
					...DEFAULT_CONFIG,
					workspace: {
						path: dir,
					},
					agent: {
						...DEFAULT_CONFIG.agent,
						sessionStore: {
							...DEFAULT_CONFIG.agent.sessionStore,
							type: "file",
							path: path.join(dir, "sessions"),
						},
					},
				}),
				sessionKey: "cli:direct",
				sessionStore: store,
				streamFn: (model, context, options) => {
					seenOptions.push({
						temperature: options?.temperature,
						maxTokens: options?.maxTokens,
					});
					expect(model.id).toBe(DEFAULT_AGENT_MODEL_ID);
					return streamSimple(registration.getModel(), context, options);
				},
			});

			agent.subscribe((event) => {
				seenEvents.push(event.type);
			});

			expect(agent.state.messages).toEqual(initialMessages);

			await agent.prompt("hello");

			expect(getLatestAssistantText(agent.state.messages)).toBe(
				"hello from faux",
			);
			expect(seenEvents).toContain("agent_start");
			expect(seenEvents).toContain("message_update");
			expect(seenEvents).toContain("agent_end");
			expect(seenOptions).toContainEqual({
				temperature: DEFAULT_CONFIG.agent.temperature,
				maxTokens: DEFAULT_CONFIG.agent.maxTokens,
			});

			const persisted = await store.load("cli:direct");
			expect(persisted?.messages).toHaveLength(3);
			expect(getLatestAssistantText(persisted?.messages ?? [])).toBe(
				"hello from faux",
			);
			expect(agent.state.tools).toEqual([]);
		} finally {
			registration.unregister();
		}
	});

	it("continues from a persisted user message and persists the assistant reply", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-agent-"));
		const store = new FileSessionStore(path.join(dir, "sessions"));
		const registration = registerFauxProvider();

		try {
			registration.setResponses([fauxAssistantMessage("continued reply")]);
			await store.save({
				key: "sdk:continue",
				createdAt: "2026-04-17T08:00:00.000Z",
				updatedAt: "2026-04-17T08:00:00.000Z",
				metadata: {},
				messages: [
					{
						role: "user",
						content: "resume",
						timestamp: 1,
					},
				],
			});

			const agent = await createSessionAgent({
				config: resolveAgentRuntimeConfig({
					...DEFAULT_CONFIG,
					workspace: {
						path: dir,
					},
					agent: {
						...DEFAULT_CONFIG.agent,
						sessionStore: {
							...DEFAULT_CONFIG.agent.sessionStore,
							type: "file",
							path: path.join(dir, "sessions"),
						},
					},
				}),
				sessionKey: "sdk:continue",
				sessionStore: store,
				streamFn: (_model, context, options) =>
					streamSimple(registration.getModel(), context, options),
			});

			await agent.continue();

			expect(getLatestAssistantText(agent.state.messages)).toBe(
				"continued reply",
			);
			expect(
				getLatestAssistantText(
					(await store.load("sdk:continue"))?.messages ?? [],
				),
			).toBe("continued reply");
		} finally {
			registration.unregister();
		}
	});

	it("uses externally supplied tools without registering built-ins in core", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-agent-"));
		const registration = registerFauxProvider();
		const store = new FileSessionStore(path.join(dir, "sessions"));
		const calls: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text",
			parameters: Type.Object({
				text: Type.String(),
			}),
			execute: async (_toolCallId, params) => {
				calls.push(params.text);
				return {
					content: [{ type: "text", text: params.text }],
					details: {
						echoed: params.text,
					},
				};
			},
		};

		try {
			registration.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("echo", { text: "tool payload" }, { id: "tool-1" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("tool completed"),
			]);

			const agent = await createSessionAgent({
				config: resolveAgentRuntimeConfig({
					...DEFAULT_CONFIG,
					workspace: {
						path: dir,
					},
					agent: {
						...DEFAULT_CONFIG.agent,
						sessionStore: {
							...DEFAULT_CONFIG.agent.sessionStore,
							type: "file",
							path: path.join(dir, "sessions"),
						},
					},
				}),
				sessionKey: "sdk:tool",
				sessionStore: store,
				tools: [echoTool],
				streamFn: (_model, context, options) =>
					streamSimple(registration.getModel(), context, options),
			});

			await agent.prompt("run tool");

			expect(calls).toEqual(["tool payload"]);
			expect(agent.state.tools).toEqual([echoTool]);
			expect(agent.state.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(getLatestAssistantText(agent.state.messages)).toBe(
				"tool completed",
			);
		} finally {
			registration.unregister();
		}
	});

	it("runs the nanobot faux provider through a real stream -> tool -> stream turn", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-agent-"));
		const store = new FileSessionStore(path.join(dir, "sessions"));
		const agent = await createSessionAgent({
			config: resolveAgentRuntimeConfig({
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
						type: "file",
						path: path.join(dir, "sessions"),
					},
				},
			}),
			sessionKey: "sdk:faux",
			sessionStore: store,
			tools: getNanobotFauxTools(),
		});

		await agent.prompt("inspect staging state");

		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(getLatestAssistantText(agent.state.messages)).toContain(
			"Faux stream resumed after tool execution.",
		);
		expect(getLatestAssistantText(agent.state.messages)).toContain(
			"faux tool result for: inspect staging state",
		);
		expect(
			(await store.load("sdk:faux"))?.messages.map((message) => message.role),
		).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("writes a checkpoint on abort and restores it on the next prompt", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-agent-"));
		const store = new FileSessionStore(path.join(dir, "sessions"), {
			maxMessages: 500,
			maxPersistedTextChars: 16_000,
			quarantineCorruptFiles: true,
		});
		const registration = registerFauxProvider();
		let firstAgent: Awaited<ReturnType<typeof createSessionAgent>> | undefined;
		const abortingTool: AgentTool = {
			name: "aborting_probe",
			label: "Aborting Probe",
			description: "Aborts the agent immediately.",
			parameters: Type.Object({
				text: Type.String(),
			}),
			execute: async () => {
				firstAgent?.abort();
				throw new DOMException("Aborted", "AbortError");
			},
		};

		try {
			registration.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall(
							"aborting_probe",
							{ text: "staging" },
							{ id: "tool-1" },
						),
					],
					{ stopReason: "toolUse" },
				),
			]);

			firstAgent = await createSessionAgent({
				config: resolveAgentRuntimeConfig({
					...DEFAULT_CONFIG,
					workspace: {
						path: dir,
					},
					agent: {
						...DEFAULT_CONFIG.agent,
						sessionStore: {
							...DEFAULT_CONFIG.agent.sessionStore,
							type: "file",
							path: path.join(dir, "sessions"),
						},
					},
				}),
				sessionKey: "sdk:checkpoint",
				sessionStore: store,
				tools: [abortingTool],
				streamFn: (_model, context, options) =>
					streamSimple(registration.getModel(), context, options),
			});

			await firstAgent.prompt("inspect").catch(() => undefined);
			const interrupted = await store.load("sdk:checkpoint");
			expect(
				(interrupted?.metadata as Record<string, unknown>)?.runtimeCheckpoint,
			).toBeTruthy();
			expect(interrupted?.messages).toEqual([]);

			registration.setResponses([fauxAssistantMessage("recovered reply")]);
			const restoredAgent = await createSessionAgent({
				config: resolveAgentRuntimeConfig({
					...DEFAULT_CONFIG,
					workspace: {
						path: dir,
					},
					agent: {
						...DEFAULT_CONFIG.agent,
						sessionStore: {
							...DEFAULT_CONFIG.agent.sessionStore,
							type: "file",
							path: path.join(dir, "sessions"),
						},
					},
				}),
				sessionKey: "sdk:checkpoint",
				sessionStore: store,
				streamFn: (_model, context, options) =>
					streamSimple(registration.getModel(), context, options),
			});

			await restoredAgent.prompt("next");

			expect(
				restoredAgent.state.messages.map((message) => message.role),
			).toEqual(["user", "assistant"]);
			expect(
				getLatestAssistantText(
					(await store.load("sdk:checkpoint"))?.messages ?? [],
				),
			).toBe("recovered reply");
			expect(
				(
					(await store.load("sdk:checkpoint"))?.metadata as Record<
						string,
						unknown
					>
				)?.runtimeCheckpoint,
			).toBeUndefined();
		} finally {
			registration.unregister();
		}
	});

	it("drops errored or aborted assistant messages before persistence", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: "hello",
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [],
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
				stopReason: "error",
				errorMessage: "boom",
				timestamp: 2,
			},
		];

		expect(
			sanitizeMessagesForPersistence(messages, {
				maxMessages: 500,
				maxPersistedTextChars: 16_000,
			}),
		).toEqual([
			{
				role: "user",
				content: "hello",
				timestamp: 1,
			},
		]);
	});
});
