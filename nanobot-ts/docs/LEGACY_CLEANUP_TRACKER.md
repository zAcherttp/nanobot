# Legacy Compatibility Cleanup Tracker

Last updated: 2026-04-20

## Scope

This slice removes compatibility paths that are no longer part of the TS-first runtime contract. The goal is strict, explicit TS behavior rather than accepting Python-era config or file formats silently.

## Landed Changes

| Area | Status | Decision |
| --- | --- | --- |
| Agent prompt config | Done | Removed inactive `agent.systemPrompt`; runtime prompts are composed from bundled templates, workspace bootstrap files, and selected skills only. |
| Config parsing | Done | Root and known nested config sections are strict. Unknown keys now fail during load instead of being ignored. |
| Auto-compact config | Done | Removed bespoke `sessionTtlMinutes` compatibility handling. It now fails as an unknown `agent` key. |
| Provider overrides | Done | `providers` remains a record, but each provider override object is strict. |
| Memory history migration | Done | Removed `memory/HISTORY.md` migration. `MemoryStore` only manages TS-native `memory/history.jsonl` and cursor files. |
| Unified session tests | Done | Removed TODO-only unified-session tests from the active suite. Unified-session policy stays deferred here instead of creating test noise. |
| Test wording | Done | Renamed Python-oriented descriptions where behavior is now TS-native. |

## Explicitly Kept

- Telegram `/dream_log` and `/dream_restore` aliases remain because they are current Telegram-safe command aliases.
- Faux provider support remains because it is current TS test infrastructure.
- Template-based prompt composition remains the canonical runtime prompt source.

## Deferred

- Unified-session policy.
- Onboard wizard parity.
- Runtime log streaming.
- Memory versioning and git-backed history.

## Verification

- `pnpm build`
- `npx vitest run`
