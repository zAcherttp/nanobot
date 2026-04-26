import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPACTION_MESSAGES,
  CompactionService,
} from "../src/agent/compaction";
import { MessageBus } from "../src/bus/index";
import type { AgentMessage } from "../src/bus/types";
import type { PersistenceService } from "../src/services/persistence";

describe("CompactionService", () => {
  let bus: MessageBus;
  let persistence: PersistenceService;
  let compaction: CompactionService;

  beforeEach(() => {
    bus = new MessageBus();
    persistence = {
      getMessages: vi.fn(),
      saveMessages: vi.fn(),
      updateMeta: vi.fn(),
    } as unknown as PersistenceService;

    compaction = new CompactionService(
      bus,
      {
        thresholdRatio: 0.8,
        keepRecentMessages: 2,
        maxRetries: 3,
        retryDelayMs: 100,
      },
      persistence,
    );

    // Mock generateSummary to avoid LLM calls
    vi.spyOn(compaction as any, "generateSummary").mockResolvedValue(
      "Test summary of conversation",
    );
  });

  describe("compactIfNeeded", () => {
    it("should not compact when token count is below threshold", async () => {
      const messages = createTestMessages(80); // 80 tokens, threshold is 80% of 128 = 102.4
      const result = await compaction.compactIfNeeded(
        messages,
        128,
        "conversation",
      );

      expect(result.compacted).toBe(false);
      expect(result.messages).toEqual(messages);
      expect(result.summary).toBeUndefined();
    });

    it("should compact when token count exceeds threshold", async () => {
      const messages = createTestMessages(150); // 150 tokens, threshold is 80% of 128 = 102.4
      const result = await compaction.compactIfNeeded(
        messages,
        128,
        "conversation",
      );

      expect(result.compacted).toBe(true);
      expect(result.messages.length).toBe(2); // 2 recent messages (no summary message)
      expect(result.summary).toBeDefined();
      expect(result.beforeTokens).toBeGreaterThan(100);
      expect(result.afterTokens).toBeLessThan(result.beforeTokens!);
    });

    it("should send start message when compaction begins", async () => {
      const messages = createTestMessages(150);
      const publishSpy = vi.spyOn(bus, "publishOutbound");

      await compaction.compactIfNeeded(messages, 128, "conversation");

      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            content: COMPACTION_MESSAGES.START,
          }),
        }),
      );
    });

    it("should send edit message on success", async () => {
      const messages = createTestMessages(150);
      const publishEditSpy = vi.spyOn(bus, "publishEdit");

      await compaction.compactIfNeeded(messages, 128, "conversation");

      expect(publishEditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          newContent: expect.stringContaining("Context compacted!"),
        }),
      );
    });

    it("should retry on failure", async () => {
      const messages = createTestMessages(150);
      const performCompactionSpy = vi
        .spyOn(compaction as any, "performCompaction")
        .mockRejectedValueOnce(new Error("Test error"))
        .mockResolvedValueOnce({
          compacted: true,
          messages: [],
          summary: "test",
          beforeTokens: 150,
          afterTokens: 50,
        });

      const result = await compaction.compactIfNeeded(
        messages,
        128,
        "conversation",
      );

      expect(performCompactionSpy).toHaveBeenCalledTimes(2);
      expect(result.compacted).toBe(true);
    });

    it("should fail after max retries", async () => {
      const messages = createTestMessages(150);
      vi.spyOn(compaction as any, "performCompaction").mockRejectedValue(
        new Error("Test error"),
      );

      await expect(
        compaction.compactIfNeeded(messages, 128, "conversation"),
      ).rejects.toThrow("Test error");
    });

    it("should not compact when not enough messages", async () => {
      const messages = createTestMessages(50, 1); // Only 1 message
      const result = await compaction.compactIfNeeded(
        messages,
        128,
        "conversation",
      );

      expect(result.compacted).toBe(false);
      expect(result.messages).toEqual(messages);
    });
  });

  describe("estimateTokens", () => {
    it("should estimate tokens correctly", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello world" }],
          timestamp: Date.now(),
        },
      ];

      const tokens = (compaction as any).estimateTokens(messages);
      expect(tokens).toBeGreaterThan(0);
    });

    it("should handle empty message list", () => {
      const tokens = (compaction as any).estimateTokens([]);
      expect(tokens).toBe(0);
    });
  });
});

describe("CompactionService.generateSummary", () => {
  it("should generate summary from messages", async () => {
    const bus = new MessageBus();
    const persistence = {
      getMessages: vi.fn(),
      saveMessages: vi.fn(),
      updateMeta: vi.fn(),
    } as unknown as PersistenceService;

    const compaction = new CompactionService(
      bus,
      {
        thresholdRatio: 0.8,
        keepRecentMessages: 2,
        maxRetries: 3,
        retryDelayMs: 100,
      },
      persistence,
    );

    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
        timestamp: Date.now(),
      },
    ];

    const summary = await (compaction as any).generateSummary(messages);
    expect(summary).toContain("2 messages");
  });
});

function createTestMessages(
  tokenCount: number,
  messageCount?: number,
): AgentMessage[] {
  // Each message when JSON serialized is about 150 characters = ~37 tokens
  const tokensPerMessage = 37;
  const count = messageCount || Math.ceil(tokenCount / tokensPerMessage);
  const messages: AgentMessage[] = [];

  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: "x".repeat(100) }],
      timestamp: Date.now() + i * 1000,
    });
  }

  return messages;
}
