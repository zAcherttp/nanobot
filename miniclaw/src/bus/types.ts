import type { AgentMessage as CoreAgentMessage } from "@mariozechner/pi-agent-core";

export type AgentMessage =
  | CoreAgentMessage
  | {
      role: "system";
      content: string;
      timestamp: number;
    };

export type { CoreAgentMessage };

export interface InboundBusEvent {
  message: AgentMessage;
  channel?: string;
  userId?: string;
}

export interface OutboundBusEvent {
  message: AgentMessage;
  channel?: string;
  userId?: string;
  trackingKey?: string;
}

export interface StreamDelta {
  id: string;
  delta: string;
  timestamp: number;
  channel?: string;
  userId?: string;
}

export interface EditBusEvent {
  messageId?: string;
  trackingKey?: string;
  newContent: string;
  channel?: string;
  userId?: string;
}
