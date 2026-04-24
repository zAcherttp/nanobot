import path from "node:path";

import {
	Agent,
	type AgentOptions,
	type AgentTool,
	type StreamFn,
	type ThinkingLevel,
	type ToolExecutionMode,
} from "@mariozechner/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	streamSimple,
	type ToolResultMessage,
	type Transport,
} from "@mariozechner/pi-ai";

import type { AppConfig } from "../config/schema.js";
import { MemoryStore } from "../memory/index.js";
import {
	providerRequiresApiKey,
	resolveProviderModel,
} from "../providers/runtime.js";
import type { Logger } from "../utils/logging.js";
import { AutoCompactor } from "./auto-compact.js";
import { Consolidator, normalizeLastConsolidated } from "./consolidator.js";
import { buildSystemPrompt } from "./prompt.js";
import {
	createRuntimeCheckpoint,
	restoreRuntimeCheckpoint,
	type SessionMetadata,
	type SessionRuntimeCheckpoint,
	sanitizeMessagesForPersistence,
	stripRuntimeCheckpoint,
} from "./session-persistence.js";
import {
	FileSessionStore,
	type SessionRecord,
	type SessionStore,
} from "./session-store.js";

export interface ResolvedAgentRuntimeConfig {
	provider: AppConfig["agent"]["provider"];
	modelId: string;
	model: Model<Api>;
	apiKey?: string;
	providerAuthSource: "config" | "env" | "none";
	workspacePath: string;
	skills: string[];
	contextWindowTokens: number;
	idleCompactAfterMinutes: number;
	thinkingLevel: ThinkingLevel;
	temperature: number;
	maxTokens: number;
	toolExecution: ToolExecutionMode;
	transport: Transport;
	maxRetryDelayMs: number;
	sessionStore: AppConfig["agent"]["sessionStore"] & {
		path: string;
	};
}

export interface CreateSessionAgentOptions {
	config: ResolvedAgentRuntimeConfig;
	sessionKey?: string;
	sessionStore?: SessionStore;
	channel?: string;
	tools?: AgentTool[];
	transformContext?: AgentOptions["transformContext"];
	convertToLlm?: AgentOptions["convertToLlm"];
	beforeToolCall?: AgentOptions["beforeToolCall"];
	afterToolCall?: AgentOptions["afterToolCall"];
	getApiKey?: AgentOptions["getApiKey"];
	streamFn?: StreamFn;
	onPayload?: AgentOptions["onPayload"];
	thinkingBudgets?: AgentOptions["thinkingBudgets"];
	consolidator?: Consolidator;
	autoCompactor?: AutoCompactor;
	logger?: Logger;
}

export const DEFAULT_SESSION_KEY = "sdk:default";

export function resolveAgentRuntimeConfig(
	config: AppConfig,
): ResolvedAgentRuntimeConfig {
	const { model, providerConfig } = resolveProviderModel(
		config,
		config.agent.provider,
		config.agent.modelId,
	);
	return {
		provider: config.agent.provider,
		modelId: config.agent.modelId,
		model,
		...(providerConfig.apiKey ? { apiKey: providerConfig.apiKey } : {}),
		providerAuthSource: providerConfig.apiKeySource,
		workspacePath: config.workspace.path,
		skills: config.agent.skills,
		contextWindowTokens: config.agent.contextWindowTokens,
		idleCompactAfterMinutes: config.agent.idleCompactAfterMinutes,
		thinkingLevel: config.agent.thinkingLevel,
		temperature: config.agent.temperature,
		maxTokens: config.agent.maxTokens,
		toolExecution: config.agent.toolExecution,
		transport: config.agent.transport,
		maxRetryDelayMs: config.agent.maxRetryDelayMs,
		sessionStore: {
			...config.agent.sessionStore,
			path: config.agent.sessionStore.path,
		},
	};
}

export async function createSessionAgent(
	options: CreateSessionAgentOptions,
): Promise<Agent> {
	const sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
	const sessionStore =
		options.sessionStore ??
		new FileSessionStore(options.config.sessionStore.path, {
			maxMessages: options.config.sessionStore.maxMessages,
			maxPersistedTextChars: options.config.sessionStore.maxPersistedTextChars,
			quarantineCorruptFiles:
				options.config.sessionStore.quarantineCorruptFiles,
		});
	let persistedSession =
		(await sessionStore.load(sessionKey)) ??
		createEmptySessionRecord(sessionKey);
	let createdAt = persistedSession.createdAt;
	let sessionMetadata = stripRuntimeCheckpoint(
		persistedSession.metadata as SessionMetadata,
	);
	let currentCheckpoint: SessionRuntimeCheckpoint | undefined;
	let pendingSummaryContext: string | undefined;
	let persistedMessages = sanitizeMessagesForPersistence(
		persistedSession.messages,
		{
			maxMessages: options.config.sessionStore.maxMessages,
			maxPersistedTextChars: options.config.sessionStore.maxPersistedTextChars,
		},
	);
	const streamFn = withRuntimeDefaults(
		options.streamFn ?? streamSimple,
		options.config,
	);
	const consolidator =
		options.consolidator ??
		createRuntimeConsolidator({
			config: options.config,
			sessionStore,
			getTools: async () => options.tools ?? [],
			...(options.logger ? { logger: options.logger } : {}),
		});
	const autoCompactor =
		options.autoCompactor ??
		createRuntimeAutoCompactor({
			config: options.config,
			sessionStore,
			consolidator,
			...(options.logger ? { logger: options.logger } : {}),
		});
	const systemPrompt = await buildSystemPrompt({
		workspacePath: options.config.workspacePath,
		selectedSkills: options.config.skills,
		...(options.channel ? { channel: options.channel } : {}),
	});
	if (
		!options.getApiKey &&
		!options.config.apiKey &&
		providerRequiresApiKey(options.config.provider)
	) {
		throw new Error(
			`Missing API key for provider '${options.config.provider}'. Configure providers.${options.config.provider}.apiKey or set the provider environment variable.`,
		);
	}

	const agentOptions: AgentOptions = {
		initialState: {
			systemPrompt,
			model: options.config.model,
			thinkingLevel: options.config.thinkingLevel,
			tools: options.tools ?? [],
			messages: persistedMessages,
		},
		streamFn,
		sessionId: sessionKey,
		transport: options.config.transport,
		maxRetryDelayMs: options.config.maxRetryDelayMs,
		toolExecution: options.config.toolExecution,
		...(options.convertToLlm ? { convertToLlm: options.convertToLlm } : {}),
		transformContext: async (messages, signal) => {
			const start = normalizeLastConsolidated(
				persistedSession.lastConsolidated,
				messages.length,
			);
			const visibleMessages = messages
				.slice(start)
				.map((message) => structuredClone(message));
			const contextMessages = pendingSummaryContext
				? [
						{
							role: "user" as const,
							content: `## Previous idle-session summary\n${pendingSummaryContext}`,
							timestamp: Date.now(),
						},
						...visibleMessages,
					]
				: visibleMessages;
			if (!options.transformContext) {
				return contextMessages;
			}
			return options.transformContext(contextMessages, signal);
		},
		...(options.getApiKey || options.config.apiKey
			? {
					getApiKey:
						options.getApiKey ?? ((_provider: string) => options.config.apiKey),
				}
			: {}),
		...(options.onPayload ? { onPayload: options.onPayload } : {}),
		...(options.beforeToolCall
			? { beforeToolCall: options.beforeToolCall }
			: {}),
		...(options.afterToolCall ? { afterToolCall: options.afterToolCall } : {}),
		...(options.thinkingBudgets
			? { thinkingBudgets: options.thinkingBudgets }
			: {}),
	};

	const agent = new Agent(agentOptions);

	await prepareSessionForExecution();

	agent.subscribe(async (event) => {
		if (event.type === "message_update" || event.type === "message_end") {
			const assistantMessage = resolveLatestAssistantMessage(
				event.type === "message_update" ? event.message : event.message,
				agent.state.messages,
			);
			if (assistantMessage) {
				currentCheckpoint = createRuntimeCheckpoint(
					assistantMessage,
					getCompletedToolResults(agent.state.messages),
				);
				await persistCheckpoint();
			}
		}

		if (event.type === "message_end" && event.message.role === "toolResult") {
			currentCheckpoint = createRuntimeCheckpoint(
				getLatestAssistantMessage(agent.state.messages),
				getCompletedToolResults(agent.state.messages),
			);
			await persistCheckpoint();
		}

		if (event.type !== "agent_end") {
			return;
		}

		const latestAssistant = getLatestAssistantMessage(agent.state.messages);
		if (
			latestAssistant &&
			(latestAssistant.stopReason === "error" ||
				latestAssistant.stopReason === "aborted")
		) {
			await persistCheckpoint();
			return;
		}

		currentCheckpoint = undefined;
		persistedMessages = sanitizeMessagesForPersistence(agent.state.messages, {
			maxMessages: options.config.sessionStore.maxMessages,
			maxPersistedTextChars: options.config.sessionStore.maxPersistedTextChars,
		});
		await sessionStore.save({
			key: sessionKey,
			createdAt,
			updatedAt: new Date().toISOString(),
			lastConsolidated: persistedSession.lastConsolidated,
			messages: persistedMessages,
			metadata: sessionMetadata,
		});
		try {
			const consolidated = await consolidator.maybeConsolidateByTokens(
				sessionKey,
				options.channel,
			);
			if (consolidated) {
				persistedSession = consolidated;
			}
		} catch (error) {
			options.logger?.warn("Token consolidation failed after agent turn", {
				component: "consolidator",
				event: "token_error",
				sessionKey,
				channel: options.channel,
				error,
			});
			// Consolidation failures should not break a completed agent turn.
		}
	});

	const originalPrompt = agent.prompt.bind(agent);
	(agent.prompt as typeof agent.prompt) = (async (
		...args: Parameters<Agent["prompt"]>
	) => {
		await prepareSessionForExecution();
		try {
			return await originalPrompt(...args);
		} finally {
			pendingSummaryContext = undefined;
		}
	}) as Agent["prompt"];

	const originalContinue = agent.continue.bind(agent);
	(agent.continue as typeof agent.continue) = (async () => {
		await prepareSessionForExecution();
		try {
			return await originalContinue();
		} finally {
			pendingSummaryContext = undefined;
		}
	}) as Agent["continue"];

	return agent;

	async function prepareSessionForExecution(): Promise<void> {
		const prepared = await autoCompactor.prepareSession(sessionKey);
		const loaded =
			prepared?.session ??
			(await sessionStore.load(sessionKey)) ??
			createEmptySessionRecord(sessionKey, createdAt);
		if (prepared?.summaryContext) {
			pendingSummaryContext = prepared.summaryContext;
			options.logger?.debug("Idle session summary context restored", {
				component: "session",
				event: "summary_restore",
				sessionKey,
				contentPreview: prepared.summaryContext,
			});
		}
		createdAt = loaded.createdAt;
		const restored = restoreRuntimeCheckpoint(loaded);
		persistedSession = restored.session;
		sessionMetadata = stripRuntimeCheckpoint(
			persistedSession.metadata as SessionMetadata,
		);
		persistedMessages = sanitizeMessagesForPersistence(
			persistedSession.messages,
			{
				maxMessages: options.config.sessionStore.maxMessages,
				maxPersistedTextChars:
					options.config.sessionStore.maxPersistedTextChars,
			},
		);
		currentCheckpoint = undefined;
		if (restored.restored) {
			await sessionStore.save({
				...persistedSession,
				messages: persistedMessages,
				metadata: sessionMetadata,
			});
			options.logger?.info("Session runtime checkpoint restored", {
				component: "session",
				event: "checkpoint_restore",
				sessionKey,
				messageCount: persistedMessages.length,
			});
		}
		agent.state.messages = structuredClone(persistedMessages);
	}

	async function persistCheckpoint(): Promise<void> {
		if (!currentCheckpoint) {
			return;
		}

		await sessionStore.save({
			key: sessionKey,
			createdAt,
			updatedAt: new Date().toISOString(),
			lastConsolidated: persistedSession.lastConsolidated,
			messages: persistedMessages,
			metadata: {
				...sessionMetadata,
				runtimeCheckpoint: currentCheckpoint,
			},
		});
		options.logger?.debug("Session runtime checkpoint saved", {
			component: "session",
			event: "checkpoint_save",
			sessionKey,
			completedToolResults: currentCheckpoint.completedToolResults.length,
			pendingToolCalls: currentCheckpoint.pendingToolCalls.length,
		});
	}
}

export function createRuntimeConsolidator(options: {
	config: ResolvedAgentRuntimeConfig;
	sessionStore: SessionStore;
	getTools?: () => AgentTool[] | Promise<AgentTool[]>;
	logger?: Logger;
}): Consolidator {
	return new Consolidator({
		memoryStore: new MemoryStore(options.config.workspacePath),
		sessionStore: options.sessionStore,
		config: options.config,
		buildSystemPrompt,
		...(options.getTools ? { getTools: options.getTools } : {}),
		...(options.logger ? { logger: options.logger } : {}),
	});
}

export function createRuntimeAutoCompactor(options: {
	config: ResolvedAgentRuntimeConfig;
	sessionStore: SessionStore;
	consolidator: Consolidator;
	isSessionActive?: (sessionKey: string) => boolean | Promise<boolean>;
	logger?: Logger;
}): AutoCompactor {
	return new AutoCompactor({
		sessionStore: options.sessionStore,
		consolidator: options.consolidator,
		idleCompactAfterMinutes: options.config.idleCompactAfterMinutes,
		...(options.isSessionActive
			? { isSessionActive: options.isSessionActive }
			: {}),
		...(options.logger ? { logger: options.logger } : {}),
	});
}

export function getLatestAssistantMessage(
	messages: readonly Message[],
): Extract<Message, { role: "assistant" }> | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

export function getLatestAssistantText(messages: readonly Message[]): string {
	const latest = getLatestAssistantMessage(messages);
	if (!latest) {
		return "";
	}

	return latest.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export function resolveSessionStorePath(
	workspacePath: string,
	sessionStorePath: string,
): string {
	return path.isAbsolute(sessionStorePath)
		? sessionStorePath
		: path.resolve(workspacePath, sessionStorePath);
}

export function createSessionRecord(
	key: string,
	messages: readonly Message[],
	createdAt = new Date().toISOString(),
): SessionRecord {
	return {
		key,
		createdAt,
		updatedAt: new Date().toISOString(),
		lastConsolidated: 0,
		metadata: {},
		messages: [...messages].map((message) => structuredClone(message)),
	};
}

function withRuntimeDefaults(
	baseStreamFn: StreamFn,
	config: ResolvedAgentRuntimeConfig,
): StreamFn {
	return (model, context, options) =>
		baseStreamFn(model, context, {
			...options,
			temperature: config.temperature,
			maxTokens: config.maxTokens,
			transport: options?.transport ?? config.transport,
			maxRetryDelayMs: options?.maxRetryDelayMs ?? config.maxRetryDelayMs,
		});
}

function createEmptySessionRecord(
	key: string,
	createdAt = new Date().toISOString(),
): SessionRecord {
	return {
		key,
		createdAt,
		updatedAt: createdAt,
		lastConsolidated: 0,
		metadata: {},
		messages: [],
	};
}

function resolveLatestAssistantMessage(
	candidate: Message | undefined,
	messages: readonly Message[],
): AssistantMessage | undefined {
	if (candidate?.role === "assistant") {
		return candidate;
	}
	return getLatestAssistantMessage(messages);
}

function getCompletedToolResults(
	messages: readonly Message[],
): ToolResultMessage[] {
	return messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult",
	);
}
