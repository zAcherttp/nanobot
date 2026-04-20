import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	type CronJob,
	CronService,
	computeNextRun,
	formatCronTimestamp,
} from "../src/cron/index.js";
import type { Logger } from "../src/utils/logging.js";

const LOGGER: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
};

describe("cron service", () => {
	it("computes next runs for every and at schedules", () => {
		expect(
			computeNextRun(
				{
					kind: "every",
					everyMs: 15_000,
				},
				1_000,
			),
		).toBe(16_000);
		expect(
			computeNextRun(
				{
					kind: "at",
					atMs: 20_000,
				},
				1_000,
			),
		).toBe(20_000);
		expect(
			computeNextRun(
				{
					kind: "at",
					atMs: 500,
				},
				1_000,
			),
		).toBeNull();
	});

	it("computes the next cron match in a timezone", () => {
		const now = Date.parse("2026-04-19T08:15:00.000Z");

		expect(
			computeNextRun(
				{
					kind: "cron",
					expr: "30 8 * * *",
					tz: "UTC",
				},
				now,
			),
		).toBe(Date.parse("2026-04-19T08:30:00.000Z"));
	});

	it("persists jobs across service instances", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cron-"));
		const storePath = path.join(dir, "jobs.json");
		const first = new CronService(storePath, {
			logger: LOGGER,
		});
		const second = new CronService(storePath, {
			logger: LOGGER,
		});

		const job = await first.addJob({
			name: "status-check",
			schedule: {
				kind: "every",
				everyMs: 60_000,
			},
			message: "check status",
		});

		const jobs = await second.listJobs(true);

		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.id).toBe(job.id);
		expect(jobs[0]?.payload.kind).toBe("agent_turn");
		if (jobs[0]?.payload.kind === "agent_turn") {
			expect(jobs[0].payload.message).toBe("check status");
		}
	});

	it("runs one-shot jobs once and removes them when deleteAfterRun is set", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cron-"));
		const storePath = path.join(dir, "jobs.json");
		const seen: string[] = [];
		let now = Date.parse("2026-04-19T08:00:00.000Z");
		const service = new CronService(storePath, {
			logger: LOGGER,
			now: () => now,
			onJob: async (job) => {
				seen.push(job.id);
			},
		});

		const job = await service.addJob({
			name: "one-shot",
			schedule: {
				kind: "at",
				atMs: now + 30_000,
			},
			message: "run once",
			deleteAfterRun: true,
		});

		now += 31_000;
		expect(await service.runJob(job.id, true)).toBe(true);
		expect(seen).toEqual([job.id]);
		expect(await service.getJob(job.id)).toBeNull();
	});

	it("records errors and caps run history", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cron-"));
		const storePath = path.join(dir, "jobs.json");
		let now = Date.parse("2026-04-19T08:00:00.000Z");
		const service = new CronService(storePath, {
			logger: LOGGER,
			now: () => now,
			maxRunHistory: 2,
			onJob: async () => {
				throw new Error("boom");
			},
		});

		const job = await service.addJob({
			name: "broken",
			schedule: {
				kind: "every",
				everyMs: 1_000,
			},
			message: "explode",
		});

		await service.runJob(job.id, true);
		now += 2_000;
		await service.runJob(job.id, true);
		now += 2_000;
		await service.runJob(job.id, true);

		const updated = await service.getJob(job.id);
		expect(updated?.state.lastStatus).toBe("error");
		expect(updated?.state.lastError).toBe("boom");
		expect(updated?.state.runHistory).toHaveLength(2);
	});

	it("formats timestamps in the configured timezone", () => {
		expect(
			formatCronTimestamp(Date.parse("2026-04-19T08:30:45.000Z"), "UTC"),
		).toBe("2026-04-19T08:30:45 (UTC)");
	});

	it("registers protected internal system jobs", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cron-"));
		const storePath = path.join(dir, "jobs.json");
		const service = new CronService(storePath, {
			logger: LOGGER,
		});

		const job = await service.registerSystemJob({
			id: "system-heartbeat",
			name: "Heartbeat",
			schedule: {
				kind: "every",
				everyMs: 60_000,
			},
			event: "heartbeat",
			message: "internal only",
		});

		expect(job.payload.kind).toBe("system_event");
		if (job.payload.kind === "system_event") {
			expect(job.payload.event).toBe("heartbeat");
			expect(job.payload.deliver).toBe(false);
		}
	});

	it("refuses to remove protected internal jobs", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cron-"));
		const storePath = path.join(dir, "jobs.json");
		const service = new CronService(storePath, {
			logger: LOGGER,
		});
		const job = await service.registerSystemJob({
			id: "system-heartbeat",
			name: "Heartbeat",
			schedule: {
				kind: "every",
				everyMs: 60_000,
			},
			event: "heartbeat",
		});

		await expect(service.removeJob(job.id)).resolves.toBe("protected");
		expect(await service.getJob(job.id)).not.toBeNull();
	});

	it("refuses to update protected internal jobs", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cron-"));
		const storePath = path.join(dir, "jobs.json");
		const service = new CronService(storePath, {
			logger: LOGGER,
		});
		const job = await service.registerSystemJob({
			id: "system-heartbeat",
			name: "Heartbeat",
			schedule: {
				kind: "every",
				everyMs: 60_000,
			},
			event: "heartbeat",
		});

		await expect(
			service.updateJob(job.id, {
				name: "Renamed",
			}),
		).resolves.toBe("protected");
	});

	it("lists all registered jobs including system and user jobs", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cron-"));
		const storePath = path.join(dir, "jobs.json");
		const service = new CronService(storePath, {
			logger: LOGGER,
		});

		await service.registerSystemJob({
			id: "system-heartbeat",
			name: "Heartbeat",
			schedule: { kind: "every", everyMs: 60_000 },
			event: "heartbeat",
		});
		await service.addJob({
			name: "User Task",
			schedule: { kind: "every", everyMs: 300_000 },
			message: "daily check",
			channel: "telegram",
			chatId: "42",
		});

		const jobs = await service.listJobs();
		expect(jobs.length).toBeGreaterThanOrEqual(2);
		expect(jobs.some((j) => j.name === "Heartbeat")).toBe(true);
		expect(jobs.some((j) => j.name === "User Task")).toBe(true);
	});

	it("updates a user job name and schedule", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cron-"));
		const storePath = path.join(dir, "jobs.json");
		const service = new CronService(storePath, {
			logger: LOGGER,
		});
		const job = await service.addJob({
			name: "Old Name",
			schedule: { kind: "every", everyMs: 60_000 },
			message: "check",
			channel: "telegram",
			chatId: "42",
		});

		const result = await service.updateJob(job.id, {
			name: "New Name",
			schedule: { kind: "every", everyMs: 120_000 },
		});
		expect(result).toEqual(expect.objectContaining({ name: "New Name" }));

		const updated = await service.getJob(job.id);
		expect(updated?.name).toBe("New Name");
		expect((updated?.schedule as any)?.everyMs).toBe(120_000);
	});

	it("handles one-shot 'at' job with a past timestamp by returning it from next run", () => {
		const pastTimestamp = Date.now() - 60_000;
		const nextRun = computeNextRun(
			{ kind: "at", atMs: pastTimestamp },
			Date.now() - 120_000,
		);
		expect(nextRun).toBe(pastTimestamp);
	});
});
