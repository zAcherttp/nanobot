# Auto-Compact Rewrite Tracker

Last updated: 2026-04-20

## Python Slice

- Python auto-compaction lives in `nanobot/agent/autocompact.py`.
- It is wired from `nanobot/agent/loop.py` as part of the long-running agent loop.
- It depends on:
  - `SessionManager`
  - `Session.last_consolidated`
  - `Consolidator.archive(...)`
  - legal recent-suffix retention
  - runtime context construction
- Its Python test coverage lives in `tests/agent/test_auto_compact.py`.

## What Python Auto-Compact Actually Does

### 1. Uses idle TTL config, disabled by default

- Config field is `agents.defaults.session_ttl_minutes`.
- Preferred user-facing alias is `idleCompactAfterMinutes`.
- Legacy alias `sessionTtlMinutes` is intentionally rejected by strict TS config parsing.
- Serialization emits `idleCompactAfterMinutes`.
- Default is `0`, which disables idle compaction.

### 2. Detects expired sessions by `updated_at`

- A session is expired when idle time is greater than or equal to the TTL.
- `None` and empty timestamps are treated as not expired.
- ISO string timestamps are parsed.
- TTL `0` disables all expiry checks.

### 3. Runs proactive sweeps from the idle agent loop

- The Python loop waits for inbound messages with a 1-second timeout.
- On timeout, it calls `auto_compact.check_expired(...)`.
- Expired sessions are scheduled as background archival tasks.
- A per-key `_archiving` set prevents duplicate archival for the same session.
- Archive errors are logged and do not crash the loop.

### 4. Archives only the unconsolidated prefix

- Auto-compact works from `session.messages[session.last_consolidated:]`.
- It keeps a legal recent suffix of 8 messages.
- It archives the older unconsolidated prefix through `Consolidator.archive(...)`.
- It then replaces the live session transcript with the kept suffix and resets `last_consolidated` to `0`.

### 5. Preserves a one-shot resume summary

- If archival produces a useful summary, Python stores it in memory and in session metadata under `_last_summary`.
- On the next request for that session, `prepare_session(...)` injects:
  - idle duration
  - previous conversation summary
- The summary is runtime context only, not persisted as normal chat messages.
- The summary is consumed once and removed from metadata.
- A summary equal to `"(nothing)"` is suppressed.

### 6. Refreshes sessions after compact or empty skip

- After a successful archive, `updated_at` is refreshed to prevent immediate rescheduling.
- Empty expired sessions skip archival but still refresh `updated_at`.
- The same session can compact again later after new messages arrive and another idle period passes.

### 7. Coexists with runtime checkpoint recovery

- Auto-compact reloads sessions before archival.
- It preserves checkpoint metadata.
- Short expired sessions can keep their messages and resume interrupted checkpoint recovery.
- It does not intentionally poison or remove checkpoint state.

### 8. Is transparent to priority commands

- Python priority commands bypass normal message processing.
- `/stop` and similar priority commands are not blocked by auto-compaction.
- Normal exact commands, including `/new`, run after `prepare_session(...)`.
- `/new` on an expired session is idempotent: the session may compact first, then clear.

## Current TS State

- TS has an auto-compact runtime service.
- `tests/auto-compact.test.ts` has real coverage for the current TS contract.
- TS prerequisites are in place:
  - file-backed `SessionStore`
  - `SessionRecord.updatedAt`
  - `SessionRecord.lastConsolidated`
  - legal suffix helpers
  - runtime checkpoint metadata
  - `Consolidator.archive(...)`
  - gateway-owned background services
  - direct CLI and gateway session-backed agent paths

## Recommended TS Shape

- Add a dedicated `AutoCompactService` or `AutoCompactor` under the agent/session layer.
- Keep the service transport-agnostic and session-store based.
- Wire proactive sweeps from gateway startup, similar to cron and heartbeat services.
- Wire `prepareSession(...)` into both:
  - gateway prompt handling
  - direct CLI agent prompt handling
- Keep summary injection as a prompt-composition/runtime-context input, not as a persisted message.
- Do not couple auto-compact to the Heartbeat task evaluator; heartbeat and auto-compact have different responsibilities.

## Decisions Locked

1. Keep Python default `idleCompactAfterMinutes = 0` disabled.
2. Accept only `idleCompactAfterMinutes`; reject legacy `sessionTtlMinutes`.
3. Run proactive sweeps from `gateway` only.
4. Apply `prepareSession(...)` to both gateway-created agents and direct CLI agents.
5. Keep one-shot summary injection into the next prompt context.
6. Keep recent suffix size fixed at Python's 8 messages.
7. Keep archive-only-unconsolidated-prefix behavior using `lastConsolidated`.
8. Keep `(nothing)` summary suppression.
9. Keep raw-fallback/trim behavior: archival failure must not block trimming or future prompts.
10. Defer inbound `system` message parity until the gateway system-message policy exists.
11. Keep auto-compact as its own gateway service, not a Heartbeat concern.
12. Sweep all safe sessions while skipping sessions reported active by gateway, cron, or heartbeat.

## Progress

| Area | Status | Notes |
| --- | --- | --- |
| Config | Done for this slice | `agent.idleCompactAfterMinutes`, default `0`, legacy key rejected |
| Runtime service | Done for this slice | `AutoCompactor` supports `start`, `stop`, `isRunning`, `sweepOnce`, and `prepareSession` |
| Session archival | Done for this slice | Archives unconsolidated prefix, keeps legal suffix of 8, resets `lastConsolidated` |
| Summary lifecycle | Done for this slice | `_last_summary` metadata is consumed once into transient context |
| Gateway integration | Done for this slice | Gateway starts/stops auto-compact and skips active gateway/cron/heartbeat sessions |
| Direct CLI integration | Done for this slice | `createSessionAgent` runs prepare before `prompt` and `continue` |
| Tests | Done for this slice | `tests/auto-compact.test.ts` converted from stubs to real coverage |

## Implemented TS Slice

- Added config:
  - `agent.idleCompactAfterMinutes: number`
  - strict unknown-key rejection for legacy `sessionTtlMinutes`
- Added auto-compact runtime:
  - `isExpired(...)`
  - `sweepOnce(...)`
  - `prepareSession(...)`
  - internal session archival path
  - per-session active archival guard
- Add summary metadata shape:
  - `_last_summary.text`
  - `_last_summary.last_active`
- Integrated:
  - gateway service startup and shutdown
  - gateway prompt preflight
  - direct CLI agent preflight
  - `/new` archival behavior if kept
- Converted `tests/auto-compact.test.ts` from TODOs into real tests.

## Test Targets

- Config alias/default/serialization behavior.
- Expiry calculation, including exact TTL boundary and string timestamps.
- Gateway proactive sweep archives expired sessions only.
- No duplicate archive while a session is already archiving.
- Empty expired sessions refresh `updatedAt`.
- Archival keeps legal recent suffix and archives only unconsolidated prefix.
- Summary metadata survives restart and is consumed once.
- Summary context is not persisted as chat messages.
- `(nothing)` summaries are suppressed.
- Runtime checkpoints survive auto-compact preparation.
- `/new` clears even if auto-compact archival fails.
- Priority commands are unaffected by active or pending auto-compaction.
