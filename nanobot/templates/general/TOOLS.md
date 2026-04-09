# Tool Usage Notes

Tool signatures are provided automatically via function calling.

## exec

- Commands have a configurable timeout.
- Dangerous commands are blocked.
- Output is truncated.

## search tools

- Prefer `glob` and `grep` over shell search when possible.
- Use `grep` in file-path mode before content-heavy searches.

## cron

- Use `cron` for reminders and recurring tasks.
