import type { Agent, AgentTool } from "@mariozechner/pi-agent-core";

import {
	createSessionAgent,
	getLatestAssistantMessage,
	getLatestAssistantText,
	type ResolvedAgentRuntimeConfig,
	type SessionStore,
} from "../agent/loop.js";
import type { MessageBus } from "../channels/bus.js";
import type { InboundChannelMessage } from "../channels/types.js";
import type { Logger } from "../utils/logging.js";

export const GATEWAY_RUNTIME_ERROR_MESSAGE =
	"Sorry, I encountered an error.";

export interface GatewayRuntimeAgent
	extends Pick<Agent, "prompt" | "state"> {}

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
	private readonly agents = new Map<string, Promise<GatewayRuntimeAgent>>();
	private readonly sessionChains = new Map<string, Promise<void>>();
	private readonly activeTasks = new Set<Promise<void>>();
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

			const task = this.enqueue(message);
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
			const agent = await this.getAgent(sessionKey);
			const previousAssistant = getLatestAssistantMessage(agent.state.messages);

			await agent.prompt(message.content);

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
}
