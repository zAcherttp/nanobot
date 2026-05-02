import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface GwsRecurrenceRule {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  until?: Date;
  count?: number;
  byDay?: number[];
  byMonth?: number[];
}

export interface GwsCalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  description?: string;
  location?: string;
  attendees?: string[];
  recurrence?: GwsRecurrenceRule;
}

export class GwsCalendarService {
  readonly name = "GWS (Google Workspace)";

  async createEvent(event: GwsCalendarEvent): Promise<string> {
    const args = this.buildCreateArgs(event);
    const command = `gws calendar create ${args}`;

    try {
      const { stdout } = await execAsync(command);
      // Parse output to get event ID
      const match = stdout.match(/Event ID: (\S+)/);
      return match?.[1] || "unknown";
    } catch (err) {
      throw new Error(`Failed to create event: ${err}`);
    }
  }

  async updateEvent(eventId: string, event: GwsCalendarEvent): Promise<void> {
    const args = this.buildUpdateArgs(event);
    const command = `gws calendar update ${eventId} ${args}`;

    try {
      await execAsync(command);
    } catch (err) {
      throw new Error(`Failed to update event: ${err}`);
    }
  }

  async deleteEvent(eventId: string): Promise<void> {
    const command = `gws calendar delete ${eventId}`;

    try {
      await execAsync(command);
    } catch (err) {
      throw new Error(`Failed to delete event: ${err}`);
    }
  }

  async listEvents(start: Date, end: Date): Promise<GwsCalendarEvent[]> {
    const startStr = start.toISOString();
    const endStr = end.toISOString();
    const command = `gws calendar list --start ${startStr} --end ${endStr}`;

    try {
      const { stdout } = await execAsync(command);
      return this.parseListOutput(stdout);
    } catch (err) {
      throw new Error(`Failed to list events: ${err}`);
    }
  }

  async getEvent(eventId: string): Promise<GwsCalendarEvent | null> {
    const command = `gws calendar get ${eventId}`;

    try {
      const { stdout } = await execAsync(command);
      return this.parseEventOutput(stdout);
    } catch (err) {
      return null;
    }
  }

  private buildCreateArgs(event: GwsCalendarEvent): string {
    const args: string[] = [];

    args.push(`--title "${event.title}"`);
    args.push(`--start "${event.start.toISOString()}"`);
    args.push(`--end "${event.end.toISOString()}"`);

    if (event.description) {
      args.push(`--description "${event.description}"`);
    }

    if (event.location) {
      args.push(`--location "${event.location}"`);
    }

    if (event.attendees && event.attendees.length > 0) {
      args.push(`--attendees "${event.attendees.join(",")}"`);
    }

    if (event.recurrence) {
      args.push(`--recurrence "${this.formatRecurrence(event.recurrence)}"`);
    }

    return args.join(" ");
  }

  private buildUpdateArgs(event: GwsCalendarEvent): string {
    const args: string[] = [];

    args.push(`--title "${event.title}"`);
    args.push(`--start "${event.start.toISOString()}"`);
    args.push(`--end "${event.end.toISOString()}"`);

    if (event.description) {
      args.push(`--description "${event.description}"`);
    }

    if (event.location) {
      args.push(`--location "${event.location}"`);
    }

    if (event.attendees && event.attendees.length > 0) {
      args.push(`--attendees "${event.attendees.join(",")}"`);
    }

    if (event.recurrence) {
      args.push(`--recurrence "${this.formatRecurrence(event.recurrence)}"`);
    }

    return args.join(" ");
  }

  private formatRecurrence(recurrence: GwsRecurrenceRule): string {
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

  private parseListOutput(output: string): GwsCalendarEvent[] {
    const events: GwsCalendarEvent[] = [];
    const lines = output.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = this.parseEventLine(line);
        if (event) {
          events.push(event);
        }
      } catch (err) {
        // Skip malformed lines
      }
    }

    return events;
  }

  private parseEventLine(line: string): GwsCalendarEvent | null {
    // Expected format: ID | Title | Start | End | Location | Description
    const parts = line.split("|").map((p) => p.trim());

    if (parts.length < 4) return null;

    return {
      id: parts[0],
      title: parts[1],
      start: new Date(parts[2]),
      end: new Date(parts[3]),
      location: parts[4] || undefined,
      description: parts[5] || undefined,
    };
  }

  private parseEventOutput(output: string): GwsCalendarEvent | null {
    const lines = output.split("\n");
    const data: Record<string, string> = {};

    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        data[match[1]] = match[2];
      }
    }

    if (!data.ID || !data.Title) return null;

    return {
      id: data.ID,
      title: data.Title,
      start: new Date(data.Start),
      end: new Date(data.End),
      location: data.Location,
      description: data.Description,
    };
  }
}
