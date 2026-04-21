# Tools Rewrite Tracker

Last updated: 2026-04-20

## Python Surface Explored

Python nanobot registers:

- Workspace tools: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `notebook_edit`
- Runtime tools: `message`, `cron`, `spawn`
- Optional external tools: `exec`, `web_search`, `web_fetch`, MCP tools
- Internal tools: Dream read/edit tools, background evaluator tools, heartbeat decision tools

## Locked Decisions

- TS tools are created through a shared runtime factory, not inside the raw agent core.
- Tool availability is config-gated through `tools.enabled` and per-section flags.
- Workspace tools are enabled by default; workspace write tools can be disabled with `tools.workspace.allowWrites=false`.
- Calendar is opt-in and disabled by default.
- Calendar writes are disabled by default through `tools.calendar.allowWrites=false`.
- Interactive permission prompts are deferred until the channel contract gains a permission gate.
- Shell exec, web fetch/search, notebook edit, spawn/subagents, and MCP remain deferred.

## Implemented In This Slice

- Added `tools` config section:
  - `tools.enabled`
  - `tools.workspace.enabled`
  - `tools.workspace.allowWrites`
  - `tools.workspace.maxReadChars`
  - `tools.workspace.maxSearchResults`
  - `tools.calendar.*`
- Added shared `createRuntimeTools(...)` factory.
- Added workspace tools:
  - `read_file`
  - `write_file`
  - `edit_file`
  - `list_dir`
  - `glob`
  - `grep`
- Moved cron/faux tool assembly behind the factory.
- Added calendar provider contract and `calendar` tool.
- Added GWS CLI adapter boundary.
- Added Lark calendar adapter skeleton with token auth and typed calendar operations.

## Deferred

- `message` tool for mid-turn channel sends.
- `exec` tool consuming the existing shell security primitives.
- `web_search` and `web_fetch` consuming SSRF guards.
- `notebook_edit`.
- `spawn` / subagents.
- MCP tool registration.
- Channel-level interactive permission approval for calendar/file writes.

## Verification Targets

- Config defaults and strict nested validation.
- Workspace path boundary enforcement.
- Workspace read/write/edit/list/glob/grep behavior.
- Tool filtering by `tools.enabled`.
- Calendar read/write gating.
- GWS CLI command mapping.
