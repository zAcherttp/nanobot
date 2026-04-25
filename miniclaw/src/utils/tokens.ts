import { encode } from "gpt-tokenizer";
import type { ThreadMessage, ContentBlock } from "@/thread/schema";

const PER_MESSAGE_OVERHEAD = 4;

/**
 * Estimate token count for a single message.
 * Uses gpt-tokenizer (pure TS BPE) with a character heuristic fallback.
 */
export function estimateMessageTokens(msg: ThreadMessage): number {
  const parts: string[] = [];

  if (typeof msg.content === "string") {
    parts.push(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      }
    }
  }

  if (msg.toolCalls) parts.push(JSON.stringify(msg.toolCalls));
  if (msg.reasoningContent) parts.push(msg.reasoningContent);
  if (msg.toolName) parts.push(msg.toolName);
  if (msg.toolCallId) parts.push(msg.toolCallId);
  if (msg.name) parts.push(msg.name);

  const text = parts.join("\n");
  if (!text) return PER_MESSAGE_OVERHEAD;

  try {
    return encode(text).length + PER_MESSAGE_OVERHEAD;
  } catch {
    return Math.ceil(text.length / 4) + PER_MESSAGE_OVERHEAD;
  }
}

/**
 * Estimate total tokens for a list of messages.
 */
export function estimateTotalTokens(messages: ThreadMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += msg.tokenEstimate ?? estimateMessageTokens(msg);
  }
  return total;
}
