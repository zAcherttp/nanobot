import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "@mariozechner/pi-ai";

import type { SessionRecord } from "./session-store.js";

export interface SessionPersistenceOptions {
	maxMessages: number;
	maxPersistedTextChars: number;
}

export interface SessionPersistenceStats {
	lastSanitizedAt: string;
	lastSavedMessageCount: number;
}

export interface SessionRuntimeCheckpointPendingToolCall {
	id: string;
	name: string;
}

export interface SessionRuntimeCheckpoint {
	assistantMessage?: AssistantMessage;
	completedToolResults: ToolResultMessage[];
	pendingToolCalls: SessionRuntimeCheckpointPendingToolCall[];
	updatedAt: string;
}

export interface SessionMetadata extends Record<string, unknown> {
	runtimeCheckpoint?: SessionRuntimeCheckpoint;
	persistence?: SessionPersistenceStats;
}

export function sanitizeMessagesForPersistence(
	messages: readonly Message[],
	options: SessionPersistenceOptions,
): Message[] {
	const filtered = messages
		.flatMap((message) => {
			if (
				message.role === "assistant" &&
				(message.stopReason === "error" || message.stopReason === "aborted")
			) {
				return [];
			}

			const truncated = truncatePersistedMessage(
				structuredClone(message),
				options.maxPersistedTextChars,
			);
			if (!truncated) {
				return [];
			}

			if (truncated.role === "assistant" && truncated.content.length === 0) {
				return [];
			}

			return [truncated];
		})
		.filter(Boolean);

	const retained = retainRecentLegalSuffix(filtered, options.maxMessages);
	const legalStart = findLegalMessageStart(retained);
	return retained.slice(legalStart);
}

export function findLegalMessageStart(messages: readonly Message[]): number {
	const declared = new Set<string>();
	let start = 0;

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) {
			continue;
		}
		if (message.role === "assistant") {
			for (const toolCall of getAssistantToolCalls(message)) {
				declared.add(toolCall.id);
			}
			continue;
		}

		if (message.role !== "toolResult") {
			continue;
		}

		if (!declared.has(message.toolCallId)) {
			start = index + 1;
			declared.clear();
			for (const previous of messages.slice(start, index + 1)) {
				if (previous.role !== "assistant") {
					continue;
				}

				for (const toolCall of getAssistantToolCalls(previous)) {
					declared.add(toolCall.id);
				}
			}
		}
	}

	return start;
}

export function retainRecentLegalSuffix(
	messages: readonly Message[],
	maxMessages: number,
): Message[] {
	if (maxMessages <= 0) {
		return [];
	}

	if (messages.length <= maxMessages) {
		return [...messages];
	}

	let startIndex = Math.max(0, messages.length - maxMessages);
	while (startIndex > 0 && messages[startIndex]?.role !== "user") {
		startIndex -= 1;
	}

	const retained = messages.slice(startIndex);
	return retained.slice(findLegalMessageStart(retained));
}

export function buildPersistenceMetadata(
	metadata: SessionMetadata | Record<string, unknown> | undefined,
	lastSavedMessageCount: number,
): SessionMetadata {
	return {
		...(metadata ?? {}),
		persistence: {
			lastSanitizedAt: new Date().toISOString(),
			lastSavedMessageCount,
		},
	};
}

export function stripRuntimeCheckpoint(
	metadata: SessionMetadata | Record<string, unknown> | undefined,
): SessionMetadata {
	const nextMetadata: SessionMetadata = {
		...(metadata ?? {}),
	};
	delete nextMetadata.runtimeCheckpoint;
	return nextMetadata;
}

export function hasRuntimeCheckpoint(
	checkpoint: SessionRuntimeCheckpoint | undefined,
): checkpoint is SessionRuntimeCheckpoint {
	if (!checkpoint) {
		return false;
	}

	return Boolean(
		checkpoint.assistantMessage ||
			checkpoint.completedToolResults.length > 0 ||
			checkpoint.pendingToolCalls.length > 0,
	);
}

export function createRuntimeCheckpoint(
	assistantMessage: AssistantMessage | undefined,
	completedToolResults: readonly ToolResultMessage[],
): SessionRuntimeCheckpoint | undefined {
	const pendingToolCalls = derivePendingToolCalls(
		assistantMessage,
		completedToolResults,
	);
	const checkpoint: SessionRuntimeCheckpoint = {
		...(assistantMessage ? { assistantMessage } : {}),
		completedToolResults: completedToolResults.map((message) =>
			structuredClone(message),
		),
		pendingToolCalls,
		updatedAt: new Date().toISOString(),
	};

	return hasRuntimeCheckpoint(checkpoint) ? checkpoint : undefined;
}

export function restoreRuntimeCheckpoint(session: SessionRecord): {
	session: SessionRecord;
	restored: boolean;
} {
	const metadata = session.metadata as SessionMetadata;
	const checkpoint = metadata.runtimeCheckpoint;
	if (!hasRuntimeCheckpoint(checkpoint)) {
		return { session, restored: false };
	}

	const restoredMessages: Message[] = [];
	if (checkpoint.assistantMessage) {
		restoredMessages.push(structuredClone(checkpoint.assistantMessage));
	}

	for (const toolResult of checkpoint.completedToolResults) {
		restoredMessages.push(structuredClone(toolResult));
	}

	for (const pendingToolCall of checkpoint.pendingToolCalls) {
		restoredMessages.push({
			role: "toolResult",
			toolCallId: pendingToolCall.id,
			toolName: pendingToolCall.name,
			content: [
				{
					type: "text",
					text: "Error: Task interrupted before this tool finished.",
				},
			],
			details: {},
			isError: true,
			timestamp: Date.now(),
		});
	}

	const overlap = findCheckpointOverlap(session.messages, restoredMessages);
	return {
		session: {
			...session,
			updatedAt: new Date().toISOString(),
			messages: [...session.messages, ...restoredMessages.slice(overlap)],
			metadata: stripRuntimeCheckpoint(metadata),
		},
		restored: true,
	};
}

function truncatePersistedMessage(
	message: Message,
	maxPersistedTextChars: number,
): Message | null {
	if (message.role === "user") {
		return {
			...message,
			content: truncateUserContent(message.content, maxPersistedTextChars),
		};
	}

	if (message.role === "assistant") {
		return {
			...message,
			content: message.content.map((block) => {
				if (block.type === "text") {
					return {
						...block,
						text: truncateText(block.text, maxPersistedTextChars),
					} satisfies TextContent;
				}
				if (block.type === "thinking") {
					return {
						...block,
						thinking: truncateText(block.thinking, maxPersistedTextChars),
					} satisfies ThinkingContent;
				}
				return block;
			}),
		};
	}

	return {
		...message,
		content: truncateToolResultContent(message.content, maxPersistedTextChars),
	};
}

function truncateUserContent(
	content: string | (TextContent | ImageContent)[],
	maxPersistedTextChars: number,
): string | (TextContent | ImageContent)[] {
	if (typeof content === "string") {
		return truncateText(content, maxPersistedTextChars);
	}

	return content.map((block) => {
		if (block.type !== "text") {
			return block;
		}
		return {
			...block,
			text: truncateText(block.text, maxPersistedTextChars),
		};
	});
}

function truncateToolResultContent(
	content: ToolResultMessage["content"],
	maxPersistedTextChars: number,
): ToolResultMessage["content"] {
	return content.map((block) => {
		if (block.type !== "text") {
			return block;
		}
		return {
			...block,
			text: truncateText(block.text, maxPersistedTextChars),
		};
	});
}

function truncateText(text: string, maxPersistedTextChars: number): string {
	if (text.length <= maxPersistedTextChars) {
		return text;
	}

	if (maxPersistedTextChars <= 3) {
		return text.slice(0, maxPersistedTextChars);
	}

	return `${text.slice(0, maxPersistedTextChars - 3)}...`;
}

function getAssistantToolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter(
		(block): block is ToolCall => block.type === "toolCall",
	);
}

function derivePendingToolCalls(
	assistantMessage: AssistantMessage | undefined,
	completedToolResults: readonly ToolResultMessage[],
): SessionRuntimeCheckpointPendingToolCall[] {
	if (!assistantMessage) {
		return [];
	}

	const completed = new Set(
		completedToolResults.map((toolResult) => toolResult.toolCallId),
	);
	return getAssistantToolCalls(assistantMessage)
		.filter((toolCall) => !completed.has(toolCall.id))
		.map((toolCall) => ({
			id: toolCall.id,
			name: toolCall.name,
		}));
}

function findCheckpointOverlap(
	existingMessages: readonly Message[],
	restoredMessages: readonly Message[],
): number {
	const maxOverlap = Math.min(existingMessages.length, restoredMessages.length);
	for (let size = maxOverlap; size > 0; size -= 1) {
		const existing = existingMessages.slice(-size);
		const restored = restoredMessages.slice(0, size);
		if (
			existing.every((message, index) => {
				const restoredMessage = restored[index];
				if (!restoredMessage) {
					return false;
				}
				return (
					getMessageCheckpointKey(message) ===
					getMessageCheckpointKey(restoredMessage)
				);
			})
		) {
			return size;
		}
	}

	return 0;
}

function getMessageCheckpointKey(message: Message): string {
	switch (message.role) {
		case "user":
			return JSON.stringify({
				role: message.role,
				content: message.content,
			});
		case "assistant":
			return JSON.stringify({
				role: message.role,
				content: message.content,
				stopReason: message.stopReason,
				model: message.model,
				provider: message.provider,
			});
		case "toolResult":
			return JSON.stringify({
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content,
				isError: message.isError,
			});
	}
}
