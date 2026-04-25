import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ulid } from "ulid";
import { FileSystemService } from "./fs";
import { ConfigService } from "./config";
import { logger } from "@/utils/logger";
import {
  ThreadNotFoundError,
  ThreadCorruptedError,
  ThreadWriteError,
} from "@/errors/base";
import type { AgentMessage } from "@/bus/types";

// ─── Thread Meta Types ──────────────────────────────────────────

export type ThreadType = "conversation" | "system";
export type ThreadStatus = "active" | "archived" | "compacted";

export interface ThreadMeta {
  id: string; // Always ULID
  type: ThreadType;
  title: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  summary?: string;
  lastCompactedAt?: string;
  metadata?: Record<string, unknown>;
}

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

export class PersistenceService {
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
    return this.createThread({
      type: "conversation",
      title: "Conversation",
    });
  }

  // ── Core CRUD ──────────────────────────────────────

  public async createThread(
    input: Pick<ThreadMeta, "type" | "title" | "metadata">,
  ): Promise<ThreadMeta> {
    const threadId = ulid();
    const threadPath = path.join(this.threadsDir, threadId);

    try {
      await fs.mkdir(threadPath, { recursive: true });

      const meta: ThreadMeta = {
        id: threadId,
        type: input.type,
        title: input.title,
        status: "active",
        createdAt: nowISO(),
        updatedAt: nowISO(),
        messageCount: 0,
        metadata: input.metadata,
      };

      await this.writeMeta(threadId, meta);
      // touch messages.jsonl
      await fs.writeFile(path.join(threadPath, "messages.jsonl"), "");

      logger.debug(`Created new thread: ${threadId} (${input.type})`);
      return meta;
    } catch (err) {
      logger.error({ err }, "Failed to create thread");
      throw new ThreadWriteError("Failed to initialize thread directory", {
        cause: err,
      });
    }
  }

  public async getThread(threadId: string): Promise<ThreadMeta> {
    const metaPath = path.join(this.threadsDir, threadId, "meta.json");
    try {
      const content = await fs.readFile(metaPath, "utf-8");
      return JSON.parse(content) as ThreadMeta;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        throw new ThreadNotFoundError(threadId);
      }
      throw new ThreadCorruptedError(threadId, "Unparseable meta.json", {
        cause: err,
      });
    }
  }

  public async updateMeta(
    threadId: string,
    updates: Partial<ThreadMeta>,
  ): Promise<ThreadMeta> {
    const meta = await this.getThread(threadId);
    const updated = { ...meta, ...updates, updatedAt: nowISO() };
    await this.writeMeta(threadId, updated);
    return updated;
  }

  public async listThreads(filter?: {
    type?: ThreadType;
    status?: ThreadStatus;
  }): Promise<ThreadMeta[]> {
    const threads: ThreadMeta[] = [];
    try {
      await fs.access(this.threadsDir);
      const entries = await fs.readdir(this.threadsDir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const meta = await this.getThread(entry.name);
          if (filter?.type && meta.type !== filter.type) continue;
          if (filter?.status && meta.status !== filter.status) continue;
          threads.push(meta);
        } catch (err) {
          logger.warn(
            { err },
            `Skipping invalid thread directory ${entry.name}`,
          );
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        logger.error({ err }, "Failed to list threads");
      }
    }

    return threads.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ── Message Operations ─────────────────────────────

  public async getMessages(threadId: string): Promise<AgentMessage[]> {
    const messagesPath = path.join(this.threadsDir, threadId, "messages.jsonl");
    const messages: AgentMessage[] = [];

    try {
      const content = await fs.readFile(messagesPath, "utf-8");
      if (!content.trim()) return [];

      const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
      for (const [index, line] of lines.entries()) {
        try {
          const msg = JSON.parse(line) as AgentMessage;
          messages.push(msg);
        } catch (err) {
          throw new ThreadCorruptedError(
            threadId,
            `Malformed JSONL at line ${index + 1}`,
            { cause: err },
          );
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        throw new ThreadCorruptedError(
          threadId,
          "Failed to read messages.jsonl",
          { cause: err },
        );
      }
    }

    return messages;
  }

  public async saveMessages(
    threadId: string,
    messages: AgentMessage[],
  ): Promise<void> {
    const messagesPath = path.join(this.threadsDir, threadId, "messages.jsonl");

    const lines = messages.map((m) => JSON.stringify(m)).join("\n");
    try {
      await fs.writeFile(messagesPath, lines + (lines ? "\n" : ""));
      await this.updateMeta(threadId, {
        messageCount: messages.length,
      });
    } catch (err) {
      logger.error({ err }, `Failed to save messages for thread ${threadId}`);
      throw new ThreadWriteError("Failed to write messages.jsonl", {
        cause: err,
      });
    }
  }

  public async appendMessage(
    threadId: string,
    message: AgentMessage,
  ): Promise<void> {
    const messagesPath = path.join(this.threadsDir, threadId, "messages.jsonl");

    try {
      await fs.appendFile(messagesPath, JSON.stringify(message) + "\n");
      const meta = await this.getThread(threadId);
      await this.updateMeta(threadId, {
        messageCount: meta.messageCount + 1,
      });
    } catch (err) {
      logger.error({ err }, `Failed to append message for thread ${threadId}`);
      throw new ThreadWriteError("Failed to append to messages.jsonl", {
        cause: err,
      });
    }
  }

  // ── Maintenance ────────────────────────────────────

  public async archiveThread(threadId: string): Promise<void> {
    const meta = await this.getThread(threadId);
    if (meta.status === "archived") return;

    await this.updateMeta(threadId, { status: "archived" });
    const archiveName = `${systemTimestamp()}_${meta.type}_${meta.title.replace(/[^a-z0-9]/gi, "_")}`;
    const newPath = path.join(this.threadsDir, archiveName);

    try {
      await fs.rename(path.join(this.threadsDir, threadId), newPath);
      logger.info(`Archived thread ${threadId} to ${archiveName}`);
    } catch (err) {
      logger.error({ err }, `Failed to rename thread directory ${threadId}`);
    }
  }

  private async writeMeta(threadId: string, meta: ThreadMeta): Promise<void> {
    const metaPath = path.join(this.threadsDir, threadId, "meta.json");
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  }
}
