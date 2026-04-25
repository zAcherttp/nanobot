import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { MessageBus } from "../bus/index";

export function createSSERouter(bus: MessageBus): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return streamSSE(c, async (stream: SSEStreamingApi) => {
      let isConnected = true;

      const unsubscribeOutbound = bus.subscribeOutbound(async (message) => {
        if (!isConnected) return;
        await stream.writeSSE({
          event: "message",
          data: JSON.stringify(message),
        });
      });

      const unsubscribeDelta = bus.subscribeStreamDelta(async (delta) => {
        if (!isConnected) return;
        await stream.writeSSE({
          event: "stream_delta",
          data: JSON.stringify(delta),
        });
      });

      // Keep connection alive or handle disconnect
      stream.onAbort(() => {
        isConnected = false;
        unsubscribeOutbound();
        unsubscribeDelta();
      });

      // Simple heartbeat to keep SSE open
      const interval = setInterval(async () => {
        if (!isConnected) {
          clearInterval(interval);
          return;
        }
        await stream.writeSSE({
          event: "ping",
          data: JSON.stringify({ timestamp: Date.now() }),
        });
      }, 30000);

      // Wait indefinitely until client aborts
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(interval);
          resolve();
        });
      });
    });
  });

  return app;
}
