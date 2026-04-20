import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AssistantMessage, Context } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentRuntimeConfig } from "../src/agent/loop.js";
import { DEFAULT_CONFIG } from "../src/config/loader.js";
import { DreamService } from "../src/dream/index.js";
import { MemoryStore } from "../src/memory/index.js";
import {
	ensureNanobotFauxProvider,
	NANOBOT_FAUX_MODEL_ID,
	NANOBOT_FAUX_PROVIDER,
} from "../src/providers/faux.js";

describe("dream - execution", () => {
	let store: MemoryStore;
	let workspace: string;

	beforeEach(async () => {
		ensureNanobotFauxProvider();
		workspace = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-dream-"));
		store = new MemoryStore(workspace, { maxHistoryEntries: 2 });
		await store.init();
		await store.writeMemory("# Memory\n");
		await store.writeSoul("# Soul\n");
		await store.writeUser("# User\n");
		await store.writeGoals("# Goals\n- Ship TS rewrite\n");
	});

	it("no-ops when there is no unprocessed history", async () => {
		const complete = vi.fn();
		const runPhaseTwo = vi.fn();
		const dream = createDreamService({ complete, runPhaseTwo });

		await expect(dream.run()).resolves.toEqual({
			processed: false,
			cursor: 0,
			entries: 0,
			edits: 0,
		});
		expect(complete).not.toHaveBeenCalled();
		expect(runPhaseTwo).not.toHaveBeenCalled();
	});

	it("calls phase two with analysis and current memory file context", async () => {
		await store.appendHistory("User confirmed the TS Dream plan.");
		const complete = vi.fn(async (_model, context: Context) => {
			expect(context.messages[0]?.role).toBe("user");
			expect(String(context.messages[0]?.content)).toContain(
				"User confirmed the TS Dream plan.",
			);
			expect(String(context.messages[0]?.content)).toContain("### GOALS.md");
			return assistant("analysis result");
		});
		const runPhaseTwo = vi.fn(async () => 1);
		const dream = createDreamService({ complete, runPhaseTwo });

		const result = await dream.run();

		expect(result.processed).toBe(true);
		expect(result.entries).toBe(1);
		expect(result.edits).toBe(1);
		expect(runPhaseTwo).toHaveBeenCalledWith(
			"analysis result",
			expect.stringContaining("### memory/MEMORY.md"),
		);
	});

	it("advances the dream cursor after processing", async () => {
		await store.appendHistory("first");
		const secondCursor = await store.appendHistory("second");
		const dream = createDreamService();

		await dream.run();

		await expect(store.getLastDreamCursor()).resolves.toBe(secondCursor);
	});

	it("compacts already-processed history entries", async () => {
		await store.appendHistory("first");
		await store.appendHistory("second");
		await store.appendHistory("third");
		const dream = createDreamService();

		await dream.run();

		const entries = await store.readUnprocessedHistory(0);
		expect(entries.map((entry) => entry.content)).toEqual(["second", "third"]);
	});

	function createDreamService(
		options: {
			complete?: DreamServiceConstructorComplete;
			runPhaseTwo?: (analysis: string, fileContext: string) => Promise<number>;
		} = {},
	): DreamService {
		const config = resolveAgentRuntimeConfig({
			...DEFAULT_CONFIG,
			workspace: {
				path: workspace,
			},
			agent: {
				...DEFAULT_CONFIG.agent,
				provider: NANOBOT_FAUX_PROVIDER,
				modelId: NANOBOT_FAUX_MODEL_ID,
				sessionStore: {
					...DEFAULT_CONFIG.agent.sessionStore,
					path: path.join(workspace, "sessions"),
				},
			},
		});
		return new DreamService({
			store,
			config,
			complete: options.complete ?? (async () => assistant("[SKIP]")),
			runPhaseTwo: options.runPhaseTwo ?? (async () => 0),
			now: () => new Date("2026-04-20T00:00:00.000Z"),
		});
	}
});

type DreamServiceConstructorComplete = ConstructorParameters<
	typeof DreamService
>[0]["complete"];

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: NANOBOT_FAUX_PROVIDER,
		model: NANOBOT_FAUX_MODEL_ID,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}
