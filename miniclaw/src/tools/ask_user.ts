import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { AskUserService } from "@/services/ask_user";

interface AskUserToolOptions {
  askUserService: AskUserService;
  threadId: string;
  channel?: string;
  userId?: string;
}

export function createAskUserTools(
  options: AskUserToolOptions,
): AgentTool<any, any>[] {
  return [
    {
      name: "ask_user",
      label: "Ask User",
      description:
        "Pause and ask the user a blocking question when their answer is required to continue. Use options for likely answers; the user's reply, typed or selected, is returned as the tool result.",
      parameters: Type.Object({
        question: Type.String({ minLength: 1 }),
        options: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      }),
      executionMode: "sequential",
      execute: async (toolCallId, params) => {
        const question = params.question.trim();
        const optionsList = Array.isArray(params.options)
          ? params.options
              .map((option: unknown) =>
                typeof option === "string" ? option.trim() : "",
              )
              .filter((option: string) => option.length > 0)
          : [];

        await options.askUserService.setPendingAsk(options.threadId, {
          toolCallId,
          question,
          options: optionsList,
          channel: options.channel,
          userId: options.userId,
          createdAt: new Date().toISOString(),
        });

        return {
          content: [{ type: "text", text: question }],
          details: {
            question,
            options: optionsList,
          },
          terminate: true,
        };
      },
    },
  ];
}
