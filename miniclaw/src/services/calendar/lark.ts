import type {
  CalendarEvent,
  CalendarProvider,
  RecurrenceRule,
} from "../calendar";

export class LarkCalendarProvider implements CalendarProvider {
  name = "Lark (Feishu)";

  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl = "https://open.feishu.cn/open-apis";

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  async createEvent(event: CalendarEvent): Promise<string> {
    const accessToken = await this.getAccessToken();
    const eventData = this.buildEventData(event);

    const response = await fetch(
      `${this.baseUrl}/calendar/v4/calendars/primary/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(eventData),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to create event: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data.event.event_id;
  }

  async updateEvent(eventId: string, event: CalendarEvent): Promise<void> {
    const accessToken = await this.getAccessToken();
    const eventData = this.buildEventData(event);

    const response = await fetch(
      `${this.baseUrl}/calendar/v4/calendars/primary/events/${eventId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(eventData),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to update event: ${response.statusText}`);
    }
  }

  async deleteEvent(eventId: string): Promise<void> {
    const accessToken = await this.getAccessToken();

    const response = await fetch(
      `${this.baseUrl}/calendar/v4/calendars/primary/events/${eventId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to delete event: ${response.statusText}`);
    }
  }

  async listEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    const accessToken = await this.getAccessToken();

    const response = await fetch(
      `${this.baseUrl}/calendar/v4/calendars/primary/events?start_time=${start.getTime()}&end_time=${end.getTime()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to list events: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data.items.map((item: any) => this.parseLarkEvent(item));
  }

  async getEvent(eventId: string): Promise<CalendarEvent | null> {
    const accessToken = await this.getAccessToken();

    const response = await fetch(
      `${this.baseUrl}/calendar/v4/calendars/primary/events/${eventId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return this.parseLarkEvent(data.data);
  }

  private async getAccessToken(): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${response.statusText}`);
    }

    const data = await response.json();
    return data.tenant_access_token;
  }

  private buildEventData(event: CalendarEvent): any {
    const data: any = {
      summary: event.title,
      start: {
        timestamp: event.start.getTime(),
      },
      end: {
        timestamp: event.end.getTime(),
      },
    };

    if (event.description) {
      data.description = event.description;
    }

    if (event.location) {
      data.location = event.location;
    }

    if (event.attendees && event.attendees.length > 0) {
      data.attendee_ability = "can_see_guest_list";
      data.attendees = event.attendees.map((email) => ({
        type: "user",
        user_id: email,
      }));
    }

    if (event.recurrence) {
      data.recurrence_rule = this.formatRecurrence(event.recurrence);
    }

    return data;
  }

  private formatRecurrence(recurrence: RecurrenceRule): string {
    const parts: string[] = [];

    parts.push(`FREQ=${recurrence.frequency.toUpperCase()}`);

    if (recurrence.interval) {
      parts.push(`INTERVAL=${recurrence.interval}`);
    }

    if (recurrence.until) {
      parts.push(
        `UNTIL=${recurrence.until.toISOString().replace(/[-:]/g, "")}`,
      );
    }

    if (recurrence.count) {
      parts.push(`COUNT=${recurrence.count}`);
    }

    if (recurrence.byDay && recurrence.byDay.length > 0) {
      const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
      parts.push(`BYDAY=${recurrence.byDay.map((d) => days[d]).join(",")}`);
    }

    if (recurrence.byMonth && recurrence.byMonth.length > 0) {
      parts.push(`BYMONTH=${recurrence.byMonth.join(",")}`);
    }

    return parts.join(";");
  }

  private parseLarkEvent(item: any): CalendarEvent {
    return {
      id: item.event_id,
      title: item.summary,
      description: item.description,
      start: new Date(item.start.timestamp),
      end: new Date(item.end.timestamp),
      location: item.location,
      attendees: item.attendees?.map((a: any) => a.user_id),
    };
  }
}
