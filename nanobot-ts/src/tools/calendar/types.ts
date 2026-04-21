export interface CalendarInfo {
	id: string;
	name: string;
	description?: string;
	timeZone?: string;
	primary?: boolean;
}

export interface CalendarAttendee {
	email: string;
	name?: string;
	optional?: boolean;
}

export interface CalendarEvent {
	id: string;
	calendarId: string;
	title: string;
	start: string;
	end: string;
	timeZone?: string;
	location?: string;
	description?: string;
	attendees?: CalendarAttendee[];
	htmlLink?: string;
	raw?: unknown;
}

export interface ListEventsInput {
	calendarId?: string;
	timeMin?: string;
	timeMax?: string;
	query?: string;
	limit?: number;
}

export interface CreateEventInput {
	calendarId?: string;
	title: string;
	start: string;
	end: string;
	timeZone?: string;
	location?: string;
	description?: string;
	attendees?: CalendarAttendee[];
}

export interface UpdateEventInput extends Partial<CreateEventInput> {
	calendarId?: string;
	eventId: string;
}

export interface DeleteEventInput {
	calendarId?: string;
	eventId: string;
}

export interface FreeBusyInput {
	calendarIds?: string[];
	timeMin: string;
	timeMax: string;
}

export interface FreeBusyResult {
	calendars: Array<{
		calendarId: string;
		busy: Array<{
			start: string;
			end: string;
		}>;
	}>;
	raw?: unknown;
}

export interface CalendarProvider {
	listCalendars(): Promise<CalendarInfo[]>;
	listEvents(input: ListEventsInput): Promise<CalendarEvent[]>;
	createEvent(input: CreateEventInput): Promise<CalendarEvent>;
	updateEvent(input: UpdateEventInput): Promise<CalendarEvent>;
	deleteEvent(input: DeleteEventInput): Promise<void>;
	freeBusy(input: FreeBusyInput): Promise<FreeBusyResult>;
}
