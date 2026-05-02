import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

export interface SystemMessage {
  role: "system";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface TransportUserMessage {
  role: "user";
  id?: string;
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface TransportAssistantMessage {
  role: "assistant";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface TransportToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    system: SystemMessage;
    transportUser: TransportUserMessage;
    transportAssistant: TransportAssistantMessage;
    transportToolResult: TransportToolResultMessage;
  }
}
