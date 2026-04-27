export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  start: Date;
  end: Date;
  location?: string;
  attendees?: string[];
  recurrence?: RecurrenceRule;
  metadata?: Record<string, unknown>;
}

export interface RecurrenceRule {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  until?: Date;
  count?: number;
  byDay?: number[]; // 0-6 (Sunday-Saturday)
  byMonth?: number[]; // 1-12
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
  private provider: CalendarProvider;

  constructor(provider: CalendarProvider) {
    this.provider = provider;
  }

  /**
   * Create a new calendar event
   */
  async createEvent(event: CalendarEvent): Promise<string> {
    return this.provider.createEvent(event);
  }

  /**
   * Update an existing event
   */
  async updateEvent(eventId: string, event: CalendarEvent): Promise<void> {
    return this.provider.updateEvent(eventId, event);
  }

  /**
   * Delete an event
   */
  async deleteEvent(eventId: string): Promise<void> {
    return this.provider.deleteEvent(eventId);
  }

  /**
   * List events in a date range
   */
  async listEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    return this.provider.listEvents(start, end);
  }

  /**
   * Get a specific event
   */
  async getEvent(eventId: string): Promise<CalendarEvent | null> {
    return this.provider.getEvent(eventId);
  }

  /**
   * Get the provider name
   */
  getProviderName(): string {
    return this.provider.name;
  }
}
