import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type {
  CreateJobInput,
  JobSection,
  TaskService,
  UpdateJobInput,
} from "@/services/tasks";
import { TaskProgressNotifier } from "@/services/task_progress";

export function createTaskTools(
  taskService: TaskService,
  notifier: TaskProgressNotifier,
  defaults: { channel?: string; userId?: string },
): AgentTool<any, any>[] {
  const taskListSchema = Type.Array(
    Type.String({ minLength: 1 }),
    { minItems: 1 },
  );

  return [
    {
      name: "list_jobs",
      label: "List Jobs",
      description: "List active or archived jobs from the global task ledger.",
      parameters: Type.Object({
        status: Type.Optional(
          Type.Union([Type.Literal("active"), Type.Literal("archived")]),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const jobs = await taskService.listJobs(params.status as JobSection | undefined);
        const text =
          jobs.length === 0
            ? "No jobs found."
            : jobs
                .map((job) => `${job.id} [${job.status}] ${job.title}`)
                .join("\n");

        return {
          content: [{ type: "text", text }],
          details: { jobs },
        };
      },
    },
    {
      name: "get_job",
      label: "Get Job",
      description: "Get a single job and its checklist.",
      parameters: Type.Object({
        job_id: Type.String(),
      }),
      execute: async (_toolCallId, params) => {
        const job = await taskService.getJob(params.job_id);
        if (!job) {
          throw new Error(`Job not found: ${params.job_id}`);
        }

        return {
          content: [{ type: "text", text: taskService.renderJobStatus(job) }],
          details: { job },
        };
      },
    },
    {
      name: "create_job",
      label: "Create Job",
      description:
        "Create a new active job for long-horizon or multi-hop work.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        goal: Type.String({ minLength: 1 }),
        tasks: taskListSchema,
      }),
      execute: async (_toolCallId, params) => {
        const input: CreateJobInput = {
          title: params.title,
          goal: params.goal,
          tasks: params.tasks,
          channelContext: {
            channel: defaults.channel,
            userId: defaults.userId,
          },
        };
        const job = await taskService.createJob(input);
        await notifier.announceJob(job);

        return {
          content: [{ type: "text", text: `Created job ${job.id}: ${job.title}` }],
          details: { job },
        };
      },
    },
    {
      name: "update_job",
      label: "Update Job",
      description: "Update a job title, goal, or replace its checklist.",
      parameters: Type.Object({
        job_id: Type.String(),
        title: Type.Optional(Type.String({ minLength: 1 })),
        goal: Type.Optional(Type.String({ minLength: 1 })),
        tasks: Type.Optional(taskListSchema),
      }),
      execute: async (_toolCallId, params) => {
        const updates: UpdateJobInput = {
          title: params.title,
          goal: params.goal,
          tasks: params.tasks,
        };
        const job = await taskService.updateJob(params.job_id, updates);
        await notifier.refreshJob(job);

        return {
          content: [{ type: "text", text: `Updated job ${job.id}.` }],
          details: { job },
        };
      },
    },
    {
      name: "complete_task",
      label: "Complete Task",
      description: "Mark one checklist item as completed.",
      parameters: Type.Object({
        job_id: Type.String(),
        task_id: Type.String(),
      }),
      execute: async (_toolCallId, params) => {
        const job = await taskService.completeTask(params.job_id, params.task_id);
        await notifier.refreshJob(job);

        return {
          content: [{ type: "text", text: `Completed task ${params.task_id}.` }],
          details: { job },
        };
      },
    },
    {
      name: "reopen_task",
      label: "Reopen Task",
      description: "Mark one checklist item as not done.",
      parameters: Type.Object({
        job_id: Type.String(),
        task_id: Type.String(),
      }),
      execute: async (_toolCallId, params) => {
        const job = await taskService.reopenTask(params.job_id, params.task_id);
        await notifier.refreshJob(job);

        return {
          content: [{ type: "text", text: `Reopened task ${params.task_id}.` }],
          details: { job },
        };
      },
    },
    {
      name: "archive_job",
      label: "Archive Job",
      description: "Archive a completed job with an optional outcome summary.",
      parameters: Type.Object({
        job_id: Type.String(),
        outcome_summary: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params) => {
        const job = await taskService.archiveJob(
          params.job_id,
          params.outcome_summary,
        );
        await notifier.closeJob(job);

        return {
          content: [{ type: "text", text: `Archived job ${job.id}.` }],
          details: { job },
        };
      },
    },
    {
      name: "cancel_job",
      label: "Cancel Job",
      description: "Cancel and archive an active job.",
      parameters: Type.Object({
        job_id: Type.String(),
        reason: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params) => {
        const job = await taskService.cancelJob(params.job_id, params.reason);
        await notifier.closeJob(job);

        return {
          content: [{ type: "text", text: `Cancelled job ${job.id}.` }],
          details: { job },
        };
      },
    },
  ];
}
