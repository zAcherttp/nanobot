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

export interface LarkCalendarProviderOptions {
	appId: string;
	appSecret: string;
	defaultCalendarId: string;
	baseUrl: string;
	fetch?: typeof fetch;
}

interface LarkTokenResponse {
	code?: number;
	msg?: string;
	tenant_access_token?: string;
}

export class LarkCalendarProvider implements CalendarProvider {
	private readonly fetchImpl: typeof fetch;
	private token: string | null = null;

	constructor(private readonly options: LarkCalendarProviderOptions) {
		this.fetchImpl = options.fetch ?? fetch;
	}

	async listCalendars(): Promise<CalendarInfo[]> {
		const raw = await this.request("GET", "/open-apis/calendar/v4/calendars");
		const data = asRecord(asRecord(raw).data);
		const entries = data.calendar_list ?? data.items ?? [];
		return Array.isArray(entries)
			? entries.map((entry) => normalizeCalendar(entry))
			: [];
	}

	async listEvents(input: ListEventsInput): Promise<CalendarEvent[]> {
		const calendarId = input.calendarId || this.options.defaultCalendarId;
		const params = new URLSearchParams();
		if (input.timeMin) {
			params.set("start_time", input.timeMin);
		}
		if (input.timeMax) {
			params.set("end_time", input.timeMax);
		}
		if (input.query) {
			params.set("query", input.query);
		}
		if (input.limit) {
			params.set("page_size", String(input.limit));
		}
		const raw = await this.request(
			"GET",
			`/open-apis/calendar/v4/calendars/${encodeURIComponent(
				calendarId,
			)}/events${params.size > 0 ? `?${params.toString()}` : ""}`,
		);
		const data = asRecord(asRecord(raw).data);
		const entries = data.items ?? data.event_list ?? [];
		return Array.isArray(entries)
			? entries.map((entry) => normalizeEvent(entry, calendarId))
			: [];
	}

	async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
		const calendarId = input.calendarId || this.options.defaultCalendarId;
		const raw = await this.request(
			"POST",
			`/open-apis/calendar/v4/calendars/${encodeURIComponent(
				calendarId,
			)}/events`,
			{
				summary: input.title,
				start_time: {
					timestamp: toUnixSeconds(input.start),
					timezone: input.timeZone,
				},
				end_time: {
					timestamp: toUnixSeconds(input.end),
					timezone: input.timeZone,
				},
				location: input.location,
				description: input.description,
				attendees: input.attendees?.map((attendee) => ({
					email: attendee.email,
					display_name: attendee.name,
				})),
			},
		);
		const data = asRecord(asRecord(raw).data);
		return normalizeEvent(data.event ?? data ?? raw, calendarId);
	}

	async updateEvent(input: UpdateEventInput): Promise<CalendarEvent> {
		const calendarId = input.calendarId || this.options.defaultCalendarId;
		const raw = await this.request(
			"PATCH",
			`/open-apis/calendar/v4/calendars/${encodeURIComponent(
				calendarId,
			)}/events/${encodeURIComponent(input.eventId)}`,
			{
				...(input.title ? { summary: input.title } : {}),
				...(input.start
					? {
							start_time: {
								timestamp: toUnixSeconds(input.start),
								timezone: input.timeZone,
							},
						}
					: {}),
				...(input.end
					? {
							end_time: {
								timestamp: toUnixSeconds(input.end),
								timezone: input.timeZone,
							},
						}
					: {}),
				...(input.location ? { location: input.location } : {}),
				...(input.description ? { description: input.description } : {}),
			},
		);
		const data = asRecord(asRecord(raw).data);
		return normalizeEvent(data.event ?? data ?? raw, calendarId);
	}

	async deleteEvent(input: DeleteEventInput): Promise<void> {
		await this.request(
			"DELETE",
			`/open-apis/calendar/v4/calendars/${encodeURIComponent(
				input.calendarId || this.options.defaultCalendarId,
			)}/events/${encodeURIComponent(input.eventId)}`,
		);
	}

	async freeBusy(input: FreeBusyInput): Promise<FreeBusyResult> {
		const calendarIds = input.calendarIds?.length
			? input.calendarIds
			: [this.options.defaultCalendarId];
		const raw = await this.request("POST", "/open-apis/calendar/v4/freebusy", {
			time_min: input.timeMin,
			time_max: input.timeMax,
			items: calendarIds.map((id) => ({ id })),
		});
		const data = asRecord(asRecord(raw).data);
		const entries = asRecord(data.calendars);
		return {
			calendars: Object.entries(entries).map(([calendarId, value]) => {
				const record = asRecord(value);
				return {
					calendarId,
					busy: Array.isArray(record.busy)
						? record.busy.map((entry) => {
								const entryRecord = asRecord(entry);
								return {
									start: String(
										entryRecord.start_time ?? entryRecord.start ?? "",
									),
									end: String(entryRecord.end_time ?? entryRecord.end ?? ""),
								};
							})
						: [],
				};
			}),
			raw,
		};
	}

	private async request(
		method: string,
		route: string,
		body?: Record<string, unknown>,
	): Promise<unknown> {
		const token = await this.getToken();
		const response = await this.fetchImpl(
			`${trimRight(this.options.baseUrl)}${route}`,
			{
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json; charset=utf-8",
				},
				...(body ? { body: JSON.stringify(removeUndefined(body)) } : {}),
			},
		);
		const raw = await response.text();
		const parsed = asRecord(raw ? JSON.parse(raw) : {});
		if (
			!response.ok ||
			(typeof parsed.code === "number" && parsed.code !== 0)
		) {
			throw new Error(
				`Lark calendar request failed: ${parsed.msg ?? response.statusText}`,
			);
		}
		return parsed;
	}

	private async getToken(): Promise<string> {
		if (this.token) {
			return this.token;
		}
		if (!this.options.appId || !this.options.appSecret) {
			throw new Error("Lark calendar requires appId and appSecret.");
		}
		const response = await this.fetchImpl(
			`${trimRight(this.options.baseUrl)}/open-apis/auth/v3/tenant_access_token/internal`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json; charset=utf-8",
				},
				body: JSON.stringify({
					app_id: this.options.appId,
					app_secret: this.options.appSecret,
				}),
			},
		);
		const payload = (await response.json()) as LarkTokenResponse;
		if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
			throw new Error(
				`Lark auth failed: ${payload.msg ?? response.statusText}`,
			);
		}
		this.token = payload.tenant_access_token;
		return this.token;
	}
}

function normalizeCalendar(raw: unknown): CalendarInfo {
	const record = asRecord(raw);
	return {
		id: String(record.calendar_id ?? record.id ?? ""),
		name: String(record.summary ?? record.name ?? record.calendar_id ?? ""),
		...(record.description ? { description: String(record.description) } : {}),
		...(record.timezone ? { timeZone: String(record.timezone) } : {}),
		...(typeof record.is_primary === "boolean"
			? { primary: record.is_primary }
			: {}),
	};
}

function normalizeEvent(
	raw: unknown,
	fallbackCalendarId: string,
): CalendarEvent {
	const record = asRecord(raw);
	return {
		id: String(record.event_id ?? record.id ?? ""),
		calendarId: String(record.calendar_id ?? fallbackCalendarId),
		title: String(record.summary ?? record.title ?? ""),
		start: fromLarkTime(record.start_time ?? record.start),
		end: fromLarkTime(record.end_time ?? record.end),
		...(record.timezone ? { timeZone: String(record.timezone) } : {}),
		...(record.location ? { location: String(record.location) } : {}),
		...(record.description ? { description: String(record.description) } : {}),
		...(Array.isArray(record.attendees)
			? {
					attendees: record.attendees.map((attendee) => {
						const attendeeRecord = asRecord(attendee);
						return {
							email: String(attendeeRecord.email ?? attendeeRecord.mail ?? ""),
							...(attendeeRecord.display_name
								? { name: String(attendeeRecord.display_name) }
								: {}),
						};
					}),
				}
			: {}),
		raw,
	};
}

function toUnixSeconds(value: string): string {
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) {
		return value;
	}
	return String(Math.floor(parsed / 1000));
}

function fromLarkTime(value: unknown): string {
	const record = asRecord(value);
	const raw = record.timestamp ?? record.date ?? value;
	if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
		return new Date(Number(raw) * 1000).toISOString();
	}
	return String(raw ?? "");
}

function trimRight(value: string): string {
	return value.replace(/\/+$/, "");
}

function removeUndefined(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).filter((entry) => entry[1] !== undefined),
	);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
