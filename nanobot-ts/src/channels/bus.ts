import type { InboundChannelMessage, OutboundChannelMessage } from "./types.js";

type MessageListener<TMessage> = (
	message: TMessage,
) => void | Promise<void>;

export interface MessageBus {
	publishInbound(message: InboundChannelMessage): Promise<void>;
	publishOutbound(message: OutboundChannelMessage): Promise<void>;
	subscribeInbound(
		listener: MessageListener<InboundChannelMessage>,
	): () => void;
	subscribeOutbound(
		listener: MessageListener<OutboundChannelMessage>,
	): () => void;
}

export class InMemoryMessageBus implements MessageBus {
	private readonly inboundListeners = new Set<
		MessageListener<InboundChannelMessage>
	>();
	private readonly outboundListeners = new Set<
		MessageListener<OutboundChannelMessage>
	>();

	async publishInbound(message: InboundChannelMessage): Promise<void> {
		for (const listener of this.inboundListeners) {
			await listener(message);
		}
	}

	async publishOutbound(message: OutboundChannelMessage): Promise<void> {
		for (const listener of this.outboundListeners) {
			await listener(message);
		}
	}

	subscribeInbound(
		listener: MessageListener<InboundChannelMessage>,
	): () => void {
		this.inboundListeners.add(listener);
		return () => {
			this.inboundListeners.delete(listener);
		};
	}

	subscribeOutbound(
		listener: MessageListener<OutboundChannelMessage>,
	): () => void {
		this.outboundListeners.add(listener);
		return () => {
			this.outboundListeners.delete(listener);
		};
	}
}
