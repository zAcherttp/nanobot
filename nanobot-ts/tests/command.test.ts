import { describe, expect, it, vi } from "vitest";

import {
	buildHelpText,
	CommandRouter,
	registerBuiltinCommands,
} from "../src/command/index.js";

describe("command router", () => {
	it("marks /stop as a priority command", () => {
		const router = new CommandRouter();
		registerBuiltinCommands(router);

		expect(router.isPriority("/stop")).toBe(true);
		expect(router.isPriority("/help")).toBe(false);
	});

	it("dispatches exact built-in commands", async () => {
		const router = new CommandRouter();
		registerBuiltinCommands(router);
		const clearSession = vi.fn(async () => undefined);

		const reply = await router.dispatch({
			msg: {
				channel: "telegram",
				senderId: "99",
				chatId: "42",
				content: "/help",
				timestamp: new Date(),
			},
			key: "telegram:42",
			raw: "/help",
			session: {
				messageCount: 0,
				promptTokens: 0,
			},
			runtime: {
				provider: "anthropic",
				modelId: "claude-opus-4-5",
				providerAuthSource: "config",
				contextWindowTokens: 65_536,
			},
			stopActiveTask: async () => false,
			clearSession,
		});

		expect(reply?.content).toBe(buildHelpText());
		expect(clearSession).not.toHaveBeenCalled();
	});

	it("returns null for non-command text", async () => {
		const router = new CommandRouter();
		registerBuiltinCommands(router);

		const reply = await router.dispatch({
			msg: {
				channel: "telegram",
				senderId: "99",
				chatId: "42",
				content: "hello",
				timestamp: new Date(),
			},
			key: "telegram:42",
			raw: "hello",
			session: null,
			runtime: {
				provider: "anthropic",
				modelId: "claude-opus-4-5",
				providerAuthSource: "config",
				contextWindowTokens: 65_536,
			},
			stopActiveTask: async () => false,
			clearSession: async () => undefined,
		});

		expect(reply).toBeNull();
	});

	it("dispatches /new and calls clearSession", async () => {
		const router = new CommandRouter();
		registerBuiltinCommands(router);
		const clearSession = vi.fn(async () => undefined);

		const reply = await router.dispatch({
			msg: {
				channel: "telegram",
				senderId: "99",
				chatId: "42",
				content: "/new",
				timestamp: new Date(),
			},
			key: "telegram:42",
			raw: "/new",
			session: { messageCount: 5, promptTokens: 128 },
			runtime: {
				provider: "anthropic",
				modelId: "claude-opus-4-5",
				providerAuthSource: "config",
				contextWindowTokens: 65_536,
			},
			stopActiveTask: async () => false,
			clearSession,
		});

		expect(reply?.content).toBe("New session started.");
		expect(clearSession).toHaveBeenCalledOnce();
	});

	it("dispatches /status with provider, model, channel, and message count", async () => {
		const router = new CommandRouter();
		registerBuiltinCommands(router);

		const reply = await router.dispatch({
			msg: {
				channel: "telegram",
				senderId: "99",
				chatId: "42",
				content: "/status",
				timestamp: new Date(),
			},
			key: "telegram:42",
			raw: "/status",
			session: { messageCount: 7, promptTokens: 912 },
			runtime: {
				provider: "openai",
				modelId: "gpt-4.1",
				providerAuthSource: "env",
				contextWindowTokens: 8_192,
			},
			stopActiveTask: async () => false,
			clearSession: async () => undefined,
		});

		expect(reply?.content).toContain("Provider: openai");
		expect(reply?.content).toContain("Model: gpt-4.1");
		expect(reply?.content).toContain("Messages: 7");
		expect(reply?.content).toContain("Prompt tokens: 912/8192");
		expect(reply?.content).toContain("Provider auth: env");
		expect(reply?.content).toContain("Channel: telegram");
		expect(reply?.content).toContain("Chat: 42");
	});

	it("dispatches /stop as priority and returns idle message when no active task", async () => {
		const router = new CommandRouter();
		registerBuiltinCommands(router);

		const reply = await router.dispatchPriority({
			msg: {
				channel: "telegram",
				senderId: "99",
				chatId: "42",
				content: "/stop",
				timestamp: new Date(),
			},
			key: "telegram:42",
			raw: "/stop",
			session: null,
			runtime: {
				provider: "anthropic",
				modelId: "claude-opus-4-5",
				providerAuthSource: "config",
				contextWindowTokens: 65_536,
			},
			stopActiveTask: async () => false,
			clearSession: async () => undefined,
		});

		expect(reply?.content).toBe("No active task to stop.");
	});

	it("returns null for unknown slash commands", async () => {
		const router = new CommandRouter();
		registerBuiltinCommands(router);

		const reply = await router.dispatch({
			msg: {
				channel: "telegram",
				senderId: "99",
				chatId: "42",
				content: "/unknowncmd",
				timestamp: new Date(),
			},
			key: "telegram:42",
			raw: "/unknowncmd",
			session: null,
			runtime: {
				provider: "anthropic",
				modelId: "claude-opus-4-5",
				providerAuthSource: "config",
				contextWindowTokens: 65_536,
			},
			stopActiveTask: async () => false,
			clearSession: async () => undefined,
		});

		expect(reply).toBeNull();
	});

	it("matches commands case-insensitively", async () => {
		const router = new CommandRouter();
		registerBuiltinCommands(router);

		expect(router.isPriority("/STOP")).toBe(true);
		expect(router.isPriority("/Stop")).toBe(true);

		const reply = await router.dispatch({
			msg: {
				channel: "telegram",
				senderId: "99",
				chatId: "42",
				content: "/HELP",
				timestamp: new Date(),
			},
			key: "telegram:42",
			raw: "/HELP",
			session: null,
			runtime: {
				provider: "anthropic",
				modelId: "claude-opus-4-5",
				providerAuthSource: "config",
				contextWindowTokens: 65_536,
			},
			stopActiveTask: async () => false,
			clearSession: async () => undefined,
		});

		expect(reply?.content).toBe(buildHelpText());
	});
});
