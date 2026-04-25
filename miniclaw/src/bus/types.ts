import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type { AgentMessage };

export interface InboundBusEvent {
  message: AgentMessage;
  channel?: string;
  userId?: string;
}

export interface OutboundBusEvent {
  message: AgentMessage;
  channel?: string;
  userId?: string;
}

export interface StreamDelta {
  id: string;
  delta: string;
  timestamp: number;
  channel?: string;
  userId?: string;
}
