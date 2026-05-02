import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { GoalService, GoalSection, GoalStatus } from "@/services/goals";

export function createGoalTools(
  goalService: GoalService,
): AgentTool<any, any>[] {
  return [
    {
      name: "list_goals",
      label: "List Goals",
      description: "List active or archived user goals.",
      parameters: Type.Object({
        status: Type.Optional(
          Type.Union([Type.Literal("active"), Type.Literal("archived")]),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const goals = await goalService.listGoals(
          params.status as GoalSection | undefined,
        );
        const text =
          goals.length === 0
            ? "No goals found."
            : goals
                .map((goal) => `${goal.id} [${goal.status}] ${goal.title}`)
                .join("\n");

        return {
          content: [{ type: "text", text }],
          details: { goals },
        };
      },
    },
    {
      name: "get_goal",
      label: "Get Goal",
      description: "Get one goal with rationale and progress.",
      parameters: Type.Object({
        goal_id: Type.String(),
      }),
      execute: async (_toolCallId, params) => {
        const goal = await goalService.getGoal(params.goal_id);
        if (!goal) {
          throw new Error(`Goal not found: ${params.goal_id}`);
        }

        const text = [
          `${goal.title} [${goal.status}]`,
          `Rationale: ${goal.rationale}`,
          goal.deadline ? `Deadline: ${goal.deadline}` : "",
          goal.timeHorizon ? `Horizon: ${goal.timeHorizon}` : "",
          goal.progress.length > 0
            ? `Latest progress: ${goal.progress[goal.progress.length - 1].summary}`
            : "Latest progress: none",
        ]
          .filter(Boolean)
          .join("\n");

        return {
          content: [{ type: "text", text }],
          details: { goal },
        };
      },
    },
    {
      name: "add_goal",
      label: "Add Goal",
      description:
        "Add a new user goal only when the user explicitly states it.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        rationale: Type.String({ minLength: 1 }),
        deadline: Type.Optional(Type.String()),
        time_horizon: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params) => {
        const goal = await goalService.addGoal({
          title: params.title,
          rationale: params.rationale,
          deadline: params.deadline,
          timeHorizon: params.time_horizon,
        });

        return {
          content: [
            { type: "text", text: `Added goal ${goal.id}: ${goal.title}` },
          ],
          details: { goal },
        };
      },
    },
    {
      name: "record_goal_progress",
      label: "Record Goal Progress",
      description: "Record progress or evidence for an existing user goal.",
      parameters: Type.Object({
        goal_id: Type.String(),
        summary: Type.String({ minLength: 1 }),
        source: Type.Optional(Type.String()),
        linked_task_id: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params) => {
        const goal = await goalService.recordProgress({
          goalId: params.goal_id,
          summary: params.summary,
          source: params.source,
          linkedTaskId: params.linked_task_id,
        });

        return {
          content: [
            { type: "text", text: `Recorded progress for ${goal.title}.` },
          ],
          details: { goal },
        };
      },
    },
    {
      name: "update_goal_status",
      label: "Update Goal Status",
      description: "Update the status of a user goal.",
      parameters: Type.Object({
        goal_id: Type.String(),
        status: Type.Union([
          Type.Literal("active"),
          Type.Literal("on-track"),
          Type.Literal("at-risk"),
          Type.Literal("stalled"),
          Type.Literal("completed"),
          Type.Literal("cancelled"),
        ]),
      }),
      execute: async (_toolCallId, params) => {
        const goal = await goalService.updateStatus(
          params.goal_id,
          params.status as GoalStatus,
        );

        return {
          content: [
            {
              type: "text",
              text: `Updated goal ${goal.id} to ${goal.status}.`,
            },
          ],
          details: { goal },
        };
      },
    },
  ];
}
