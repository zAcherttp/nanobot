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
    sse: z
      .object({
        enabled: z.boolean().default(true),
      })
      .default({}),
  })
  .default({});

export const AppConfigSchema = z.object({
  workspace: WorkspaceConfigSchema.default({}),
  gateway: GatewayConfigSchema.default({}),
  thread: ThreadConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  channels: ChannelsConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
