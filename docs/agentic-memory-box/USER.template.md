# USER PROFILE

Durable behavioral profile for planning, prioritization, and proactive schedule repair.

## Identity

- Name: USER_NAME
- Timezone: Asia/Ho_Chi_Minh
- Primary role: student
- Typical wake window: 06:30-07:30
- Typical sleep window: 23:30-00:30

## Stable Preferences

- Prefers deep work in the morning.
- Prefers Monday morning reserved for thesis work.
- Dislikes back-to-back meetings.
- Prefers 60-90 minute focus blocks over fragmented sessions.

## Scheduling Constraints

### Hard Constraints

- Fixed classes and advisor meetings must be preserved unless user approves a change.
- Avoid scheduling focused work after 21:30.

### Soft Constraints

- Keep at least 15 minutes between meetings where possible.
- Keep lunch open between 11:30-13:00 where possible.
- Avoid more than 3 meetings in one day.

## Behavioral Patterns

### Energy Pattern

- Pattern: Morning focus peak
  - Window: 08:00-11:00
  - Best for: thesis writing, analysis, planning
  - Confidence: 0.89
  - Evidence: repeated success over 5 weeks
  - Source type: inferred
  - Last confirmed: 2026-04-06
  - Decay rule: reduce confidence if not reconfirmed within 30 days

- Pattern: Mid-afternoon slump
  - Window: 14:00-15:30
  - Best for: admin, email, errands
  - Risk for: deep work, dense reading
  - Confidence: 0.84
  - Evidence: self-report plus repeated task deferrals
  - Source type: mixed
  - Last confirmed: 2026-04-07
  - Decay rule: reduce confidence if contradicted for 2 weeks

### Transition Cost

- Pattern: Recovery needed after meeting clusters
  - Trigger: 2 or more consecutive meetings
  - Effect: 20-30 minute decompression needed before deep work
  - Confidence: 0.78
  - Evidence: repeated low-focus reports after meeting-heavy mornings
  - Source type: inferred
  - Last confirmed: 2026-04-04

## Task-Type Compatibility

- Thesis writing
  - Ideal windows: Mon/Tue/Thu 08:00-11:00
  - Avoid: 14:00-16:00, immediately after meetings

- Literature review
  - Ideal windows: late morning, early evening
  - Acceptable windows: post-lunch if meeting load is low

- Admin / errands
  - Ideal windows: 14:00-16:30

- Weekly planning
  - Ideal windows: Sunday evening or weekday 07:30-08:00

## Risk Markers

- Signal: user says "too tired", "brain fog", or "cannot focus"
  - Scheduling meaning: same-day deep work becomes fragile

- Signal: day already has 3 or more commitments
  - Scheduling meaning: spillover risk increases

- Signal: short sleep
  - Scheduling meaning: protect only one high-value win and downgrade the rest

## Agent Policies

- Protect Monday morning thesis block unless a higher-priority commitment exists.
- If a task needs more than 90 minutes of focus, prefer a morning slot with no prior meetings.
- If overload is detected, preserve anchors first and defer low-value flexible tasks.
- When the day breaks, offer:
  - one conservative repair plan
  - one deadline-preserving repair plan

## Open Hypotheses

- Hypothesis: Sunday evening is a strong planning window.
  - Confidence: 0.42
  - Evidence: weak but recurring
  - Action policy: use only if no stronger weekday option exists

## Recent Drift

- Since thesis deadline pressure increased, evening work tolerance has increased.
- Do not convert this into a stable preference unless it persists for at least 2 weeks.

## Update Policy

- Direct user statements override low-confidence inferred beliefs.
- Single-day emotional states do not become durable profile entries by default.
- Inferred beliefs require repeated evidence before becoming agent policy.
- Confidence should decay over time if not reconfirmed.
