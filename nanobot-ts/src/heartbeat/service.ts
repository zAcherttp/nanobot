import { readFile } from "node:fs/promises";
import path from "node:path";

import { complete, Type } from "@mariozechner/pi-ai";

import type { ResolvedAgentRuntimeConfig } from "../agent/loop.js";
import {
	type BackgroundTarget,
	evaluateBackgroundResult,
	getToolCallArguments,
} from "../background/index.js";
import type { Logger } from "../utils/logging.js";

export interface HeartbeatDecision {
	action: "skip" | "run";
	tasks: string;
}

export interface HeartbeatServiceOptions {
	workspacePath: string;
	config: ResolvedAgentRuntimeConfig;
	intervalSeconds: number;
	keepRecentMessages: number;
	enabled: boolean;
	timezone?: string;
	logger: Logger;
	resolveTarget?: () => Promise<BackgroundTarget | null>;
	onExecute?: (
		tasks: string,
		target: BackgroundTarget | null,
	) => Promise<string>;
	onNotify?: (response: string, target: BackgroundTarget) => Promise<void>;
	decideTasks?: (content: string) => Promise<HeartbeatDecision>;
	evaluateResult?: (taskContext: string, response: string) => Promise<boolean>;
}

export class HeartbeatService {
	private readonly resolveTarget: () => Promise<BackgroundTarget | null>;
	private readonly onExecute: (
		tasks: string,
		target: BackgroundTarget | null,
	) => Promise<string>;
	private readonly onNotify:
		| ((response: string, target: BackgroundTarget) => Promise<void>)
		| undefined;
	private readonly decideTasks: (content: string) => Promise<HeartbeatDecision>;
	private readonly evaluateResult: (
		taskContext: string,
		response: string,
	) => Promise<boolean>;
	private timer: NodeJS.Timeout | undefined;
	private activeExecutions = 0;
	private running = false;

	constructor(private readonly options: HeartbeatServiceOptions) {
		this.resolveTarget = options.resolveTarget ?? (async () => null);
		this.onExecute = options.onExecute ?? (async () => "");
		this.onNotify = options.onNotify;
		this.decideTasks =
			options.decideTasks ??
			((content) => {
				const decisionOptions = {
					config: options.config,
					content,
					...(options.timezone ? { timezone: options.timezone } : {}),
				};
				return decideHeartbeatTasks(decisionOptions);
			});
		this.evaluateResult =
			options.evaluateResult ??
			((taskContext, response) =>
				evaluateBackgroundResult({
					config: options.config,
					taskContext,
					response,
					logger: options.logger,
				}));
	}

	get heartbeatFile(): string {
		return path.join(this.options.workspacePath, "HEARTBEAT.md");
	}

	isRunning(): boolean {
		return this.running;
	}

	isSessionActive(sessionKey: string): boolean {
		return sessionKey === "heartbeat" && this.activeExecutions > 0;
	}

	async start(): Promise<void> {
		if (!this.options.enabled || this.running) {
			return;
		}

		this.running = true;
		this.scheduleNextTick();
		this.options.logger.info("Heartbeat service started", {
			component: "heartbeat",
			event: "start",
			intervalSeconds: this.options.intervalSeconds,
		});
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.options.logger.info("Heartbeat service stopped", {
			component: "heartbeat",
			event: "stop",
		});
	}

	async triggerNow(): Promise<string | null> {
		const content = await this.readHeartbeatFile();
		if (!content?.trim()) {
			this.options.logger.debug("Heartbeat skipped empty task file", {
				component: "heartbeat",
				event: "skip_empty",
			});
			return null;
		}

		const decision = await this.decideTasks(content);
		this.options.logger.info("Heartbeat decision completed", {
			component: "heartbeat",
			event: "decision",
			action: decision.action,
			tasksPreview: decision.tasks,
		});
		if (decision.action !== "run" || !decision.tasks.trim()) {
			return null;
		}

		const target = await this.resolveTarget();
		this.options.logger.info("Heartbeat execution started", {
			component: "heartbeat",
			event: "run_start",
			channel: target?.channel,
			chatId: target?.chatId,
		});
		this.activeExecutions += 1;
		let response: string;
		try {
			response = await this.onExecute(decision.tasks, target);
		} finally {
			this.activeExecutions -= 1;
		}
		this.options.logger.info("Heartbeat execution completed", {
			component: "heartbeat",
			event: "run_end",
			responsePreview: response,
		});
		if (!response.trim()) {
			return response;
		}

		if (target && this.onNotify) {
			const shouldNotify = await this.evaluateResult(decision.tasks, response);
			if (shouldNotify) {
				await this.onNotify(response, target);
				this.options.logger.info("Heartbeat response delivered", {
					component: "heartbeat",
					event: "notify",
					channel: target.channel,
					chatId: target.chatId,
				});
			} else {
				this.options.logger.info("Heartbeat response suppressed by evaluator", {
					component: "heartbeat",
					event: "suppress",
				});
			}
		}

		return response;
	}

	private scheduleNextTick(): void {
		if (!this.running) {
			return;
		}

		this.timer = setTimeout(() => {
			void this.tick();
		}, this.options.intervalSeconds * 1000);
	}

	private async tick(): Promise<void> {
		try {
			await this.triggerNow();
		} catch (error) {
			this.options.logger.error("Heartbeat tick failed", {
				component: "heartbeat",
				event: "error",
				error,
			});
		} finally {
			if (this.running) {
				this.scheduleNextTick();
			}
		}
	}

	private async readHeartbeatFile(): Promise<string | null> {
		try {
			return await readFile(this.heartbeatFile, "utf8");
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return null;
			}
			throw error;
		}
	}
}

export async function decideHeartbeatTasks(options: {
	config: ResolvedAgentRuntimeConfig;
	content: string;
	timezone?: string;
}): Promise<HeartbeatDecision> {
	const message = await complete(
		options.config.model,
		{
			systemPrompt:
				"You are a heartbeat agent. Review the heartbeat task file and always answer by calling the heartbeat tool.",
			messages: [
				{
					role: "user",
					content: `Current Time: ${formatCurrentTime(
						options.timezone,
					)}\n\nReview the following HEARTBEAT.md and decide whether there are active tasks.\n\n${options.content}`,
					timestamp: Date.now(),
				},
			],
			tools: [HEARTBEAT_TOOL],
		},
		{
			...(options.config.apiKey ? { apiKey: options.config.apiKey } : {}),
			maxTokens: 256,
			temperature: 0,
		},
	);

	const args = getToolCallArguments<{
		action?: "skip" | "run";
		tasks?: string;
	}>(message, "heartbeat");
	if (!args) {
		return {
			action: "skip",
			tasks: "",
		};
	}

	return {
		action: args.action === "run" ? "run" : "skip",
		tasks: args.tasks?.trim() ?? "",
	};
}

function formatCurrentTime(timezone?: string): string {
	return new Date().toLocaleString("en-US", {
		...(timezone ? { timeZone: timezone } : {}),
	});
}

const HEARTBEAT_PARAMETERS = Type.Object({
	action: Type.String({
		enum: ["skip", "run"],
	}),
	tasks: Type.Optional(Type.String()),
});

const HEARTBEAT_TOOL = {
	name: "heartbeat",
	description: "Report the heartbeat decision after reviewing active tasks.",
	parameters: HEARTBEAT_PARAMETERS,
};
