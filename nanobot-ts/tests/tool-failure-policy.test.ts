import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/loader.js";
import { createCronTool } from "../src/cron/index.js";
import {
	type CalendarProvider,
	createCalendarTool,
	createWorkspaceTools,
	executeWebFetch,
	executeWebSearch,
	type WebConfig,
} from "../src/tools/index.js";

describe("tool failure policy", () => {
	it("web search distinguishes backend failure from no results", async () => {
		const unavailable = await executeWebSearch(
			{ query: "network outage" },
			{
				config: createWebConfig(),
				fetchImpl: async () => {
					throw new Error("socket hang up");
				},
			},
		);
		const noResults = await executeWebSearch(
			{ query: "missing" },
			{
				config: createWebConfig(),
				fetchImpl: async (input) =>
					responseWithUrl("<html></html>", {
						url: String(input),
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		);

		expect(unavailable).toContain(
			"Web search is temporarily unavailable for: network outage.",
		);
		expect(unavailable).toContain(
			"Do not treat this as evidence that no results exist.",
		);
		expect(noResults).toBe("No results for: missing");
	});

	it("web fetch returns invalid-request and blocked-target guidance", async () => {
		const missingUrl = await executeWebFetch({}, { config: createWebConfig() });
		const blockedTarget = await executeWebFetch(
			{ url: "http://127.0.0.1/private" },
			{ config: createWebConfig() },
		);

		expect(missingUrl).toContain("Cannot run web_fetch: url is required.");
		expect(blockedTarget).toContain(
			"Web fetch is temporarily unavailable for: http://127.0.0.1/private.",
		);
		expect(blockedTarget).toContain("Do not retry this URL unless");
	});

	it("calendar reports disabled writes, invalid input, and provider failures distinctly", async () => {
		const disabledTool = createCalendarTool({
			provider: new FailingCalendarProvider(),
			allowWrites: false,
			defaultCalendarId: "primary",
		});
		const enabledTool = createCalendarTool({
			provider: new FailingCalendarProvider(),
			allowWrites: true,
			defaultCalendarId: "primary",
		});

		const disabled = await resultText(
			disabledTool.execute("call-1", {
				action: "create_event",
				title: "Focus",
				start: "2026-04-21T09:00:00Z",
				end: "2026-04-21T10:00:00Z",
			}),
		);
		const invalid = await resultText(
			enabledTool.execute("call-2", {
				action: "create_event",
				title: "Missing time",
			}),
		);
		const unavailable = await resultText(
			enabledTool.execute("call-3", {
				action: "list_events",
			}),
		);

		expect(disabled).toContain(
			"Calendar write access is disabled by user config.",
		);
		expect(disabled).toContain("Do not try to create, update, or delete");
		expect(invalid).toContain(
			"Cannot run calendar: title, start, and end are required for create_event.",
		);
		expect(unavailable).toContain(
			"Calendar is temporarily unavailable for: list_events.",
		);
		expect(unavailable).toContain("provider offline");
	});

	it("workspace tools classify unsafe paths as invalid requests", async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-policy-"),
		);
		const tools = createWorkspaceTools({
			workspacePath: workspace,
			allowWrites: true,
			maxReadChars: 1_000,
			maxSearchResults: 10,
		});

		const read = await resultText(
			getTool(tools, "read_file").execute("call-1", {
				path: "../outside.md",
			}),
		);
		const write = await resultText(
			getTool(tools, "write_file").execute("call-2", {
				path: "../outside.md",
				content: "nope",
			}),
		);

		expect(read).toContain("Cannot run read_file: Path escapes workspace");
		expect(read).toContain("Use a workspace-relative path");
		expect(write).toContain("Cannot run write_file: Path escapes workspace");
		expect(write).toContain("Use a workspace-relative path");
	});

	it("cron reports invalid scheduling requests and storage failures distinctly", async () => {
		const invalidTool = createCronTool({
			service: {
				addJob: vi.fn(),
				listJobs: vi.fn(),
				removeJob: vi.fn(),
			} as never,
			defaultTimeZone: "UTC",
		});
		const failingTool = createCronTool({
			service: {
				addJob: vi.fn(async () => {
					throw new Error("cron store offline");
				}),
				listJobs: vi.fn(),
				removeJob: vi.fn(async () => "protected"),
			} as never,
			defaultTimeZone: "UTC",
			channel: "telegram",
			chatId: "42",
		});

		const missingContext = await resultText(
			invalidTool.execute("call-1", {
				action: "add",
				message: "deliver later",
				every_seconds: 60,
			}),
		);
		const protectedJob = await resultText(
			failingTool.execute("call-2", {
				action: "remove",
				job_id: "system-heartbeat",
			}),
		);
		const unavailable = await resultText(
			failingTool.execute("call-3", {
				action: "add",
				message: "deliver later",
				every_seconds: 60,
			}),
		);

		expect(missingContext).toContain(
			"Cannot run cron: no session context is available for delivery",
		);
		expect(protectedJob).toContain(
			"Cannot run cron: job system-heartbeat is a protected internal job.",
		);
		expect(unavailable).toContain(
			"Cron is temporarily unavailable for: deliver later.",
		);
		expect(unavailable).toContain("cron store offline");
	});
});

function createWebConfig(overrides: Partial<WebConfig> = {}): WebConfig {
	return {
		...DEFAULT_CONFIG.tools.web,
		...overrides,
		search: {
			...DEFAULT_CONFIG.tools.web.search,
			...overrides.search,
		},
		fetch: {
			...DEFAULT_CONFIG.tools.web.fetch,
			...overrides.fetch,
		},
	};
}

function responseWithUrl(
	body: string,
	init: ResponseInit & { url: string },
): Response {
	const response = new Response(body, init);
	Object.defineProperty(response, "url", {
		value: init.url,
	});
	return response;
}

class FailingCalendarProvider implements CalendarProvider {
	async listCalendars() {
		throw new Error("provider offline");
	}

	async listEvents() {
		throw new Error("provider offline");
	}

	async createEvent() {
		throw new Error("provider offline");
	}

	async updateEvent() {
		throw new Error("provider offline");
	}

	async deleteEvent() {
		throw new Error("provider offline");
	}

	async freeBusy() {
		throw new Error("provider offline");
	}
}

function getTool(tools: AgentTool[], name: string): AgentTool {
	const tool = tools.find((entry) => entry.name === name);
	if (!tool) {
		throw new Error(`Missing tool ${name}`);
	}
	return tool;
}

async function resultText(result: Promise<unknown>): Promise<string> {
	const resolved = (await result) as {
		content: Array<{ type: "text"; text: string }>;
	};
	return resolved.content[0]?.text ?? "";
}
