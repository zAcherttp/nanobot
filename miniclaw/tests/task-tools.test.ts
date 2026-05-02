import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageBus } from "../src/bus/index";
import { TaskProgressNotifier } from "../src/services/task_progress";
import { TaskService } from "../src/services/tasks";
import { createTaskTools } from "../src/tools/tasks";

describe("task tools", () => {
  let tempDir: string;
  let workspaceDir: string;
  let taskService: TaskService;
  let bus: MessageBus;
  let outbound: string[];
  let edits: string[];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-task-tools-"));
    workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    taskService = new TaskService(workspaceDir);
    await taskService.ensureTasksFile();
    bus = new MessageBus();
    outbound = [];
    edits = [];

    bus.subscribeOutbound((event) => {
      outbound.push(String(event.message.content));
    });
    bus.subscribeEdit((event) => {
      edits.push(event.newContent);
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates jobs through the tool interface and posts a status message", async () => {
    const tools = createTaskTools(
      taskService,
      new TaskProgressNotifier(bus),
      { channel: "cli", userId: "user-1" },
    );

    const createJob = tools.find((tool) => tool.name === "create_job");
    const result = await createJob!.execute("tool-1", {
      title: "Ship release notes",
      goal: "Draft and publish release notes.",
      tasks: ["Draft notes", "Publish notes"],
    });

    const jobs = await taskService.listJobs("active");
    expect(result.details.job.id).toBe(jobs[0].id);
    expect(jobs[0].tasks).toHaveLength(2);
    expect(outbound[0]).toContain("Ship release notes [active]");
  });

  it("updates progress and archives jobs through the tool interface", async () => {
    const tools = createTaskTools(
      taskService,
      new TaskProgressNotifier(bus),
      { channel: "cli", userId: "user-1" },
    );

    const createJob = tools.find((tool) => tool.name === "create_job")!;
    await createJob.execute("tool-1", {
      title: "Close support loop",
      goal: "Follow up and close the request.",
      tasks: ["Send reply"],
    });
    const job = (await taskService.listJobs("active"))[0];

    const completeTask = tools.find((tool) => tool.name === "complete_task")!;
    await completeTask.execute("tool-2", {
      job_id: job.id,
      task_id: job.tasks[0].id,
    });
    expect(edits[0]).toContain("[x] Send reply");

    const archiveJob = tools.find((tool) => tool.name === "archive_job")!;
    await archiveJob.execute("tool-3", {
      job_id: job.id,
      outcome_summary: "Replied and closed the loop.",
    });

    expect(await taskService.listJobs("active")).toHaveLength(0);
    expect((await taskService.listJobs("archived"))[0].status).toBe("completed");
    expect(outbound[outbound.length - 1]).toContain("Finished job: Close support loop");
  });
});
