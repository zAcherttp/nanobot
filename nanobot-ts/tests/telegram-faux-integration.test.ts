import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	FileSessionStore,
	resolveAgentRuntimeConfig,
} from "../src/agent/loop.js";
import {
	type ChannelFactory,
	ChannelManager,
} from "../src/channels/manager.js";
import {
	handleTextMessage,
	TELEGRAM_CHANNEL_NAME,
	type TelegramBotDeps,
	TelegramChannel,
} from "../src/channels/telegram.js";
import { DEFAULT_CONFIG } from "../src/config/loader.js";
import type { AppConfig } from "../src/config/schema.js";
import { GatewayRuntime } from "../src/gateway/index.js";
import {
	getNanobotFauxTools,
	NANOBOT_FAUX_MODEL_ID,
	NANOBOT_FAUX_PROVIDER,
} from "../src/providers/faux.js";
import type { Logger } from "../src/utils/logging.js";

class TestTelegramChannel extends TelegramChannel {
	async start(): Promise<void> {
		this.setStatus("running");
	}

	async stop(): Promise<void> {
		this.setStatus("idle");
	}
}

const LOGGER: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
};

describe("telegram faux integration", () => {
	it("covers the full telegram -> gateway -> faux provider/tool -> telegram transport line", async () => {
		const dir = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-telegram-faux-"),
		);
		let nowMs = Date.parse("2026-04-19T08:00:00.000Z");
		let nextMessageId = 1;
		const sentMessages = new Map<number, string>();
		const sendHistory: Array<{
			chatId: string;
			text: string;
			messageId: number;
		}> = [];
		const editHistory: Array<{
			chatId: string;
			messageId: number;
			text: string;
		}> = [];
		const deps: TelegramBotDeps = {
			sendMessage: vi.fn(async (chatId: string, text: string) => {
				const messageId = nextMessageId++;
				sentMessages.set(messageId, text);
				sendHistory.push({ chatId, text, messageId });
				return { message_id: messageId };
			}),
			editMessage: vi.fn(
				async (chatId: string, messageId: number, text: string) => {
					sentMessages.set(messageId, text);
					editHistory.push({ chatId, messageId, text });
				},
			),
			now: () => {
				nowMs += 350;
				return new Date(nowMs);
			},
		};

		const config: AppConfig = {
			...structuredClone(DEFAULT_CONFIG),
			channels: {
				telegram: {
					enabled: true,
					token: "123:abc",
					allowFrom: ["*"],
					chatIds: [],
					streaming: true,
				},
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
		};

		const factory: ChannelFactory = {
			name: TELEGRAM_CHANNEL_NAME,
			displayName: "Telegram",
			isEnabled: () => true,
			createChannel: (_config, bus) => {
				return new TestTelegramChannel(
					{
						name: TELEGRAM_CHANNEL_NAME,
						displayName: "Telegram",
						config: config.channels.telegram,
						bus,
					},
					deps,
				);
			},
		};

		const manager = new ChannelManager(config, LOGGER, {
			channelFactories: [factory],
		});
		const bus = manager.getBus();
		const inboundChannel = new TestTelegramChannel(
			{
				name: TELEGRAM_CHANNEL_NAME,
				displayName: "Telegram",
				config: config.channels.telegram,
				bus,
			},
			deps,
		);
		const runtimeConfig = resolveAgentRuntimeConfig(config);
		const runtime = new GatewayRuntime({
			bus,
			logger: LOGGER,
			config: runtimeConfig,
			sessionStore: new FileSessionStore(runtimeConfig.sessionStore.path, {
				maxMessages: runtimeConfig.sessionStore.maxMessages,
				maxPersistedTextChars: runtimeConfig.sessionStore.maxPersistedTextChars,
				quarantineCorruptFiles:
					runtimeConfig.sessionStore.quarantineCorruptFiles,
			}),
			tools: getNanobotFauxTools(),
		});

		await manager.start();
		await runtime.start();

		try {
			await handleTextMessage(
				{
					chat: { id: 42, type: "private" },
					from: { id: 99 },
					message: { text: "inspect staging state" },
					reply: vi.fn(async () => undefined),
				},
				inboundChannel,
			);

			await waitUntil(() => {
				expect(sendHistory).toHaveLength(3);
				expect(editHistory.length).toBeGreaterThan(0);
			});
		} finally {
			await runtime.stop();
			await manager.stop();
		}

		expect(sendHistory.map((entry) => entry.chatId)).toEqual([
			"42",
			"42",
			"42",
		]);
		expect(sendHistory[1]?.text).toContain("nanobot_faux_probe");

		const renderedAssistantMessages = Array.from(sentMessages.entries())
			.filter(([messageId]) => messageId !== sendHistory[1]?.messageId)
			.map(([, text]) => text);

		expect(renderedAssistantMessages).toHaveLength(2);
		expect(renderedAssistantMessages[0]).toContain(
			"Faux stream start. Preparing a probe for: inspect staging state.",
		);
		expect(renderedAssistantMessages[1]).toContain(
			"Faux stream resumed after tool execution.",
		);
		expect(renderedAssistantMessages[1]).toContain(
			"faux tool result for: inspect staging state",
		);
		expect(sendHistory).toHaveLength(3);
	});
});

async function waitUntil(assertion: () => void): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			assertion();
			return;
		} catch (error) {
			if (attempt === 49) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}
