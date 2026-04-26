import { ulid } from "ulid";
import type { MessageBus } from "@/bus/index";
import type { AgentMessage } from "@/bus/types";
import type { PersistenceService } from "@/services/persistence";
import { logger } from "@/utils/logger";

export const COMPACTION_MESSAGES = {
  START: "My brain is overloading, please wait a little bit for me to cooldown",
  SUCCESS: (before: number, after: number) =>
    `Context compacted! ${before} K tokens -> ${after} K tokens`,
  FAILURE: "Compaction failed, please try again",
} as const;

export interface CompactionConfig {
  thresholdRatio: number;
  keepRecentMessages: number;
  maxRetries: number;
  retryDelayMs: number;
}

export interface CompactionResult {
  compacted: boolean;
  messages: AgentMessage[];
  summary?: string;
  beforeTokens?: number;
  afterTokens?: number;
}

export class CompactionService {
  constructor(
    private readonly bus: MessageBus,
    private readonly config: CompactionConfig,
    private readonly persistence: PersistenceService,
  ) {}

  public async compactIfNeeded(
    messages: AgentMessage[],
    contextWindow: number,
    threadId: string,
    channel?: string,
    userId?: string,
  ): Promise<CompactionResult> {
    const tokenCount = this.estimateTokens(messages);
    const threshold = contextWindow * this.config.thresholdRatio;

    logger.debug(
      `Token count: ${tokenCount}, threshold: ${threshold}, context window: ${contextWindow}`,
    );

    if (tokenCount < threshold) {
      return { compacted: false, messages };
    }

    logger.info(
      `Compaction needed: ${tokenCount} tokens exceeds threshold ${threshold}`,
    );

    // Send start message
    const startMessageId = await this.sendCompactionStart(channel, userId);

    // Perform compaction with retries
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        logger.info(`Compaction attempt ${attempt}/${this.config.maxRetries}`);
        const result = await this.performCompaction(messages);
        await this.sendCompactionSuccess(
          startMessageId,
          result.beforeTokens ?? -1,
          result.afterTokens ?? -1,
          channel,
          userId,
        );
        return result;
      } catch (err) {
        logger.error({ err }, `Compaction attempt ${attempt} failed`);
        if (attempt === this.config.maxRetries) {
          await this.sendCompactionFailure(startMessageId, channel, userId);
          throw err;
        }
        await this.delay(this.config.retryDelayMs);
      }
    }

    return { compacted: false, messages };
  }

  private async performCompaction(
    messages: AgentMessage[],
  ): Promise<CompactionResult> {
    if (messages.length <= this.config.keepRecentMessages) {
      logger.info(
        `Not enough messages to compact (${messages.length} messages, keeping ${this.config.keepRecentMessages})`,
      );
      return { compacted: false, messages };
    }

    // 1. Keep recent messages
    const recentMessages = messages.slice(-this.config.keepRecentMessages);

    // 2. Generate summary from old messages
    const oldMessages = messages.slice(0, -this.config.keepRecentMessages);
    const summary = await this.generateSummary(oldMessages);

    // 3. Return new message list (without summary message)
    const beforeTokens = this.estimateTokens(messages);
    const afterTokens = this.estimateTokens(recentMessages);

    logger.info(
      `Compaction complete: ${beforeTokens} tokens -> ${afterTokens} tokens`,
    );

    return {
      compacted: true,
      messages: recentMessages,
      summary,
      beforeTokens,
      afterTokens,
    };
  }

  private async generateSummary(messages: AgentMessage[]): Promise<string> {
    // For now, return a simple summary
    // In the future, this could use the LLM to generate a more sophisticated summary
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    return `This conversation contains ${messages.length} messages (${userMessages.length} from user, ${assistantMessages.length} from assistant). The discussion has been summarized to reduce context size while preserving recent context.`;
  }

  private estimateTokens(messages: AgentMessage[]): number {
    // Simple estimation: 1 token ≈ 4 characters
    const text = messages
      .map((m) => {
        if (typeof m.content === "string") {
          return m.content;
        }
        if (Array.isArray(m.content)) {
          return m.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("");
        }
        return "";
      })
      .join("");
    return Math.ceil(text.length / 4);
  }

  private async sendCompactionStart(
    channel?: string,
    userId?: string,
  ): Promise<string> {
    const messageId = ulid();
    this.bus.publishOutbound({
      message: {
        role: "system",
        content: COMPACTION_MESSAGES.START,
        timestamp: Date.now(),
      },
      channel,
      userId,
    });
    return messageId;
  }

  private async sendCompactionSuccess(
    messageId: string,
    beforeTokens: number,
    afterTokens: number,
    channel?: string,
    userId?: string,
  ): Promise<void> {
    const successMessage = COMPACTION_MESSAGES.SUCCESS(
      Math.round(beforeTokens / 1000),
      Math.round(afterTokens / 1000),
    );

    this.bus.publishEdit({
      messageId,
      newContent: successMessage,
      channel,
      userId,
    });
  }

  private async sendCompactionFailure(
    messageId: string,
    channel?: string,
    userId?: string,
  ): Promise<void> {
    this.bus.publishEdit({
      messageId,
      newContent: COMPACTION_MESSAGES.FAILURE,
      channel,
      userId,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
