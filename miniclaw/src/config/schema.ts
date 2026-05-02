import { z } from "zod";

export const LogLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const WorkspaceConfigSchema = z.object({
  path: z.string().default("workspace"),
});

export const GatewayConfigSchema = z.object({
  port: z.number().int().positive().default(18790),
  heartbeat: z
    .object({
      enabled: z.boolean().default(true),
      intervalSeconds: z.number().int().positive().default(1800),
    })
    .default({}),
});

export const ThreadConfigSchema = z.object({
  provider: z.string().default("ollama"),
  modelId: z.string().default("gemma4:31b-cloud"),
  contextWindowTokens: z.number().int().positive().default(65536),
  idleCompactAfterMinutes: z.number().int().min(0).default(0),
  maxTokens: z.number().int().positive().default(8192),
  temperature: z.number().min(0).max(2).default(0.1),
  compaction: z
    .object({
      thresholdRatio: z.number().min(0.5).max(0.9).default(0.8),
      keepRecentMessages: z.number().int().min(1).default(10),
      maxRetries: z.number().int().min(1).max(5).default(3),
      retryDelayMs: z.number().int().min(1000).default(2000),
    })
    .default({}),
  apiKeys: z
    .object({
      openai: z.string().default(""),
      anthropic: z.string().default(""),
      ollama: z.string().default(""),
      nvidia: z.string().default(""),
    })
    .default({}),
  store: z
    .object({
      type: z.literal("file").default("file"),
      path: z.string().default("threads"),
      maxMessages: z.number().int().positive().default(500),
    })
    .default({}),
});

export const LoggingConfigSchema = z.object({
  level: LogLevelSchema.default("info"),
  console: z.boolean().default(false),
});

export const ToolsConfigSchema = z
  .object({
    exec: z
      .object({
        enable: z.boolean().default(true),
        timeout: z.number().int().positive().max(600).default(60),
        pathAppend: z.string().default(""),
        sandbox: z.string().default(""),
        allowedEnvKeys: z.array(z.string()).default([]),
      })
      .default({}),
    restrictToWorkspace: z.boolean().default(false),
  })
  .default({});

export const ChannelsConfigSchema = z
  .object({
    telegram: z
      .object({
        enabled: z.boolean().default(false),
        botToken: z.string().default(""),
        allowedUsers: z.array(z.string()).default([]),
      })
      .default({}),
    cli: z
      .object({
        enabled: z.boolean().default(true),
      })
      .default({}),
  })
  .strict()
  .default({});

export const MemoryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxMemories: z.number().int().positive().default(1000),
  })
  .default({});

export const DreamConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    schedule: z.string().default("0 2 * * *"), // Daily at 2 AM
    maxEntriesPerDream: z.number().int().positive().default(10),
    minMessagesForDream: z.number().int().positive().default(5),
  })
  .default({});

export const EvalConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    defaultMode: z.enum(["simulate", "sandbox-live"]).default("simulate"),
    outputDir: z.string().default("eval-reports"),
    safeWindow: z
      .object({
        start: z.string().default("2026-06-01T00:00:00.000Z"),
        end: z.string().default("2026-06-30T23:59:59.000Z"),
      })
      .default({}),
    eventPrefix: z.string().default("[MINICLAW-EVAL]"),
    throttle: z
      .object({
        llmMaxConcurrency: z.number().int().positive().default(1),
        gwsMaxConcurrency: z.number().int().positive().default(1),
        llmCooldownMs: z.number().int().min(0).default(0),
        gwsCooldownMs: z.number().int().min(0).default(250),
        turnCooldownMs: z.number().int().min(0).default(100),
        maxToolCallsPerScenario: z.number().int().positive().default(20),
      })
      .default({}),
    timeouts: z
      .object({
        scenarioMs: z.number().int().positive().default(120000),
        turnMs: z.number().int().positive().default(30000),
      })
      .default({}),
    retryPolicy: z
      .object({
        maxInfraRetries: z.number().int().min(0).default(1),
      })
      .default({}),
  })
  .default({});

export const AppConfigSchema = z.object({
  workspace: WorkspaceConfigSchema.default({}),
  gateway: GatewayConfigSchema.default({}),
  thread: ThreadConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  channels: ChannelsConfigSchema.default({}),
  memory: MemoryConfigSchema.optional(),
  dream: DreamConfigSchema.optional(),
  eval: EvalConfigSchema.optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
