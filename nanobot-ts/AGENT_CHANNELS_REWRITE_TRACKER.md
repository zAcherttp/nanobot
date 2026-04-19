# Agent + Channels Rewrite Tracker

Last updated: 2026-04-19

## Slice Summary

- Python behavior reviewed for this slice:
  - inbound channel messages land on a generic bus
  - default session keys come from `channel:chat_id`
  - per-session processing is serialized
  - outbound replies route back to the originating channel
  - runtime failures become generic user-visible error replies
- Explicitly deferred in this slice:
  - slash commands
  - inbound `system` messages
  - mid-turn message injection
  - streaming/progress delivery
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
| Deferred Python policies | Deferred | commands, system messages, injections, streaming, cron/heartbeat |

## Next Targets

1. Decide whether the next gateway policy slice should add slash commands or inbound `system` messages first.
2. Add progress/streaming delivery once the non-streaming contract is stable.
3. Revisit heartbeat/cron integration after the gateway bridge settles.
