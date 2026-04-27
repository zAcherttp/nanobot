import type {
  CalendarService,
  CalendarEvent,
  RecurrenceRule,
} from "@/services/calendar";

/**
 * Create a calendar event
 */
export async function createCalendarEvent(
  calendarService: CalendarService,
  params: {
    title: string;
    start: string; // ISO datetime
    end: string; // ISO datetime
    description?: string;
    location?: string;
    attendees?: string[];
    recurrence?: RecurrenceRule;
  },
): Promise<string> {
  const event: CalendarEvent = {
    id: "", // Will be assigned by provider
    title: params.title,
    start: new Date(params.start),
    end: new Date(params.end),
    description: params.description,
    location: params.location,
    attendees: params.attendees,
    recurrence: params.recurrence,
  };

  try {
    const eventId = await calendarService.createEvent(event);
    return `Created event '${params.title}' with ID: ${eventId}`;
  } catch (err) {
    return `Failed to create event: ${err}`;
  }
}

/**
 * Update a calendar event
 */
export async function updateCalendarEvent(
  calendarService: CalendarService,
  params: {
    eventId: string;
    title?: string;
    start?: string; // ISO datetime
    end?: string; // ISO datetime
    description?: string;
    location?: string;
    attendees?: string[];
    recurrence?: RecurrenceRule;
  },
): Promise<string> {
  const existing = await calendarService.getEvent(params.eventId);

  if (!existing) {
    return `Event ${params.eventId} not found`;
  }

  const event: CalendarEvent = {
    ...existing,
    title: params.title ?? existing.title,
    start: params.start ? new Date(params.start) : existing.start,
    end: params.end ? new Date(params.end) : existing.end,
    description: params.description ?? existing.description,
    location: params.location ?? existing.location,
    attendees: params.attendees ?? existing.attendees,
    recurrence: params.recurrence ?? existing.recurrence,
  };

  try {
    await calendarService.updateEvent(params.eventId, event);
    return `Updated event '${event.title}' (${params.eventId})`;
  } catch (err) {
    return `Failed to update event: ${err}`;
  }
}

/**
 * Delete a calendar event
 */
export async function deleteCalendarEvent(
  calendarService: CalendarService,
  eventId: string,
): Promise<string> {
  try {
    await calendarService.deleteEvent(eventId);
    return `Deleted event ${eventId}`;
  } catch (err) {
    return `Failed to delete event: ${err}`;
  }
}

/**
 * List calendar events
 */
export async function listCalendarEvents(
  calendarService: CalendarService,
  params: {
    start: string; // ISO datetime
    end: string; // ISO datetime
  },
): Promise<string> {
  const start = new Date(params.start);
  const end = new Date(params.end);

  try {
    const events = await calendarService.listEvents(start, end);

    if (events.length === 0) {
      return "No events found in the specified range.";
    }

    const lines = events.map((event) => {
      const startStr = event.start.toISOString();
      const endStr = event.end.toISOString();
      const location = event.location ? ` @ ${event.location}` : "";
      const attendees = event.attendees?.length
        ? ` (${event.attendees.length} attendees)`
        : "";

      return `- **${event.title}** (${event.id})
  ${startStr} - ${endStr}${location}${attendees}
  ${event.description || ""}`;
    });

    return lines.join("\n\n");
  } catch (err) {
    return `Failed to list events: ${err}`;
  }
}

/**
 * Get a specific calendar event
 */
export async function getCalendarEvent(
  calendarService: CalendarService,
  eventId: string,
): Promise<string> {
  try {
    const event = await calendarService.getEvent(eventId);

    if (!event) {
      return `Event ${eventId} not found`;
    }

    const startStr = event.start.toISOString();
    const endStr = event.end.toISOString();
    const location = event.location ? ` @ ${event.location}` : "";
    const attendees = event.attendees?.length
      ? ` (${event.attendees.length} attendees)`
      : "";

    return `**${event.title}** (${event.id})
${startStr} - ${endStr}${location}${attendees}

${event.description || "No description"}`;
  } catch (err) {
    return `Failed to get event: ${err}`;
  }
}
