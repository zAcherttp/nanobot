# Scheduler Autonomy Milestone

## Summary
- Split background behavior into two independent systems:
- `delta sync`: ingest external calendar/task changes into scheduler state
- `reflection`: ask lightweight follow-up questions at phase boundaries

- Move approval from implicit tool-time behavior to explicit planner bundles.
- Add a batch executor that applies an approved bundle with `best-effort + report`.
- Keep current tool adapters and current scheduler loop; extend them rather than replacing them.
- Start follow-up generation with deterministic templates. LLM phrasing is deferred.

## Product Decisions
- Follow-up timing starts with `morning phase end` and `night phase end`.
- If the assistant later learns the user’s working hours confidently, phase-end triggers shift to those learned end times.
- Item-specific follow-ups are only sent for `flagged` items.
- Planner approval is `proposal bundle` based.
- Batch execution uses `best-effort + structured report`.
- Executor concurrency stays capped at `3`.

## Implementation Changes

### 1. Delta Sync Loop
- Add a scheduler background sync job that:
- reads stored sync cursors
- calls `mcp_gws_calendar_list_event_changes`
- calls `mcp_gws_tasks_list_task_changes`
- writes compact reconciled entries into `memory/diff_insights.jsonl`
- updates `memory/sync_state.json`

- Keep this loop read-only with respect to external systems.
- Treat manual edits as normal input, not exceptions.

Likely file targets:
- [scheduler_state.py](/E:/Web/.tauri/nanobot/nanobot/agent/scheduler_state.py)
- [scheduler.py](/E:/Web/.tauri/nanobot/nanobot/agent/tools/scheduler.py)
- [service.py](/E:/Web/.tauri/nanobot/nanobot/heartbeat/service.py)
- [commands.py](/E:/Web/.tauri/nanobot/nanobot/cli/commands.py)

### 2. Reflection Loop
- Add a separate reflection scheduler that runs at phase-end boundaries.
- Initial default phases:
- morning phase end
- night phase end

- Later, when working-hour confidence is high enough, derive phase-end triggers from learned working hours.
- Reflection prompt selection rules:
- generic phase check-in by default
- task/event-specific follow-up only for flagged items
- deterministic templates first
- optional future LLM phrasing only for high-context flagged cases

- Reflection should produce:
- a user-facing message
- optional structured observation records from the reply
- no automatic calendar/task mutation

Likely file targets:
- [service.py](/E:/Web/.tauri/nanobot/nanobot/heartbeat/service.py)
- [scheduler.py](/E:/Web/.tauri/nanobot/nanobot/agent/tools/scheduler.py)
- [HEARTBEAT.md](/E:/Web/.tauri/nanobot/nanobot/templates/scheduler/HEARTBEAT.md)
- [evaluator.md](/E:/Web/.tauri/nanobot/nanobot/templates/scheduler/agent/evaluator.md)

### 3. Proposal Bundle Approval
- Introduce a serialized `proposal bundle` format for planner-generated external changes.
- A bundle should include:
- stable `bundle_id`
- human summary
- machine-readable operations
- operation IDs
- dependencies
- approval family
- expected side effects
- optional rollback guidance text

- When planner returns `needs_approval`, the loop should create an approval request from the bundle itself before any write tool is called.
- Approval should bind execution to that exact bundle.
- Tool-level approval remains as a fallback guardrail only.

Likely file targets:
- [scheduler_contract.py](/E:/Web/.tauri/nanobot/nanobot/agent/scheduler_contract.py)
- [loop.py](/E:/Web/.tauri/nanobot/nanobot/agent/loop.py)
- [approval.py](/E:/Web/.tauri/nanobot/nanobot/approval.py)
- [identity.md](/E:/Web/.tauri/nanobot/nanobot/templates/scheduler/agent/identity.md)

### 4. Batch Executor
- Add a scheduler executor that takes an approved bundle and applies the contained operations with bounded concurrency.
- Execution semantics:
- preserve operation ordering when dependencies require it
- run independent operations with concurrency cap `3`
- do not invent new operations at execution time
- return a structured result for every operation

- Result shape should include:
- completed ops
- failed ops
- skipped ops
- partial-application indicator
- visible user-facing summary
- suggested recovery steps when relevant

- This is not a true transaction. It is deterministic best-effort execution with reporting.

Likely file targets:
- new executor module under `nanobot/agent/`
- [loop.py](/E:/Web/.tauri/nanobot/nanobot/agent/loop.py)
- possibly small helper additions in [calendar.py](/E:/Web/.tauri/nanobot/nanobot/agent/tools/calendar.py)
- possibly small helper additions in [tasks.py](/E:/Web/.tauri/nanobot/nanobot/agent/tools/tasks.py)

### 5. Habit Signal Integration
- Use reflection replies and reconciled diffs as evidence inputs, not as direct preference writes.
- Promote repeated patterns into low-confidence observations first.
- Only strengthen working-hour assumptions after repeated confirmation.
- Let phase-end reflection scheduling consume those confidence-scored working-hour signals.

Likely file targets:
- [memory.py](/E:/Web/.tauri/nanobot/nanobot/agent/memory.py)
- [USER.md](/E:/Web/.tauri/nanobot/nanobot/templates/scheduler/USER.md)
- [GOALS.md](/E:/Web/.tauri/nanobot/nanobot/templates/scheduler/GOALS.md)

## Verification
- Delta sync test: calendar/task deltas update `sync_state` and append compact `diff_insights`.
- Manual edit test: external edits are reconciled without full snapshot bloat.
- Reflection timing test: defaults use morning/night phase ends, then shift when learned working-hour confidence crosses threshold.
- Follow-up scope test: only flagged items generate item-specific prompts.
- Approval test: `needs_approval` produces an approval request before any write tool executes.
- Bundle integrity test: approved execution matches the exact serialized bundle.
- Batch executor test: partial failures return structured `completed/failed/skipped` results.
- Concurrency test: independent operations never exceed `3` concurrent writes.
- No-side-effect reflection test: reflection sends prompts and records observations but never mutates external systems.
- Stability test: identical approved bundles produce identical operation ordering and reporting.

## Deferrals
- No true transactional rollback layer in this milestone.
- No free-form LLM-generated follow-up prompts by default.
- No automatic schedule mutation from reflection replies.
- No planner rewrite beyond what is needed to emit and execute proposal bundles.

## Recommended Delivery Order
1. proposal bundle schema and `needs_approval` loop integration
2. approved bundle batch executor
3. background delta sync using existing change tools
4. phase-end reflection scheduling
5. habit-based adaptive timing for phase boundaries
6. optional LLM phrasing for flagged follow-ups later