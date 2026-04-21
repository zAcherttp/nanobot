import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import {
	isToolInputError,
	ToolInputError,
	toolDisabledByUserConfigMessage,
	toolInvalidRequestMessage,
	toolUnavailableMessage,
} from "../messages.js";
import type {
	CalendarAttendee,
	CalendarProvider,
	CreateEventInput,
	FreeBusyInput,
	ListEventsInput,
	UpdateEventInput,
} from "./types.js";

export interface CalendarToolOptions {
	provider: CalendarProvider;
	allowWrites: boolean;
	defaultCalendarId: string;
}

type CalendarAction =
	| "list_calendars"
	| "list_events"
	| "free_busy"
	| "create_event"
	| "update_event"
	| "delete_event";

interface CalendarToolInput {
	action?: CalendarAction;
	calendar_id?: string;
	event_id?: string;
	title?: string;
	start?: string;
	end?: string;
	time_zone?: string;
	time_min?: string;
	time_max?: string;
	query?: string;
	limit?: number;
	location?: string;
	description?: string;
	attendees?: CalendarAttendee[];
	calendar_ids?: string[];
}

export function createCalendarTool(options: CalendarToolOptions): AgentTool {
	return {
		name: "calendar",
		label: "Calendar",
		description:
			"Read calendar data and, when config allows writes, create/update/delete calendar events.",
		parameters: Type.Object({
			action: Type.String({
				enum: [
					"list_calendars",
					"list_events",
					"free_busy",
					"create_event",
					"update_event",
					"delete_event",
				],
			}),
			calendar_id: Type.Optional(Type.String()),
			event_id: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			start: Type.Optional(Type.String()),
			end: Type.Optional(Type.String()),
			time_zone: Type.Optional(Type.String()),
			time_min: Type.Optional(Type.String()),
			time_max: Type.Optional(Type.String()),
			query: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer()),
			location: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			attendees: Type.Optional(
				Type.Array(
					Type.Object({
						email: Type.String(),
						name: Type.Optional(Type.String()),
						optional: Type.Optional(Type.Boolean()),
					}),
				),
			),
			calendar_ids: Type.Optional(Type.Array(Type.String())),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as CalendarToolInput;
			const text = await executeCalendarAction(input, options);
			return {
				content: [
					{
						type: "text" as const,
						text,
					},
				],
				details: {
					tool: "calendar",
					action: input.action,
				},
			};
		},
	};
}

async function executeCalendarAction(
	input: CalendarToolInput,
	options: CalendarToolOptions,
): Promise<string> {
	try {
		switch (input.action) {
			case "list_calendars":
				return formatJson(await options.provider.listCalendars());
			case "list_events":
				return formatJson(
					await options.provider.listEvents(toListEventsInput(input)),
				);
			case "free_busy":
				return formatJson(
					await options.provider.freeBusy(toFreeBusyInput(input)),
				);
			case "create_event":
				if (!options.allowWrites) {
					return toolDisabledByUserConfigMessage(
						"Calendar write access",
						"Read-only calendar actions may still work. Do not try to create, update, or delete events unless the user enables calendar writes.",
					);
				}
				return formatJson(
					await options.provider.createEvent(toCreateEventInput(input)),
				);
			case "update_event":
				if (!options.allowWrites) {
					return toolDisabledByUserConfigMessage(
						"Calendar write access",
						"Read-only calendar actions may still work. Do not try to create, update, or delete events unless the user enables calendar writes.",
					);
				}
				return formatJson(
					await options.provider.updateEvent(toUpdateEventInput(input)),
				);
			case "delete_event":
				if (!options.allowWrites) {
					return toolDisabledByUserConfigMessage(
						"Calendar write access",
						"Read-only calendar actions may still work. Do not try to create, update, or delete events unless the user enables calendar writes.",
					);
				}
				if (!input.event_id?.trim()) {
					return toolInvalidRequestMessage(
						"calendar",
						"event_id is required for delete_event.",
					);
				}
				await options.provider.deleteEvent({
					calendarId: input.calendar_id || options.defaultCalendarId,
					eventId: input.event_id,
				});
				return `Deleted event ${input.event_id}`;
			default:
				return toolInvalidRequestMessage(
					"calendar",
					`unknown action '${input.action ?? ""}'.`,
				);
		}
	} catch (error) {
		if (isToolInputError(error)) {
			return toolInvalidRequestMessage("calendar", error.message);
		}
		return toolUnavailableMessage({
			tool: "Calendar",
			target: input.action,
			reason: error instanceof Error ? error.message : String(error),
			guidance:
				"Do not treat this as evidence that the calendar data does not exist. Check provider configuration/authentication or ask the user to retry later.",
		});
	}
}

function toListEventsInput(input: CalendarToolInput): ListEventsInput {
	return {
		...(input.calendar_id ? { calendarId: input.calendar_id } : {}),
		...(input.time_min ? { timeMin: input.time_min } : {}),
		...(input.time_max ? { timeMax: input.time_max } : {}),
		...(input.query ? { query: input.query } : {}),
		...(input.limit ? { limit: input.limit } : {}),
	};
}

function toFreeBusyInput(input: CalendarToolInput): FreeBusyInput {
	if (!input.time_min?.trim() || !input.time_max?.trim()) {
		throw new ToolInputError(
			"time_min and time_max are required for free_busy.",
		);
	}
	return {
		timeMin: input.time_min,
		timeMax: input.time_max,
		...(input.calendar_ids ? { calendarIds: input.calendar_ids } : {}),
	};
}

function toCreateEventInput(input: CalendarToolInput): CreateEventInput {
	if (!input.title?.trim() || !input.start?.trim() || !input.end?.trim()) {
		throw new ToolInputError(
			"title, start, and end are required for create_event.",
		);
	}
	return {
		title: input.title,
		start: input.start,
		end: input.end,
		...(input.calendar_id ? { calendarId: input.calendar_id } : {}),
		...(input.time_zone ? { timeZone: input.time_zone } : {}),
		...(input.location ? { location: input.location } : {}),
		...(input.description ? { description: input.description } : {}),
		...(input.attendees ? { attendees: input.attendees } : {}),
	};
}

function toUpdateEventInput(input: CalendarToolInput): UpdateEventInput {
	if (!input.event_id?.trim()) {
		throw new ToolInputError("event_id is required for update_event.");
	}
	return {
		eventId: input.event_id,
		...(input.calendar_id ? { calendarId: input.calendar_id } : {}),
		...(input.title ? { title: input.title } : {}),
		...(input.start ? { start: input.start } : {}),
		...(input.end ? { end: input.end } : {}),
		...(input.time_zone ? { timeZone: input.time_zone } : {}),
		...(input.location ? { location: input.location } : {}),
		...(input.description ? { description: input.description } : {}),
		...(input.attendees ? { attendees: input.attendees } : {}),
	};
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
