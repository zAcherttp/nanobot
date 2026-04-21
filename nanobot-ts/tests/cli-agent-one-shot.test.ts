import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileSessionStore } from "../src/agent/session-store.js";
import { createCli } from "../src/cli/commands.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/config/loader.js";
import {
	NANOBOT_FAUX_MODEL_ID,
	NANOBOT_FAUX_PROVIDER,
} from "../src/providers/faux.js";

const CLI_TIMEOUT_MS = 10_000;

describe("cli agent one-shot mode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends one message, completes the faux tool loop, prints the final reply, and exits", async () => {
		const { configPath, sessionsPath } = await createFauxCliConfig();
		const output = await runAgentOneShot([
			"agent",
			"-m",
			"inspect staging state",
			"-c",
			configPath,
		]);

		expect(output).toContain("nanobot:");
		expect(output).toContain("Faux stream resumed after tool execution.");
		expect(output).toContain("faux tool result for: inspect staging state");
		expect(output).not.toContain("Interactive mode");
		expect(output).not.toContain("toolResult");

		const store = new FileSessionStore(sessionsPath);
		const session = await store.load("cli:direct");
		expect(session?.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("persists one-shot messages under the provided session key", async () => {
		const { configPath, sessionsPath } = await createFauxCliConfig();
		const output = await runAgentOneShot([
			"agent",
			"-m",
			"inspect staging state",
			"--session",
			"cli:test-one-shot",
			"-c",
			configPath,
		]);

		expect(output).toContain("Faux stream resumed after tool execution.");

		const store = new FileSessionStore(sessionsPath);
		const customSession = await store.load("cli:test-one-shot");
		const defaultSession = await store.load("cli:direct");
		expect(customSession?.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(defaultSession).toBeNull();
	});
});

async function createFauxCliConfig(): Promise<{
	configPath: string;
	sessionsPath: string;
}> {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-cli-"));
	const workspacePath = path.join(dataDir, "workspace");
	const sessionsPath = path.join(dataDir, "sessions");
	const configPath = path.join(dataDir, "config.json");
	const config = structuredClone(DEFAULT_CONFIG);
	config.workspace.path = workspacePath;
	config.agent.provider = NANOBOT_FAUX_PROVIDER;
	config.agent.modelId = NANOBOT_FAUX_MODEL_ID;
	config.agent.sessionStore.path = sessionsPath;
	config.tools.web.enabled = false;
	config.tools.workspace.enabled = false;
	config.tools.calendar.enabled = false;

	await saveConfig(config, configPath);
	return { configPath, sessionsPath };
}

async function runAgentOneShot(args: string[]): Promise<string> {
	const output: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
		output.push(values.map(String).join(" "));
	});

	const program = createCli("nanobot-ts");
	await withTimeout(
		program.parseAsync(["node", "nanobot-ts", ...args]),
		CLI_TIMEOUT_MS,
	);
	return output.join("\n");
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
