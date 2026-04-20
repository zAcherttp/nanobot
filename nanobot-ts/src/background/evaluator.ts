import { type AssistantMessage, complete, Type } from "@mariozechner/pi-ai";

import type { ResolvedAgentRuntimeConfig } from "../agent/loop.js";
import type { Logger } from "../utils/logging.js";

export interface BackgroundEvaluatorOptions {
	config: ResolvedAgentRuntimeConfig;
	taskContext: string;
	response: string;
	logger?: Logger;
}

export async function evaluateBackgroundResult(
	options: BackgroundEvaluatorOptions,
): Promise<boolean> {
	try {
		const message = await complete(
			options.config.model,
			{
				systemPrompt:
					"You decide whether a background task result should be delivered to the user. Always answer by calling the evaluate_notification tool.",
				messages: [
					{
						role: "user",
						content: `Task context:\n${options.taskContext}\n\nResult:\n${options.response}`,
						timestamp: Date.now(),
					},
				],
				tools: [BACKGROUND_EVALUATOR_TOOL],
			},
			{
				...(options.config.apiKey ? { apiKey: options.config.apiKey } : {}),
				maxTokens: 256,
				temperature: 0,
			},
		);

		const args = getToolCallArguments<{
			should_notify?: boolean;
			reason?: string;
		}>(message, "evaluate_notification");
		if (!args) {
			options.logger?.warn(
				"Background evaluator returned no tool call; defaulting to notify.",
			);
			return true;
		}

		const shouldNotify = args.should_notify ?? true;
		options.logger?.info("Background evaluator decision", {
			shouldNotify,
			reason: args.reason ?? "",
		});
		return Boolean(shouldNotify);
	} catch (error) {
		options.logger?.warn("Background evaluator failed; defaulting to notify.", {
			error,
		});
		return true;
	}
}

export function getToolCallArguments<T>(
	message: AssistantMessage,
	toolName: string,
): T | null {
	const toolCall = message.content.find(
		(block) => block.type === "toolCall" && block.name === toolName,
	);
	if (!toolCall) {
		return null;
	}
	if (toolCall.type !== "toolCall") {
		return null;
	}
	return toolCall.arguments as T;
}

const BACKGROUND_EVALUATOR_PARAMETERS = Type.Object({
	should_notify: Type.Boolean(),
	reason: Type.Optional(Type.String()),
});

const BACKGROUND_EVALUATOR_TOOL = {
	name: "evaluate_notification",
	description:
		"Decide whether the user should be notified about a background task result.",
	parameters: BACKGROUND_EVALUATOR_PARAMETERS,
};
