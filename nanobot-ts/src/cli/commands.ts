import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { Command } from "commander";

import {
	createSessionAgent,
	FileSessionStore,
	getLatestAssistantText,
	resolveAgentRuntimeConfig,
	resolveSessionStorePath,
} from "../agent/loop.js";
import { ChannelManager } from "../channels/manager.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../config/loader.js";
import { resolveConfigPath, resolveWorkspacePath } from "../config/paths.js";
import type { AppConfig, LogLevel } from "../config/schema.js";
import { GatewayRuntime } from "../gateway/index.js";
import { resolveProviderConfig } from "../providers/runtime.js";
import { createLogger } from "../utils/logging.js";

const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require("../../package.json") as {
	version: string;
};

const EXIT_COMMANDS = new Set(["/quit", "/q"]);
const EXIT_COMMANDS_TEXT = Array.from(EXIT_COMMANDS).join(", ");
const ANSI = {
	reset: "\u001B[0m",
	brightBlue: "\u001B[94m",
	cyan: "\u001B[36m",
	brightCyan: "\u001B[96m",
	dimCyan: "\u001B[36;2m",
} as const;

interface CommonOptions {
	config?: string;
	workspace?: string;
}

interface GatewayOptions extends CommonOptions {
	port?: number;
	verbose?: boolean;
}

interface AgentOptions extends CommonOptions {
	message?: string;
	session?: string;
	markdown?: boolean;
	logs?: boolean;
}

export function createCli(programName = "nanobot-ts"): Command {
	const program = new Command();

	program
		.name(programName)
		.description("nanobot - Personal AI Assistant")
		.showHelpAfterError()
		.version(`${programName} v${CLI_VERSION}`, "-v, --version", "Show version");

	program.configureOutput({
		writeOut: (text) => process.stdout.write(styleHelp(text)),
		writeErr: (text) => process.stderr.write(styleHelp(text)),
	});

	program
		.command("onboard")
		.description("Initialize nanobot configuration and workspace.")
		.option("-w, --workspace <workspace>", "Workspace directory")
		.option("-c, --config <config>", "Path to config file")
		.option("--wizard", "Use interactive wizard")
		.action(async (options: CommonOptions & { wizard?: boolean }) => {
			await runOnboard(programName, options);
		});

	program
		.command("gateway")
		.description("Start the nanobot gateway.")
		.option("-p, --port <port>", "Gateway port", parseInteger)
		.option("-w, --workspace <workspace>", "Workspace directory")
		.option("-v, --verbose", "Verbose output")
		.option("-c, --config <config>", "Path to config file")
		.action(async (options: GatewayOptions) => {
			await runGateway(programName, options);
		});

	program
		.command("agent")
		.description("Interact with the agent directly.")
		.option("-m, --message <message>", "Message to send to the agent")
		.option("-s, --session <session>", "Session ID", "cli:direct")
		.option("-w, --workspace <workspace>", "Workspace directory")
		.option("-c, --config <config>", "Config file path")
		.option("--markdown", "Render assistant output as Markdown", true)
		.option("--no-markdown", "Render assistant output as plain text")
		.option("--logs", "Show nanobot runtime logs during chat", false)
		.option("--no-logs", "Hide nanobot runtime logs during chat")
		.action(async (options: AgentOptions) => {
			await runAgent(options);
		});

	program
		.command("status")
		.description("Show nanobot status.")
		.action(async () => {
			await runStatus();
		});

	const channels = program.command("channels").description("Manage channels");

	channels
		.command("status")
		.description("Show channel status.")
		.option("-c, --config <config>", "Path to config file")
		.action(async (options: { config?: string }) => {
			await runChannelsStatus(options.config);
		});

	channels
		.command("message")
		.description("Deliver a system message to configured channels.")
		.argument("<message...>", "Message text to deliver")
		.option("-c, --config <config>", "Path to config file")
		.action(async (messageParts: string[], options: { config?: string }) => {
			await runChannelsMessage(messageParts.join(" "), options.config);
		});

	return program;
}

export async function main(argv = process.argv): Promise<void> {
	const program = createCli(resolveProgramName(argv));

	if (argv.slice(2).length === 0) {
		program.outputHelp();
		return;
	}

	await program.parseAsync(argv);
}

async function runOnboard(
	programName: string,
	options: CommonOptions & { wizard?: boolean },
): Promise<void> {
	const configPath = resolveConfigPath(options.config);
	const configDir = path.dirname(configPath);
	let config = cloneConfig(DEFAULT_CONFIG);

	if (await pathExists(configPath)) {
		if (options.wizard) {
			config = await loadOnboardConfig(
				configPath,
				options.workspace,
				configDir,
			);
		} else {
			printInfo(`Config already exists at ${accentPath(configPath)}`);
			printNote("  y = overwrite with defaults (existing values will be lost)");
			printNote(
				"  N = refresh config, keeping existing values and adding new fields",
			);

			const overwrite = await promptForOverwrite();
			if (overwrite) {
				config = applyWorkspaceOverride(
					cloneConfig(DEFAULT_CONFIG),
					options.workspace,
					configDir,
				);
				await saveConfig(config, configPath);
				printInfo(`Config reset to defaults at ${accentPath(configPath)}`);
			} else {
				config = await loadOnboardConfig(
					configPath,
					options.workspace,
					configDir,
				);
				await saveConfig(config, configPath);
				printInfo(
					`Config refreshed at ${accentPath(configPath)} (existing values preserved)`,
				);
			}
		}
	} else {
		printInfo(`Creating config at ${accentPath(configPath)}`);
		config = applyWorkspaceOverride(config, options.workspace, configDir);
	}

	if (options.wizard) {
		printNote(
			"Interactive wizard is not implemented in nanobot-ts yet. Writing the stub config instead.",
		);
	}

	const writtenPath = await saveConfig(config, configPath);
	const workspacePath = resolveEffectiveWorkspacePath(config, writtenPath);
	await ensureWorkspace(workspacePath);

	printInfo(`Config saved at ${accentPath(writtenPath)}`);
	printInfo(`Workspace ready at ${accentPath(workspacePath)}`);
	console.log("");
	printSection("Next steps");
	console.log(`  1. ${accentCommand(`${programName} agent -m "Hello!"`)}`);
	console.log(`  2. ${accentCommand(`${programName} gateway`)}`);
}

async function loadOnboardConfig(
	configPath: string,
	workspace?: string,
	configDir?: string,
): Promise<AppConfig> {
	const loaded = await loadConfig({ cliConfigPath: configPath });
	return applyWorkspaceOverride(loaded.config, workspace, configDir);
}

async function runGateway(
	programName: string,
	options: GatewayOptions,
): Promise<void> {
	const { config } = await loadRuntimeConfig(programName, options);
	const port = options.port ?? config.gateway.port;

	await ensureWorkspace(config.workspace.path);

	const level: LogLevel = options.verbose ? "debug" : config.logging.level;
	const logger = createLogger(level);
	const manager = new ChannelManager(config, logger);
	const agentConfig = resolveAgentRuntimeConfig(config);
	const runtime = new GatewayRuntime({
		bus: manager.getBus(),
		logger,
		config: agentConfig,
		sessionStore: new FileSessionStore(agentConfig.sessionStorePath),
	});

	if (!manager.hasEnabledChannels()) {
		throw new Error(
			"No channels are enabled. Set channels.telegram.enabled=true in the config before starting the gateway.",
		);
	}

	printSection(
		`Starting ${programName} gateway version ${CLI_VERSION} on port ${port}...`,
	);
	printKeyValue("Workspace", accentPath(config.workspace.path));

	await runtime.start();
	await manager.start();
	printInfo("Gateway is running. Press Ctrl+C to stop.");

	await waitForShutdown(async (signal) => {
		printNote(`Received ${signal}, stopping gateway...`);
		await runtime.stop();
		await manager.stop();
		printInfo("Gateway stopped.");
	});
}

async function runAgent(options: AgentOptions): Promise<void> {
	const { config } = await loadRuntimeConfig("nanobot-ts", options);
	await ensureWorkspace(config.workspace.path);

	if (options.logs) {
		printNote("Runtime log streaming is not implemented in nanobot-ts yet.");
	}

	const sessionId = options.session ?? "cli:direct";
	const agent = await createSessionAgent({
		config: resolveAgentRuntimeConfig(config),
		sessionKey: sessionId,
	});

	if (options.message) {
		await agent.prompt(options.message);
		const reply = getLatestAssistantText(agent.state.messages);
		if (reply.trim()) {
			printAgentReply(reply);
		}
		return;
	}

	printSection(`Interactive mode (type ${EXIT_COMMANDS_TEXT} to quit)`);

	const readline = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	readline.on("SIGINT", () => {
		printNote(`Use ${EXIT_COMMANDS_TEXT} to quit interactive mode.`);
	});

	try {
		while (true) {
			const input = (await readline.question(userPrompt())).trim();
			if (!input) {
				continue;
			}

			if (EXIT_COMMANDS.has(input.toLowerCase())) {
				printInfo("Goodbye!");
				break;
			}

			await agent.prompt(input);
			const reply = getLatestAssistantText(agent.state.messages);
			if (reply.trim()) {
				printAgentReply(reply);
			}
		}
	} finally {
		readline.close();
	}
}

async function runStatus(): Promise<void> {
	const configPath = resolveConfigPath();
	const { config } = await loadRuntimeConfig("nanobot-ts", {});

	printSection("nanobot Status");
	console.log("");
	printKeyValue("Config", accentPath(configPath));
	printKeyValue("Workspace", accentPath(config.workspace.path));
	printKeyValue(
		"Model",
		accent(`${config.agent.provider}/${config.agent.modelId}`),
	);
	const providerConfig = resolveProviderConfig(config, config.agent.provider);
	printKeyValue(
		"Provider auth",
		accent(providerConfig.apiKeySource),
	);
	printKeyValue(
		"Telegram",
		accent(config.channels.telegram.enabled ? "enabled" : "disabled"),
	);
	printKeyValue("Gateway port", accent(String(config.gateway.port)));
	printKeyValue("Log level", accent(config.logging.level));
}

async function runChannelsStatus(configPath?: string): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	const manager = new ChannelManager(loaded.config, createLogger("fatal"));

	printSection("Channel Status");
	console.log("");
	for (const channel of manager.getSnapshots()) {
		console.log(
			`${accent(channel.displayName)}\t${accent(
				channel.enabled ? channel.status : "disabled",
			)}`,
		);
	}
}

async function runChannelsMessage(
	message: string,
	configPath?: string,
): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	const text = message.trim();
	if (!text) {
		throw new Error("Message content cannot be empty.");
	}

	const manager = new ChannelManager(loaded.config, createLogger("fatal"));
	const delivered = await manager.broadcast({
		content: text,
		role: "system",
	});

	printInfo(
		`Delivered system message to ${accent(String(delivered))} chat(s).`,
	);
}

async function loadRuntimeConfig(
	programName: string,
	options: CommonOptions,
): Promise<{ config: AppConfig; path: string }> {
	const loaded = await loadRequiredConfig(options.config, programName);

	if (options.workspace) {
		const previousWorkspace = loaded.config.workspace.path;
		loaded.config.workspace.path = resolveWorkspacePath(
			options.workspace,
			path.dirname(loaded.path),
		);
		if (loaded.config.agent.sessionStore.type === "file") {
			const relativeSessionStorePath = path.relative(
				previousWorkspace,
				loaded.config.agent.sessionStore.path,
			);
			loaded.config.agent.sessionStore.path = resolveSessionStorePath(
				loaded.config.workspace.path,
				relativeSessionStorePath,
			);
		}
	}

	return loaded;
}

async function loadRequiredConfig(
	configPath?: string,
	programName = "nanobot-ts",
): Promise<{ config: AppConfig; path: string }> {
	const resolvedPath = resolveConfigPath(configPath);

	if (!(await pathExists(resolvedPath))) {
		throw new Error(
			`Config file not found: ${resolvedPath}\nRun \`${programName} onboard\` first.`,
		);
	}

	return loadConfig({ cliConfigPath: resolvedPath });
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function ensureWorkspace(workspacePath: string): Promise<void> {
	await mkdir(workspacePath, { recursive: true });
}

async function waitForShutdown(
	onShutdown: (signal: NodeJS.Signals) => Promise<void>,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let shuttingDown = false;

		const cleanup = () => {
			process.off("SIGINT", handleSignal);
			process.off("SIGTERM", handleSignal);
		};

		const handleSignal = (signal: NodeJS.Signals) => {
			if (shuttingDown) {
				return;
			}

			shuttingDown = true;
			cleanup();

			void onShutdown(signal).then(resolve, reject);
		};

		process.on("SIGINT", handleSignal);
		process.on("SIGTERM", handleSignal);
	});
}

function cloneConfig(config: AppConfig): AppConfig {
	return structuredClone(config);
}

function applyWorkspaceOverride(
	config: AppConfig,
	workspace?: string,
	baseDir?: string,
): AppConfig {
	if (!workspace) {
		return config;
	}

	config.workspace.path = resolveWorkspacePath(workspace, baseDir);
	return config;
}

export function resolveEffectiveWorkspacePath(
	config: AppConfig,
	configPath: string,
): string {
	return resolveWorkspacePath(config.workspace.path, path.dirname(configPath));
}

function parseInteger(value: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid integer: ${value}`);
	}
	return parsed;
}

function resolveProgramName(argv: string[]): string {
	const executable = argv[1];
	if (!executable) {
		return "nanobot-ts";
	}

	const basename = path.basename(executable);
	if (basename === "cli" || basename === "cli.js") {
		return "nanobot-ts";
	}

	return basename;
}

async function promptForOverwrite(): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		printNote("Non-interactive terminal detected. Defaulting to refresh.");
		return false;
	}

	const readline = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		const answer = (
			await readline.question(`${ANSI.cyan}Overwrite? [y/N]${ANSI.reset} `)
		)
			.trim()
			.toLowerCase();

		return answer === "y" || answer === "yes";
	} finally {
		readline.close();
	}
}

export function formatCliError(message: string): string {
	return `${ANSI.brightBlue}nanobot${ANSI.reset} ${ANSI.cyan}${message}${ANSI.reset}`;
}

function styleHelp(text: string): string {
	return text
		.replace(/^Usage:/gm, `${ANSI.brightBlue}Usage:${ANSI.reset}`)
		.replace(/^Commands:/gm, `${ANSI.brightBlue}Commands:${ANSI.reset}`)
		.replace(/^Options:/gm, `${ANSI.brightBlue}Options:${ANSI.reset}`);
}

function printSection(text: string): void {
	console.log(`${ANSI.brightBlue}${text}${ANSI.reset}`);
}

function printInfo(text: string): void {
	console.log(`${ANSI.brightCyan}${text}${ANSI.reset}`);
}

function printNote(text: string): void {
	console.log(`${ANSI.dimCyan}${text}${ANSI.reset}`);
}

function printKeyValue(label: string, value: string): void {
	console.log(`${ANSI.cyan}${label}:${ANSI.reset} ${value}`);
}

function printAgentReply(reply: string): void {
	console.log(
		`${ANSI.brightBlue}nanobot:${ANSI.reset} ${ANSI.brightCyan}${reply}${ANSI.reset}`,
	);
}

function userPrompt(): string {
	return `${ANSI.cyan}You:${ANSI.reset} `;
}

function accent(text: string): string {
	return `${ANSI.brightCyan}${text}${ANSI.reset}`;
}

function accentPath(text: string): string {
	return `${ANSI.cyan}${text}${ANSI.reset}`;
}

function accentCommand(text: string): string {
	return `${ANSI.brightBlue}${text}${ANSI.reset}`;
}
