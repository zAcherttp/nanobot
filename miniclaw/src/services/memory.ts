import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger";

export interface DreamCursor {
  lastProcessedAt: string;
  lastMessageId: string;
}

export class MemoryStore {
  private readonly archivePath: string;
  private readonly cursorPath: string;

  constructor(memoryDir: string) {
    this.archivePath = path.join(memoryDir, "history.jsonl");
    this.cursorPath = path.join(memoryDir, "cursor.json");
  }

  public get historyPath(): string {
    return this.archivePath;
  }

  public async appendArchiveEntry(entry: unknown): Promise<void> {
    await fs.mkdir(path.dirname(this.archivePath), { recursive: true });
    await fs.appendFile(this.archivePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  public async getLastDreamCursor(): Promise<DreamCursor | null> {
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

  public async updateCursor(cursor: DreamCursor): Promise<void> {
    await fs.mkdir(path.dirname(this.cursorPath), { recursive: true });
    await fs.writeFile(
      this.cursorPath,
      JSON.stringify(cursor, null, 2),
      "utf8",
    );
    logger.debug(`Updated dream cursor: ${cursor.lastProcessedAt}`);
  }

  public async readUnprocessedHistory<
    T extends { id: string; timestamp: number },
  >(messages: T[]): Promise<T[]> {
    const cursor = await this.getLastDreamCursor();

    if (!cursor) {
      return messages;
    }

    const lastProcessedTime = new Date(cursor.lastProcessedAt).getTime();
    return messages.filter((message) => message.timestamp > lastProcessedTime);
  }
}
