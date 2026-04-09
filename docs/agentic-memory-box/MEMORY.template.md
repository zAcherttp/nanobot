# MEMORY

Short-term operational memory for immediate scheduling decisions.

## Current Status

- Date: YYYY-MM-DD
- Day mode: normal | overloaded | recovery | travel | deadline-week
- Scheduling confidence: low | medium | high

## Active Temporary Conditions

- Condition:
  - Type: fatigue | running-late | schedule-change | stress | illness | travel | recovery
  - Summary: User is tired after poor sleep.
  - Started: 2026-04-09T07:15:00+07:00
  - Expected duration: today
  - Scheduling impact: Avoid high-focus work before noon.
  - Source: direct-user-statement

- Condition:
  - Type: running-late
  - Summary: User is likely 15-20 minutes late to first meeting.
  - Started: 2026-04-09T08:40:00+07:00
  - Expected duration: 2 hours
  - Scheduling impact: Protect downstream buffers and notify rescheduling logic.
  - Source: inferred-from-context

## Recent Operational Events

- 2026-04-09T08:35:00+07:00
  - Event: Calendar meeting moved from 10:00 to 10:30.
  - Impact: Deep-work block shortened.

- 2026-04-09T11:55:00+07:00
  - Event: User reported low focus after advisor meeting.
  - Impact: Downgrade afternoon thesis block to light editing.

## Today’s Planning Notes

- Preserve one meaningful win even if the day degrades.
- Prefer admin and errand tasks during 14:00-15:30.
- Do not schedule a new 90-minute deep-work block after two meetings.

## Expiry Rules

- Remove or archive conditions after they expire.
- Do not keep temporary complaints here for more than 7 days unless still active.
- `Dream Cycle` may summarize repeated patterns into `USER.md`.
