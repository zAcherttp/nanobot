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
	getEnvApiKey,
	getModel,
	getModels,
	type Message,
	type Model,
	streamSimple,
	type Transport,
} from "@mariozechner/pi-ai";

import type { AppConfig } from "../config/schema.js";
import {
	FileSessionStore,
	type SessionRecord,
	type SessionStore,
} from "./session-store.js";

export interface ResolvedAgentRuntimeConfig {
	provider: AppConfig["agent"]["provider"];
	modelId: string;
	model: Model<Api>;
	systemPrompt: string;
	thinkingLevel: ThinkingLevel;
	temperature: number;
	maxTokens: number;
	toolExecution: ToolExecutionMode;
	transport: Transport;
	maxRetryDelayMs: number;
	sessionStorePath: string;
}

export interface CreateSessionAgentOptions {
	config: ResolvedAgentRuntimeConfig;
	sessionKey?: string;
	sessionStore?: SessionStore;
	tools?: AgentTool[];
	transformContext?: AgentOptions["transformContext"];
	convertToLlm?: AgentOptions["convertToLlm"];
	beforeToolCall?: AgentOptions["beforeToolCall"];
	afterToolCall?: AgentOptions["afterToolCall"];
	getApiKey?: AgentOptions["getApiKey"];
	streamFn?: StreamFn;
	onPayload?: AgentOptions["onPayload"];
	thinkingBudgets?: AgentOptions["thinkingBudgets"];
}

export const DEFAULT_SESSION_KEY = "sdk:default";

export function resolveAgentRuntimeConfig(
	config: AppConfig,
): ResolvedAgentRuntimeConfig {
	const model = resolveModel(config.agent.provider, config.agent.modelId);
	return {
		provider: config.agent.provider,
		modelId: config.agent.modelId,
		model,
		systemPrompt: config.agent.systemPrompt,
		thinkingLevel: config.agent.thinkingLevel,
		temperature: config.agent.temperature,
		maxTokens: config.agent.maxTokens,
		toolExecution: config.agent.toolExecution,
		transport: config.agent.transport,
		maxRetryDelayMs: config.agent.maxRetryDelayMs,
		sessionStorePath: config.agent.sessionStore.path,
	};
}

export async function createSessionAgent(
	options: CreateSessionAgentOptions,
): Promise<Agent> {
	const sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
	const sessionStore =
		options.sessionStore ??
		new FileSessionStore(options.config.sessionStorePath);
	const existingSession = await sessionStore.load(sessionKey);
	const initialMessages = sanitizeMessagesForPersistence(
		existingSession?.messages ?? [],
	);
	const createdAt = existingSession?.createdAt ?? new Date().toISOString();
	const streamFn = withRuntimeDefaults(
		options.streamFn ?? streamSimple,
		options.config,
	);

	const agentOptions: AgentOptions = {
		initialState: {
			systemPrompt: options.config.systemPrompt,
			model: options.config.model,
			thinkingLevel: options.config.thinkingLevel,
			tools: options.tools ?? [],
			messages: initialMessages,
		},
		streamFn,
		sessionId: sessionKey,
		transport: options.config.transport,
		maxRetryDelayMs: options.config.maxRetryDelayMs,
		toolExecution: options.config.toolExecution,
		...(options.convertToLlm ? { convertToLlm: options.convertToLlm } : {}),
		...(options.transformContext
			? { transformContext: options.transformContext }
			: {}),
		...((options.getApiKey ??
		((provider: string) =>
			getEnvApiKey(provider as AppConfig["agent"]["provider"])))
			? {
					getApiKey:
						options.getApiKey ??
						((provider: string) =>
							getEnvApiKey(provider as AppConfig["agent"]["provider"])),
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

	agent.subscribe(async (event) => {
		if (event.type !== "agent_end") {
			return;
		}

		await sessionStore.save({
			key: sessionKey,
			createdAt,
			updatedAt: new Date().toISOString(),
			messages: sanitizeMessagesForPersistence(agent.state.messages),
			metadata: {},
		});
	});

	return agent;
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

export function sanitizeMessagesForPersistence(
	messages: readonly Message[],
): Message[] {
	return messages
		.filter((message) => {
			return !(
				message.role === "assistant" &&
				(message.stopReason === "error" || message.stopReason === "aborted")
			);
		})
		.map((message) => structuredClone(message));
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
		metadata: {},
		messages: sanitizeMessagesForPersistence(messages),
	};
}

function resolveModel(
	provider: AppConfig["agent"]["provider"],
	modelId: string,
): Model<Api> {
	const model = getModels(provider).find(
		(candidate) => candidate.id === modelId,
	);
	if (!model) {
		throw new Error(`Unknown modelId '${modelId}' for provider '${provider}'.`);
	}
	return getModel(provider, modelId as never) as Model<Api>;
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
