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

export class ChannelManager {
	private readonly bus: MessageBus;
	private readonly channels = new Map<string, BaseChannel<unknown>>();
	private readonly factories: ChannelFactory[];
	private readonly factoryByName: Map<string, ChannelFactory>;
	private readonly bufferedStreams = new Map<string, BufferedStreamState>();
	private unsubscribeOutbound: (() => void) | undefined;
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
		});
		this.unsubscribeOutbound = this.bus.subscribeOutbound(async (message) => {
			try {
				await this.dispatchOutbound(message);
			} catch (error) {
				this.logger.error("Channel outbound dispatch failed", {
					component: "channel",
					event: "outbound_error",
					channel: message.channel,
					chatId: message.chatId,
					error,
				});
				throw error;
			}
		});

		for (const channel of this.channels.values()) {
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

		this.started = false;
		this.unsubscribeOutbound?.();
		this.unsubscribeOutbound = undefined;

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
		if (hasStreamingMetadata(message) && !channel.supportsStreaming(message)) {
			return this.dispatchBufferedStream(channel, message);
		}
		return channel.send(message);
	}

	private async sendDirect(message: OutboundChannelMessage): Promise<number> {
		const channel = this.getChannelForMessage(message);
		return channel.send(message);
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

function getBufferedStreamKey(
	channel: string,
	chatId: string,
	streamId: string,
): string {
	return `${channel}:${chatId}:${streamId}`;
}
