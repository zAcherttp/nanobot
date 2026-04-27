import { DreamService, AgentMessage } from "./dream";
import { MemoryStore, DreamCursor } from "../services/memory";
import { CronService } from "../services/cron";
import { logger } from "../utils/logger";

export interface DreamCronConfig {
  schedule: string; // cron expression
  maxEntriesPerDream: number;
  minMessagesForDream: number;
}

export class DreamCronJob {
  private readonly dreamService: DreamService;
  private readonly memoryStore: MemoryStore;
  private readonly cronService: CronService;
  private readonly config: DreamCronConfig;
  private readonly getMessages: () => Promise<AgentMessage[]>;
  private jobId: string | null = null;

  constructor(
    memoryStore: MemoryStore,
    cronService: CronService,
    getMessages: () => Promise<AgentMessage[]>,
    config?: Partial<DreamCronConfig>,
  ) {
    this.memoryStore = memoryStore;
    this.cronService = cronService;
    this.getMessages = getMessages;

    this.config = {
      schedule: config?.schedule ?? "0 2 * * *", // Daily at 2 AM
      maxEntriesPerDream: config?.maxEntriesPerDream ?? 10,
      minMessagesForDream: config?.minMessagesForDream ?? 5,
    };

    this.dreamService = new DreamService(memoryStore, {
      maxMemoriesPerDream: this.config.maxEntriesPerDream,
      minMessagesForDream: this.config.minMessagesForDream,
    });
  }

  /**
   * Register the dream job with the cron service
   */
  async register(): Promise<void> {
    if (this.jobId) {
      logger.warn("Dream job already registered");
      return;
    }

    const job = await this.cronService.addJob(
      "dream-consolidation",
      { cronExpr: this.config.schedule },
      "Running dream consolidation",
      false, // don't deliver message
    );

    this.jobId = job.id;
    logger.info(
      `Dream job registered: ${job.id} (schedule: ${this.config.schedule})`,
    );
  }

  /**
   * Run dream consolidation manually
   */
  async run(): Promise<void> {
    logger.info("Running dream consolidation...");

    try {
      // Get unprocessed messages
      const allMessages = await this.getMessages();
      const unprocessedMessages =
        await this.memoryStore.readUnprocessedHistory(allMessages);

      if (unprocessedMessages.length === 0) {
        logger.info("No new messages to process");
        return;
      }

      logger.info(
        `Processing ${unprocessedMessages.length} unprocessed messages`,
      );

      // Run dream consolidation
      const memories = await this.dreamService.consolidate(unprocessedMessages);

      // Update cursor
      if (unprocessedMessages.length > 0) {
        const lastMessage = unprocessedMessages[unprocessedMessages.length - 1];
        const cursor: DreamCursor = {
          lastProcessedAt: new Date(lastMessage.timestamp).toISOString(),
          lastMessageId: lastMessage.id,
        };
        await this.memoryStore.updateCursor(cursor);
      }

      logger.info(
        `Dream consolidation complete: ${memories.length} memories created`,
      );
    } catch (err) {
      logger.error({ err }, "Dream consolidation failed");
      throw err;
    }
  }

  /**
   * Unregister the dream job
   */
  async unregister(): Promise<void> {
    if (!this.jobId) {
      logger.warn("Dream job not registered");
      return;
    }

    await this.cronService.removeJob(this.jobId);
    this.jobId = null;
    logger.info("Dream job unregistered");
  }

  /**
   * Get the job ID
   */
  getJobId(): string | null {
    return this.jobId;
  }
}
