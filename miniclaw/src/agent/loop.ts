import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { ulid } from "ulid";
import path from "node:path";
import type { MessageBus } from "@/bus/index";
import type { AgentMessage } from "@/bus/types";
import type { AppConfig } from "@/config/schema";
import type { PersistenceService } from "@/services/persistence";
import { logger } from "@/utils/logger";
import { CompactionService } from "./compaction";
import { buildSystemPrompt } from "./context";
import { SkillsLoader } from "./skills";
import { CronService } from "@/services/cron";
import { MemoryStore } from "@/services/memory";
import { DreamCronJob } from "./dream-cron";
import { GoalService } from "@/services/goals";
import {
  REQUIRED_PROFILE_FIELDS,
  type RequiredProfileField,
  UserProfileService,
} from "@/services/user_profile";
import { TaskService, type TaskJob } from "@/services/tasks";
import { TaskProgressNotifier } from "@/services/task_progress";
import { createSkillTools } from "@/tools/skills";
import { createTaskTools } from "@/tools/tasks";
import { createUserProfileTools } from "@/tools/user_profile";
import { createGoalTools } from "@/tools/goals";
import { createCalendarTools } from "@/tools/calendar";
import { createWorkspaceMemoryTools } from "@/tools/memory";
import { GwsCalendarService } from "@/services/calendar/gws";
import { WorkspaceMemoryService } from "@/services/workspace_memory";

registerBuiltInApiProviders();

const INBOUND_LOG_PREVIEW_CHARS = 120;
const OUTBOUND_LOG_PREVIEW_CHARS = 120;
const ONBOARDING_JOB_KIND = "onboarding";

const PROFILE_FIELD_LABELS: Record<RequiredProfileField, string> = {
  name: "Capture the user's name",
  timezone: "Capture the user's timezone",
  language: "Capture the user's preferred language",
  communicationStyle: "Capture the user's communication style",
  responseLength: "Capture the user's preferred response length",
  technicalLevel: "Capture the user's technical level",
  calendarProvider: "Capture the user's preferred calendar provider",
  defaultCalendar: "Capture the user's default calendar name or ID",
};

const TRANSIENT_TOOL_NAMES = new Set([
  "list_skills",
  "load_skill",
  "get_skill_info",
  "list_jobs",
  "get_job",
  "create_job",
  "update_job",
  "complete_task",
  "reopen_task",
  "archive_job",
  "cancel_job",
  "get_user_profile",
  "update_user_profile",
  "record_user_fact",
  "record_user_preference",
  "list_goals",
  "get_goal",
  "add_goal",
  "record_goal_progress",
  "update_goal_status",
  "list_memory_entries",
  "get_memory_entry",
  "record_memory_entry",
  "update_memory_entry",
  "remove_memory_entry",
  "gws_calendar_agenda",
  "propose_plan",
  "execute_plan",
]);

export class AgentLoop {
  private readonly skillsLoader: SkillsLoader;
  private readonly cronService: CronService;
  private readonly memoryStore: MemoryStore | null;
  private readonly dreamCronJob: DreamCronJob | null;
  private readonly userProfileService: UserProfileService;
  private readonly goalService: GoalService;
  private readonly taskService: TaskService;
  private readonly workspaceMemoryService: WorkspaceMemoryService;
  private readonly taskNotifier: TaskProgressNotifier;
  private readonly gwsCalendar: GwsCalendarService;
  private unsubscribeInbound: (() => void) | null = null;
  private readonly activeTurns = new Set<Promise<void>>();
  private running = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly bus: MessageBus,
    private readonly persistence: PersistenceService,
    private readonly config: AppConfig,
  ) {
    const skillsPath = path.join(this.config.workspace.path, "skills");
    this.skillsLoader = new SkillsLoader(skillsPath);

    const cronStorePath = path.join(
      this.config.workspace.path,
      "cron",
      "store.json",
    );
    this.cronService = new CronService(cronStorePath, async (job) => {
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

    this.memoryStore = this.initMemoryStore();
    this.userProfileService = new UserProfileService(this.config.workspace.path);
    this.goalService = new GoalService(this.config.workspace.path);
    this.taskService = new TaskService(this.config.workspace.path);
    this.workspaceMemoryService = new WorkspaceMemoryService(
      this.config.workspace.path,
    );
    this.taskNotifier = new TaskProgressNotifier(this.bus);
    this.gwsCalendar = new GwsCalendarService();
    this.dreamCronJob = this.initDreamCronJob();
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
        const threads = await this.persistence.listThreads();
        const allMessages: Array<{
          id: string;
          role: "user" | "assistant" | "system";
          content: string;
          timestamp: number;
        }> = [];

        for (const thread of threads) {
          const messages = await this.persistence.getMessages(thread.id);
          for (const msg of messages) {
            const content = this.extractTextContent(msg.content);
            if (!content.trim()) continue;
            allMessages.push({
              id: msg.id || ulid(),
              role: msg.role as "user" | "assistant" | "system",
              content,
              timestamp: msg.timestamp || Date.now(),
            });
          }
        }

        return allMessages;
      },
      this.userProfileService,
      this.goalService,
      this.workspaceMemoryService,
      {
        schedule: dreamConfig.schedule,
        maxEntriesPerDream: dreamConfig.maxEntriesPerDream,
        minMessagesForDream: dreamConfig.minMessagesForDream,
      },
    );
  }

  public async start() {
    if (this.running) {
      return;
    }

    await this.userProfileService.ensureProfileFile();
    await this.goalService.ensureGoalsFile();
    await this.taskService.ensureTasksFile();
    await this.workspaceMemoryService.ensureMemoryFile();
    await this.cronService.start();

    if (this.dreamCronJob) {
      await this.dreamCronJob.register();
    }

    this.running = true;
    this.stopPromise = null;
    this.unsubscribeInbound = this.bus.subscribeInbound((event) => {
      if (!this.running) {
        return;
      }

      const busReceivedAt = Date.now();
      const turnPromise = (async () => {
        try {
          await this.handleTurn(
            event.message.content as string,
            event.channel,
            event.userId,
            busReceivedAt,
          );
        } catch (err) {
          logger.error({ err }, "Agent loop turn failed");
        } finally {
          this.activeTurns.delete(turnPromise);
        }
      })();

      this.activeTurns.add(turnPromise);
    });
  }

  public async stop(): Promise<void> {
    if (!this.running && !this.stopPromise) {
      return;
    }

    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    this.running = false;
    this.unsubscribeInbound?.();
    this.unsubscribeInbound = null;

    this.stopPromise = (async () => {
      if (this.dreamCronJob) {
        await this.dreamCronJob.unregister();
      }

      this.cronService.stop();
      await Promise.allSettled([...this.activeTurns]);
    })();

    await this.stopPromise;
    this.stopPromise = null;
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

    await this.persistence.appendMessage(thread.id, {
      role: "user",
      content: userText,
      timestamp: Date.now(),
    });

    await this.ensureOnboardingJob(channel, userId);

    const messages = await this.persistence.getMessages(thread.id);

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
      await this.persistence.saveSummary(thread.id, summary);
      await this.persistence.updateMeta(thread.id, {
        summary,
        lastCompactedAt: new Date().toISOString(),
        status: "compacted",
      });
      await this.persistence.saveMessages(thread.id, compactedMessages);
    }

    const threadPath = path.join(this.config.thread.store.path, thread.id);
    const skillsSummary = await this.skillsLoader.getSkillSummary();
    const relevantMemoryEntries =
      await this.workspaceMemoryService.searchEntries(userText);
    const relevantHistory = this.buildRelevantConversationContext(
      messages.slice(0, -1),
      userText,
    );

    const systemPrompt = await buildSystemPrompt({
      workspacePath: this.config.workspace.path,
      threadPath,
      channel,
      skillsSummary,
      userProfileService: this.userProfileService,
      goalService: this.goalService,
      taskService: this.taskService,
      memoryService: this.workspaceMemoryService,
      relevantMemory:
        this.workspaceMemoryService.formatRelevantEntries(relevantMemoryEntries),
      relevantHistory,
    });

    const model = this.resolveModel();
    const tools = [
      ...createSkillTools(this.skillsLoader),
      ...createTaskTools(this.taskService, this.taskNotifier, {
        channel,
        userId,
      }),
      ...createUserProfileTools(this.userProfileService),
      ...createGoalTools(this.goalService),
      ...createWorkspaceMemoryTools(this.workspaceMemoryService),
      ...createCalendarTools({
        gwsCalendar: this.gwsCalendar,
        taskService: this.taskService,
        notifier: this.taskNotifier,
        goalService: this.goalService,
        currentUserText: userText,
        channel,
        userId,
      }),
    ];

    const agent = new Agent({
      initialState: {
        model,
        systemPrompt,
        messages: compactedMessages,
        tools,
        thinkingLevel: "off",
      },
      getApiKey: this.getApiKey,
      transformContext: async (msgs) => msgs,
    });

    const streamId = ulid();
    let firstTokenLogged = false;

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

    logger.debug(`Starting agent turn (channel: ${channel || "unknown"})`);
    await agent.continue();
    await agent.waitForIdle();

    if (!firstTokenLogged && typeof busReceivedAt === "number") {
      const latencyMs = Date.now() - busReceivedAt;
      logger.debug(
        `No streamed token emitted before turn completion: ${latencyMs} ms`,
      );
    }

    await this.ensureOnboardingJob(channel, userId);

    const updatedMessages = stripTransientMessages(agent.state.messages);
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

  private resolveModel() {
    const providerStr = this.config.thread.provider as any;
    const modelIdStr = this.config.thread.modelId;
    let model;
    try {
      model = getModel(providerStr, modelIdStr as any);
    } catch {
      // ignored
    }

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

    return model;
  }

  private getApiKey = (provider: string) => {
    const apiKeyEnvMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      ollama: "OLLAMA_API_KEY",
      nvidia: "NVIDIA_API_KEY",
    };

    const configKey =
      this.config.thread.apiKeys[
        provider as keyof typeof this.config.thread.apiKeys
      ];
    const envKey = apiKeyEnvMap[provider];
    const apiKey = configKey || (envKey ? process.env[envKey] : undefined);
    return apiKey || (provider === "ollama" ? "ollama" : undefined);
  };

  private async ensureOnboardingJob(
    channel?: string,
    userId?: string,
  ): Promise<TaskJob | null> {
    const profile = await this.userProfileService.getProfile();
    const missingFields = this.userProfileService.getMissingFields(profile);
    let job = await this.taskService.findActiveJobByKind(ONBOARDING_JOB_KIND);
    let created = false;

    if (missingFields.length === 0) {
      if (job) {
        const completedTaskIds = job.tasks.map((task) => task.id);
        const syncResult = await this.taskService.syncManagedJob(
          job.id,
          completedTaskIds,
        );
        job = syncResult.job;
        const archived = await this.taskService.archiveJob(
          job.id,
          "User profile setup complete.",
        );
        await this.taskNotifier.closeJob(archived);
        return archived;
      }
      return null;
    }

    if (!job) {
      job = await this.taskService.createJob({
        title: "Complete user profile",
        goal:
          "Collect the user's preferences and calendar defaults in USER.md.",
        tasks: REQUIRED_PROFILE_FIELDS.map((field) => ({
          title: PROFILE_FIELD_LABELS[field],
          fieldKey: field,
        })),
        channelContext: {
          channel,
          userId,
        },
        kind: ONBOARDING_JOB_KIND,
      });
      created = true;
    } else if (channel || userId) {
      job = await this.taskService.attachJobContext(job.id, {
        channel,
        userId,
      });
    }

    const completedTaskIds = job.tasks
      .filter((task) => task.fieldKey && profile[task.fieldKey].trim())
      .map((task) => task.id);

    const syncResult = await this.taskService.syncManagedJob(
      job.id,
      completedTaskIds,
    );
    job = syncResult.job;

    if (created) {
      await this.taskNotifier.announceJob(job);
    } else if (syncResult.changed) {
      await this.taskNotifier.refreshJob(job);
    }

    return job;
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

  private truncateForLog(value: string, maxLength: number): string {
    return value.length > maxLength
      ? `${value.slice(0, maxLength)}...`
      : value;
  }

  private buildRelevantConversationContext(
    messages: AgentMessage[],
    query: string,
    limit: number = 4,
  ): string | null {
    const queryTokens = tokenizeForRetrieval(query);
    if (queryTokens.length === 0) {
      return null;
    }

    const matches = messages
      .map((message) => {
        const content = this.extractTextContent(message.content);
        return {
          role: message.role,
          content,
          timestamp: message.timestamp || 0,
          score: scoreText(content, queryTokens),
        };
      })
      .filter((entry) => entry.content && entry.score > 0)
      .sort((left, right) =>
        right.score - left.score || right.timestamp - left.timestamp,
      )
      .slice(0, limit);

    if (matches.length === 0) {
      return null;
    }

    const lines = ["## Relevant Prior Conversation", ""];
    for (const match of matches) {
      lines.push(`- ${match.role}: ${match.content}`);
    }
    return lines.join("\n");
  }
}

function stripTransientMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => {
    if (isToolResultMessage(message)) {
      return !TRANSIENT_TOOL_NAMES.has(message.toolName);
    }

    if (isToolCallOnlyAssistantMessage(message)) {
      return false;
    }

    return true;
  });
}

function isToolResultMessage(
  message: AgentMessage,
): message is AgentMessage & { role: "toolResult"; toolName: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "toolResult" &&
    "toolName" in message &&
    typeof message.toolName === "string"
  );
}

function isToolCallOnlyAssistantMessage(message: AgentMessage): boolean {
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    message.role !== "assistant" ||
    !("content" in message) ||
    !Array.isArray(message.content)
  ) {
    return false;
  }

  return (
    message.content.length > 0 &&
    message.content.every(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "toolCall",
    )
  );
}

function tokenizeForRetrieval(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 3),
  )];
}

function scoreText(value: string, tokens: string[]): number {
  const haystack = value.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}
