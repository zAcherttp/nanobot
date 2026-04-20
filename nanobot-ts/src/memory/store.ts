import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	AssistantMessage,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@mariozechner/pi-ai";

export interface HistoryEntry {
	cursor: number;
	timestamp: string;
	content: string;
	signals: Record<string, string>;
}

export interface MemoryStoreOptions {
	maxHistoryEntries?: number;
}

export interface ArchivedMemoryEntry {
	content: string;
	signals?: Record<string, string>;
}

const TIMESTAMP_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*/;
const ENTRY_START_RE = /^\[(\d{4}-\d{2}-\d{2}[^\]]*)\]\s*/;
const RAW_MESSAGE_RE =
	/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s+[A-Z][A-Z0-9_]*(?:\s+\[tools:\s*[^\]]+\])?:/;

export class MemoryStore {
	readonly workspace: string;
	readonly maxHistoryEntries: number;
	readonly memoryDir: string;
	readonly memoryFile: string;
	readonly historyFile: string;
	readonly legacyHistoryFile: string;
	readonly soulFile: string;
	readonly userFile: string;
	readonly goalsFile: string;
	readonly cursorFile: string;
	readonly dreamCursorFile: string;

	constructor(workspacePath: string, options: MemoryStoreOptions = {}) {
		this.workspace = workspacePath;
		this.maxHistoryEntries = options.maxHistoryEntries ?? 1000;
		this.memoryDir = path.join(workspacePath, "memory");
		this.memoryFile = path.join(this.memoryDir, "MEMORY.md");
		this.historyFile = path.join(this.memoryDir, "history.jsonl");
		this.legacyHistoryFile = path.join(this.memoryDir, "HISTORY.md");
		this.soulFile = path.join(workspacePath, "SOUL.md");
		this.userFile = path.join(workspacePath, "USER.md");
		this.goalsFile = path.join(workspacePath, "GOALS.md");
		this.cursorFile = path.join(this.memoryDir, ".cursor");
		this.dreamCursorFile = path.join(this.memoryDir, ".dream_cursor");
	}

	async init(): Promise<void> {
		await mkdir(this.memoryDir, { recursive: true });
		await this.maybeMigrateLegacyHistory();
	}

	async readMemory(): Promise<string> {
		return this.readTextFile(this.memoryFile);
	}

	async writeMemory(content: string): Promise<void> {
		await this.writeTextFile(this.memoryFile, content);
	}

	async readSoul(): Promise<string> {
		return this.readTextFile(this.soulFile);
	}

	async writeSoul(content: string): Promise<void> {
		await this.writeTextFile(this.soulFile, content);
	}

	async readUser(): Promise<string> {
		return this.readTextFile(this.userFile);
	}

	async writeUser(content: string): Promise<void> {
		await this.writeTextFile(this.userFile, content);
	}

	async readGoals(): Promise<string> {
		return this.readTextFile(this.goalsFile);
	}

	async writeGoals(content: string): Promise<void> {
		await this.writeTextFile(this.goalsFile, content);
	}

	async getMemoryContext(): Promise<string> {
		const longTerm = await this.readMemory();
		if (!longTerm.trim()) {
			return "";
		}

		return `## Long-term Memory\n${longTerm}`;
	}

	async appendHistory(
		entry: string,
		signals: Record<string, string> = {},
	): Promise<number> {
		const cursor = await this.nextCursor();
		const record: HistoryEntry = {
			cursor,
			timestamp: formatTimestamp(new Date()),
			content: entry.trimEnd(),
			signals,
		};
		await writeFile(this.historyFile, `${JSON.stringify(record)}\n`, {
			encoding: "utf8",
			flag: "a",
		});
		await this.writeTextFile(this.cursorFile, String(cursor));
		return cursor;
	}

	async archiveSummary(entry: ArchivedMemoryEntry): Promise<number> {
		return this.appendHistory(entry.content, entry.signals ?? {});
	}

	async rawArchive(messages: readonly Message[]): Promise<number | null> {
		if (messages.length === 0) {
			return null;
		}

		return this.appendHistory(
			`[RAW] ${messages.length} messages\n${formatMessagesForHistory(messages)}`,
			{},
		);
	}

	async readUnprocessedHistory(sinceCursor: number): Promise<HistoryEntry[]> {
		const entries = await this.readEntries();
		return entries.filter((entry) => entry.cursor > sinceCursor);
	}

	async compactHistory(): Promise<void> {
		if (this.maxHistoryEntries <= 0) {
			return;
		}

		const entries = await this.readEntries();
		if (entries.length <= this.maxHistoryEntries) {
			return;
		}

		await this.writeEntries(entries.slice(-this.maxHistoryEntries));
	}

	async getLastDreamCursor(): Promise<number> {
		try {
			const raw = await this.readTextFile(this.dreamCursorFile);
			const parsed = Number.parseInt(raw.trim(), 10);
			return Number.isFinite(parsed) ? parsed : 0;
		} catch {
			return 0;
		}
	}

	async setLastDreamCursor(cursor: number): Promise<void> {
		await this.writeTextFile(this.dreamCursorFile, String(cursor));
	}

	private async readTextFile(filePath: string): Promise<string> {
		try {
			return await readFile(filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return "";
			}
			throw error;
		}
	}

	private async writeTextFile(
		filePath: string,
		content: string,
	): Promise<void> {
		await writeFile(filePath, content, "utf8");
	}

	private async nextCursor(): Promise<number> {
		try {
			const raw = await this.readTextFile(this.cursorFile);
			const parsed = Number.parseInt(raw.trim(), 10);
			if (Number.isFinite(parsed)) {
				return parsed + 1;
			}
		} catch {
			// Fall through to JSONL scan.
		}

		const entries = await this.readEntries();
		const lastEntry = entries.at(-1);
		if (lastEntry) {
			return lastEntry.cursor + 1;
		}

		return 1;
	}

	private async readEntries(): Promise<HistoryEntry[]> {
		const raw = await this.readTextFile(this.historyFile);
		if (!raw.trim()) {
			return [];
		}

		const entries: HistoryEntry[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) {
				continue;
			}

			try {
				const parsed = JSON.parse(line) as Partial<HistoryEntry>;
				const previousCursor = entries.at(-1)?.cursor ?? 0;
				const cursor =
					typeof parsed.cursor === "number" &&
					Number.isFinite(parsed.cursor) &&
					parsed.cursor > 0
						? parsed.cursor
						: previousCursor + 1;
				const content =
					typeof parsed.content === "string"
						? parsed.content
						: String(parsed.content ?? "");
				const timestamp =
					typeof parsed.timestamp === "string" ? parsed.timestamp : "";
				const signals =
					parsed.signals && typeof parsed.signals === "object"
						? Object.fromEntries(
								Object.entries(parsed.signals).map(([key, value]) => [
									key,
									String(value),
								]),
							)
						: {};
				entries.push({
					cursor,
					timestamp,
					content,
					signals,
				});
			} catch {}
		}

		return entries;
	}

	private async writeEntries(entries: HistoryEntry[]): Promise<void> {
		const content = entries
			.map((entry) => `${JSON.stringify(entry)}\n`)
			.join("");
		await this.writeTextFile(this.historyFile, content);
	}

	private async maybeMigrateLegacyHistory(): Promise<void> {
		let legacyStat;
		try {
			legacyStat = await stat(this.legacyHistoryFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}

		try {
			const currentHistoryStat = await stat(this.historyFile);
			if (currentHistoryStat.size > 0) {
				return;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}

		const legacyText = await readFile(this.legacyHistoryFile, "utf8");
		const entries = this.parseLegacyHistory(
			legacyText,
			formatTimestamp(legacyStat.mtime),
		);
		if (entries.length > 0) {
			await this.writeEntries(entries);
			const lastCursor = entries.at(-1)?.cursor ?? 0;
			await this.writeTextFile(this.cursorFile, String(lastCursor));
			await this.writeTextFile(this.dreamCursorFile, String(lastCursor));
		}

		const backupPath = `${this.legacyHistoryFile}.bak`;
		try {
			await rename(this.legacyHistoryFile, backupPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				await rename(this.legacyHistoryFile, `${backupPath}.${Date.now()}`);
				return;
			}
			throw error;
		}
	}

	private parseLegacyHistory(
		text: string,
		fallbackTimestamp = formatTimestamp(new Date()),
	): HistoryEntry[] {
		const normalized = text.replace(/\r\n?/g, "\n").trim();
		if (!normalized) {
			return [];
		}

		return this.splitLegacyHistoryChunks(normalized).map((chunk, index) => {
			const match = chunk.match(TIMESTAMP_RE);
			const timestamp = match?.[1] ?? fallbackTimestamp;
			const content = match
				? chunk.slice(match[0].length).trim()
				: chunk.trim();
			return {
				cursor: index + 1,
				timestamp,
				content,
				signals: {},
			};
		});
	}

	private splitLegacyHistoryChunks(text: string): string[] {
		const chunks: string[] = [];
		let current: string[] = [];
		let sawBlankSeparator = false;

		for (const line of text.split("\n")) {
			if (!line.trim()) {
				if (current.length > 0) {
					current.push("");
					sawBlankSeparator = true;
				}
				continue;
			}

			const startsEntry = ENTRY_START_RE.test(line);
			const currentIsRawBlock =
				current.length > 0 && RAW_MESSAGE_RE.test(current[0]!.trim());
			const shouldStartNewChunk =
				current.length > 0 &&
				(sawBlankSeparator || (startsEntry && !currentIsRawBlock));

			if (shouldStartNewChunk) {
				const chunk = current.join("\n").trim();
				if (chunk) {
					chunks.push(chunk);
				}
				current = [line];
			} else {
				current.push(line);
			}

			sawBlankSeparator = false;
		}

		const finalChunk = current.join("\n").trim();
		if (finalChunk) {
			chunks.push(finalChunk);
		}

		return chunks;
	}
}

function formatTimestamp(value: Date): string {
	return value.toISOString().slice(0, 16).replace("T", " ");
}

export function formatMessagesForHistory(messages: readonly Message[]): string {
	return messages
		.map((message) => formatMessageForHistory(message))
		.filter((entry): entry is string => Boolean(entry))
		.join("\n");
}

function formatMessageForHistory(message: Message): string | null {
	const content = extractMessageContent(message).trim();
	if (!content) {
		return null;
	}

	const timestamp = formatHistoryTimestamp(message.timestamp);
	switch (message.role) {
		case "user":
			return `[${timestamp}] USER: ${content}`;
		case "assistant": {
			const tools = getAssistantToolCalls(message);
			const toolSuffix =
				tools.length > 0
					? ` [tools: ${tools.map((toolCall) => toolCall.name).join(", ")}]`
					: "";
			return `[${timestamp}] ASSISTANT${toolSuffix}: ${content}`;
		}
		case "toolResult":
			return `[${timestamp}] TOOL_RESULT ${message.toolName}: ${content}`;
	}
}

function extractMessageContent(message: Message): string {
	switch (message.role) {
		case "user":
			return extractUserContent(message);
		case "assistant":
			return message.content
				.flatMap((block) => {
					if (block.type === "text") {
						return [block.text];
					}
					if (block.type === "thinking") {
						return [block.thinking];
					}
					if (block.type === "toolCall") {
						return [`${block.name}(${JSON.stringify(block.arguments ?? {})})`];
					}
					return [];
				})
				.join("\n");
		case "toolResult":
			return message.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("\n");
	}
}

function extractUserContent(message: UserMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}

	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getAssistantToolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter(
		(block): block is ToolCall => block.type === "toolCall",
	);
}

function formatHistoryTimestamp(timestamp: number): string {
	if (!Number.isFinite(timestamp)) {
		return formatTimestamp(new Date());
	}
	return formatTimestamp(new Date(timestamp));
}
