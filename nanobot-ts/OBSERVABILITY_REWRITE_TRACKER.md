# Runtime Observability Rewrite Tracker

Last updated: 2026-04-20

## Locked Decisions

- Durable runtime logs live in the instance data directory under `.nanobot/logs`, not inside the workspace.
- Logs are JSONL entries in `runtime.jsonl` for direct local inspection and future tooling.
- Persisted data is sanitized by default: secret-like keys are redacted and content/tool previews are truncated.
- CLI visibility is limited to `logs tail`, `logs show`, `logs clear`, `agent --logs`, and `gateway --verbose`.
- This slice does not add metrics, dashboards, tracing backends, remote shipping, or HTTP log APIs.

## Implemented

- Shared `LogStore` remains available for in-memory logs.
- Added `RuntimeLogStore` for file-backed JSONL append, recent-entry reads, filtering, clearing, malformed-line skipping, and bounded retention.
- Added structured runtime fields: `component`, `event`, `sessionKey`, `channel`, `chatId`, `jobId`, `turnId`, and sanitized `data`.
- Added logging config fields: `logging.maxEntries`, `logging.maxPreviewChars`, and `logging.console`.
- Added CLI `logs show`, `logs tail`, and `logs clear`.
- `agent --logs` now streams direct run events instead of reporting a stub.
- `gateway --verbose` now writes durable logs and streams console lifecycle/debug events.
- Runtime surfaces now emit structured events for gateway, channels, agent turns/events, cron, heartbeat, Dream, auto-compact, and session quarantine paths.

## Deferred

- OpenTelemetry or external tracing integration.
- Metrics counters and dashboards.
- HTTP log inspection APIs.
- Full prompt/session transcript capture.
- Rich log rotation by file size/time; current retention is max-entry compaction.

## Verification

- Added tests for JSONL append/read, max-entry retention, malformed-line skipping, filters, and sanitization.
- Added CLI/config coverage for the new log surface and logging defaults.
