import type { Message } from "@mariozechner/pi-ai";

import type { Logger } from "../utils/logging.js";
import type {
	Consolidator,
	ConsolidatorArchiveResult,
} from "./consolidator.js";
import {
	retainRecentLegalSuffix,
	type SessionMetadata,
} from "./session-persistence.js";
import type { SessionRecord, SessionStore } from "./session-store.js";

const AUTO_COMPACT_RECENT_SUFFIX_MESSAGES = 8;
const AUTO_COMPACT_SWEEP_INTERVAL_MS = 1_000;
const AUTO_COMPACT_SUMMARY_KEY = "_last_summary";

export interface AutoCompactSummaryMetadata {
	text: string;
	last_active: string;
}

export interface AutoCompactPrepareResult {
	session: SessionRecord;
	summaryContext?: string;
}

export interface AutoCompactorOptions {
	sessionStore: SessionStore;
	consolidator: Pick<Consolidator, "archive">;
	idleCompactAfterMinutes: number;
	logger?: Logger;
	isSessionActive?: (sessionKey: string) => boolean | Promise<boolean>;
	now?: () => Date;
}

export class AutoCompactor {
	private readonly sessionStore: SessionStore;
	private readonly consolidator: Pick<Consolidator, "archive">;
	private readonly idleCompactAfterMinutes: number;
	private readonly logger: Logger | undefined;
	private readonly isSessionActive:
		| ((sessionKey: string) => boolean | Promise<boolean>)
		| undefined;
	private readonly now: () => Date;
	private readonly archiving = new Set<string>();
	private timer: NodeJS.Timeout | undefined;
	private running = false;

	constructor(options: AutoCompactorOptions) {
		this.sessionStore = options.sessionStore;
		this.consolidator = options.consolidator;
		this.idleCompactAfterMinutes = options.idleCompactAfterMinutes;
		this.logger = options.logger;
		this.isSessionActive = options.isSessionActive;
		this.now = options.now ?? (() => new Date());
	}

	isRunning(): boolean {
		return this.running;
	}

	async start(): Promise<void> {
		if (this.running || this.idleCompactAfterMinutes <= 0) {
			return;
		}

		this.running = true;
		this.scheduleNextSweep();
		this.logger?.info("Auto-compact service started", {
			component: "autoCompact",
			event: "start",
			idleCompactAfterMinutes: this.idleCompactAfterMinutes,
		});
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.logger?.info("Auto-compact service stopped", {
			component: "autoCompact",
			event: "stop",
		});
	}

	async sweepOnce(): Promise<void> {
		if (this.idleCompactAfterMinutes <= 0) {
			return;
		}

		const sessions = await this.sessionStore.list();
		this.logger?.debug("Auto-compact sweep started", {
			component: "autoCompact",
			event: "sweep_start",
			sessions: sessions.length,
		});
		await Promise.all(
			sessions.map(async (summary) => {
				if (this.archiving.has(summary.key)) {
					return;
				}
				if (await this.isActive(summary.key)) {
					return;
				}
				const session = await this.sessionStore.load(summary.key);
				if (!session || !this.isExpired(session.updatedAt)) {
					return;
				}
				await this.compactSession(session, { consumeSummary: false });
			}),
		);
	}

	async prepareSession(
		sessionKey: string,
	): Promise<AutoCompactPrepareResult | null> {
		let session = await this.sessionStore.load(sessionKey);
		if (!session) {
			return null;
		}
		this.logger?.debug("Auto-compact prepare session", {
			component: "autoCompact",
			event: "prepare",
			sessionKey,
		});

		if (this.isExpired(session.updatedAt)) {
			session = await this.compactSession(session, { consumeSummary: false });
		}

		const summary = getSummaryMetadata(session.metadata);
		if (!summary) {
			return { session };
		}

		const metadata = { ...session.metadata };
		delete metadata[AUTO_COMPACT_SUMMARY_KEY];
		const prepared = {
			...session,
			metadata,
			updatedAt: this.now().toISOString(),
		};
		await this.sessionStore.save(prepared);
		return {
			session: prepared,
			summaryContext: this.formatSummaryContext(summary),
		};
	}

	isExpired(updatedAt: unknown): boolean {
		if (this.idleCompactAfterMinutes <= 0) {
			return false;
		}

		const timestamp = parseUpdatedAt(updatedAt);
		if (timestamp === null) {
			return false;
		}

		return (
			this.now().getTime() - timestamp.getTime() >=
			this.idleCompactAfterMinutes * 60_000
		);
	}

	private async compactSession(
		session: SessionRecord,
		options: { consumeSummary: boolean },
	): Promise<SessionRecord> {
		if (this.archiving.has(session.key)) {
			return session;
		}

		this.archiving.add(session.key);
		try {
			const { archiveMessages, keptMessages } =
				this.splitUnconsolidatedMessages(session);
			const lastActive = session.updatedAt;
			let archiveResult: ConsolidatorArchiveResult | null = null;

			if (archiveMessages.length > 0) {
				try {
					this.logger?.info("Auto-compact archive started", {
						component: "autoCompact",
						event: "archive_start",
						sessionKey: session.key,
						messages: archiveMessages.length,
					});
					archiveResult = await this.consolidator.archive(archiveMessages);
					this.logger?.info("Auto-compact archive completed", {
						component: "autoCompact",
						event: "archive_end",
						sessionKey: session.key,
					});
				} catch (error) {
					this.logger?.warn("Auto-compact archive failed", {
						component: "autoCompact",
						event: "archive_error",
						sessionKey: session.key,
						error: String(error),
					});
				}
			}

			const metadata = {
				...session.metadata,
			};
			const summaryText = archiveResult?.content.trim();
			if (summaryText && summaryText !== "(nothing)") {
				metadata[AUTO_COMPACT_SUMMARY_KEY] = {
					text: summaryText,
					last_active: lastActive,
				} satisfies AutoCompactSummaryMetadata;
			}

			const compacted = {
				...session,
				messages: keptMessages,
				lastConsolidated: 0,
				updatedAt: this.now().toISOString(),
				metadata,
			};
			await this.sessionStore.save(compacted);

			if (!options.consumeSummary) {
				return compacted;
			}

			return (await this.prepareSession(session.key))?.session ?? compacted;
		} finally {
			this.archiving.delete(session.key);
		}
	}

	private splitUnconsolidatedMessages(session: SessionRecord): {
		archiveMessages: Message[];
		keptMessages: Message[];
	} {
		const start = normalizeConsolidatedStart(
			session.lastConsolidated,
			session.messages.length,
		);
		const tail = session.messages
			.slice(start)
			.map((message) => structuredClone(message));
		if (tail.length === 0) {
			return {
				archiveMessages: [],
				keptMessages: [],
			};
		}

		const keptMessages = retainRecentLegalSuffix(
			tail,
			AUTO_COMPACT_RECENT_SUFFIX_MESSAGES,
		);
		const archiveMessages = tail.slice(0, tail.length - keptMessages.length);
		return {
			archiveMessages,
			keptMessages,
		};
	}

	private async isActive(sessionKey: string): Promise<boolean> {
		return Boolean(await this.isSessionActive?.(sessionKey));
	}

	private formatSummaryContext(summary: AutoCompactSummaryMetadata): string {
		const idleMinutes = Math.max(
			0,
			Math.floor(
				(this.now().getTime() - new Date(summary.last_active).getTime()) /
					60_000,
			),
		);
		return `Inactive for ${idleMinutes} minutes.\nPrevious conversation summary: ${summary.text}`;
	}

	private scheduleNextSweep(): void {
		if (!this.running) {
			return;
		}

		this.timer = setTimeout(() => {
			void this.sweepOnce()
				.catch((error) => {
					this.logger?.warn("Auto-compact sweep failed", {
						component: "autoCompact",
						event: "sweep_error",
						error: String(error),
					});
				})
				.finally(() => {
					this.scheduleNextSweep();
				});
		}, AUTO_COMPACT_SWEEP_INTERVAL_MS);
	}
}

export function getSummaryMetadata(
	metadata: SessionMetadata | Record<string, unknown> | undefined,
): AutoCompactSummaryMetadata | null {
	const entry = metadata?.[AUTO_COMPACT_SUMMARY_KEY];
	if (!entry || typeof entry !== "object") {
		return null;
	}

	const candidate = entry as Record<string, unknown>;
	if (
		typeof candidate.text !== "string" ||
		typeof candidate.last_active !== "string"
	) {
		return null;
	}

	return {
		text: candidate.text,
		last_active: candidate.last_active,
	};
}

function parseUpdatedAt(updatedAt: unknown): Date | null {
	if (updatedAt instanceof Date && Number.isFinite(updatedAt.getTime())) {
		return updatedAt;
	}
	if (typeof updatedAt !== "string" || !updatedAt.trim()) {
		return null;
	}

	const parsed = new Date(updatedAt);
	return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeConsolidatedStart(
	value: number,
	messageCount: number,
): number {
	if (!Number.isFinite(value)) {
		return 0;
	}

	const normalized = Math.max(0, Math.trunc(value));
	return Math.min(normalized, Math.max(0, messageCount));
}
