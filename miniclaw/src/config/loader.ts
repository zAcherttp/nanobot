import { promises as fs } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { AppConfig, AppConfigSchema, LogLevelSchema } from "./schema.js";
import { ConfigLoadError, ConfigValidationError } from "../errors/base.js";

dotenv.config({ quiet: true });

export interface LoadConfigOptions {
  configPath?: string;
  envOverrides?: Record<string, string | undefined>;
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<AppConfig> {
  const configPath =
    options.configPath ||
    path.resolve(process.cwd(), ".miniclaw", "config.json");
  let rawConfig: Record<string, unknown> = {};

  try {
    const fileContent = await fs.readFile(configPath, "utf8");
    rawConfig = JSON.parse(fileContent);
  } catch (error: any) {
    // If the file doesn't exist and it's not explicitly provided, we just use defaults
    if (error.code !== "ENOENT" || options.configPath) {
      throw new ConfigLoadError(configPath, error);
    }
  }

  // Apply ENV overrides
  const env = options.envOverrides || process.env;
  if (env.NANOBOT_GATEWAY_PORT) {
    rawConfig.gateway = rawConfig.gateway || {};
    (rawConfig.gateway as any).port = parseInt(env.NANOBOT_GATEWAY_PORT, 10);
  }

  if (env.NANOBOT_LOG_LEVEL) {
    const parsedLevel = LogLevelSchema.safeParse(env.NANOBOT_LOG_LEVEL);
    if (parsedLevel.success) {
      rawConfig.logging = rawConfig.logging || {};
      (rawConfig.logging as any).level = parsedLevel.data;
    }
  }

  const result = AppConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    throw new ConfigValidationError(result.error.issues);
  }

  const data = result.data;
  const configDir = path.dirname(configPath);
  data.workspace.path = path.resolve(configDir, data.workspace.path);
  data.thread.store.path = path.resolve(configDir, data.thread.store.path);

  return data;
}

export async function saveConfig(
  config: AppConfig,
  configPath: string,
): Promise<void> {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

export async function initConfigFile(configPath: string): Promise<AppConfig> {
  const parsed = AppConfigSchema.safeParse({});
  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error.issues);
  }
  const defaultConfig = parsed.data;
  await saveConfig(defaultConfig, configPath);
  return defaultConfig;
}
