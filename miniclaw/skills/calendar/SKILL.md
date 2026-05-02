---
name: calendar
description: Provider-specific calendar workflow entrypoint
triggers: ["calendar", "schedule", "event", "meeting", "appointment"]
---

# Calendar

Use calendar skills for guidance, then execute through `exec`.

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
4. Use `exec` for read-only inspection commands.
5. For write commands, present the proposed command plan with `ask_user` and only run `exec` after explicit approval.

## Notes

- Keep times explicit and timezone-aware.
- Confirm write commands before execution through `ask_user`.
- If the preferred provider is `lark`, explain that Miniclaw currently stores the preference but does not have a Lark execution path.
