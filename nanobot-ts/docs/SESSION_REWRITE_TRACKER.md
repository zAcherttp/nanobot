# Session Rewrite Tracker

Last updated: 2026-04-19

## Slice Summary

- Python session behaviors reviewed for this slice:
  - legal history boundaries
  - interrupted-turn runtime checkpoints
  - corrupted-session tolerance
  - bounded live transcript retention
- Explicitly deferred in this slice:
  - idle TTL auto-compact
  - resumed idle-session summaries
  - dream/memory consolidation
  - unified-session mode

## Decisions Locked

- Keep TS JSON session files; no JSONL migration
- Recovery policy: restore interrupted turn state on next request
- Retention policy: legal recent suffix by message count plus persisted text truncation
- Corruption policy: quarantine unreadable session files and continue
- CLI surface: minimal admin commands only

## Progress

| Area | Status | Notes |
| --- | --- | --- |
| File store durability | Done for this slice | Atomic save + corrupt-file quarantine |
| Persistence hygiene | Done for this slice | Empty assistant drop, legal start detection, recent suffix retention, text truncation |
| Runtime recovery | Done for this slice | Checkpoint persistence during in-flight turns and restore on next request |
| CLI admin surface | Done for this slice | `sessions list/show/clear` |
| TTL/auto-compact | Deferred | Intentionally excluded from this slice |

## Next Targets

1. Decide whether TS needs TTL-based idle compaction.
2. Decide whether session inspection needs export/prune commands.
3. Revisit unified-session policy only after cron/heartbeat are stable.
