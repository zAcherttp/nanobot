import type { AppConfig } from "../config/schema.js";
import type { Logger } from "../utils/logging.js";
import { BaseChannel } from "./base.js";
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
		for (const channel of this.channels.values()) {
			await channel.start();
		}
	}

	async stop(): Promise<void> {
		const activeChannels = Array.from(this.channels.values()).reverse();
		for (const channel of activeChannels) {
			await channel.stop();
		}
	}

	async send(message: OutboundChannelMessage): Promise<number> {
		const factory = this.factoryByName.get(message.channel);
		if (!factory) {
			throw new Error(`Unknown channel: ${message.channel}.`);
		}

		const channel = this.channels.get(message.channel);
		if (!channel) {
			throw new Error(`Channel ${message.channel} is disabled.`);
		}

		await this.bus.publishOutbound(message);
		return channel.send(message);
	}

	async broadcast(
		message: Omit<OutboundChannelMessage, "channel">,
	): Promise<number> {
		if (!this.hasEnabledChannels()) {
			throw new Error("No channels are enabled.");
		}

		let delivered = 0;
		for (const [channelName] of this.channels) {
			delivered += await this.send({
				...message,
				channel: channelName,
			});
		}

		return delivered;
	}
}
