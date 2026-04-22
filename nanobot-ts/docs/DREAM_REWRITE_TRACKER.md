# Dream Rewrite Tracker

Last updated: 2026-04-20

Scope: Python Dream background learning parity exploration for `nanobot-ts`.

## Python Behavior Mapped

- Reads unprocessed `memory/history.jsonl` entries after `memory/.dream_cursor`.
- Processes a bounded batch with `max_batch_size` default `20`.
- Uses a two-phase LLM flow:
  - Phase 1 analyzes conversation history plus current `MEMORY.md`, `SOUL.md`, `USER.md`, and `GOALS.md`.
  - Phase 2 runs an agent/tool loop to surgically edit workspace memory files.
- Uses workspace-scoped file tools only:
  - read file
  - edit file
- Edits these files:
  - `memory/MEMORY.md`
  - `SOUL.md`
  - `USER.md`
  - `GOALS.md`
- Tracks behavioral signals from history entries into `USER.md` behavioral observations and confirmed heuristics.
- Tracks goal effort and status updates in `GOALS.md`.
- Advances `.dream_cursor` after Phase 1 succeeds and Phase 2 has been attempted, even if no edits happen.
- Calls `compact_history()` after advancing the cursor.
- Returns `false` when no unprocessed history exists; returns `true` when it processed a batch.
- Logs failures without crashing the gateway.
- Supports config:
  - `intervalH`, default `2`
  - legacy `cron` override
  - `modelOverride`
  - `maxBatchSize`, default `20`
  - `maxIterations`, default `10`
- Registers a protected internal cron job named `dream`.
- Cron execution special-cases the `dream` system event and calls Dream directly.
- Adds slash commands:
  - `/dream`
  - `/dream-log`
  - `/dream-restore`
- `/dream` is fire-and-forget: immediate `Dreaming...`, then later completion/no-op/failure notification.
- `/dream-log` and `/dream-restore` depend on git-backed memory versioning.
- Telegram exposes slash commands and normalizes `_` aliases:
  - `/dream_log` -> `/dream-log`
  - `/dream_restore` -> `/dream-restore`

## Current TS State

- `MemoryStore` already has:
  - `readUnprocessedHistory()`
  - `getLastDreamCursor()`
  - `setLastDreamCursor()`
  - `compactHistory()`
  - `readMemory()`, `readSoul()`, `readUser()`, `readGoals()`
- `CronService` already supports protected `system_event` jobs.
- `createCronService()` currently returns `system_event` messages but does not dispatch Dream.
- Template loading already supports bundled `templates/agent/*.md`.
- Session/consolidator history archive plumbing already writes Dream-readable `history.jsonl`.
- `tests/dream.test.ts` exists but is still TODO-only.
- No TS `DreamService` exists yet.
- No TS file edit/read tool pair exists for Dream.
- No TS git-backed memory versioning exists.

## Locked Decisions

- Keep Python's full two-phase LLM flow.
- Edit all four memory files:
  - `memory/MEMORY.md`
  - `SOUL.md`
  - `USER.md`
  - `GOALS.md`
- Support both protected internal cron job `dream` and manual `/dream`.
- Use the main agent provider/model; do not add Dream model override in this slice.
- Defer real `/dream-log` and `/dream-restore` until git-backed memory versioning exists.
- Keep Python cursor semantics: advance after Phase 2 is attempted, even if no edits were made.
- Keep history compaction after each Dream run.
- Keep Telegram underscore aliases:
  - `/dream_log` -> `/dream-log`
  - `/dream_restore` -> `/dream-restore`

## Implemented In This Slice

- Added `DreamService`.
- Added bundled `dream_phase1.md` and `dream_phase2.md` templates.
- Added workspace-scoped Dream read/edit tools.
- Added `agent.dream.intervalHours`, `agent.dream.maxBatchSize`, and `agent.dream.maxIterations`.
- Registered protected cron job `dream` during gateway startup.
- Wired cron `system_event: dream` execution to `DreamService`.
- Added `/dream` command with immediate `Dreaming...` response and settled completion/no-op/failure notification.
- Added unavailable guidance for `/dream-log` and `/dream-restore`.
- Added Telegram alias normalization for Dream commands.
- Converted Dream stub tests into real tests for no-op, prompt context, cursor advancement, and compaction.

## Remaining Work

- Add git-backed memory versioning before implementing real `/dream-log` and `/dream-restore`.
- Add deeper tests for the real Phase 2 tool loop with a faux model that edits files.
- Add richer gateway observability for Dream job state and last run details.

## Test Targets

- No-op when no unprocessed history exists. Done.
- Phase 1 receives bounded history and current memory file context. Done.
- Phase 2 receives analysis result and workspace file context. Done via injection.
- Read/edit tools are constrained to the workspace.
- Cursor advances to the last processed batch entry. Done.
- History compaction runs after successful processing. Done.
- Phase 1 failure does not advance cursor.
- Phase 2 failure still advances cursor after Phase 1 succeeded.
- Protected cron job `dream` is registered and cannot be removed or updated.
- `/dream` triggers background Dream execution and emits immediate plus settled replies.
- Existing gateway, cron, and heartbeat behavior remains unchanged.
