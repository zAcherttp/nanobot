import { describe, expect, it } from "vitest";

import {
	type CalendarProvider,
	createCalendarTool,
	GwsCalendarProvider,
} from "../src/tools/index.js";

describe("calendar tool", () => {
	it("lists events through the configured provider", async () => {
		const provider = new FakeCalendarProvider();
		const tool = createCalendarTool({
			provider,
			allowWrites: false,
			defaultCalendarId: "primary",
		});

		const text = await resultText(
			tool.execute("call-1", {
				action: "list_events",
				time_min: "2026-04-20T00:00:00Z",
				time_max: "2026-04-21T00:00:00Z",
			}),
		);

		expect(JSON.parse(text)).toEqual([
			expect.objectContaining({
				id: "event-1",
				calendarId: "primary",
				title: "Design review",
			}),
		]);
		expect(provider.calls).toEqual(["listEvents:primary"]);
	});

	it("keeps write operations config gated", async () => {
		const provider = new FakeCalendarProvider();
		const disabledTool = createCalendarTool({
			provider,
			allowWrites: false,
			defaultCalendarId: "primary",
		});
		const enabledTool = createCalendarTool({
			provider,
			allowWrites: true,
			defaultCalendarId: "primary",
		});

		const blocked = await resultText(
			disabledTool.execute("call-1", {
				action: "create_event",
				title: "Focus",
				start: "2026-04-20T09:00:00Z",
				end: "2026-04-20T10:00:00Z",
			}),
		);
		const created = await resultText(
			enabledTool.execute("call-2", {
				action: "create_event",
				title: "Focus",
				start: "2026-04-20T09:00:00Z",
				end: "2026-04-20T10:00:00Z",
			}),
		);

		expect(blocked).toContain(
			"Calendar write access is disabled by user config.",
		);
		expect(blocked).toContain("Read-only calendar actions may still work.");
		expect(JSON.parse(created)).toEqual(
			expect.objectContaining({
				id: "created-1",
				title: "Focus",
			}),
		);
	});

	it("returns LLM-friendly calendar unavailable messages", async () => {
		const tool = createCalendarTool({
			provider: new FailingCalendarProvider(),
			allowWrites: false,
			defaultCalendarId: "primary",
		});

		const text = await resultText(
			tool.execute("call-1", {
				action: "list_events",
				time_min: "2026-04-20T00:00:00Z",
			}),
		);

		expect(text).toContain(
			"Calendar is temporarily unavailable for: list_events.",
		);
		expect(text).toContain("provider offline");
		expect(text).toContain("Do not treat this as evidence");
	});

	it("maps GWS CLI commands through the provider boundary", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const provider = new GwsCalendarProvider({
			command: "gws",
			defaultCalendarId: "primary",
			run: async (command, args) => {
				calls.push({ command, args });
				return {
					stdout: JSON.stringify({
						events: [
							{
								id: "event-1",
								summary: "From CLI",
								start: { dateTime: "2026-04-20T09:00:00Z" },
								end: { dateTime: "2026-04-20T10:00:00Z" },
							},
						],
					}),
					stderr: "",
				};
			},
		});

		const events = await provider.listEvents({
			timeMin: "2026-04-20T00:00:00Z",
			timeMax: "2026-04-21T00:00:00Z",
			limit: 5,
		});

		expect(calls).toEqual([
			{
				command: "gws",
				args: [
					"calendar",
					"list-events",
					"--calendar-id",
					"primary",
					"--time-min",
					"2026-04-20T00:00:00Z",
					"--time-max",
					"2026-04-21T00:00:00Z",
					"--limit",
					"5",
					"--json",
				],
			},
		]);
		expect(events[0]).toEqual(
			expect.objectContaining({
				id: "event-1",
				title: "From CLI",
				start: "2026-04-20T09:00:00Z",
			}),
		);
	});
});

class FakeCalendarProvider implements CalendarProvider {
	readonly calls: string[] = [];

	async listCalendars() {
		this.calls.push("listCalendars");
		return [{ id: "primary", name: "Primary", primary: true }];
	}

	async listEvents(input: { calendarId?: string }) {
		this.calls.push(`listEvents:${input.calendarId ?? "primary"}`);
		return [
			{
				id: "event-1",
				calendarId: input.calendarId ?? "primary",
				title: "Design review",
				start: "2026-04-20T09:00:00Z",
				end: "2026-04-20T10:00:00Z",
			},
		];
	}

	async createEvent(input: { title: string; calendarId?: string }) {
		this.calls.push("createEvent");
		return {
			id: "created-1",
			calendarId: input.calendarId ?? "primary",
			title: input.title,
			start: "2026-04-20T09:00:00Z",
			end: "2026-04-20T10:00:00Z",
		};
	}

	async updateEvent(input: { eventId: string; calendarId?: string }) {
		this.calls.push("updateEvent");
		return {
			id: input.eventId,
			calendarId: input.calendarId ?? "primary",
			title: "Updated",
			start: "2026-04-20T09:00:00Z",
			end: "2026-04-20T10:00:00Z",
		};
	}

	async deleteEvent() {
		this.calls.push("deleteEvent");
	}

	async freeBusy() {
		this.calls.push("freeBusy");
		return {
			calendars: [{ calendarId: "primary", busy: [] }],
		};
	}
}

class FailingCalendarProvider extends FakeCalendarProvider {
	override async listEvents() {
		throw new Error("provider offline");
	}
}

async function resultText(result: Promise<unknown>): Promise<string> {
	const resolved = (await result) as {
		content: Array<{ type: "text"; text: string }>;
	};
	return resolved.content[0]?.text ?? "";
}
