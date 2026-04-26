import { Bot, GrammyError, HttpError } from "grammy";
import type { Channel } from "./base";
import type { MessageBus } from "@/bus/index";
import type { StreamDelta, OutboundBusEvent } from "@/bus/types";
import { logger } from "@/utils/logger";

type DraftStreamState = {
  mode: "draft";
  streamId: string;
  targetChatId: string;
  draftId: number;
  text: string;
  lastSendAt: number;
  timeoutId?: NodeJS.Timeout;
  pendingFlush: boolean;
};

type MessageStreamState = {
  mode: "message";
  streamId: string;
  targetChatId: string;
  messageId: number;
  text: string;
  lastSendAt: number;
  timeoutId?: NodeJS.Timeout;
  pendingFlush: boolean;
};

type StreamState = DraftStreamState | MessageStreamState;

export class TelegramChannel implements Channel {
  public readonly name = "telegram";
  private bot: Bot | null = null;
  private activeStreams = new Map<string, StreamState>();
  private closedStreams = new Map<
    string,
    { streamId: string; closedAt: number }
  >();
  private routeQueues = new Map<string, Promise<void>>();
  private userChatIds = new Map<string, string>();

  private static readonly STREAM_SEND_INTERVAL_MS = 1000;
  private static readonly CLOSED_STREAM_TTL_MS = 5000;

  constructor(
    private readonly bus: MessageBus,
    private readonly token: string,
    private readonly allowedUsers: string[],
  ) {}

  public async start(): Promise<void> {
    this.bot = new Bot(this.token);

    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id.toString();
      const username = ctx.from?.username;
      if (!userId) return;

      if (!this.isAllowedUser(userId, username)) {
        logger.warn(
          `Unauthorized Telegram access attempt from user: ${userId}${username ? ` (@${username})` : ""}`,
        );
        return;
      }

      await next();
    });

    this.bot.on("message:text", (ctx) => {
      const userId = ctx.from.id.toString();
      const targetChatId = ctx.chat.id.toString();
      this.userChatIds.set(userId, targetChatId);

      this.bus.publishInbound({
        message: {
          role: "user",
          content: ctx.msg.text,
          timestamp: Date.now(),
        },
        channel: this.name,
        userId,
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
    this.closedStreams.clear();
    this.routeQueues.clear();
    this.userChatIds.clear();
  }

  public async handleOutbound(event: OutboundBusEvent): Promise<void> {
    if (!event.userId) return;
    const routeKey = event.userId;
    const content = this.renderOutboundContent(event) || "(empty)";

    await this.enqueueRouteTask(routeKey, async () => {
      const bot = this.bot;
      if (!bot) return;

      const stream = this.activeStreams.get(routeKey);
      if (stream) {
        if (stream.timeoutId) clearTimeout(stream.timeoutId);

        try {
          if (stream.mode === "draft") {
            // Draft stream is ephemeral; emit one final persisted message.
            await this.sendMarkdownV2Message(bot, stream.targetChatId, content);
          } else {
            // Always finalize with an edit in case the last debounced preview differs.
            await this.editMarkdownV2Message(
              bot,
              stream.targetChatId,
              stream.messageId,
              content,
            );
          }
        } catch (err) {
          if (this.isMessageNotModifiedError(err)) {
            // Already finalized.
          } else {
            logger.error(
              { err },
              `Failed to finalize telegram stream for route ${routeKey}`,
            );
            try {
              await this.sendMarkdownV2Message(
                bot,
                stream.targetChatId,
                content,
              );
            } catch (sendErr) {
              logger.error(
                { err: sendErr },
                `Failed to send fallback telegram message to ${stream.targetChatId}`,
              );
            }
          }
        } finally {
          this.closedStreams.set(routeKey, {
            streamId: stream.streamId,
            closedAt: Date.now(),
          });
          this.activeStreams.delete(routeKey);
        }

        return;
      }

      const targetChatId = this.resolveTargetChatId(routeKey);
      try {
        await this.sendMarkdownV2Message(bot, targetChatId, content);
      } catch (err) {
        logger.error(
          { err },
          `Failed to send telegram message to ${targetChatId}`,
        );
      }
    });
  }

  public async handleStreamDelta(delta: StreamDelta): Promise<void> {
    if (!delta.userId) return;
    const routeKey = delta.userId;

    await this.enqueueRouteTask(routeKey, async () => {
      await this.processStreamDelta(routeKey, delta);
    });
  }

  private async processStreamDelta(
    routeKey: string,
    delta: StreamDelta,
  ): Promise<void> {
    const bot = this.bot;
    if (!bot) return;

    const closed = this.closedStreams.get(routeKey);
    if (closed) {
      const expired =
        Date.now() - closed.closedAt > TelegramChannel.CLOSED_STREAM_TTL_MS;
      if (expired) {
        this.closedStreams.delete(routeKey);
      } else if (closed.streamId === delta.id) {
        return;
      }
    }

    const targetChatId = this.resolveTargetChatId(routeKey);
    const stream = this.activeStreams.get(routeKey);

    if (!stream || stream.targetChatId !== targetChatId) {
      if (stream?.timeoutId) {
        clearTimeout(stream.timeoutId);
      }

      this.closedStreams.delete(routeKey);

      const initialText = delta.delta || "...";
      const draftId = this.toDraftId(delta.id);
      const usedDraft = await this.trySendMarkdownV2Draft(
        bot,
        targetChatId,
        draftId,
        initialText,
      );

      if (usedDraft) {
        this.activeStreams.set(routeKey, {
          mode: "draft",
          streamId: delta.id,
          targetChatId,
          draftId,
          text: initialText,
          lastSendAt: Date.now(),
          pendingFlush: false,
        });
        return;
      }

      try {
        const messageId = await this.sendMarkdownV2Message(
          bot,
          targetChatId,
          initialText,
        );
        this.activeStreams.set(routeKey, {
          mode: "message",
          streamId: delta.id,
          targetChatId,
          messageId,
          text: initialText,
          lastSendAt: Date.now(),
          pendingFlush: false,
        });
      } catch (err) {
        logger.error(
          { err },
          `Failed to send initial stream draft to ${targetChatId}`,
        );
      }

      return;
    }

    if (stream.streamId !== delta.id) {
      // Keep one active stream per route while tolerating stream id churn.
      stream.streamId = delta.id;
    }

    stream.text += delta.delta;
    stream.pendingFlush = true;

    const elapsed = Date.now() - stream.lastSendAt;
    if (elapsed >= TelegramChannel.STREAM_SEND_INTERVAL_MS) {
      await this.flushStream(routeKey);
      return;
    }

    if (!stream.timeoutId) {
      stream.timeoutId = setTimeout(() => {
        void this.enqueueRouteTask(routeKey, async () => {
          await this.flushStream(routeKey);
        });
      }, TelegramChannel.STREAM_SEND_INTERVAL_MS - elapsed);
    }
  }

  private async flushStream(routeKey: string): Promise<void> {
    const bot = this.bot;
    const stream = this.activeStreams.get(routeKey);
    if (!bot || !stream?.pendingFlush) return;

    stream.pendingFlush = false;
    stream.lastSendAt = Date.now();

    if (stream.timeoutId) {
      clearTimeout(stream.timeoutId);
      stream.timeoutId = undefined;
    }

    const preview = `${stream.text} ...`;

    if (stream.mode === "draft") {
      const ok = await this.trySendMarkdownV2Draft(
        bot,
        stream.targetChatId,
        stream.draftId,
        preview,
      );

      if (ok) {
        return;
      }

      try {
        const messageId = await this.sendMarkdownV2Message(
          bot,
          stream.targetChatId,
          preview,
        );
        this.activeStreams.set(routeKey, {
          mode: "message",
          streamId: stream.streamId,
          targetChatId: stream.targetChatId,
          messageId,
          text: stream.text,
          lastSendAt: stream.lastSendAt,
          pendingFlush: false,
        });
      } catch (err) {
        logger.error(
          { err },
          `Failed fallback stream send to ${stream.targetChatId}`,
        );
      }

      return;
    }

    try {
      await this.editMarkdownV2Message(
        bot,
        stream.targetChatId,
        stream.messageId,
        preview,
      );
    } catch (err: unknown) {
      if (this.isMessageNotModifiedError(err)) {
        return;
      }

      if (this.isMessageNotFoundError(err)) {
        try {
          stream.messageId = await this.sendMarkdownV2Message(
            bot,
            stream.targetChatId,
            preview,
          );
          return;
        } catch (sendErr) {
          logger.error(
            { err: sendErr },
            `Failed to recover missing telegram message for ${stream.targetChatId}`,
          );
        }
      }

      logger.error({ err }, `Failed to edit message ${stream.messageId}`);
    }
  }

  private async enqueueRouteTask(
    routeKey: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = this.routeQueues.get(routeKey) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.routeQueues.set(routeKey, next);

    next.finally(() => {
      if (this.routeQueues.get(routeKey) === next) {
        this.routeQueues.delete(routeKey);
      }
    });

    await next;
  }

  private resolveTargetChatId(routeKey: string): string {
    return this.userChatIds.get(routeKey) || routeKey;
  }

  private renderOutboundContent(event: OutboundBusEvent): string {
    const { content } = event.message;
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .map((part) => {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type?: unknown }).type === "text" &&
          "text" in part
        ) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }

        return "[Media]";
      })
      .join("\n");
  }

  private isMessageNotModifiedError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return message.toLowerCase().includes("message is not modified");
  }

  private isMessageNotFoundError(err: unknown): boolean {
    if (err instanceof GrammyError) {
      return err.description
        .toLowerCase()
        .includes("message to edit not found");
    }

    const message = err instanceof Error ? err.message : String(err);
    return message.toLowerCase().includes("message to edit not found");
  }

  private isAllowedUser(userId: string, username?: string): boolean {
    if (this.allowedUsers.includes("*")) {
      return true;
    }

    if (this.allowedUsers.length === 0) {
      return false;
    }

    if (this.allowedUsers.includes(userId)) {
      return true;
    }

    if (!username) {
      return false;
    }

    return (
      this.allowedUsers.includes(username) ||
      this.allowedUsers.includes(`@${username}`)
    );
  }

  private async sendMarkdownV2Message(
    bot: Bot,
    chatId: string,
    text: string,
  ): Promise<number> {
    const sent = await bot.api.sendMessage(
      chatId,
      this.escapeMarkdownV2(text),
      {
        parse_mode: "MarkdownV2",
      },
    );

    return sent.message_id;
  }

  private async editMarkdownV2Message(
    bot: Bot,
    chatId: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    await bot.api.editMessageText(
      chatId,
      messageId,
      this.escapeMarkdownV2(text),
      {
        parse_mode: "MarkdownV2",
      },
    );
  }

  private toDraftId(streamId: string): number {
    let hash = 0;
    for (let i = 0; i < streamId.length; i++) {
      hash = (hash * 31 + streamId.charCodeAt(i)) | 0;
    }

    const normalized = Math.abs(hash) % 2147483647;
    return normalized === 0 ? 1 : normalized;
  }

  private async trySendMarkdownV2Draft(
    bot: Bot,
    chatId: string,
    draftId: number,
    text: string,
  ): Promise<boolean> {
    const numericChatId = Number(chatId);
    if (!Number.isInteger(numericChatId)) {
      return false;
    }

    try {
      await bot.api.sendMessageDraft(
        numericChatId,
        draftId,
        this.escapeMarkdownV2(text),
        { parse_mode: "MarkdownV2" },
      );
      return true;
    } catch (err) {
      logger.warn(
        { err },
        "sendMessageDraft failed, falling back to sendMessage/editMessageText",
      );
      return false;
    }
  }

  private escapeMarkdownV2(text: string): string {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
  }
}
