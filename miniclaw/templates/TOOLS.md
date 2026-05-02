# Tool Usage Notes

Tool signatures are provided automatically via function calling.
This file documents non-obvious constraints and usage patterns.

## Task Tools

- Use task tools to read or mutate the global job ledger.
- Create jobs only for long-horizon or multi-hop work.
- Keep progress checklists current as tasks finish.
- Archive completed or cancelled jobs instead of removing them.

## User Profile Tools

- Use profile tools to read and update the managed profile in `USER.md`.
- Keep timezone, language, communication style, response length, technical level, calendar provider, and default calendar current.
- Use `record_user_fact` and `record_user_preference` for explicit confirmed user information that should be remembered later.
- Completing the onboarding profile should also complete the onboarding job.

## Workspace Memory Tools

- Use memory tools to manage durable workspace/project knowledge in `MEMORY.md`.
- `MEMORY.md` is for decisions, conventions, constraints, and attempts/outcomes.
- Do not store user identity, preferences, goals, or active task state in `MEMORY.md`.
- When a workflow or project decision is clarified, persist it here for future reuse.

## Goal Tools

- Use goal tools to read and update `GOALS.md`.
- Goals are user-owned. Add a goal only when the user explicitly states one.
- It is valid to record progress, evidence, and status for an existing goal.

## Calendar Tools

- Use `gws_calendar_agenda` for read-only Google Calendar inspection.
- Use `propose_gws_calendar_insert` to create a pending proposal instead of writing immediately.
- Use `execute_gws_calendar_insert` only after explicit user confirmation.

## exec — Safety Limits

- Commands have a configurable timeout (default 60s)
- Dangerous commands are blocked (rm -rf, format, dd, shutdown, etc.)
- Output is truncated at 10,000 characters
- `restrictToWorkspace` config can limit file access to the workspace

## glob — File Discovery

- Use `glob` to find files by pattern before falling back to shell commands
- Simple patterns like `*.py` match recursively by filename
- Use `entry_type="dirs"` when you need matching directories instead of files
- Use `head_limit` and `offset` to page through large result sets
- Prefer this over `exec` when you only need file paths

## grep — Content Search

- Use `grep` to search file contents inside the workspace
- Default behavior returns only matching file paths (`output_mode="files_with_matches"`)
- Supports optional `glob` filtering plus `context_before` / `context_after`
- Supports `type="py"`, `type="ts"`, `type="md"` and similar shorthand filters
- Use `fixed_strings=true` for literal keywords containing regex characters
- Use `output_mode="files_with_matches"` to get only matching file paths
- Use `output_mode="count"` to size a search before reading full matches
- Use `head_limit` and `offset` to page across results
- Prefer this over `exec` for code and history searches
- Binary or oversized files may be skipped to keep results readable

## cron — Scheduled Reminders

- Please refer to cron skill for usage.
