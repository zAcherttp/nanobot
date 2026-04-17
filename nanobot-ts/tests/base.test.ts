import { describe, expect, it } from "vitest";

import { BaseChannel } from "../src/channels/base.js";
import { InMemoryMessageBus } from "../src/channels/bus.js";
import type { OutboundChannelMessage } from "../src/channels/types.js";

class TestChannel extends BaseChannel<{ allowFrom: string[] }> {
	constructor(allowFrom: string[]) {
		super({
			name: "test",
			displayName: "Test",
			config: { allowFrom },
			bus: new InMemoryMessageBus(),
		});
	}

	protected override getAllowFrom(): string[] {
		return this.config.allowFrom;
	}

	protected override getDefaultInboundMetadata(): Record<string, unknown> {
		return {
			fromChannel: "test",
		};
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	async send(_message: OutboundChannelMessage): Promise<number> {
		return 0;
	}

	get messageBus(): InMemoryMessageBus {
		return this.bus as InMemoryMessageBus;
	}

	async publishForTest(senderId: string): Promise<boolean> {
		return this.publishInbound({
			senderId,
			chatId: "room-1",
			content: "hello",
			metadata: {
				requestId: "123",
			},
		});
	}
}

describe("base channel", () => {
	it("publishes inbound messages for allowed senders", async () => {
		const channel = new TestChannel(["*"]);
		const received: unknown[] = [];

		channel.messageBus.subscribeInbound(async (message) => {
			received.push(message);
		});

		const published = await channel.publishForTest("42");

		expect(published).toBe(true);
		expect(received).toEqual([
			expect.objectContaining({
				channel: "test",
				senderId: "42",
				chatId: "room-1",
				content: "hello",
				metadata: {
					fromChannel: "test",
					requestId: "123",
				},
			}),
		]);
	});

	it("rejects inbound messages from blocked senders", async () => {
		const channel = new TestChannel(["7"]);
		let received = false;

		channel.messageBus.subscribeInbound(async () => {
			received = true;
		});

		const published = await channel.publishForTest("42");

		expect(published).toBe(false);
		expect(received).toBe(false);
	});

	it("requires exact allowFrom sender id matches", async () => {
		const channel = new TestChannel(["allow@email.com"]);
		let received = false;

		channel.messageBus.subscribeInbound(async () => {
			received = true;
		});

		const allowed = await channel.publishForTest("allow@email.com");
		const injected = await channel.publishForTest("attacker|allow@email.com");

		expect(allowed).toBe(true);
		expect(injected).toBe(false);
		expect(received).toBe(true);
	});

	it("denies all senders when allowFrom is empty", async () => {
		const channel = new TestChannel([]);
		let received = false;

		channel.messageBus.subscribeInbound(async () => {
			received = true;
		});

		const published = await channel.publishForTest("42");

		expect(published).toBe(false);
		expect(received).toBe(false);
	});
});
