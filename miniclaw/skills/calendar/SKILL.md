---
name: calendar
description: Provider-specific calendar workflow entrypoint
triggers: ["calendar", "schedule", "event", "meeting", "appointment"]
---

# Calendar

Use provider-specific calendar skills instead of a generalized calendar tool.

## When to use

Use this skill when the user asks to:
- Create, update, or delete calendar events
- Check availability or schedule meetings
- View upcoming events
- Manage recurring events

## Usage

For Google Calendar:
1. Load `gws-shared` first for auth and safety rules.
2. Load `gws-calendar` for the full command surface.
3. Load narrower helpers such as `gws-calendar-agenda` or `gws-calendar-insert` when they match the request.

## Notes

- Keep times explicit and timezone-aware.
- Confirm write commands before execution.
- If the preferred provider is `lark`, explain that dedicated Lark execution skills are not available yet.
