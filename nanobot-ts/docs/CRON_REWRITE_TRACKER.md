# Cron Rewrite Tracker

Last updated: 2026-04-19

## Python Slice

- Persistent file-backed cron service with `at`, `every`, and `cron` schedules
- Job state with next/last run timestamps, status, error, and capped run history
- Agent-turn payload delivery back into channels
- Agent cron tool with `add`, `list`, `remove`
- Nested scheduling blocked inside cron execution
- Protected internal system jobs exist in Python, but are intentionally deferred in TS
- Python action-log multi-process merge layer is deferred in TS

## Keep / Remove Decisions

- Keep `at`, `every`, and `cron`
- Keep persistent JSON storage
- Keep delivery fields `deliver`, `channel`, and `to`
- Keep both CLI admin commands and the agent tool
- Keep nested-scheduling protection inside cron execution
- Remove/defer Python action-log merge layer
- Remove/defer protected `system_event` jobs and dream integration

## Current TS Target

- `CronService` with persistent JSON store and timer loop
- Context-aware `cron` agent tool
- `gateway` startup wiring for scheduled execution
- CLI admin surface for list/add/remove/run/status
- No system jobs in this slice

