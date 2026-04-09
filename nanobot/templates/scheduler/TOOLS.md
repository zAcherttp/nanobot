# Scheduler Tool Notes

Scheduler mode has a constrained toolset.

## Allowed tools

- `read_file`
- `list_dir`
- `glob`
- `grep`
- `web_search`
- `web_fetch`
- `cron`
- `message`

## Policy

- Do not mutate workspace files as part of normal scheduler conversations.
- Use `cron` for reminders and recurring planning support.
- Use search and web tools to gather context, then recommend or schedule with consent.
