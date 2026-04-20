import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { Command } from "commander";

import {
	createRuntimeAutoCompactor,
	createRuntimeConsolidator,
	createSessionAgent,
	FileSessionStore,
	getLatestAssistantText,
	type ResolvedAgentRuntimeConfig,
	resolveAgentRuntimeConfig,
	resolveSessionStorePath,
} from "../agent/loop.js";
import {
	type BackgroundTarget,
	evaluateBackgroundResult,
	pickRecentChannelTarget,
} from "../background/index.js";
import { ChannelManager } from "../channels/manager.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../config/loader.js";
import { resolveConfigPath, resolveWorkspacePath } from "../config/paths.js";
import type { AppConfig, LogLevel } from "../config/schema.js";
import {
	type CronSchedule,
	CronService,
	createCronTool,
	formatCronTimestamp,
	isValidTimeZone,
	parseNaiveIsoToMs,
} from "../cron/index.js";
import { DreamService } from "../dream/index.js";
import { GatewayRuntime } from "../gateway/index.js";
import { HeartbeatService, runHeartbeatTasks } from "../heartbeat/index.js";
import { MemoryStore } from "../memory/index.js";
import {
	getNanobotFauxTools,
	isNanobotFauxProvider,
} from "../providers/faux.js";
import { resolveProviderConfig } from "../providers/runtime.js";
import { syncWorkspaceTemplates } from "../templates/index.js";
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

interface CronAddOptions extends CommonOptions {
	name?: string;
	message: string;
	everySeconds?: number;
	cron?: string;
	tz?: string;
	at?: string;
	deliver?: boolean;
	channel?: string;
	to?: string;
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

	const sessions = program.command("sessions").description("Manage sessions");

	sessions
		.command("list")
		.description("List stored sessions.")
		.option("-c, --config <config>", "Path to config file")
		.action(async (options: { config?: string }) => {
			await runSessionsList(options.config);
		});

	sessions
		.command("show")
		.description("Show a stored session.")
		.argument("<key>", "Session key")
		.option("-c, --config <config>", "Path to config file")
		.action(async (key: string, options: { config?: string }) => {
			await runSessionsShow(key, options.config);
		});

	sessions
		.command("clear")
		.description("Delete a stored session.")
		.argument("<key>", "Session key")
		.option("-c, --config <config>", "Path to config file")
		.action(async (key: string, options: { config?: string }) => {
			await runSessionsClear(key, options.config);
		});

	const cron = program.command("cron").description("Manage cron jobs");

	cron
		.command("list")
		.description("List cron jobs.")
		.option("-c, --config <config>", "Path to config file")
		.action(async (options: { config?: string }) => {
			await runCronList(options.config);
		});

	cron
		.command("add")
		.description("Add a cron job.")
		.requiredOption("-m, --message <message>", "Message to run")
		.option("-n, --name <name>", "Job name")
		.option("--every-seconds <seconds>", "Run every N seconds", parseInteger)
		.option("--cron <expr>", "Cron expression")
		.option("--tz <timezone>", "IANA timezone for cron expressions")
		.option("--at <datetime>", "One-time ISO datetime")
		.option("--deliver", "Deliver the job result to a channel", false)
		.option("--channel <channel>", "Delivery channel name")
		.option("--to <target>", "Delivery chat/recipient target")
		.option("-c, --config <config>", "Path to config file")
		.action(async (options: CronAddOptions) => {
			await runCronAdd(options);
		});

	cron
		.command("remove")
		.description("Remove a cron job.")
		.argument("<id>", "Job ID")
		.option("-c, --config <config>", "Path to config file")
		.action(async (id: string, options: { config?: string }) => {
			await runCronRemove(id, options.config);
		});

	cron
		.command("run")
		.description("Run a cron job immediately.")
		.argument("<id>", "Job ID")
		.option("-c, --config <config>", "Path to config file")
		.action(async (id: string, options: { config?: string }) => {
			await runCronRun(id, options.config);
		});

	cron
		.command("status")
		.description("Show cron service status.")
		.option("-c, --config <config>", "Path to config file")
		.action(async (options: { config?: string }) => {
			await runCronStatus(options.config);
		});

	const heartbeat = program
		.command("heartbeat")
		.description("Manage heartbeat background execution");

	heartbeat
		.command("run")
		.description("Run heartbeat once immediately.")
		.option("-c, --config <config>", "Path to config file")
		.action(async (options: { config?: string }) => {
			await runHeartbeatRun(options.config);
		});

	heartbeat
		.command("status")
		.description("Show heartbeat service status.")
		.option("-c, --config <config>", "Path to config file")
		.action(async (options: { config?: string }) => {
			await runHeartbeatStatus(options.config);
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
			"Interactive wizard is not implemented in nanobot-ts yet. Writing the initial config instead.",
		);
	}

	const writtenPath = await saveConfig(config, configPath);
	const workspacePath = resolveEffectiveWorkspacePath(config, writtenPath);
	await ensureWorkspace(workspacePath);
	await syncWorkspaceTemplates(workspacePath);

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
	await syncWorkspaceTemplates(config.workspace.path);

	const level: LogLevel = options.verbose ? "debug" : config.logging.level;
	const logger = createLogger(level);
	const manager = new ChannelManager(config, logger);
	const agentConfig = resolveAgentRuntimeConfig(config);
	const dreamService = createDreamService(config, logger, agentConfig);
	const cronService = createCronService(config, logger, {
		manager,
		agentConfig,
		dreamService,
	});
	await registerDreamCronJob(config, cronService);
	const runtimeSessionStore = createRuntimeSessionStore(agentConfig);
	let runtime!: GatewayRuntime;
	let heartbeatService!: HeartbeatService;
	const autoCompactor = createRuntimeAutoCompactor({
		config: agentConfig,
		sessionStore: runtimeSessionStore,
		consolidator: createRuntimeConsolidator({
			config: agentConfig,
			sessionStore: runtimeSessionStore,
		}),
		logger,
		isSessionActive: (sessionKey) =>
			runtime.isSessionActive(sessionKey) ||
			cronService.isSessionActive(sessionKey) ||
			heartbeatService.isSessionActive(sessionKey),
	});
	runtime = new GatewayRuntime({
		bus: manager.getBus(),
		logger,
		config: agentConfig,
		sessionStore: runtimeSessionStore,
		getTools: ({ message }) =>
			getRuntimeTools(config, {
				cronService,
				channel: message.channel,
				chatId: message.chatId,
			}),
		dreamService,
		autoCompactor,
	});
	heartbeatService = createHeartbeatService(config, logger, {
		manager,
		agentConfig,
		cronService,
	});

	if (
		!manager.hasEnabledChannels() &&
		!config.cron.enabled &&
		!config.gateway.heartbeat.enabled &&
		config.agent.idleCompactAfterMinutes <= 0
	) {
		throw new Error(
			"No channels are enabled and cron, heartbeat, and auto-compact are disabled. Enable a channel, set cron.enabled=true / gateway.heartbeat.enabled=true, or set agent.idleCompactAfterMinutes before starting the gateway.",
		);
	}

	printSection(
		`Starting ${programName} gateway version ${CLI_VERSION} on port ${port}...`,
	);
	printKeyValue("Workspace", accentPath(config.workspace.path));

	await manager.start();
	await runtime.start();
	if (config.cron.enabled) {
		await cronService.start();
	}
	if (config.gateway.heartbeat.enabled) {
		await heartbeatService.start();
	}
	await autoCompactor.start();
	printInfo("Gateway is running. Press Ctrl+C to stop.");

	await waitForShutdown(async (signal) => {
		printNote(`Received ${signal}, stopping gateway...`);
		await autoCompactor.stop();
		await heartbeatService.stop();
		await cronService.stop();
		await runtime.stop();
		await manager.stop();
		printInfo("Gateway stopped.");
	});
}

async function runAgent(options: AgentOptions): Promise<void> {
	const { config } = await loadRuntimeConfig("nanobot-ts", options);
	await ensureWorkspace(config.workspace.path);
	await syncWorkspaceTemplates(config.workspace.path);

	if (options.logs) {
		printNote("Runtime log streaming is not implemented in nanobot-ts yet.");
	}

	const sessionId = options.session ?? "cli:direct";
	const cronService = createCronService(config, createLogger("fatal"), {
		agentConfig: resolveAgentRuntimeConfig(config),
	});
	const agent = await createSessionAgent({
		config: resolveAgentRuntimeConfig(config),
		sessionKey: sessionId,
		channel: "cli",
		tools: getRuntimeTools(config, {
			cronService,
		}),
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
	printKeyValue("Provider auth", accent(providerConfig.apiKeySource));
	printKeyValue(
		"Telegram",
		accent(config.channels.telegram.enabled ? "enabled" : "disabled"),
	);
	printKeyValue("Gateway port", accent(String(config.gateway.port)));
	printKeyValue(
		"Heartbeat",
		accent(config.gateway.heartbeat.enabled ? "enabled" : "disabled"),
	);
	printKeyValue("Cron", accent(config.cron.enabled ? "enabled" : "disabled"));
	printKeyValue("Log level", accent(config.logging.level));
}

async function runSessionsList(configPath?: string): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	const store = createRuntimeSessionStore(
		resolveAgentRuntimeConfig(loaded.config),
	);
	const sessions = await store.list();

	printSection("Sessions");
	if (sessions.length === 0) {
		printNote("No stored sessions.");
		return;
	}

	for (const session of sessions) {
		console.log(
			`${accent(session.key)}\t${accent(String(session.messageCount))}\t${accent(
				session.updatedAt,
			)}${session.hasRuntimeCheckpoint ? `\t${ANSI.cyan}checkpoint${ANSI.reset}` : ""}`,
		);
	}
}

async function runSessionsShow(
	key: string,
	configPath?: string,
): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	const store = createRuntimeSessionStore(
		resolveAgentRuntimeConfig(loaded.config),
	);
	const session = await store.load(key);
	if (!session) {
		throw new Error(`Session not found: ${key}`);
	}

	const metadata = session.metadata as {
		runtimeCheckpoint?: {
			completedToolResults?: unknown[];
			pendingToolCalls?: unknown[];
		};
		persistence?: {
			lastSanitizedAt?: string;
			lastSavedMessageCount?: number;
		};
	};
	const checkpoint = metadata.runtimeCheckpoint;

	printSection(`Session ${key}`);
	printKeyValue("Created", accent(session.createdAt));
	printKeyValue("Updated", accent(session.updatedAt));
	printKeyValue("Messages", accent(String(session.messages.length)));
	printKeyValue("Checkpoint", accent(checkpoint ? "present" : "none"));
	if (checkpoint) {
		printKeyValue(
			"Completed tools",
			accent(String(checkpoint.completedToolResults?.length ?? 0)),
		);
		printKeyValue(
			"Pending tools",
			accent(String(checkpoint.pendingToolCalls?.length ?? 0)),
		);
	}
	if (metadata.persistence?.lastSanitizedAt) {
		printKeyValue(
			"Last sanitized",
			accent(metadata.persistence.lastSanitizedAt),
		);
	}

	console.log("");
	printSection("Recent Messages");
	for (const message of session.messages.slice(-5)) {
		console.log(
			`${ANSI.cyan}${message.role}:${ANSI.reset} ${ANSI.brightCyan}${summarizeSessionMessage(message)}${ANSI.reset}`,
		);
	}
}

async function runSessionsClear(
	key: string,
	configPath?: string,
): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	const store = createRuntimeSessionStore(
		resolveAgentRuntimeConfig(loaded.config),
	);
	await store.delete(key);
	printInfo(`Deleted session ${accent(key)}`);
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

async function runCronList(configPath?: string): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	const service = createCronService(loaded.config, createLogger("fatal"), {
		agentConfig: resolveAgentRuntimeConfig(loaded.config),
	});
	const jobs = await service.listJobs(true);

	printSection("Cron Jobs");
	if (jobs.length === 0) {
		printNote("No scheduled jobs.");
		return;
	}

	for (const job of jobs) {
		console.log(
			`${accent(job.id)}\t${accent(job.name)}\t${accent(
				formatCronSchedule(job.schedule, loaded.config.cron.timezone),
			)}\t${accent(job.enabled ? "enabled" : "disabled")}`,
		);
	}
}

async function runCronAdd(options: CronAddOptions): Promise<void> {
	const loaded = await loadRequiredConfig(options.config);
	const schedule = resolveCliCronSchedule(options, loaded.config.cron.timezone);
	const deliver = options.deliver ?? false;
	if (deliver && (!options.channel?.trim() || !options.to?.trim())) {
		throw new Error("Delivery jobs require both --channel and --to.");
	}

	const service = createCronService(loaded.config, createLogger("fatal"), {
		agentConfig: resolveAgentRuntimeConfig(loaded.config),
	});
	const job = await service.addJob({
		name: options.name?.trim() || options.message.trim().slice(0, 30),
		schedule,
		message: options.message.trim(),
		deliver,
		...(options.channel?.trim() ? { channel: options.channel.trim() } : {}),
		...(options.to?.trim() ? { to: options.to.trim() } : {}),
		deleteAfterRun: schedule.kind === "at",
	});

	printInfo(`Created job ${accent(job.id)} (${accent(job.name)})`);
}

async function runCronRemove(id: string, configPath?: string): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	const service = createCronService(loaded.config, createLogger("fatal"), {
		agentConfig: resolveAgentRuntimeConfig(loaded.config),
	});
	const result = await service.removeJob(id);
	if (result === "not_found") {
		throw new Error(`Cron job not found: ${id}`);
	}
	if (result === "protected") {
		throw new Error(`Cron job is protected and cannot be removed: ${id}`);
	}
	printInfo(`Removed job ${accent(id)}`);
}

async function runCronRun(id: string, configPath?: string): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	const logger = createLogger("fatal");
	const manager = new ChannelManager(loaded.config, logger);
	const service = createCronService(loaded.config, logger, {
		manager,
		agentConfig: resolveAgentRuntimeConfig(loaded.config),
	});
	if (manager.hasEnabledChannels()) {
		await manager.start();
	}
	try {
		const ran = await service.runJob(id, true);
		if (!ran) {
			throw new Error(`Cron job not found: ${id}`);
		}
		const job = await service.getJob(id);
		if (job?.state.lastStatus === "error") {
			throw new Error(job.state.lastError || `Cron job ${id} failed.`);
		}
		printInfo(`Ran job ${accent(id)}`);
	} finally {
		if (manager.hasEnabledChannels()) {
			await manager.stop();
		}
	}
}

async function runCronStatus(configPath?: string): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	const service = createCronService(loaded.config, createLogger("fatal"), {
		agentConfig: resolveAgentRuntimeConfig(loaded.config),
	});
	const status = await service.status();

	printSection("Cron Status");
	printKeyValue("Enabled", accent(status.enabled ? "running" : "idle"));
	printKeyValue("Jobs", accent(String(status.jobs)));
	printKeyValue("Store", accentPath(loaded.config.cron.path));
	printKeyValue("Timezone", accent(loaded.config.cron.timezone));
	printKeyValue(
		"Next wake",
		accent(
			status.nextWakeAtMs === null
				? "none"
				: formatCronTimestamp(status.nextWakeAtMs, loaded.config.cron.timezone),
		),
	);
}

async function runHeartbeatRun(configPath?: string): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	await ensureWorkspace(loaded.config.workspace.path);
	await syncWorkspaceTemplates(loaded.config.workspace.path);

	const logger = createLogger("fatal");
	const manager = new ChannelManager(loaded.config, logger);
	const agentConfig = resolveAgentRuntimeConfig(loaded.config);
	const cronService = createCronService(loaded.config, logger, {
		manager,
		agentConfig,
	});
	const heartbeatService = createHeartbeatService(loaded.config, logger, {
		manager,
		agentConfig,
		cronService,
	});

	if (manager.hasEnabledChannels()) {
		await manager.start();
	}

	try {
		const response = await heartbeatService.triggerNow();
		if (!response?.trim()) {
			printNote("No active heartbeat tasks.");
			return;
		}

		printAgentReply(response.trim());
	} finally {
		if (manager.hasEnabledChannels()) {
			await manager.stop();
		}
	}
}

async function runHeartbeatStatus(configPath?: string): Promise<void> {
	const loaded = await loadRequiredConfig(configPath);
	const logger = createLogger("fatal");
	const manager = new ChannelManager(loaded.config, logger);
	const agentConfig = resolveAgentRuntimeConfig(loaded.config);
	const cronService = createCronService(loaded.config, logger, {
		manager,
		agentConfig,
	});
	const heartbeatService = createHeartbeatService(loaded.config, logger, {
		manager,
		agentConfig,
		cronService,
	});
	const target = await resolveHeartbeatTarget(
		manager,
		createRuntimeSessionStore(agentConfig),
	);

	printSection("Heartbeat Status");
	printKeyValue(
		"Enabled",
		accent(loaded.config.gateway.heartbeat.enabled ? "yes" : "no"),
	);
	printKeyValue("Running", accent(heartbeatService.isRunning() ? "yes" : "no"));
	printKeyValue(
		"Interval",
		accent(`${loaded.config.gateway.heartbeat.intervalSeconds}s`),
	);
	printKeyValue(
		"Keep recent",
		accent(String(loaded.config.gateway.heartbeat.keepRecentMessages)),
	);
	printKeyValue("File", accentPath(heartbeatService.heartbeatFile));
	printKeyValue(
		"File exists",
		accent((await pathExists(heartbeatService.heartbeatFile)) ? "yes" : "no"),
	);
	printKeyValue(
		"Target",
		accent(target ? `${target.channel}:${target.chatId}` : "none"),
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
		loaded.config.cron.path = resolveWorkspacePath(
			path.relative(previousWorkspace, loaded.config.cron.path),
			loaded.config.workspace.path,
		);
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

function createRuntimeSessionStore(
	config: ReturnType<typeof resolveAgentRuntimeConfig>,
) {
	return new FileSessionStore(config.sessionStore.path, {
		maxMessages: config.sessionStore.maxMessages,
		maxPersistedTextChars: config.sessionStore.maxPersistedTextChars,
		quarantineCorruptFiles: config.sessionStore.quarantineCorruptFiles,
	});
}

function getRuntimeTools(
	config: AppConfig,
	options: {
		cronService?: CronService;
		channel?: string;
		chatId?: string;
		inCronContext?: boolean;
	} = {},
): AgentTool[] {
	const tools: AgentTool[] = [];
	if (isNanobotFauxProvider(config.agent.provider)) {
		tools.push(...getNanobotFauxTools());
	}
	if (options.cronService) {
		tools.push(
			createCronTool({
				service: options.cronService,
				defaultTimeZone: config.cron.timezone,
				...(options.channel ? { channel: options.channel } : {}),
				...(options.chatId ? { chatId: options.chatId } : {}),
				...(options.inCronContext ? { inCronContext: true } : {}),
			}),
		);
	}
	return tools;
}

function createCronService(
	config: AppConfig,
	logger: ReturnType<typeof createLogger>,
	options: {
		manager?: ChannelManager;
		agentConfig: ResolvedAgentRuntimeConfig;
		dreamService?: DreamService;
	},
): CronService {
	const sessionStore = createRuntimeSessionStore(options.agentConfig);
	return new CronService(config.cron.path, {
		logger,
		maxRunHistory: config.cron.maxRunHistory,
		maxSleepMs: config.cron.maxSleepMs,
		onJob: async (job) => {
			if (job.payload.kind === "system_event") {
				if (job.payload.event === "dream") {
					if (!options.dreamService) {
						throw new Error("Dream service is not available.");
					}
					const result = await options.dreamService.run();
					return result.processed
						? `Dream processed ${result.entries} history entr${result.entries === 1 ? "y" : "ies"}.`
						: "Dream: nothing to process.";
				}
				return job.payload.message?.trim() || null;
			}
			const payload = job.payload;
			const agent = await createSessionAgent({
				config: options.agentConfig,
				sessionKey: `cron:${job.id}`,
				...(payload.channel ? { channel: payload.channel } : {}),
				sessionStore,
				tools: getRuntimeTools(config, {
					inCronContext: true,
					...(payload.channel ? { channel: payload.channel } : {}),
					...(payload.to ? { chatId: payload.to } : {}),
				}),
			});
			await agent.prompt(payload.message);
			const reply = getLatestAssistantText(agent.state.messages).trim();

			if (payload.deliver) {
				if (!payload.channel || !payload.to) {
					throw new Error(
						`Cron job '${job.id}' is missing delivery channel or target.`,
					);
				}
				if (!options.manager) {
					throw new Error(
						`Cron job '${job.id}' requires a channel manager for delivery.`,
					);
				}
				if (reply) {
					const shouldNotify = await evaluateBackgroundResult({
						config: options.agentConfig,
						taskContext: payload.message,
						response: reply,
						logger,
					});
					if (shouldNotify) {
						await options.manager.send({
							channel: payload.channel,
							chatId: payload.to,
							content: reply,
							role: "assistant",
						});
					}
				}
			}

			return reply || null;
		},
	});
}

function createDreamService(
	config: AppConfig,
	logger: ReturnType<typeof createLogger>,
	agentConfig: ResolvedAgentRuntimeConfig,
): DreamService {
	return new DreamService({
		store: new MemoryStore(config.workspace.path),
		config: agentConfig,
		maxBatchSize: config.agent.dream.maxBatchSize,
		maxIterations: config.agent.dream.maxIterations,
		logger,
	});
}

async function registerDreamCronJob(
	config: AppConfig,
	cronService: CronService,
): Promise<void> {
	await cronService.registerSystemJob({
		id: "dream",
		name: "dream",
		schedule: {
			kind: "every",
			everyMs: config.agent.dream.intervalHours * 60 * 60 * 1000,
		},
		event: "dream",
		message: "Dream memory consolidation for long-term memory.",
	});
}

function createHeartbeatService(
	config: AppConfig,
	logger: ReturnType<typeof createLogger>,
	options: {
		manager: ChannelManager;
		agentConfig: ResolvedAgentRuntimeConfig;
		cronService: CronService;
	},
): HeartbeatService {
	const sessionStore = createRuntimeSessionStore(options.agentConfig);
	return new HeartbeatService({
		workspacePath: config.workspace.path,
		config: options.agentConfig,
		intervalSeconds: config.gateway.heartbeat.intervalSeconds,
		keepRecentMessages: config.gateway.heartbeat.keepRecentMessages,
		enabled: config.gateway.heartbeat.enabled,
		timezone: config.cron.timezone,
		logger,
		resolveTarget: async () =>
			resolveHeartbeatTarget(options.manager, sessionStore),
		onExecute: async (tasks, target) =>
			runHeartbeatTasks({
				config: options.agentConfig,
				sessionStore,
				tasks,
				keepRecentMessages: config.gateway.heartbeat.keepRecentMessages,
				target,
				tools: getRuntimeTools(config, {
					cronService: options.cronService,
					...(target?.channel ? { channel: target.channel } : {}),
					...(target?.chatId ? { chatId: target.chatId } : {}),
				}),
			}),
		onNotify: async (response, target) => {
			await options.manager.send({
				channel: target.channel,
				chatId: target.chatId,
				content: response,
				role: "assistant",
			});
		},
	});
}

async function resolveHeartbeatTarget(
	manager: ChannelManager,
	sessionStore: ReturnType<typeof createRuntimeSessionStore>,
): Promise<BackgroundTarget | null> {
	const sessions = await sessionStore.list();
	const enabledChannels = new Set(
		manager
			.getSnapshots()
			.filter((snapshot) => snapshot.enabled)
			.map((snapshot) => snapshot.name),
	);
	return pickRecentChannelTarget(sessions, enabledChannels);
}

function resolveCliCronSchedule(
	options: CronAddOptions,
	defaultTimeZone: string,
): CronSchedule {
	const scheduleKinds = [
		options.everySeconds !== undefined,
		Boolean(options.cron?.trim()),
		Boolean(options.at?.trim()),
	].filter(Boolean).length;
	if (scheduleKinds !== 1) {
		throw new Error("Specify exactly one of --every-seconds, --cron, or --at.");
	}

	if (options.everySeconds !== undefined) {
		if (options.everySeconds <= 0) {
			throw new Error("--every-seconds must be positive.");
		}
		return {
			kind: "every",
			everyMs: options.everySeconds * 1000,
		};
	}

	if (options.cron?.trim()) {
		const timeZone = options.tz?.trim() || defaultTimeZone;
		if (!isValidTimeZone(timeZone)) {
			throw new Error(`Unknown timezone '${timeZone}'.`);
		}
		return {
			kind: "cron",
			expr: options.cron.trim(),
			tz: timeZone,
		};
	}

	return {
		kind: "at",
		atMs: parseNaiveIsoToMs(options.at?.trim() || "", defaultTimeZone),
	};
}

function formatCronSchedule(
	schedule: CronSchedule,
	defaultTimeZone: string,
): string {
	if (schedule.kind === "every") {
		return `every ${Math.floor(schedule.everyMs / 1000)}s`;
	}
	if (schedule.kind === "at") {
		return `at ${formatCronTimestamp(schedule.atMs, defaultTimeZone)}`;
	}
	return `cron: ${schedule.expr} (${schedule.tz || defaultTimeZone})`;
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

function summarizeSessionMessage(message: Message): string {
	if (typeof message.content === "string") {
		return truncatePreview(message.content);
	}

	if (Array.isArray(message.content)) {
		const text = message.content
			.flatMap((block) => {
				if (!block || typeof block !== "object") {
					return [];
				}
				if ("type" in block && block.type === "text" && "text" in block) {
					return [String(block.text)];
				}
				if (
					"type" in block &&
					block.type === "thinking" &&
					"thinking" in block
				) {
					return [String(block.thinking)];
				}
				if ("type" in block && block.type === "toolCall" && "name" in block) {
					return [`${String(block.name)}(...)`];
				}
				return [];
			})
			.join(" ");
		return truncatePreview(text || "(non-text content)");
	}

	return "(no content)";
}

function truncatePreview(text: string, limit = 120): string {
	if (text.length <= limit) {
		return text;
	}

	return `${text.slice(0, limit - 3)}...`;
}
