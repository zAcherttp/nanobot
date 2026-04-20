import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
	createLogger,
	createRuntimeLogStore,
	sanitizeLogData,
} from "../src/utils/logging.js";

describe("runtime logging", () => {
	let logDir: string;

	beforeEach(async () => {
		logDir = await mkdtemp(path.join(os.tmpdir(), "nanobot-ts-logs-"));
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
});
