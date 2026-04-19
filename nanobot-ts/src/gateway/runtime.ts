import type { Agent, AgentTool } from "@mariozechner/pi-agent-core";

import {
	createSessionAgent,
	getLatestAssistantMessage,
	getLatestAssistantText,
	type ResolvedAgentRuntimeConfig,
	type SessionStore,
} from "../agent/loop.js";
import type { MessageBus } from "../channels/bus.js";
import type {
	InboundChannelMessage,
	OutboundChannelMessage,
} from "../channels/types.js";
import {
	CommandRouter,
	registerBuiltinCommands,
	type CommandContext,
	type CommandSessionSummary,
} from "../command/index.js";
import type { Logger } from "../utils/logging.js";

export const GATEWAY_RUNTIME_ERROR_MESSAGE =
	"Sorry, I encountered an error.";

export interface GatewayRuntimeAgent
	extends Pick<Agent, "prompt" | "state" | "abort" | "reset"> {}

export interface GatewayRuntimeAgentFactoryOptions {
	config: ResolvedAgentRuntimeConfig;
	sessionKey: string;
	sessionStore: SessionStore;
	tools: AgentTool[];
}

export type GatewayRuntimeAgentFactory = (
	options: GatewayRuntimeAgentFactoryOptions,
) => Promise<GatewayRuntimeAgent>;

export interface GatewayRuntimeOptions {
	bus: MessageBus;
	logger: Logger;
	config: ResolvedAgentRuntimeConfig;
	sessionStore: SessionStore;
	tools?: AgentTool[];
	createAgent?: GatewayRuntimeAgentFactory;
	commandRouter?: CommandRouter;
}

interface ActivePromptTask {
	agent: GatewayRuntimeAgent;
	aborted: boolean;
}

export function resolveChannelSessionKey(
	message: Pick<
		InboundChannelMessage,
		"channel" | "chatId" | "sessionKeyOverride"
	>,
): string {
	return (
		message.sessionKeyOverride ?? `${message.channel}:${message.chatId}`
	);
}

export class GatewayRuntime {
	private readonly tools: AgentTool[];
	private readonly createAgent: GatewayRuntimeAgentFactory;
	private readonly commandRouter: CommandRouter;
	private readonly agents = new Map<string, Promise<GatewayRuntimeAgent>>();
	private readonly sessionChains = new Map<string, Promise<void>>();
	private readonly activeTasks = new Set<Promise<void>>();
	private readonly activePromptTasks = new Map<string, ActivePromptTask>();
	private unsubscribeInbound: (() => void) | undefined;
	private running = false;

	constructor(private readonly options: GatewayRuntimeOptions) {
		this.tools = options.tools ?? [];
		this.createAgent =
			options.createAgent ??
			((agentOptions) =>
				createSessionAgent({
					config: agentOptions.config,
					sessionKey: agentOptions.sessionKey,
					sessionStore: agentOptions.sessionStore,
					tools: agentOptions.tools,
				}));
		this.commandRouter = options.commandRouter ?? createDefaultCommandRouter();
	}

	isRunning(): boolean {
		return this.running;
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
		try {
			const commandReply = await this.dispatchCommand(message, sessionKey);
			if (commandReply) {
				await this.options.bus.publishOutbound(commandReply);
				return;
			}

			const agent = await this.getAgent(sessionKey);
			const previousAssistant = getLatestAssistantMessage(agent.state.messages);
			const activePromptTask: ActivePromptTask = {
				agent,
				aborted: false,
			};
			this.activePromptTasks.set(sessionKey, activePromptTask);

			try {
				await agent.prompt(message.content);
			} catch (error) {
				if (activePromptTask.aborted || isAbortError(error)) {
					this.options.logger.info("Gateway runtime aborted active prompt", {
						channel: message.channel,
						chatId: message.chatId,
						sessionKey,
					});
					return;
				}
				throw error;
			} finally {
				if (this.activePromptTasks.get(sessionKey) === activePromptTask) {
					this.activePromptTasks.delete(sessionKey);
				}
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
				this.options.logger.error("Gateway runtime failed to publish error reply", {
					error: replyError,
					channel: message.channel,
					chatId: message.chatId,
					sessionKey,
				});
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
			this.options.logger.error("Gateway runtime failed to process priority command", {
				error,
				channel: message.channel,
				chatId: message.chatId,
				sessionKey,
			});
			await this.options.bus.publishOutbound({
				channel: message.channel,
				chatId: message.chatId,
				content: GATEWAY_RUNTIME_ERROR_MESSAGE,
				role: "assistant",
			});
		}
	}

	private getAgent(sessionKey: string): Promise<GatewayRuntimeAgent> {
		const existing = this.agents.get(sessionKey);
		if (existing) {
			return existing;
		}

		const created = this.createAgent({
			config: this.options.config,
			sessionKey,
			sessionStore: this.options.sessionStore,
			tools: this.tools,
		});
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
			session: await this.getSessionSummary(sessionKey),
			runtime: {
				provider: this.options.config.provider,
				modelId: this.options.config.modelId,
				providerAuthSource: this.options.config.providerAuthSource,
			},
			stopActiveTask: async () => this.stopActiveTask(sessionKey),
			clearSession: async () => this.clearSession(sessionKey),
		};
	}

	private async getSessionSummary(
		sessionKey: string,
	): Promise<CommandSessionSummary | null> {
		const agent = await this.getExistingAgent(sessionKey);
		if (agent) {
			return {
				messageCount: agent.state.messages.length,
			};
		}

		const session = await this.options.sessionStore.load(sessionKey);
		if (!session) {
			return null;
		}

		return {
			messageCount: session.messages.length,
		};
	}

	private async clearSession(sessionKey: string): Promise<void> {
		const existingSession = await this.options.sessionStore.load(sessionKey);
		const now = new Date().toISOString();
		await this.options.sessionStore.save({
			key: sessionKey,
			createdAt: existingSession?.createdAt ?? now,
			updatedAt: now,
			metadata: existingSession?.metadata ?? {},
			messages: [],
		});

		const existingAgent = await this.getExistingAgent(sessionKey);
		if (existingAgent) {
			existingAgent.abort();
			existingAgent.reset();
		}
		this.agents.delete(sessionKey);
		this.activePromptTasks.delete(sessionKey);
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
