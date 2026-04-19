# Agent Rewrite Tracker

Last updated: 2026-04-17

## Slice Summary

- Python agent features reviewed for this slice:
  - session-key-based isolation
  - durable session persistence
  - direct programmatic runs
  - tool execution
  - hook/event streaming
  - context shaping before model calls
- Explicitly deferred in this slice:
  - cron / heartbeat / dream
  - unified session mode
  - auto-compact / session TTL
  - subagents / MCP
  - Python config compatibility
  - broad Python provider parity

## Decisions Locked

- Runtime engine: `@mariozechner/pi-agent-core` `Agent`
- Canonical transcript contract: `@mariozechner/pi-ai` `Message`
- Public runtime surface: raw `Agent`, created by nanobot helpers
- Session layer: pluggable store, file-backed by default
- Tool ownership: outside core runtime
- Config direction: TS-first only
- Model config shape: `provider` + `modelId`
- Provider scope in v1: `pi-ai` built-ins only

## Progress

| Area | Status | Notes |
| --- | --- | --- |
| Runtime contract | Done for v1 slice | Raw `Agent` creation, `streamFn` wrapping, no built-in tool registration |
| Session persistence | Done for v1 slice | Pluggable session store plus file-backed default |
| Config resolution | Done for v1 slice | TS-first agent config resolves `provider` + `modelId` into `pi-ai` model |
| Direct programmable use | Done for v1 slice | Session-backed raw `Agent` factory with auto-persist on `agent_end` |
| CLI adoption | Partial | `agent` command uses the new runtime; gateway bridging now lives in [AGENT_CHANNELS_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AGENT_CHANNELS_REWRITE_TRACKER.md) |
| Advanced Python parity | Deferred | cron, heartbeat, dream, unified session, MCP, subagents |

## Next Targets

1. Replace provider CLI placeholders with real `pi-ai` auth/runtime flows where applicable.
2. Decide the next gateway-policy slice after the new channel bridge.
3. Decide the next slice boundary for sessions vs providers vs cron/heartbeat integration.
