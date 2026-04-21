import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config/loader.js";
import {
	NANOBOT_FAUX_MODEL_ID,
	NANOBOT_FAUX_PROVIDER,
} from "../src/providers/faux.js";
import { createRuntimeTools } from "../src/tools/index.js";

describe("runtime tool factory", () => {
	it("registers workspace tools by default and filters by group/name", () => {
		const allTools = createRuntimeTools({
			config: {
				...DEFAULT_CONFIG,
				workspace: {
					path: process.cwd(),
				},
			},
		}).map((tool) => tool.name);
		const filteredTools = createRuntimeTools({
			config: {
				...DEFAULT_CONFIG,
				workspace: {
					path: process.cwd(),
				},
				tools: {
					...DEFAULT_CONFIG.tools,
					enabled: ["workspace", "calendar"],
					calendar: {
						...DEFAULT_CONFIG.tools.calendar,
						enabled: true,
					},
				},
			},
			calendarProvider: {
				listCalendars: async () => [],
				listEvents: async () => [],
				createEvent: async () => {
					throw new Error("not used");
				},
				updateEvent: async () => {
					throw new Error("not used");
				},
				deleteEvent: async () => undefined,
				freeBusy: async () => ({ calendars: [] }),
			},
		}).map((tool) => tool.name);

		expect(allTools).toEqual(
			expect.arrayContaining([
				"read_file",
				"write_file",
				"edit_file",
				"grep",
				"glob",
				"web_search",
				"web_fetch",
			]),
		);
		expect(filteredTools).toEqual(
			expect.arrayContaining(["read_file", "grep", "calendar"]),
		);
		expect(filteredTools).not.toContain("web_search");
		expect(filteredTools).not.toContain("cron");
	});

	it("filters web tools by group and individual names", () => {
		const webTools = createRuntimeTools({
			config: {
				...DEFAULT_CONFIG,
				tools: {
					...DEFAULT_CONFIG.tools,
					enabled: ["web"],
				},
			},
		}).map((tool) => tool.name);
		const searchOnly = createRuntimeTools({
			config: {
				...DEFAULT_CONFIG,
				tools: {
					...DEFAULT_CONFIG.tools,
					enabled: ["web_search"],
				},
			},
		}).map((tool) => tool.name);
		const disabled = createRuntimeTools({
			config: {
				...DEFAULT_CONFIG,
				tools: {
					...DEFAULT_CONFIG.tools,
					web: {
						...DEFAULT_CONFIG.tools.web,
						enabled: false,
					},
				},
			},
		}).map((tool) => tool.name);

		expect(webTools).toEqual(["web_search", "web_fetch"]);
		expect(searchOnly).toEqual(["web_search"]);
		expect(disabled).not.toContain("web_search");
		expect(disabled).not.toContain("web_fetch");
	});

	it("honors empty enabled tool filter", () => {
		const tools = createRuntimeTools({
			config: {
				...DEFAULT_CONFIG,
				agent: {
					...DEFAULT_CONFIG.agent,
					provider: NANOBOT_FAUX_PROVIDER,
					modelId: NANOBOT_FAUX_MODEL_ID,
				},
				tools: {
					...DEFAULT_CONFIG.tools,
					enabled: [],
				},
			},
		});

		expect(tools).toHaveLength(0);
	});
});
