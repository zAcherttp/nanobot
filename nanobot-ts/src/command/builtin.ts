import type { OutboundChannelMessage } from "../channels/types.js";
import type { CommandContext, CommandRouter } from "./router.js";

export function buildHelpText(): string {
	return [
		"nanobot commands:",
		"/help - Show available commands",
		"/status - Show runtime status",
		"/new - Start a new conversation",
		"/stop - Stop the current task",
	].join("\n");
}

export function registerBuiltinCommands(router: CommandRouter): void {
	router.priority("/stop", handleStop);
	router.exact("/help", handleHelp);
	router.exact("/status", handleStatus);
	router.exact("/new", handleNew);
}

async function handleHelp(
	context: CommandContext,
): Promise<OutboundChannelMessage> {
	return createCommandReply(context, buildHelpText());
}

async function handleStatus(
	context: CommandContext,
): Promise<OutboundChannelMessage> {
	return createCommandReply(
		context,
		[
			"nanobot-ts status:",
			`Provider: ${context.runtime.provider}`,
			`Model: ${context.runtime.modelId}`,
			`Provider auth: ${context.runtime.providerAuthSource}`,
			`Session: ${context.key}`,
			`Messages: ${context.session?.messageCount ?? 0}`,
			`Channel: ${context.msg.channel}`,
			`Chat: ${context.msg.chatId}`,
		].join("\n"),
	);
}

async function handleNew(
	context: CommandContext,
): Promise<OutboundChannelMessage> {
	await context.clearSession();
	return createCommandReply(context, "New session started.");
}

async function handleStop(
	context: CommandContext,
): Promise<OutboundChannelMessage> {
	const stopped = await context.stopActiveTask();
	return createCommandReply(
		context,
		stopped ? "Stopped 1 task(s)." : "No active task to stop.",
	);
}

function createCommandReply(
	context: CommandContext,
	content: string,
): OutboundChannelMessage {
	return {
		channel: context.msg.channel,
		chatId: context.msg.chatId,
		content,
		role: "assistant",
		metadata: {
			...(context.msg.metadata ?? {}),
			render_as: "text",
		},
	};
}
