export type {
  MessageRole,
  ThreadMessage,
  ToolCall,
  ContentBlock,
} from "@/thread/schema";

export interface StreamDelta {
  id: string;
  delta: string;
  timestamp: number;
  channel?: string;
  userId?: string;
}
