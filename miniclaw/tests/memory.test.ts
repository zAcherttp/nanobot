import { describe, it, expect, beforeEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MemoryStore, DreamCursor } from "../src/services/memory";

vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    appendFile: vi.fn(),
    mkdir: vi.fn(),
  },
}));

describe("MemoryStore", () => {
  let memoryStore: MemoryStore;
  const mockMemoryDir = "/test/memory";

  beforeEach(() => {
    memoryStore = new MemoryStore(mockMemoryDir);
    vi.clearAllMocks();
  });

  it("appends archive entries to history.jsonl", async () => {
    await memoryStore.appendArchiveEntry({ summary: "Older turns compacted" });

    expect(vi.mocked(fs.mkdir)).toHaveBeenCalledWith(
      path.dirname(path.join(mockMemoryDir, "history.jsonl")),
      {
        recursive: true,
      },
    );
    expect(vi.mocked(fs.appendFile)).toHaveBeenCalledWith(
      path.join(mockMemoryDir, "history.jsonl"),
      expect.stringContaining('"summary":"Older turns compacted"'),
      "utf8",
    );
  });

  it("returns null when the cursor file does not exist", async () => {
    vi.mocked(fs.readFile).mockRejectedValue({ code: "ENOENT" });

    const cursor = await memoryStore.getLastDreamCursor();

    expect(cursor).toBeNull();
  });

  it("reads the saved dream cursor", async () => {
    const mockCursor: DreamCursor = {
      lastProcessedAt: "2024-01-01T00:00:00.000Z",
      lastMessageId: "msg123",
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockCursor));

    const cursor = await memoryStore.getLastDreamCursor();

    expect(cursor).toEqual(mockCursor);
  });

  it("writes the updated cursor", async () => {
    const cursor: DreamCursor = {
      lastProcessedAt: "2024-01-01T00:00:00.000Z",
      lastMessageId: "msg123",
    };

    await memoryStore.updateCursor(cursor);

    expect(vi.mocked(fs.mkdir)).toHaveBeenCalledWith(
      path.dirname(path.join(mockMemoryDir, "cursor.json")),
      {
        recursive: true,
      },
    );
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(
      path.join(mockMemoryDir, "cursor.json"),
      JSON.stringify(cursor, null, 2),
      "utf8",
    );
  });

  it("returns all messages as unprocessed when no cursor exists", async () => {
    const messages = [
      { id: "msg1", timestamp: 1000 },
      { id: "msg2", timestamp: 2000 },
    ];
    vi.mocked(fs.readFile).mockRejectedValue({ code: "ENOENT" });

    const unprocessed = await memoryStore.readUnprocessedHistory(messages);

    expect(unprocessed).toEqual(messages);
  });

  it("filters messages that were already processed", async () => {
    const messages = [
      { id: "msg1", timestamp: 1000 },
      { id: "msg2", timestamp: 2000 },
      { id: "msg3", timestamp: 3000 },
    ];
    const cursor: DreamCursor = {
      lastProcessedAt: "1970-01-01T00:00:01.500Z",
      lastMessageId: "msg1",
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(cursor));

    const unprocessed = await memoryStore.readUnprocessedHistory(messages);

    expect(unprocessed).toEqual([
      { id: "msg2", timestamp: 2000 },
      { id: "msg3", timestamp: 3000 },
    ]);
  });
});
