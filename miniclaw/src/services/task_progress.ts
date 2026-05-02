import type { MessageBus } from "@/bus/index";
import type { TaskJob } from "./tasks";

export class TaskProgressNotifier {
  constructor(private readonly bus: MessageBus) {}

  public async announceJob(job: TaskJob): Promise<void> {
    if (!job.channel || !job.userId) return;

    this.bus.publishOutbound({
      message: {
        role: "assistant",
        content: renderJobProgress(job),
        timestamp: Date.now(),
      },
      channel: job.channel,
      userId: job.userId,
      trackingKey: job.trackingKey,
    });
  }

  public async refreshJob(job: TaskJob): Promise<void> {
    if (!job.channel || !job.userId) return;

    this.bus.publishEdit({
      trackingKey: job.trackingKey,
      newContent: renderJobProgress(job),
      channel: job.channel,
      userId: job.userId,
    });
  }

  public async closeJob(job: TaskJob): Promise<void> {
    if (!job.channel || !job.userId) return;

    await this.refreshJob(job);
    this.bus.publishOutbound({
      message: {
        role: "assistant",
        content:
          job.status === "completed"
            ? `Finished job: ${job.title}`
            : `Cancelled job: ${job.title}`,
        timestamp: Date.now(),
      },
      channel: job.channel,
      userId: job.userId,
    });
  }
}

function renderJobProgress(job: TaskJob): string {
  const header = `${job.title} [${job.status}]`;
  const goal = `Goal: ${job.goal}`;
  const checklist = job.tasks.map(
    (task) => `${task.done ? "[x]" : "[ ]"} ${task.title}`,
  );
  const tail =
    job.status === "completed"
      ? `Outcome: ${job.outcomeSummary || "Completed."}`
      : job.status === "cancelled"
        ? `Cancelled: ${job.cancelReason || "No reason provided."}`
        : "";

  return [header, goal, ...checklist, tail].filter(Boolean).join("\n");
}
