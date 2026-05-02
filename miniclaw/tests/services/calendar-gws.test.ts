import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GwsCalendarEvent } from "../../src/services/calendar/gws";

const execMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  exec: execMock,
}));

import { GwsCalendarService } from "../../src/services/calendar/gws";

describe("GwsCalendarService", () => {
  let provider: GwsCalendarService;

  beforeEach(() => {
    provider = new GwsCalendarService();
    execMock.mockReset();
  });

  it("creates an event with the expected gws command and parses the event id", async () => {
    const event = buildEvent();

    execMock.mockImplementationOnce(
      (
        command: string,
        callback: (error: Error | null, result: { stdout: string }) => void,
      ) => {
        callback(null, {
          stdout: "Created successfully\nEvent ID: evt_12345\n",
        });
      },
    );

    const eventId = await provider.createEvent(event);

    expect(eventId).toBe("evt_12345");
    expect(execMock).toHaveBeenCalledWith(
      'gws calendar create --title "Project sync" --start "2026-05-01T09:00:00.000Z" --end "2026-05-01T10:00:00.000Z" --description "Weekly planning" --location "Room 1" --attendees "alice@example.com,bob@example.com" --recurrence "FREQ=WEEKLY;INTERVAL=2;COUNT=3;BYDAY=MO,WE"',
      expect.any(Function),
    );
  });

  it("updates an event with the expected gws command", async () => {
    const event = buildEvent();

    execMock.mockImplementationOnce(
      (
        _command: string,
        callback: (error: Error | null, result: { stdout: string }) => void,
      ) => {
        callback(null, { stdout: "" });
      },
    );

    await provider.updateEvent("evt_12345", event);

    expect(execMock).toHaveBeenCalledWith(
      'gws calendar update evt_12345 --title "Project sync" --start "2026-05-01T09:00:00.000Z" --end "2026-05-01T10:00:00.000Z" --description "Weekly planning" --location "Room 1" --attendees "alice@example.com,bob@example.com" --recurrence "FREQ=WEEKLY;INTERVAL=2;COUNT=3;BYDAY=MO,WE"',
      expect.any(Function),
    );
  });

  it("wraps gws command failures for delete", async () => {
    execMock.mockImplementationOnce(
      (
        _command: string,
        callback: (error: Error | null, result?: { stdout: string }) => void,
      ) => {
        callback(new Error("command failed"));
      },
    );

    await expect(provider.deleteEvent("evt_12345")).rejects.toThrow(
      "Failed to delete event",
    );
  });

  it("parses list output and skips malformed lines", async () => {
    execMock.mockImplementationOnce(
      (
        _command: string,
        callback: (error: Error | null, result: { stdout: string }) => void,
      ) => {
        callback(null, {
          stdout: [
            "evt_1 | Project sync | 2026-05-01T09:00:00.000Z | 2026-05-01T10:00:00.000Z | Room 1 | Weekly planning",
            "not a valid line",
            "evt_2 | Retro | 2026-05-02T11:00:00.000Z | 2026-05-02T11:30:00.000Z",
          ].join("\n"),
        });
      },
    );

    const events = await provider.listEvents(
      new Date("2026-05-01T00:00:00.000Z"),
      new Date("2026-05-03T00:00:00.000Z"),
    );

    expect(events).toEqual([
      {
        id: "evt_1",
        title: "Project sync",
        start: new Date("2026-05-01T09:00:00.000Z"),
        end: new Date("2026-05-01T10:00:00.000Z"),
        location: "Room 1",
        description: "Weekly planning",
      },
      {
        id: "evt_2",
        title: "Retro",
        start: new Date("2026-05-02T11:00:00.000Z"),
        end: new Date("2026-05-02T11:30:00.000Z"),
        location: undefined,
        description: undefined,
      },
    ]);
  });

  it("parses a fetched event and returns null when gws get fails", async () => {
    execMock.mockImplementationOnce(
      (
        _command: string,
        callback: (error: Error | null, result: { stdout: string }) => void,
      ) => {
        callback(null, {
          stdout: [
            "ID: evt_9",
            "Title: Team lunch",
            "Start: 2026-05-03T12:00:00.000Z",
            "End: 2026-05-03T13:00:00.000Z",
            "Location: Cafe",
            "Description: Celebrate launch",
          ].join("\n"),
        });
      },
    );

    await expect(provider.getEvent("evt_9")).resolves.toEqual({
      id: "evt_9",
      title: "Team lunch",
      start: new Date("2026-05-03T12:00:00.000Z"),
      end: new Date("2026-05-03T13:00:00.000Z"),
      location: "Cafe",
      description: "Celebrate launch",
    });

    execMock.mockImplementationOnce(
      (
        _command: string,
        callback: (error: Error | null, result?: { stdout: string }) => void,
      ) => {
        callback(new Error("not found"));
      },
    );

    await expect(provider.getEvent("missing")).resolves.toBeNull();
  });
});

function buildEvent(): GwsCalendarEvent {
  return {
    id: "evt_12345",
    title: "Project sync",
    start: new Date("2026-05-01T09:00:00.000Z"),
    end: new Date("2026-05-01T10:00:00.000Z"),
    description: "Weekly planning",
    location: "Room 1",
    attendees: ["alice@example.com", "bob@example.com"],
    recurrence: {
      frequency: "weekly",
      interval: 2,
      count: 3,
      byDay: [1, 3],
    },
  };
}
