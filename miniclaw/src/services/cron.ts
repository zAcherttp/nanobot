import cron from "node-cron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "@/utils/logger";

export interface CronSchedule {
  kind: "at" | "every" | "cron";
  atMs?: number;
  everyMs?: number;
  expr?: string;
  tz?: string;
}

export interface CronPayload {
  kind: "agent_turn" | "system_event";
  message: string;
  deliver: boolean;
  channel?: string;
  to?: string;
}

export interface CronJobState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  runHistory: CronRunRecord[];
}

export interface CronRunRecord {
  runAtMs: number;
  status: "ok" | "error";
  durationMs: number;
  error?: string;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  state: CronJobState;
  createdAtMs: number;
  updatedAtMs: number;
  deleteAfterRun: boolean;
}

export interface CronStore {
  version: number;
  jobs: CronJob[];
}

export type CronCallback = (job: CronJob) => Promise<void> | void;

export class CronService {
  private readonly storePath: string;
  private readonly onJob: CronCallback | null;
  private store: CronStore | null = null;
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private running = false;

  constructor(storePath: string, onJob: CronCallback | null = null) {
    this.storePath = storePath;
    this.onJob = onJob;
  }

  /**
   * Start the cron service
   */
  async start(): Promise<void> {
    this.running = true;
    await this.loadStore();
    this.scheduleJobs();
    logger.info(
      `Cron service started with ${this.store?.jobs.length || 0} jobs`,
    );
  }

  /**
   * Stop the cron service
   */
  stop(): void {
    this.running = false;
    this.tasks.forEach((task) => task.stop());
    this.tasks.clear();
    logger.info("Cron service stopped");
  }

  /**
   * List all jobs
   */
  listJobs(includeDisabled = false): CronJob[] {
    if (!this.store) return [];
    const jobs = includeDisabled
      ? this.store.jobs
      : this.store.jobs.filter((j) => j.enabled);
    return jobs.sort(
      (a, b) =>
        (a.state.nextRunAtMs || Infinity) - (b.state.nextRunAtMs || Infinity),
    );
  }

  /**
   * Add a new job
   */
  async addJob(
    name: string,
    schedule: CronSchedule,
    message: string,
    deliver = false,
    channel?: string,
    to?: string,
    deleteAfterRun = false,
  ): Promise<CronJob> {
    const now = Date.now();
    const job: CronJob = {
      id: this.generateId(),
      name,
      enabled: true,
      schedule,
      payload: {
        kind: "agent_turn",
        message,
        deliver,
        channel,
        to,
      },
      state: {
        nextRunAtMs: this.computeNextRun(schedule, now),
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        runHistory: [],
      },
      createdAtMs: now,
      updatedAtMs: now,
      deleteAfterRun,
    };

    if (!this.store) {
      this.store = { version: 1, jobs: [] };
    }

    this.store.jobs.push(job);
    await this.saveStore();

    if (this.running) {
      this.scheduleJob(job);
    }

    logger.info(`Cron: added job '${name}' (${job.id})`);
    return job;
  }

  /**
   * Remove a job
   */
  async removeJob(jobId: string): Promise<boolean> {
    if (!this.store) return false;

    const job = this.store.jobs.find((j) => j.id === jobId);
    if (!job) return false;

    if (job.payload.kind === "system_event") {
      logger.info(`Cron: refused to remove protected system job ${jobId}`);
      return false;
    }

    const before = this.store.jobs.length;
    this.store.jobs = this.store.jobs.filter((j) => j.id !== jobId);
    const removed = this.store.jobs.length < before;

    if (removed) {
      this.tasks.get(jobId)?.stop();
      this.tasks.delete(jobId);
      await this.saveStore();
      logger.info(`Cron: removed job ${jobId}`);
    }

    return removed;
  }

  /**
   * Enable or disable a job
   */
  async enableJob(jobId: string, enabled = true): Promise<CronJob | null> {
    if (!this.store) return null;

    const job = this.store.jobs.find((j) => j.id === jobId);
    if (!job) return null;

    job.enabled = enabled;
    job.updatedAtMs = Date.now();

    if (enabled) {
      job.state.nextRunAtMs = this.computeNextRun(job.schedule, Date.now());
      if (this.running) {
        this.scheduleJob(job);
      }
    } else {
      job.state.nextRunAtMs = null;
      this.tasks.get(jobId)?.stop();
      this.tasks.delete(jobId);
    }

    await this.saveStore();
    return job;
  }

  /**
   * Get a job by ID
   */
  getJob(jobId: string): CronJob | null {
    if (!this.store) return null;
    return this.store.jobs.find((j) => j.id === jobId) || null;
  }

  /**
   * Get service status
   */
  status(): { enabled: boolean; jobs: number } {
    return {
      enabled: this.running,
      jobs: this.store?.jobs.length || 0,
    };
  }

  /**
   * Load jobs from disk
   */
  private async loadStore(): Promise<void> {
    try {
      const content = await fs.readFile(this.storePath, "utf8");
      this.store = JSON.parse(content) as CronStore;
    } catch (err) {
      logger.debug(`Failed to load cron store: ${err}`);
      this.store = { version: 1, jobs: [] };
    }
  }

  /**
   * Save jobs to disk
   */
  private async saveStore(): Promise<void> {
    if (!this.store) return;

    const dir = path.dirname(this.storePath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(
      this.storePath,
      JSON.stringify(this.store, null, 2),
      "utf8",
    );
  }

  /**
   * Schedule all jobs
   */
  private scheduleJobs(): void {
    if (!this.store) return;

    for (const job of this.store.jobs) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  /**
   * Schedule a single job
   */
  private scheduleJob(job: CronJob): void {
    // Stop existing task if any
    this.tasks.get(job.id)?.stop();

    let cronExpr: string;

    switch (job.schedule.kind) {
      case "at":
        if (!job.schedule.atMs) return;
        cronExpr = this.atToCron(job.schedule.atMs);
        break;
      case "every":
        if (!job.schedule.everyMs) return;
        cronExpr = this.everyToCron(job.schedule.everyMs);
        break;
      case "cron":
        if (!job.schedule.expr) return;
        cronExpr = job.schedule.expr;
        break;
      default:
        return;
    }

    const task = cron.schedule(
      cronExpr,
      async () => {
        await this.executeJob(job);
      },
      { timezone: job.schedule.tz },
    );

    this.tasks.set(job.id, task);
    task.start();
  }

  /**
   * Execute a job
   */
  private async executeJob(job: CronJob): Promise<void> {
    const startMs = Date.now();
    logger.info(`Cron: executing job '${job.name}' (${job.id})`);

    try {
      if (this.onJob) {
        await this.onJob(job);
      }

      job.state.lastStatus = "ok";
      job.state.lastError = null;
      logger.info(`Cron: job '${job.name}' completed`);
    } catch (err) {
      job.state.lastStatus = "error";
      job.state.lastError = String(err);
      logger.error(`Cron: job '${job.name}' failed: ${err}`);
    }

    const endMs = Date.now();
    job.state.lastRunAtMs = startMs;
    job.updatedAtMs = endMs;

    job.state.runHistory.push({
      runAtMs: startMs,
      status: job.state.lastStatus,
      durationMs: endMs - startMs,
      error: job.state.lastError || undefined,
    });

    // Keep only last 20 records
    if (job.state.runHistory.length > 20) {
      job.state.runHistory = job.state.runHistory.slice(-20);
    }

    // Handle one-shot jobs
    if (job.schedule.kind === "at") {
      if (job.deleteAfterRun) {
        this.store!.jobs = this.store!.jobs.filter((j) => j.id !== job.id);
        this.tasks.get(job.id)?.stop();
        this.tasks.delete(job.id);
      } else {
        job.enabled = false;
        job.state.nextRunAtMs = null;
        this.tasks.get(job.id)?.stop();
        this.tasks.delete(job.id);
      }
    } else {
      // Compute next run
      job.state.nextRunAtMs = this.computeNextRun(job.schedule, Date.now());
    }

    await this.saveStore();
  }

  /**
   * Compute next run time in milliseconds
   */
  private computeNextRun(schedule: CronSchedule, nowMs: number): number | null {
    if (schedule.kind === "at") {
      return schedule.atMs && schedule.atMs > nowMs ? schedule.atMs : null;
    }

    if (schedule.kind === "every") {
      if (!schedule.everyMs || schedule.everyMs <= 0) return null;
      return nowMs + schedule.everyMs;
    }

    if (schedule.kind === "cron" && schedule.expr) {
      // For cron expressions, we can't easily compute the next run time
      // without a cron library. Return null and let node-cron handle it.
      return null;
    }

    return null;
  }

  /**
   * Convert timestamp to cron expression
   */
  private atToCron(atMs: number): string {
    const date = new Date(atMs);
    const minute = date.getMinutes();
    const hour = date.getHours();
    const day = date.getDate();
    const month = date.getMonth() + 1;
    return `${minute} ${hour} ${day} ${month} *`;
  }

  /**
   * Convert interval to cron expression
   */
  private everyToCron(everyMs: number): string {
    const minutes = Math.floor(everyMs / 60000);
    if (minutes < 1) return "* * * * *"; // Every minute minimum
    return `*/${minutes} * * * *`;
  }

  /**
   * Generate a unique ID
   */
  private generateId(): string {
    return Math.random().toString(36).substring(2, 10);
  }
}
