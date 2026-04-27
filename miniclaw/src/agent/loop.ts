import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { ulid } from "ulid";
import path from "node:path";
import type { MessageBus } from "@/bus/index";
import type { AppConfig } from "@/config/schema";
import type { PersistenceService } from "@/services/persistence";
import { logger } from "@/utils/logger";
import { CompactionService } from "./compaction";
import { buildSystemPrompt } from "./context";
import { SkillsLoader } from "./skills";
import { CronService } from "@/services/cron";
import { CalendarService } from "@/services/calendar";
import { GwsCalendarProvider } from "@/services/calendar/gws";
import { LarkCalendarProvider } from "@/services/calendar/lark";
import { MemoryStore } from "@/services/memory";
import { DreamCronJob } from "./dream-cron";

// Ensure built-in pi-ai providers (OpenAI, Anthropic, etc.) are registered
registerBuiltInApiProviders();

const INBOUND_LOG_PREVIEW_CHARS = 120;
const OUTBOUND_LOG_PREVIEW_CHARS = 120;

export class AgentLoop {
  private readonly skillsLoader: SkillsLoader;
  private readonly cronService: CronService;
  private readonly calendarService: CalendarService | null;
  private readonly memoryStore: MemoryStore | null;
  private readonly dreamCronJob: DreamCronJob | null;

  constructor(
    private readonly bus: MessageBus,
    private readonly persistence: PersistenceService,
    private readonly config: AppConfig,
  ) {
    // Initialize SkillsLoader
    const skillsPath = path.join(this.config.workspace.path, "skills");
    this.skillsLoader = new SkillsLoader(skillsPath);

    // Initialize CronService
    const cronStorePath = path.join(
      this.config.workspace.path,
      "cron",
      "store.json",
    );
    this.cronService = new CronService(cronStorePath, async (job) => {
      // Handle cron job execution
      if (job.payload.deliver) {
        this.bus.publishOutbound({
          message: {
            role: "assistant",
            content: job.payload.message,
            timestamp: Date.now(),
          },
          channel: job.payload.channel,
          userId: job.payload.to,
        });
      }
    });

    // Initialize CalendarService
    this.calendarService = this.initCalendarService();

    // Initialize MemoryStore
    this.memoryStore = this.initMemoryStore();

    // Initialize DreamCronJob
    this.dreamCronJob = this.initDreamCronJob();
  }

  private initCalendarService(): CalendarService | null {
    const calendarConfig = this.config.calendar;
    if (!calendarConfig) return null;

    switch (calendarConfig.provider) {
      case "gws":
        return new CalendarService(new GwsCalendarProvider());
      case "lark":
        if (!calendarConfig.larkAppId || !calendarConfig.larkAppSecret) {
          logger.warn("Lark calendar provider requires appId and appSecret");
          return null;
        }
        return new CalendarService(
          new LarkCalendarProvider(
            calendarConfig.larkAppId,
            calendarConfig.larkAppSecret,
          ),
        );
      default:
        logger.warn(`Unknown calendar provider: ${calendarConfig.provider}`);
        return null;
    }
  }

  private initMemoryStore(): MemoryStore | null {
    const memoryConfig = this.config.memory;
    if (!memoryConfig?.enabled) {
      logger.info("Memory store disabled");
      return null;
    }

    const memoryDir = path.join(this.config.workspace.path, "memory");
    return new MemoryStore(memoryDir);
  }

  private initDreamCronJob(): DreamCronJob | null {
    const dreamConfig = this.config.dream;
    if (!dreamConfig?.enabled || !this.memoryStore) {
      logger.info("Dream cron job disabled");
      return null;
    }

    return new DreamCronJob(
      this.memoryStore,
      this.cronService,
      async () => {
        // Get all messages from all threads
        const threads = await this.persistence.listThreads();
        const allMessages: Array<{ id: string; timestamp: number }> = [];

        for (const thread of threads) {
          const messages = await this.persistence.getMessages(thread.id);
          for (const msg of messages) {
            allMessages.push({
              id: msg.id || ulid(),
              timestamp: msg.timestamp || Date.now(),
            });
          }
        }

        return allMessages;
      },
      {
        schedule: dreamConfig.schedule,
        maxEntriesPerDream: dreamConfig.maxEntriesPerDream,
        minMessagesForDream: dreamConfig.minMessagesForDream,
      },
    );
  }

  public async start() {
    // Start cron service
    await this.cronService.start();

    // Register dream cron job
    if (this.dreamCronJob) {
      await this.dreamCronJob.register();
    }

    this.bus.subscribeInbound(async (event) => {
      const busReceivedAt = Date.now();
      try {
        await this.handleTurn(
          event.message.content as string,
          event.channel,
          event.userId,
          busReceivedAt,
        );
      } catch (err) {
        logger.error({ err }, "Agent loop turn failed");
      }
    });
  }

  public stop() {
    this.cronService.stop();
  }

  private async handleTurn(
    userText: string,
    channel?: string,
    userId?: string,
    busReceivedAt?: number,
  ) {
    logger.info(
      {
        channel: channel || "unknown",
        userId: userId || "anonymous",
        content: this.truncateForLog(userText, INBOUND_LOG_PREVIEW_CHARS),
      },
      "Gateway message received",
    );

    const thread = await this.persistence.getConversationThread();

    // 1. Persist inbound user message
    await this.persistence.appendMessage(thread.id, {
      role: "user",
      content: userText,
      timestamp: Date.now(),
    });

    // 2. Load context
    const messages = await this.persistence.getMessages(thread.id);
    const threadMeta = await this.persistence.getThread(thread.id);

    // 3. Check and perform compaction if needed
    const compaction = new CompactionService(
      this.bus,
      this.config.thread.compaction,
      this.persistence,
    );

    const {
      compacted,
      messages: compactedMessages,
      summary,
    } = await compaction.compactIfNeeded(
      messages,
      this.config.thread.contextWindowTokens,
      thread.id,
      channel,
      userId,
    );

    if (compacted && summary) {
      // Save summary to file
      await this.persistence.saveSummary(thread.id, summary);

      // Update thread metadata
      await this.persistence.updateMeta(thread.id, {
        summary,
        lastCompactedAt: new Date().toISOString(),
        status: "compacted",
      });

      // Save compacted messages
      await this.persistence.saveMessages(thread.id, compactedMessages);
    }

    // 4. Build system prompt with summary, memory, and skills
    const threadPath = path.join(
      this.config.workspace.path,
      "threads",
      thread.id,
    );
    const skillsSummary = await this.skillsLoader.getSkillSummary();
    const alwaysSkills = await this.skillsLoader.getAlwaysSkills();
    const alwaysSkillsContent = await this.skillsLoader.loadSkillsForContext(
      alwaysSkills.map((s) => s.name),
    );

    const systemPrompt = await buildSystemPrompt({
      workspacePath: this.config.workspace.path,
      threadPath,
      channel,
      skillsSummary,
      memoryStore: this.memoryStore || undefined,
    });

    // Add always skills to system prompt if any exist
    const finalSystemPrompt = alwaysSkillsContent
      ? `${systemPrompt}\n\n---\n\n${alwaysSkillsContent}`
      : systemPrompt;

    // 5. Resolve Provider & API Key
    const providerStr = this.config.thread.provider as any;
    const modelIdStr = this.config.thread.modelId;
    let model;
    try {
      model = getModel(providerStr, modelIdStr as any);
    } catch {
      // Ignored
    }

    // Provider configuration
    const providerConfig = {
      ollama: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
      nvidia: {
        api: "openai-responses",
        baseUrl: "https://integrate.api.nvidia.com/v1",
      },
    };

    if (!model) {
      // Fallback if model not found in strict types
      const config = providerConfig[providerStr as keyof typeof providerConfig];
      model = {
        id: modelIdStr,
        name: modelIdStr,
        api: config?.api || "openai-responses",
        provider: providerStr,
        baseUrl: config?.baseUrl || "",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: this.config.thread.contextWindowTokens,
        maxTokens: this.config.thread.maxTokens,
      } as any;
    }

    const apiKeyEnvMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      ollama: "OLLAMA_API_KEY",
      nvidia: "NVIDIA_API_KEY",
    };

    const getApiKey = (provider: string) => {
      const configKey =
        this.config.thread.apiKeys[
          provider as keyof typeof this.config.thread.apiKeys
        ];
      const envKey = apiKeyEnvMap[provider];
      const apiKey = configKey || (envKey ? process.env[envKey] : undefined);
      // Ollama defaults to "ollama" if no key is provided
      return apiKey || (provider === "ollama" ? "ollama" : undefined);
    };

    // 6. Initialize pi-agent-core Agent
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: finalSystemPrompt,
        messages: compactedMessages,
        thinkingLevel: "off",
      },
      getApiKey,
      transformContext: async (msgs) => {
        // TODO: Additional context transformation logic if needed
        return msgs;
      },
    });

    const streamId = ulid();
    let firstTokenLogged = false;

    // 5. Subscribe to agent streams for CLI / UI
    agent.subscribe(async (agentEvent) => {
      if (agentEvent.type === "message_update") {
        if (agentEvent.assistantMessageEvent.type === "text_delta") {
          if (!firstTokenLogged && typeof busReceivedAt === "number") {
            firstTokenLogged = true;
            const latencyMs = Date.now() - busReceivedAt;
            logger.debug(
              `Time from bus receive to first streamed token: ${latencyMs} ms`,
            );
          }

          this.bus.publishStreamDelta({
            id: streamId,
            delta: agentEvent.assistantMessageEvent.delta,
            timestamp: Date.now(),
            channel,
            userId,
          });
        }
      }
    });

    // 6. Execute Turn
    logger.debug(`Starting agent turn (channel: ${channel || "unknown"})`);
    await agent.continue(); // This triggers the LLM using the loaded messages
    await agent.waitForIdle();

    if (!firstTokenLogged && typeof busReceivedAt === "number") {
      const latencyMs = Date.now() - busReceivedAt;
      logger.debug(
        `No streamed token emitted before turn completion: ${latencyMs} ms`,
      );
    }

    // 7. Extract final response and sync to storage
    const updatedMessages = agent.state.messages;
    await this.persistence.saveMessages(thread.id, updatedMessages);

    const lastMsg = updatedMessages[updatedMessages.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      const responseText = this.extractTextContent(lastMsg.content);
      logger.info(
        {
          channel: channel || "unknown",
          userId: userId || "anonymous",
          content: this.truncateForLog(
            responseText,
            OUTBOUND_LOG_PREVIEW_CHARS,
          ),
        },
        "Agent response",
      );

      this.bus.publishOutbound({
        message: lastMsg,
        channel,
        userId,
      });
    }
  }

  private extractTextContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .map((part) => {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type?: unknown }).type === "text" &&
          "text" in part
        ) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }

        return "[non-text-content]";
      })
      .join("\n")
      .trim();
  }

  private truncateForLog(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }

    return `${text.slice(0, maxChars)}...`;
  }
}
