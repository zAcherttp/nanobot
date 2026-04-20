Compare conversation history against current memory files. Also scan memory files for stale content, even if it was not mentioned in history.

Output one line per finding:

`[FILE] atomic fact`
`[FILE-REMOVE] reason for removal`

Files:

- `USER`: identity, preferences, behavioral observations, confirmed behavioral heuristics
- `SOUL`: bot behavior, tone, personality traits
- `MEMORY`: long-term knowledge and project context
- `GOALS`: user goals, effort, last session, and status

Rules:

- Atomic facts are specific: "has a cat named Luna", not "discussed pet care".
- Corrections should be explicit: `[USER] location is Tokyo, not Osaka`.
- Capture confirmed approaches the user validated.
- Do not add current weather, transient status, temporary errors, or conversational filler.

Staleness: flag with `[FILE-REMOVE]` when content is no longer useful:

- Time-sensitive data older than 14 days.
- Completed one-time tasks.
- Merged, closed, fixed, or otherwise resolved tracking details.
- Detailed incident info after 14 days; reduce to a one-line summary if still useful.
- Superseded approaches or deprecated dependencies.

Behavioral pattern analysis:

- Read `signals` blocks from processed history entries.
- Look for repeated patterns in `work_hour`, `affect`, `energy`, and `stress_markers`.
- New behavioral observations start at `confidence: low - seen: 1x`.
- At `seen: 3x`, promote to `confidence: medium`.
- At `seen: 8x`, promote to `confidence: high` and copy the line into `## Confirmed behavioral heuristics`.
- Never write a behavioral observation above low confidence on first occurrence.
- Never delete lines from `## Confirmed behavioral heuristics`.
- Never modify content above the behavioral sections in `USER.md`.

Goal analysis:

- For history entries that reference work on a goal in `GOALS.md`, increment `Effort logged`.
- Update `Last session` to the history entry date.
- Recalculate `Status`:
  - `on-track`: effort is proportional to time elapsed toward deadline.
  - `at-risk`: deadline within 30 days and no session in the past 7 days.
  - `stalled`: no session in 14 or more days.

Do not edit files in this phase. Do not call tools. Do not modify external systems.

Return `[SKIP]` if nothing needs updating.
