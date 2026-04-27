import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger";

export interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  source: "dream" | "manual";
}

export interface DreamCursor {
  lastProcessedAt: string;
  lastMessageId: string;
}

export class MemoryStore {
  private readonly memoryPath: string;
  private readonly cursorPath: string;
  private memories: MemoryEntry[] | null = null;

  constructor(memoryDir: string) {
    this.memoryPath = path.join(memoryDir, "memory.jsonl");
    this.cursorPath = path.join(memoryDir, "cursor.json");
  }

  /**
   * Add a new memory to the store
   */
  async addMemory(
    content: string,
    tags: string[] = [],
    source: "dream" | "manual" = "manual",
  ): Promise<void> {
    const memory: MemoryEntry = {
      id: this.generateId(),
      content: content.trim(),
      tags,
      createdAt: new Date().toISOString(),
      source,
    };

    // Append to file
    const line = JSON.stringify(memory) + "\n";
    await fs.appendFile(this.memoryPath, line, "utf8");

    // Invalidate cache
    this.memories = null;

    logger.debug(`Added memory: ${memory.id} (${source})`);
  }

  /**
   * Retrieve memories, optionally filtered by tags
   */
  async getMemories(tags?: string[], limit?: number): Promise<MemoryEntry[]> {
    const memories = await this.loadMemories();

    let filtered = memories;

    if (tags && tags.length > 0) {
      filtered = memories.filter((m) =>
        tags.some((tag) => m.tags.includes(tag)),
      );
    }

    if (limit && limit > 0) {
      filtered = filtered.slice(-limit);
    }

    return filtered;
  }

  /**
   * Search memories by content
   */
  async searchMemories(query: string): Promise<MemoryEntry[]> {
    const memories = await this.loadMemories();
    const lowerQuery = query.toLowerCase();

    return memories.filter(
      (m) =>
        m.content.toLowerCase().includes(lowerQuery) ||
        m.tags.some((t) => t.toLowerCase().includes(lowerQuery)),
    );
  }

  /**
   * Read all memories as formatted text for context
   */
  async readMemory(): Promise<string> {
    const memories = await this.loadMemories();

    if (memories.length === 0) {
      return "";
    }

    return memories
      .map((m) => {
        const tagStr = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
        return `- ${m.content}${tagStr}`;
      })
      .join("\n");
  }

  /**
   * Get memory context for system prompt
   * Returns null if no memories exist or if using default template
   */
  async getMemoryContext(): Promise<string | null> {
    const memories = await this.loadMemories();

    if (memories.length === 0) {
      return null;
    }

    const memoryText = await this.readMemory();
    return `## Long-term Memory

${memoryText}`;
  }

  /**
   * Get the last dream cursor
   */
  async getLastDreamCursor(): Promise<DreamCursor | null> {
    try {
      const content = await fs.readFile(this.cursorPath, "utf8");
      return JSON.parse(content) as DreamCursor;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return null;
      }
      logger.error({ err }, "Failed to read dream cursor");
      return null;
    }
  }

  /**
   * Update the dream cursor
   */
  async updateCursor(cursor: DreamCursor): Promise<void> {
    await fs.writeFile(
      this.cursorPath,
      JSON.stringify(cursor, null, 2),
      "utf8",
    );
    logger.debug(`Updated dream cursor: ${cursor.lastProcessedAt}`);
  }

  /**
   * Read unprocessed conversation history since last dream
   */
  async readUnprocessedHistory(
    messages: Array<{ id: string; timestamp: number }>,
  ): Promise<Array<{ id: string; timestamp: number }>> {
    const cursor = await this.getLastDreamCursor();

    if (!cursor) {
      // No cursor, return all messages
      return messages;
    }

    const lastProcessedTime = new Date(cursor.lastProcessedAt).getTime();

    // Return messages after the last processed time
    return messages.filter((m) => m.timestamp > lastProcessedTime);
  }

  /**
   * Load all memories from file
   */
  private async loadMemories(): Promise<MemoryEntry[]> {
    if (this.memories) {
      return this.memories;
    }

    try {
      const content = await fs.readFile(this.memoryPath, "utf8");
      const lines = content
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);

      this.memories = lines
        .map((line) => {
          try {
            return JSON.parse(line) as MemoryEntry;
          } catch {
            return null;
          }
        })
        .filter((m): m is MemoryEntry => m !== null);

      return this.memories;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        // File doesn't exist yet
        this.memories = [];
        return [];
      }
      logger.error({ err }, "Failed to load memories");
      this.memories = [];
      return [];
    }
  }

  /**
   * Generate a unique ID for memories
   */
  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
