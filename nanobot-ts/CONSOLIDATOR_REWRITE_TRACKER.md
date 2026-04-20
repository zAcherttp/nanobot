# Consolidator Rewrite Tracker

Last updated: 2026-04-20

## Python Slice

- Python consolidator lives in `nanobot/agent/memory.py` as `Consolidator`.
- It sits between:
  - `SessionManager` / `Session.last_consolidated`
  - the provider/model runtime
  - `MemoryStore.history.jsonl`
  - `AutoCompact`
- It is used from:
  - `nanobot/agent/loop.py`
  - `nanobot/command/builtin.py`
  - `nanobot/agent/autocompact.py`

## What Python Consolidator Actually Does

### 1. Owns token-budget-triggered archival

- The primary runtime entrypoint is `maybe_consolidate_by_tokens(session)`.
- It estimates current prompt size for the *normal session history view*.
- It compares that against:
  - `context_window_tokens`
  - minus `max_completion_tokens`
  - minus a safety buffer
- If prompt size is too large, it archives older unconsolidated messages until the session falls under a safer target budget.

### 2. Tracks unconsolidated message boundaries through the session

- Python sessions carry `last_consolidated: int`.
- Consolidator only considers `session.messages[session.last_consolidated:]`.
- After a successful archival chunk, it advances `session.last_consolidated = end_idx` and persists the session.
- This boundary is a core contract with:
  - `Session.get_history(...)`
  - `/new`
  - `AutoCompact`

### 3. Picks only safe archival boundaries

- It does **not** archive arbitrary message counts.
- `pick_consolidation_boundary(...)` only cuts on later `user` turns.
- This avoids archiving half a tool chain or mid-assistant/tool turn.
- `_cap_consolidation_boundary(...)` adds a hard cap per archival round while still preserving a user-turn boundary.

### 4. Estimates prompt tokens using the real runtime message builder

- `estimate_session_prompt_tokens(session)` calls the shared message-construction path, not a simplified local formatter.
- It builds the same prompt shape used for normal inference, then estimates token cost with provider/model-aware helpers.
- `/status` uses this estimate too.

### 5. Archives via a dedicated LLM prompt, then writes to MemoryStore history

- `archive(messages)`:
  - formats the message chunk via `MemoryStore._format_messages(...)`
  - calls a dedicated prompt template: `templates/agent/consolidator_archive.md`
  - expects JSON with:
    - `content`
    - `signals`
  - accepts legacy plain text fallback if JSON parsing fails
- On success it appends the summary into `history.jsonl`.

### 6. Has a raw-dump fallback on LLM failure

- If the consolidator LLM call fails, Python falls back to `store.raw_archive(messages)`.
- This degrades quality, but preserves information instead of silently dropping archived context.

### 7. Uses per-session async locking

- Python keeps a shared async lock per session key.
- This prevents multiple overlapping background consolidation passes from racing the same session.

### 8. Is intentionally bounded

- `_MAX_CONSOLIDATION_ROUNDS = 5`
- `_MAX_CHUNK_MESSAGES = 60`
- `_SAFETY_BUFFER = 1024`
- These limits are part reliability guardrail, part latency control.

## Runtime Dependencies

- `MemoryStore`
  - must support appending structured history entries
- Session runtime
  - must expose messages plus `last_consolidated`
  - must persist post-archive state
- Prompt/token estimation
  - must be able to estimate the *real* prompt shape
- Provider/model runtime
  - needed for archive summarization

## What Seems Essential To Keep In TS

1. `last_consolidated` contract
2. per-session lock
3. safe user-turn boundary selection
4. capped chunking / bounded rounds
5. archive JSON parsing with plain-text fallback
6. raw archival fallback on failure
7. prompt-size-triggered consolidation, not just manual archival

## What Is More Flexible In TS

1. exact token estimator implementation
2. exact archive prompt wording
3. whether `/status` depends on the same estimator immediately
4. exact safety-buffer numbers

## Main Design Question For TS

- Should TS first port:
  - only the `archive(...)` primitive plus boundary helpers,
  - or the full token-budget `maybe_consolidate_by_tokens(...)` loop?

For agent reliability, the full loop is the real value. Porting only `archive(...)` would unblock Dream less than it appears, because AutoCompact and long-session control depend on `last_consolidated` and token-budget enforcement.
