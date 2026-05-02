import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { Bot, GrammyError, HttpError, type ApiClientOptions } from "grammy";
import type { MessageBus } from "@/bus/index";
import type { EditBusEvent, OutboundBusEvent, StreamDelta } from "@/bus/types";
import { logger } from "@/utils/logger";
import type { Channel } from "./base";

type StreamMode = "draft" | "message";

type StreamState = {
  mode: StreamMode;
  streamId: string;
  targetChatId: string;
  text: string;
  lastSendAt: number;
  timeoutId?: NodeJS.Timeout;
  pendingFlush: boolean;
  // Mode-specific fields
  draftId?: number;
  messageId?: number;
};

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
  private trackingMessages = new Map<
    string,
    { chatId: string; messageId: number }
  >();

  private static readonly STREAM_SEND_INTERVAL_MS = 1000;
  private static readonly CLOSED_STREAM_TTL_MS = 5000;
  private static readonly POLLING_MAX_SOCKETS = 2;
  private static readonly SEND_MAX_SOCKETS = 16;
  private static readonly API_RETRY_ATTEMPTS = 3;
  private static readonly API_RETRY_BASE_DELAY_MS = 500;
  private readonly pollingHttpAgent = new HttpAgent({
    keepAlive: true,
    maxSockets: TelegramChannel.POLLING_MAX_SOCKETS,
  });
  private readonly pollingHttpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: TelegramChannel.POLLING_MAX_SOCKETS,
  });
  private readonly sendHttpAgent = new HttpAgent({
    keepAlive: true,
    maxSockets: TelegramChannel.SEND_MAX_SOCKETS,
  });
  private readonly sendHttpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: TelegramChannel.SEND_MAX_SOCKETS,
  });

  constructor(
    private readonly bus: MessageBus,
    private readonly token: string,
    private readonly allowedUsers: string[],
  ) {}

  public async start(): Promise<void> {
    this.bot = new Bot(this.token, {
      client: this.buildClientConfig(),
    });

    // Subscribe to edit events
    this.bus.subscribeEdit(async (event: EditBusEvent) => {
      if (event.channel === this.name) {
        await this.handleEdit(event);
      }
    });

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
    this.trackingMessages.clear();
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

        await this.finalizeStream(bot, stream, content, routeKey);
        return;
      }

      const targetChatId = this.resolveTargetChatId(routeKey);
      try {
        const messageId = await this.sendMarkdownV2Message(
          bot,
          targetChatId,
          content,
          event.options,
        );
        if (event.trackingKey) {
          this.trackingMessages.set(event.trackingKey, {
            chatId: targetChatId,
            messageId,
          });
        }
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

    if (this.shouldSkipStream(routeKey, delta)) return;

    const targetChatId = this.resolveTargetChatId(routeKey);
    const stream = this.activeStreams.get(routeKey);

    if (!stream || stream.targetChatId !== targetChatId) {
      await this.createNewStream(bot, routeKey, targetChatId, delta);
      return;
    }

    this.updateStreamState(stream, delta);
    await this.scheduleStreamFlush(routeKey);
  }

  private shouldSkipStream(routeKey: string, delta: StreamDelta): boolean {
    const closed = this.closedStreams.get(routeKey);
    if (!closed) return false;

    const expired =
      Date.now() - closed.closedAt > TelegramChannel.CLOSED_STREAM_TTL_MS;
    if (expired) {
      this.closedStreams.delete(routeKey);
      return false;
    }

    return closed.streamId === delta.id;
  }

  private async createNewStream(
    bot: Bot,
    routeKey: string,
    targetChatId: string,
    delta: StreamDelta,
  ): Promise<void> {
    const existing = this.activeStreams.get(routeKey);
    if (existing?.timeoutId) clearTimeout(existing.timeoutId);
    this.closedStreams.delete(routeKey);

    const initialText = delta.delta || "...";
    const draftId = this.toDraftId(delta.id);

    const usedDraft = await this.trySendMarkdownV2Draft(
      bot,
      targetChatId,
      draftId,
      initialText,
    );

    this.activeStreams.set(routeKey, {
      mode: usedDraft ? "draft" : "message",
      streamId: delta.id,
      targetChatId,
      draftId: usedDraft ? draftId : undefined,
      messageId: usedDraft
        ? undefined
        : await this.trySendMessage(bot, targetChatId, initialText),
      text: initialText,
      lastSendAt: Date.now(),
      pendingFlush: false,
    });
  }

  private async trySendMessage(
    bot: Bot,
    chatId: string,
    text: string,
  ): Promise<number | undefined> {
    try {
      return await this.sendMarkdownV2Message(bot, chatId, text);
    } catch (err) {
      logger.error({ err }, `Failed to send initial stream draft to ${chatId}`);
      return undefined;
    }
  }

  private updateStreamState(stream: StreamState, delta: StreamDelta): void {
    if (stream.streamId !== delta.id) {
      stream.streamId = delta.id;
    }
    stream.text += delta.delta;
    stream.pendingFlush = true;
  }

  private async scheduleStreamFlush(routeKey: string): Promise<void> {
    const stream = this.activeStreams.get(routeKey);
    if (!stream) return;

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
      await this.flushDraftStream(bot, stream, preview, routeKey);
    } else {
      await this.flushMessageStream(bot, stream, preview);
    }
  }

  private async flushDraftStream(
    bot: Bot,
    stream: StreamState,
    preview: string,
    routeKey: string,
  ): Promise<void> {
    const ok = await this.trySendMarkdownV2Draft(
      bot,
      stream.targetChatId,
      stream.draftId!,
      preview,
    );

    if (ok) return;

    const messageId = await this.trySendMessage(
      bot,
      stream.targetChatId,
      preview,
    );
    if (messageId) {
      this.activeStreams.set(routeKey, {
        ...stream,
        mode: "message",
        messageId,
        draftId: undefined,
      });
    }
  }

  private async flushMessageStream(
    bot: Bot,
    stream: StreamState,
    preview: string,
  ): Promise<void> {
    try {
      await this.editMarkdownV2Message(
        bot,
        stream.targetChatId,
        stream.messageId!,
        preview,
      );
    } catch (err: unknown) {
      if (this.isMessageNotModifiedError(err)) return;

      if (this.isMessageNotFoundError(err)) {
        const newMessageId = await this.trySendMessage(
          bot,
          stream.targetChatId,
          preview,
        );
        if (newMessageId) stream.messageId = newMessageId;
        return;
      }

      logger.error({ err }, `Failed to edit message ${stream.messageId}`);
    }
  }

  private async finalizeStream(
    bot: Bot,
    stream: StreamState,
    content: string,
    routeKey: string,
  ): Promise<void> {
    try {
      if (stream.mode === "draft") {
        await this.sendMarkdownV2Message(bot, stream.targetChatId, content);
      } else {
        await this.editMarkdownV2Message(
          bot,
          stream.targetChatId,
          stream.messageId!,
          content,
        );
      }
    } catch (err) {
      if (!this.isMessageNotModifiedError(err)) {
        logger.error(
          { err },
          `Failed to finalize telegram stream for route ${routeKey}`,
        );
        await this.trySendMessage(bot, stream.targetChatId, content);
      }
    } finally {
      this.closedStreams.set(routeKey, {
        streamId: stream.streamId,
        closedAt: Date.now(),
      });
      this.activeStreams.delete(routeKey);
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
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

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
    if (this.allowedUsers.includes("*")) return true;
    if (this.allowedUsers.length === 0) return false;
    if (this.allowedUsers.includes(userId)) return true;
    if (!username) return false;

    return (
      this.allowedUsers.includes(username) ||
      this.allowedUsers.includes(`@${username}`)
    );
  }

  private async sendMarkdownV2Message(
    bot: Bot,
    chatId: string,
    text: string,
    options?: string[],
  ): Promise<number> {
    const sent = await this.callTelegramApi("sendMessage", () =>
      bot.api.sendMessage(chatId, this.escapeMarkdownV2(text), {
        parse_mode: "MarkdownV2",
        reply_markup:
          options && options.length > 0
            ? {
                keyboard: [options],
                resize_keyboard: true,
                one_time_keyboard: true,
              }
            : undefined,
      }),
    );
    return sent.message_id;
  }

  private async editMarkdownV2Message(
    bot: Bot,
    chatId: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    await this.callTelegramApi("editMessageText", () =>
      bot.api.editMessageText(chatId, messageId, this.escapeMarkdownV2(text), {
        parse_mode: "MarkdownV2",
      }),
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
    if (!Number.isInteger(numericChatId)) return false;

    try {
      await this.callTelegramApi("sendMessageDraft", () =>
        bot.api.sendMessageDraft(
          numericChatId,
          draftId,
          this.escapeMarkdownV2(text),
          { parse_mode: "MarkdownV2" },
        ),
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

  public async handleEdit(event: EditBusEvent): Promise<void> {
    if (!event.userId) return;
    const routeKey = event.userId;

    await this.enqueueRouteTask(routeKey, async () => {
      const bot = this.bot;
      if (!bot) return;

      const targetChatId = this.resolveTargetChatId(routeKey);
      try {
        const tracked =
          event.trackingKey && this.trackingMessages.has(event.trackingKey)
            ? this.trackingMessages.get(event.trackingKey)
            : undefined;
        const messageId = event.messageId
          ? Number(event.messageId)
          : tracked?.messageId;
        const chatId = tracked?.chatId || targetChatId;

        if (!messageId) {
          const sentId = await this.sendMarkdownV2Message(
            bot,
            chatId,
            event.newContent,
          );
          if (event.trackingKey) {
            this.trackingMessages.set(event.trackingKey, {
              chatId,
              messageId: sentId,
            });
          }
          return;
        }

        await this.editMarkdownV2Message(
          bot,
          chatId,
          messageId,
          event.newContent,
        );
      } catch (err) {
        if (this.isMessageNotFoundError(err)) {
          const sentId = await this.sendMarkdownV2Message(
            bot,
            targetChatId,
            event.newContent,
          );
          if (event.trackingKey) {
            this.trackingMessages.set(event.trackingKey, {
              chatId: targetChatId,
              messageId: sentId,
            });
          }
          return;
        }

        logger.error(
          { err },
          `Failed to edit telegram message to ${targetChatId}`,
        );
      }
    });
  }

  private buildClientConfig(): ApiClientOptions {
    const baseFetchConfig = {
      compress: true,
      agent: (parsedUrl: URL) => this.selectTransportAgent(parsedUrl),
    } as ApiClientOptions["baseFetchConfig"];

    return {
      timeoutSeconds: 60,
      baseFetchConfig,
    };
  }

  private selectTransportAgent(parsedUrl: URL): HttpAgent | HttpsAgent {
    const isPolling = parsedUrl.pathname.endsWith("/getUpdates");
    const useHttps = parsedUrl.protocol === "https:";
    if (isPolling) {
      return useHttps ? this.pollingHttpsAgent : this.pollingHttpAgent;
    }
    return useHttps ? this.sendHttpsAgent : this.sendHttpAgent;
  }

  private async callTelegramApi<T>(
    method: string,
    action: () => Promise<T>,
  ): Promise<T> {
    let delayMs = TelegramChannel.API_RETRY_BASE_DELAY_MS;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await action();
      } catch (err) {
        if (
          attempt >= TelegramChannel.API_RETRY_ATTEMPTS ||
          !this.shouldRetryTelegramApiError(err)
        ) {
          throw err;
        }

        logger.warn(
          { err, attempt, method, delayMs },
          `Transient Telegram API failure in ${method}, retrying`,
        );
        await this.sleep(delayMs);
        delayMs *= 2;
      }
    }
  }

  private shouldRetryTelegramApiError(err: unknown): boolean {
    if (err instanceof HttpError) {
      return true;
    }
    if (err instanceof GrammyError) {
      if (err.error_code >= 500) return true;
      if (err.error_code === 429) return true;
      const description = err.description.toLowerCase();
      return (
        description.includes("timed out") ||
        description.includes("timeout") ||
        description.includes("temporarily unavailable")
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    const lowered = message.toLowerCase();
    return (
      lowered.includes("timed out") ||
      lowered.includes("timeout") ||
      lowered.includes("econnreset") ||
      lowered.includes("socket hang up") ||
      lowered.includes("temporarily unavailable")
    );
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
