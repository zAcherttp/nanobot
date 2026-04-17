import type { Bot } from "grammy";

import { AgentLoop } from "../agent/loop.js";
import type { AppConfig } from "../config/schema.js";
import type { Logger } from "../utils/logging.js";
import { createTelegramBot } from "./telegram.js";

export type BotStatus = "idle" | "starting" | "running" | "stopping" | "error";

export interface BotSnapshot {
	status: BotStatus;
	sessionCount: number;
	errorMessage?: string;
}

export class TelegramBotController {
	private bot: Bot | null = null;
	private startPromise: Promise<void> | null = null;
	private snapshot: BotSnapshot = {
		status: "idle",
		sessionCount: 0,
	};
	private readonly listeners = new Set<() => void>();
	readonly agent = new AgentLoop();

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getSnapshot(): BotSnapshot {
		return {
			...this.snapshot,
			sessionCount: this.agent.getSessionCount(),
		};
	}

	async start(config: AppConfig, logger: Logger): Promise<void> {
		if (
			this.snapshot.status === "starting" ||
			this.snapshot.status === "running"
		) {
			return;
		}

		this.setSnapshot({ status: "starting" });
		logger.info("Starting Telegram bot");

		const bot = createTelegramBot(config.channels.telegram, {
			onError: (error) => logger.error("Telegram bot error", error),
		});
		this.bot = bot;
		this.setSnapshot({ status: "running" });

		this.startPromise = bot.start().then(
			() => {
				if (this.snapshot.status !== "stopping") {
					this.setSnapshot({ status: "idle" });
					logger.info("Telegram bot stopped");
				}
			},
			(error) => {
				this.setSnapshot({
					status: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
				});
				logger.error("Telegram bot failed", error);
			},
		);
	}

	async stop(logger: Logger): Promise<void> {
		if (!this.bot) {
			return;
		}
		this.setSnapshot({ status: "stopping" });
		logger.info("Stopping Telegram bot");
		this.bot.stop();
		try {
			await this.startPromise;
		} finally {
			this.bot = null;
			this.startPromise = null;
			this.setSnapshot({ status: "idle" });
		}
	}

	private setSnapshot(next: Partial<BotSnapshot>): void {
		this.snapshot = {
			...this.snapshot,
			...next,
			sessionCount: this.agent.getSessionCount(),
		};
		for (const listener of this.listeners) {
			listener();
		}
	}
}
