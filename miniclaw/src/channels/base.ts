import type { OutboundBusEvent, StreamDelta } from "@/bus/types";
import type { MessageBus } from "@/bus/index";
import { logger } from "@/utils/logger";
import type { AppConfig } from "@/config/schema";

export interface Channel {
  readonly name: string;

  /**
   * Boot the channel (e.g. start polling, attach to server, start readline)
   */
  start(): Promise<void>;

  /**
   * Stop the channel
   */
  stop(): Promise<void>;

  /**
   * Handle an outgoing message from the Agent
   */
  handleOutbound(event: OutboundBusEvent): Promise<void>;

  /**
   * Handle streaming deltas from the Agent (optional)
   */
  handleStreamDelta?(delta: StreamDelta): Promise<void>;
}

export class ChannelRegistry {
  private channels = new Map<string, Channel>();

  constructor(
    private readonly bus: MessageBus,
    private readonly config: AppConfig,
  ) {
    // Route outbound messages to the correct channel
    this.bus.subscribeOutbound(async (msg) => {
      const target = msg.channel;
      if (target && this.channels.has(target)) {
        try {
          await this.channels.get(target)!.handleOutbound(msg);
        } catch (err) {
          logger.error(
            { err },
            `Channel [${target}] failed to handle outbound message`,
          );
        }
      }
    });

    // Route stream deltas
    this.bus.subscribeStreamDelta(async (delta) => {
      const target = delta.channel;
      if (target && this.channels.has(target)) {
        const channel = this.channels.get(target)!;
        if (channel.handleStreamDelta) {
          try {
            await channel.handleStreamDelta(delta);
          } catch (err) {
            logger.error(
              { err },
              `Channel [${target}] failed to handle stream delta`,
            );
          }
        }
      }
    });
  }

  register(channel: Channel) {
    this.channels.set(channel.name, channel);
    logger.info(`Registered channel: ${channel.name}`);
  }

  async startAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.start();
        logger.info(`Started channel: ${channel.name}`);
      } catch (err) {
        logger.error({ err }, `Failed to start channel: ${channel.name}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.stop();
        logger.info(`Stopped channel: ${channel.name}`);
      } catch (err) {
        logger.error({ err }, `Failed to stop channel: ${channel.name}`);
      }
    }
  }
}
