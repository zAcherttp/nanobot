import type { SessionSummary } from "../agent/loop.js";

export interface BackgroundTarget {
	channel: string;
	chatId: string;
	sessionKey: string;
}

const INTERNAL_CHANNELS = new Set(["cli", "system", "cron", "heartbeat"]);

export function pickRecentChannelTarget(
	sessions: readonly SessionSummary[],
	enabledChannels: ReadonlySet<string>,
): BackgroundTarget | null {
	for (const session of sessions) {
		const key = session.key;
		if (!key.includes(":")) {
			continue;
		}

		const [channel = "", chatId = ""] = key.split(":", 2);
		if (!channel || !chatId) {
			continue;
		}
		if (INTERNAL_CHANNELS.has(channel)) {
			continue;
		}
		if (!enabledChannels.has(channel)) {
			continue;
		}

		return {
			channel,
			chatId,
			sessionKey: key,
		};
	}

	return null;
}
