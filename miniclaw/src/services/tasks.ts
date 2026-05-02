import { promises as fs } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

const ACTIVE_START = "<!-- miniclaw:active-jobs:start -->";
const ACTIVE_END = "<!-- miniclaw:active-jobs:end -->";
const ARCHIVED_START = "<!-- miniclaw:archived-jobs:start -->";
const ARCHIVED_END = "<!-- miniclaw:archived-jobs:end -->";

export type JobSection = "active" | "archived";
export type JobStatus = "active" | "completed" | "cancelled";

export interface TaskChannelContext {
  channel?: string;
  userId?: string;
  trackingKey?: string;
}

export interface JobTask {
  id: string;
  title: string;
  done: boolean;
  completedAt?: string;
  fieldKey?: string;
}

export interface TaskJob {
  id: string;
  title: string;
  goal: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  tasks: JobTask[];
  channel?: string;
  userId?: string;
  trackingKey?: string;
  outcomeSummary?: string;
  cancelReason?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateJobInput {
  title: string;
  goal: string;
  tasks: Array<string | { title: string; fieldKey?: string }>;
  channelContext?: TaskChannelContext;
  kind?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateJobInput {
  title?: string;
  goal?: string;
  tasks?: string[];
}

interface TasksFileData {
  active: TaskJob[];
  archived: TaskJob[];
}

export class TaskService {
  constructor(private readonly workspacePath: string) {}

  public get tasksPath(): string {
    return path.join(this.workspacePath, "TASKS.md");
  }

  public async ensureTasksFile(): Promise<void> {
    try {
      await fs.access(this.tasksPath);
    } catch {
      await fs.mkdir(this.workspacePath, { recursive: true });
      await fs.writeFile(this.tasksPath, renderTasksMarkdown(emptyTasksFile()));
    }
  }

  public async listJobs(section?: JobSection): Promise<TaskJob[]> {
    const data = await this.readTasks();
    if (!section) {
      return [...data.active, ...data.archived];
    }
    return [...data[section]];
  }

  public async getJob(jobId: string): Promise<TaskJob | null> {
    const data = await this.readTasks();
    return findJob(data, jobId);
  }

  public async createJob(input: CreateJobInput): Promise<TaskJob> {
    const data = await this.readTasks();
    const now = new Date().toISOString();
    const jobId = `job_${ulid().toLowerCase()}`;
    const tasks = input.tasks.map((task) => {
      if (typeof task === "string") {
        return {
          id: `task_${ulid().toLowerCase()}`,
          title: task,
          done: false,
        };
      }

      return {
        id: `task_${ulid().toLowerCase()}`,
        title: task.title,
        fieldKey: task.fieldKey,
        done: false,
      };
    });

    const job: TaskJob = {
      id: jobId,
      title: input.title.trim(),
      goal: input.goal.trim(),
      status: "active",
      createdAt: now,
      updatedAt: now,
      tasks,
      channel: input.channelContext?.channel,
      userId: input.channelContext?.userId,
      trackingKey:
        input.channelContext?.trackingKey || `task:${jobId.toLowerCase()}`,
      kind: input.kind,
      metadata: input.metadata,
    };

    data.active.push(job);
    await this.writeTasks(data);
    return job;
  }

  public async updateJob(jobId: string, updates: UpdateJobInput): Promise<TaskJob> {
    const data = await this.readTasks();
    const job = this.requireActiveJob(data, jobId);

    if (typeof updates.title === "string" && updates.title.trim()) {
      job.title = updates.title.trim();
    }
    if (typeof updates.goal === "string" && updates.goal.trim()) {
      job.goal = updates.goal.trim();
    }
    if (updates.tasks) {
      job.tasks = updates.tasks.map((title) => ({
        id: `task_${ulid().toLowerCase()}`,
        title: title.trim(),
        done: false,
      }));
    }
    job.updatedAt = new Date().toISOString();

    await this.writeTasks(data);
    return job;
  }

  public async completeTask(jobId: string, taskId: string): Promise<TaskJob> {
    const data = await this.readTasks();
    const job = this.requireActiveJob(data, jobId);
    const task = this.requireTask(job, taskId);
    task.done = true;
    task.completedAt = new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    await this.writeTasks(data);
    return job;
  }

  public async reopenTask(jobId: string, taskId: string): Promise<TaskJob> {
    const data = await this.readTasks();
    const job = this.requireActiveJob(data, jobId);
    const task = this.requireTask(job, taskId);
    task.done = false;
    delete task.completedAt;
    job.updatedAt = new Date().toISOString();
    await this.writeTasks(data);
    return job;
  }

  public async archiveJob(
    jobId: string,
    outcomeSummary?: string,
  ): Promise<TaskJob> {
    const data = await this.readTasks();
    const index = data.active.findIndex((job) => job.id === jobId);
    if (index === -1) {
      throw new Error(`Active job not found: ${jobId}`);
    }

    const [job] = data.active.splice(index, 1);
    job.status = "completed";
    job.outcomeSummary = outcomeSummary?.trim() || job.outcomeSummary;
    job.updatedAt = new Date().toISOString();
    data.archived.unshift(job);
    await this.writeTasks(data);
    return job;
  }

  public async cancelJob(jobId: string, reason?: string): Promise<TaskJob> {
    const data = await this.readTasks();
    const index = data.active.findIndex((job) => job.id === jobId);
    if (index === -1) {
      throw new Error(`Active job not found: ${jobId}`);
    }

    const [job] = data.active.splice(index, 1);
    job.status = "cancelled";
    job.cancelReason = reason?.trim() || "";
    job.updatedAt = new Date().toISOString();
    data.archived.unshift(job);
    await this.writeTasks(data);
    return job;
  }

  public async findActiveJobByKind(kind: string): Promise<TaskJob | null> {
    const data = await this.readTasks();
    return data.active.find((job) => job.kind === kind) || null;
  }

  public async attachJobContext(
    jobId: string,
    context: TaskChannelContext,
  ): Promise<TaskJob> {
    const data = await this.readTasks();
    const job = this.requireActiveJob(data, jobId);
    let changed = false;

    if (context.channel && job.channel !== context.channel) {
      job.channel = context.channel;
      changed = true;
    }
    if (context.userId && job.userId !== context.userId) {
      job.userId = context.userId;
      changed = true;
    }
    if (context.trackingKey && job.trackingKey !== context.trackingKey) {
      job.trackingKey = context.trackingKey;
      changed = true;
    }

    if (changed) {
      job.updatedAt = new Date().toISOString();
      await this.writeTasks(data);
    }

    return job;
  }

  public async syncManagedJob(
    jobId: string,
    completedTaskIds: string[],
  ): Promise<{ job: TaskJob; changed: boolean }> {
    const data = await this.readTasks();
    const job = this.requireActiveJob(data, jobId);
    let changed = false;

    for (const task of job.tasks) {
      const shouldBeDone = completedTaskIds.includes(task.id);
      if (task.done !== shouldBeDone) {
        task.done = shouldBeDone;
        changed = true;
        if (shouldBeDone) {
          task.completedAt = new Date().toISOString();
        } else {
          delete task.completedAt;
        }
      }
    }

    if (changed) {
      job.updatedAt = new Date().toISOString();
      await this.writeTasks(data);
    }

    return { job, changed };
  }

  public renderJobStatus(job: TaskJob): string {
    const header = `${job.title} [${job.status}]`;
    const goal = `Goal: ${job.goal}`;
    const lines = job.tasks.map((task) =>
      `${task.done ? "[x]" : "[ ]"} ${task.title}`,
    );

    if (job.status !== "active") {
      const summary =
        job.status === "completed"
          ? `Outcome: ${job.outcomeSummary || "Completed."}`
          : `Cancelled: ${job.cancelReason || "No reason provided."}`;
      return [header, goal, ...lines, summary].join("\n");
    }

    return [header, goal, ...lines].join("\n");
  }

  public async getPromptContext(): Promise<string | null> {
    const activeJobs = await this.listJobs("active");
    const lines = ["## TASKS.md", "", "### Active Jobs"];

    if (activeJobs.length === 0) {
      lines.push("- No active jobs.");
      return lines.join("\n");
    }

    for (const job of activeJobs) {
      lines.push(`- ${job.title}`);
      lines.push(`  Goal: ${job.goal}`);
      for (const task of job.tasks) {
        lines.push(`  ${task.done ? "[x]" : "[ ]"} ${task.title}`);
      }
    }

    return lines.join("\n");
  }

  private async readTasks(): Promise<TasksFileData> {
    await this.ensureTasksFile();
    const content = await fs.readFile(this.tasksPath, "utf8");
    return parseTasksMarkdown(content);
  }

  private async writeTasks(data: TasksFileData): Promise<void> {
    await fs.writeFile(this.tasksPath, renderTasksMarkdown(data), "utf8");
  }

  private requireActiveJob(data: TasksFileData, jobId: string): TaskJob {
    const job = data.active.find((entry) => entry.id === jobId);
    if (!job) {
      throw new Error(`Active job not found: ${jobId}`);
    }
    return job;
  }

  private requireTask(job: TaskJob, taskId: string): JobTask {
    const task = job.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }
}

function emptyTasksFile(): TasksFileData {
  return { active: [], archived: [] };
}

function renderTasksMarkdown(data: TasksFileData): string {
  return `# TASKS.md

Agent-managed task ledger.

- Active jobs are the jobs the agent should keep progressing.
- Completed or cancelled jobs must move into Archived Jobs.
- Use task tools to update this file instead of editing it freehand.

## Active Jobs
${renderSection(ACTIVE_START, ACTIVE_END, data.active)}

## Archived Jobs
${renderSection(ARCHIVED_START, ARCHIVED_END, data.archived)}
`;
}

function renderSection(
  startMarker: string,
  endMarker: string,
  value: TaskJob[],
): string {
  return `${startMarker}
\`\`\`json
${JSON.stringify(value, null, 2)}
\`\`\`
${endMarker}`;
}

function parseTasksMarkdown(content: string): TasksFileData {
  return {
    active: parseSection(content, ACTIVE_START, ACTIVE_END),
    archived: parseSection(content, ARCHIVED_START, ARCHIVED_END),
  };
}

function parseSection(
  content: string,
  startMarker: string,
  endMarker: string,
): TaskJob[] {
  const match = new RegExp(
    `${escapeRegExp(startMarker)}\\s*\\\`\\\`\\\`json\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`\\s*${escapeRegExp(endMarker)}`,
    "m",
  ).exec(content);

  if (!match) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[1]) as TaskJob[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function findJob(data: TasksFileData, jobId: string): TaskJob | null {
  return data.active.find((job) => job.id === jobId)
    || data.archived.find((job) => job.id === jobId)
    || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
