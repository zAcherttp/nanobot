import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedAgentRuntimeConfig } from "../src/agent/loop.js";
import type { BackgroundTarget } from "../src/background/index.js";
import { HeartbeatService } from "../src/heartbeat/index.js";
import type { Logger } from "../src/utils/logging.js";

const LOGGER: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
};

const RUNTIME_CONFIG = {} as ResolvedAgentRuntimeConfig;

describe("heartbeat service", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("skips execution when the decision is skip", async () => {
		const workspace = await createWorkspace();
		const onExecute = vi.fn(async () => "unused");
		const service = createService(workspace, {
			decideTasks: async () => ({
				action: "skip",
				tasks: "",
			}),
			onExecute,
		});

		const result = await service.triggerNow();

		expect(result).toBeNull();
		expect(onExecute).not.toHaveBeenCalled();
	});

	it("executes and notifies when the evaluator allows delivery", async () => {
		const workspace = await createWorkspace();
		const target: BackgroundTarget = {
			channel: "telegram",
			chatId: "42",
			sessionKey: "telegram:42",
		};
		const onExecute = vi.fn(async () => "heartbeat reply");
		const onNotify = vi.fn(async () => undefined);
		const evaluateResult = vi.fn(async () => true);
		const service = createService(workspace, {
			resolveTarget: async () => target,
			decideTasks: async () => ({
				action: "run",
				tasks: "Review outstanding work.",
			}),
			onExecute,
			onNotify,
			evaluateResult,
		});

		const result = await service.triggerNow();

		expect(result).toBe("heartbeat reply");
		expect(onExecute).toHaveBeenCalledWith("Review outstanding work.", target);
		expect(evaluateResult).toHaveBeenCalledWith(
			"Review outstanding work.",
			"heartbeat reply",
		);
		expect(onNotify).toHaveBeenCalledWith("heartbeat reply", target);
	});

	it("suppresses notification when the evaluator says no", async () => {
		const workspace = await createWorkspace();
		const target: BackgroundTarget = {
			channel: "telegram",
			chatId: "42",
			sessionKey: "telegram:42",
		};
		const onNotify = vi.fn(async () => undefined);
		const service = createService(workspace, {
			resolveTarget: async () => target,
			decideTasks: async () => ({
				action: "run",
				tasks: "Check background tasks.",
			}),
			onExecute: async () => "suppressed reply",
			onNotify,
			evaluateResult: async () => false,
		});

		const result = await service.triggerNow();

		expect(result).toBe("suppressed reply");
		expect(onNotify).not.toHaveBeenCalled();
	});

	it("runs on interval ticks and keeps going after errors", async () => {
		vi.useFakeTimers();
		const workspace = await createWorkspace();
		const service = createService(workspace, {
			intervalSeconds: 10,
		});
		const triggerNow = vi
			.spyOn(service, "triggerNow")
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(null);

		await service.start();
		expect(service.isRunning()).toBe(true);

		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(10_000);
		await service.stop();

		expect(triggerNow).toHaveBeenCalledTimes(2);
		expect(LOGGER.error).toHaveBeenCalledWith("Heartbeat tick failed", {
			error: expect.any(Error),
		});
	});

	it("returns null when HEARTBEAT.md is missing", async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-heartbeat-"),
		);
		const onExecute = vi.fn(async () => "unused");
		const service = createService(workspace, {
			decideTasks: async () => ({
				action: "run",
				tasks: "check",
			}),
			onExecute,
		});

		const result = await service.triggerNow();

		expect(result).toBeNull();
		expect(onExecute).not.toHaveBeenCalled();
	});

	it("reports isRunning correctly after start and stop", async () => {
		vi.useFakeTimers();
		const workspace = await createWorkspace();
		const service = createService(workspace, {
			intervalSeconds: 60,
		});

		expect(service.isRunning()).toBe(false);
		await service.start();
		expect(service.isRunning()).toBe(true);
		await service.stop();
		expect(service.isRunning()).toBe(false);
	});

	it("can be restarted after stop", async () => {
		vi.useFakeTimers();
		const workspace = await createWorkspace();
		const service = createService(workspace, {
			intervalSeconds: 10,
		});
		const triggerNow = vi.spyOn(service, "triggerNow").mockResolvedValue(null);

		await service.start();
		await vi.advanceTimersByTimeAsync(10_000);
		await service.stop();

		triggerNow.mockClear();

		await service.start();
		await vi.advanceTimersByTimeAsync(10_000);
		await service.stop();

		expect(triggerNow).toHaveBeenCalledTimes(1);
	});
});

async function createWorkspace(): Promise<string> {
	const workspace = await mkdtemp(
		path.join(os.tmpdir(), "nanobot-ts-heartbeat-"),
	);
	await writeFile(
		path.join(workspace, "HEARTBEAT.md"),
		"# Heartbeat\n\nReview outstanding work.\n",
		"utf8",
	);
	return workspace;
}

function createService(
	workspacePath: string,
	options: {
		intervalSeconds?: number;
		resolveTarget?: () => Promise<BackgroundTarget | null>;
		decideTasks?: (
			content: string,
		) => Promise<{ action: "skip" | "run"; tasks: string }>;
		onExecute?: (
			tasks: string,
			target: BackgroundTarget | null,
		) => Promise<string>;
		onNotify?: (response: string, target: BackgroundTarget) => Promise<void>;
		evaluateResult?: (
			taskContext: string,
			response: string,
		) => Promise<boolean>;
	} = {},
): HeartbeatService {
	return new HeartbeatService({
		workspacePath,
		config: RUNTIME_CONFIG,
		intervalSeconds: options.intervalSeconds ?? 30,
		keepRecentMessages: 8,
		enabled: true,
		logger: LOGGER,
		resolveTarget: options.resolveTarget,
		decideTasks: options.decideTasks,
		onExecute: options.onExecute,
		onNotify: options.onNotify,
		evaluateResult: options.evaluateResult,
	});
}
