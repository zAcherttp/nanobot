# Gateway Streaming Rewrite Tracker

Last updated: 2026-04-19

## Slice Summary

- Python behavior reviewed for this slice:
  - outbound streaming/progress uses bus metadata markers
  - Telegram progressively edits streamed assistant text
  - tool-call hints can be surfaced during a turn
- Explicitly kept in TS for this slice:
  - metadata-marker-based outbound contract
  - Telegram-native streaming support
  - buffered fallback for non-streaming channels
- Explicitly deferred in TS for this slice:
  - broader progress categories
  - global channel progress config
  - inbound system-message policy

## Decisions Locked

- Bus wire shape stays on `OutboundChannelMessage + metadata`
- Stream scope is assistant text plus tool hints
- Telegram uses a local `streaming` toggle
- Stream completion publishes an end marker, not a duplicate final reply
- Non-streaming channels buffer deltas and emit one final whole reply

## Progress

| Area | Status | Notes |
| --- | --- | --- |
| Gateway event translation | Done for this slice | `message_update` and tool execution events become bus markers |
| Telegram streaming | Done for this slice | First send, later edits, final end handling |
| Buffered fallback | Done for this slice | Manager accumulates delta text until `_stream_end` |
| Deferred policy | Deferred | richer progress semantics and shared config |

## Next Targets

1. Decide whether TS needs shared `sendProgress` / `sendToolHints` config like Python.
2. Revisit inbound system messages after the streaming contract settles.
3. Fold streaming behavior into future multi-channel support if a second channel is added.
