import { describe, expect, it } from "vitest";

import { createCli, formatCliError } from "../src/cli/commands.js";

describe("cli", () => {
	it("matches the python-style top-level command surface", () => {
		const program = createCli("nanobot-ts");

		expect(program.commands.map((command) => command.name())).toEqual([
			"onboard",
			"gateway",
			"agent",
			"status",
			"channels",
			"plugins",
			"provider",
		]);
	});

	it("exposes python-like channel and provider subcommands", () => {
		const program = createCli("nanobot-ts");
		const channels = program.commands.find(
			(command) => command.name() === "channels",
		);
		const plugins = program.commands.find(
			(command) => command.name() === "plugins",
		);
		const provider = program.commands.find(
			(command) => command.name() === "provider",
		);

		expect(channels?.commands.map((command) => command.name())).toEqual([
			"status",
			"login",
		]);
		expect(plugins?.commands.map((command) => command.name())).toEqual([
			"list",
		]);
		expect(provider?.commands.map((command) => command.name())).toEqual([
			"login",
		]);
	});

	it("keeps the python agent flags on the stub command", () => {
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
});
