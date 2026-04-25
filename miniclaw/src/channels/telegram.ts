import { Bot, GrammyError, HttpError } from "grammy";
import type { Channel } from "./base";
import type { MessageBus } from "@/bus/index";
import type { ThreadMessage, StreamDelta } from "@/bus/types";
import { logger } from "@/utils/logger";
import { ulid } from "ulid";

export class TelegramChannel implements Channel {
  public readonly name = "telegram";
  private bot: Bot | null = null;

  // Track active streams per user/chat: chatId -> { messageId, text, lastEditTime, timeoutId }
  private activeStreams = new Map<
    string,
    {
      messageId: number;
      text: string;
      lastEditTime: number;
      timeoutId?: NodeJS.Timeout;
      pendingFlush: boolean;
    }
  >();

  constructor(
    private readonly bus: MessageBus,
    private readonly token: string,
    private readonly allowedUsers: string[],
  ) {}

  public async start(): Promise<void> {
    this.bot = new Bot(this.token);

    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(userId)) {
        logger.warn(
          `Unauthorized Telegram access attempt from user: ${userId}`,
        );
        return;
      }
      await next();
    });

    this.bot.on("message:text", (ctx) => {
      const text = ctx.msg.text;
      const userId = ctx.from.id.toString();

      this.bus.publishInbound({
        id: ulid(),
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
        channel: this.name,
        userId: userId,
      });
    });

    this.bot.catch((err) => {
      const ctx = err.ctx;
      logger.error(`Error while handling update ${ctx.update.update_id}:`);
      const e = err.error;
      if (e instanceof GrammyError) {
        logger.error({ description: e.description }, "Error in request");
      } else if (e instanceof HttpError) {
        logger.error({ err: e }, "Could not contact Telegram");
      } else {
        logger.error({ err: e }, "Unknown error");
      }
    });

    // Start long-polling
    this.bot.start({
      onStart: (botInfo) => {
        logger.info(`Telegram bot started: @${botInfo.username}`);
      },
    });
  }

  public async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }

    for (const stream of this.activeStreams.values()) {
      if (stream.timeoutId) clearTimeout(stream.timeoutId);
    }
    this.activeStreams.clear();
  }

  public async handleOutbound(message: ThreadMessage): Promise<void> {
    if (!this.bot || !message.userId) return;

    const chatId = message.userId;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((c) => (c.type === "text" ? c.text : "[Media]"))
            .join("\n");

    const stream = this.activeStreams.get(chatId);
    if (stream) {
      // Finalize the stream by editing one last time
      if (stream.timeoutId) clearTimeout(stream.timeoutId);
      try {
        if (stream.text !== content) {
          await this.bot.api.editMessageText(chatId, stream.messageId, content);
        }
      } catch (err) {
        logger.error(
          { err },
          `Failed to finalize telegram message ${stream.messageId}`,
        );
      }
      this.activeStreams.delete(chatId);
    } else {
      // No stream was active, just send a new message
      try {
        await this.bot.api.sendMessage(chatId, content || "*(empty)*", {
          parse_mode: "Markdown",
        });
      } catch (err) {
        logger.error({ err }, `Failed to send telegram message to ${chatId}`);
      }
    }
  }

  public async handleStreamDelta(delta: StreamDelta): Promise<void> {
    if (!this.bot || !delta.userId) return;
    const chatId = delta.userId;

    let stream = this.activeStreams.get(chatId);
    if (!stream) {
      // Create a new draft message
      try {
        const sent = await this.bot.api.sendMessage(
          chatId,
          delta.delta || "...",
          { parse_mode: "Markdown" },
        );
        stream = {
          messageId: sent.message_id,
          text: delta.delta,
          lastEditTime: Date.now(),
          pendingFlush: false,
        };
        this.activeStreams.set(chatId, stream);
      } catch (err) {
        logger.error({ err }, `Failed to send initial draft to ${chatId}`);
        return;
      }
    } else {
      stream.text += delta.delta;
      stream.pendingFlush = true;

      // Debounce logic: edit at most once every 1000ms
      const now = Date.now();
      if (now - stream.lastEditTime > 1000) {
        this.flushStream(chatId);
      } else if (!stream.timeoutId) {
        stream.timeoutId = setTimeout(
          () => {
            this.flushStream(chatId);
          },
          1000 - (now - stream.lastEditTime),
        );
      }
    }
  }

  private async flushStream(chatId: string) {
    const stream = this.activeStreams.get(chatId);
    if (!stream || !stream.pendingFlush || !this.bot) return;

    stream.pendingFlush = false;
    stream.lastEditTime = Date.now();
    if (stream.timeoutId) {
      clearTimeout(stream.timeoutId);
      stream.timeoutId = undefined;
    }

    try {
      // Telegram throws if the text is exactly the same, which is fine to ignore but better to catch
      await this.bot.api.editMessageText(
        chatId,
        stream.messageId,
        stream.text + " ⏳",
      );
    } catch (err: any) {
      if (!err.message?.includes("message is not modified")) {
        logger.error({ err }, `Failed to edit message ${stream.messageId}`);
      }
    }
  }
}
