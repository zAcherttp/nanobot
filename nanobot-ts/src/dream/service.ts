import type {
	ThinkingLevel,
	ToolExecutionMode,
} from "@mariozechner/pi-agent-core";
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	completeSimple,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type TextContent,
	type Transport,
} from "@mariozechner/pi-ai";
import type { AppConfig } from "../config/schema.js";
import type { HistoryEntry, MemoryStore } from "../memory/index.js";
import { renderTemplate } from "../templates/index.js";
import type { Logger } from "../utils/logging.js";
import { createDreamTools, DREAM_EDIT_FILE_TOOL } from "./tools.js";

export interface DreamRuntimeConfig {
	provider: AppConfig["agent"]["provider"];
	modelId: string;
	model: Model<Api>;
	apiKey?: string;
	workspacePath: string;
	thinkingLevel: ThinkingLevel;
	temperature: number;
	maxTokens: number;
	transport: Transport;
	maxRetryDelayMs: number;
	toolExecution: ToolExecutionMode;
}

export interface DreamRunResult {
	processed: boolean;
	cursor: number;
	entries: number;
	edits: number;
}

export interface DreamServiceOptions {
	store: MemoryStore;
	config: DreamRuntimeConfig;
	maxBatchSize?: number;
	maxIterations?: number;
	logger?: Logger;
	complete?: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	runPhaseTwo?: (analysis: string, fileContext: string) => Promise<number>;
	now?: () => Date;
}

export class DreamService {
	private readonly maxBatchSize: number;
	private readonly maxIterations: number;
	private readonly complete;
	private readonly phaseTwoRunner;
	private readonly now: () => Date;
	private initPromise: Promise<void> | undefined;
	private pending = Promise.resolve<DreamRunResult>({
		processed: false,
		cursor: 0,
		entries: 0,
		edits: 0,
	});

	constructor(private readonly options: DreamServiceOptions) {
		this.maxBatchSize = options.maxBatchSize ?? 20;
		this.maxIterations = options.maxIterations ?? 10;
		this.complete = options.complete ?? completeSimple;
		this.phaseTwoRunner =
			options.runPhaseTwo ??
			((analysis, fileContext) => this.runPhaseTwo(analysis, fileContext));
		this.now = options.now ?? (() => new Date());
	}

	async run(): Promise<DreamRunResult> {
		const next = this.pending
			.catch(() => ({
				processed: false,
				cursor: 0,
				entries: 0,
				edits: 0,
			}))
			.then(() => this.runOnce());
		this.pending = next;
		return next;
	}

	private async runOnce(): Promise<DreamRunResult> {
		await this.ensureReady();
		this.options.logger?.info("Dream run started", {
			component: "dream",
			event: "start",
		});
		const lastCursor = await this.options.store.getLastDreamCursor();
		const entries = await this.options.store.readUnprocessedHistory(lastCursor);
		if (entries.length === 0) {
			this.options.logger?.info("Dream skipped empty history", {
				component: "dream",
				event: "skip_empty",
				cursor: lastCursor,
			});
			return {
				processed: false,
				cursor: lastCursor,
				entries: 0,
				edits: 0,
			};
		}

		const batch = entries.slice(0, this.maxBatchSize);
		const historyText = formatHistoryBatch(batch);
		const fileContext = await this.buildFileContext();
		let analysis: string;
		try {
			this.options.logger?.info("Dream phase 1 started", {
				component: "dream",
				event: "phase1_start",
				entries: batch.length,
			});
			analysis = await this.runPhaseOne(historyText, fileContext);
			this.options.logger?.info("Dream phase 1 completed", {
				component: "dream",
				event: "phase1_end",
				analysisPreview: analysis,
			});
		} catch (error) {
			this.options.logger?.error("Dream phase 1 failed", {
				component: "dream",
				event: "phase1_error",
				error,
			});
			return {
				processed: false,
				cursor: lastCursor,
				entries: 0,
				edits: 0,
			};
		}

		let edits = 0;
		try {
			this.options.logger?.info("Dream phase 2 started", {
				component: "dream",
				event: "phase2_start",
			});
			edits = await this.phaseTwoRunner(analysis, fileContext);
			this.options.logger?.info("Dream phase 2 completed", {
				component: "dream",
				event: "phase2_end",
				edits,
			});
		} catch (error) {
			this.options.logger?.error("Dream phase 2 failed", {
				component: "dream",
				event: "phase2_error",
				error,
			});
		}

		const cursor = batch.at(-1)?.cursor ?? lastCursor;
		await this.options.store.setLastDreamCursor(cursor);
		await this.options.store.compactHistory();
		this.options.logger?.info("Dream processed memory history", {
			component: "dream",
			event: "end",
			cursor,
			entries: batch.length,
			edits,
		});
		return {
			processed: true,
			cursor,
			entries: batch.length,
			edits,
		};
	}

	private async runPhaseOne(
		historyText: string,
		fileContext: string,
	): Promise<string> {
		const systemPrompt = await renderTemplate("agent/dream_phase1.md");
		const response = await this.complete(
			this.options.config.model,
			{
				systemPrompt,
				messages: [
					{
						role: "user",
						content: `## Conversation History\n${historyText}\n\n${fileContext}`,
						timestamp: this.now().getTime(),
					},
				],
			},
			this.modelOptions(2_048),
		);
		return extractAssistantText(response);
	}

	private async runPhaseTwo(
		analysis: string,
		fileContext: string,
	): Promise<number> {
		const systemPrompt = await renderTemplate("agent/dream_phase2.md");
		const tools = createDreamTools(this.options.config.workspacePath);
		let turns = 0;
		let edits = 0;
		const agent = new Agent({
			initialState: {
				systemPrompt,
				model: this.options.config.model,
				thinkingLevel: this.options.config.thinkingLevel,
				tools,
				messages: [],
			},
			streamFn: (model, context, options) =>
				streamSimple(model, context, {
					...options,
					...this.modelOptions(this.options.config.maxTokens),
				}),
			toolExecution: this.options.config.toolExecution,
			transport: this.options.config.transport,
			maxRetryDelayMs: this.options.config.maxRetryDelayMs,
			...(this.options.config.apiKey
				? { getApiKey: () => this.options.config.apiKey }
				: {}),
		});
		agent.subscribe((event: AgentEvent) => {
			if (event.type === "turn_start") {
				turns += 1;
				if (turns > this.maxIterations) {
					agent.abort();
				}
				return;
			}
			if (
				event.type === "tool_execution_end" &&
				event.toolName === DREAM_EDIT_FILE_TOOL &&
				!event.isError
			) {
				edits += 1;
			}
		});
		await agent.prompt(`## Analysis Result\n${analysis}\n\n${fileContext}`);
		return edits;
	}

	private async buildFileContext(): Promise<string> {
		const memory = await this.options.store.readMemory();
		const soul = await this.options.store.readSoul();
		const user = await this.options.store.readUser();
		const goals = await this.options.store.readGoals();
		return [
			"## Current Files",
			`Current date: ${this.now().toISOString().slice(0, 10)}`,
			formatCurrentFile("memory/MEMORY.md", memory),
			formatCurrentFile("SOUL.md", soul),
			formatCurrentFile("USER.md", user),
			formatCurrentFile("GOALS.md", goals),
		].join("\n\n");
	}

	private modelOptions(maxTokens: number): SimpleStreamOptions {
		return {
			temperature: this.options.config.temperature,
			maxTokens,
			transport: this.options.config.transport,
			maxRetryDelayMs: this.options.config.maxRetryDelayMs,
			...(this.options.config.apiKey
				? { apiKey: this.options.config.apiKey }
				: {}),
		};
	}

	private ensureReady(): Promise<void> {
		this.initPromise ??= this.options.store.init();
		return this.initPromise;
	}
}

function formatHistoryBatch(entries: readonly HistoryEntry[]): string {
	return entries
		.map((entry) => {
			const signals =
				Object.keys(entry.signals).length > 0
					? `\nSignals: ${JSON.stringify(entry.signals)}`
					: "";
			return `[${entry.timestamp}] ${entry.content}${signals}`;
		})
		.join("\n\n");
}

function formatCurrentFile(filename: string, content: string): string {
	return [
		`### ${filename}`,
		`Chars: ${content.length}`,
		"```md",
		content.trim() || "(empty)",
		"```",
	].join("\n");
}

function extractAssistantText(message: AssistantMessage | Message): string {
	if (message.role !== "assistant") {
		return "";
	}
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
}
