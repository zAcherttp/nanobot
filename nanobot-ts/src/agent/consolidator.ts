import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	completeSimple,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type Transport,
} from "@mariozechner/pi-ai";

import type { AppConfig } from "../config/schema.js";
import { formatMessagesForHistory, type MemoryStore } from "../memory/index.js";
import { renderTemplate } from "../templates/index.js";
import {
	findLegalMessageStart,
	retainRecentLegalSuffix,
} from "./session-persistence.js";
import type { SessionRecord, SessionStore } from "./session-store.js";

const CONSOLIDATOR_MAX_ROUNDS = 5;
const CONSOLIDATOR_MAX_CHUNK_MESSAGES = 60;
const CONSOLIDATOR_SAFETY_BUFFER = 1_024;

export interface ConsolidatorRuntimeConfig {
	provider: AppConfig["agent"]["provider"];
	modelId: string;
	model: Model<Api>;
	apiKey?: string;
	workspacePath: string;
	skills: string[];
	contextWindowTokens: number;
	thinkingLevel: ThinkingLevel;
	temperature: number;
	maxTokens: number;
	transport: Transport;
	maxRetryDelayMs: number;
	sessionStore: {
		maxMessages: number;
		maxPersistedTextChars: number;
		path: string;
	};
}

export interface ConsolidatorPromptContext {
	workspacePath: string;
	selectedSkills: string[];
	channel?: string;
}

export interface ConsolidatorArchiveResult {
	content: string;
	signals: Record<string, string>;
}

export interface ConsolidatorOptions {
	memoryStore: MemoryStore;
	sessionStore: SessionStore;
	config: ConsolidatorRuntimeConfig;
	buildSystemPrompt: (context: ConsolidatorPromptContext) => Promise<string>;
	getTools?: () => AgentTool[] | Promise<AgentTool[]>;
	complete?: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
}

export interface ConsolidationEstimate {
	promptTokens: number;
	unconsolidatedMessageCount: number;
	contextWindowTokens: number;
}

export class Consolidator {
	private readonly sessionLocks = new Map<string, Promise<void>>();
	private readonly complete;
	private initPromise: Promise<void> | undefined;

	constructor(private readonly options: ConsolidatorOptions) {
		this.complete = options.complete ?? completeSimple;
	}

	async estimateSessionPromptTokens(
		session: SessionRecord,
		channel?: string,
	): Promise<number> {
		const systemPrompt = await this.options.buildSystemPrompt({
			workspacePath: this.options.config.workspacePath,
			selectedSkills: this.options.config.skills,
			...(channel ? { channel } : {}),
		});
		const tools = await this.resolveTools();
		const history = getPromptHistory(session);
		return estimateContextTokens({
			systemPrompt,
			messages: history,
			tools: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		});
	}

	async estimateSession(
		sessionKey: string,
		channel?: string,
	): Promise<ConsolidationEstimate> {
		const session = await this.options.sessionStore.load(sessionKey);
		if (!session) {
			return {
				promptTokens: 0,
				unconsolidatedMessageCount: 0,
				contextWindowTokens: this.options.config.contextWindowTokens,
			};
		}

		return {
			promptTokens: await this.estimateSessionPromptTokens(session, channel),
			unconsolidatedMessageCount: getUnconsolidatedMessages(session).length,
			contextWindowTokens: this.options.config.contextWindowTokens,
		};
	}

	pickConsolidationBoundary(
		session: SessionRecord,
		tokensToRemove: number,
	): number {
		const start = normalizeLastConsolidated(
			session.lastConsolidated,
			session.messages.length,
		);
		const maxBoundary = Math.min(
			session.messages.length,
			start + CONSOLIDATOR_MAX_CHUNK_MESSAGES,
		);
		let bestBoundary = start;
		let removedTokensAtBest = 0;

		for (let boundary = start + 1; boundary <= maxBoundary; boundary += 1) {
			if (session.messages[boundary]?.role !== "user") {
				continue;
			}

			const candidateChunk = session.messages.slice(start, boundary);
			if (candidateChunk.length === 0) {
				continue;
			}

			const removedTokens = estimateMessagesTokens(candidateChunk);
			bestBoundary = boundary;
			removedTokensAtBest = removedTokens;
			if (removedTokens >= tokensToRemove) {
				return boundary;
			}
		}

		return removedTokensAtBest > 0 ? bestBoundary : start;
	}

	async archive(
		messages: readonly Message[],
	): Promise<ConsolidatorArchiveResult | null> {
		await this.ensureReady();
		if (messages.length === 0) {
			return null;
		}

		const transcript = formatMessagesForHistory(messages);
		if (!transcript.trim()) {
			return null;
		}

		const systemPrompt = await renderTemplate("agent/consolidator_archive.md");
		try {
			const response = await this.complete(
				this.options.config.model,
				{
					systemPrompt,
					messages: [
						{
							role: "user",
							content: transcript,
							timestamp: Date.now(),
						},
					],
				},
				{
					temperature: this.options.config.temperature,
					maxTokens: this.options.config.maxTokens,
					transport: this.options.config.transport,
					maxRetryDelayMs: this.options.config.maxRetryDelayMs,
					...(this.options.config.apiKey
						? { apiKey: this.options.config.apiKey }
						: {}),
				},
			);
			const parsed = parseArchiveAssistantMessage(response);
			await this.options.memoryStore.archiveSummary(parsed);
			return parsed;
		} catch {
			await this.options.memoryStore.rawArchive(messages);
			return null;
		}
	}

	async maybeConsolidateByTokens(
		sessionKey: string,
		channel?: string,
	): Promise<SessionRecord | null> {
		await this.ensureReady();
		return this.withSessionLock(sessionKey, async () => {
			let session = await this.options.sessionStore.load(sessionKey);
			if (!session) {
				return null;
			}

			for (let round = 0; round < CONSOLIDATOR_MAX_ROUNDS; round += 1) {
				const estimate = await this.estimateSessionPromptTokens(
					session,
					channel,
				);
				const threshold =
					this.options.config.contextWindowTokens - CONSOLIDATOR_SAFETY_BUFFER;
				if (estimate <= threshold) {
					break;
				}

				const boundary = this.pickConsolidationBoundary(
					session,
					estimate - threshold,
				);
				const start = normalizeLastConsolidated(
					session.lastConsolidated,
					session.messages.length,
				);
				if (boundary <= start) {
					break;
				}

				const chunk = session.messages.slice(start, boundary);
				if (chunk.length === 0) {
					break;
				}

				await this.archive(chunk);
				session = {
					...session,
					lastConsolidated: boundary,
					updatedAt: new Date().toISOString(),
				};
				await this.options.sessionStore.save(session);
			}

			return session;
		});
	}

	async archiveUnconsolidated(sessionKey: string): Promise<void> {
		await this.ensureReady();
		await this.withSessionLock(sessionKey, async () => {
			const session = await this.options.sessionStore.load(sessionKey);
			if (!session) {
				return;
			}

			const chunk = getUnconsolidatedMessages(session);
			if (chunk.length === 0) {
				return;
			}

			await this.archive(chunk);
		});
	}

	private async withSessionLock<T>(
		sessionKey: string,
		task: () => Promise<T>,
	): Promise<T> {
		const previous = this.sessionLocks.get(sessionKey) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(task);
		const sentinel = current.then(
			() => undefined,
			() => undefined,
		);
		this.sessionLocks.set(sessionKey, sentinel);

		try {
			return await current;
		} finally {
			if (this.sessionLocks.get(sessionKey) === sentinel) {
				this.sessionLocks.delete(sessionKey);
			}
		}
	}

	private async ensureReady(): Promise<void> {
		this.initPromise ??= this.options.memoryStore.init();
		await this.initPromise;
	}

	private async resolveTools(): Promise<AgentTool[]> {
		if (!this.options.getTools) {
			return [];
		}
		return this.options.getTools();
	}
}

export function getUnconsolidatedMessages(session: SessionRecord): Message[] {
	const start = normalizeLastConsolidated(
		session.lastConsolidated,
		session.messages.length,
	);
	return session.messages
		.slice(start)
		.map((message) => structuredClone(message));
}

export function normalizeLastConsolidated(
	value: number,
	messageCount: number,
): number {
	if (!Number.isFinite(value)) {
		return 0;
	}

	const normalized = Math.max(0, Math.trunc(value));
	return Math.min(normalized, Math.max(0, messageCount));
}

export function resetSessionConsolidation(
	session: SessionRecord,
): SessionRecord {
	return {
		...session,
		lastConsolidated: 0,
	};
}

function getPromptHistory(session: SessionRecord): Message[] {
	const unconsolidated = getUnconsolidatedMessages(session);
	const retained = retainRecentLegalSuffix(
		unconsolidated,
		session.messages.length,
	);
	return retained.slice(findLegalMessageStart(retained));
}

function estimateContextTokens(context: Context): number {
	const serialized = JSON.stringify({
		systemPrompt: context.systemPrompt ?? "",
		messages: context.messages,
		tools: context.tools ?? [],
	});
	return Math.max(1, Math.ceil(serialized.length / 4));
}

function estimateMessagesTokens(messages: readonly Message[]): number {
	return estimateContextTokens({
		messages: [...messages],
	});
}

function parseArchiveAssistantMessage(
	message: AssistantMessage,
): ConsolidatorArchiveResult {
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
	if (!text) {
		return {
			content: "",
			signals: {},
		};
	}

	try {
		const parsed = JSON.parse(text) as {
			content?: unknown;
			signals?: Record<string, unknown>;
		};
		if (typeof parsed.content === "string" && parsed.content.trim()) {
			return {
				content: parsed.content.trim(),
				signals: Object.fromEntries(
					Object.entries(parsed.signals ?? {}).map(([key, value]) => [
						key,
						String(value),
					]),
				),
			};
		}
	} catch {
		// Fallback to plain text below.
	}

	return {
		content: text,
		signals: {},
	};
}
