export interface RecurrenceRule {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  until?: Date;
  count?: number;
  byDay?: number[];
  byMonth?: number[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  description?: string;
  location?: string;
  attendees?: string[];
  recurrence?: RecurrenceRule;
}

export interface CalendarProvider {
  name: string;
  createEvent(event: CalendarEvent): Promise<string>;
  updateEvent(eventId: string, event: CalendarEvent): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
  listEvents(start: Date, end: Date): Promise<CalendarEvent[]>;
  getEvent(eventId: string): Promise<CalendarEvent | null>;
}

export class CalendarService {
  constructor(private readonly provider: CalendarProvider) {}

  createEvent(event: CalendarEvent): Promise<string> {
    return this.provider.createEvent(event);
  }

  updateEvent(eventId: string, event: CalendarEvent): Promise<void> {
    return this.provider.updateEvent(eventId, event);
  }

  deleteEvent(eventId: string): Promise<void> {
    return this.provider.deleteEvent(eventId);
  }

  listEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    return this.provider.listEvents(start, end);
  }

  getEvent(eventId: string): Promise<CalendarEvent | null> {
    return this.provider.getEvent(eventId);
  }
}
