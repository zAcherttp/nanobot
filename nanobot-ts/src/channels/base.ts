import { isSenderAllowed } from "../config/loader.js";
import type { MessageBus } from "./bus.js";
import type {
	ChannelSnapshot,
	ChannelStatus,
	InboundChannelMessage,
	OutboundChannelMessage,
} from "./types.js";

export interface BaseChannelOptions<TConfig> {
	name: string;
	displayName: string;
	config: TConfig;
	bus: MessageBus;
}

export abstract class BaseChannel<TConfig> {
	private status: ChannelStatus = "idle";
	private errorMessage?: string;

	protected constructor(
		protected readonly options: BaseChannelOptions<TConfig>,
	) {}

	get name(): string {
		return this.options.name;
	}

	get displayName(): string {
		return this.options.displayName;
	}

	getSnapshot(enabled: boolean): ChannelSnapshot {
		return {
			name: this.name,
			displayName: this.displayName,
			enabled,
			status: this.status,
			...(this.errorMessage ? { errorMessage: this.errorMessage } : {}),
		};
	}

	abstract start(): Promise<void>;
	abstract stop(): Promise<void>;
	abstract send(message: OutboundChannelMessage): Promise<number>;

	supportsStreaming(_message?: OutboundChannelMessage): boolean {
		return false;
	}

	protected get config(): TConfig {
		return this.options.config;
	}

	protected get bus(): MessageBus {
		return this.options.bus;
	}

	protected currentStatus(): ChannelStatus {
		return this.status;
	}

	protected setStatus(status: ChannelStatus, errorMessage?: string): void {
		this.status = status;
		if (errorMessage === undefined) {
			delete this.errorMessage;
			return;
		}

		this.errorMessage = errorMessage;
	}

	protected getAllowFrom(): string[] {
		return [];
	}

	configuredAllowFrom(): string[] {
		return [...this.getAllowFrom()];
	}

	protected getDefaultInboundMetadata(): Record<string, unknown> {
		return {};
	}

	protected canAcceptSender(senderId: string): boolean {
		return isSenderAllowed(this.getAllowFrom(), senderId);
	}

	protected async publishInbound(
		message: Omit<InboundChannelMessage, "channel" | "timestamp" | "metadata"> &
			Partial<
				Pick<InboundChannelMessage, "channel" | "timestamp" | "metadata">
			>,
	): Promise<boolean> {
		if (!this.canAcceptSender(message.senderId)) {
			return false;
		}

		const metadata = {
			...this.getDefaultInboundMetadata(),
			...(message.metadata ?? {}),
		};

		await this.bus.publishInbound({
			...message,
			channel: message.channel ?? this.name,
			timestamp: message.timestamp ?? new Date(),
			metadata,
		});
		return true;
	}
}
