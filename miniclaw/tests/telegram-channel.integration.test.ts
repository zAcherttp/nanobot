import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus/index";
import { ChannelRegistry } from "../src/channels/base";
import { TelegramChannel } from "../src/channels/telegram";
import { AppConfigSchema } from "../src/config/schema";

const telegramHarness = vi.hoisted(() => {
  class GrammyError extends Error {
    public readonly description: string;

    constructor(message: string, description = message) {
      super(message);
      this.description = description;
    }
  }

  class HttpError extends Error {}

  class Bot {
    public static instances: Bot[] = [];
    public readonly api = {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      editMessageText: vi.fn(async () => undefined),
      sendMessageDraft: vi.fn(async () => undefined),
    };

    private middlewares: Array<
      (ctx: any, next: () => Promise<void>) => Promise<void> | void
    > = [];
    private messageHandler: ((ctx: any) => Promise<void> | void) | null = null;
    private catchHandler: ((error: any) => Promise<void> | void) | null = null;

    constructor(public readonly token: string) {
      Bot.instances.push(this);
    }

    use(
      middleware: (ctx: any, next: () => Promise<void>) => Promise<void> | void,
    ) {
      this.middlewares.push(middleware);
    }

    on(event: string, handler: (ctx: any) => Promise<void> | void) {
      if (event === "message:text") {
        this.messageHandler = handler;
      }
    }

    catch(handler: (error: any) => Promise<void> | void) {
      this.catchHandler = handler;
    }

    start(options?: { onStart?: (botInfo: { username: string }) => void }) {
      options?.onStart?.({ username: "test-bot" });
    }

    async stop() {}

    async dispatchText(input: {
      userId: string;
      username?: string;
      chatId: string;
      text: string;
    }) {
      const ctx = {
        from: {
          id: Number(input.userId),
          username: input.username,
        },
        chat: {
          id: Number(input.chatId),
        },
        msg: {
          text: input.text,
        },
        update: {
          update_id: 1,
        },
      };

      let index = -1;
      const next = async (): Promise<void> => {
        index += 1;
        const middleware = this.middlewares[index];

        if (middleware) {
          await middleware(ctx, next);
          return;
        }

        if (this.messageHandler) {
          await this.messageHandler(ctx);
        }
      };

      try {
        await next();
      } catch (error) {
        if (this.catchHandler) {
          await this.catchHandler({ ctx, error });
        } else {
          throw error;
        }
      }
    }
  }

  return { Bot, GrammyError, HttpError };
});

vi.mock("grammy", () => ({
  Bot: telegramHarness.Bot,
  GrammyError: telegramHarness.GrammyError,
  HttpError: telegramHarness.HttpError,
}));

describe("TelegramChannel integration", () => {
  beforeEach(() => {
    telegramHarness.Bot.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("ignores unauthorized inbound Telegram messages", async () => {
    const bus = new MessageBus();
    const inbound: string[] = [];
    const channel = new TelegramChannel(bus, "token", ["42"]);

    bus.subscribeInbound((event) => {
      inbound.push(String(event.message.content));
    });

    await channel.start();
    const bot = telegramHarness.Bot.instances[0];

    await bot.dispatchText({
      userId: "99",
      username: "intruder",
      chatId: "99",
      text: "hello",
    });

    expect(inbound).toEqual([]);
  });

  it("routes a real bus event chain from inbound Telegram message to streamed and finalized output", async () => {
    const bus = new MessageBus();
    const registry = new ChannelRegistry(bus, AppConfigSchema.parse({}));
    const channel = new TelegramChannel(bus, "token", ["42"]);

    registry.register(channel);
    await registry.startAll();

    const bot = telegramHarness.Bot.instances[0];
    bot.api.sendMessageDraft.mockRejectedValue(new Error("draft unavailable"));

    bus.subscribeInbound((event) => {
      bus.publishStreamDelta({
        id: "stream-1",
        delta: "hello",
        timestamp: Date.now(),
        channel: "telegram",
        userId: event.userId,
      });
      bus.publishOutbound({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello world" }],
          timestamp: Date.now(),
        },
        channel: "telegram",
        userId: event.userId,
      });
    });

    await bot.dispatchText({
      userId: "42",
      username: "allowed",
      chatId: "4242",
      text: "ping",
    });

    await vi.runAllTimersAsync();

    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      "4242",
      "hello",
      expect.objectContaining({ parse_mode: "MarkdownV2" }),
    );
    expect(bot.api.editMessageText).toHaveBeenCalledWith(
      "4242",
      1,
      "hello world",
      expect.objectContaining({ parse_mode: "MarkdownV2" }),
    );
  });

  it("falls back to resending when an in-flight message can no longer be edited", async () => {
    const bus = new MessageBus();
    const channel = new TelegramChannel(bus, "token", ["42"]);

    await channel.start();
    const bot = telegramHarness.Bot.instances[0];
    bot.api.sendMessageDraft.mockRejectedValue(new Error("draft unavailable"));

    await bot.dispatchText({
      userId: "42",
      username: "allowed",
      chatId: "4242",
      text: "prime route",
    });

    await channel.handleStreamDelta({
      id: "stream-2",
      delta: "hello",
      timestamp: Date.now(),
      userId: "42",
    });

    bot.api.editMessageText.mockRejectedValue(
      new telegramHarness.GrammyError(
        "message missing",
        "message to edit not found",
      ),
    );

    await channel.handleStreamDelta({
      id: "stream-2",
      delta: " again",
      timestamp: Date.now(),
      userId: "42",
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("suppresses duplicate deltas after a stream has already been finalized", async () => {
    const bus = new MessageBus();
    const channel = new TelegramChannel(bus, "token", ["42"]);

    await channel.start();
    const bot = telegramHarness.Bot.instances[0];
    bot.api.sendMessageDraft.mockRejectedValue(new Error("draft unavailable"));

    await bot.dispatchText({
      userId: "42",
      username: "allowed",
      chatId: "4242",
      text: "prime route",
    });

    await channel.handleStreamDelta({
      id: "stream-3",
      delta: "hello",
      timestamp: Date.now(),
      userId: "42",
    });

    await channel.handleOutbound({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        timestamp: Date.now(),
      },
      userId: "42",
    });

    await channel.handleStreamDelta({
      id: "stream-3",
      delta: " ignored",
      timestamp: Date.now(),
      userId: "42",
    });

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
  });

  it("delivers edit events as follow-up Telegram messages", async () => {
    const bus = new MessageBus();
    const channel = new TelegramChannel(bus, "token", ["42"]);

    await channel.start();
    const bot = telegramHarness.Bot.instances[0];

    await bot.dispatchText({
      userId: "42",
      username: "allowed",
      chatId: "4242",
      text: "prime route",
    });

    await channel.handleEdit({
      messageId: "edit-1",
      newContent: "Context compacted!",
      channel: "telegram",
      userId: "42",
    });

    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      "4242",
      "Context compacted\\!",
      expect.objectContaining({ parse_mode: "MarkdownV2" }),
    );
  });
});
