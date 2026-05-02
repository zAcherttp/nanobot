import { beforeEach, describe, expect, it, vi } from "vitest";
import { DreamCronJob } from "../src/agent/dream-cron";

describe("DreamCronJob", () => {
  let mockMemoryStore: {
    readUnprocessedHistory: ReturnType<typeof vi.fn>;
    updateCursor: ReturnType<typeof vi.fn>;
  };
  let mockCronService: {
    addJob: ReturnType<typeof vi.fn>;
    removeJob: ReturnType<typeof vi.fn>;
  };
  let mockProfileService: {
    addPreference: ReturnType<typeof vi.fn>;
    addStableFact: ReturnType<typeof vi.fn>;
  };
  let mockGoalService: {
    listGoals: ReturnType<typeof vi.fn>;
    recordProgress: ReturnType<typeof vi.fn>;
  };
  let mockWorkspaceMemoryService: {
    recordEntry: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockMemoryStore = {
      readUnprocessedHistory: vi.fn(),
      updateCursor: vi.fn(),
    };
    mockCronService = {
      addJob: vi.fn().mockResolvedValue({ id: "job123" }),
      removeJob: vi.fn().mockResolvedValue(true),
    };
    mockProfileService = {
      addPreference: vi.fn(),
      addStableFact: vi.fn(),
      getDocument: vi.fn().mockResolvedValue({
        profile: {},
        stableFacts: [],
        preferences: [],
      }),
    } as any;
    mockGoalService = {
      listGoals: vi.fn().mockResolvedValue([]),
      recordProgress: vi.fn(),
    };
    mockWorkspaceMemoryService = {
      recordEntry: vi.fn(),
    };
  });

  it("registers the dream job with the cron service", async () => {
    const job = new DreamCronJob(
      mockMemoryStore as any,
      mockCronService as any,
      async () => [],
      mockProfileService as any,
      mockGoalService as any,
      mockWorkspaceMemoryService as any,
      { schedule: "0 2 * * *" },
    );

    await job.register();

    expect(mockCronService.addJob).toHaveBeenCalledWith(
      "dream-consolidation",
      { kind: "cron", expr: "0 2 * * *" },
      "Running dream consolidation",
      false,
    );
    expect(job.getJobId()).toBe("job123");
  });

  it("runs consolidation on unprocessed messages and updates the cursor", async () => {
    const messages = [
      { id: "1", role: "user", content: "I prefer dark mode", timestamp: 1 },
      { id: "2", role: "assistant", content: "Noted", timestamp: 2 },
      { id: "3", role: "user", content: "I like short replies", timestamp: 3 },
      { id: "4", role: "assistant", content: "OK", timestamp: 4 },
      { id: "5", role: "user", content: "Hello", timestamp: 5 },
    ];
    mockMemoryStore.readUnprocessedHistory.mockResolvedValue(messages);

    const job = new DreamCronJob(
      mockMemoryStore as any,
      mockCronService as any,
      async () => messages,
      mockProfileService as any,
      mockGoalService as any,
      mockWorkspaceMemoryService as any,
    );

    await job.run();

    expect(mockMemoryStore.readUnprocessedHistory).toHaveBeenCalledWith(messages);
    expect(mockMemoryStore.updateCursor).toHaveBeenCalledWith({
      lastProcessedAt: new Date(5).toISOString(),
      lastMessageId: "5",
    });
  });

  it("does not update the cursor when nothing new exists", async () => {
    mockMemoryStore.readUnprocessedHistory.mockResolvedValue([]);

    const job = new DreamCronJob(
      mockMemoryStore as any,
      mockCronService as any,
      async () => [],
      mockProfileService as any,
      mockGoalService as any,
      mockWorkspaceMemoryService as any,
    );

    await job.run();

    expect(mockMemoryStore.updateCursor).not.toHaveBeenCalled();
  });
});
