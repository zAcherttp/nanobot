export type MessageRole = "system" | "user" | "assistant" | "toolResult";

export interface BusMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface StreamDelta {
  id: string;
  delta: string;
  timestamp: number;
}
