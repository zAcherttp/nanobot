import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
	DEFAULT_AGENT_MAX_RETRY_DELAY_MS,
	DEFAULT_AGENT_MAX_TOKENS,
	DEFAULT_AGENT_MODEL_ID,
	DEFAULT_AGENT_PROVIDER,
	DEFAULT_AGENT_SESSION_STORE_MAX_MESSAGES,
	DEFAULT_AGENT_SESSION_STORE_MAX_PERSISTED_TEXT_CHARS,
	DEFAULT_AGENT_SESSION_STORE_PATH,
	DEFAULT_AGENT_TEMPERATURE,
	DEFAULT_CONFIG,
	DEFAULT_CONFIG_FILENAME,
	DEFAULT_CRON_PATH,
	DEFAULT_GATEWAY_PORT,
	DEFAULT_HEARTBEAT_ENABLED,
	DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
	DEFAULT_HEARTBEAT_KEEP_RECENT_MESSAGES,
	DEFAULT_LOGGING_CONSOLE,
	DEFAULT_LOGGING_MAX_ENTRIES,
	DEFAULT_LOGGING_MAX_PREVIEW_CHARS,
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
import {
	NANOBOT_FAUX_MODEL_ID,
	NANOBOT_FAUX_PROVIDER,
} from "../src/providers/faux.js";

async function expectConfigLoadFailure(
	rawConfig: unknown,
	expected: RegExp,
): Promise<void> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-config-"));
	const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
	await writeFile(configPath, JSON.stringify(rawConfig), "utf8");

	await expect(loadConfig({ cliConfigPath: configPath })).rejects.toThrow(
		expected,
	);
}

describe("config", () => {
	beforeEach(() => {
		delete process.env.NANOBOT_TS_CONFIG;
		delete process.env.NANOBOT_TS_ENV;
		delete process.env.NANOBOT_TS_TELEGRAM_TOKEN;
		delete process.env.NANOBOT_TS_LOG_LEVEL;
		delete process.env.NANOBOT_TS_WORKSPACE;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.NANOBOT_TEST_PROVIDER_KEY;
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
		expect(loaded.config.channels.telegram.streaming).toBe(true);
		expect(loaded.config.agent.provider).toBe(DEFAULT_AGENT_PROVIDER);
		expect(loaded.config.providers).toEqual({});
		expect(loaded.config.agent.modelId).toBe(DEFAULT_AGENT_MODEL_ID);
		expect("systemPrompt" in loaded.config.agent).toBe(false);
		expect(loaded.config.agent.temperature).toBe(DEFAULT_AGENT_TEMPERATURE);
		expect(loaded.config.agent.maxTokens).toBe(DEFAULT_AGENT_MAX_TOKENS);
		expect(loaded.config.agent.maxRetryDelayMs).toBe(
			DEFAULT_AGENT_MAX_RETRY_DELAY_MS,
		);
		expect(loaded.config.agent.sessionStore.maxMessages).toBe(
			DEFAULT_AGENT_SESSION_STORE_MAX_MESSAGES,
		);
		expect(loaded.config.agent.sessionStore.maxPersistedTextChars).toBe(
			DEFAULT_AGENT_SESSION_STORE_MAX_PERSISTED_TEXT_CHARS,
		);
		expect(loaded.config.agent.sessionStore.quarantineCorruptFiles).toBe(true);
		expect(loaded.config.gateway.port).toBe(DEFAULT_GATEWAY_PORT);
		expect(loaded.config.gateway.heartbeat.enabled).toBe(
			DEFAULT_HEARTBEAT_ENABLED,
		);
		expect(loaded.config.gateway.heartbeat.intervalSeconds).toBe(
			DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
		);
		expect(loaded.config.gateway.heartbeat.keepRecentMessages).toBe(
			DEFAULT_HEARTBEAT_KEEP_RECENT_MESSAGES,
		);
		expect(loaded.config.cron.enabled).toBe(true);
		expect(loaded.config.cron.timezone).toBe("UTC");
		expect(loaded.config.security.restrictToWorkspace).toBe(false);
		expect(loaded.config.security.allowedEnvKeys).toEqual([]);
		expect(loaded.config.security.ssrfWhitelist).toEqual([]);
		expect(loaded.config.logging.level).toBe("info");
		expect(loaded.config.logging.maxEntries).toBe(DEFAULT_LOGGING_MAX_ENTRIES);
		expect(loaded.config.logging.maxPreviewChars).toBe(
			DEFAULT_LOGGING_MAX_PREVIEW_CHARS,
		);
		expect(loaded.config.logging.console).toBe(DEFAULT_LOGGING_CONSOLE);
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

	it("resolves ${ENV_VAR} placeholders in config values", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-config-"));
		const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
		process.env.NANOBOT_TEST_PROVIDER_KEY = "from-env";
		await writeFile(
			configPath,
			JSON.stringify({
				...DEFAULT_CONFIG,
				providers: {
					anthropic: {
						apiKey: "${NANOBOT_TEST_PROVIDER_KEY}",
						apiBase: "https://example.test",
					},
				},
			}),
			"utf8",
		);

		const loaded = await loadConfig({ cliConfigPath: configPath });

		expect(loaded.config.providers.anthropic).toEqual({
			apiKey: "from-env",
			apiBase: "https://example.test",
		});
	});

	it("throws when an ${ENV_VAR} placeholder is unset", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-config-"));
		const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
		await writeFile(
			configPath,
			JSON.stringify({
				...DEFAULT_CONFIG,
				providers: {
					anthropic: {
						apiKey: "${MISSING_ENV_KEY}",
					},
				},
			}),
			"utf8",
		);

		await expect(loadConfig({ cliConfigPath: configPath })).rejects.toThrow(
			"Environment variable 'MISSING_ENV_KEY'",
		);
	});

	it("rejects unknown root config keys", async () => {
		await expectConfigLoadFailure(
			{
				...DEFAULT_CONFIG,
				legacyRoot: true,
			},
			/legacyRoot|unrecognized/i,
		);
	});

	it("rejects unknown agent keys including removed legacy fields", async () => {
		await expectConfigLoadFailure(
			{
				...DEFAULT_CONFIG,
				agent: {
					...DEFAULT_CONFIG.agent,
					sessionTtlMinutes: 15,
				},
			},
			/sessionTtlMinutes|unrecognized/i,
		);

		await expectConfigLoadFailure(
			{
				...DEFAULT_CONFIG,
				agent: {
					...DEFAULT_CONFIG.agent,
					systemPrompt: "legacy prompt",
				},
			},
			/systemPrompt|unrecognized/i,
		);
	});

	it("rejects unknown nested config keys", async () => {
		const cases: Array<[unknown, RegExp]> = [
			[
				{
					...DEFAULT_CONFIG,
					gateway: {
						...DEFAULT_CONFIG.gateway,
						legacyGateway: true,
					},
				},
				/legacyGateway|unrecognized/i,
			],
			[
				{
					...DEFAULT_CONFIG,
					gateway: {
						...DEFAULT_CONFIG.gateway,
						heartbeat: {
							...DEFAULT_CONFIG.gateway.heartbeat,
							legacyHeartbeat: true,
						},
					},
				},
				/legacyHeartbeat|unrecognized/i,
			],
			[
				{
					...DEFAULT_CONFIG,
					cron: {
						...DEFAULT_CONFIG.cron,
						legacyCron: true,
					},
				},
				/legacyCron|unrecognized/i,
			],
			[
				{
					...DEFAULT_CONFIG,
					channels: {
						telegram: {
							...DEFAULT_CONFIG.channels.telegram,
							legacyTelegram: true,
						},
					},
				},
				/legacyTelegram|unrecognized/i,
			],
			[
				{
					...DEFAULT_CONFIG,
					security: {
						...DEFAULT_CONFIG.security,
						legacySecurity: true,
					},
				},
				/legacySecurity|unrecognized/i,
			],
			[
				{
					...DEFAULT_CONFIG,
					agent: {
						...DEFAULT_CONFIG.agent,
						sessionStore: {
							...DEFAULT_CONFIG.agent.sessionStore,
							legacyStore: true,
						},
					},
				},
				/legacyStore|unrecognized/i,
			],
			[
				{
					...DEFAULT_CONFIG,
					agent: {
						...DEFAULT_CONFIG.agent,
						dream: {
							...DEFAULT_CONFIG.agent.dream,
							legacyDream: true,
						},
					},
				},
				/legacyDream|unrecognized/i,
			],
			[
				{
					...DEFAULT_CONFIG,
					logging: {
						...DEFAULT_CONFIG.logging,
						legacyLogging: true,
					},
				},
				/legacyLogging|unrecognized/i,
			],
			[
				{
					...DEFAULT_CONFIG,
					providers: {
						anthropic: {
							apiKey: "secret",
							legacyProvider: true,
						},
					},
				},
				/legacyProvider|unrecognized/i,
			],
		];

		for (const [rawConfig, expected] of cases) {
			await expectConfigLoadFailure(rawConfig, expected);
		}
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

	it("fails fast when an enabled telegram channel has an empty allowFrom list", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-config-"));
		const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
		await writeFile(
			configPath,
			JSON.stringify({
				...DEFAULT_CONFIG,
				channels: {
					telegram: {
						...DEFAULT_CONFIG.channels.telegram,
						enabled: true,
						token: "real-token",
						allowFrom: [],
					},
				},
			}),
			"utf8",
		);

		await expect(loadConfig({ cliConfigPath: configPath })).rejects.toThrow(
			'Enabled channel "telegram" has empty allowFrom',
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
		expect(loaded.config.cron.path).toBe(
			path.join(configDir, "workspace", DEFAULT_CRON_PATH),
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
					streaming: false,
				},
			},
			providers: {
				anthropic: {
					apiKey: "secret",
					apiBase: "https://anthropic.example.test",
					headers: {
						"x-app": "nanobot-ts",
					},
				},
			},
			agent: {
				...DEFAULT_CONFIG.agent,
				provider: "anthropic",
				modelId: "claude-sonnet-4-20250514",
			},
			logging: {
				...DEFAULT_CONFIG.logging,
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

	it("accepts the nanobot faux provider", () => {
		const fauxConfig = {
			...DEFAULT_CONFIG,
			agent: {
				...DEFAULT_CONFIG.agent,
				provider: NANOBOT_FAUX_PROVIDER,
				modelId: NANOBOT_FAUX_MODEL_ID,
			},
		};

		expect(() => validateRuntimeConfig(fauxConfig)).not.toThrow();
	});

	it("rejects empty security.allowedEnvKeys entries", () => {
		const invalidConfig = {
			...DEFAULT_CONFIG,
			security: {
				...DEFAULT_CONFIG.security,
				allowedEnvKeys: ["PATH", ""],
			},
		};

		expect(() => validateRuntimeConfig(invalidConfig)).toThrow(
			"security.allowedEnvKeys cannot contain empty entries",
		);
	});

	it("rejects empty security.ssrfWhitelist entries", () => {
		const invalidConfig = {
			...DEFAULT_CONFIG,
			security: {
				...DEFAULT_CONFIG.security,
				ssrfWhitelist: ["10.0.0.0/8", ""],
			},
		};

		expect(() => validateRuntimeConfig(invalidConfig)).toThrow(
			"security.ssrfWhitelist cannot contain empty entries",
		);
	});

	it("rejects zero heartbeat intervalSeconds", () => {
		const invalidConfig = {
			...DEFAULT_CONFIG,
			gateway: {
				...DEFAULT_CONFIG.gateway,
				heartbeat: {
					...DEFAULT_CONFIG.gateway.heartbeat,
					intervalSeconds: 0,
				},
			},
		};

		expect(() => validateRuntimeConfig(invalidConfig)).toThrow(
			"intervalSeconds must be positive",
		);
	});

	it("rejects empty cron timezone", () => {
		const invalidConfig = {
			...DEFAULT_CONFIG,
			cron: {
				...DEFAULT_CONFIG.cron,
				timezone: "   ",
			},
		};

		expect(() => validateRuntimeConfig(invalidConfig)).toThrow(
			"Cron timezone is required",
		);
	});

	it("rejects invalid logging retention limits", () => {
		const invalidEntriesConfig = {
			...DEFAULT_CONFIG,
			logging: {
				...DEFAULT_CONFIG.logging,
				maxEntries: 0,
			},
		};
		const invalidPreviewConfig = {
			...DEFAULT_CONFIG,
			logging: {
				...DEFAULT_CONFIG.logging,
				maxPreviewChars: 0,
			},
		};

		expect(() => validateRuntimeConfig(invalidEntriesConfig)).toThrow(
			"logging.maxEntries must be positive",
		);
		expect(() => validateRuntimeConfig(invalidPreviewConfig)).toThrow(
			"logging.maxPreviewChars must be positive",
		);
	});

	it("rejects whitespace-only telegram token when enabled", () => {
		const invalidConfig = {
			...DEFAULT_CONFIG,
			channels: {
				...DEFAULT_CONFIG.channels,
				telegram: {
					...DEFAULT_CONFIG.channels.telegram,
					enabled: true,
					token: "   ",
					allowFrom: ["*"],
				},
			},
		};

		expect(() => validateRuntimeConfig(invalidConfig)).toThrow(
			"Telegram token is required",
		);
	});

	it("rejects unsupported agent provider at runtime validation", () => {
		const invalidConfig = {
			...DEFAULT_CONFIG,
			agent: {
				...DEFAULT_CONFIG.agent,
				provider: "nonexistent_llm" as any,
			},
		};

		expect(() => validateRuntimeConfig(invalidConfig)).toThrow(
			"Unsupported agent provider",
		);
	});
});
