import { describe, expect, it, vi } from "vitest";

import { createCronTool } from "../src/cron/index.js";

describe("cron tool", () => {
	it("rejects nested scheduling inside cron execution", async () => {
		const tool = createCronTool({
			service: {
				addJob: vi.fn(),
				listJobs: vi.fn(),
				removeJob: vi.fn(),
			} as never,
			defaultTimeZone: "UTC",
			inCronContext: true,
		});

		const result = (await tool.execute("call-1", {
			action: "add",
			message: "schedule something",
			every_seconds: 60,
		})) as {
			content: Array<{ type: string; text: string }>;
		};

		expect(result.content[0]?.text).toContain(
			"cannot schedule new jobs from within a cron job execution",
		);
	});

	it("requires channel context for delivery jobs", async () => {
		const tool = createCronTool({
			service: {
				addJob: vi.fn(),
				listJobs: vi.fn(),
				removeJob: vi.fn(),
			} as never,
			defaultTimeZone: "UTC",
		});

		const result = (await tool.execute("call-1", {
			action: "add",
			message: "deliver this later",
			every_seconds: 60,
			deliver: true,
		})) as {
			content: Array<{ type: string; text: string }>;
		};

		expect(result.content[0]?.text).toBe(
			"Error: no session context (channel/chat_id)",
		);
	});

	it("creates jobs with channel delivery context when available", async () => {
		const addJob = vi.fn(async (input) => ({
			id: "job-1",
			name: input.name,
		}));
		const tool = createCronTool({
			service: {
				addJob,
				listJobs: vi.fn(),
				removeJob: vi.fn(),
			} as never,
			defaultTimeZone: "UTC",
			channel: "telegram",
			chatId: "42",
		});

		const result = (await tool.execute("call-1", {
			action: "add",
			name: "morning-check",
			message: "say hi",
			cron_expr: "0 9 * * *",
			tz: "UTC",
		})) as {
			content: Array<{ type: string; text: string }>;
		};

		expect(addJob).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "morning-check",
				message: "say hi",
				deliver: true,
				channel: "telegram",
				to: "42",
			}),
		);
		expect(result.content[0]?.text).toContain("Created job");
	});

	it("lists and removes jobs through the service", async () => {
		const listJobs = vi.fn(async () => [
			{
				id: "job-1",
				name: "ping",
				schedule: {
					kind: "every",
					everyMs: 60_000,
				},
				state: {
					nextRunAtMs: Date.parse("2026-04-19T09:00:00.000Z"),
				},
			},
		]);
		const removeJob = vi.fn(async () => "removed");
		const tool = createCronTool({
			service: {
				addJob: vi.fn(),
				listJobs,
				removeJob,
			} as never,
			defaultTimeZone: "UTC",
		});

		const listed = (await tool.execute("call-1", {
			action: "list",
		})) as {
			content: Array<{ type: string; text: string }>;
		};
		const removed = (await tool.execute("call-2", {
			action: "remove",
			job_id: "job-1",
		})) as {
			content: Array<{ type: string; text: string }>;
		};

		expect(listJobs).toHaveBeenCalledOnce();
		expect(removeJob).toHaveBeenCalledWith("job-1");
		expect(listed.content[0]?.text).toContain("Scheduled jobs:");
		expect(removed.content[0]?.text).toBe("Removed job job-1");
	});
});
