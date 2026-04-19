# Nanobot TS Rewrite Tracker

Last updated: 2026-04-17

This tracker is intentionally blunt. Percentages are parity estimates against the Python nanobot behavior and architecture, not lines-of-code counts.

## Summary

- Foundation is in place: config loading, onboarding stub flow, Commander CLI, and the new generic channel abstraction.
- Most higher-level runtime features are still missing or stubbed.
- Treat anything under 100% as still under rewrite.

## Tracked Areas

| Area | Est. % | Status | Current TS State | Main Gaps | Next Target |
| --- | ---: | --- | --- | --- | --- |
| Config + Onboard | 70% | Partial | Local/prod `.nanobot` paths, `config.json`, workspace creation, existing-config refresh/overwrite flow | Real wizard parity, plugin onboarding, richer post-onboard guidance, template sync | Implement real onboard wizard |
| Commands / CLI | 74% | Core command slice landed | Commander CLI plus gateway-integrated slash-command routing for `/help`, `/status`, `/new`, and `/stop`. See [COMMAND_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/COMMAND_REWRITE_TRACKER.md) | No restart/dream command surface, no cron/heartbeat/skills/template commands yet | Decide whether TS should add restart or keep commands minimal |
| Channels | 90% | Bridge plus command slice landed | Generic `BaseChannel`, `MessageBus`, `ChannelManager`, Telegram implementation, runtime bridge to raw agent, `channels message`, no echo, command handling ahead of prompting. See [AGENT_CHANNELS_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AGENT_CHANNELS_REWRITE_TRACKER.md) and [COMMAND_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/COMMAND_REWRITE_TRACKER.md) | More channel types, richer status/reporting, no streaming/progress policy yet | Decide the streaming/progress gateway slice |
| Agent | 64% | Core runtime plus command-aware gateway landed | Raw `pi-agent-core` `Agent` runtime, session-backed factory, native `pi-ai` message transcript, direct prompt/continue flow, channel-to-agent bridge, and native abort-backed `/stop`. See [AGENT_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AGENT_REWRITE_TRACKER.md), [AGENT_CHANNELS_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/AGENT_CHANNELS_REWRITE_TRACKER.md), and [COMMAND_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/COMMAND_REWRITE_TRACKER.md) | No cron/heartbeat/dream, no advanced Python loop parity, no streaming/system-message policy | Implement the gateway streaming/progress slice or session policy slice |
| Session | 35% | Foundation landed | Pluggable session store plus file-backed persistence under workspace | No expiration, unified-session policy, compaction, or richer metadata/lifecycle handling | Expand session policy and runtime integration |
| Providers | 48% | Real config/runtime slice landed | TS-first `provider` + `modelId` config resolves built-in `pi-ai` models; generic provider config supports `apiKey`, `apiBase`, `headers`, and `${ENV}` resolution. See [PROVIDER_REWRITE_TRACKER.md](E:/Web/.tauri/nanobot/nanobot-ts/PROVIDER_REWRITE_TRACKER.md) | No custom OpenAI-compatible path, no broader provider UX, no real interactive auth flow | Decide whether to add custom provider support |
| Cron | 0% | Missing | No TS implementation yet | No scheduler, no job definitions, no command surface, no persistence | Add cron domain model and CLI stubs |
| Heartbeat | 0% | Missing | No TS implementation yet | No recurring health/runtime hooks, no scheduling, no integration with agent/channels | Define heartbeat contract after cron shape is clear |
| Security | 0% | Missing | No dedicated TS security layer yet | No policy model, secrets handling strategy, permission gates, or security checks | Define minimal security/config boundary |
| Skills | 0% | Missing | No TS implementation yet | No skill registry, loader, execution path, or CLI/admin surface | Design skill manifest + loader boundary |
| Templates | 0% | Missing | No TS implementation yet | No template registry, sync logic, scaffold flow, or workspace integration | Define template storage and sync behavior |

## Suggested Rewrite Order

1. Session
2. Gateway streaming / progress policy
3. Cron
4. Heartbeat
5. Skills
6. Templates
7. Security
8. Final CLI cleanup / parity pass

## Notes

- `Channels` moved ahead because the generic abstraction is now in place.
- `Commands / CLI` is only partially rewritten because a lot of the surface still points at stubs.
- `Providers` is now structurally in place enough to stay on `pi-ai` built-ins for the near term.
- `Session` and gateway streaming/progress are the next coupled areas; changing one will likely affect the other.
- `Cron` and `Heartbeat` should probably share some scheduling primitives once their Python behavior is mapped.

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
