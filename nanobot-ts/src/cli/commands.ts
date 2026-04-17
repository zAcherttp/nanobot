import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { Command } from "commander";

import { AgentLoop } from "../agent/loop.js";
import { TelegramBotController } from "../channels/manager.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../config/loader.js";
import { resolveConfigPath, resolveWorkspacePath } from "../config/paths.js";
import type { AppConfig, LogLevel } from "../config/schema.js";
import { createLogger } from "../utils/logging.js";

const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require("../../package.json") as {
	version: string;
};

const EXIT_COMMANDS = new Set(["exit", "quit", "/exit", "/quit", ":q"]);
const SUPPORTED_PROVIDERS = new Set(["openai-codex", "github-copilot"]);

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

interface ChannelsLoginOptions {
	config?: string;
	force?: boolean;
}

export function createCli(programName = "nanobot-ts"): Command {
	const program = new Command();

	program
		.name(programName)
		.description("nanobot - Personal AI Assistant")
		.showHelpAfterError()
		.version(`${programName} v${CLI_VERSION}`, "-v, --version", "Show version");

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
		.command("login")
		.description(
			"Authenticate with a channel via QR code or other interactive login.",
		)
		.argument("<channel_name>", "Channel name (e.g. weixin, whatsapp)")
		.option("-f, --force", "Force re-authentication even if already logged in")
		.option("-c, --config <config>", "Path to config file")
		.action(async (channelName: string, options: ChannelsLoginOptions) => {
			await runChannelsLogin(channelName, options);
		});

	const plugins = program
		.command("plugins")
		.description("Manage channel plugins");

	plugins
		.command("list")
		.description("List all discovered channels (built-in and plugins).")
		.action(async () => {
			await runPluginsList();
		});

	const provider = program.command("provider").description("Manage providers");

	provider
		.command("login")
		.description("Authenticate with an OAuth provider.")
		.argument(
			"<provider>",
			"OAuth provider (e.g. 'openai-codex', 'github-copilot')",
		)
		.action(async (providerName: string) => {
			await runProviderLogin(providerName);
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
	let config = cloneConfig(DEFAULT_CONFIG);

	if (await pathExists(configPath)) {
		const loaded = await loadConfig({ cliConfigPath: configPath });
		config = loaded.config;
		console.log(`Config already exists at ${configPath}`);
	} else {
		console.log(`Creating config at ${configPath}`);
	}

	if (options.workspace) {
		config.workspace.path = resolveWorkspacePath(options.workspace);
	}

	if (options.wizard) {
		console.log(
			"Interactive wizard is not implemented in nanobot-ts yet. Writing the stub config instead.",
		);
	}

	const writtenPath = await saveConfig(config, configPath);
	await ensureWorkspace(config.workspace.path);

	console.log(`Config saved at ${writtenPath}`);
	console.log(`Workspace ready at ${config.workspace.path}`);
	console.log("");
	console.log("Next steps:");
	console.log(`  1. Chat: ${programName} agent -m "Hello!"`);
	console.log(`  2. Start gateway: ${programName} gateway`);
}

async function runGateway(
	programName: string,
	options: GatewayOptions,
): Promise<void> {
	const { config } = await loadRuntimeConfig(programName, options);
	const port = options.port ?? config.gateway.port;

	if (!config.channels.telegram.enabled) {
		throw new Error(
			"No channels are enabled. Set channels.telegram.enabled=true in the config before starting the gateway.",
		);
	}

	await ensureWorkspace(config.workspace.path);

	const level: LogLevel = options.verbose ? "debug" : config.logging.level;
	const logger = createLogger(level);
	const controller = new TelegramBotController();

	console.log(
		`Starting ${programName} gateway version ${CLI_VERSION} on port ${port}...`,
	);
	console.log(`Workspace: ${config.workspace.path}`);

	await controller.start(config, logger);
	console.log("Telegram gateway is running. Press Ctrl+C to stop.");

	await waitForShutdown(async (signal) => {
		console.log(`Received ${signal}, stopping gateway...`);
		await controller.stop(logger);
		console.log("Gateway stopped.");
	});
}

async function runAgent(options: AgentOptions): Promise<void> {
	const { config } = await loadRuntimeConfig("nanobot-ts", options);
	await ensureWorkspace(config.workspace.path);

	if (options.logs) {
		console.log("Runtime log streaming is not implemented in nanobot-ts yet.");
	}

	const agent = new AgentLoop();
	const sessionId = options.session ?? "cli:direct";

	if (options.message) {
		const reply = await agent.reply(sessionId, options.message);
		console.log(reply);
		return;
	}

	console.log(
		"Interactive mode (type exit, quit, /exit, /quit, :q, or Ctrl+C to quit)",
	);

	const readline = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		while (true) {
			const input = (await readline.question("You: ")).trim();
			if (!input) {
				continue;
			}

			if (EXIT_COMMANDS.has(input.toLowerCase())) {
				console.log("Goodbye!");
				break;
			}

			const reply = await agent.reply(sessionId, input);
			console.log(`nanobot: ${reply}`);
		}
	} finally {
		readline.close();
	}
}

async function runStatus(): Promise<void> {
	const configPath = resolveConfigPath();
	const { config } = await loadRuntimeConfig("nanobot-ts", {});

	console.log("nanobot Status");
	console.log("");
	console.log(`Config: ${configPath}`);
	console.log(`Workspace: ${config.workspace.path}`);
	console.log(`Model: ${config.agent.model}`);
	console.log(
		`Telegram: ${config.channels.telegram.enabled ? "enabled" : "disabled"}`,
	);
	console.log(`Gateway port: ${config.gateway.port}`);
	console.log(`Log level: ${config.logging.level}`);
}

async function runChannelsStatus(configPath?: string): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	const telegram = loaded.config.channels.telegram;

	console.log("Channel Status");
	console.log("");
	console.log(`Telegram\t${telegram.enabled ? "enabled" : "disabled"}`);
}

async function runChannelsLogin(
	channelName: string,
	options: ChannelsLoginOptions,
): Promise<void> {
	if (options.config) {
		await loadRequiredConfig(options.config);
	}

	if (channelName !== "telegram") {
		throw new Error(`Unknown channel: ${channelName}. Available: telegram`);
	}

	if (options.force) {
		console.log("Telegram login does not have a persisted session to reset.");
	}

	console.log(
		"Telegram does not require `channels login` in nanobot-ts. Set channels.telegram.token in the config and run `gateway`.",
	);
}

async function runPluginsList(): Promise<void> {
	const config = await loadConfigIfPresent();
	const telegramEnabled = config?.channels.telegram.enabled ?? false;

	console.log("Channel Plugins");
	console.log("");
	console.log(`Telegram\tbuiltin\t${telegramEnabled ? "yes" : "no"}`);
}

async function runProviderLogin(providerName: string): Promise<void> {
	if (!SUPPORTED_PROVIDERS.has(providerName)) {
		throw new Error(
			`Unknown OAuth provider: ${providerName}. Supported: ${[
				...SUPPORTED_PROVIDERS,
			].join(", ")}`,
		);
	}

	throw new Error(
		`Provider login for ${providerName} is not implemented in nanobot-ts yet.`,
	);
}

async function loadRuntimeConfig(
	programName: string,
	options: CommonOptions,
): Promise<{ config: AppConfig; path: string }> {
	const loaded = await loadRequiredConfig(options.config, programName);

	if (options.workspace) {
		loaded.config.workspace.path = resolveWorkspacePath(options.workspace);
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

async function loadConfigIfPresent(): Promise<AppConfig | null> {
	const configPath = resolveConfigPath();
	if (!(await pathExists(configPath))) {
		return null;
	}

	const loaded = await loadConfig({ cliConfigPath: configPath });
	return loaded.config;
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
