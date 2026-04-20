# Agent + Channels Rewrite Tracker

Last updated: 2026-04-19

## Slice Summary

- Python behavior reviewed for this slice:
  - inbound channel messages land on a generic bus
  - default session keys come from `channel:chat_id`
  - per-session processing is serialized
  - outbound replies route back to the originating channel
  - runtime failures become generic user-visible error replies
- Additional gateway policy now landed:
  - slash commands are routed ahead of normal prompting
  - `/stop` can cancel active per-session work
  - `/help`, `/status`, and `/new` return channel-bound text replies without touching the model
- Additional streaming policy now landed:
  - assistant text deltas are published onto the outbound bus
  - tool hints are surfaced as progress metadata
  - Telegram consumes stream markers natively while non-streaming channels buffer and finalize
- Explicitly deferred in this slice:
  - inbound `system` messages
  - mid-turn message injection
  - heartbeat/cron/subagent integration

## Decisions Locked

- Bridge shape: separate gateway runtime service
- Channel manager stays transport-focused
- Agent runtime remains the raw `pi-agent-core` path from the earlier slice
- Session persistence stays in the existing file-backed session store
- Reply mode in this slice: one settled assistant reply only
- Error mode in this slice: generic reply, no channel-specific fallback logic

## Progress

| Area | Status | Notes |
| --- | --- | --- |
| Inbound bus subscription | Done for this slice | Dedicated gateway runtime subscribes to channel inbound traffic |
| Session-key contract | Done for this slice | Uses `sessionKeyOverride` first, else `channel:chatId` |
| Per-session serialization | Done for this slice | Same-session messages queue; different sessions can run in parallel |
| Outbound delivery | Done for this slice | Runtime publishes outbound replies; manager dispatches them while running |
| CLI gateway adoption | Done for this slice | `gateway` now starts both the runtime bridge and the channel manager |
| Core command policy | Done for this slice | `/help`, `/status`, `/new`, `/stop` now live in the gateway runtime |
| Streaming / progress delivery | Done for this slice | Bus metadata markers, Telegram edits, and buffered fallback are in place |
| Deferred Python policies | Deferred | system messages, injections, cron/heartbeat |

## Next Targets

1. Decide whether inbound `system` messages are still needed after the command slice.
2. Revisit shared progress/tool-hint config after the streaming slice settles.
3. Revisit heartbeat/cron integration after the gateway bridge settles.
