import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { GoalService } from "@/services/goals";
import type { CalendarService } from "@/services/calendar";
import type { TaskService } from "@/services/tasks";
import { TaskProgressNotifier } from "@/services/task_progress";

interface CalendarToolOptions {
  calendarService: CalendarService;
  taskService: TaskService;
  notifier: TaskProgressNotifier;
  goalService: GoalService;
  currentUserText: string;
  channel?: string;
  userId?: string;
}

interface ProposalMetadata {
  action: "gws.insert";
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
        const events = await options.calendarService.listEvents(start, end);
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
      name: "propose_gws_calendar_insert",
      label: "Propose GWS Calendar Insert",
      description:
        "Create a pending calendar proposal job without writing to Google Calendar.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        start: Type.String({ minLength: 1 }),
        end: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
        location: Type.Optional(Type.String()),
        related_goal_id: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params) => {
        const metadata: ProposalMetadata = {
          action: "gws.insert",
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
          title: `Confirm calendar event: ${params.title}`,
          goal: "Wait for explicit user confirmation before writing to Google Calendar.",
          tasks: [
            "Present the proposal to the user",
            "Wait for explicit confirmation",
            "Create the calendar event after confirmation",
          ],
          channelContext: {
            channel: options.channel,
            userId: options.userId,
          },
          kind: "calendar-proposal",
          metadata: metadata as Record<string, unknown>,
        });

        await options.notifier.announceJob(job);

        return {
          content: [
            {
              type: "text",
              text: `Created pending proposal ${job.id} for "${params.title}". Present the proposal and wait for explicit confirmation before calling execute_gws_calendar_insert.`,
            },
          ],
          details: { job, proposal: metadata },
        };
      },
    },
    {
      name: "execute_gws_calendar_insert",
      label: "Execute GWS Calendar Insert",
      description:
        "Execute a previously proposed Google Calendar event only after explicit user confirmation.",
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
        if (!job || job.status !== "active" || job.kind !== "calendar-proposal") {
          throw new Error(`Pending calendar proposal not found: ${params.job_id}`);
        }

        const metadata = job.metadata as ProposalMetadata | undefined;
        if (!metadata || metadata.action !== "gws.insert") {
          throw new Error(`Calendar proposal payload missing for ${params.job_id}`);
        }

        const eventId = await options.calendarService.createEvent({
          id: "",
          title: metadata.event.title,
          start: new Date(metadata.event.start),
          end: new Date(metadata.event.end),
          description: metadata.event.description,
          location: metadata.event.location,
        });

        const archived = await options.taskService.archiveJob(
          job.id,
          `Created Google Calendar event ${eventId}.`,
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
