# Templates + Skills Rewrite Tracker

Last updated: 2026-04-19

## Python Slice Summary

This slice is split across:

- `nanobot/agent/context.py`
- `nanobot/agent/skills.py`
- `nanobot/utils/prompt_templates.py`
- `nanobot/utils/helpers.py::sync_workspace_templates`
- `nanobot/templates/**`
- `nanobot/skills/**`

The Python implementation treats `templates` and `skills` as prompt-composition infrastructure, not as agent-core logic.

## Python Features Present

### Templates

- Jinja2-based prompt rendering from bundled files under `nanobot/templates/`.
- Cached template environment with support for includes, especially `templates/agent/_snippets/*`.
- Identity/system prompt assembly from template fragments:
  - `agent/identity.md`
  - `agent/platform_policy.md`
  - `agent/skills_section.md`
- Channel-specific formatting hints embedded in the identity template.
- Workspace bootstrap file loading from:
  - `AGENTS.md`
  - `SOUL.md`
  - `USER.md`
  - `TOOLS.md`
- `USER.md` is filtered so only the `Confirmed behavioral heuristics` section is injected.
- Workspace template sync creates missing files only:
  - root markdown bootstrap files
  - `memory/MEMORY.md`
  - empty `memory/history.jsonl`
  - `skills/` directory
- Workspace sync also initializes a git-backed memory store, but that is a separate concern from prompt composition.

### Skills

- Builtin skills live under `nanobot/skills/<name>/SKILL.md`.
- Workspace skills live under `<workspace>/skills/<name>/SKILL.md`.
- Workspace skills override builtin skills with the same name.
- Skill discovery returns:
  - `name`
  - `path`
  - `source` (`workspace` or `builtin`)
- Skills can carry frontmatter metadata.
- Requirement gating supports:
  - required binaries
  - required env vars
- Metadata parser accepts both:
  - `nanobot`
  - `openclaw`
- `always` skills are auto-loaded into the main system prompt when requirements are met.
- Full skill markdown can be loaded into context, with YAML frontmatter stripped.
- A progressive-loading XML summary of all skills is added to the prompt so the agent can decide what to read later.
- Unavailable skills still appear in the summary with `available="false"` and a missing-requirements description.
- There is also a separate skill-authoring/tooling layer:
  - `skill-creator`
  - packaging
  - validation
  - example scripts/assets/references

### Context Composition

- System prompt is assembled from:
  - identity template
  - workspace bootstrap files
  - memory context
  - always-loaded skill content
  - skills summary template
  - recent dream/history entries
- Runtime metadata is injected into the user message as an untrusted block:
  - current time
  - channel
  - chat id
  - resumed-session summary
- Media attachments are converted into inline image blocks.
- Runtime context is merged into the current user message to avoid consecutive same-role messages.

## Likely Keep / Remove Candidates

### Strong Keep Candidates

- Bundled template rendering for agent prompt assembly.
- Workspace bootstrap file sync for missing files only.
- Workspace-skill-overrides-builtin precedence.
- Requirement-gated skill discovery.
- Progressive-loading skills summary rather than dumping all skill bodies.
- Optional `always` skills.
- Explicit workspace `skills/` directory.

### Likely Remove Or Defer

- Full Python context-builder parity in the first TS slice.
- Dream/history injection.
- Git-store initialization as part of template sync.
- OpenClaw metadata compatibility, unless you want cross-compatibility preserved.
- Skill packaging/validation/authoring scripts in the first runtime slice.
- Image/media prompt assembly in this slice unless it is immediately needed by the gateway.

## TS-First Direction

Recommended first TS slice:

1. `TemplateRegistry`
2. `syncWorkspaceTemplates(workspace)`
3. `SkillRegistry` / `SkillsLoader`
4. `buildSkillsSummary()`
5. `loadSkillBodies(names)`
6. Agent-facing prompt composer that consumes the above

Keep this TS-first:

- no Jinja2 clone requirement
- no Python frontmatter quirks unless intentionally preserved
- no skill packaging tools in v1
- no dream/history coupling in v1

## Decisions Needed

Locked decisions for this slice:

1. Keep workspace bootstrap files `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`.
2. Skills are opt-in only. Do not port Python `always` skills.
3. Keep requirement filtering (`bins` / `env`) in v1.
4. Do not keep OpenClaw metadata compatibility. TS uses nanobot-only metadata.
5. Keep progressive-loading skill summaries.
6. Keep template sync only. Do not port Python git/memory setup side effects.

## Proposed First TS Scope

If you want the narrowest useful slice, I would implement:

- bundled template file loader
- workspace template sync for missing files only
- workspace + builtin skill discovery
- workspace override precedence
- requirement filtering
- skills summary generation
- selected-skill body loading
- bootstrap-file loading for prompt composition

And explicitly defer:

- skill authoring/packaging scripts
- OpenClaw metadata compatibility
- dream/history prompt sections
- media-aware context assembly
- git-store side effects
- always-skill auto-loading
