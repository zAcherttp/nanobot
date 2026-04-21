import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileSessionStore } from "../src/agent/session-store.js";
import { createCli } from "../src/cli/commands.js";
import {
	DEFAULT_CONFIG,
	loadConfig,
	saveConfig,
} from "../src/config/loader.js";
import { resolveLogsPath } from "../src/config/paths.js";
import {
	NANOBOT_FAUX_MODEL_ID,
	NANOBOT_FAUX_PROVIDER,
} from "../src/providers/faux.js";
import { createRuntimeLogStore } from "../src/utils/logging.js";

const CLI_TIMEOUT_MS = 10_000;

describe("cli control plane", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("onboard writes config and workspace files, then refreshes existing config non-destructively", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cli-"));
		const configPath = path.join(root, "config.json");
		const workspacePath = path.join(root, "workspace");

		const first = await runCli([
			"onboard",
			"-c",
			configPath,
			"-w",
			workspacePath,
		]);
		expect(first.stdout).toContain("Config saved at");
		expect(first.stdout).toContain("Workspace ready at");
		await expect(
			readFile(path.join(workspacePath, "AGENTS.md"), "utf8"),
		).resolves.toBeTruthy();
		await expect(
			readFile(path.join(workspacePath, "HEARTBEAT.md"), "utf8"),
		).resolves.toBeTruthy();

		const original = await loadConfig({ cliConfigPath: configPath });
		original.config.agent.provider = NANOBOT_FAUX_PROVIDER;
		original.config.agent.modelId = NANOBOT_FAUX_MODEL_ID;
		await saveConfig(original.config, configPath);

		const refreshed = await runCli(["onboard", "-c", configPath]);
		const afterRefresh = await loadConfig({ cliConfigPath: configPath });
		expect(refreshed.stdout).toContain("Config refreshed");
		expect(afterRefresh.config.agent.provider).toBe(NANOBOT_FAUX_PROVIDER);
		expect(afterRefresh.config.agent.modelId).toBe(NANOBOT_FAUX_MODEL_ID);
	});

	it("logs show, tail, and clear operate on the configured runtime log file", async () => {
		const { configPath } = await createFauxCliConfig();
		const store = createRuntimeLogStore(resolveLogsPath(configPath), {
			maxEntries: 10,
			maxPreviewChars: 200,
		});
		store.append("info", "Agent turn started", {
			component: "agent",
			event: "turn_start",
			sessionKey: "cli:direct",
		});
		store.append("error", "Tool failed", {
			component: "agent",
			event: "tool_error",
			sessionKey: "cli:direct",
		});

		const shown = await runCli([
			"logs",
			"show",
			"-c",
			configPath,
			"--level",
			"error",
		]);
		expect(shown.stdout).toContain("Runtime Logs");
		expect(shown.stdout).toContain("Tool failed");
		expect(shown.stdout).not.toContain("Agent turn started");

		const tailed = await runCli([
			"logs",
			"tail",
			"-c",
			configPath,
			"--session",
			"cli:direct",
			"-n",
			"1",
		]);
		expect(tailed.stdout).toContain("Tool failed");

		const cleared = await runCli(["logs", "clear", "-c", configPath]);
		const afterClear = await runCli(["logs", "show", "-c", configPath]);
		expect(cleared.stdout).toContain("Cleared runtime logs");
		expect(afterClear.stdout).toContain("No runtime log entries.");
	});

	it("sessions list, show, and clear inspect and remove file-backed sessions", async () => {
		const { configPath, sessionsPath } = await createFauxCliConfig();
		const store = new FileSessionStore(sessionsPath);
		await store.save({
			key: "cli:direct",
			createdAt: "2026-04-21T01:00:00.000Z",
			updatedAt: "2026-04-21T01:01:00.000Z",
			lastConsolidated: 0,
			metadata: {},
			messages: [
				{
					role: "user",
					content: "hello",
					timestamp: 1,
				} satisfies Message,
				{
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					timestamp: 2,
				} satisfies Message,
			],
		});

		const listed = await runCli(["sessions", "list", "-c", configPath]);
		const shown = await runCli([
			"sessions",
			"show",
			"cli:direct",
			"-c",
			configPath,
		]);
		const cleared = await runCli([
			"sessions",
			"clear",
			"cli:direct",
			"-c",
			configPath,
		]);

		expect(listed.stdout).toContain("Sessions");
		expect(listed.stdout).toContain("cli:direct");
		expect(shown.stdout).toContain("Session cli:direct");
		expect(shown.stdout).toContain("Messages:");
		expect(shown.stdout).toContain("user:");
		expect(cleared.stdout).toContain("Deleted session");
		expect(await store.load("cli:direct")).toBeNull();
	});

	it("cron add, list, status, and remove mutate the configured cron store", async () => {
		const { configPath, cronPath } = await createFauxCliConfig();

		const added = await runCli([
			"cron",
			"add",
			"-c",
			configPath,
			"-m",
			"say hi",
			"-n",
			"hello-job",
			"--every-seconds",
			"60",
		]);
		const cronRaw = JSON.parse(await readFile(cronPath, "utf8")) as {
			jobs: Array<{ id: string; name: string }>;
		};
		const jobId = cronRaw.jobs.find((job) => job.name === "hello-job")?.id;
		expect(jobId).toBeTruthy();

		const listed = await runCli(["cron", "list", "-c", configPath]);
		const status = await runCli(["cron", "status", "-c", configPath]);
		const removed = await runCli([
			"cron",
			"remove",
			jobId ?? "",
			"-c",
			configPath,
		]);
		const afterRemove = await runCli(["cron", "list", "-c", configPath]);

		expect(added.stdout).toContain("Created job");
		expect(listed.stdout).toContain("hello-job");
		expect(status.stdout).toContain("Cron Status");
		expect(status.stdout).toContain("Jobs:");
		expect(removed.stdout).toContain("Removed job");
		expect(afterRemove.stdout).toContain("No scheduled jobs.");
	});

	it("status-like channel and heartbeat commands report configured local state", async () => {
		const { configPath, workspacePath } = await createFauxCliConfig();
		await mkdir(workspacePath, { recursive: true });
		await writeFile(path.join(workspacePath, "HEARTBEAT.md"), "", "utf8");

		const channels = await runCli(["channels", "status", "-c", configPath]);
		const heartbeat = await runCli(["heartbeat", "status", "-c", configPath]);

		expect(channels.stdout).toContain("Channel Status");
		expect(channels.stdout).toContain("Telegram");
		expect(channels.stdout).toContain("disabled");
		expect(heartbeat.stdout).toContain("Heartbeat Status");
		expect(heartbeat.stdout).toContain("File exists:");
		expect(heartbeat.stdout).toContain("Target:");
	});

	it("agent --workspace overrides workspace, session store, and cron paths for one-shot runs", async () => {
		const { configPath, workspacePath, sessionsPath } =
			await createFauxCliConfig();
		const overrideWorkspace = path.join(
			await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cli-override-")),
			"workspace",
		);

		const output = await runCli([
			"agent",
			"-m",
			"inspect staging state",
			"-c",
			configPath,
			"-w",
			overrideWorkspace,
		]);
		const originalStore = new FileSessionStore(sessionsPath);
		const overrideStore = new FileSessionStore(
			path.join(overrideWorkspace, "sessions"),
		);

		expect(output.stdout).toContain(
			"Faux stream resumed after tool execution.",
		);
		expect(await originalStore.load("cli:direct")).toBeNull();
		expect(
			(await overrideStore.load("cli:direct"))?.messages.map(
				(message) => message.role,
			),
		).toEqual(["user", "assistant", "toolResult", "assistant"]);
		await expect(
			readFile(path.join(overrideWorkspace, "AGENTS.md"), "utf8"),
		).resolves.toBeTruthy();
		await expect(
			readFile(path.join(workspacePath, "AGENTS.md"), "utf8"),
		).rejects.toThrow();
	});
});

async function createFauxCliConfig(): Promise<{
	configPath: string;
	workspacePath: string;
	sessionsPath: string;
	cronPath: string;
}> {
	const root = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cli-"));
	const workspacePath = path.join(root, "workspace");
	const sessionsPath = path.join(workspacePath, "sessions");
	const cronPath = path.join(workspacePath, "cron", "jobs.json");
	const configPath = path.join(root, "config.json");
	const config = structuredClone(DEFAULT_CONFIG);
	config.workspace.path = workspacePath;
	config.agent.provider = NANOBOT_FAUX_PROVIDER;
	config.agent.modelId = NANOBOT_FAUX_MODEL_ID;
	config.agent.sessionStore.path = sessionsPath;
	config.cron.path = cronPath;
	config.tools.web.enabled = false;
	config.tools.workspace.enabled = false;
	config.tools.calendar.enabled = false;
	config.gateway.heartbeat.enabled = false;

	await saveConfig(config, configPath);
	return { configPath, workspacePath, sessionsPath, cronPath };
}

async function runCli(args: string[]): Promise<{
	stdout: string;
	stderr: string;
}> {
	vi.restoreAllMocks();
	const stdout: string[] = [];
	const stderr: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
		stdout.push(values.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
		stderr.push(values.map(String).join(" "));
	});

	const program = createCli("nanobot-ts");
	await withTimeout(
		program.parseAsync(["node", "nanobot-ts", ...args]),
		CLI_TIMEOUT_MS,
	);
	return {
		stdout: stdout.join("\n"),
		stderr: stderr.join("\n"),
	};
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`CLI command timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
