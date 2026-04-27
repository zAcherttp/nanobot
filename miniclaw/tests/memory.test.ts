import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MemoryStore, MemoryEntry, DreamCursor } from "../src/services/memory";

// Mock fs module
vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    appendFile: vi.fn(),
    access: vi.fn(),
  },
}));

describe("MemoryStore", () => {
  let memoryStore: MemoryStore;
  const mockMemoryDir = "/test/memory";

  beforeEach(() => {
    memoryStore = new MemoryStore(mockMemoryDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("addMemory", () => {
    it("should add a memory with default parameters", async () => {
      const mockAppendFile = vi.mocked(fs.appendFile).mockResolvedValue();

      await memoryStore.addMemory("Test memory content");

      expect(mockAppendFile).toHaveBeenCalledWith(
        path.join(mockMemoryDir, "memory.jsonl"),
        expect.stringContaining('"content":"Test memory content"'),
        "utf8",
      );
    });

    it("should add a memory with tags", async () => {
      const mockAppendFile = vi.mocked(fs.appendFile).mockResolvedValue();

      await memoryStore.addMemory("Test memory", ["tag1", "tag2"]);

      expect(mockAppendFile).toHaveBeenCalledWith(
        path.join(mockMemoryDir, "memory.jsonl"),
        expect.stringContaining('"tags":["tag1","tag2"]'),
        "utf8",
      );
    });

    it("should add a memory with source 'dream'", async () => {
      const mockAppendFile = vi.mocked(fs.appendFile).mockResolvedValue();

      await memoryStore.addMemory("Dream memory", [], "dream");

      expect(mockAppendFile).toHaveBeenCalledWith(
        path.join(mockMemoryDir, "memory.jsonl"),
        expect.stringContaining('"source":"dream"'),
        "utf8",
      );
    });

    it("should trim content", async () => {
      const mockAppendFile = vi.mocked(fs.appendFile).mockResolvedValue();

      await memoryStore.addMemory("  Test memory  ");

      expect(mockAppendFile).toHaveBeenCalledWith(
        path.join(mockMemoryDir, "memory.jsonl"),
        expect.stringContaining('"content":"Test memory"'),
        "utf8",
      );
    });

    it("should generate unique IDs for each memory", async () => {
      const mockAppendFile = vi.mocked(fs.appendFile).mockResolvedValue();

      await memoryStore.addMemory("Memory 1");
      await memoryStore.addMemory("Memory 2");

      const calls = mockAppendFile.mock.calls;
      const id1 = calls[0][1].match(/"id":"([^"]+)"/)?.[1];
      const id2 = calls[1][1].match(/"id":"([^"]+)"/)?.[1];

      expect(id1).not.toBe(id2);
    });
  });

  describe("getMemories", () => {
    it("should return all memories when no filters provided", async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: "mem1",
          content: "Memory 1",
          tags: ["tag1"],
          createdAt: "2024-01-01T00:00:00.000Z",
          source: "manual",
        },
        {
          id: "mem2",
          content: "Memory 2",
          tags: ["tag2"],
          createdAt: "2024-01-02T00:00:00.000Z",
          source: "dream",
        },
      ];

      vi.mocked(fs.readFile).mockResolvedValue(
        mockMemories.map((m) => JSON.stringify(m)).join("\n"),
      );

      const memories = await memoryStore.getMemories();

      expect(memories).toHaveLength(2);
      expect(memories[0].content).toBe("Memory 1");
      expect(memories[1].content).toBe("Memory 2");
    });

    it("should filter memories by tags", async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: "mem1",
          content: "Memory 1",
          tags: ["tag1", "important"],
          createdAt: "2024-01-01T00:00:00.000Z",
          source: "manual",
        },
        {
          id: "mem2",
          content: "Memory 2",
          tags: ["tag2"],
          createdAt: "2024-01-02T00:00:00.000Z",
          source: "dream",
        },
      ];

      vi.mocked(fs.readFile).mockResolvedValue(
        mockMemories.map((m) => JSON.stringify(m)).join("\n"),
      );

      const memories = await memoryStore.getMemories(["important"]);

      expect(memories).toHaveLength(1);
      expect(memories[0].id).toBe("mem1");
    });

    it("should limit number of memories returned", async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: "mem1",
          content: "Memory 1",
          tags: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          source: "manual",
        },
        {
          id: "mem2",
          content: "Memory 2",
          tags: [],
          createdAt: "2024-01-02T00:00:00.000Z",
          source: "manual",
        },
        {
          id: "mem3",
          content: "Memory 3",
          tags: [],
          createdAt: "2024-01-03T00:00:00.000Z",
          source: "manual",
        },
      ];

      vi.mocked(fs.readFile).mockResolvedValue(
        mockMemories.map((m) => JSON.stringify(m)).join("\n"),
      );

      const memories = await memoryStore.getMemories(undefined, 2);

      expect(memories).toHaveLength(2);
      expect(memories[0].id).toBe("mem2");
      expect(memories[1].id).toBe("mem3");
    });

    it("should return empty array when file doesn't exist", async () => {
      vi.mocked(fs.readFile).mockRejectedValue({ code: "ENOENT" });

      const memories = await memoryStore.getMemories();

      expect(memories).toEqual([]);
    });

    it("should handle malformed JSON lines gracefully", async () => {
      const content =
        JSON.stringify({
          id: "mem1",
          content: "Valid memory",
          tags: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          source: "manual",
        }) +
        "\ninvalid json\n" +
        JSON.stringify({
          id: "mem2",
          content: "Another valid memory",
          tags: [],
          createdAt: "2024-01-02T00:00:00.000Z",
          source: "manual",
        });

      vi.mocked(fs.readFile).mockResolvedValue(content);

      const memories = await memoryStore.getMemories();

      expect(memories).toHaveLength(2);
      expect(memories[0].id).toBe("mem1");
      expect(memories[1].id).toBe("mem2");
    });
  });

  describe("searchMemories", () => {
    it("should search memories by content", async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: "mem1",
          content: "User prefers dark mode",
          tags: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          source: "manual",
        },
        {
          id: "mem2",
          content: "Meeting scheduled for tomorrow",
          tags: [],
          createdAt: "2024-01-02T00:00:00.000Z",
          source: "manual",
        },
      ];

      vi.mocked(fs.readFile).mockResolvedValue(
        mockMemories.map((m) => JSON.stringify(m)).join("\n"),
      );

      const results = await memoryStore.searchMemories("dark mode");

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("mem1");
    });

    it("should search memories by tags", async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: "mem1",
          content: "Memory 1",
          tags: ["preference", "user"],
          createdAt: "2024-01-01T00:00:00.000Z",
          source: "manual",
        },
        {
          id: "mem2",
          content: "Memory 2",
          tags: ["task"],
          createdAt: "2024-01-02T00:00:00.000Z",
          source: "manual",
        },
      ];

      vi.mocked(fs.readFile).mockResolvedValue(
        mockMemories.map((m) => JSON.stringify(m)).join("\n"),
      );

      const results = await memoryStore.searchMemories("preference");

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("mem1");
    });

    it("should be case-insensitive", async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: "mem1",
          content: "User PREFERS dark mode",
          tags: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          source: "manual",
        },
      ];

      vi.mocked(fs.readFile).mockResolvedValue(
        mockMemories.map((m) => JSON.stringify(m)).join("\n"),
      );

      const results = await memoryStore.searchMemories("prefers");

      expect(results).toHaveLength(1);
    });

    it("should return empty array when no matches found", async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: "mem1",
          content: "Memory 1",
          tags: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          source: "manual",
        },
      ];

      vi.mocked(fs.readFile).mockResolvedValue(
        mockMemories.map((m) => JSON.stringify(m)).join("\n"),
      );

      const results = await memoryStore.searchMemories("nonexistent");

      expect(results).toEqual([]);
    });
  });

  describe("readMemory", () => {
    it("should format memories as text", async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: "mem1",
          content: "User prefers dark mode",
          tags: ["preference"],
          createdAt: "2024-01-01T00:00:00.000Z",
          source: "manual",
        },
        {
          id: "mem2",
          content: "Meeting at 2pm",
          tags: [],
          createdAt: "2024-01-02T00:00:00.000Z",
          source: "manual",
        },
      ];

      vi.mocked(fs.readFile).mockResolvedValue(
        mockMemories.map((m) => JSON.stringify(m)).join("\n"),
      );

      const text = await memoryStore.readMemory();

      expect(text).toContain("User prefers dark mode [preference]");
      expect(text).toContain("Meeting at 2pm");
    });

    it("should return empty string when no memories", async () => {
      vi.mocked(fs.readFile).mockRejectedValue({ code: "ENOENT" });

      const text = await memoryStore.readMemory();

      expect(text).toBe("");
    });
  });

  describe("getMemoryContext", () => {
    it("should return null when no memories exist", async () => {
      vi.mocked(fs.readFile).mockRejectedValue({ code: "ENOENT" });

      const context = await memoryStore.getMemoryContext();

      expect(context).toBeNull();
    });

    it("should return formatted context when memories exist", async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: "mem1",
          content: "User prefers dark mode",
          tags: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          source: "manual",
        },
      ];

      vi.mocked(fs.readFile).mockResolvedValue(
        mockMemories.map((m) => JSON.stringify(m)).join("\n"),
      );

      const context = await memoryStore.getMemoryContext();

      expect(context).toContain("## Long-term Memory");
      expect(context).toContain("User prefers dark mode");
    });
  });

  describe("getLastDreamCursor", () => {
    it("should return null when cursor file doesn't exist", async () => {
      vi.mocked(fs.readFile).mockRejectedValue({ code: "ENOENT" });

      const cursor = await memoryStore.getLastDreamCursor();

      expect(cursor).toBeNull();
    });

    it("should return cursor when file exists", async () => {
      const mockCursor: DreamCursor = {
        lastProcessedAt: "2024-01-01T00:00:00.000Z",
        lastMessageId: "msg123",
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockCursor));

      const cursor = await memoryStore.getLastDreamCursor();

      expect(cursor).toEqual(mockCursor);
    });

    it("should return null on read error", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("Read error"));

      const cursor = await memoryStore.getLastDreamCursor();

      expect(cursor).toBeNull();
    });
  });

  describe("updateCursor", () => {
    it("should update cursor file", async () => {
      const mockWriteFile = vi.mocked(fs.writeFile).mockResolvedValue();

      const cursor: DreamCursor = {
        lastProcessedAt: "2024-01-01T00:00:00.000Z",
        lastMessageId: "msg123",
      };

      await memoryStore.updateCursor(cursor);

      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join(mockMemoryDir, "cursor.json"),
        JSON.stringify(cursor, null, 2),
        "utf8",
      );
    });
  });

  describe("readUnprocessedHistory", () => {
    it("should return all messages when no cursor exists", async () => {
      const messages = [
        { id: "msg1", timestamp: 1000 },
        { id: "msg2", timestamp: 2000 },
      ];

      vi.mocked(fs.readFile).mockRejectedValue({ code: "ENOENT" });

      const unprocessed = await memoryStore.readUnprocessedHistory(messages);

      expect(unprocessed).toEqual(messages);
    });

    it("should filter messages after cursor timestamp", async () => {
      const messages = [
        { id: "msg1", timestamp: 1000 },
        { id: "msg2", timestamp: 2000 },
        { id: "msg3", timestamp: 3000 },
      ];

      const cursor: DreamCursor = {
        lastProcessedAt: "1970-01-01T00:00:01.500Z", // 1500ms
        lastMessageId: "msg1",
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(cursor));

      const unprocessed = await memoryStore.readUnprocessedHistory(messages);

      expect(unprocessed).toHaveLength(2);
      expect(unprocessed[0].id).toBe("msg2");
      expect(unprocessed[1].id).toBe("msg3");
    });

    it("should return empty array when all messages are processed", async () => {
      const messages = [
        { id: "msg1", timestamp: 1000 },
        { id: "msg2", timestamp: 2000 },
      ];

      const cursor: DreamCursor = {
        lastProcessedAt: "1970-01-01T00:00:03.000Z", // 3000ms
        lastMessageId: "msg2",
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(cursor));

      const unprocessed = await memoryStore.readUnprocessedHistory(messages);

      expect(unprocessed).toEqual([]);
    });
  });
});
