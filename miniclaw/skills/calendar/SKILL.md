---
name: calendar
description: Manage calendar events and scheduling
triggers: ["calendar", "schedule", "event", "meeting", "appointment"]
---

# Calendar

Use the calendar tool to manage events and scheduling.

## When to use

Use this skill when the user asks to:
- Create, update, or delete calendar events
- Check availability or schedule meetings
- View upcoming events
- Manage recurring events

## Usage

Create an event:
```
calendar(action="create", title="Team Meeting", start="2024-01-15T10:00:00", end="2024-01-15T11:00:00")
```

List events:
```
calendar(action="list", start="2024-01-01", end="2024-01-31")
```

Update an event:
```
calendar(action="update", event_id="abc123", title="Updated Title")
```

Delete an event:
```
calendar(action="delete", event_id="abc123")
```

## Notes

- All times should be in ISO 8601 format
- The calendar provider (GWS or Lark) is configured in the system
- Timezone handling is automatic based on user configuration
