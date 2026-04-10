# Scheduler Tool Notes

Scheduler mode has a constrained toolset.

## Allowed tools

- `read_file`
- `list_dir`
- `glob`
- `grep`
- `mcp_gws_calendar_*`
- `mcp_gws_tasks_*`
- `scheduler_record_observation`
- `scheduler_recall_context`
- `scheduler_reflow_timespan`
- `web_search`
- `web_fetch`
- `cron`
- `message`

## Policy

- Do not mutate workspace files directly as part of normal scheduler conversations.
- Prefer calendar/task tools for real-world scheduling changes.
- Use `scheduler_record_observation` instead of editing `USER.md` or `MEMORY.md` directly.
- Use `scheduler_recall_context` when the current planning turn needs compact local recall.
- Use `scheduler_reflow_timespan` before proposing multi-item reschedules.
- Use `cron` for reminders and recurring planning support.
- Use search and web tools to gather context, then recommend or schedule with consent.
