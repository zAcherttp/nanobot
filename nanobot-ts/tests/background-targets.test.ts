import { describe, expect, it } from "vitest";

import { pickRecentChannelTarget } from "../src/background/index.js";

describe("background targets", () => {
	it("picks the most recent enabled external channel session", () => {
		const target = pickRecentChannelTarget(
			[
				{
					key: "cli:direct",
					createdAt: "2026-04-19T08:00:00.000Z",
					updatedAt: "2026-04-19T08:03:00.000Z",
					path: "cli",
					messageCount: 1,
					hasRuntimeCheckpoint: false,
				},
				{
					key: "telegram:42",
					createdAt: "2026-04-19T08:00:00.000Z",
					updatedAt: "2026-04-19T08:02:00.000Z",
					path: "telegram",
					messageCount: 4,
					hasRuntimeCheckpoint: false,
				},
				{
					key: "discord:99",
					createdAt: "2026-04-19T08:00:00.000Z",
					updatedAt: "2026-04-19T08:01:00.000Z",
					path: "discord",
					messageCount: 2,
					hasRuntimeCheckpoint: false,
				},
			],
			new Set(["telegram", "discord"]),
		);

		expect(target).toEqual({
			channel: "telegram",
			chatId: "42",
			sessionKey: "telegram:42",
		});
	});

	it("skips internal and disabled channel sessions", () => {
		const target = pickRecentChannelTarget(
			[
				{
					key: "heartbeat",
					createdAt: "2026-04-19T08:00:00.000Z",
					updatedAt: "2026-04-19T08:03:00.000Z",
					path: "heartbeat",
					messageCount: 1,
					hasRuntimeCheckpoint: false,
				},
				{
					key: "telegram:42",
					createdAt: "2026-04-19T08:00:00.000Z",
					updatedAt: "2026-04-19T08:02:00.000Z",
					path: "telegram",
					messageCount: 4,
					hasRuntimeCheckpoint: false,
				},
			],
			new Set(["discord"]),
		);

		expect(target).toBeNull();
	});
});
