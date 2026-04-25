import { z } from "zod";

// ─── Thread Types ─────────────────────────────────────

export const ThreadTypeSchema = z.enum(["conversation", "system"]);
export type ThreadType = z.infer<typeof ThreadTypeSchema>;

export const ThreadStatusSchema = z.enum(["active", "archived", "compacted"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ThreadMetaSchema = z.object({
  id: z.string(), // Always ULID
  type: ThreadTypeSchema,
  title: z.string(),
  status: ThreadStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().min(0),
  tokenEstimate: z.number().int().min(0),
  summary: z.string().optional(),
  lastCompactedAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ThreadMeta = z.infer<typeof ThreadMetaSchema>;

// ─── Message Types ────────────────────────────────────

export const MessageRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
  "toolResult",
]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string() }),
  }),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const ThreadMessageSchema = z.object({
  id: z.string(),
  role: MessageRoleSchema,
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
  timestamp: z.string(),
  channel: z.string().optional(),
  userId: z.string().optional(),
  name: z.string().optional(), // Tool name for "tool" role (OpenAI spec)

  // Assistant-specific
  model: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
  reasoningContent: z.string().optional(),

  // Tool-specific
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),

  // Accounting
  tokenEstimate: z.number().int().min(0).optional(),

  metadata: z.record(z.unknown()).optional(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

/**
 * Input type for creating a new message (id, timestamp, tokenEstimate are auto-generated).
 */
export type NewMessage = Omit<
  ThreadMessage,
  "id" | "timestamp" | "tokenEstimate"
>;
