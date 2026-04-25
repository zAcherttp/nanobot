import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ulid } from "ulid";
import { FileSystemService } from "./fs";
import { ConfigService } from "./config";
import { estimateMessageTokens } from "@/utils/tokens";
import { logger } from "@/utils/logger";
import {
  ThreadNotFoundError,
  ThreadCorruptedError,
  ThreadWriteError,
} from "@/errors/base";
import type {
  ThreadMeta,
  ThreadMessage,
  ThreadType,
  ThreadStatus,
  NewMessage,
} from "@/thread/schema";
import { ThreadMetaSchema, ThreadMessageSchema } from "@/thread/schema";

// ─── Helpers ──────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function systemTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

// ─── Service ──────────────────────────────────────────

export class ThreadStorageService {
  private readonly threadsDir: string;

  constructor(
    private readonly fsService: FileSystemService,
    private readonly configService: ConfigService,
  ) {
    this.threadsDir = this.fsService.resolvePath("threads");
  }

  // ── Conversation Thread (singleton) ────────────────

  /**
   * Get the conversation thread, auto-creating it on first access.
   */
  public async getConversationThread(): Promise<ThreadMeta> {
    const threads = await this.listThreads({ type: "conversation" });
    const active = threads.find(
      (t) => t.status === "active" || t.status === "compacted",
    );

    if (active) return active;

    // Auto-create
    return this.createThread("conversation", "conversation");
  }

  /**
   * Get conversation messages with summary prepended as a system message.
   * Convenience method for building the LLM context window.
   */
  public async getConversationMessagesWithSummary(): Promise<ThreadMessage[]> {
    const thread = await this.getConversationThread();
    const messages = await this.getMessages(thread.id);

    if (thread.summary) {
      const summaryMsg: ThreadMessage = {
        id: "summary",
        role: "system",
        content: `[Previous conversation summary]\n${thread.summary}`,
        timestamp: thread.lastCompactedAt ?? thread.createdAt,
      };
      return [summaryMsg, ...messages];
    }

    return messages;
  }

  // ── System Threads ────────────────────────────────

  /**
   * Create an ephemeral system thread for background tasks.
   * Title format: "system-{task}-{YYYYMMDD-HHmm}"
   */
  public async createSystemThread(task: string): Promise<ThreadMeta> {
    const title = `system-${task}-${systemTimestamp()}`;
    return this.createThread("system", title);
  }

  // ── CRUD ──────────────────────────────────────────

  public async getThread(threadId: string): Promise<ThreadMeta> {
    const metaPath = this.getMetaPath(threadId);
    try {
      const raw = await fs.readFile(metaPath, "utf8");
      const parsed = ThreadMetaSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new ThreadCorruptedError(threadId, parsed.error);
      }
      return parsed.data;
    } catch (error: any) {
      if (error instanceof ThreadCorruptedError) throw error;
      if (error.code === "ENOENT") {
        throw new ThreadNotFoundError(threadId);
      }
      throw new ThreadCorruptedError(threadId, error);
    }
  }

  public async listThreads(filter?: {
    type?: ThreadType;
    status?: ThreadStatus;
  }): Promise<ThreadMeta[]> {
    try {
      await fs.access(this.threadsDir);
    } catch {
      return [];
    }

    const entries = await fs.readdir(this.threadsDir, {
      withFileTypes: true,
    });

    const threads: ThreadMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = await this.getThread(entry.name);
        if (filter?.type && meta.type !== filter.type) continue;
        if (filter?.status && meta.status !== filter.status) continue;
        threads.push(meta);
      } catch {
        // Skip corrupted threads during listing
      }
    }

    // Sort by updatedAt descending (most recent first)
    threads.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return threads;
  }

  public async getMessages(
    threadId: string,
    opts?: { limit?: number },
  ): Promise<ThreadMessage[]> {
    const messagesPath = this.getMessagesPath(threadId);
    try {
      const raw = await fs.readFile(messagesPath, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);

      let messages: ThreadMessage[] = [];
      for (const line of lines) {
        try {
          const parsed = ThreadMessageSchema.parse(JSON.parse(line));
          messages.push(parsed);
        } catch {
          // Skip corrupted lines
        }
      }

      if (opts?.limit && opts.limit > 0) {
        messages = messages.slice(-opts.limit);
      }

      return messages;
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw new ThreadCorruptedError(threadId, error);
    }
  }

  // ── Write ─────────────────────────────────────────

  public async appendMessage(
    threadId: string,
    msg: NewMessage,
  ): Promise<ThreadMessage> {
    // Ensure thread exists
    const meta = await this.getThread(threadId);

    const fullMessage: ThreadMessage = {
      ...msg,
      id: ulid(),
      timestamp: nowISO(),
    };

    // Estimate tokens
    fullMessage.tokenEstimate = estimateMessageTokens(fullMessage);

    // Append to JSONL
    const messagesPath = this.getMessagesPath(threadId);
    try {
      await fs.appendFile(
        messagesPath,
        JSON.stringify(fullMessage) + "\n",
        "utf8",
      );
    } catch (error) {
      throw new ThreadWriteError(threadId, error);
    }

    // Update meta
    await this.updateMeta(threadId, {
      updatedAt: nowISO(),
      messageCount: meta.messageCount + 1,
      tokenEstimate: meta.tokenEstimate + (fullMessage.tokenEstimate ?? 0),
    });

    return fullMessage;
  }

  /**
   * Finalize a turn: check if compaction is needed.
   * Returns { needsCompaction: true } if token budget is exceeded.
   * ThreadStorageService only TRIGGERS — actual summarization is external.
   */
  public async finalizeTurn(
    threadId: string,
  ): Promise<{ needsCompaction: boolean }> {
    const meta = await this.getThread(threadId);

    // Only conversation threads get auto-compaction
    if (meta.type !== "conversation") {
      return { needsCompaction: false };
    }

    const config = await this.configService.load();
    const budget =
      config.thread.contextWindowTokens - config.thread.maxTokens - 1024; // safety buffer

    if (meta.tokenEstimate <= budget) {
      return { needsCompaction: false };
    }

    // Check for pending tool calls without matching results
    const messages = await this.getMessages(threadId);
    if (this.hasPendingToolCalls(messages)) {
      return { needsCompaction: false };
    }

    return { needsCompaction: true };
  }

  // ── Lifecycle ─────────────────────────────────────

  public async archiveThread(threadId: string): Promise<void> {
    await this.updateMeta(threadId, {
      status: "archived",
      updatedAt: nowISO(),
    });
  }

  /**
   * Apply compaction: store summary, truncate old messages, keep recent.
   */
  public async compact(threadId: string, summary: string): Promise<void> {
    const meta = await this.getThread(threadId);
    const messages = await this.getMessages(threadId);

    // Keep only the most recent messages that fit in ~25% of the budget
    const config = await this.configService.load();
    const keepBudget = Math.floor(
      (config.thread.contextWindowTokens - config.thread.maxTokens - 1024) *
        0.25,
    );

    let keepTokens = 0;
    let keepFrom = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = messages[i].tokenEstimate ?? 0;
      if (keepTokens + tokens > keepBudget) break;
      keepTokens += tokens;
      keepFrom = i;
    }

    const keptMessages = messages.slice(keepFrom);

    // Rewrite messages.jsonl with only kept messages
    const messagesPath = this.getMessagesPath(threadId);
    const content = keptMessages.map((m) => JSON.stringify(m)).join("\n");
    await this.atomicWrite(messagesPath, content + "\n");

    // Update meta
    const now = nowISO();
    await this.updateMeta(threadId, {
      status: "compacted",
      summary,
      lastCompactedAt: now,
      updatedAt: now,
      messageCount: keptMessages.length,
      tokenEstimate: keepTokens,
    });

    logger.info(
      `Compacted thread ${threadId}: ${messages.length} → ${keptMessages.length} messages`,
    );
  }

  // ── Private ───────────────────────────────────────

  private async createThread(
    type: ThreadType,
    title: string,
  ): Promise<ThreadMeta> {
    const id = ulid();
    const now = nowISO();

    const meta: ThreadMeta = {
      id,
      type,
      title,
      status: "active",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      tokenEstimate: 0,
    };

    const threadDir = path.join(this.threadsDir, id);
    await this.fsService.ensureDir(threadDir);

    // Write meta.json atomically
    await this.atomicWrite(
      path.join(threadDir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );

    // Create empty messages.jsonl
    await fs.writeFile(path.join(threadDir, "messages.jsonl"), "", "utf8");

    return meta;
  }

  private async updateMeta(
    threadId: string,
    update: Partial<ThreadMeta>,
  ): Promise<void> {
    const meta = await this.getThread(threadId);
    const updated = { ...meta, ...update };

    await this.atomicWrite(
      this.getMetaPath(threadId),
      JSON.stringify(updated, null, 2),
    );
  }

  private hasPendingToolCalls(messages: ThreadMessage[]): boolean {
    const pendingCallIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === "assistant" && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          pendingCallIds.add(tc.id);
        }
      }
      if (msg.role === "toolResult" && msg.toolCallId) {
        pendingCallIds.delete(msg.toolCallId);
      }
    }

    return pendingCallIds.size > 0;
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const tmpPath = `${filePath}.${ulid()}.tmp`;
    try {
      await fs.writeFile(tmpPath, content, "utf8");
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      // Clean up temp file on failure
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  private getMetaPath(threadId: string): string {
    return path.join(this.threadsDir, threadId, "meta.json");
  }

  private getMessagesPath(threadId: string): string {
    return path.join(this.threadsDir, threadId, "messages.jsonl");
  }
}
