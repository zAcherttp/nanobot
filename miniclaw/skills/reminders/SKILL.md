---
name: reminders
description: Set and manage reminders for important tasks
triggers: ["remind", "reminder", "notify", "alert"]
---

# Reminders

Use the cron tool to create reminders for important tasks.

## When to use

Use this skill when the user asks to:
- Set a reminder for a specific time
- Create recurring reminders
- Get notified about deadlines
- Remember important events

## Usage

One-time reminder:
```
cron(action="add", message="Time for the meeting!", at="2024-01-15T10:00:00")
```

Recurring reminder:
```
cron(action="add", message="Daily standup", cron_expr="0 9 * * 1-5")
```

Interval reminder:
```
cron(action="add", message="Take a break", every_seconds=3600)
```

List reminders:
```
cron(action="list")
```

Remove reminder:
```
cron(action="remove", job_id="abc123")
```

## Notes

- Use `at` for one-time reminders (ISO datetime)
- Use `cron_expr` for recurring schedules (cron syntax)
- Use `every_seconds` for interval-based reminders
- Reminders are delivered via the configured channel
