# Nanobot TS Rewrite Tracker

Last updated: 2026-04-20

This tracker is intentionally blunt. Percentages are parity estimates against the Python nanobot behavior and architecture, not lines-of-code counts.

## Summary

- Foundation is in place: config loading, onboarding stub flow, Commander CLI, and the new generic channel abstraction.
- Most higher-level runtime features are still missing or stubbed.
- Treat anything under 100% as still under rewrite.

## Tracked Areas

| Area | Est. % | Status | Current TS State | Main Gaps | Next Target |
| --- | ---: | --- | --- | --- | --- |
| Config + Onboard | 70% | Partial | Local/prod `.nanobot` paths, `config.json`, workspace creation, existing-config refresh/overwrite flow | Real wizard parity, plugin onboarding, richer post-onboard guidance, template sync | Implement real onboard wizard |
| Commands / CLI | 80% | Heartbeat admin surface landed | Commander CLI plus gateway-integrated slash-command routing for `/help`, `/status`, `/new`, and `/stop`, along with `cron`, `sessions`, and `heartbeat run/status`. See [COMMAND_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/COMMAND_REWRITE_TRACKER.md) and [HEARTBEAT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/HEARTBEAT_REWRITE_TRACKER.md) | No restart/dream command surface, no richer operator/reporting commands yet | Decide whether TS should add restart or keep commands minimal |
| Channels | 94% | Streaming slice landed | Generic `BaseChannel`, `MessageBus`, `ChannelManager`, Telegram implementation, runtime bridge to raw agent, command handling ahead of prompting, Telegram stream/edit delivery, and buffered fallback for non-streaming channels. See [AGENT_CHANNELS_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AGENT_CHANNELS_REWRITE_TRACKER.md), [COMMAND_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/COMMAND_REWRITE_TRACKER.md), and [GATEWAY_STREAMING_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/GATEWAY_STREAMING_REWRITE_TRACKER.md) | More channel types, richer status/reporting, no shared progress config yet | Decide whether TS needs shared progress/tool-hint config |
| Agent | 82% | Consolidator and Dream runtime landed | Raw `pi-agent-core` `Agent` runtime, session-backed factory, native `pi-ai` message transcript, direct prompt/continue flow, channel-to-agent bridge, native abort-backed `/stop`, bus-level stream/progress markers, interrupted-turn checkpoint recovery, consolidator runtime, and Dream runtime. See [DREAM_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/DREAM_REWRITE_TRACKER.md), [AGENT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AGENT_REWRITE_TRACKER.md), [AGENT_CHANNELS_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AGENT_CHANNELS_REWRITE_TRACKER.md), [COMMAND_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/COMMAND_REWRITE_TRACKER.md), [GATEWAY_STREAMING_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/GATEWAY_STREAMING_REWRITE_TRACKER.md), [SESSION_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/SESSION_REWRITE_TRACKER.md), [CONSOLIDATOR_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/CONSOLIDATOR_REWRITE_TRACKER.md), and [AUTO_COMPACT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AUTO_COMPACT_REWRITE_TRACKER.md) | No auto-compact runtime, no advanced Python loop parity, no inbound system-message policy, no git-backed memory versioning | Decide auto-compact keep/remove scope |
| Dream | 68% | Runtime slice landed | `DreamService`, two-phase LLM flow, workspace-scoped read/edit tools, all four memory files, protected cron `dream`, manual `/dream`, cursor advancement, history compaction, and Telegram alias normalization are implemented. See [DREAM_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/DREAM_REWRITE_TRACKER.md). | No git-backed `/dream-log` or `/dream-restore`, limited real tool-loop tests, no richer Dream observability | Decide whether memory versioning or auto-compact should come next |
| Session | 72% | Auto-compact mapped | Atomic JSON session store, corrupt-file quarantine, legal transcript boundaries, runtime checkpoints, bounded retention, and minimal `sessions` CLI. Auto-compact Python behavior is mapped in [AUTO_COMPACT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AUTO_COMPACT_REWRITE_TRACKER.md). See [SESSION_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/SESSION_REWRITE_TRACKER.md) | No TTL compaction, unified-session policy, export/prune tooling, or git-backed memory versioning | Decide auto-compact keep/remove scope |
| Providers | 48% | Real config/runtime slice landed | TS-first `provider` + `modelId` config resolves built-in `pi-ai` models; generic provider config supports `apiKey`, `apiBase`, `headers`, and `${ENV}` resolution. See [PROVIDER_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/PROVIDER_REWRITE_TRACKER.md) | No custom OpenAI-compatible path, no broader provider UX, no real interactive auth flow | Decide whether to add custom provider support |
| Cron | 74% | Evaluator-gated delivery landed | Persistent JSON-backed `CronService`, `at` / `every` / `cron` schedules, CLI admin surface, context-aware `cron` agent tool, and shared background evaluator gating for delivered results are in place. See [CRON_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/CRON_REWRITE_TRACKER.md) and [HEARTBEAT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/HEARTBEAT_REWRITE_TRACKER.md) | No multi-process action-log merge layer, no protected system jobs, no dedicated cron status UI beyond CLI | Decide whether TS needs protected internal jobs or can keep cron user-facing only |
| Heartbeat | 72% | Background policy slice landed | Gateway-owned `HeartbeatService`, `HEARTBEAT.md` workspace contract, two-phase LLM decision/notify flow, heuristic recent-session delivery target selection, bounded `heartbeat` session reuse, and `heartbeat run/status` CLI are in place. See [HEARTBEAT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/HEARTBEAT_REWRITE_TRACKER.md) | No dedicated model override, no slash-command/manual in-channel trigger, no richer observability or reporting | Decide whether heartbeat should gain richer operator controls or stay gateway-owned only |
| Security | 62% | Foundation slice landed | TS now has top-level security config, fail-fast enabled-channel allowlist validation, shared shell/network/env guard helpers, and protected internal cron job boundaries. See [SECURITY_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/SECURITY_REWRITE_TRACKER.md) | No public exec/web tools consume the helpers yet, no sandbox backend support, no richer admin/auth policy | Decide whether future shell/web tools should expose all security knobs or keep them mostly config-driven |
| Skills | 4% | Python slice mapped | No TS runtime implementation yet, but the Python skill model has been mapped and tracked in [TEMPLATES_SKILLS_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/TEMPLATES_SKILLS_REWRITE_TRACKER.md) | No skill registry, loader, requirement filtering, progressive summary, or agent composition path in TS | Decide keep/remove scope for skill metadata, always-skills, and requirement gating |
| Templates | 4% | Python slice mapped | No TS runtime implementation yet, but the Python template/bootstrap model has been mapped and tracked in [TEMPLATES_SKILLS_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/TEMPLATES_SKILLS_REWRITE_TRACKER.md) | No template registry, workspace sync, bootstrap loading, or prompt composition path in TS | Decide keep/remove scope for workspace bootstrap files and template sync side effects |

## Suggested Rewrite Order

1. Auto-compact
2. Memory versioning
3. Skills
4. Templates
5. Restart/system-message policy
6. Final CLI cleanup / parity pass

## Notes

- `Channels` moved ahead because the generic abstraction is now in place.
- `Commands / CLI` is only partially rewritten because a lot of the surface still points at stubs.
- `Providers` is now structurally in place enough to stay on `pi-ai` built-ins for the near term.
- `Gateway` streaming/progress is now in place enough to let `Session` move next.
- `Session`, `Cron`, and `Heartbeat` are now the main coupled runtime areas.
- `Cron` and `Heartbeat` should probably share some scheduling primitives once their Python behavior is mapped.
- `Auto-compact` is now mapped as the next session reliability candidate after `MemoryStore`, `Consolidator`, and `Dream`.

## Update Rule

When a rewrite phase lands, update:

- the percentage
- the `Current TS State`
- the `Main Gaps`
- the `Next Target`

Do not mark an area `100%` until tests cover the intended contract and the Python behavior gap is materially closed.

## Workflow Comment

For each new rewrite task:

1. Explore the Python implementation first.
2. List the Python feature slice behavior that already exists.
3. Ask which parts should be kept and which should be removed.
4. Produce a dedicated sub-tracker markdown file for that slice.
5. Link or mention that sub-tracker from this main tracker for clear reference in later turns.

The point is to keep every rewrite phase grounded in the original Python behavior before TypeScript changes are made.
