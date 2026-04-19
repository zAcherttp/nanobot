import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Message } from "@mariozechner/pi-ai";

export interface SessionRecord {
	key: string;
	messages: Message[];
	createdAt: string;
	updatedAt: string;
	metadata: Record<string, unknown>;
}

export interface SessionSummary {
	key: string;
	createdAt: string;
	updatedAt: string;
	path: string;
	messageCount: number;
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
	metadata?: Record<string, unknown>;
	messages: Message[];
}

export class FileSessionStore implements SessionStore {
	constructor(private readonly sessionsDir: string) {}

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
			throw error;
		}
	}

	async save(session: SessionRecord): Promise<void> {
		await mkdir(this.sessionsDir, { recursive: true });
		const sessionPath = this.getSessionPath(session.key);
		await writeFile(
			sessionPath,
			`${JSON.stringify(session, null, 2)}\n`,
			"utf8",
		);
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
				});
			} catch {}
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
		metadata: payload.metadata ?? {},
	};
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
