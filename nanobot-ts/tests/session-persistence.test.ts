import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import {
	findLegalMessageStart,
	restoreRuntimeCheckpoint,
	sanitizeMessagesForPersistence,
} from "../src/agent/loop.js";

describe("session persistence", () => {
	it("drops orphan leading tool results and empty assistant messages", () => {
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "missing",
				toolName: "probe",
				content: [{ type: "text" as const, text: "orphan" }],
				details: {},
				isError: false,
				timestamp: 1,
			},
			{
				role: "assistant" as const,
				content: [],
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
				stopReason: "stop" as const,
				timestamp: 2,
			},
			{
				role: "user" as const,
				content: "hello",
				timestamp: 3,
			},
		];

		expect(findLegalMessageStart(messages)).toBe(1);
		expect(
			sanitizeMessagesForPersistence(messages, {
				maxMessages: 500,
				maxPersistedTextChars: 16_000,
			}),
		).toEqual([
			{
				role: "user",
				content: "hello",
				timestamp: 3,
			},
		]);
	});

	it("retains a legal recent suffix and truncates oversized text", () => {
		const veryLong = "x".repeat(20_000);
		const messages = [
			{
				role: "user" as const,
				content: "oldest",
				timestamp: 1,
			},
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "middle" }],
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
				stopReason: "stop" as const,
				timestamp: 2,
			},
			{
				role: "user" as const,
				content: veryLong,
				timestamp: 3,
			},
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "recent" }],
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
				stopReason: "stop" as const,
				timestamp: 4,
			},
		];

		const sanitized = sanitizeMessagesForPersistence(messages, {
			maxMessages: 2,
			maxPersistedTextChars: 16_000,
		});

		expect(sanitized).toHaveLength(2);
		expect(sanitized[0]).toEqual(
			expect.objectContaining({
				role: "user",
				content: `${"x".repeat(15_997)}...`,
			}),
		);
		expect(sanitized[1]).toEqual(
			expect.objectContaining({
				role: "assistant",
			}),
		);
	});

	it("restores runtime checkpoints with overlap dedupe and interrupted tool errors", () => {
		const restored = restoreRuntimeCheckpoint({
			key: "telegram:42",
			createdAt: "2026-04-19T08:00:00.000Z",
			updatedAt: "2026-04-19T08:00:01.000Z",
			messages: [
				{
					role: "user",
					content: "earlier",
					timestamp: 1,
				},
				{
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
					timestamp: 2,
				},
			],
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
						timestamp: 2,
					},
					completedToolResults: [
						{
							role: "toolResult",
							toolCallId: "tool-1",
							toolName: "probe",
							content: [{ type: "text", text: "done" }],
							details: {},
							isError: false,
							timestamp: 3,
						},
					],
					pendingToolCalls: [
						{
							id: "tool-2",
							name: "search",
						},
					],
					updatedAt: "2026-04-19T08:00:02.000Z",
				},
			},
		});

		expect(restored.restored).toBe(true);
		expect(
			(restored.session.metadata as Record<string, unknown>).runtimeCheckpoint,
		).toBeUndefined();
		expect(restored.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
		]);
		expect(restored.session.messages[3]).toEqual(
			expect.objectContaining({
				role: "toolResult",
				toolCallId: "tool-2",
				isError: true,
			}),
		);
	});

	it("caps maxMessages by walking back to a user boundary", () => {
		const messages = Array.from({ length: 10 }, (_, index) => ({
			...(index % 2 === 0
				? { role: "user" as const, content: `user-${index}`, timestamp: index }
				: {
						role: "assistant" as const,
						content: [{ type: "text" as const, text: `asst-${index}` }],
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
						stopReason: "stop" as const,
						timestamp: index,
					}),
		}));

		const sanitized = sanitizeMessagesForPersistence(messages, {
			maxMessages: 4,
			maxPersistedTextChars: 16_000,
		});

		expect(sanitized.length).toBeLessThanOrEqual(4);
		expect(sanitized[0]?.role).toBe("user");
	});

	it("truncates oversized assistant text blocks during persistence", () => {
		const messages = [
			{ role: "user" as const, content: "question", timestamp: 1 },
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "x".repeat(20_000) }],
				api: "test",
				provider: "anthropic",
				model: "claude-opus-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: 2,
			},
		];

		const sanitized = sanitizeMessagesForPersistence(messages, {
			maxMessages: 10,
			maxPersistedTextChars: 100,
		});

		expect(sanitized).toHaveLength(2);
		const assistant = sanitized[1];
		if (assistant?.role !== "assistant") {
			throw new Error("Expected sanitized assistant message.");
		}
		const textBlock = assistant.content[0];
		if (textBlock?.type !== "text") {
			throw new Error("Expected sanitized assistant text block.");
		}
		const assistantContent = textBlock.text;
		expect(assistantContent.length).toBeLessThanOrEqual(100);
		expect(assistantContent).toContain("...");
	});

	it("preserves toolCall/toolResult pairs across the persistence boundary", () => {
		const messages = [
			{ role: "user" as const, content: "do task", timestamp: 1 },
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "working" },
					{
						type: "toolCall" as const,
						id: "tc-1",
						name: "probe",
						input: {},
						providerData: {},
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
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse" as const,
				timestamp: 2,
			},
			{
				role: "toolResult" as const,
				toolCallId: "tc-1",
				toolName: "probe",
				content: [{ type: "text" as const, text: "result" }],
				details: {},
				isError: false,
				timestamp: 3,
			},
		];

		const sanitized = sanitizeMessagesForPersistence(messages, {
			maxMessages: 500,
			maxPersistedTextChars: 16_000,
		});

		expect(sanitized).toHaveLength(3);
		expect(sanitized.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
	});

	it("restores a checkpoint with zero completed results and all pending", () => {
		const restored = restoreRuntimeCheckpoint({
			key: "cli:test",
			createdAt: "2026-04-19T08:00:00.000Z",
			updatedAt: "2026-04-19T08:00:01.000Z",
			messages: [{ role: "user", content: "do task", timestamp: 1 }],
			metadata: {
				runtimeCheckpoint: {
					assistantMessage: {
						role: "assistant",
						content: [
							{ type: "text", text: "let me check" },
							{
								type: "toolCall",
								id: "tc-a",
								name: "search",
								input: { query: "test" },
								providerData: {},
							},
							{
								type: "toolCall",
								id: "tc-b",
								name: "probe",
								input: {},
								providerData: {},
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
						timestamp: 2,
					},
					completedToolResults: [],
					pendingToolCalls: [
						{ id: "tc-a", name: "search" },
						{ id: "tc-b", name: "probe" },
					],
					updatedAt: "2026-04-19T08:00:02.000Z",
				},
			},
		});

		expect(restored.restored).toBe(true);
		expect(restored.session.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
		]);
		const toolResults = restored.session.messages.filter(
			(m): m is ToolResultMessage => m.role === "toolResult",
		);
		expect(toolResults).toHaveLength(2);
		expect(toolResults.every((m) => m.isError)).toBe(true);
	});
});
