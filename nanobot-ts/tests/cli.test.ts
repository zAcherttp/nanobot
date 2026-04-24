import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	createCli,
	formatCliError,
	renderGatewayBootSummary,
	resolveEffectiveWorkspacePath,
	resolveGatewayLoggerSettings,
} from "../src/cli/commands.js";
import { DEFAULT_CONFIG } from "../src/config/loader.js";

describe("cli", () => {
	it("matches the TS top-level command surface", () => {
		const program = createCli("nanobot-ts");

		expect(program.commands.map((command) => command.name())).toEqual([
			"onboard",
			"gateway",
			"agent",
			"status",
			"logs",
			"channels",
			"sessions",
			"cron",
			"heartbeat",
		]);
	});

	it("adds runtime log inspection commands", () => {
		const program = createCli("nanobot-ts");
		const logs = program.commands.find((command) => command.name() === "logs");

		expect(logs?.commands.map((command) => command.name())).toEqual([
			"show",
			"tail",
			"clear",
		]);
	});

	it("exposes channel subcommands", () => {
		const program = createCli("nanobot-ts");
		const channels = program.commands.find(
			(command) => command.name() === "channels",
		);

		expect(channels?.commands.map((command) => command.name())).toEqual([
			"status",
			"message",
		]);
	});

	it("adds a minimal session admin surface", () => {
		const program = createCli("nanobot-ts");
		const sessions = program.commands.find(
			(command) => command.name() === "sessions",
		);

		expect(sessions?.commands.map((command) => command.name())).toEqual([
			"list",
			"show",
			"clear",
		]);
	});

	it("adds cron admin commands", () => {
		const program = createCli("nanobot-ts");
		const cron = program.commands.find((command) => command.name() === "cron");

		expect(cron?.commands.map((command) => command.name())).toEqual([
			"list",
			"add",
			"remove",
			"run",
			"status",
		]);
	});

	it("adds heartbeat admin commands", () => {
		const program = createCli("nanobot-ts");
		const heartbeat = program.commands.find(
			(command) => command.name() === "heartbeat",
		);

		expect(heartbeat?.commands.map((command) => command.name())).toEqual([
			"run",
			"status",
		]);
	});

	it("keeps the direct agent command flags", () => {
		const program = createCli("nanobot-ts");
		const agent = program.commands.find(
			(command) => command.name() === "agent",
		);

		expect(agent?.options.map((option) => option.long)).toEqual(
			expect.arrayContaining([
				"--message",
				"--session",
				"--workspace",
				"--config",
				"--markdown",
				"--logs",
			]),
		);
	});

	it("keeps gateway verbose compatibility and adds quiet mode", () => {
		const program = createCli("nanobot-ts");
		const gateway = program.commands.find(
			(command) => command.name() === "gateway",
		);

		expect(gateway?.options.map((option) => option.long)).toEqual(
			expect.arrayContaining(["--verbose", "--quiet"]),
		);
	});

	it("uses configured level with console output for default gateway runs", () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.logging.level = "info";
		config.logging.console = false;

		expect(resolveGatewayLoggerSettings(config)).toEqual({
			level: "info",
			console: true,
		});
	});

	it("keeps verbose gateway mode as explicit debug console logging", () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.logging.level = "info";
		config.logging.console = false;

		expect(resolveGatewayLoggerSettings(config, { verbose: true })).toEqual({
			level: "debug",
			console: true,
		});
	});

	it("lets quiet gateway mode use configured logging settings", () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.logging.level = "error";
		config.logging.console = false;

		expect(resolveGatewayLoggerSettings(config, { quiet: true })).toEqual({
			level: "error",
			console: false,
		});
	});

	it("renders friendly gateway boot summaries", () => {
		const lines = renderGatewayBootSummary({
			programName: "nanobot-ts",
			version: "0.0.1",
			port: 18790,
			configPath: "E:\\tmp\\.nanobot\\config.json",
			workspacePath: "E:\\tmp\\.nanobot\\workspace",
			logPath: "E:\\tmp\\.nanobot\\logs\\runtime.jsonl",
			provider: "anthropic",
			modelId: "claude-opus-4-5",
			channelSnapshots: [
				{
					name: "telegram",
					displayName: "Telegram",
					enabled: true,
					status: "idle",
				},
				{
					name: "websocket",
					displayName: "WebSocket",
					enabled: false,
					status: "idle",
				},
			],
			cronEnabled: true,
			cronJobCount: 2,
			heartbeatEnabled: true,
			heartbeatIntervalSeconds: 1800,
			dreamIntervalHours: 2,
			autoCompactAfterMinutes: 30,
		});

		expect(lines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Workspace:"),
				expect.stringContaining("Logs:"),
				"Model: anthropic/claude-opus-4-5",
				"Channels enabled: telegram",
				"Channels disabled: websocket",
				"Cron: 2 scheduled jobs",
				"Heartbeat: every 1800s",
				"Dream: every 2h",
				"Auto-compact: after 30m idle",
				"Health endpoint: http://0.0.0.0:18790/health",
			]),
		);
	});

	it("formats top-level CLI errors with blue and cyan accents", () => {
		const formatted = formatCliError("boom");

		expect(formatted).toContain("\u001B[94m");
		expect(formatted).toContain("\u001B[36m");
		expect(formatted).toContain("boom");
	});

	it("resolves onboard workspace relative to the config directory", () => {
		const configPath = path.join("E:\\tmp", ".nanobot", "config.json");

		expect(resolveEffectiveWorkspacePath(DEFAULT_CONFIG, configPath)).toBe(
			path.join("E:\\tmp", ".nanobot", "workspace"),
		);
	});
});
