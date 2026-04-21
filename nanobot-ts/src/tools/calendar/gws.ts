import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
	CalendarEvent,
	CalendarInfo,
	CalendarProvider,
	CreateEventInput,
	DeleteEventInput,
	FreeBusyInput,
	FreeBusyResult,
	ListEventsInput,
	UpdateEventInput,
} from "./types.js";

export type GwsCommandRunner = (
	command: string,
	args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface GwsCalendarProviderOptions {
	command: string;
	defaultCalendarId: string;
	run?: GwsCommandRunner;
}

const execFileAsync = promisify(execFile);

export class GwsCalendarProvider implements CalendarProvider {
	private readonly run: GwsCommandRunner;

	constructor(private readonly options: GwsCalendarProviderOptions) {
		this.run =
			options.run ??
			(async (command, args) => {
				const result = await execFileAsync(command, args, {
					windowsHide: true,
				});
				return {
					stdout: result.stdout,
					stderr: result.stderr,
				};
			});
	}

	async listCalendars(): Promise<CalendarInfo[]> {
		const raw = await this.call(["calendar", "list-calendars", "--json"]);
		const entries = Array.isArray(raw) ? raw : asRecord(raw).calendars;
		if (!Array.isArray(entries)) {
			return [];
		}
		return entries.map((entry) => normalizeCalendar(entry));
	}

	async listEvents(input: ListEventsInput): Promise<CalendarEvent[]> {
		const raw = await this.call([
			"calendar",
			"list-events",
			"--calendar-id",
			input.calendarId || this.options.defaultCalendarId,
			...optionalFlag("--time-min", input.timeMin),
			...optionalFlag("--time-max", input.timeMax),
			...optionalFlag("--query", input.query),
			...optionalFlag("--limit", input.limit?.toString()),
			"--json",
		]);
		const entries = Array.isArray(raw) ? raw : asRecord(raw).events;
		if (!Array.isArray(entries)) {
			return [];
		}
		return entries.map((entry) =>
			normalizeEvent(entry, input.calendarId || this.options.defaultCalendarId),
		);
	}

	async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
		const calendarId = input.calendarId || this.options.defaultCalendarId;
		const raw = await this.call([
			"calendar",
			"create-event",
			"--calendar-id",
			calendarId,
			"--title",
			input.title,
			"--start",
			input.start,
			"--end",
			input.end,
			...optionalFlag("--time-zone", input.timeZone),
			...optionalFlag("--location", input.location),
			...optionalFlag("--description", input.description),
			...attendeeFlags(input.attendees),
			"--json",
		]);
		return normalizeEvent(raw, calendarId);
	}

	async updateEvent(input: UpdateEventInput): Promise<CalendarEvent> {
		const calendarId = input.calendarId || this.options.defaultCalendarId;
		const raw = await this.call([
			"calendar",
			"update-event",
			"--calendar-id",
			calendarId,
			"--event-id",
			input.eventId,
			...optionalFlag("--title", input.title),
			...optionalFlag("--start", input.start),
			...optionalFlag("--end", input.end),
			...optionalFlag("--time-zone", input.timeZone),
			...optionalFlag("--location", input.location),
			...optionalFlag("--description", input.description),
			...attendeeFlags(input.attendees),
			"--json",
		]);
		return normalizeEvent(raw, calendarId);
	}

	async deleteEvent(input: DeleteEventInput): Promise<void> {
		await this.call([
			"calendar",
			"delete-event",
			"--calendar-id",
			input.calendarId || this.options.defaultCalendarId,
			"--event-id",
			input.eventId,
			"--json",
		]);
	}

	async freeBusy(input: FreeBusyInput): Promise<FreeBusyResult> {
		const raw = await this.call([
			"calendar",
			"free-busy",
			"--time-min",
			input.timeMin,
			"--time-max",
			input.timeMax,
			...(input.calendarIds?.length
				? input.calendarIds.flatMap((id) => ["--calendar-id", id])
				: ["--calendar-id", this.options.defaultCalendarId]),
			"--json",
		]);
		return normalizeFreeBusy(
			raw,
			input.calendarIds ?? [this.options.defaultCalendarId],
		);
	}

	private async call(args: string[]): Promise<unknown> {
		const result = await this.run(this.options.command, args);
		const payload = result.stdout.trim();
		if (!payload) {
			return {};
		}
		try {
			return JSON.parse(payload);
		} catch {
			throw new Error(
				`GWS calendar command returned non-JSON output: ${payload.slice(0, 200)}`,
			);
		}
	}
}

function optionalFlag(flag: string, value: string | undefined): string[] {
	return value?.trim() ? [flag, value] : [];
}

function attendeeFlags(
	attendees: CreateEventInput["attendees"] | undefined,
): string[] {
	return (attendees ?? []).flatMap((attendee) => [
		"--attendee",
		attendee.email,
	]);
}

function normalizeCalendar(raw: unknown): CalendarInfo {
	const record = asRecord(raw);
	return {
		id: String(record.id ?? record.calendarId ?? ""),
		name: String(record.name ?? record.summary ?? record.id ?? ""),
		...(record.description ? { description: String(record.description) } : {}),
		...(record.timeZone ? { timeZone: String(record.timeZone) } : {}),
		...(typeof record.primary === "boolean" ? { primary: record.primary } : {}),
	};
}

function normalizeEvent(
	raw: unknown,
	fallbackCalendarId: string,
): CalendarEvent {
	const record = asRecord(raw);
	return {
		id: String(record.id ?? record.eventId ?? ""),
		calendarId: String(record.calendarId ?? fallbackCalendarId),
		title: String(record.title ?? record.summary ?? ""),
		start: normalizeDateTime(record.start),
		end: normalizeDateTime(record.end),
		...(record.timeZone ? { timeZone: String(record.timeZone) } : {}),
		...(record.location ? { location: String(record.location) } : {}),
		...(record.description ? { description: String(record.description) } : {}),
		...(Array.isArray(record.attendees)
			? {
					attendees: record.attendees.map((attendee) => {
						const attendeeRecord = asRecord(attendee);
						return {
							email: String(attendeeRecord.email ?? attendee),
							...(attendeeRecord.displayName
								? { name: String(attendeeRecord.displayName) }
								: {}),
						};
					}),
				}
			: {}),
		...(record.htmlLink ? { htmlLink: String(record.htmlLink) } : {}),
		raw,
	};
}

function normalizeDateTime(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	const record = asRecord(value);
	return String(record.dateTime ?? record.date ?? "");
}

function normalizeFreeBusy(
	raw: unknown,
	fallbackCalendarIds: string[],
): FreeBusyResult {
	const rawRecord = asRecord(raw);
	const source = asRecord(rawRecord.calendars ?? raw);
	const calendars = Object.entries(source).map(([calendarId, value]) => {
		const record = asRecord(value);
		return {
			calendarId,
			busy: Array.isArray(record.busy)
				? record.busy.map((entry) => {
						const entryRecord = asRecord(entry);
						return {
							start: String(entryRecord.start ?? ""),
							end: String(entryRecord.end ?? ""),
						};
					})
				: [],
		};
	});
	return {
		calendars:
			calendars.length > 0
				? calendars
				: fallbackCalendarIds.map((calendarId) => ({ calendarId, busy: [] })),
		raw,
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
