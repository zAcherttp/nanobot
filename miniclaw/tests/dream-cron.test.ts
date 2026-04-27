import { describe, it, expect, beforeEach, vi } from "vitest";
import { DreamCronJob } from "../src/agent/dream-cron";
import { MemoryStore, DreamCursor } from "../src/services/memory";
import { CronService } from "../src/services/cron";

// Mock dependencies
vi.mock("../src/services/memory", () => ({
  MemoryStore: vi.fn().mockImplementation(() => ({
    readUnprocessedHistory: vi.fn(),
    updateCursor: vi.fn(),
  })),
}));

vi.mock("../src/services/cron", () => ({
  CronService: vi.fn().mockImplementation(() => ({
    addJob: vi.fn(),
    removeJob: vi.fn(),
  })),
}));

describe("DreamCronJob", () => {
  let dreamCronJob: DreamCronJob;
  let mockMemoryStore: MemoryStore;
  let mockCronService: CronService;
  let mockGetMessages: () => Promise<Array<{ id: string; timestamp: number }>>;

  beforeEach(() => {
    mockMemoryStore = new MemoryStore("/test/memory");
    mockCronService = new CronService("/test/cron/store.json", vi.fn());
    mockGetMessages = vi.fn();

    dreamCronJob = new DreamCronJob(
      mockMemoryStore,
      mockCronService,
      mockGetMessages,
    );

    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should use default schedule", () => {
      expect(dreamCronJob).toBeDefined();
    });

    it("should use custom schedule", () => {
      const customJob = new DreamCronJob(
        mockMemoryStore,
        mockCronService,
        mockGetMessages,
        { schedule: "0 3 * * *" },
      );

      expect(customJob).toBeDefined();
    });

    it("should use custom maxEntriesPerDream", () => {
      const customJob = new DreamCronJob(
        mockMemoryStore,
        mockCronService,
        mockGetMessages,
        { maxEntriesPerDream: 20 },
      );

      expect(customJob).toBeDefined();
    });

    it("should use custom minMessagesForDream", () => {
      const customJob = new DreamCronJob(
        mockMemoryStore,
        mockCronService,
        mockGetMessages,
        { minMessagesForDream: 10 },
      );

      expect(customJob).toBeDefined();
    });
  });

  describe("register", () => {
    it("should register dream job with cron service", async () => {
      const mockJob = {
        id: "job123",
        name: "dream-consolidation",
        enabled: true,
        schedule: { cronExpr: "0 2 * * *" },
        payload: {
          kind: "agent_turn",
          message: "Running dream consolidation",
          deliver: false,
        },
        state: {
          nextRunAtMs: Date.now() + 86400000,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          runHistory: [],
        },
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        deleteAfterRun: false,
      };

      vi.mocked(mockCronService.addJob).mockResolvedValue(mockJob);

      await dreamCronJob.register();

      expect(mockCronService.addJob).toHaveBeenCalledWith(
        "dream-consolidation",
        { cronExpr: "0 2 * * *" },
        "Running dream consolidation",
        false,
      );
    });

    it("should set jobId after registration", async () => {
      const mockJob = {
        id: "job123",
        name: "dream-consolidation",
        enabled: true,
        schedule: { cronExpr: "0 2 * * *" },
        payload: {
          kind: "agent_turn",
          message: "Running dream consolidation",
          deliver: false,
        },
        state: {
          nextRunAtMs: Date.now() + 86400000,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          runHistory: [],
        },
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        deleteAfterRun: false,
      };

      vi.mocked(mockCronService.addJob).mockResolvedValue(mockJob);

      await dreamCronJob.register();

      expect(dreamCronJob.getJobId()).toBe("job123");
    });

    it("should not register if already registered", async () => {
      const mockJob = {
        id: "job123",
        name: "dream-consolidation",
        enabled: true,
        schedule: { cronExpr: "0 2 * * *" },
        payload: {
          kind: "agent_turn",
          message: "Running dream consolidation",
          deliver: false,
        },
        state: {
          nextRunAtMs: Date.now() + 86400000,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          runHistory: [],
        },
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        deleteAfterRun: false,
      };

      vi.mocked(mockCronService.addJob).mockResolvedValue(mockJob);

      await dreamCronJob.register();
      await dreamCronJob.register();

      expect(mockCronService.addJob).toHaveBeenCalledTimes(1);
    });

    it("should use custom schedule when provided", async () => {
      const customJob = new DreamCronJob(
        mockMemoryStore,
        mockCronService,
        mockGetMessages,
        { schedule: "0 3 * * *" },
      );

      const mockJob = {
        id: "job123",
        name: "dream-consolidation",
        enabled: true,
        schedule: { cronExpr: "0 3 * * *" },
        payload: {
          kind: "agent_turn",
          message: "Running dream consolidation",
          deliver: false,
        },
        state: {
          nextRunAtMs: Date.now() + 86400000,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          runHistory: [],
        },
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        deleteAfterRun: false,
      };

      vi.mocked(mockCronService.addJob).mockResolvedValue(mockJob);

      await customJob.register();

      expect(mockCronService.addJob).toHaveBeenCalledWith(
        "dream-consolidation",
        { cronExpr: "0 3 * * *" },
        "Running dream consolidation",
        false,
      );
    });
  });

  describe("run", () => {
    it("should process unprocessed messages", async () => {
      const messages = [
        { id: "msg1", timestamp: 1000 },
        { id: "msg2", timestamp: 2000 },
        { id: "msg3", timestamp: 3000 },
      ];

      vi.mocked(mockGetMessages).mockResolvedValue(messages);
      vi.mocked(mockMemoryStore.readUnprocessedHistory).mockResolvedValue(
        messages,
      );

      await dreamCronJob.run();

      expect(mockMemoryStore.readUnprocessedHistory).toHaveBeenCalledWith(
        messages,
      );
    });

    it("should update cursor after processing", async () => {
      const messages = [
        { id: "msg1", timestamp: 1000 },
        { id: "msg2", timestamp: 2000 },
      ];

      vi.mocked(mockGetMessages).mockResolvedValue(messages);
      vi.mocked(mockMemoryStore.readUnprocessedHistory).mockResolvedValue(
        messages,
      );

      await dreamCronJob.run();

      expect(mockMemoryStore.updateCursor).toHaveBeenCalledWith({
        lastProcessedAt: expect.any(String),
        lastMessageId: "msg2",
      });
    });

    it("should handle no new messages", async () => {
      const messages = [
        { id: "msg1", timestamp: 1000 },
        { id: "msg2", timestamp: 2000 },
      ];

      vi.mocked(mockGetMessages).mockResolvedValue(messages);
      vi.mocked(mockMemoryStore.readUnprocessedHistory).mockResolvedValue([]);

      await dreamCronJob.run();

      expect(mockMemoryStore.updateCursor).not.toHaveBeenCalled();
    });

    it("should handle empty message list", async () => {
      vi.mocked(mockGetMessages).mockResolvedValue([]);
      vi.mocked(mockMemoryStore.readUnprocessedHistory).mockResolvedValue([]);

      await dreamCronJob.run();

      expect(mockMemoryStore.updateCursor).not.toHaveBeenCalled();
    });

    it("should handle errors during run", async () => {
      vi.mocked(mockGetMessages).mockRejectedValue(
        new Error("Failed to get messages"),
      );

      await expect(dreamCronJob.run()).rejects.toThrow(
        "Failed to get messages",
      );
    });
  });

  describe("unregister", () => {
    it("should unregister dream job", async () => {
      const mockJob = {
        id: "job123",
        name: "dream-consolidation",
        enabled: true,
        schedule: { cronExpr: "0 2 * * *" },
        payload: {
          kind: "agent_turn",
          message: "Running dream consolidation",
          deliver: false,
        },
        state: {
          nextRunAtMs: Date.now() + 86400000,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          runHistory: [],
        },
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        deleteAfterRun: false,
      };

      vi.mocked(mockCronService.addJob).mockResolvedValue(mockJob);

      await dreamCronJob.register();
      await dreamCronJob.unregister();

      expect(mockCronService.removeJob).toHaveBeenCalledWith("job123");
      expect(dreamCronJob.getJobId()).toBeNull();
    });

    it("should handle unregister when not registered", async () => {
      await dreamCronJob.unregister();

      expect(mockCronService.removeJob).not.toHaveBeenCalled();
    });
  });

  describe("getJobId", () => {
    it("should return null when not registered", () => {
      expect(dreamCronJob.getJobId()).toBeNull();
    });

    it("should return job ID after registration", async () => {
      const mockJob = {
        id: "job123",
        name: "dream-consolidation",
        enabled: true,
        schedule: { cronExpr: "0 2 * * *" },
        payload: {
          kind: "agent_turn",
          message: "Running dream consolidation",
          deliver: false,
        },
        state: {
          nextRunAtMs: Date.now() + 86400000,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          runHistory: [],
        },
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        deleteAfterRun: false,
      };

      vi.mocked(mockCronService.addJob).mockResolvedValue(mockJob);

      await dreamCronJob.register();

      expect(dreamCronJob.getJobId()).toBe("job123");
    });
  });

  describe("integration scenarios", () => {
    it("should handle full lifecycle: register, run, unregister", async () => {
      const mockJob = {
        id: "job123",
        name: "dream-consolidation",
        enabled: true,
        schedule: { cronExpr: "0 2 * * *" },
        payload: {
          kind: "agent_turn",
          message: "Running dream consolidation",
          deliver: false,
        },
        state: {
          nextRunAtMs: Date.now() + 86400000,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          runHistory: [],
        },
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        deleteAfterRun: false,
      };

      vi.mocked(mockCronService.addJob).mockResolvedValue(mockJob);

      // Register
      await dreamCronJob.register();
      expect(dreamCronJob.getJobId()).toBe("job123");

      // Run
      const messages = [
        { id: "msg1", timestamp: 1000 },
        { id: "msg2", timestamp: 2000 },
      ];

      vi.mocked(mockGetMessages).mockResolvedValue(messages);
      vi.mocked(mockMemoryStore.readUnprocessedHistory).mockResolvedValue(
        messages,
      );

      await dreamCronJob.run();
      expect(mockMemoryStore.updateCursor).toHaveBeenCalled();

      // Unregister
      await dreamCronJob.unregister();
      expect(dreamCronJob.getJobId()).toBeNull();
    });

    it("should handle multiple runs with cursor updates", async () => {
      const messages = [
        { id: "msg1", timestamp: 1000 },
        { id: "msg2", timestamp: 2000 },
        { id: "msg3", timestamp: 3000 },
      ];

      vi.mocked(mockGetMessages).mockResolvedValue(messages);

      // First run - process all messages
      vi.mocked(mockMemoryStore.readUnprocessedHistory).mockResolvedValueOnce(
        messages,
      );
      await dreamCronJob.run();

      const firstCall = (mockMemoryStore.updateCursor as any).mock.calls[0];
      expect(firstCall[0].lastMessageId).toBe("msg3");

      // Second run - no new messages
      vi.mocked(mockMemoryStore.readUnprocessedHistory).mockResolvedValueOnce(
        [],
      );
      await dreamCronJob.run();

      expect(mockMemoryStore.updateCursor).toHaveBeenCalledTimes(1);
    });
  });
});
