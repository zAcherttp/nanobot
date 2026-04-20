import crypto from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { Message } from "@mariozechner/pi-ai";
import {
	buildPersistenceMetadata,
	type SessionMetadata,
	type SessionPersistenceOptions,
	sanitizeMessagesForPersistence,
} from "./session-persistence.js";

export interface SessionRecord {
	key: string;
	messages: Message[];
	createdAt: string;
	updatedAt: string;
	lastConsolidated: number;
	metadata: Record<string, unknown>;
}

export interface SessionSummary {
	key: string;
	createdAt: string;
	updatedAt: string;
	path: string;
	messageCount: number;
	hasRuntimeCheckpoint: boolean;
}

export interface SessionStore {
	load(key: string): Promise<SessionRecord | null>;
	save(session: SessionRecord): Promise<void>;
	list(): Promise<SessionSummary[]>;
	delete(key: string): Promise<void>;
}

interface PersistedSessionPayload {
	key: string;
	createdAt: string;
	updatedAt: string;
	lastConsolidated?: number;
	metadata?: Record<string, unknown>;
	messages: Message[];
}

export interface SessionStoreLogger {
	warn(message: string, metadata?: Record<string, unknown>): void;
}

export interface FileSessionStoreOptions extends SessionPersistenceOptions {
	quarantineCorruptFiles: boolean;
	logger?: SessionStoreLogger;
}

export class FileSessionStore implements SessionStore {
	constructor(
		private readonly sessionsDir: string,
		private readonly options: FileSessionStoreOptions = {
			maxMessages: 500,
			maxPersistedTextChars: 16_000,
			quarantineCorruptFiles: true,
		},
	) {}

	async load(key: string): Promise<SessionRecord | null> {
		const sessionPath = this.getSessionPath(key);
		try {
			const raw = await readFile(sessionPath, "utf8");
			return normalizeSessionPayload(
				JSON.parse(raw) as PersistedSessionPayload,
				key,
			);
		} catch (error) {
			if (isMissingFileError(error)) {
				return null;
			}
			await this.handleCorruptSessionFile(sessionPath, error);
			return null;
		}
	}

	async save(session: SessionRecord): Promise<void> {
		await mkdir(this.sessionsDir, { recursive: true });
		const sessionPath = this.getSessionPath(session.key);
		const sanitizedMessages = sanitizeMessagesForPersistence(
			session.messages,
			this.options,
		);
		const payload = {
			...session,
			messages: sanitizedMessages,
			metadata: buildPersistenceMetadata(
				session.metadata as SessionMetadata,
				sanitizedMessages.length,
			),
		};
		const tempPath = path.join(
			this.sessionsDir,
			`.${path.basename(sessionPath)}.${crypto.randomUUID()}.tmp`,
		);
		await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		await rename(tempPath, sessionPath);
	}

	async list(): Promise<SessionSummary[]> {
		await mkdir(this.sessionsDir, { recursive: true });
		const entries = await readdir(this.sessionsDir, { withFileTypes: true });
		const sessions: SessionSummary[] = [];

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) {
				continue;
			}

			const entryPath = path.join(this.sessionsDir, entry.name);
			try {
				const raw = await readFile(entryPath, "utf8");
				const payload = normalizeSessionPayload(
					JSON.parse(raw) as PersistedSessionPayload,
				);
				sessions.push({
					key: payload.key,
					createdAt: payload.createdAt,
					updatedAt: payload.updatedAt,
					path: entryPath,
					messageCount: payload.messages.length,
					hasRuntimeCheckpoint: Boolean(
						(payload.metadata as SessionMetadata | undefined)
							?.runtimeCheckpoint,
					),
				});
			} catch (error) {
				await this.handleCorruptSessionFile(entryPath, error);
			}
		}

		return sessions.sort((left, right) =>
			right.updatedAt.localeCompare(left.updatedAt),
		);
	}

	async delete(key: string): Promise<void> {
		const sessionPath = this.getSessionPath(key);
		await rm(sessionPath, { force: true });
	}

	private getSessionPath(key: string): string {
		return path.join(
			this.sessionsDir,
			`${Buffer.from(key, "utf8").toString("base64url")}.json`,
		);
	}

	private async handleCorruptSessionFile(
		sessionPath: string,
		error: unknown,
	): Promise<void> {
		if (!this.options.quarantineCorruptFiles) {
			throw error;
		}

		const quarantinePath = `${sessionPath}.corrupt.${Date.now()}.json`;
		try {
			await rename(sessionPath, quarantinePath);
		} catch (renameError) {
			if (!isMissingFileError(renameError)) {
				this.options.logger?.warn("Failed to quarantine corrupt session file", {
					component: "session",
					event: "quarantine_error",
					path: sessionPath,
					error: String(renameError),
				});
			}
		}

		this.options.logger?.warn("Quarantined corrupt session file", {
			component: "session",
			event: "quarantine",
			path: sessionPath,
			quarantinePath,
			error: String(error),
		});
	}
}

function normalizeSessionPayload(
	payload: PersistedSessionPayload,
	fallbackKey?: string,
): SessionRecord {
	return {
		key: payload.key || fallbackKey || "unknown",
		messages: payload.messages ?? [],
		createdAt: payload.createdAt ?? new Date(0).toISOString(),
		updatedAt:
			payload.updatedAt ?? payload.createdAt ?? new Date(0).toISOString(),
		lastConsolidated: normalizeLastConsolidated(
			payload.lastConsolidated,
			payload.messages?.length ?? 0,
		),
		metadata: payload.metadata ?? {},
	};
}

function normalizeLastConsolidated(
	value: unknown,
	messageCount: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 0;
	}

	const normalized = Math.max(0, Math.trunc(value));
	return Math.min(normalized, Math.max(0, messageCount));
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
