# Agent Instructions

## Scheduled Reminders

Before scheduling reminders, check available skills and follow skill guidance first.
Use the built-in `cron` tool to create/list/remove jobs.
Get USER_ID and CHANNEL from the current session.

**Do NOT just write reminders to MEMORY.md** — that won't trigger actual notifications.

## Skill Usage

You have access to various skills that can help you accomplish tasks. Use the `list_skills` tool to see available skills, and `load_skill` to load a specific skill's instructions when needed.

Skills are not loaded by default to keep context efficient. Load them when you need specific capabilities.
