import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { Channel } from "./base";
import type { MessageBus } from "@/bus/index";
import type { OutboundBusEvent, StreamDelta, EditBusEvent } from "@/bus/types";
import { logger } from "@/utils/logger";

export class SseChannel implements Channel {
  public readonly name = "sse";
  private streams = new Set<SSEStreamingApi>();
  public router = new Hono();

  constructor(private readonly bus: MessageBus) {}

  public async start(): Promise<void> {
    // Subscribe to edit events
    this.bus.subscribeEdit(async (event: EditBusEvent) => {
      if (event.channel === this.name) {
        await this.handleEdit(event);
      }
    });

    this.router.get("/stream", (c) => {
      return streamSSE(c, async (stream: SSEStreamingApi) => {
        this.streams.add(stream);
        logger.info(`SSE client connected. Active: ${this.streams.size}`);

        stream.onAbort(() => {
          this.streams.delete(stream);
          logger.info(`SSE client disconnected. Active: ${this.streams.size}`);
        });

        // Wait indefinitely
        await new Promise<void>((resolve) => {
          stream.onAbort(resolve);
        });
      });
    });

    // Endpoint for incoming user messages via REST
    this.router.post("/chat", async (c) => {
      try {
        const body = await c.req.json();
        if (!body || !body.content) {
          return c.json({ error: "Missing content" }, 400);
        }

        this.bus.publishInbound({
          message: {
            role: "user",
            content: body.content,
            timestamp: Date.now(),
          },
          channel: this.name,
        });

        return c.json({ success: true });
      } catch (err) {
        return c.json({ error: "Invalid request" }, 400);
      }
    });
  }

  public async stop(): Promise<void> {
    this.streams.clear();
  }

  public async handleOutbound(event: OutboundBusEvent): Promise<void> {
    const promises = Array.from(this.streams).map((stream) =>
      stream
        .writeSSE({
          event: "message",
          data: JSON.stringify(event),
        })
        .catch(() => {
          this.streams.delete(stream);
        }),
    );
    await Promise.all(promises);
  }

  public async handleStreamDelta(delta: StreamDelta): Promise<void> {
    const promises = Array.from(this.streams).map((stream) =>
      stream
        .writeSSE({
          event: "stream_delta",
          data: JSON.stringify(delta),
        })
        .catch(() => {
          this.streams.delete(stream);
        }),
    );
    await Promise.all(promises);
  }

  public async handleEdit(event: EditBusEvent): Promise<void> {
    const promises = Array.from(this.streams).map((stream) =>
      stream
        .writeSSE({
          event: "edit",
          data: JSON.stringify(event),
        })
        .catch(() => {
          this.streams.delete(stream);
        }),
    );
    await Promise.all(promises);
  }
}
