import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { CronService } from "./service.js";
import {
	formatCronTimestamp,
	isValidTimeZone,
	parseNaiveIsoToMs,
} from "./service.js";
import type { CronSchedule } from "./types.js";

export interface CronToolOptions {
	service: CronService;
	defaultTimeZone: string;
	channel?: string;
	chatId?: string;
	inCronContext?: boolean;
}

export function createCronTool(options: CronToolOptions): AgentTool {
	return {
		name: "cron",
		label: "Cron",
		description:
			"Schedule reminders and recurring agent tasks. Actions: add, list, remove.",
		parameters: Type.Object({
			action: Type.String({
				enum: ["add", "list", "remove"],
			}),
			name: Type.Optional(Type.String()),
			message: Type.Optional(Type.String()),
			every_seconds: Type.Optional(Type.Integer()),
			cron_expr: Type.Optional(Type.String()),
			tz: Type.Optional(Type.String()),
			at: Type.Optional(Type.String()),
			job_id: Type.Optional(Type.String()),
			deliver: Type.Optional(Type.Boolean()),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as {
				action?: string;
				name?: string;
				message?: string;
				every_seconds?: number;
				cron_expr?: string;
				tz?: string;
				at?: string;
				job_id?: string;
				deliver?: boolean;
			};
			const text = await executeCronAction(input, options);
			return {
				content: [
					{
						type: "text",
						text,
					},
				],
				details: {
					tool: "cron",
				},
			};
		},
	};
}

async function executeCronAction(
	input: {
		action?: string;
		name?: string;
		message?: string;
		every_seconds?: number;
		cron_expr?: string;
		tz?: string;
		at?: string;
		job_id?: string;
		deliver?: boolean;
	},
	options: CronToolOptions,
): Promise<string> {
	if (input.action === "add") {
		if (options.inCronContext) {
			return "Error: cannot schedule new jobs from within a cron job execution";
		}
		return addCronJob(input, options);
	}

	if (input.action === "list") {
		const jobs = await options.service.listJobs();
		if (jobs.length === 0) {
			return "No scheduled jobs.";
		}

		return `Scheduled jobs:\n${jobs
			.map((job) => {
				const nextRun =
					job.state.nextRunAtMs !== null
						? `\n  Next run: ${formatCronTimestamp(
								job.state.nextRunAtMs,
								getScheduleTimeZone(job.schedule, options.defaultTimeZone),
							)}`
						: "";
				return `- ${job.name} (id: ${job.id}, ${formatSchedule(
					job.schedule,
					options.defaultTimeZone,
				)})${nextRun}`;
			})
			.join("\n")}`;
	}

	if (input.action === "remove") {
		if (!input.job_id?.trim()) {
			return "Error: job_id is required for remove";
		}
		const result = await options.service.removeJob(input.job_id.trim());
		if (result === "removed") {
			return `Removed job ${input.job_id.trim()}`;
		}
		if (result === "protected") {
			return `Error: job ${input.job_id.trim()} is a protected internal job`;
		}
		return `Job ${input.job_id.trim()} not found`;
	}

	return `Unknown action: ${input.action ?? ""}`;
}

async function addCronJob(
	input: {
		name?: string;
		message?: string;
		every_seconds?: number;
		cron_expr?: string;
		tz?: string;
		at?: string;
		deliver?: boolean;
	},
	options: CronToolOptions,
): Promise<string> {
	const message = input.message?.trim();
	if (!message) {
		return "Error: message is required for add";
	}

	const deliver = input.deliver ?? true;
	if (deliver && (!options.channel || !options.chatId)) {
		return "Error: no session context (channel/chat_id)";
	}
	if (input.tz && !input.cron_expr) {
		return "Error: tz can only be used with cron_expr";
	}

	let schedule: CronSchedule | null = null;
	let deleteAfterRun = false;
	if (input.every_seconds && input.every_seconds > 0) {
		schedule = {
			kind: "every",
			everyMs: input.every_seconds * 1000,
		};
	} else if (input.cron_expr?.trim()) {
		const effectiveTimeZone = input.tz?.trim() || options.defaultTimeZone;
		if (!isValidTimeZone(effectiveTimeZone)) {
			return `Error: unknown timezone '${effectiveTimeZone}'`;
		}
		schedule = {
			kind: "cron",
			expr: input.cron_expr.trim(),
			tz: effectiveTimeZone,
		};
	} else if (input.at?.trim()) {
		try {
			schedule = {
				kind: "at",
				atMs: parseNaiveIsoToMs(input.at.trim(), options.defaultTimeZone),
			};
			deleteAfterRun = true;
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	if (!schedule) {
		return "Error: either every_seconds, cron_expr, or at is required";
	}

	try {
		const job = await options.service.addJob({
			name: input.name?.trim() || message.slice(0, 30),
			schedule,
			message,
			deliver,
			...(options.channel ? { channel: options.channel } : {}),
			...(options.chatId ? { to: options.chatId } : {}),
			deleteAfterRun,
		});
		return `Created job '${job.name}' (id: ${job.id})`;
	} catch (error) {
		return `Error: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function formatSchedule(
	schedule: CronSchedule,
	defaultTimeZone: string,
): string {
	if (schedule.kind === "every") {
		return `every ${Math.floor(schedule.everyMs / 1000)}s`;
	}
	if (schedule.kind === "at") {
		return `at ${formatCronTimestamp(schedule.atMs, defaultTimeZone)}`;
	}
	return `cron: ${schedule.expr} (${schedule.tz || defaultTimeZone})`;
}

function getScheduleTimeZone(
	schedule: CronSchedule,
	defaultTimeZone: string,
): string {
	if (schedule.kind === "cron" && schedule.tz) {
		return schedule.tz;
	}
	return defaultTimeZone;
}
