# Heartbeat Rewrite Tracker

Last updated: 2026-04-19

## TS Status

- Heartbeat is now implemented in `nanobot-ts` as a gateway-owned service:
  - `src/heartbeat/service.ts`
  - `src/heartbeat/runtime.ts`
  - wired from `src/cli/commands.ts`
- `HEARTBEAT.md` is now part of TS workspace template sync.
- TS keeps the Python-style two-phase flow:
  - decision phase via lightweight tool-call LLM request
  - execution phase through the real session-backed agent runtime using session key `heartbeat`
- TS keeps heuristic delivery target selection from recent non-internal enabled channel sessions.
- TS keeps bounded heartbeat history trimming after execution.
- TS exposes manual control through:
  - `heartbeat run`
  - `heartbeat status`
- TS also landed the shared background evaluator and now applies it to:
  - heartbeat notify/suppress
  - cron background delivery

## Remaining Gaps

- No dedicated heartbeat model override; TS uses the normal configured provider/model
- No slash-command trigger for heartbeat yet
- No richer heartbeat observability beyond CLI/admin status
- No dedicated heartbeat progress UI beyond normal streamed agent output when the execution path produces it

## Python Slice

- `HeartbeatService` lives in `nanobot/heartbeat/service.py`
- Reads `HEARTBEAT.md` from the workspace on each tick
- Runs on a fixed interval (`interval_s`), default 30 minutes
- Has a two-phase flow:
  - decision phase: small LLM call with a virtual `heartbeat` tool returning `skip` or `run`
  - execution phase: only if decision is `run`, invoke the full agent loop with the returned task summary
- Accepts `on_execute` and `on_notify` callbacks rather than owning delivery/runtime directly
- Supports `trigger_now()` for manual execution
- Uses timezone-aware current-time injection in the decision prompt
- Logs and swallows runtime errors instead of crashing the gateway loop

## Gateway Wiring In Python

- Heartbeat is created in `nanobot/cli/commands.py`, not in the heartbeat package itself
- Target delivery channel is chosen heuristically from the most recent non-internal session on an enabled channel
- Execution runs through the full agent loop with:
  - fixed session key `heartbeat`
  - chosen `channel` / `chat_id`
  - silent progress callback
- After each execution, the Python gateway trims heartbeat session history to a bounded recent suffix (`keep_recent_messages`)
- Notification delivery is separate from execution and only sends when an external routable channel exists

## Post-Run Policy

- Python heartbeat does not blindly notify after execution
- `nanobot/utils/evaluator.py` makes a second lightweight LLM tool-call decision:
  - `should_notify: true|false`
  - defaults to notify on any evaluator failure
- This evaluator is shared by heartbeat and cron

## Python Config Surface

- `config.gateway.heartbeat.enabled`
- `config.gateway.heartbeat.interval_s`
- `config.gateway.heartbeat.keep_recent_messages`

## Explicitly Noted Characteristics

- No separate heartbeat models/types file was found; behavior is concentrated in the service plus gateway wiring
- Heartbeat is not a generic message command/tool in Python
- Heartbeat is policy-heavy:
  - workspace file driven
  - LLM-based task detection
  - LLM-based notify/suppress decision
  - session-target heuristic for channel delivery

## Likely TS Slice Boundaries

- Scheduler glue alone would be too small and would miss the real product behavior
- The meaningful TS heartbeat slice likely needs:
  - `HEARTBEAT.md` file contract
  - periodic trigger service
  - decision phase
  - execution via raw TS agent runtime
  - delivery target policy
  - notify/suppress policy
