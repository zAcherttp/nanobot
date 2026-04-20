import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import pino from "pino";

import type { LogLevel } from "../config/schema.js";

export interface LogEntry {
	id: number;
	level: LogLevel;
	message: string;
	timestamp: number;
	component?: string;
	event?: string;
	sessionKey?: string;
	channel?: string;
	chatId?: string;
	jobId?: string;
	turnId?: string;
	data?: unknown;
}

export interface Logger {
	info: (message: string, data?: unknown) => void;
	warn: (message: string, data?: unknown) => void;
	error: (message: string, data?: unknown) => void;
	debug: (message: string, data?: unknown) => void;
	trace: (message: string, data?: unknown) => void;
	fatal: (message: string, data?: unknown) => void;
}

export interface RuntimeLogStoreOptions {
	maxEntries?: number;
	maxPreviewChars?: number;
	fileName?: string;
}

export interface CreateLoggerOptions {
	store?: LogStore;
	console?: boolean;
	component?: string;
	maxPreviewChars?: number;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	fatal: 60,
	error: 50,
	warn: 40,
	info: 30,
	debug: 20,
	trace: 10,
};

export class LogStore {
	private readonly entries: LogEntry[] = [];
	private readonly listeners = new Set<() => void>();
	private nextId = 1;

	constructor(
		private readonly maxEntries = 200,
		private readonly maxPreviewChars = 500,
	) {}

	append(level: LogLevel, message: string, data?: unknown): void {
		const entry = buildLogEntry({
			id: this.nextId++,
			level,
			message,
			timestamp: Date.now(),
			data,
			maxPreviewChars: this.maxPreviewChars,
		});
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries.splice(0, this.entries.length - this.maxEntries);
		}
		this.emit();
	}

	snapshot(): LogEntry[] {
		return [...this.entries];
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

export class RuntimeLogStore extends LogStore {
	readonly logFilePath: string;
	private nextFileId = 1;

	constructor(
		readonly logDir: string,
		private readonly options: Required<RuntimeLogStoreOptions>,
	) {
		super(options.maxEntries, options.maxPreviewChars);
		this.logFilePath = path.join(logDir, options.fileName);
		mkdirSync(logDir, { recursive: true });
		this.nextFileId =
			readLogEntries(this.logFilePath).reduce(
				(maxId, entry) => Math.max(maxId, entry.id),
				0,
			) + 1;
	}

	override append(level: LogLevel, message: string, data?: unknown): void {
		super.append(level, message, data);
		const timestamp = Date.now();
		const entry = buildLogEntry({
			id: this.nextFileId++,
			level,
			message,
			timestamp,
			data,
			maxPreviewChars: this.options.maxPreviewChars,
		});
		appendFileSync(this.logFilePath, `${JSON.stringify(entry)}\n`, "utf8");
		this.compactIfNeeded();
	}

	readRecent(
		options: {
			limit?: number;
			level?: LogLevel;
			component?: string;
			sessionKey?: string;
		} = {},
	): LogEntry[] {
		if (!existsSync(this.logFilePath)) {
			return [];
		}

		const entries = readLogEntries(this.logFilePath);
		const filtered = entries.filter((entry) => {
			if (
				options.level &&
				LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[options.level]
			) {
				return false;
			}
			if (options.component && entry.component !== options.component) {
				return false;
			}
			if (options.sessionKey && entry.sessionKey !== options.sessionKey) {
				return false;
			}
			return true;
		});
		return filtered.slice(-(options.limit ?? this.options.maxEntries));
	}

	clear(): void {
		mkdirSync(this.logDir, { recursive: true });
		writeFileSync(this.logFilePath, "", "utf8");
	}

	delete(): void {
		rmSync(this.logFilePath, { force: true });
	}

	private compactIfNeeded(): void {
		const entries = readLogEntries(this.logFilePath);
		if (entries.length <= this.options.maxEntries) {
			return;
		}
		const kept = entries.slice(-this.options.maxEntries);
		writeFileSync(
			this.logFilePath,
			kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
			"utf8",
		);
	}
}

export function createRuntimeLogStore(
	logDir: string,
	options: RuntimeLogStoreOptions = {},
): RuntimeLogStore {
	return new RuntimeLogStore(logDir, {
		maxEntries: options.maxEntries ?? 5_000,
		maxPreviewChars: options.maxPreviewChars ?? 500,
		fileName: options.fileName ?? "runtime.jsonl",
	});
}

export function createLogger(
	level: LogLevel,
	storeOrOptions?: LogStore | CreateLoggerOptions,
): Logger {
	const options =
		storeOrOptions instanceof LogStore
			? { store: storeOrOptions }
			: (storeOrOptions ?? {});
	const base = pino({
		level,
		enabled: false,
	});

	const write = (entryLevel: LogLevel, message: string, data?: unknown) => {
		if (LEVEL_PRIORITY[entryLevel] < LEVEL_PRIORITY[level]) {
			return;
		}
		const enrichedData =
			options.component && isPlainObject(data)
				? { component: options.component, ...data }
				: options.component
					? { component: options.component, data }
					: data;
		options.store?.append(entryLevel, message, enrichedData);
		if (options.console) {
			writeConsoleLog(
				entryLevel,
				message,
				enrichedData,
				options.maxPreviewChars,
			);
		}
		base[entryLevel](data, message);
	};

	return {
		info: (message, data) => write("info", message, data),
		warn: (message, data) => write("warn", message, data),
		error: (message, data) => write("error", message, data),
		debug: (message, data) => write("debug", message, data),
		trace: (message, data) => write("trace", message, data),
		fatal: (message, data) => write("fatal", message, data),
	};
}

export function sanitizeLogData(
	value: unknown,
	options: {
		maxPreviewChars?: number;
	} = {},
): unknown {
	return sanitizeValue(value, options.maxPreviewChars ?? 500, new WeakSet());
}

function buildLogEntry(options: {
	id: number;
	level: LogLevel;
	message: string;
	timestamp: number;
	data?: unknown;
	maxPreviewChars: number;
}): LogEntry {
	const sanitizedData = sanitizeLogData(options.data, {
		maxPreviewChars: options.maxPreviewChars,
	});
	const fields = extractStructuredFields(sanitizedData);
	return {
		id: options.id,
		level: options.level,
		message: truncateText(options.message, options.maxPreviewChars),
		timestamp: options.timestamp,
		...fields,
		...(fields.data !== undefined ? { data: fields.data } : {}),
	};
}

function extractStructuredFields(data: unknown): Partial<LogEntry> {
	if (!isPlainObject(data)) {
		return data !== undefined ? { data } : {};
	}

	const source = data as Record<string, unknown>;
	const rest: Record<string, unknown> = {};
	const entry: Partial<LogEntry> = {};
	for (const [key, value] of Object.entries(source)) {
		if (
			[
				"component",
				"event",
				"sessionKey",
				"channel",
				"chatId",
				"jobId",
				"turnId",
			].includes(key) &&
			(typeof value === "string" || typeof value === "number")
		) {
			(entry as Record<string, unknown>)[key] = String(value);
			continue;
		}
		rest[key] = value;
	}

	if (Object.keys(rest).length > 0) {
		entry.data = rest;
	}
	return entry;
}

function sanitizeValue(
	value: unknown,
	maxPreviewChars: number,
	seen: WeakSet<object>,
): unknown {
	if (typeof value === "string") {
		return truncateText(value, maxPreviewChars);
	}
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "undefined"
	) {
		return value;
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: truncateText(value.message, maxPreviewChars),
		};
	}
	if (Array.isArray(value)) {
		return value
			.slice(0, 20)
			.map((entry) => sanitizeValue(entry, maxPreviewChars, seen));
	}
	if (!isPlainObject(value)) {
		return truncateText(String(value), maxPreviewChars);
	}
	if (seen.has(value)) {
		return "[Circular]";
	}
	seen.add(value);

	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
			key,
			isSecretKey(key)
				? "[REDACTED]"
				: sanitizeValue(entry, maxPreviewChars, seen),
		]),
	);
}

function isSecretKey(key: string): boolean {
	return /(api[_-]?key|authorization|bearer|token|secret|password|providerHeaders?|headers?)/i.test(
		key,
	);
}

function truncateText(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function readLogEntries(logFilePath: string): LogEntry[] {
	if (!existsSync(logFilePath)) {
		return [];
	}
	return readFileSync(logFilePath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as LogEntry];
			} catch {
				return [];
			}
		});
}

function writeConsoleLog(
	level: LogLevel,
	message: string,
	data: unknown,
	maxPreviewChars = 500,
): void {
	const entry = buildLogEntry({
		id: 0,
		level,
		message,
		timestamp: Date.now(),
		data,
		maxPreviewChars,
	});
	const stamp = new Date(entry.timestamp).toISOString();
	const context = [entry.component, entry.event, entry.sessionKey, entry.jobId]
		.filter(Boolean)
		.join(" ");
	const suffix = context ? ` ${context}` : "";
	const line = `[${stamp}] ${level.toUpperCase()}${suffix} ${entry.message}`;
	if (level === "error" || level === "fatal" || level === "warn") {
		console.error(line);
		return;
	}
	console.log(line);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}
