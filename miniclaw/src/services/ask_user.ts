import type { AgentMessage } from "@/bus/types";
import type { PersistenceService } from "./persistence";

const PENDING_ASK_KEY = "pendingAsk";
const APPROVAL_KEY = "approvedAsk";

export interface PendingAskState {
  toolCallId: string;
  question: string;
  options: string[];
  channel?: string;
  userId?: string;
  createdAt: string;
}

export interface ApprovedAskState {
  toolCallId: string;
  grantedAt: string;
}

export type AskReplyOutcome = "proceed" | "cancel" | "ambiguous";

export class AskUserService {
  constructor(private readonly persistence: PersistenceService) {}

  public async getPendingAsk(
    threadId: string,
  ): Promise<PendingAskState | null> {
    const metadata = await this.getMetadata(threadId);
    const pending = metadata[PENDING_ASK_KEY];
    if (!pending || typeof pending !== "object") {
      return null;
    }

    const record = pending as Record<string, unknown>;
    if (
      typeof record.toolCallId !== "string" ||
      typeof record.question !== "string" ||
      !Array.isArray(record.options)
    ) {
      return null;
    }

    return {
      toolCallId: record.toolCallId,
      question: record.question,
      options: record.options.filter(
        (option): option is string => typeof option === "string",
      ),
      channel: typeof record.channel === "string" ? record.channel : undefined,
      userId: typeof record.userId === "string" ? record.userId : undefined,
      createdAt:
        typeof record.createdAt === "string"
          ? record.createdAt
          : new Date().toISOString(),
    };
  }

  public async setPendingAsk(
    threadId: string,
    pendingAsk: PendingAskState,
  ): Promise<void> {
    const metadata = await this.getMetadata(threadId);
    metadata[PENDING_ASK_KEY] = pendingAsk;
    delete metadata[APPROVAL_KEY];
    await this.setMetadata(threadId, metadata);
  }

  public async clearPendingAsk(threadId: string): Promise<void> {
    const metadata = await this.getMetadata(threadId);
    delete metadata[PENDING_ASK_KEY];
    await this.setMetadata(threadId, metadata);
  }

  public async getApprovedAsk(
    threadId: string,
  ): Promise<ApprovedAskState | null> {
    const metadata = await this.getMetadata(threadId);
    const approved = metadata[APPROVAL_KEY];
    if (!approved || typeof approved !== "object") {
      return null;
    }

    const record = approved as Record<string, unknown>;
    if (
      typeof record.toolCallId !== "string" ||
      typeof record.grantedAt !== "string"
    ) {
      return null;
    }

    return {
      toolCallId: record.toolCallId,
      grantedAt: record.grantedAt,
    };
  }

  public async setApprovedAsk(
    threadId: string,
    approved: ApprovedAskState,
  ): Promise<void> {
    const metadata = await this.getMetadata(threadId);
    metadata[APPROVAL_KEY] = approved;
    await this.setMetadata(threadId, metadata);
  }

  public async clearApprovedAsk(threadId: string): Promise<void> {
    const metadata = await this.getMetadata(threadId);
    delete metadata[APPROVAL_KEY];
    await this.setMetadata(threadId, metadata);
  }

  public buildToolResultMessage(
    toolCallId: string,
    answer: string,
  ): AgentMessage {
    return {
      role: "toolResult",
      toolCallId,
      toolName: "ask_user",
      content: [{ type: "text", text: answer }],
      details: {
        answer,
      },
      timestamp: Date.now(),
    };
  }

  public classifyReply(reply: string, options: string[]): AskReplyOutcome {
    const normalized = normalize(reply);
    if (!normalized) {
      return "ambiguous";
    }

    if (options.length > 0) {
      for (const option of options) {
        const normalizedOption = normalize(option);
        if (!normalizedOption) {
          continue;
        }
        if (normalized === normalizedOption) {
          if (isProceedLike(normalizedOption)) {
            return "proceed";
          }
          if (isCancelLike(normalizedOption)) {
            return "cancel";
          }
        }
      }
    }

    if (isProceedLike(normalized)) {
      return "proceed";
    }
    if (isCancelLike(normalized)) {
      return "cancel";
    }
    return "ambiguous";
  }

  private async getMetadata(
    threadId: string,
  ): Promise<Record<string, unknown>> {
    const thread = await this.persistence.getThread(threadId);
    return thread.metadata && typeof thread.metadata === "object"
      ? { ...thread.metadata }
      : {};
  }

  private async setMetadata(
    threadId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.persistence.updateMeta(threadId, {
      metadata,
    });
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isProceedLike(value: string): boolean {
  return [
    /^proceed$/,
    /^yes$/,
    /^yes[, ]/,
    /^confirm$/,
    /^confirmed$/,
    /^go ahead$/,
    /^do it$/,
    /^please do$/,
    /^schedule it$/,
    /^book it$/,
  ].some((pattern) => pattern.test(value));
}

function isCancelLike(value: string): boolean {
  return [
    /^cancel$/,
    /^no$/,
    /^stop$/,
    /^abort$/,
    /^don't$/,
    /^do not$/,
    /^not now$/,
  ].some((pattern) => pattern.test(value));
}
