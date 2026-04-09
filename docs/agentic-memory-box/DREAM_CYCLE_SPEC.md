# Dream Cycle Spec

Offline consolidation process for turning recent observations into durable scheduling knowledge.

## Inputs

- `history.jsonl`
- recent `MEMORY.md`
- Google Calendar outcomes
- Google Tasks completion / deferral patterns

## Outputs

- updates to `USER.md`
- optional cleanup or summarization of stale `MEMORY.md` entries

## Core Responsibilities

1. Detect repeated behavioral patterns.
2. Separate transient complaints from durable preferences.
3. Maintain confidence scores on existing beliefs.
4. Add new hypotheses when evidence is suggestive but weak.
5. Decay or retire beliefs that are no longer supported.

## Promotion Rules

### Promote Immediately

Allowed only when the user explicitly states a durable preference.

Examples:

- "I hate meetings before 9 AM."
- "I always want Monday morning for thesis work."
- "Do not schedule deep work after dinner."

### Keep Temporary

Keep in `MEMORY.md` if the statement is obviously situational.

Examples:

- "I am exhausted today."
- "I am running late."
- "This afternoon is ruined."

### Promote After Repetition

Promote into `USER.md` when evidence repeats across days or contexts.

Examples:

- afternoon deep work repeatedly gets postponed
- user repeatedly struggles after meeting clusters
- Sunday evening planning repeatedly succeeds

## Confidence Guidance

- 0.30 to 0.49: weak hypothesis
- 0.50 to 0.69: plausible pattern
- 0.70 to 0.84: reliable planner signal
- 0.85 to 1.00: strong durable belief

## Conflict Resolution

When new evidence conflicts with old profile items:

1. Prefer recent direct user statements.
2. Lower confidence on contradicted inferred beliefs.
3. Preserve old belief as a note until enough evidence exists to replace it.

## Suggested Consolidation Pass

For each recent observation:

1. Classify it as transient, preference, pattern, or contradiction.
2. Link it to an existing profile item if possible.
3. Update confidence and last-confirmed metadata.
4. If evidence is insufficient, create or update an open hypothesis.

## Scheduler Contract

The online scheduler should never depend on the `Dream Cycle` to react to urgent same-day conditions.

The `Dream Cycle` exists to improve future decisions, not to handle today’s emergency.
