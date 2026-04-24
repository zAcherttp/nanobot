import type { AppConfig } from "../config/schema.js";
import type { Logger } from "../utils/logging.js";
import type { BaseChannel } from "./base.js";
import { InMemoryMessageBus, type MessageBus } from "./bus.js";
import { createTelegramChannelFactory } from "./telegram.js";
import type { ChannelSnapshot, OutboundChannelMessage } from "./types.js";

export interface ChannelFactory {
	name: string;
	displayName: string;
	isEnabled(config: AppConfig): boolean;
	createChannel(
		config: AppConfig,
		bus: MessageBus,
		logger: Logger,
	): BaseChannel<unknown>;
}

export interface ChannelManagerOptions {
	bus?: MessageBus;
	channelFactories?: ChannelFactory[];
}

const DEFAULT_CHANNEL_FACTORIES: ChannelFactory[] = [
	createTelegramChannelFactory(),
];
const OUTBOUND_RETRY_DELAYS_MS = [0, 100, 500] as const;

export class ChannelManager {
	private readonly bus: MessageBus;
	private readonly channels = new Map<string, BaseChannel<unknown>>();
	private readonly factories: ChannelFactory[];
	private readonly factoryByName: Map<string, ChannelFactory>;
	private readonly bufferedStreams = new Map<string, BufferedStreamState>();
	private readonly outboundQueue: OutboundChannelMessage[] = [];
	private unsubscribeOutbound: (() => void) | undefined;
	private outboundDrainTimer: ReturnType<typeof setTimeout> | undefined;
	private outboundDrainPromise: Promise<void> | undefined;
	private started = false;

	constructor(
		private readonly config: AppConfig,
		private readonly logger: Logger,
		options: ChannelManagerOptions = {},
	) {
		this.bus = options.bus ?? new InMemoryMessageBus();
		this.factories = options.channelFactories ?? DEFAULT_CHANNEL_FACTORIES;
		this.factoryByName = new Map(
			this.factories.map((factory) => [factory.name, factory]),
		);

		for (const factory of this.factories) {
			if (!factory.isEnabled(this.config)) {
				continue;
			}
			this.channels.set(
				factory.name,
				factory.createChannel(this.config, this.bus, this.logger),
			);
		}

		this.validateEnabledChannelPolicies();
	}

	getBus(): MessageBus {
		return this.bus;
	}

	hasEnabledChannels(): boolean {
		return this.channels.size > 0;
	}

	getSnapshots(): ChannelSnapshot[] {
		return this.factories.map((factory) => {
			const channel = this.channels.get(factory.name);
			if (!channel) {
				return {
					name: factory.name,
					displayName: factory.displayName,
					enabled: false,
					status: "idle",
				} satisfies ChannelSnapshot;
			}

			return channel.getSnapshot(true);
		});
	}

	async start(): Promise<void> {
		if (this.started) {
			return;
		}

		this.started = true;
		this.logger.info("Channel manager started", {
			component: "channel",
			event: "manager_start",
			channels: Array.from(this.channels.keys()),
			snapshots: this.getSnapshots(),
		});
		this.unsubscribeOutbound = this.bus.subscribeOutbound((message) => {
			this.enqueueOutbound(message);
		});
		this.logger.info("Channel outbound dispatcher started", {
			component: "channel",
			event: "outbound_dispatcher_start",
		});

		for (const channel of this.channels.values()) {
			this.logger.info("Starting channel", {
				component: "channel",
				event: "start_requested",
				channel: channel.name,
			});
			await channel.start();
			this.logger.info("Channel started", {
				component: "channel",
				event: "start",
				channel: channel.name,
			});
		}
	}

	async stop(): Promise<void> {
		if (!this.started) {
			return;
		}

		this.unsubscribeOutbound?.();
		this.unsubscribeOutbound = undefined;
		await this.flushOutboundQueue();
		this.started = false;
		this.logger.info("Channel outbound dispatcher stopped", {
			component: "channel",
			event: "outbound_dispatcher_stop",
		});

		const activeChannels = Array.from(this.channels.values()).reverse();
		for (const channel of activeChannels) {
			await channel.stop();
			this.logger.info("Channel stopped", {
				component: "channel",
				event: "stop",
				channel: channel.name,
			});
		}
		this.bufferedStreams.clear();
		this.logger.info("Channel manager stopped", {
			component: "channel",
			event: "manager_stop",
		});
	}

	async send(message: OutboundChannelMessage): Promise<number> {
		return this.sendDirect(message);
	}

	async broadcast(
		message: Omit<OutboundChannelMessage, "channel">,
	): Promise<number> {
		if (!this.hasEnabledChannels()) {
			throw new Error("No channels are enabled.");
		}

		let delivered = 0;
		for (const [channelName] of this.channels) {
			delivered += await this.sendDirect({
				...message,
				channel: channelName,
			});
		}

		return delivered;
	}

	private async dispatchOutbound(
		message: OutboundChannelMessage,
	): Promise<number> {
		const channel = this.getChannelForMessage(message);
		this.logger.debug("Channel outbound dispatch", {
			component: "channel",
			event: "outbound_dispatch",
			channel: message.channel,
			chatId: message.chatId,
			streaming: hasStreamingMetadata(message),
			contentPreview: message.content,
		});
		if (hasStreamingMetadata(message) && !channel.supportsStreaming(message)) {
			return this.dispatchBufferedStream(channel, message);
		}
		return channel.send(message);
	}

	private async sendDirect(message: OutboundChannelMessage): Promise<number> {
		const channel = this.getChannelForMessage(message);
		return channel.send(message);
	}

	private enqueueOutbound(message: OutboundChannelMessage): void {
		if (!this.started) {
			this.logger.debug("Channel outbound message ignored while stopped", {
				component: "channel",
				event: "outbound_ignored",
				channel: message.channel,
				chatId: message.chatId,
			});
			return;
		}

		this.outboundQueue.push(message);
		this.scheduleOutboundDrain();
	}

	private scheduleOutboundDrain(): void {
		if (this.outboundDrainTimer || this.outboundDrainPromise) {
			return;
		}

		this.outboundDrainTimer = setTimeout(() => {
			this.outboundDrainTimer = undefined;
			this.outboundDrainPromise = this.drainOutboundQueue().finally(() => {
				this.outboundDrainPromise = undefined;
				if (this.started && this.outboundQueue.length > 0) {
					this.scheduleOutboundDrain();
				}
			});
		}, 0);
	}

	private async flushOutboundQueue(): Promise<void> {
		if (this.outboundDrainTimer) {
			clearTimeout(this.outboundDrainTimer);
			this.outboundDrainTimer = undefined;
		}

		if (this.outboundDrainPromise) {
			await this.outboundDrainPromise;
		}

		if (this.outboundQueue.length > 0) {
			await this.drainOutboundQueue();
		}
	}

	private async drainOutboundQueue(): Promise<void> {
		while (this.started && this.outboundQueue.length > 0) {
			const nextMessage = this.outboundQueue.shift();
			if (!nextMessage) {
				continue;
			}
			const message = this.coalesceOutboundMessage(nextMessage);
			if (this.shouldSuppressOutbound(message)) {
				continue;
			}

			await this.dispatchOutboundWithRetry(message);
		}
	}

	private coalesceOutboundMessage(
		message: OutboundChannelMessage,
	): OutboundChannelMessage {
		if (message.metadata?._stream_delta !== true) {
			return message;
		}

		let coalesced: OutboundChannelMessage | undefined;
		while (this.outboundQueue.length > 0) {
			const next = this.outboundQueue[0];
			if (!canCoalesceStreamDelta(message, next)) {
				break;
			}
			this.outboundQueue.shift();
			coalesced ??= { ...message };
			coalesced.content += next?.content ?? "";
		}

		return coalesced ?? message;
	}

	private shouldSuppressOutbound(message: OutboundChannelMessage): boolean {
		if (message.metadata?._retry_wait === true) {
			return true;
		}

		if (message.metadata?._progress !== true) {
			return false;
		}

		if (message.metadata?._tool_hint === true) {
			if (!this.config.channels.sendToolHints) {
				this.logger.debug("Channel tool hint suppressed", {
					component: "channel",
					event: "tool_hint_suppressed",
					channel: message.channel,
					chatId: message.chatId,
					contentPreview: message.content,
				});
				return true;
			}
			return false;
		}

		if (!this.config.channels.sendProgress) {
			this.logger.debug("Channel progress suppressed", {
				component: "channel",
				event: "progress_suppressed",
				channel: message.channel,
				chatId: message.chatId,
				contentPreview: message.content,
			});
			return true;
		}

		return false;
	}

	private async dispatchOutboundWithRetry(
		message: OutboundChannelMessage,
	): Promise<number> {
		const maxAttempts = Math.max(this.config.channels.sendMaxRetries, 1);
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			try {
				return await this.dispatchOutbound(message);
			} catch (error) {
				lastError = error;
				if (attempt >= maxAttempts) {
					break;
				}

				const delayMs = getRetryDelayMs(attempt - 1);
				this.logger.warn("Channel outbound dispatch retry scheduled", {
					component: "channel",
					event: "outbound_retry",
					channel: message.channel,
					chatId: message.chatId,
					attempt,
					nextAttempt: attempt + 1,
					maxAttempts,
					delayMs,
					error,
				});
				await sleep(delayMs);
			}
		}

		this.logger.error("Channel outbound dispatch failed", {
			component: "channel",
			event: "outbound_error",
			channel: message.channel,
			chatId: message.chatId,
			error: lastError,
		});
		return 0;
	}

	private getChannelForMessage(
		message: OutboundChannelMessage,
	): BaseChannel<unknown> {
		const factory = this.factoryByName.get(message.channel);
		if (!factory) {
			throw new Error(`Unknown channel: ${message.channel}.`);
		}

		const channel = this.channels.get(message.channel);
		if (!channel) {
			throw new Error(`Channel ${message.channel} is disabled.`);
		}

		return channel;
	}

	private async dispatchBufferedStream(
		channel: BaseChannel<unknown>,
		message: OutboundChannelMessage,
	): Promise<number> {
		if (!message.chatId) {
			throw new Error("Buffered stream messages require a chatId.");
		}

		if (message.metadata?._progress === true) {
			return 0;
		}

		const streamId = getStreamId(message);
		if (!streamId) {
			throw new Error("Buffered stream messages require metadata._stream_id.");
		}

		const key = getBufferedStreamKey(message.channel, message.chatId, streamId);
		if (message.metadata?._stream_delta === true) {
			const existing = this.bufferedStreams.get(key);
			this.bufferedStreams.set(key, {
				channel: message.channel,
				chatId: message.chatId,
				content: `${existing?.content ?? ""}${message.content}`,
				role: message.role,
			});
			return 0;
		}

		if (message.metadata?._stream_end === true) {
			const buffered = this.bufferedStreams.get(key);
			this.bufferedStreams.delete(key);
			if (!buffered?.content.trim()) {
				return 0;
			}

			return channel.send({
				channel: buffered.channel,
				chatId: buffered.chatId,
				content: buffered.content,
				...(buffered.role ? { role: buffered.role } : {}),
			});
		}

		return channel.send(message);
	}

	private validateEnabledChannelPolicies(): void {
		for (const [name, channel] of this.channels) {
			if (channel.configuredAllowFrom().length > 0) {
				continue;
			}

			throw new Error(
				`Enabled channel "${name}" has empty allowFrom (denies all). Set ["*"] to allow everyone, or add specific sender IDs.`,
			);
		}
	}
}

interface BufferedStreamState {
	channel: string;
	chatId: string;
	content: string;
	role?: OutboundChannelMessage["role"];
}

function hasStreamingMetadata(message: OutboundChannelMessage): boolean {
	return (
		message.metadata?._stream_delta === true ||
		message.metadata?._stream_end === true ||
		message.metadata?._progress === true
	);
}

function getStreamId(message: OutboundChannelMessage): string | null {
	const streamId = message.metadata?._stream_id;
	return typeof streamId === "string" && streamId ? streamId : null;
}

function canCoalesceStreamDelta(
	first: OutboundChannelMessage,
	next: OutboundChannelMessage | undefined,
): boolean {
	return (
		next?.metadata?._stream_delta === true &&
		next.channel === first.channel &&
		next.chatId === first.chatId &&
		getStreamId(next) === getStreamId(first)
	);
}

function getBufferedStreamKey(
	channel: string,
	chatId: string,
	streamId: string,
): string {
	return `${channel}:${chatId}:${streamId}`;
}

function getRetryDelayMs(failedAttemptIndex: number): number {
	return (
		OUTBOUND_RETRY_DELAYS_MS[
			Math.min(failedAttemptIndex, OUTBOUND_RETRY_DELAYS_MS.length - 1)
		] ?? 0
	);
}

function sleep(delayMs: number): Promise<void> {
	if (delayMs <= 0) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		setTimeout(resolve, delayMs);
	});
}
