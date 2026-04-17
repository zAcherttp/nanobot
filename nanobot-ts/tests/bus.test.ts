import { describe, expect, it } from "vitest";

import { InMemoryMessageBus } from "../src/channels/bus.js";
import type {
	InboundChannelMessage,
	OutboundChannelMessage,
} from "../src/channels/types.js";

describe("message bus", () => {
	it("publishes inbound messages without altering their shape", async () => {
		const bus = new InMemoryMessageBus();
		const received: InboundChannelMessage[] = [];
		const timestamp = new Date("2026-04-17T08:00:00.000Z");

		bus.subscribeInbound(async (message) => {
			received.push(message);
		});

		const inbound: InboundChannelMessage = {
			channel: "telegram",
			senderId: "42",
			chatId: "99",
			content: "hello",
			timestamp,
			metadata: {
				source: "test",
			},
			sessionKeyOverride: "telegram:99",
		};

		await bus.publishInbound(inbound);

		expect(received).toEqual([inbound]);
	});

	it("publishes outbound messages without altering role or metadata", async () => {
		const bus = new InMemoryMessageBus();
		const received: OutboundChannelMessage[] = [];

		bus.subscribeOutbound(async (message) => {
			received.push(message);
		});

		const outbound: OutboundChannelMessage = {
			channel: "telegram",
			chatId: "99",
			content: "deploy finished",
			role: "system",
			replyTo: "55",
			metadata: {
				requestId: "abc",
			},
		};

		await bus.publishOutbound(outbound);

		expect(received).toEqual([outbound]);
	});
});
