# Security Rewrite Tracker

Last updated: 2026-04-20

## Python Slice

- Python security is not one single module. It is spread across:
  - config loading and schema
  - channel access control
  - shell/tool guards
  - network SSRF protections
  - cron/system-job protections
- The meaningful files are:
  - `nanobot/config/loader.py`
  - `nanobot/config/schema.py`
  - `nanobot/channels/base.py`
  - `nanobot/channels/manager.py`
  - `nanobot/agent/tools/shell.py`
  - `nanobot/agent/tools/web.py`
  - `nanobot/security/network.py`
  - `nanobot/cron/service.py`

## Config-Level Controls In Python

- `tools.restrict_to_workspace`
  - global switch intended to keep tool access inside the workspace
  - legacy config migration still maps `tools.exec.restrictToWorkspace` to this field
- `tools.exec.allowed_env_keys`
  - explicit allowlist of env vars that may pass through to subprocesses
- `tools.exec.sandbox`
  - optional sandbox backend, currently `bwrap` on Unix only
- `tools.ssrf_whitelist`
  - CIDR ranges allowed to bypass SSRF blocking
- `channels.send_progress`
  - enables/disables progress streaming
- `channels.send_tool_hints`
  - enables/disables tool-call hint streaming
- `channels.send_max_retries`
  - caps channel delivery retries

## Channel Security Behavior In Python

- Channel access is deny-by-default if `allow_from` is empty.
- `BaseChannel.is_allowed(...)`
  - empty `allow_from` means deny all
  - `"*"` means allow all
  - otherwise sender ID must match exactly
- `BaseChannel._handle_message(...)`
  - drops disallowed senders before publishing to the bus
- `ChannelManager._validate_allow_from()`
  - fails fast at startup if an enabled channel has `allowFrom = []`
  - Python treats this as misconfiguration, not just a runtime no-op

## Shell / Tool Security Behavior In Python

- `ExecTool` has explicit safety guards before command execution:
  - deny-pattern blocklist for destructive commands:
    - `rm -rf`
    - `del /f` / `del /q`
    - `rmdir /s`
    - `format`
    - `mkfs`, `diskpart`
    - `dd if=`
    - writes to `/dev/sd*`
    - shutdown/reboot/poweroff
    - fork bombs
  - optional allow-pattern allowlist
  - internal/private URL detection inside shell commands
  - path-traversal checks when workspace restriction is enabled
  - absolute-path escape checks when workspace restriction is enabled
- Environment exposure is intentionally minimal:
  - Unix subprocesses get a reduced base env
  - Windows subprocesses get a curated system env
  - extra env vars must be explicitly allowed via `allowed_env_keys`
- Optional shell sandboxing exists on Unix via `bwrap`
  - Windows logs a warning and runs unsandboxed

## Network / Web Security Behavior In Python

- `nanobot/security/network.py` provides SSRF protection:
  - blocks private/internal IPv4 and IPv6 ranges
  - blocks localhost and link-local ranges
  - supports config-driven CIDR exceptions through `ssrf_whitelist`
- `validate_url_target(...)`
  - validates scheme, hostname, and resolved IPs before fetch
- `validate_resolved_url(...)`
  - validates redirect targets after fetch
- `contains_internal_url(...)`
  - scans command text for internal/private URLs and is reused by shell guards
- `web_fetch`
  - validates initial URL with SSRF checks
  - validates redirect targets again after fetch
  - marks fetched content as untrusted data
- `web_search`
  - validates custom SearXNG URL shape, but SSRF protections are strongest on fetch paths

## Background / System Protections In Python

- Cron protects internal/system jobs:
  - `register_system_job(...)` exists for protected internal jobs
  - `remove_job(...)` refuses to remove `system_event` jobs
  - `update_job(...)` refuses to update `system_event` jobs
- Heartbeat itself is policy-controlled rather than user-triggered from channels in the current Python shape.

## Secret Handling Characteristics In Python

- Provider API keys live in config and can also be sourced from env references.
- Config loader resolves `${ENV_VAR}` placeholders and raises if missing.
- Shell subprocesses do not inherit arbitrary parent env vars by default.
- There is no dedicated secret vault layer in the explored Python slice.

## Likely TS Slice Boundaries

- The TS security slice should probably cover:
  - channel sender access policy
  - subprocess env minimization and allowlisted passthrough
  - workspace-boundary enforcement
  - shell dangerous-command guards
  - SSRF and redirect validation for web/network tooling
  - protection for internal/system background jobs
- It should probably not try to solve:
  - a full secret-management product
  - interactive approval UX
  - OS-level sandboxing parity on every platform in the first pass

## Locked Decisions

1. Keep Python's fail-fast startup behavior for empty channel allowlists.
2. Keep the dangerous shell-command denylist.
3. Keep minimal subprocess env plus explicit `allowedEnvKeys`.
4. Keep SSRF blocking with config whitelist semantics.
5. Keep protected internal cron/system jobs.
6. Defer sandbox backend support.

## TS Slice Status

- Top-level `security` config now carries:
  - `restrictToWorkspace`
  - `allowedEnvKeys`
  - `ssrfWhitelist`
- Enabled channels now fail fast when `allowFrom` is empty.
- Shared TS security helpers now exist for:
  - SSRF/internal-network validation
  - embedded internal URL detection
  - dangerous shell command detection
  - workspace path-boundary checks
  - restricted subprocess env construction
- Cron now supports protected internal `system_event` jobs through runtime registration and refuses public remove/update attempts.

## Remaining Gaps

- No public TS shell tool yet.
- No public TS web fetch/search tool yet.
- No sandbox backend support yet.
- No richer admin/auth policy beyond current channel sender allowlists.
