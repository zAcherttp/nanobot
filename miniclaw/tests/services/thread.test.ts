import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ThreadStorageService } from "../../src/services/thread";
import { FileSystemService } from "../../src/services/fs";
import { ConfigService } from "../../src/services/config";
import { ThreadNotFoundError } from "../../src/errors/base";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("ThreadStorageService", () => {
  let threadService: ThreadStorageService;
  let fsService: FileSystemService;
  let configService: ConfigService;
  let tmpDir: string;

  beforeEach(async () => {
    // Create a real temp directory for integration-style tests
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-test-"));

    fsService = {
      getRootPath: () => tmpDir,
      getConfigPath: () => path.join(tmpDir, "config.json"),
      ensureDir: async (dirPath: string) => {
        await fs.mkdir(dirPath, { recursive: true });
      },
      resolvePath: (...paths: string[]) => path.resolve(tmpDir, ...paths),
    } as unknown as FileSystemService;

    configService = {
      load: vi.fn().mockResolvedValue({
        thread: {
          contextWindowTokens: 65536,
          maxTokens: 8192,
          store: { path: "threads", maxMessages: 500 },
        },
      }),
    } as unknown as ConfigService;

    threadService = new ThreadStorageService(fsService, configService);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Conversation Thread ───────────────────────

  it("should auto-create conversation thread on first access", async () => {
    const thread = await threadService.getConversationThread();

    expect(thread.type).toBe("conversation");
    expect(thread.title).toBe("conversation");
    expect(thread.status).toBe("active");
    expect(thread.messageCount).toBe(0);
    expect(thread.tokenEstimate).toBe(0);
  });

  it("should return the same conversation thread on subsequent access", async () => {
    const first = await threadService.getConversationThread();
    const second = await threadService.getConversationThread();

    expect(first.id).toBe(second.id);
  });

  // ── System Threads ────────────────────────────

  it("should create system thread with correct title format", async () => {
    const thread = await threadService.createSystemThread("dream");

    expect(thread.type).toBe("system");
    expect(thread.title).toMatch(/^system-dream-\d{8}-\d{4}$/);
    expect(thread.status).toBe("active");
  });

  // ── Messages ──────────────────────────────────

  it("should append and read messages", async () => {
    const thread = await threadService.getConversationThread();

    const msg = await threadService.appendMessage(thread.id, {
      role: "user",
      content: "Hello, agent!",
      channel: "telegram",
    });

    expect(msg.id).toBeDefined();
    expect(msg.timestamp).toBeDefined();
    expect(msg.tokenEstimate).toBeGreaterThan(0);

    const messages = await threadService.getMessages(thread.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello, agent!");
    expect(messages[0].channel).toBe("telegram");
  });

  it("should update meta on message append", async () => {
    const thread = await threadService.getConversationThread();

    await threadService.appendMessage(thread.id, {
      role: "user",
      content: "Test message",
    });

    const updated = await threadService.getThread(thread.id);
    expect(updated.messageCount).toBe(1);
    expect(updated.tokenEstimate).toBeGreaterThan(0);
  });

  it("should support message limit", async () => {
    const thread = await threadService.getConversationThread();

    await threadService.appendMessage(thread.id, {
      role: "user",
      content: "First",
    });
    await threadService.appendMessage(thread.id, {
      role: "assistant",
      content: "Second",
    });
    await threadService.appendMessage(thread.id, {
      role: "user",
      content: "Third",
    });

    const limited = await threadService.getMessages(thread.id, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].content).toBe("Second");
    expect(limited[1].content).toBe("Third");
  });

  // ── Listing ───────────────────────────────────

  it("should list threads with type filter", async () => {
    await threadService.getConversationThread();
    await threadService.createSystemThread("dream");

    const all = await threadService.listThreads();
    expect(all.length).toBe(2);

    const convOnly = await threadService.listThreads({
      type: "conversation",
    });
    expect(convOnly.length).toBe(1);
    expect(convOnly[0].type).toBe("conversation");
  });

  // ── Archive ───────────────────────────────────

  it("should archive a thread", async () => {
    const thread = await threadService.createSystemThread("dream");
    await threadService.archiveThread(thread.id);

    const archived = await threadService.getThread(thread.id);
    expect(archived.status).toBe("archived");
  });

  // ── Compaction ────────────────────────────────

  it("should compact conversation thread", async () => {
    // Use a tiny budget so compaction actually truncates
    vi.mocked(configService.load).mockResolvedValue({
      thread: {
        contextWindowTokens: 200,
        maxTokens: 10,
        store: { path: "threads", maxMessages: 500 },
      },
    } as any);

    const thread = await threadService.getConversationThread();

    // Add several messages
    for (let i = 0; i < 10; i++) {
      await threadService.appendMessage(thread.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"x".repeat(100)}`,
      });
    }

    await threadService.compact(
      thread.id,
      "This is a summary of the conversation so far.",
    );

    const compacted = await threadService.getThread(thread.id);
    expect(compacted.status).toBe("compacted");
    expect(compacted.summary).toBe(
      "This is a summary of the conversation so far.",
    );
    expect(compacted.lastCompactedAt).toBeDefined();
    expect(compacted.messageCount).toBeLessThan(10);
  });

  it("should prepend summary in getConversationMessagesWithSummary", async () => {
    const thread = await threadService.getConversationThread();

    await threadService.appendMessage(thread.id, {
      role: "user",
      content: "Hello",
    });

    await threadService.compact(thread.id, "Previous context summary");

    // Append a new message after compaction
    await threadService.appendMessage(thread.id, {
      role: "user",
      content: "New message after compaction",
    });

    const messages = await threadService.getConversationMessagesWithSummary();
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Previous context summary");
  });

  // ── Compaction Trigger ────────────────────────

  it("should return needsCompaction when budget exceeded", async () => {
    // Override config to have a tiny budget
    vi.mocked(configService.load).mockResolvedValue({
      thread: {
        contextWindowTokens: 100,
        maxTokens: 10,
        store: { path: "threads", maxMessages: 500 },
      },
    } as any);

    const thread = await threadService.getConversationThread();

    // Add a message with enough content to exceed budget
    await threadService.appendMessage(thread.id, {
      role: "user",
      content: "x".repeat(1000),
    });

    const result = await threadService.finalizeTurn(thread.id);
    expect(result.needsCompaction).toBe(true);
  });

  it("should defer compaction when tool call is pending", async () => {
    vi.mocked(configService.load).mockResolvedValue({
      thread: {
        contextWindowTokens: 100,
        maxTokens: 10,
        store: { path: "threads", maxMessages: 500 },
      },
    } as any);

    const thread = await threadService.getConversationThread();

    await threadService.appendMessage(thread.id, {
      role: "user",
      content: "x".repeat(1000),
    });

    // Assistant issues a tool call
    await threadService.appendMessage(thread.id, {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "tc_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
        },
      ],
    });

    // No toolResult yet → should defer
    const result = await threadService.finalizeTurn(thread.id);
    expect(result.needsCompaction).toBe(false);
  });

  // ── Error Cases ───────────────────────────────

  it("should throw ThreadNotFoundError for missing thread", async () => {
    await expect(threadService.getThread("nonexistent")).rejects.toThrow(
      ThreadNotFoundError,
    );
  });
});
