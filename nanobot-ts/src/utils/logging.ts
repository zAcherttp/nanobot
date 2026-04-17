import pino from "pino";

import type { LogLevel } from "../config/schema.js";

export interface LogEntry {
	id: number;
	level: LogLevel;
	message: string;
	timestamp: number;
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

	constructor(private readonly maxEntries = 200) {}

	append(level: LogLevel, message: string, data?: unknown): void {
		this.entries.push({
			id: this.nextId++,
			level,
			message,
			timestamp: Date.now(),
			...(data !== undefined ? { data } : {}),
		});
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

export function createLogger(level: LogLevel, store?: LogStore): Logger {
	const base = pino({
		level,
		enabled: false,
	});

	const write = (entryLevel: LogLevel, message: string, data?: unknown) => {
		if (LEVEL_PRIORITY[entryLevel] < LEVEL_PRIORITY[level]) {
			return;
		}
		store?.append(entryLevel, message, data);
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
