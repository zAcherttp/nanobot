import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import {
  type Api,
  getModels,
  getProviders,
  type KnownProvider,
  type Model,
  registerBuiltInApiProviders,
} from "@mariozechner/pi-ai";
import { ulid } from "ulid";
import type { MessageBus } from "@/bus/index";
import type { AgentMessage } from "@/bus/types";
import type { AppConfig } from "@/config/schema";
import { AskUserService } from "@/services/ask_user";
import { CronService } from "@/services/cron";
import { GoalService } from "@/services/goals";
import { MemoryStore } from "@/services/memory";
import type { PersistenceService } from "@/services/persistence";
import { ShellExecutionService } from "@/services/shell";
import { TaskProgressNotifier } from "@/services/task_progress";
import { type TaskJob, TaskService } from "@/services/tasks";
import {
  REQUIRED_PROFILE_FIELDS,
  type RequiredProfileField,
  UserProfileService,
} from "@/services/user_profile";
import { WorkspaceMemoryService } from "@/services/workspace_memory";
import { createAskUserTools } from "@/tools/ask_user";
import { createExecTools } from "@/tools/exec";
import { createGoalTools } from "@/tools/goals";
import { createWorkspaceMemoryTools } from "@/tools/memory";
import { createSearchTools } from "@/tools/search";
import { createSkillTools } from "@/tools/skills";
import { createTaskTools } from "@/tools/tasks";
import { createUserProfileTools } from "@/tools/user_profile";
import { logger } from "@/utils/logger";
import { CompactionService } from "./compaction";
import { buildSystemPrompt } from "./context";
import { DreamCronJob } from "./dream-cron";
import { SkillsLoader } from "./skills";

registerBuiltInApiProviders();

const INBOUND_LOG_PREVIEW_CHARS = 120;
const OUTBOUND_LOG_PREVIEW_CHARS = 120;
const MESSAGE_PART_LOG_PREVIEW_CHARS = 120;
const ONBOARDING_JOB_KIND = "onboarding";

export interface ToolExecutionEvent {
  name: string;
  toolCallId: string;
  params: unknown;
  startedAt: string;
  finishedAt?: string;
  success: boolean;
  resultText?: string;
  error?: string;
}

export interface AgentLoopOptions {
  onToolExecution?: (event: ToolExecutionEvent) => void;
  shellService?: ShellExecutionService;
}

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
  "ask_user",
  "exec",
  "glob",
  "grep",
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
  private readonly askUserService: AskUserService;
  private readonly taskNotifier: TaskProgressNotifier;
  private readonly shellService: ShellExecutionService;
  private readonly options: AgentLoopOptions;
  private unsubscribeInbound: (() => void) | null = null;
  private readonly activeTurns = new Set<Promise<void>>();
  private readonly activeAgents = new Set<Agent>();
  private running = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly bus: MessageBus,
    private readonly persistence: PersistenceService,
    private readonly config: AppConfig,
    options: AgentLoopOptions = {},
  ) {
    this.options = options;
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
    this.userProfileService = new UserProfileService(
      this.config.workspace.path,
    );
    this.goalService = new GoalService(this.config.workspace.path);
    this.taskService = new TaskService(this.config.workspace.path);
    this.workspaceMemoryService = new WorkspaceMemoryService(
      this.config.workspace.path,
    );
    this.askUserService = new AskUserService(this.persistence);
    this.taskNotifier = new TaskProgressNotifier(this.bus);
    this.shellService =
      options.shellService ||
      new ShellExecutionService({
        workspacePath: this.config.workspace.path,
        toolConfig: this.config.tools.exec,
        restrictToWorkspace: this.config.tools.restrictToWorkspace,
      });
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
              id: "id" in msg && typeof msg.id === "string" ? msg.id : ulid(),
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
      const turnPromise = this.handleTurn(
        this.extractTextContent(event.message.content),
        event.channel,
        event.userId,
        busReceivedAt,
      ).catch((err) => {
        if (shouldLogChannel(event.channel)) {
          logger.error({ err }, "Agent loop turn failed");
        }
      });
      this.activeTurns.add(turnPromise);
      void turnPromise.finally(() => {
        this.activeTurns.delete(turnPromise);
      });
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
      for (const agent of this.activeAgents) {
        try {
          agent.abort();
        } catch {
          // Best effort: stopping should still wait on the turn promises.
        }
      }
      await Promise.allSettled([...this.activeTurns]);
    })();

    await this.stopPromise;
    this.stopPromise = null;
  }

  public async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.activeTurns]);
  }

  private async handleTurn(
    userText: string,
    channel?: string,
    userId?: string,
    busReceivedAt?: number,
  ) {
    const shouldLog = shouldLogChannel(channel);
    if (shouldLog) {
      logger.info(
        {
          channel: channel || "unknown",
          userId: userId || "anonymous",
          content: this.truncateForLog(userText, INBOUND_LOG_PREVIEW_CHARS),
        },
        "Gateway message received",
      );
    }

    const thread = await this.persistence.getConversationThread();
    const pendingAsk = await this.askUserService.getPendingAsk(thread.id);
    let approvalGranted = false;
    let workingMessages: AgentMessage[];

    if (pendingAsk) {
      const replyOutcome = this.askUserService.classifyReply(
        userText,
        pendingAsk.options,
      );
      await this.askUserService.clearPendingAsk(thread.id);
      if (replyOutcome === "proceed") {
        await this.askUserService.setApprovedAsk(thread.id, {
          toolCallId: pendingAsk.toolCallId,
          grantedAt: new Date().toISOString(),
        });
        approvalGranted = true;
      } else {
        await this.askUserService.clearApprovedAsk(thread.id);
      }

      workingMessages = [
        ...(await this.persistence.getMessages(thread.id)),
        this.askUserService.buildToolResultMessage(
          pendingAsk.toolCallId,
          userText,
        ),
      ];
    } else {
      await this.persistence.appendMessage(thread.id, {
        role: "user",
        content: userText,
        timestamp: Date.now(),
      });
      workingMessages = await this.persistence.getMessages(thread.id);
    }

    await this.ensureOnboardingJob(channel, userId);

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
      workingMessages,
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
      workingMessages.slice(0, -1),
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
      relevantMemory: this.workspaceMemoryService.formatRelevantEntries(
        relevantMemoryEntries,
      ),
      relevantHistory,
    });

    const model = this.resolveModel();
    const tools = this.instrumentTools(
      [
        ...createSkillTools(this.skillsLoader),
        ...createTaskTools(this.taskService, this.taskNotifier, {
          channel,
          userId,
        }),
        ...createUserProfileTools(this.userProfileService),
        ...createGoalTools(this.goalService),
        ...createWorkspaceMemoryTools(this.workspaceMemoryService),
        ...createAskUserTools({
          askUserService: this.askUserService,
          threadId: thread.id,
          channel,
          userId,
        }),
        ...createSearchTools({
          workspacePath: this.config.workspace.path,
          restrictToWorkspace: this.config.tools.restrictToWorkspace,
        }),
        ...createExecTools({
          shellService: this.shellService,
          workspacePath: this.config.workspace.path,
          timeoutSeconds: this.config.tools.exec.timeout,
          canRunMutatingGws: async () =>
            Boolean(await this.askUserService.getApprovedAsk(thread.id)),
        }),
      ],
      channel,
    );

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
    this.activeAgents.add(agent);

    const streamId = ulid();
    let firstTokenLogged = false;

    try {
      agent.subscribe(async (agentEvent) => {
        if (agentEvent.type === "message_update") {
          if (agentEvent.assistantMessageEvent.type === "text_delta") {
            if (!firstTokenLogged && typeof busReceivedAt === "number") {
              firstTokenLogged = true;
              const latencyMs = Date.now() - busReceivedAt;
              if (shouldLog) {
                logger.debug(
                  `Time from bus receive to first streamed token: ${latencyMs} ms`,
                );
              }
            }

            this.bus.publishStreamDelta({
              id: streamId,
              delta: agentEvent.assistantMessageEvent.delta,
              timestamp: Date.now(),
              channel,
              userId,
            });
          } else if (
            shouldLog &&
            !isToolStreamEvent(agentEvent.assistantMessageEvent.type)
          ) {
            logger.info(
              {
                channel: channel || "unknown",
                userId: userId || "anonymous",
                eventType: agentEvent.assistantMessageEvent.type,
                preview: this.truncateForLog(
                  this.summarizeAssistantMessageEvent(
                    agentEvent.assistantMessageEvent,
                  ),
                  MESSAGE_PART_LOG_PREVIEW_CHARS,
                ),
              },
              "Agent stream event",
            );
          }
        }
      });

      if (shouldLog) {
        logger.debug(`Starting agent turn (channel: ${channel || "unknown"})`);
      }
      await agent.continue();
      await agent.waitForIdle();
      this.logConversationMessages(
        agent.state.messages,
        compactedMessages.length,
        channel,
        userId,
      );

      if (!firstTokenLogged && typeof busReceivedAt === "number") {
        const latencyMs = Date.now() - busReceivedAt;
        if (shouldLog) {
          logger.debug(
            `No streamed token emitted before turn completion: ${latencyMs} ms`,
          );
        }
      }

      await this.ensureOnboardingJob(channel, userId);
      if (approvalGranted) {
        await this.askUserService.clearApprovedAsk(thread.id);
      }

      const updatedMessages = stripTransientMessages(agent.state.messages);
      await this.persistence.saveMessages(thread.id, updatedMessages);

      const activePendingAsk = await this.askUserService.getPendingAsk(
        thread.id,
      );
      if (activePendingAsk) {
        if (shouldLog) {
          logger.info(
            {
              channel: channel || "unknown",
              userId: userId || "anonymous",
              content: this.truncateForLog(
                activePendingAsk.question,
                OUTBOUND_LOG_PREVIEW_CHARS,
              ),
              options: activePendingAsk.options,
            },
            "Agent response",
          );
        }

        this.bus.publishOutbound({
          message: {
            role: "assistant",
            content: [{ type: "text", text: activePendingAsk.question }],
            timestamp: Date.now(),
          },
          channel,
          userId,
          options: activePendingAsk.options,
        });
        return;
      }

      const lastMsg = updatedMessages[updatedMessages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        const responseText = this.extractTextContent(lastMsg.content);
        if (responseText.trim().length === 0) {
          return;
        }

        if (shouldLog) {
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
        }

        this.bus.publishOutbound({
          message: lastMsg,
          channel,
          userId,
        });
      }
    } finally {
      this.activeAgents.delete(agent);
    }
  }

  private resolveModel(): Model<Api> {
    const providerStr = this.config.thread.provider;
    const modelIdStr = this.config.thread.modelId;
    if (isKnownProvider(providerStr)) {
      const knownModel = getModels(providerStr).find(
        (candidate) => candidate.id === modelIdStr,
      );
      if (knownModel) {
        return knownModel;
      }
    }

    const providerConfig: Partial<
      Record<string, { api: Api; baseUrl: string }>
    > = {
      ollama: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
      nvidia: {
        api: "openai-responses",
        baseUrl: "https://integrate.api.nvidia.com/v1",
      },
    };

    const config = providerConfig[providerStr];
    return {
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
    };
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
        goal: "Collect the user's preferences and calendar defaults in USER.md.",
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
      .filter(
        (task): task is typeof task & { fieldKey: RequiredProfileField } =>
          isRequiredProfileField(task.fieldKey) &&
          profile[task.fieldKey].trim().length > 0,
      )
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

  private logConversationMessages(
    messages: AgentMessage[],
    startIndex: number,
    channel?: string,
    userId?: string,
  ) {
    if (!shouldLogChannel(channel)) {
      return;
    }

    const newMessages = messages.slice(startIndex);
    for (const [offset, message] of newMessages.entries()) {
      if (
        isToolResultMessage(message) ||
        isToolCallOnlyAssistantMessage(message)
      ) {
        continue;
      }

      const parts = this.summarizeMessageContent(message.content).filter(
        (part) => part.preview.trim().length > 0,
      );
      if (parts.length === 0) {
        continue;
      }

      logger.info(
        {
          channel: channel || "unknown",
          userId: userId || "anonymous",
          messageIndex: startIndex + offset,
          role: message.role,
          toolName:
            typeof message === "object" &&
            message !== null &&
            "toolName" in message &&
            typeof message.toolName === "string"
              ? message.toolName
              : undefined,
          parts,
        },
        "Agent conversation message",
      );
    }
  }

  private summarizeMessageContent(
    content: unknown,
  ): Array<{ type: string; preview: string }> {
    if (typeof content === "string") {
      return [
        {
          type: "text",
          preview: this.truncateForLog(content, MESSAGE_PART_LOG_PREVIEW_CHARS),
        },
      ];
    }

    if (Array.isArray(content)) {
      return content.map((part) => this.summarizeMessagePart(part));
    }

    if (content && typeof content === "object") {
      return [this.summarizeMessagePart(content)];
    }

    return [
      {
        type: typeof content,
        preview: this.truncateForLog(
          String(content ?? ""),
          MESSAGE_PART_LOG_PREVIEW_CHARS,
        ),
      },
    ];
  }

  private summarizeMessagePart(part: unknown): {
    type: string;
    preview: string;
  } {
    if (typeof part === "string") {
      return {
        type: "text",
        preview: this.truncateForLog(part, MESSAGE_PART_LOG_PREVIEW_CHARS),
      };
    }

    if (!part || typeof part !== "object") {
      return {
        type: typeof part,
        preview: this.truncateForLog(
          String(part ?? ""),
          MESSAGE_PART_LOG_PREVIEW_CHARS,
        ),
      };
    }

    const record = part as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "unknown";

    const preview = this.buildMessagePartPreview(type, record);
    return {
      type,
      preview: this.truncateForLog(preview, MESSAGE_PART_LOG_PREVIEW_CHARS),
    };
  }

  private buildMessagePartPreview(
    type: string,
    record: Record<string, unknown>,
  ): string {
    const textFields = [
      "text",
      "delta",
      "content",
      "result",
      "error",
      "summary",
      "reasoning",
      "thinking",
    ];
    for (const field of textFields) {
      if (typeof record[field] === "string") {
        return record[field] as string;
      }
    }

    if (type === "toolCall") {
      const name =
        typeof record.toolName === "string"
          ? record.toolName
          : typeof record.name === "string"
            ? record.name
            : "unknown-tool";
      const params =
        record.params ??
        record.arguments ??
        record.args ??
        record.input ??
        record.payload;
      return `${name} ${this.safeSerializeForLog(params)}`.trim();
    }

    if (type === "toolResult") {
      const name =
        typeof record.toolName === "string"
          ? record.toolName
          : typeof record.name === "string"
            ? record.name
            : "unknown-tool";
      const result =
        record.result ?? record.output ?? record.content ?? record.value;
      return `${name} ${this.safeSerializeForLog(result)}`.trim();
    }

    return this.safeSerializeForLog(record);
  }

  private summarizeAssistantMessageEvent(event: unknown): string {
    if (!event || typeof event !== "object") {
      return this.safeSerializeForLog(event);
    }

    const record = event as Record<string, unknown>;
    const eventType =
      typeof record.type === "string" ? record.type : "unknown_event";

    if (eventType === "toolcall_start") {
      const toolName = this.extractToolCallName(record);
      return toolName ? `executing ${toolName}` : eventType;
    }

    if (eventType === "toolcall_delta") {
      const toolName = this.extractToolCallName(record);
      const delta =
        typeof record.delta === "string"
          ? this.summarizeToolArgumentsDelta(record.delta)
          : "";
      return [toolName, delta].filter(Boolean).join(" ").trim() || eventType;
    }

    if (eventType === "toolcall_end") {
      const toolName = this.extractToolCallName(record);
      const toolArgs = this.extractToolCallArguments(record);
      const paramsPreview = this.summarizeToolLogValue(toolArgs);
      return (
        [toolName, paramsPreview].filter(Boolean).join(" ").trim() || eventType
      );
    }

    return this.safeSerializeForLog(event);
  }

  private extractToolCallName(record: Record<string, unknown>): string | null {
    const directToolCall =
      record.toolCall && typeof record.toolCall === "object"
        ? (record.toolCall as Record<string, unknown>)
        : null;
    if (directToolCall && typeof directToolCall.name === "string") {
      return directToolCall.name;
    }

    const partial =
      record.partial && typeof record.partial === "object"
        ? (record.partial as Record<string, unknown>)
        : null;
    const content =
      partial && Array.isArray(partial.content) ? partial.content : null;
    const contentIndex =
      typeof record.contentIndex === "number" ? record.contentIndex : 0;
    const candidate =
      content &&
      contentIndex >= 0 &&
      contentIndex < content.length &&
      typeof content[contentIndex] === "object" &&
      content[contentIndex] !== null
        ? (content[contentIndex] as Record<string, unknown>)
        : null;

    return candidate && typeof candidate.name === "string"
      ? candidate.name
      : null;
  }

  private extractToolCallArguments(record: Record<string, unknown>): unknown {
    const directToolCall =
      record.toolCall && typeof record.toolCall === "object"
        ? (record.toolCall as Record<string, unknown>)
        : null;
    if (directToolCall && "arguments" in directToolCall) {
      return directToolCall.arguments;
    }

    const partial =
      record.partial && typeof record.partial === "object"
        ? (record.partial as Record<string, unknown>)
        : null;
    const content =
      partial && Array.isArray(partial.content) ? partial.content : null;
    const contentIndex =
      typeof record.contentIndex === "number" ? record.contentIndex : 0;
    const candidate =
      content &&
      contentIndex >= 0 &&
      contentIndex < content.length &&
      typeof content[contentIndex] === "object" &&
      content[contentIndex] !== null
        ? (content[contentIndex] as Record<string, unknown>)
        : null;

    return candidate?.arguments;
  }

  private summarizeToolArgumentsDelta(delta: string): string {
    try {
      const parsed = JSON.parse(delta) as unknown;
      return this.summarizeToolLogValue(parsed);
    } catch {
      return delta;
    }
  }

  private summarizeToolLogValue(value: unknown): string {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "command" in value &&
      typeof (value as { command?: unknown }).command === "string"
    ) {
      return (value as { command: string }).command;
    }

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "question" in value &&
      typeof (value as { question?: unknown }).question === "string"
    ) {
      return (value as { question: string }).question;
    }

    if (typeof value === "string") {
      return value;
    }

    return this.safeSerializeForLog(value);
  }

  private safeSerializeForLog(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private truncateForLog(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
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
      .sort(
        (left, right) =>
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

  private instrumentTools(
    tools: AgentTool<any, any>[],
    channel?: string,
  ): AgentTool<any, any>[] {
    if (!this.options.onToolExecution) {
      return tools;
    }

    const shouldLog = shouldLogChannel(channel);
    return tools.map((tool) => {
      const execute = tool.execute.bind(tool);
      return {
        ...tool,
        execute: async (toolCallId, params) => {
          const startedAt = new Date().toISOString();
          if (shouldLog) {
            logger.info(
              {
                toolName: tool.name,
                toolCallId,
                params: this.truncateForLog(
                  this.summarizeToolLogValue(params),
                  MESSAGE_PART_LOG_PREVIEW_CHARS,
                ),
              },
              "Agent tool call",
            );
          }
          try {
            const result = await execute(toolCallId, params);
            const resultText = this.extractTextContent(result?.content);
            if (shouldLog) {
              logger.info(
                {
                  toolName: tool.name,
                  toolCallId,
                  result: this.truncateForLog(
                    resultText || this.safeSerializeForLog(result),
                    MESSAGE_PART_LOG_PREVIEW_CHARS,
                  ),
                },
                "Agent tool result",
              );
            }
            this.options.onToolExecution?.({
              name: tool.name,
              toolCallId,
              params,
              startedAt,
              finishedAt: new Date().toISOString(),
              success: true,
              resultText,
            });
            return result;
          } catch (error) {
            if (shouldLog) {
              logger.warn(
                {
                  toolName: tool.name,
                  toolCallId,
                  error: this.truncateForLog(
                    error instanceof Error ? error.message : String(error),
                    MESSAGE_PART_LOG_PREVIEW_CHARS,
                  ),
                },
                "Agent tool failure",
              );
            }
            this.options.onToolExecution?.({
              name: tool.name,
              toolCallId,
              params,
              startedAt,
              finishedAt: new Date().toISOString(),
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      };
    });
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
      (part: unknown) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "toolCall",
    )
  );
}

function tokenizeForRetrieval(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter((token) => token.length >= 3),
    ),
  ];
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

function isRequiredProfileField(
  value: string | undefined,
): value is RequiredProfileField {
  return (
    typeof value === "string" && Object.hasOwn(PROFILE_FIELD_LABELS, value)
  );
}

function isKnownProvider(value: string): value is KnownProvider {
  return getProviders().some((provider) => provider === value);
}

function shouldLogChannel(channel?: string): boolean {
  return channel === "cli" || channel === "eval";
}

function isToolStreamEvent(eventType: string): boolean {
  return (
    eventType === "toolcall_start" ||
    eventType === "toolcall_delta" ||
    eventType === "toolcall_end"
  );
}
