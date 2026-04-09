# Agentic Memory Box

This folder is a drop-in starter package for the scheduler-focused memory system discussed earlier.

## Goal

Separate memory into three layers:

1. `MEMORY.md`
Temporary operational state that should affect scheduling immediately.

2. `USER.md`
Durable behavioral profile that stores stable preferences, learned patterns, and planner policies.

3. `Dream Cycle`
Offline consolidation that reads recent chat and system traces, then promotes validated patterns into `USER.md`.

## Recommended File Layout

```text
agentic-memory-box/
  README.md
  MEMORY.template.md
  USER.template.md
  DREAM_CYCLE_SPEC.md
```

## Design Rules

- Put same-day or short-lived facts into `MEMORY.md`.
- Put durable, decision-relevant beliefs into `USER.md`.
- Never promote a single complaint into `USER.md` unless the user explicitly states a stable preference.
- Every durable profile item should include confidence, evidence source, and last-confirmed metadata.
- The scheduler should read both files before making planning decisions.

## What Goes Where

### Write to `MEMORY.md`

- "Running 20 minutes late"
- "Exhausted today"
- "Meeting moved"
- "Need a lighter afternoon"
- "Did not sleep well"

### Write to `USER.md`

- "Prefers deep work on Monday mornings"
- "Afternoon slump usually occurs around 14:00-15:30"
- "Needs 20 minutes of decompression after meeting clusters"
- "Avoid scheduling thesis writing after 2 consecutive meetings"

## Promotion Pipeline

1. Conversation or external event generates an observation.
2. Observation is recorded in `MEMORY.md`.
3. Scheduler uses that observation immediately if it affects planning.
4. `Dream Cycle` reviews `history.jsonl`, calendar outcomes, task completion patterns, and recent `MEMORY.md`.
5. `Dream Cycle` decides whether to:
   - discard the observation
   - summarize it into a short note
   - strengthen an existing profile belief
   - create a new low-confidence hypothesis in `USER.md`
6. Old beliefs decay if not reconfirmed.

## Minimal Runtime Contract

Before each scheduling decision, the agent should synthesize:

- current commitments from Calendar and Tasks
- temporary state from `MEMORY.md`
- durable profile and policies from `USER.md`

Then the planner should answer:

- What is fixed?
- What is behaviorally risky?
- What should be protected?
- What can be moved or downgraded?

## Practical Heuristic

Use this rule in code:

- If it matters today, write to `MEMORY.md`.
- If it is likely true next month, store it in `USER.md`.
- If you are not sure, keep it in `MEMORY.md` and let the `Dream Cycle` decide.
