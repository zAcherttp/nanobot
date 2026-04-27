import type { CronService, CronSchedule } from "@/services/cron";

/**
 * Add a cron job
 */
export async function addCronJob(
  cronService: CronService,
  params: {
    name: string;
    message: string;
    deliver?: boolean;
    channel?: string;
    to?: string;
    deleteAfterRun?: boolean;
    at?: string; // ISO datetime
    cronExpr?: string; // Cron expression
    everySeconds?: number;
    tz?: string; // Timezone
  },
): Promise<string> {
  let schedule: CronSchedule;

  if (params.at) {
    const atMs = new Date(params.at).getTime();
    if (isNaN(atMs)) {
      return "Error: Invalid datetime format. Use ISO format (e.g., 2024-01-15T10:00:00)";
    }
    schedule = { kind: "at", atMs };
  } else if (params.cronExpr) {
    schedule = { kind: "cron", expr: params.cronExpr, tz: params.tz };
  } else if (params.everySeconds) {
    schedule = { kind: "every", everyMs: params.everySeconds * 1000 };
  } else {
    return "Error: Must specify one of: at, cronExpr, or everySeconds";
  }

  const job = await cronService.addJob(
    params.name,
    schedule,
    params.message,
    params.deliver || false,
    params.channel,
    params.to,
    params.deleteAfterRun || false,
  );

  return `Created job '${job.name}' (${job.id})`;
}

/**
 * List cron jobs
 */
export async function listCronJobs(
  cronService: CronService,
  includeDisabled = false,
): Promise<string> {
  const jobs = cronService.listJobs(includeDisabled);

  if (jobs.length === 0) {
    return "No jobs scheduled.";
  }

  const lines = jobs.map((job) => {
    const schedule = formatSchedule(job.schedule);
    const nextRun = job.state.nextRunAtMs
      ? new Date(job.state.nextRunAtMs).toISOString()
      : "N/A";
    const lastRun = job.state.lastRunAtMs
      ? new Date(job.state.lastRunAtMs).toISOString()
      : "Never";

    return `- **${job.name}** (${job.id})
  Schedule: ${schedule}
  Next run: ${nextRun}
  Last run: ${lastRun}
  Status: ${job.state.lastStatus || "Never run"}
  ${job.state.lastError ? `Error: ${job.state.lastError}` : ""}`;
  });

  return lines.join("\n\n");
}

/**
 * Remove a cron job
 */
export async function removeCronJob(
  cronService: CronService,
  jobId: string,
): Promise<string> {
  const removed = await cronService.removeJob(jobId);

  if (removed) {
    return `Removed job ${jobId}`;
  }

  return `Job ${jobId} not found or is protected`;
}

/**
 * Enable or disable a cron job
 */
export async function enableCronJob(
  cronService: CronService,
  jobId: string,
  enabled = true,
): Promise<string> {
  const job = await cronService.enableJob(jobId, enabled);

  if (job) {
    return `${enabled ? "Enabled" : "Disabled"} job '${job.name}' (${jobId})`;
  }

  return `Job ${jobId} not found`;
}

/**
 * Format schedule for display
 */
function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at":
      return schedule.atMs
        ? `At ${new Date(schedule.atMs).toISOString()}`
        : "Invalid";
    case "every":
      return schedule.everyMs
        ? `Every ${schedule.everyMs / 1000} seconds`
        : "Invalid";
    case "cron":
      return schedule.expr
        ? `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ""}`
        : "Invalid";
    default:
      return "Unknown";
  }
}
