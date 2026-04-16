Compare conversation history against current memory files. Also scan memory files for stale content — even if not mentioned in history.

Output one line per finding:
[FILE] atomic fact (not already in memory)
[FILE-REMOVE] reason for removal

Files: USER (identity, preferences), SOUL (bot behavior, tone), MEMORY (knowledge, project context)

Rules:
- Atomic facts: "has a cat named Luna" not "discussed pet care"
- Corrections: [USER] location is Tokyo, not Osaka
- Capture confirmed approaches the user validated

Staleness — flag for [FILE-REMOVE]:
- Time-sensitive data older than 14 days: weather, daily status, one-time meetings, passed events
- Completed one-time tasks: triage, one-time reviews, finished research, resolved incidents
- Resolved tracking: merged/closed PRs, fixed issues, completed migrations
- Detailed incident info after 14 days — reduce to one-line summary
- Superseded: approaches replaced by newer solutions, deprecated dependencies

Do not add: current weather, transient status, temporary errors, conversational filler.

## Step 2: Behavioral pattern analysis

Read all history.jsonl entries processed in this run that contain a `signals` block.

For each signals block:
- Note the `work_hour`, `affect`, `energy`, and any `stress_markers`
- Look for the same pattern appearing across multiple entries (e.g. low energy at similar hours, stress markers near the same type of deadline)

For each pattern you identify:
- If it does not yet exist in USER.md `## Behavioral observations`: add it at confidence: low · seen: 1x
- If it already exists: increment the seen count and apply the confidence promotion rules
- `seen: 3x` → promote to `confidence: medium`
- `seen: 8x` → promote to `confidence: high` and copy the line into `## Confirmed behavioral heuristics`
- Never write a behavioral observation with confidence higher than `low` on first occurrence
- Never delete lines from `## Confirmed behavioral heuristics`
- Never modify content above the behavioral sections in USER.md

For each history entry that references work on a goal listed in GOALS.md:
- Increment `Effort logged` by the estimated hours spent (infer from conversation length and topic depth, minimum 0.5h)
- Update `Last session` to the entry's timestamp date
- Recalculate `Status` using these rules:
  - `on-track`: effort logged is proportional to time elapsed toward deadline
  - `at-risk`: deadline within 30 days and no session logged in the past 7 days
  - `stalled`: no session logged in 14+ days regardless of deadline

Do not make any edits to external systems. Do not modify calendar or task data.

[SKIP] if nothing needs updating.
