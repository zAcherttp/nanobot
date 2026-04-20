import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../utils/logging.js";
import type {
	CronJob,
	CronPayload,
	CronRunRecord,
	CronSchedule,
	CronServiceStatus,
	CronStoreData,
} from "./types.js";

export interface CronServiceOptions {
	onJob?: (job: CronJob) => Promise<string | null | void>;
	maxSleepMs?: number;
	maxRunHistory?: number;
	logger?: Logger;
	now?: () => number;
}

export const CRON_STORE_VERSION = 1;
const DEFAULT_MAX_RUN_HISTORY = 20;
const DEFAULT_MAX_SLEEP_MS = 300_000;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export class CronService {
	private readonly onJob:
		| ((job: CronJob) => Promise<string | null | void>)
		| undefined;
	private readonly maxSleepMs: number;
	private readonly maxRunHistory: number;
	private readonly logger: Logger | undefined;
	private readonly now: () => number;
	private store: CronStoreData = {
		version: CRON_STORE_VERSION,
		jobs: [],
	};
	private running = false;
	private timer: NodeJS.Timeout | undefined;
	private pending = Promise.resolve<void>(undefined);
	private readonly activeJobIds = new Set<string>();

	constructor(
		private readonly storePath: string,
		options: CronServiceOptions = {},
	) {
		this.onJob = options.onJob;
		this.maxSleepMs = options.maxSleepMs ?? DEFAULT_MAX_SLEEP_MS;
		this.maxRunHistory = options.maxRunHistory ?? DEFAULT_MAX_RUN_HISTORY;
		this.logger = options.logger;
		this.now = options.now ?? (() => Date.now());
	}

	isRunning(): boolean {
		return this.running;
	}

	isSessionActive(sessionKey: string): boolean {
		if (!sessionKey.startsWith("cron:")) {
			return false;
		}
		return this.activeJobIds.has(sessionKey.slice("cron:".length));
	}

	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		this.running = true;
		await this.withLock(async () => {
			this.store = await this.loadStore();
			this.recomputeNextRuns(this.now());
			await this.saveStore(this.store);
			this.armTimer();
		});
		this.logger?.info("Cron service started", {
			path: this.storePath,
			jobs: this.store.jobs.length,
		});
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.pending;
	}

	async listJobs(includeDisabled = false): Promise<CronJob[]> {
		return this.withLock(async () => {
			const store = await this.getCurrentStore();
			const jobs = includeDisabled
				? store.jobs
				: store.jobs.filter((job) => job.enabled);
			return jobs
				.map((job) => structuredClone(job))
				.sort(
					(left, right) =>
						(left.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER) -
						(right.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER),
				);
		});
	}

	async getJob(jobId: string): Promise<CronJob | null> {
		return this.withLock(async () => {
			const store = await this.getCurrentStore();
			const job = store.jobs.find((entry) => entry.id === jobId);
			return job ? structuredClone(job) : null;
		});
	}

	async addJob(options: {
		name: string;
		schedule: CronSchedule;
		message: string;
		deliver?: boolean;
		channel?: string;
		to?: string;
		deleteAfterRun?: boolean;
	}): Promise<CronJob> {
		return this.withLock(async () => {
			validateSchedule(options.schedule);
			const store = await this.getCurrentStore();
			const now = this.now();
			const job: CronJob = {
				id: createJobId(now),
				name: options.name,
				enabled: true,
				schedule: structuredClone(options.schedule),
				payload: {
					kind: "agent_turn",
					message: options.message,
					deliver: options.deliver ?? false,
					...(options.channel ? { channel: options.channel } : {}),
					...(options.to ? { to: options.to } : {}),
				},
				state: {
					nextRunAtMs: computeNextRun(options.schedule, now),
					lastRunAtMs: null,
					lastStatus: null,
					lastError: null,
					runHistory: [],
				},
				createdAtMs: now,
				updatedAtMs: now,
				deleteAfterRun: options.deleteAfterRun ?? false,
			};
			store.jobs.push(job);
			await this.commitStore(store);
			this.logger?.info("Cron job added", {
				jobId: job.id,
				name: job.name,
			});
			return structuredClone(job);
		});
	}

	async registerSystemJob(options: {
		id: string;
		name: string;
		schedule: CronSchedule;
		event: string;
		message?: string;
		deleteAfterRun?: boolean;
	}): Promise<CronJob> {
		return this.withLock(async () => {
			validateSchedule(options.schedule);
			const store = await this.getCurrentStore();
			const now = this.now();
			const existingIndex = store.jobs.findIndex(
				(job) => job.id === options.id,
			);
			const createdAtMs =
				existingIndex >= 0 ? store.jobs[existingIndex]!.createdAtMs : now;
			const job: CronJob = {
				id: options.id,
				name: options.name,
				enabled: true,
				schedule: structuredClone(options.schedule),
				payload: {
					kind: "system_event",
					event: options.event,
					...(options.message ? { message: options.message } : {}),
					deliver: false,
				},
				state: {
					nextRunAtMs: computeNextRun(options.schedule, now),
					lastRunAtMs: null,
					lastStatus: null,
					lastError: null,
					runHistory: [],
				},
				createdAtMs,
				updatedAtMs: now,
				deleteAfterRun: options.deleteAfterRun ?? false,
			};
			if (existingIndex >= 0) {
				store.jobs[existingIndex] = job;
			} else {
				store.jobs.push(job);
			}
			await this.commitStore(store);
			return structuredClone(job);
		});
	}

	async removeJob(
		jobId: string,
	): Promise<"removed" | "protected" | "not_found"> {
		return this.withLock(async () => {
			const store = await this.getCurrentStore();
			const job = store.jobs.find((entry) => entry.id === jobId);
			if (!job) {
				return "not_found" as const;
			}
			if (job.payload.kind === "system_event") {
				return "protected" as const;
			}
			const nextJobs = store.jobs.filter((entry) => entry.id !== jobId);
			store.jobs = nextJobs;
			await this.commitStore(store);
			return "removed" as const;
		});
	}

	async enableJob(jobId: string, enabled = true): Promise<CronJob | null> {
		return this.withLock(async () => {
			const store = await this.getCurrentStore();
			const job = store.jobs.find((entry) => entry.id === jobId);
			if (!job) {
				return null;
			}
			job.enabled = enabled;
			job.updatedAtMs = this.now();
			job.state.nextRunAtMs = enabled
				? computeNextRun(job.schedule, this.now())
				: null;
			await this.commitStore(store);
			return structuredClone(job);
		});
	}

	async updateJob(
		jobId: string,
		options: {
			name?: string;
			schedule?: CronSchedule;
			message?: string;
			deliver?: boolean;
			channel?: string | null;
			to?: string | null;
			deleteAfterRun?: boolean;
		},
	): Promise<CronJob | "protected" | "not_found"> {
		return this.withLock(async () => {
			const store = await this.getCurrentStore();
			const job = store.jobs.find((entry) => entry.id === jobId);
			if (!job) {
				return "not_found";
			}
			if (job.payload.kind === "system_event") {
				return "protected";
			}

			if (options.schedule) {
				validateSchedule(options.schedule);
				job.schedule = structuredClone(options.schedule);
				job.state.nextRunAtMs = job.enabled
					? computeNextRun(job.schedule, this.now())
					: null;
			}
			if (options.name !== undefined) {
				job.name = options.name;
			}
			if (options.message !== undefined) {
				job.payload.message = options.message;
			}
			if (options.deliver !== undefined) {
				job.payload.deliver = options.deliver;
			}
			if (options.channel !== undefined) {
				if (options.channel) {
					job.payload.channel = options.channel;
				} else {
					delete job.payload.channel;
				}
			}
			if (options.to !== undefined) {
				if (options.to) {
					job.payload.to = options.to;
				} else {
					delete job.payload.to;
				}
			}
			if (options.deleteAfterRun !== undefined) {
				job.deleteAfterRun = options.deleteAfterRun;
			}
			job.updatedAtMs = this.now();
			await this.commitStore(store);
			return structuredClone(job);
		});
	}

	async runJob(jobId: string, force = false): Promise<boolean> {
		return this.withLock(async () => {
			const store = await this.getCurrentStore();
			const job = store.jobs.find((entry) => entry.id === jobId);
			if (!job) {
				return false;
			}
			if (!force && !job.enabled) {
				return false;
			}

			await this.executeJob(job, store);
			await this.commitStore(store);
			return true;
		});
	}

	async status(): Promise<CronServiceStatus> {
		return this.withLock(async () => {
			const store = await this.getCurrentStore();
			return {
				enabled: this.running,
				jobs: store.jobs.length,
				nextWakeAtMs: getNextWakeAtMs(store.jobs),
			};
		});
	}

	private async handleTimer(): Promise<void> {
		await this.withLock(async () => {
			if (!this.running) {
				return;
			}

			const store = await this.getCurrentStore();
			const now = this.now();
			const dueJobs = store.jobs.filter(
				(job) =>
					job.enabled &&
					job.state.nextRunAtMs !== null &&
					now >= job.state.nextRunAtMs,
			);

			for (const job of dueJobs) {
				await this.executeJob(job, store);
			}

			await this.commitStore(store);
		});
	}

	private recomputeNextRuns(nowMs: number): void {
		this.store.jobs = this.store.jobs.map((job) => {
			if (!job.enabled) {
				return {
					...job,
					state: {
						...job.state,
						nextRunAtMs: null,
					},
				};
			}

			return {
				...job,
				state: {
					...job.state,
					nextRunAtMs: computeNextRun(job.schedule, nowMs),
				},
			};
		});
	}

	private async executeJob(job: CronJob, store: CronStoreData): Promise<void> {
		const startedAt = this.now();
		this.activeJobIds.add(job.id);
		this.logger?.info("Cron job executing", {
			jobId: job.id,
			name: job.name,
		});

		try {
			await this.onJob?.(structuredClone(job));
			job.state.lastStatus = "ok";
			job.state.lastError = null;
		} catch (error) {
			job.state.lastStatus = "error";
			job.state.lastError =
				error instanceof Error ? error.message : String(error);
			this.logger?.error("Cron job failed", {
				jobId: job.id,
				name: job.name,
				error,
			});
		} finally {
			this.activeJobIds.delete(job.id);
		}

		const finishedAt = this.now();
		job.state.lastRunAtMs = startedAt;
		job.updatedAtMs = finishedAt;
		const record: CronRunRecord = {
			runAtMs: startedAt,
			status: job.state.lastStatus ?? "error",
			durationMs: finishedAt - startedAt,
			...(job.state.lastError ? { error: job.state.lastError } : {}),
		};
		job.state.runHistory.push(record);
		job.state.runHistory = job.state.runHistory.slice(-this.maxRunHistory);

		if (job.schedule.kind === "at") {
			if (job.deleteAfterRun) {
				store.jobs = store.jobs.filter((entry) => entry.id !== job.id);
				return;
			}
			job.enabled = false;
			job.state.nextRunAtMs = null;
			return;
		}

		job.state.nextRunAtMs = computeNextRun(job.schedule, this.now());
	}

	private async getCurrentStore(): Promise<CronStoreData> {
		if (this.running) {
			return this.store;
		}

		return this.loadStore();
	}

	private async commitStore(store: CronStoreData): Promise<void> {
		if (this.running) {
			this.store = store;
		}
		await this.saveStore(store);
		if (this.running) {
			this.armTimer();
		}
	}

	private armTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (!this.running) {
			return;
		}

		const nextWakeAtMs = getNextWakeAtMs(this.store.jobs);
		const delayMs =
			nextWakeAtMs === null
				? this.maxSleepMs
				: Math.min(this.maxSleepMs, Math.max(0, nextWakeAtMs - this.now()));

		this.timer = setTimeout(() => {
			void this.handleTimer();
		}, delayMs);
	}

	private async loadStore(): Promise<CronStoreData> {
		try {
			const raw = await readFile(this.storePath, "utf8");
			const parsed = JSON.parse(raw) as CronStoreData;
			return normalizeStore(parsed);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return {
					version: CRON_STORE_VERSION,
					jobs: [],
				};
			}

			throw error;
		}
	}

	private async saveStore(store: CronStoreData): Promise<void> {
		await mkdir(path.dirname(this.storePath), { recursive: true });
		const temporaryPath = `${this.storePath}.tmp`;
		await writeFile(
			temporaryPath,
			`${JSON.stringify(store, null, 2)}\n`,
			"utf8",
		);
		await rename(temporaryPath, this.storePath);
	}

	private withLock<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.pending.then(operation, operation);
		this.pending = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}

export function computeNextRun(
	schedule: CronSchedule,
	nowMs: number,
): number | null {
	if (schedule.kind === "at") {
		return schedule.atMs > nowMs ? schedule.atMs : null;
	}

	if (schedule.kind === "every") {
		return schedule.everyMs > 0 ? nowMs + schedule.everyMs : null;
	}

	const fields = parseCronExpression(schedule.expr);
	if (!fields) {
		return null;
	}

	const tz = schedule.tz || "UTC";
	if (!isValidTimeZone(tz)) {
		return null;
	}

	const nextMinute = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
	const limit = nextMinute + 366 * 24 * 60 * 60 * 1000;
	for (let candidate = nextMinute; candidate <= limit; candidate += 60_000) {
		const parts = getZonedParts(candidate, tz);
		if (
			fields.minute.has(parts.minute) &&
			fields.hour.has(parts.hour) &&
			fields.dayOfMonth.has(parts.day) &&
			fields.month.has(parts.month) &&
			fields.dayOfWeek.has(parts.weekday)
		) {
			return candidate;
		}
	}

	return null;
}

export function validateSchedule(schedule: CronSchedule): void {
	if (schedule.kind === "every") {
		if (schedule.everyMs <= 0) {
			throw new Error("everyMs must be positive.");
		}
		return;
	}

	if (schedule.kind === "at") {
		if (!Number.isFinite(schedule.atMs)) {
			throw new Error("atMs must be a finite timestamp.");
		}
		return;
	}

	if (schedule.tz && !isValidTimeZone(schedule.tz)) {
		throw new Error(`Unknown timezone '${schedule.tz}'.`);
	}

	if (!parseCronExpression(schedule.expr)) {
		throw new Error(`Invalid cron expression '${schedule.expr}'.`);
	}
}

export function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", {
			timeZone,
		}).format(0);
		return true;
	} catch {
		return false;
	}
}

export function formatCronTimestamp(ms: number, timeZone: string): string {
	const parts = getZonedParts(ms, timeZone);
	return `${parts.year.toString().padStart(4, "0")}-${parts.month
		.toString()
		.padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}T${parts.hour
		.toString()
		.padStart(2, "0")}:${parts.minute
		.toString()
		.padStart(2, "0")}:${parts.second
		.toString()
		.padStart(2, "0")} (${timeZone})`;
}

export function parseNaiveIsoToMs(input: string, timeZone: string): number {
	const withZone = Date.parse(input);
	if (!Number.isNaN(withZone) && /[zZ]|[+-]\d{2}:\d{2}$/.test(input)) {
		return withZone;
	}

	const match = input.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
	);
	if (!match) {
		throw new Error(
			`Invalid ISO datetime '${input}'. Expected YYYY-MM-DDTHH:MM[:SS].`,
		);
	}
	if (!isValidTimeZone(timeZone)) {
		throw new Error(`Unknown timezone '${timeZone}'.`);
	}

	const year = match[1]!;
	const month = match[2]!;
	const day = match[3]!;
	const hour = match[4]!;
	const minute = match[5]!;
	const second = match[6] ?? "00";
	const target = {
		year: Number.parseInt(year, 10),
		month: Number.parseInt(month, 10),
		day: Number.parseInt(day, 10),
		hour: Number.parseInt(hour, 10),
		minute: Number.parseInt(minute, 10),
		second: Number.parseInt(second, 10),
	};
	const guess = Date.UTC(
		target.year,
		target.month - 1,
		target.day,
		target.hour,
		target.minute,
		target.second,
	);
	const lowerBound = guess - 36 * 60 * 60 * 1000;
	const upperBound = guess + 36 * 60 * 60 * 1000;

	for (let candidate = lowerBound; candidate <= upperBound; candidate += 1000) {
		const parts = getZonedParts(candidate, timeZone);
		if (
			parts.year === target.year &&
			parts.month === target.month &&
			parts.day === target.day &&
			parts.hour === target.hour &&
			parts.minute === target.minute &&
			parts.second === target.second
		) {
			return candidate;
		}
	}

	throw new Error(`Could not resolve '${input}' in timezone '${timeZone}'.`);
}

function normalizeStore(input: CronStoreData): CronStoreData {
	return {
		version:
			typeof input.version === "number" ? input.version : CRON_STORE_VERSION,
		jobs: Array.isArray(input.jobs)
			? input.jobs.map((job) => ({
					...job,
					payload: normalizePayload(job.payload),
					state: {
						nextRunAtMs: job.state?.nextRunAtMs ?? null,
						lastRunAtMs: job.state?.lastRunAtMs ?? null,
						lastStatus: job.state?.lastStatus ?? null,
						lastError: job.state?.lastError ?? null,
						runHistory: Array.isArray(job.state?.runHistory)
							? job.state.runHistory
							: [],
					},
				}))
			: [],
	};
}

function normalizePayload(
	payload: CronPayload | Record<string, unknown>,
): CronPayload {
	if (payload.kind === "system_event") {
		return {
			kind: "system_event",
			event: typeof payload.event === "string" ? payload.event : "system_event",
			...(typeof payload.message === "string"
				? { message: payload.message }
				: {}),
			deliver: false,
		};
	}

	return {
		kind: "agent_turn",
		message: typeof payload.message === "string" ? payload.message : "",
		deliver: payload.deliver === true,
		...("channel" in payload && typeof payload.channel === "string"
			? { channel: payload.channel }
			: {}),
		...("to" in payload && typeof payload.to === "string"
			? { to: payload.to }
			: {}),
	};
}

function getNextWakeAtMs(jobs: readonly CronJob[]): number | null {
	const wakeTimes = jobs
		.filter((job) => job.enabled && job.state.nextRunAtMs !== null)
		.map((job) => job.state.nextRunAtMs as number);
	return wakeTimes.length > 0 ? Math.min(...wakeTimes) : null;
}

function createJobId(nowMs: number): string {
	return `${nowMs.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function parseCronExpression(expression: string): CronFields | null {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		return null;
	}

	try {
		return {
			minute: parseCronField(parts[0]!, 0, 59),
			hour: parseCronField(parts[1]!, 0, 23),
			dayOfMonth: parseCronField(parts[2]!, 1, 31),
			month: parseCronField(parts[3]!, 1, 12),
			dayOfWeek: parseCronField(parts[4]!, 0, 6, {
				sun: 0,
				mon: 1,
				tue: 2,
				wed: 3,
				thu: 4,
				fri: 5,
				sat: 6,
				7: 0,
			}),
		};
	} catch {
		return null;
	}
}

function parseCronField(
	field: string,
	minimum: number,
	maximum: number,
	aliases: Record<string, number> = {},
): Set<number> {
	const result = new Set<number>();
	for (const chunk of field.split(",")) {
		const normalized = chunk.trim().toLowerCase();
		if (!normalized) {
			throw new Error("Empty cron field.");
		}

		const [base = "", stepPart] = normalized.split("/");
		const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
		if (!Number.isInteger(step) || step <= 0) {
			throw new Error("Invalid cron step.");
		}

		if (base === "*") {
			for (let value = minimum; value <= maximum; value += step) {
				result.add(value);
			}
			continue;
		}

		const [rawStart = "", rawEnd] = base.split("-");
		const start = parseCronValue(rawStart, aliases);
		const end = rawEnd ? parseCronValue(rawEnd, aliases) : start;
		if (start < minimum || end > maximum || start > end) {
			throw new Error("Cron range is out of bounds.");
		}

		for (let value = start; value <= end; value += step) {
			result.add(value);
		}
	}

	if (result.size === 0) {
		throw new Error("Cron field resolved to no values.");
	}
	return result;
}

function parseCronValue(
	value: string,
	aliases: Record<string, number>,
): number {
	if (value in aliases) {
		return aliases[value] as number;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed)) {
		throw new Error("Invalid cron value.");
	}
	return parsed;
}

function getZonedParts(timestampMs: number, timeZone: string): ZonedDateParts {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		weekday: "short",
	});
	const raw = Object.fromEntries(
		formatter
			.formatToParts(new Date(timestampMs))
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, part.value]),
	);
	const year = getRequiredPart(raw, "year");
	const month = getRequiredPart(raw, "month");
	const day = getRequiredPart(raw, "day");
	const hour = getRequiredPart(raw, "hour");
	const minute = getRequiredPart(raw, "minute");
	const second = getRequiredPart(raw, "second");
	const weekday = getRequiredPart(raw, "weekday");

	return {
		year: Number.parseInt(year, 10),
		month: Number.parseInt(month, 10),
		day: Number.parseInt(day, 10),
		hour: Number.parseInt(hour, 10),
		minute: Number.parseInt(minute, 10),
		second: Number.parseInt(second, 10),
		weekday: DAY_NAMES.indexOf(
			weekday.toLowerCase() as (typeof DAY_NAMES)[number],
		),
	};
}

function getRequiredPart(raw: Record<string, string>, key: string): string {
	const value = raw[key];
	if (!value) {
		throw new Error(`Missing time part '${key}'.`);
	}
	return value;
}

interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
}

interface ZonedDateParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	weekday: number;
}
