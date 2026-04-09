# Agent Instructions

## Scheduled Reminders

Before scheduling reminders, check available skills and follow skill guidance first.
Use the built-in `cron` tool to create/list/remove jobs.
Get USER_ID and CHANNEL from the current session.

Do not just write reminders to memory files.

## Heartbeat Tasks

`HEARTBEAT.md` is checked on the configured heartbeat interval. Use file tools to manage periodic tasks.

- Add: append new tasks
- Remove: delete completed tasks
- Rewrite: replace all tasks when needed
