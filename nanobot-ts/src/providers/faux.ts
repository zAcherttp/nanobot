import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	type FauxProviderRegistration,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Message,
	registerFauxProvider,
	Type,
} from "@mariozechner/pi-ai";

export const NANOBOT_FAUX_PROVIDER = "nanobot-faux";
export const NANOBOT_FAUX_MODEL_ID = "nanobot-faux-stream";
export const NANOBOT_FAUX_TOOL_NAME = "nanobot_faux_probe";

let fauxRegistration: FauxProviderRegistration | null = null;

export function isNanobotFauxProvider(provider: string): boolean {
	return provider === NANOBOT_FAUX_PROVIDER;
}

export function ensureNanobotFauxProvider(): FauxProviderRegistration {
	if (fauxRegistration) {
		primeNanobotFauxResponses(fauxRegistration);
		return fauxRegistration;
	}

	fauxRegistration = registerFauxProvider({
		provider: NANOBOT_FAUX_PROVIDER,
		models: [
			{
				id: NANOBOT_FAUX_MODEL_ID,
				name: "Nanobot Faux Stream",
				reasoning: false,
				input: ["text"],
			},
		],
		tokensPerSecond: 48,
		tokenSize: {
			min: 1,
			max: 2,
		},
	});

	primeNanobotFauxResponses(fauxRegistration);
	return fauxRegistration;
}

export function getNanobotFauxTools(): AgentTool[] {
	return [createNanobotFauxTool()];
}

function createNanobotFauxTool(): AgentTool {
	return {
		name: NANOBOT_FAUX_TOOL_NAME,
		label: "Nanobot Faux Probe",
		description:
			"Returns a deterministic tool result for faux provider testing.",
		parameters: Type.Object({
			prompt: Type.String(),
		}),
		execute: async (_toolCallId, params) => {
			const normalizedPrompt =
				(params as { prompt?: string }).prompt?.trim() || "empty prompt";
			return {
				content: [
					{
						type: "text",
						text: `faux tool result for: ${normalizedPrompt}`,
					},
				],
				details: {
					provider: NANOBOT_FAUX_PROVIDER,
					prompt: normalizedPrompt,
				},
			};
		},
	};
}

function createFauxResponse(context: { messages: Message[] }) {
	const latestMessage = context.messages.at(-1);
	if (latestMessage?.role === "toolResult") {
		return createFauxFollowupResponse(context);
	}

	return createFauxInitialResponse(context);
}

function createFauxInitialResponse(context: { messages: Message[] }) {
	const prompt = getLatestUserText(context.messages);
	return fauxAssistantMessage(
		[
			fauxText(`Faux stream start. Preparing a probe for: ${prompt}. `),
			fauxToolCall(
				NANOBOT_FAUX_TOOL_NAME,
				{
					prompt,
				},
				{
					id: "nanobot-faux-tool-1",
				},
			),
		],
		{
			stopReason: "toolUse",
		},
	);
}

function createFauxFollowupResponse(context: { messages: Message[] }) {
	const toolResult = getLatestToolResultText(context.messages);
	return fauxAssistantMessage(
		`Faux stream resumed after tool execution. ${toolResult}. Final faux answer complete.`,
		{
			stopReason: "stop",
		},
	);
}

function getLatestUserText(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") {
			continue;
		}

		return normalizeMessageText(message.content) || "empty prompt";
	}

	return "empty prompt";
}

function getLatestToolResultText(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "toolResult") {
			continue;
		}

		return (
			message.content
				.map((block) => {
					if (block.type === "text") {
						return block.text;
					}
					return "";
				})
				.join("")
				.trim() || "tool completed"
		);
	}

	return "tool completed";
}

function normalizeMessageText(
	content: string | readonly { type: string; text?: string }[],
): string {
	if (typeof content === "string") {
		return content.trim();
	}

	return content
		.map((block) => {
			if (block.type === "text") {
				return block.text ?? "";
			}
			return "";
		})
		.join("")
		.trim();
}

function primeNanobotFauxResponses(
	registration: FauxProviderRegistration,
	minimumPending = 32,
): void {
	const pendingCount = registration.getPendingResponseCount();
	if (pendingCount >= minimumPending) {
		return;
	}

	const stepsToAdd = minimumPending - pendingCount;
	registration.appendResponses(
		Array.from(
			{ length: stepsToAdd },
			() => createFauxResponse as FauxResponseStep,
		),
	);
}
