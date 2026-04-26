import { EventEmitter } from "node:events";
import type { InboundBusEvent, OutboundBusEvent, StreamDelta } from "./types";

export class MessageBus extends EventEmitter {
  // constructor() {
  //   super();
  // }

  // Frontend to Agent
  publishInbound(event: InboundBusEvent): void {
    this.emit("inbound", event);
  }

  // Agent to Frontend (final message)
  publishOutbound(event: OutboundBusEvent): void {
    this.emit("outbound", event);
  }

  // Agent to Frontend (streaming delta)
  publishStreamDelta(delta: StreamDelta): void {
    this.emit("stream_delta", delta);
  }

  subscribeInbound(handler: (event: InboundBusEvent) => void): () => void {
    this.on("inbound", handler);
    return () => this.off("inbound", handler);
  }

  subscribeOutbound(handler: (event: OutboundBusEvent) => void): () => void {
    this.on("outbound", handler);
    return () => this.off("outbound", handler);
  }

  subscribeStreamDelta(handler: (delta: StreamDelta) => void): () => void {
    this.on("stream_delta", handler);
    return () => this.off("stream_delta", handler);
  }
}
