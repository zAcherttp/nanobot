import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	createCli,
	formatCliError,
	resolveEffectiveWorkspacePath,
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
			"channels",
			"sessions",
			"cron",
			"heartbeat",
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
