import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createLogger,
	createRuntimeLogStore,
	sanitizeLogData,
} from "../src/utils/logging.js";

function stripAnsi(text: string): string {
	const ansiEscape = String.fromCharCode(27);
	return text.replace(new RegExp(`${ansiEscape}\\[[0-9;]*m`, "g"), "");
}

describe("runtime logging", () => {
	let logDir: string;
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		logDir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-logs-"));
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	it("appends structured JSONL entries and reloads recent logs", async () => {
		const store = createRuntimeLogStore(logDir, {
			maxEntries: 10,
			maxPreviewChars: 16,
		});
		const logger = createLogger("trace", { store });

		logger.info("gateway started", {
			component: "gateway",
			event: "start",
			sessionKey: "telegram:1",
			apiKey: "secret",
			content: "x".repeat(40),
		});

		const [entry] = store.readRecent({ limit: 1 });
		const raw = await readFile(store.logFilePath, "utf8");

		expect(raw.trim()).toContain("gateway started");
		expect(entry?.component).toBe("gateway");
		expect(entry?.event).toBe("start");
		expect(entry?.sessionKey).toBe("telegram:1");
		expect(entry?.data).toMatchObject({
			apiKey: "[REDACTED]",
			content: "xxxxxxxxxxxxx...",
		});
	});

	it("applies max-entry retention to durable logs", () => {
		const store = createRuntimeLogStore(logDir, {
			maxEntries: 3,
			maxPreviewChars: 100,
		});
		const logger = createLogger("trace", { store });

		for (let index = 1; index <= 5; index += 1) {
			logger.info(`entry ${index}`, { component: "cron" });
		}

		expect(
			store.readRecent({ limit: 10 }).map((entry) => entry.message),
		).toEqual(["entry 3", "entry 4", "entry 5"]);
	});

	it("skips malformed JSONL lines and supports filters", async () => {
		const store = createRuntimeLogStore(logDir, {
			maxEntries: 10,
			maxPreviewChars: 100,
		});
		await writeFile(
			store.logFilePath,
			[
				"not-json",
				JSON.stringify({
					id: 1,
					level: "debug",
					message: "debug hidden",
					timestamp: 1,
					component: "gateway",
					sessionKey: "telegram:1",
				}),
				JSON.stringify({
					id: 2,
					level: "error",
					message: "visible",
					timestamp: 2,
					component: "agent",
					sessionKey: "telegram:2",
				}),
			].join("\n"),
			"utf8",
		);

		expect(
			store.readRecent({ level: "info" }).map((entry) => entry.message),
		).toEqual(["visible"]);
		expect(
			store.readRecent({ component: "agent" }).map((entry) => entry.message),
		).toEqual(["visible"]);
		expect(store.readRecent({ sessionKey: "telegram:1" })).toHaveLength(1);
	});

	it("redacts secret-like keys while preserving routing fields", () => {
		const sanitized = sanitizeLogData(
			{
				sessionKey: "telegram:1",
				channel: "telegram",
				providerAuthSource: "env",
				headers: { Authorization: "Bearer secret" },
				token: "secret",
			},
			{ maxPreviewChars: 500 },
		);

		expect(sanitized).toEqual({
			sessionKey: "telegram:1",
			channel: "telegram",
			providerAuthSource: "env",
			headers: "[REDACTED]",
			token: "[REDACTED]",
		});
	});

	it("prints live console events as component:event labels with messages", () => {
		const logger = createLogger("debug", { console: true });

		logger.debug("Gateway workspace ready", {
			component: "gateway",
			event: "workspace_ready",
		});
		logger.warn("Gateway runtime failed", {
			component: "gateway",
			event: "runtime_error",
		});

		const debugLine = String(consoleLogSpy.mock.calls[0]?.[0] ?? "");
		const warnLine = String(consoleErrorSpy.mock.calls[0]?.[0] ?? "");

		expect(debugLine).toContain("\u001B[36mDEBUG\u001B[0m");
		expect(stripAnsi(debugLine)).toMatch(
			/^\[[^\]]+\] DEBUG gateway:workspace_ready - Gateway workspace ready$/,
		);
		expect(warnLine).toContain("\u001B[33mWARN\u001B[0m");
		expect(stripAnsi(warnLine)).toMatch(
			/^\[[^\]]+\] WARN gateway:runtime_error - Gateway runtime failed$/,
		);
	});
});
