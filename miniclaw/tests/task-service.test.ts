import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskService } from "../src/services/tasks";

describe("TaskService", () => {
  let tempDir: string;
  let workspaceDir: string;
  let taskService: TaskService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-tasks-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    taskService = new TaskService(workspaceDir);
    await taskService.ensureTasksFile();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates jobs with checklist items and lists them from the active section", async () => {
    const job = await taskService.createJob({
      title: "Organize launch",
      goal: "Prepare the product launch checklist.",
      tasks: ["Draft plan", "Confirm owners"],
      channelContext: {
        channel: "cli",
        userId: "user-1",
      },
    });

    const activeJobs = await taskService.listJobs("active");

    expect(activeJobs).toHaveLength(1);
    expect(activeJobs[0].id).toBe(job.id);
    expect(activeJobs[0].tasks).toHaveLength(2);
    expect(activeJobs[0].trackingKey).toBe(`task:${job.id.toLowerCase()}`);
  });

  it("completes and reopens individual tasks without corrupting the job", async () => {
    const job = await taskService.createJob({
      title: "Collect onboarding info",
      goal: "Fill the managed profile.",
      tasks: ["Capture timezone"],
    });

    const [task] = job.tasks;
    const completed = await taskService.completeTask(job.id, task.id);
    expect(completed.tasks[0].done).toBe(true);
    expect(completed.tasks[0].completedAt).toBeTruthy();

    const reopened = await taskService.reopenTask(job.id, task.id);
    expect(reopened.tasks[0].done).toBe(false);
    expect(reopened.tasks[0].completedAt).toBeUndefined();
  });

  it("archives completed jobs in the archived section instead of deleting them", async () => {
    const job = await taskService.createJob({
      title: "Prepare summary",
      goal: "Close out the user request cleanly.",
      tasks: ["Draft summary"],
    });

    await taskService.archiveJob(job.id, "Delivered the requested summary.");

    expect(await taskService.listJobs("active")).toHaveLength(0);
    const archived = await taskService.listJobs("archived");
    expect(archived).toHaveLength(1);
    expect(archived[0].status).toBe("completed");
    expect(archived[0].outcomeSummary).toBe("Delivered the requested summary.");
  });

  it("cancels active jobs and preserves the cancellation record", async () => {
    const job = await taskService.createJob({
      title: "Investigate request",
      goal: "Try an alternate approach.",
      tasks: ["Inspect runtime"],
    });

    await taskService.cancelJob(job.id, "User changed direction.");

    const archived = await taskService.listJobs("archived");
    expect(archived).toHaveLength(1);
    expect(archived[0].status).toBe("cancelled");
    expect(archived[0].cancelReason).toBe("User changed direction.");
  });
});
