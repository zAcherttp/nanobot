import type { Agent, AgentEvent, AgentTool } from "@mariozechner/pi-agent-core";
import {
	type Consolidator,
	getUnconsolidatedMessages,
} from "../agent/consolidator.js";
import {
	type AutoCompactor,
	createRuntimeConsolidator,
	createSessionAgent,
	getLatestAssistantMessage,
	getLatestAssistantText,
	type ResolvedAgentRuntimeConfig,
	type SessionRecord,
	type SessionStore,
} from "../agent/loop.js";
import { stripRuntimeCheckpoint } from "../agent/session-persistence.js";
import type { MessageBus } from "../channels/bus.js";
import type {
	InboundChannelMessage,
	OutboundChannelMessage,
} from "../channels/types.js";
import {
	type CommandContext,
	CommandRouter,
	type CommandSessionSummary,
	registerBuiltinCommands,
} from "../command/index.js";
import type { DreamService } from "../dream/index.js";
import type { Logger } from "../utils/logging.js";

export const GATEWAY_RUNTIME_ERROR_MESSAGE = "Sorry, I encountered an error.";

export interface GatewayRuntimeAgent
	extends Pick<Agent, "prompt" | "state" | "abort" | "reset"> {
	subscribe?: Agent["subscribe"];
}

export interface GatewayRuntimeAgentFactoryOptions {
	config: ResolvedAgentRuntimeConfig;
	sessionKey: string;
	channel?: string;
	sessionStore: SessionStore;
	tools: AgentTool[];
	consolidator?: Consolidator;
}

export interface GatewayRuntimeToolFactoryOptions {
	sessionKey: string;
	message: InboundChannelMessage;
}

export type GatewayRuntimeAgentFactory = (
	options: GatewayRuntimeAgentFactoryOptions,
) => Promise<GatewayRuntimeAgent>;
export type GatewayRuntimeToolFactory = (
	options: GatewayRuntimeToolFactoryOptions,
) => AgentTool[] | Promise<AgentTool[]>;

export interface GatewayRuntimeOptions {
	bus: MessageBus;
	logger: Logger;
	config: ResolvedAgentRuntimeConfig;
	sessionStore: SessionStore;
	tools?: AgentTool[];
	getTools?: GatewayRuntimeToolFactory;
	createAgent?: GatewayRuntimeAgentFactory;
	createConsolidator?: (
		getTools?: () => AgentTool[] | Promise<AgentTool[]>,
	) => Consolidator;
	autoCompactor?: AutoCompactor;
	commandRouter?: CommandRouter;
	dreamService?: DreamService;
}

interface ActivePromptTask {
	agent: GatewayRuntimeAgent;
	aborted: boolean;
}

interface PromptStreamState {
	message: InboundChannelMessage;
	sessionKey: string;
	activeStreamId?: string;
	sawAnyTextDelta: boolean;
	streamSequence: number;
}

export function resolveChannelSessionKey(
	message: Pick<
		InboundChannelMessage,
		"channel" | "chatId" | "sessionKeyOverride"
	>,
): string {
	return message.sessionKeyOverride ?? `${message.channel}:${message.chatId}`;
}

export class GatewayRuntime {
	private readonly tools: AgentTool[];
	private readonly getTools: GatewayRuntimeToolFactory | undefined;
	private readonly createAgent: GatewayRuntimeAgentFactory;
	private readonly commandRouter: CommandRouter;
	private readonly agents = new Map<string, Promise<GatewayRuntimeAgent>>();
	private readonly sessionChains = new Map<string, Promise<void>>();
	private readonly activeTasks = new Set<Promise<void>>();
	private readonly activePromptTasks = new Map<string, ActivePromptTask>();
	private streamCounter = 0;
	private unsubscribeInbound: (() => void) | undefined;
	private running = false;

	constructor(private readonly options: GatewayRuntimeOptions) {
		this.tools = options.tools ?? [];
		this.getTools = options.getTools;
		this.createAgent =
			options.createAgent ??
			((agentOptions) =>
				createSessionAgent({
					config: agentOptions.config,
					sessionKey: agentOptions.sessionKey,
					...(agentOptions.channel ? { channel: agentOptions.channel } : {}),
					sessionStore: agentOptions.sessionStore,
					tools: agentOptions.tools,
					...(agentOptions.consolidator
						? { consolidator: agentOptions.consolidator }
						: {}),
					...(options.autoCompactor
						? { autoCompactor: options.autoCompactor }
						: {}),
				}));
		this.commandRouter = options.commandRouter ?? createDefaultCommandRouter();
	}

	isRunning(): boolean {
		return this.running;
	}

	isSessionActive(sessionKey: string): boolean {
		return (
			this.activePromptTasks.has(sessionKey) ||
			this.sessionChains.has(sessionKey)
		);
	}

	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		this.running = true;
		this.unsubscribeInbound = this.options.bus.subscribeInbound((message) => {
			if (!this.running) {
				return;
			}

			const task = this.commandRouter.isPriority(message.content)
				? this.handlePriorityCommand(message)
				: this.enqueue(message);
			this.activeTasks.add(task);
			void task.finally(() => {
				this.activeTasks.delete(task);
			});
		});
	}

	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		this.running = false;
		this.unsubscribeInbound?.();
		this.unsubscribeInbound = undefined;
		await Promise.allSettled([...this.activeTasks]);
		this.agents.clear();
		this.sessionChains.clear();
		this.activePromptTasks.clear();
	}

	private enqueue(message: InboundChannelMessage): Promise<void> {
		const sessionKey = resolveChannelSessionKey(message);
		const previous = this.sessionChains.get(sessionKey) ?? Promise.resolve();
		const current = previous
			.catch(() => undefined)
			.then(async () => {
				if (!this.running) {
					return;
				}

				await this.processMessage(message, sessionKey);
			});

		this.sessionChains.set(sessionKey, current);
		void current.finally(() => {
			if (this.sessionChains.get(sessionKey) === current) {
				this.sessionChains.delete(sessionKey);
			}
		});

		return current;
	}

	private async processMessage(
		message: InboundChannelMessage,
		sessionKey: string,
	): Promise<void> {
		let promptStreamState: PromptStreamState | undefined;
		try {
			const commandReply = await this.dispatchCommand(message, sessionKey);
			if (commandReply) {
				await this.options.bus.publishOutbound(commandReply);
				return;
			}

			const agent = await this.getAgent(sessionKey, message);
			const previousAssistant = getLatestAssistantMessage(agent.state.messages);
			const activePromptTask: ActivePromptTask = {
				agent,
				aborted: false,
			};
			this.activePromptTasks.set(sessionKey, activePromptTask);
			promptStreamState = {
				message,
				sessionKey,
				sawAnyTextDelta: false,
				streamSequence: 0,
			};
			const unsubscribe =
				typeof agent.subscribe === "function"
					? agent.subscribe(async (event) => {
							if (!promptStreamState) {
								return;
							}
							await this.handleAgentEvent(event, promptStreamState);
						})
					: () => undefined;

			try {
				await agent.prompt(message.content);
			} catch (error) {
				if (activePromptTask.aborted || isAbortError(error)) {
					await this.finalizeOpenStream(promptStreamState);
					this.options.logger.info("Gateway runtime aborted active prompt", {
						channel: message.channel,
						chatId: message.chatId,
						sessionKey,
					});
					return;
				}
				throw error;
			} finally {
				unsubscribe();
				if (this.activePromptTasks.get(sessionKey) === activePromptTask) {
					this.activePromptTasks.delete(sessionKey);
				}
			}

			await this.finalizeOpenStream(promptStreamState);
			if (promptStreamState.sawAnyTextDelta) {
				return;
			}

			const latestAssistant = getLatestAssistantMessage(agent.state.messages);
			if (!latestAssistant || latestAssistant === previousAssistant) {
				return;
			}

			const reply = getLatestAssistantText(agent.state.messages).trim();
			if (!reply) {
				return;
			}

			await this.options.bus.publishOutbound({
				channel: message.channel,
				chatId: message.chatId,
				content: reply,
				role: "assistant",
			});
		} catch (error) {
			if (promptStreamState) {
				await this.finalizeOpenStream(promptStreamState);
			}
			this.options.logger.error("Gateway runtime failed to process message", {
				error,
				channel: message.channel,
				chatId: message.chatId,
				sessionKey,
			});
			try {
				await this.options.bus.publishOutbound({
					channel: message.channel,
					chatId: message.chatId,
					content: GATEWAY_RUNTIME_ERROR_MESSAGE,
					role: "assistant",
				});
			} catch (replyError) {
				this.options.logger.error(
					"Gateway runtime failed to publish error reply",
					{
						error: replyError,
						channel: message.channel,
						chatId: message.chatId,
						sessionKey,
					},
				);
			}
		}
	}

	private async handlePriorityCommand(
		message: InboundChannelMessage,
	): Promise<void> {
		const sessionKey = resolveChannelSessionKey(message);
		try {
			const reply = await this.dispatchPriorityCommand(message, sessionKey);
			if (!reply) {
				return;
			}

			await this.options.bus.publishOutbound(reply);
		} catch (error) {
			this.options.logger.error(
				"Gateway runtime failed to process priority command",
				{
					error,
					channel: message.channel,
					chatId: message.chatId,
					sessionKey,
				},
			);
			await this.options.bus.publishOutbound({
				channel: message.channel,
				chatId: message.chatId,
				content: GATEWAY_RUNTIME_ERROR_MESSAGE,
				role: "assistant",
			});
		}
	}

	private getAgent(
		sessionKey: string,
		message: InboundChannelMessage,
	): Promise<GatewayRuntimeAgent> {
		const existing = this.agents.get(sessionKey);
		if (existing) {
			return existing;
		}

		const created = Promise.resolve(
			this.getTools
				? this.getTools({
						sessionKey,
						message,
					})
				: this.tools,
		).then((tools) =>
			this.createAgent({
				config: this.options.config,
				sessionKey,
				...(message.channel ? { channel: message.channel } : {}),
				sessionStore: this.options.sessionStore,
				tools,
				consolidator: this.createConsolidator(async () => tools),
			}),
		);
		void created.catch(() => {
			if (this.agents.get(sessionKey) === created) {
				this.agents.delete(sessionKey);
			}
		});
		this.agents.set(sessionKey, created);
		return created;
	}

	private async dispatchPriorityCommand(
		message: InboundChannelMessage,
		sessionKey: string,
	): Promise<OutboundChannelMessage | null> {
		return this.commandRouter.dispatchPriority(
			await this.createCommandContext(message, sessionKey),
		);
	}

	private async dispatchCommand(
		message: InboundChannelMessage,
		sessionKey: string,
	): Promise<OutboundChannelMessage | null> {
		return this.commandRouter.dispatch(
			await this.createCommandContext(message, sessionKey),
		);
	}

	private async createCommandContext(
		message: InboundChannelMessage,
		sessionKey: string,
	): Promise<CommandContext> {
		return {
			msg: message,
			key: sessionKey,
			raw: message.content,
			session: await this.getSessionSummary(sessionKey, message),
			runtime: {
				provider: this.options.config.provider,
				modelId: this.options.config.modelId,
				providerAuthSource: this.options.config.providerAuthSource,
				contextWindowTokens: this.options.config.contextWindowTokens,
			},
			stopActiveTask: async () => this.stopActiveTask(sessionKey),
			clearSession: async () => this.clearSession(sessionKey, message),
			triggerDream: async () => this.startDream(message),
		};
	}

	private async startDream(message: InboundChannelMessage): Promise<boolean> {
		const dreamService = this.options.dreamService;
		if (!dreamService) {
			return false;
		}

		const startedAt = Date.now();
		const task = this.runDreamAndNotify(dreamService, message, startedAt);
		this.activeTasks.add(task);
		void task.finally(() => {
			this.activeTasks.delete(task);
		});
		return true;
	}

	private async runDreamAndNotify(
		dreamService: DreamService,
		message: InboundChannelMessage,
		startedAt: number,
	): Promise<void> {
		try {
			const result = await dreamService.run();
			const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
			await this.options.bus.publishOutbound({
				channel: message.channel,
				chatId: message.chatId,
				content: result.processed
					? `Dream completed in ${elapsed}s.`
					: "Dream: nothing to process.",
				role: "assistant",
			});
		} catch (error) {
			const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
			this.options.logger.error("Dream command failed", { error });
			await this.options.bus.publishOutbound({
				channel: message.channel,
				chatId: message.chatId,
				content: `Dream failed after ${elapsed}s: ${formatError(error)}`,
				role: "assistant",
			});
		}
	}

	private async getSessionSummary(
		sessionKey: string,
		message: InboundChannelMessage,
	): Promise<CommandSessionSummary | null> {
		const session = await this.resolveSessionRecord(sessionKey);
		if (!session) {
			return null;
		}

		const promptTokens = await this.createConsolidator(async () => {
			const agent = await this.getExistingAgent(sessionKey);
			if (agent) {
				return Array.isArray(agent.state.tools) ? agent.state.tools : [];
			}
			if (this.getTools) {
				return this.getTools({
					sessionKey,
					message,
				});
			}
			return this.tools;
		}).estimateSessionPromptTokens(session, message.channel);

		return {
			messageCount: session.messages.length,
			promptTokens,
		};
	}

	private async clearSession(
		sessionKey: string,
		message: InboundChannelMessage,
	): Promise<void> {
		const existingSession = await this.options.sessionStore.load(sessionKey);
		const existingAgent = await this.getExistingAgent(sessionKey);
		const unconsolidated = existingSession
			? getUnconsolidatedMessages(existingSession)
			: [];
		const now = new Date().toISOString();
		await this.options.sessionStore.save({
			key: sessionKey,
			createdAt: existingSession?.createdAt ?? now,
			updatedAt: now,
			lastConsolidated: 0,
			metadata: stripRuntimeCheckpoint(existingSession?.metadata),
			messages: [],
		});

		if (existingAgent) {
			existingAgent.abort();
			existingAgent.reset();
		}
		this.agents.delete(sessionKey);
		this.activePromptTasks.delete(sessionKey);

		if (unconsolidated.length === 0) {
			return;
		}

		try {
			await this.createConsolidator(async () => {
				if (existingAgent) {
					return Array.isArray(existingAgent.state.tools)
						? existingAgent.state.tools
						: [];
				}
				if (this.getTools) {
					return this.getTools({
						sessionKey,
						message,
					});
				}
				return this.tools;
			}).archive(unconsolidated);
		} catch {
			// Clearing a session must succeed even if archival fails.
		}
	}

	private async stopActiveTask(sessionKey: string): Promise<boolean> {
		const activePromptTask = this.activePromptTasks.get(sessionKey);
		if (!activePromptTask) {
			return false;
		}

		activePromptTask.aborted = true;
		activePromptTask.agent.abort();
		return true;
	}

	private async getExistingAgent(
		sessionKey: string,
	): Promise<GatewayRuntimeAgent | null> {
		const existing = this.agents.get(sessionKey);
		if (!existing) {
			return null;
		}

		try {
			return await existing;
		} catch {
			return null;
		}
	}

	private async resolveSessionRecord(
		sessionKey: string,
	): Promise<SessionRecord | null> {
		const persisted = await this.options.sessionStore.load(sessionKey);
		if (persisted) {
			return persisted;
		}

		const agent = await this.getExistingAgent(sessionKey);
		if (!agent) {
			return null;
		}

		return {
			key: sessionKey,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date().toISOString(),
			lastConsolidated: 0,
			metadata: {},
			messages: structuredClone(agent.state.messages),
		};
	}

	private createConsolidator(
		getTools?: () => AgentTool[] | Promise<AgentTool[]>,
	): Consolidator {
		return (
			this.options.createConsolidator?.(getTools) ??
			createRuntimeConsolidator({
				config: this.options.config,
				sessionStore: this.options.sessionStore,
				...(getTools ? { getTools } : {}),
			})
		);
	}

	private async handleAgentEvent(
		event: AgentEvent,
		streamState: PromptStreamState,
	): Promise<void> {
		if (event.type === "message_update") {
			if (event.assistantMessageEvent.type !== "text_delta") {
				return;
			}

			if (!streamState.activeStreamId) {
				streamState.activeStreamId = this.createStreamId(streamState);
			}

			streamState.sawAnyTextDelta = true;
			await this.options.bus.publishOutbound({
				channel: streamState.message.channel,
				chatId: streamState.message.chatId,
				content: event.assistantMessageEvent.delta,
				role: "assistant",
				metadata: {
					_stream_delta: true,
					_stream_id: streamState.activeStreamId,
				},
			});
			return;
		}

		if (event.type === "tool_execution_start") {
			await this.options.bus.publishOutbound({
				channel: streamState.message.channel,
				chatId: streamState.message.chatId,
				content: formatToolHint(event.toolName, event.args),
				role: "assistant",
				metadata: {
					_progress: true,
					_tool_hint: true,
					...(streamState.activeStreamId
						? { _stream_id: streamState.activeStreamId }
						: {}),
				},
			});
			return;
		}

		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			streamState.activeStreamId
		) {
			await this.publishStreamEnd(streamState);
		}
	}

	private createStreamId(streamState: PromptStreamState): string {
		streamState.streamSequence += 1;
		const streamId = `${streamState.sessionKey}:${++this.streamCounter}:${streamState.streamSequence}`;
		if (!streamState.activeStreamId) {
			streamState.activeStreamId = streamId;
		}
		return streamId;
	}

	private async finalizeOpenStream(
		streamState: PromptStreamState,
	): Promise<void> {
		if (!streamState.activeStreamId) {
			return;
		}

		await this.publishStreamEnd(streamState);
	}

	private async publishStreamEnd(
		streamState: PromptStreamState,
	): Promise<void> {
		const streamId = streamState.activeStreamId;
		if (!streamId) {
			return;
		}

		delete streamState.activeStreamId;
		await this.options.bus.publishOutbound({
			channel: streamState.message.channel,
			chatId: streamState.message.chatId,
			content: "",
			role: "assistant",
			metadata: {
				_stream_end: true,
				_streamed: true,
				_stream_id: streamId,
			},
		});
	}
}

function createDefaultCommandRouter(): CommandRouter {
	const router = new CommandRouter();
	registerBuiltinCommands(router);
	return router;
}

function isAbortError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" ||
			error.message.toLowerCase().includes("abort"))
	);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatToolHint(toolName: string, args: unknown): string {
	const formattedArgs = summarizeToolArgs(args);
	return `${toolName}(${formattedArgs})`;
}

function summarizeToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") {
		return "";
	}

	const serialized = JSON.stringify(args);
	if (!serialized || serialized === "{}") {
		return "";
	}

	return serialized.length > 80 ? `${serialized.slice(0, 77)}...` : serialized;
}
