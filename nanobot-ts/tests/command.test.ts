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
			},
			runtime: {
				provider: "anthropic",
				modelId: "claude-opus-4-5",
				providerAuthSource: "config",
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
			},
			stopActiveTask: async () => false,
			clearSession: async () => undefined,
		});

		expect(reply).toBeNull();
	});
});
