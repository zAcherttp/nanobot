import { describe, expect, it, vi } from "vitest";

import { BaseChannel } from "../src/channels/base.js";
import {
	type ChannelFactory,
	ChannelManager,
} from "../src/channels/manager.js";
import type { OutboundChannelMessage } from "../src/channels/types.js";
import { DEFAULT_CONFIG } from "../src/config/loader.js";
import type { AppConfig } from "../src/config/schema.js";
import type { Logger } from "../src/utils/logging.js";

class FakeChannel extends BaseChannel<{ allowFrom: string[] }> {
	startCalls = 0;
	stopCalls = 0;
	sentMessages: OutboundChannelMessage[] = [];
	constructor(
		name: string,
		private readonly streamingSupported = false,
		allowFrom: string[] = ["*"],
	) {
		super({
			name,
			displayName: name,
			config: { allowFrom },
			bus: {
				publishInbound: async () => undefined,
				publishOutbound: async () => undefined,
				subscribeInbound: () => () => undefined,
				subscribeOutbound: () => () => undefined,
			},
		});
	}

	protected override getAllowFrom(): string[] {
		return this.config.allowFrom;
	}

	override supportsStreaming(): boolean {
		return this.streamingSupported;
	}

	async start(): Promise<void> {
		this.startCalls += 1;
		this.setStatus("running");
	}

	async stop(): Promise<void> {
		this.stopCalls += 1;
		this.setStatus("idle");
	}

	async send(message: OutboundChannelMessage): Promise<number> {
		this.sentMessages.push(message);
		return 1;
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

function createConfig(): AppConfig {
	return structuredClone(DEFAULT_CONFIG);
}

describe("channel manager", () => {
	it("initializes only enabled channels", () => {
		const enabledChannel = new FakeChannel("enabled");
		const disabledChannel = new FakeChannel("disabled");
		const manager = new ChannelManager(createConfig(), LOGGER, {
			channelFactories: [
				{
					name: "enabled",
					displayName: "Enabled",
					isEnabled: () => true,
					createChannel: () => enabledChannel,
				},
				{
					name: "disabled",
					displayName: "Disabled",
					isEnabled: () => false,
					createChannel: () => disabledChannel,
				},
			],
		});

		expect(manager.hasEnabledChannels()).toBe(true);
		expect(manager.getSnapshots()).toEqual([
			{
				name: "enabled",
				displayName: "enabled",
				enabled: true,
				status: "idle",
			},
			{
				name: "disabled",
				displayName: "Disabled",
				enabled: false,
				status: "idle",
			},
		]);
		expect(disabledChannel.startCalls).toBe(0);
	});

	it("starts and stops enabled channels", async () => {
		const channel = new FakeChannel("enabled");
		const manager = new ChannelManager(createConfig(), LOGGER, {
			channelFactories: [
				{
					name: "enabled",
					displayName: "Enabled",
					isEnabled: () => true,
					createChannel: () => channel,
				},
			],
		});

		await manager.start();
		expect(channel.startCalls).toBe(1);
		expect(manager.getSnapshots()[0]).toEqual({
			name: "enabled",
			displayName: "enabled",
			enabled: true,
			status: "running",
		});

		await manager.stop();
		expect(channel.stopCalls).toBe(1);
		expect(manager.getSnapshots()[0]).toEqual({
			name: "enabled",
			displayName: "enabled",
			enabled: true,
			status: "idle",
		});
	});

	it("stops channels in reverse start order", async () => {
		const stopOrder: string[] = [];
		const first = new FakeChannel("first");
		const second = new FakeChannel("second");

		first.stop = async () => {
			stopOrder.push("first");
		};
		second.stop = async () => {
			stopOrder.push("second");
		};

		const manager = new ChannelManager(createConfig(), LOGGER, {
			channelFactories: [
				{
					name: "first",
					displayName: "First",
					isEnabled: () => true,
					createChannel: () => first,
				},
				{
					name: "second",
					displayName: "Second",
					isEnabled: () => true,
					createChannel: () => second,
				},
			],
		});

		await manager.start();
		await manager.stop();

		expect(stopOrder).toEqual(["second", "first"]);
	});

	it("routes outbound messages to the selected channel and publishes them", async () => {
		const channel = new FakeChannel("enabled");
		const manager = new ChannelManager(createConfig(), LOGGER, {
			channelFactories: [
				{
					name: "enabled",
					displayName: "Enabled",
					isEnabled: () => true,
					createChannel: () => channel,
				},
			],
		});

		await expect(
			manager.send({
				channel: "enabled",
				chatId: "room-1",
				content: "deploy finished",
				role: "system",
				metadata: {
					requestId: "abc",
				},
			}),
		).resolves.toBe(1);

		expect(channel.sentMessages).toHaveLength(1);
		expect(channel.sentMessages[0]).toEqual(
			expect.objectContaining({
				channel: "enabled",
				chatId: "room-1",
				content: "deploy finished",
				role: "system",
			}),
		);
	});

	it("dispatches outbound bus messages while running", async () => {
		const channel = new FakeChannel("enabled");
		const manager = new ChannelManager(createConfig(), LOGGER, {
			channelFactories: [
				{
					name: "enabled",
					displayName: "Enabled",
					isEnabled: () => true,
					createChannel: () => channel,
				},
			],
		});

		await manager.start();
		await manager.getBus().publishOutbound({
			channel: "enabled",
			chatId: "room-1",
			content: "hello from bus",
			role: "assistant",
		});
		await manager.stop();

		expect(channel.sentMessages).toEqual([
			expect.objectContaining({
				channel: "enabled",
				chatId: "room-1",
				content: "hello from bus",
			}),
		]);
	});

	it("buffers streamed outbound messages for non-streaming channels until the end marker", async () => {
		const channel = new FakeChannel("enabled", false);
		const manager = new ChannelManager(createConfig(), LOGGER, {
			channelFactories: [
				{
					name: "enabled",
					displayName: "Enabled",
					isEnabled: () => true,
					createChannel: () => channel,
				},
			],
		});

		await manager.start();
		await manager.getBus().publishOutbound({
			channel: "enabled",
			chatId: "room-1",
			content: "hello",
			role: "assistant",
			metadata: {
				_stream_delta: true,
				_stream_id: "stream-1",
			},
		});
		await manager.getBus().publishOutbound({
			channel: "enabled",
			chatId: "room-1",
			content: " world",
			role: "assistant",
			metadata: {
				_stream_delta: true,
				_stream_id: "stream-1",
			},
		});

		expect(channel.sentMessages).toEqual([]);

		await manager.getBus().publishOutbound({
			channel: "enabled",
			chatId: "room-1",
			content: "",
			role: "assistant",
			metadata: {
				_stream_end: true,
				_stream_id: "stream-1",
			},
		});
		await manager.stop();

		expect(channel.sentMessages).toEqual([
			expect.objectContaining({
				channel: "enabled",
				chatId: "room-1",
				content: "hello world",
				role: "assistant",
			}),
		]);
	});

	it("handles disabled and unknown channel targets", async () => {
		const factories: ChannelFactory[] = [
			{
				name: "enabled",
				displayName: "Enabled",
				isEnabled: () => true,
				createChannel: () => new FakeChannel("enabled"),
			},
			{
				name: "disabled",
				displayName: "Disabled",
				isEnabled: () => false,
				createChannel: () => new FakeChannel("disabled"),
			},
		];
		const manager = new ChannelManager(createConfig(), LOGGER, {
			channelFactories: factories,
		});

		await expect(
			manager.send({
				channel: "disabled",
				content: "hi",
			}),
		).rejects.toThrow("disabled");
		await expect(
			manager.send({
				channel: "missing",
				content: "hi",
			}),
		).rejects.toThrow("Unknown channel");
	});

	it("broadcasts outbound messages to all enabled channels", async () => {
		const first = new FakeChannel("first");
		const second = new FakeChannel("second");
		const manager = new ChannelManager(createConfig(), LOGGER, {
			channelFactories: [
				{
					name: "first",
					displayName: "First",
					isEnabled: () => true,
					createChannel: () => first,
				},
				{
					name: "second",
					displayName: "Second",
					isEnabled: () => true,
					createChannel: () => second,
				},
			],
		});

		await expect(
			manager.broadcast({
				chatId: "room-1",
				content: "hello",
				role: "system",
			}),
		).resolves.toBe(2);

		expect(first.sentMessages).toEqual([
			expect.objectContaining({ channel: "first", content: "hello" }),
		]);
		expect(second.sentMessages).toEqual([
			expect.objectContaining({ channel: "second", content: "hello" }),
		]);
	});

	it("fails broadcast when no channels are enabled", async () => {
		const manager = new ChannelManager(createConfig(), LOGGER, {
			channelFactories: [
				{
					name: "disabled",
					displayName: "Disabled",
					isEnabled: () => false,
					createChannel: () => new FakeChannel("disabled"),
				},
			],
		});

		await expect(
			manager.broadcast({
				content: "hello",
			}),
		).rejects.toThrow("No channels are enabled");
	});

	it("fails fast when an enabled channel has an empty allowFrom policy", () => {
		expect(
			() =>
				new ChannelManager(createConfig(), LOGGER, {
					channelFactories: [
						{
							name: "enabled",
							displayName: "Enabled",
							isEnabled: () => true,
							createChannel: () => new FakeChannel("enabled", false, []),
						},
					],
				}),
		).toThrow('Enabled channel "enabled" has empty allowFrom');
	});
});
