import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
	DEFAULT_AGENT_MAX_RETRY_DELAY_MS,
	DEFAULT_AGENT_MAX_TOKENS,
	DEFAULT_AGENT_MODEL_ID,
	DEFAULT_AGENT_PROVIDER,
	DEFAULT_AGENT_SESSION_STORE_PATH,
	DEFAULT_AGENT_SYSTEM_PROMPT,
	DEFAULT_AGENT_TEMPERATURE,
	DEFAULT_CONFIG,
	DEFAULT_CONFIG_FILENAME,
	DEFAULT_GATEWAY_PORT,
	initConfigFile,
	isSenderAllowed,
	loadConfig,
	saveConfig,
	validateRuntimeConfig,
} from "../src/config/loader.js";
import {
	detectRuntimeMode,
	getDefaultDataDir,
	resolveConfigPath,
	resolveWorkspacePath,
} from "../src/config/paths.js";

describe("config", () => {
	beforeEach(() => {
		delete process.env.NANOBOT_TS_CONFIG;
		delete process.env.NANOBOT_TS_ENV;
		delete process.env.NANOBOT_TS_TELEGRAM_TOKEN;
		delete process.env.NANOBOT_TS_LOG_LEVEL;
		delete process.env.NANOBOT_TS_WORKSPACE;
	});

	it("loads valid config from json", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-config-"));
		const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
		await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG), "utf8");

		const loaded = await loadConfig({ cliConfigPath: configPath });

		expect(loaded.path).toBe(configPath);
		expect(loaded.config.channels.telegram.allowFrom).toEqual([]);
		expect(loaded.config.channels.telegram.chatIds).toEqual([]);
		expect(loaded.config.channels.telegram.enabled).toBe(false);
		expect(loaded.config.agent.provider).toBe(DEFAULT_AGENT_PROVIDER);
		expect(loaded.config.agent.modelId).toBe(DEFAULT_AGENT_MODEL_ID);
		expect(loaded.config.agent.systemPrompt).toBe(DEFAULT_AGENT_SYSTEM_PROMPT);
		expect(loaded.config.agent.temperature).toBe(DEFAULT_AGENT_TEMPERATURE);
		expect(loaded.config.agent.maxTokens).toBe(DEFAULT_AGENT_MAX_TOKENS);
		expect(loaded.config.agent.maxRetryDelayMs).toBe(
			DEFAULT_AGENT_MAX_RETRY_DELAY_MS,
		);
		expect(loaded.config.gateway.port).toBe(DEFAULT_GATEWAY_PORT);
		expect(loaded.config.logging.level).toBe("info");
	});

	it("env overrides token and log level", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-config-"));
		const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
		await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG), "utf8");
		process.env.NANOBOT_TS_TELEGRAM_TOKEN = "env-token";
		process.env.NANOBOT_TS_LOG_LEVEL = "debug";

		const loaded = await loadConfig({ cliConfigPath: configPath });

		expect(loaded.config.channels.telegram.token).toBe("env-token");
		expect(loaded.config.logging.level).toBe("debug");
	});

	it("throws clear error when token is missing", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-config-"));
		const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
		const invalid = {
			...DEFAULT_CONFIG,
			channels: {
				telegram: {
					...DEFAULT_CONFIG.channels.telegram,
					enabled: true,
					token: "",
				},
			},
		};
		await writeFile(configPath, JSON.stringify(invalid), "utf8");

		await expect(loadConfig({ cliConfigPath: configPath })).rejects.toThrow(
			"Telegram token is required",
		);
	});

	it("validates allowFrom wildcard and explicit ids", () => {
		expect(isSenderAllowed(["*"], "123")).toBe(true);
		expect(isSenderAllowed(["123", "456"], "123")).toBe(true);
		expect(isSenderAllowed(["123", "456"], "999")).toBe(false);
	});

	it("config init writes a valid sample file", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-config-"));
		const configPath = path.join(dir, "nested", DEFAULT_CONFIG_FILENAME);

		const writtenPath = await initConfigFile(configPath);
		const raw = await readFile(writtenPath, "utf8");

		expect(JSON.parse(raw)).toEqual(DEFAULT_CONFIG);
	});

	it("defaults to repo-local .nanobot paths in development mode", () => {
		process.env.NANOBOT_TS_ENV = "development";

		expect(detectRuntimeMode()).toBe("development");
		expect(getDefaultDataDir()).toBe(path.resolve(process.cwd(), ".nanobot"));
		expect(resolveConfigPath()).toBe(
			path.resolve(process.cwd(), ".nanobot", "config.json"),
		);
		expect(resolveWorkspacePath()).toBe(
			path.resolve(process.cwd(), ".nanobot", "workspace"),
		);
	});

	it("defaults to home .nanobot paths in production mode", () => {
		process.env.NANOBOT_TS_ENV = "production";

		expect(detectRuntimeMode()).toBe("production");
		expect(getDefaultDataDir()).toBe(path.join(os.homedir(), ".nanobot"));
		expect(resolveConfigPath()).toBe(
			path.join(os.homedir(), ".nanobot", "config.json"),
		);
		expect(resolveWorkspacePath()).toBe(
			path.join(os.homedir(), ".nanobot", "workspace"),
		);
	});

	it("resolves relative workspace paths from the config directory", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-config-"));
		const configDir = path.join(dir, ".nanobot");
		const configPath = path.join(configDir, DEFAULT_CONFIG_FILENAME);
		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG), "utf8");

		const loaded = await loadConfig({ cliConfigPath: configPath });

		expect(loaded.config.workspace.path).toBe(
			path.join(configDir, "workspace"),
		);
		expect(loaded.config.agent.sessionStore.path).toBe(
			path.join(configDir, "workspace", DEFAULT_AGENT_SESSION_STORE_PATH),
		);
	});

	it("saveConfig writes a modified config payload", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-config-"));
		const configPath = path.join(dir, "saved.json");
		const nextConfig = {
			...DEFAULT_CONFIG,
			channels: {
				telegram: {
					enabled: true,
					token: "real-token",
					allowFrom: ["123", "456"],
					chatIds: ["123", "456"],
				},
			},
			agent: {
				...DEFAULT_CONFIG.agent,
				provider: "anthropic",
				modelId: "claude-sonnet-4-20250514",
			},
			logging: {
				level: "debug" as const,
			},
		};

		await saveConfig(nextConfig, configPath);
		const raw = await readFile(configPath, "utf8");

		expect(JSON.parse(raw)).toEqual(nextConfig);
	});

	it("rejects unsupported agent providers", () => {
		const invalidConfig = {
			...DEFAULT_CONFIG,
			agent: {
				...DEFAULT_CONFIG.agent,
				provider: "missing-provider",
			},
		};

		expect(() =>
			validateRuntimeConfig(invalidConfig as typeof DEFAULT_CONFIG),
		).toThrow("Unsupported agent provider");
	});
});
