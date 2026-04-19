# Command Rewrite Tracker

Last updated: 2026-04-19

## Slice Summary

- Python behavior reviewed for this slice:
  - slash commands are routed separately from normal agent prompting
  - priority commands can bypass the normal per-session dispatch lock
  - built-in commands include `/help`, `/status`, `/new`, and `/stop`
- Explicitly kept in TS for this slice:
  - dedicated command router ahead of the agent runtime
  - real `/stop` cancellation through the raw `pi-agent-core` abort path
  - `/help`, `/status`, `/new`, and `/stop` as the initial built-in command set
- Explicitly deferred in TS for this slice:
  - `/restart`
  - Dream commands
  - prefix commands and interceptors
  - streaming/progress policy

## Decisions Locked

- Command handling stays in the gateway/runtime layer, not in `ChannelManager`
- `/stop` is the only priority command in this slice
- `/status` reports TS runtime truth only
- `/new` clears both persisted session state and cached in-memory agent state
- Handled commands never fall through to the model

## Progress

| Area | Status | Notes |
| --- | --- | --- |
| Command router | Done for this slice | Exact and priority routing are in place |
| Core built-ins | Done for this slice | `/help`, `/status`, `/new`, `/stop` |
| Gateway integration | Done for this slice | Commands are handled before normal prompting |
| Stop behavior | Done for this slice | Uses native `agent.abort()` for active session work |
| Deferred Python command set | Deferred | restart, dream, prefix/interceptor logic |

## Next Targets

1. Decide whether `/restart` belongs in TS or should remain out of scope.
2. Add the next gateway policy slice only after deciding on streaming/progress behavior.
3. Revisit richer command routing only if a real prefix/interceptor use case appears.
