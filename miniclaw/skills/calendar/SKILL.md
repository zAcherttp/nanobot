---
name: calendar
description: Provider-specific calendar workflow entrypoint
triggers: ["calendar", "schedule", "event", "meeting", "appointment"]
---

# Calendar

Use calendar skills for guidance, then execute only through the dedicated GWS tools.

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
4. Use `gws_calendar_agenda`, `propose_plan`, and `execute_plan` as the actual runtime actions.

## Notes

- Keep times explicit and timezone-aware.
- Confirm write commands before execution.
- The currently supported write plan type is `gws_calendar_insert`.
- If the preferred provider is `lark`, explain that Miniclaw currently stores the preference but does not have a Lark execution path.
