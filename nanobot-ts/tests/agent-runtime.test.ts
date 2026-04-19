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
import { DEFAULT_CONFIG } from "../src/config/loader.js";

describe("agent runtime", () => {
	it("resolves provider and modelId into a pi-ai model", () => {
		const resolved = resolveAgentRuntimeConfig(DEFAULT_CONFIG);

		expect(resolved.provider).toBe("anthropic");
		expect(resolved.modelId).toBe("claude-opus-4-5");
		expect(resolved.model.provider).toBe("anthropic");
		expect(resolved.model.id).toBe("claude-opus-4-5");
	});

	it("fails clearly when the modelId does not exist for the provider", () => {
		const invalidConfig = {
			...DEFAULT_CONFIG,
			agent: {
				...DEFAULT_CONFIG.agent,
				modelId: "not-a-real-model",
			},
		};

		expect(() => resolveAgentRuntimeConfig(invalidConfig)).toThrow(
			"Unknown modelId",
		);
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
					expect(model.id).toBe("claude-opus-4-5");
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

		expect(sanitizeMessagesForPersistence(messages)).toEqual([
			{
				role: "user",
				content: "hello",
				timestamp: 1,
			},
		]);
	});
});
