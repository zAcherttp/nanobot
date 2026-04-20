# Nanobot TS Rewrite Tracker

Last updated: 2026-04-20

This tracker is intentionally blunt. Percentages are parity estimates against the Python nanobot behavior and architecture, not lines-of-code counts.

## Summary

- Foundation is in place: strict config loading, onboarding scaffold flow, Commander CLI, and the new generic channel abstraction.
- Most higher-level runtime features are still missing or deferred.
- Treat anything under 100% as still under rewrite.

## Tracked Areas

| Area | Est. % | Status | Current TS State | Main Gaps | Next Target |
| --- | ---: | --- | --- | --- | --- |
| Config + Onboard | 78% | Legacy cleanup landed | Local/prod `.nanobot` paths, strict `config.json` parsing, workspace creation, existing-config refresh/overwrite flow, and TS-native config without inactive Python-era aliases. See [LEGACY_CLEANUP_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/LEGACY_CLEANUP_TRACKER.md) | Real wizard parity, plugin onboarding, richer post-onboard guidance | Implement real onboard wizard |
| Commands / CLI | 80% | Heartbeat admin surface landed | Commander CLI plus gateway-integrated slash-command routing for `/help`, `/status`, `/new`, and `/stop`, along with `cron`, `sessions`, and `heartbeat run/status`. See [COMMAND_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/COMMAND_REWRITE_TRACKER.md) and [HEARTBEAT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/HEARTBEAT_REWRITE_TRACKER.md) | No restart/dream command surface, no richer operator/reporting commands yet | Decide whether TS should add restart or keep commands minimal |
| Channels | 94% | Streaming slice landed | Generic `BaseChannel`, `MessageBus`, `ChannelManager`, Telegram implementation, runtime bridge to raw agent, command handling ahead of prompting, Telegram stream/edit delivery, and buffered fallback for non-streaming channels. See [AGENT_CHANNELS_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AGENT_CHANNELS_REWRITE_TRACKER.md), [COMMAND_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/COMMAND_REWRITE_TRACKER.md), and [GATEWAY_STREAMING_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/GATEWAY_STREAMING_REWRITE_TRACKER.md) | More channel types, richer status/reporting, no shared progress config yet | Decide whether TS needs shared progress/tool-hint config |
| Agent | 87% | Legacy cleanup landed | Raw `pi-agent-core` `Agent` runtime, session-backed factory, native `pi-ai` message transcript, direct prompt/continue flow, channel-to-agent bridge, native abort-backed `/stop`, bus-level stream/progress markers, interrupted-turn checkpoint recovery, consolidator runtime, Dream runtime, idle auto-compaction, and template-only runtime prompt composition. See [DREAM_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/DREAM_REWRITE_TRACKER.md), [AGENT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AGENT_REWRITE_TRACKER.md), [AGENT_CHANNELS_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AGENT_CHANNELS_REWRITE_TRACKER.md), [COMMAND_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/COMMAND_REWRITE_TRACKER.md), [GATEWAY_STREAMING_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/GATEWAY_STREAMING_REWRITE_TRACKER.md), [SESSION_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/SESSION_REWRITE_TRACKER.md), [CONSOLIDATOR_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/CONSOLIDATOR_REWRITE_TRACKER.md), [AUTO_COMPACT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AUTO_COMPACT_REWRITE_TRACKER.md), and [LEGACY_CLEANUP_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/LEGACY_CLEANUP_TRACKER.md) | No advanced Python loop parity, no inbound system-message policy, no git-backed memory versioning | Explore memory versioning or restart/system-message policy next |
| Dream | 68% | Runtime slice landed | `DreamService`, two-phase LLM flow, workspace-scoped read/edit tools, all four memory files, protected cron `dream`, manual `/dream`, cursor advancement, history compaction, and Telegram alias normalization are implemented. See [DREAM_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/DREAM_REWRITE_TRACKER.md). | No git-backed `/dream-log` or `/dream-restore`, limited real tool-loop tests, no richer Dream observability | Decide whether memory versioning or auto-compact should come next |
| Session | 83% | Legacy cleanup landed | Atomic JSON session store, corrupt-file quarantine, legal transcript boundaries, runtime checkpoints, bounded retention, minimal `sessions` CLI, TTL-based idle auto-compaction, and no active unified-session TODO tests. See [AUTO_COMPACT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AUTO_COMPACT_REWRITE_TRACKER.md), [SESSION_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/SESSION_REWRITE_TRACKER.md), and [LEGACY_CLEANUP_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/LEGACY_CLEANUP_TRACKER.md) | No unified-session policy, export/prune tooling, or git-backed memory versioning | Decide whether memory versioning or unified-session policy comes next |
| Providers | 48% | Real config/runtime slice landed | TS-first `provider` + `modelId` config resolves built-in `pi-ai` models; generic provider config supports `apiKey`, `apiBase`, `headers`, and `${ENV}` resolution. See [PROVIDER_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/PROVIDER_REWRITE_TRACKER.md) | No custom OpenAI-compatible path, no broader provider UX, no real interactive auth flow | Decide whether to add custom provider support |
| Cron | 74% | Evaluator-gated delivery landed | Persistent JSON-backed `CronService`, `at` / `every` / `cron` schedules, CLI admin surface, context-aware `cron` agent tool, and shared background evaluator gating for delivered results are in place. See [CRON_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/CRON_REWRITE_TRACKER.md) and [HEARTBEAT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/HEARTBEAT_REWRITE_TRACKER.md) | No multi-process action-log merge layer, no protected system jobs, no dedicated cron status UI beyond CLI | Decide whether TS needs protected internal jobs or can keep cron user-facing only |
| Heartbeat | 72% | Background policy slice landed | Gateway-owned `HeartbeatService`, `HEARTBEAT.md` workspace contract, two-phase LLM decision/notify flow, heuristic recent-session delivery target selection, bounded `heartbeat` session reuse, and `heartbeat run/status` CLI are in place. See [HEARTBEAT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/HEARTBEAT_REWRITE_TRACKER.md) | No dedicated model override, no slash-command/manual in-channel trigger, no richer observability or reporting | Decide whether heartbeat should gain richer operator controls or stay gateway-owned only |
| Security | 62% | Foundation slice landed | TS now has top-level security config, fail-fast enabled-channel allowlist validation, shared shell/network/env guard helpers, and protected internal cron job boundaries. See [SECURITY_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/SECURITY_REWRITE_TRACKER.md) | No public exec/web tools consume the helpers yet, no sandbox backend support, no richer admin/auth policy | Decide whether future shell/web tools should expose all security knobs or keep them mostly config-driven |
| Skills | 62% | Composition slice landed | TS-native builtin/workspace skill loader, requirement filtering, summaries with availability markers, selected skill bodies via `agent.skills`, and prompt-composition integration. See [TEMPLATES_SKILLS_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/TEMPLATES_SKILLS_REWRITE_TRACKER.md) | No dynamic skill selection, no skill authoring tooling, no auto-registration of tools from skills | Decide whether dynamic skill selection belongs in commands or agent policy |
| Templates | 74% | Composition slice landed | Bundled templates, missing-files-only workspace sync, bootstrap files, `USER.md` heuristic extraction, memory scaffolding, and canonical runtime prompt composition. See [TEMPLATES_SKILLS_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/TEMPLATES_SKILLS_REWRITE_TRACKER.md) | No memory-versioning template sync, no richer onboard wizard integration | Decide whether template sync needs versioning or manual repair commands |

## Suggested Rewrite Order

1. Memory versioning
2. Restart/system-message policy
3. Skills
4. Templates
5. Unified-session policy
6. Final CLI cleanup / parity pass

## Notes

- `Channels` moved ahead because the generic abstraction is now in place.
- `Commands / CLI` is only partially rewritten because some operator surfaces are intentionally deferred.
- `Providers` is now structurally in place enough to stay on `pi-ai` built-ins for the near term.
- `Gateway` streaming/progress is now in place enough to let `Session` move next.
- `Session`, `Cron`, and `Heartbeat` are now the main coupled runtime areas.
- `Cron` and `Heartbeat` should probably share some scheduling primitives once their Python behavior is mapped.
- `Auto-compact` is now implemented as the next session reliability layer after `MemoryStore`, `Consolidator`, and `Dream`.
- `Legacy cleanup` removed inactive prompt config, Python-era memory migration, and TODO-only unified-session tests.

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
