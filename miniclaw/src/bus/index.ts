import { EventEmitter } from "node:events";
import type { ThreadMessage, StreamDelta } from "./types";

export class MessageBus extends EventEmitter {
  constructor() {
    super();
  }

  // Frontend to Agent
  publishInbound(message: ThreadMessage): void {
    this.emit("inbound", message);
  }

  // Agent to Frontend (final message)
  publishOutbound(message: ThreadMessage): void {
    this.emit("outbound", message);
  }

  // Agent to Frontend (streaming delta)
  publishStreamDelta(delta: StreamDelta): void {
    this.emit("stream_delta", delta);
  }

  subscribeInbound(handler: (message: ThreadMessage) => void): () => void {
    this.on("inbound", handler);
    return () => this.off("inbound", handler);
  }

  subscribeOutbound(handler: (message: ThreadMessage) => void): () => void {
    this.on("outbound", handler);
    return () => this.off("outbound", handler);
  }

  subscribeStreamDelta(handler: (delta: StreamDelta) => void): () => void {
    this.on("stream_delta", handler);
    return () => this.off("stream_delta", handler);
  }
}
