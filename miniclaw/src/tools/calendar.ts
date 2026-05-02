import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { GoalService } from "@/services/goals";
import type { TaskService } from "@/services/tasks";
import { TaskProgressNotifier } from "@/services/task_progress";
import type { GwsCalendarService } from "@/services/calendar/gws";

interface CalendarToolOptions {
  gwsCalendar: GwsCalendarService;
  taskService: TaskService;
  notifier: TaskProgressNotifier;
  goalService: GoalService;
  currentUserText: string;
  channel?: string;
  userId?: string;
}

type SupportedPlanType = "gws_calendar_insert";

interface PlanMetadata {
  planType: SupportedPlanType;
  event: {
    title: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
  };
  relatedGoalId?: string;
}

export function createCalendarTools(
  options: CalendarToolOptions,
): AgentTool<any, any>[] {
  return [
    {
      name: "gws_calendar_agenda",
      label: "GWS Calendar Agenda",
      description: "Read upcoming Google Calendar events.",
      parameters: Type.Object({
        days: Type.Optional(Type.Number({ minimum: 1, maximum: 30 })),
      }),
      execute: async (_toolCallId, params) => {
        const days = params.days || 3;
        const start = new Date();
        const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
        const events = await options.gwsCalendar.listEvents(start, end);
        const text =
          events.length === 0
            ? `No events found in the next ${days} day(s).`
            : events
                .map(
                  (event) =>
                    `- ${event.title}: ${event.start.toISOString()} -> ${event.end.toISOString()}`,
                )
                .join("\n");

        return {
          content: [{ type: "text", text }],
          details: {
            range: {
              start: start.toISOString(),
              end: end.toISOString(),
            },
            events,
          },
        };
      },
    },
    {
      name: "propose_plan",
      label: "Propose Plan",
      description:
        "Create a pending execution plan that requires explicit confirmation before any external write. Currently supports gws_calendar_insert.",
      parameters: Type.Object({
        plan_type: Type.Literal("gws_calendar_insert"),
        title: Type.String({ minLength: 1 }),
        start: Type.String({ minLength: 1 }),
        end: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
        location: Type.Optional(Type.String()),
        related_goal_id: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params) => {
        const metadata: PlanMetadata = {
          planType: params.plan_type,
          event: {
            title: params.title,
            start: new Date(params.start).toISOString(),
            end: new Date(params.end).toISOString(),
            description: params.description?.trim() || undefined,
            location: params.location?.trim() || undefined,
          },
          relatedGoalId: params.related_goal_id?.trim() || undefined,
        };

        const job = await options.taskService.createJob({
          title: `Confirm plan: schedule "${params.title}"`,
          goal: "Wait for explicit user confirmation before executing the pending plan.",
          tasks: [
            "Present the proposal to the user",
            "Wait for explicit confirmation",
            "Execute the plan after confirmation",
          ],
          channelContext: {
            channel: options.channel,
            userId: options.userId,
          },
          kind: "pending-plan",
          metadata: metadata as Record<string, unknown>,
        });

        await options.notifier.announceJob(job);

        return {
          content: [
            {
              type: "text",
              text: `Created pending plan ${job.id} for "${params.title}". Present the proposal and wait for explicit confirmation before calling execute_plan.`,
            },
          ],
          details: { job, plan: metadata },
        };
      },
    },
    {
      name: "execute_plan",
      label: "Execute Plan",
      description:
        "Execute a previously proposed plan only after explicit user confirmation. Currently supports gws_calendar_insert.",
      parameters: Type.Object({
        job_id: Type.String(),
      }),
      execute: async (_toolCallId, params) => {
        if (!isExplicitConfirmation(options.currentUserText)) {
          throw new Error(
            "Explicit user confirmation is required before creating a calendar event.",
          );
        }

        const job = await options.taskService.getJob(params.job_id);
        if (!job || job.status !== "active" || job.kind !== "pending-plan") {
          throw new Error(`Pending plan not found: ${params.job_id}`);
        }

        const metadata = job.metadata as PlanMetadata | undefined;
        if (!metadata || metadata.planType !== "gws_calendar_insert") {
          throw new Error(
            `Plan payload missing or unsupported for ${params.job_id}`,
          );
        }

        const eventId = await options.gwsCalendar.createEvent({
          id: "",
          title: metadata.event.title,
          start: new Date(metadata.event.start),
          end: new Date(metadata.event.end),
          description: metadata.event.description,
          location: metadata.event.location,
        });

        const archived = await options.taskService.archiveJob(
          job.id,
          `Executed plan by creating Google Calendar event ${eventId}.`,
        );
        await options.notifier.closeJob(archived);

        if (metadata.relatedGoalId) {
          await options.goalService.recordProgress({
            goalId: metadata.relatedGoalId,
            summary: `Scheduled "${metadata.event.title}" on the calendar.`,
            source: "calendar-execution",
            linkedTaskId: job.id,
          });
        }

        return {
          content: [
            {
              type: "text",
              text: `Created Google Calendar event ${eventId} for "${metadata.event.title}".`,
            },
          ],
          details: { eventId, jobId: job.id },
        };
      },
    },
  ];
}

function isExplicitConfirmation(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return false;

  const patterns = [
    /\b(yes|yep|yeah|confirm|confirmed|go ahead|please do|schedule it|book it|do it)\b/,
    /\bproceed\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}
