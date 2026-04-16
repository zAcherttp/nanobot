# Memory Migration Guidelines — Behavioral Scheduler Adaptation

You are making **minimal, surgical changes** to Nanobot's memory system to support behavioral scheduling. Do not rewrite working logic. Do not rename existing files. Do not change what currently works. Only add what is explicitly described below.

For each file, you will:
1. Read the current file
2. Compare it against the **target shape** described here
3. Apply only the diff — nothing more

---

## 1. `memory/history.jsonl` — Enrich the schema

### What to compare
Read the 5 most recent entries in `history.jsonl`. Check whether any entry contains a `signals` key.

### What change is needed
The Consolidator's extraction prompt (find the prompt string that instructs the LLM what to extract from conversation history before writing a new entry) must gain one additional extraction category.

Append this block to the end of that prompt string, before any closing instruction:

```
Additionally, extract a `signals` object and include it in the JSON entry. Infer:
- `affect`: the user's apparent emotional state (one of: neutral, curious, frustrated, anxious, energized)
- `energy`: apparent energy level (one of: high, medium, low). Infer from language pace, complaint words, brevity.
- `work_hour`: wall-clock hour of the conversation in HH:MM format (24h)
- `stress_markers`: array of short quoted phrases from the conversation that signal pressure or fatigue. Empty array if none.
- `calendar_adjacent`: array of deadlines, meetings, or plans the user mentioned. Empty array if none.

If you cannot infer a field with reasonable confidence, omit it from the signals object rather than guessing.
```

### Target entry shape
```jsonl
{
  "cursor": 42,
  "timestamp": "2026-04-10 23:14",
  "content": "- Decided to use edge functions for auth\n- User prefers dry code style",
  "signals": {
    "affect": "frustrated",
    "energy": "low",
    "work_hour": "23:14",
    "stress_markers": ["I'm behind", "this is exhausting"],
    "calendar_adjacent": ["deadline: Submit thesis tomorrow"]
  }
}
```

### Hard constraints
- Existing entries without `signals` remain valid. Do not backfill them.
- If signals cannot be inferred, write `"signals": {}` rather than omitting the key.
- The JSON schema is additive only. No existing keys are renamed or removed.

---

## 2. `USER.md` — Add confidence-scored behavioral observations

### What to compare
Open the current `USER.md`. Check whether it contains a section called `## Behavioral observations` and a section called `## Confirmed behavioral heuristics`.

### What change is needed
**If both sections are absent:** Add them below the existing content. Do not touch the existing fact lines above.

**If only one is present:** Add the missing one.

**If both are present:** No structural change needed — proceed to Dream prompt changes only.

### Target structure
```markdown
# USER.md

## Stable facts
(all existing content stays here, untouched)

## Behavioral observations
<!-- Dream writes low-confidence patterns here first.
     Format: - <observation> · confidence: low|medium|high · seen: Nx -->

## Confirmed behavioral heuristics
<!-- Dream promotes observations here only when confidence reaches: high.
     Only lines in this section are loaded into the scheduling gatekeeper. -->
```

### Confidence promotion rules (for Dream to follow — see section 4)
- New pattern observed: write to `## Behavioral observations` at `confidence: low · seen: 1x`
- Same pattern seen again: increment `seen:` count
- `seen: 3x` → promote to `confidence: medium`
- `seen: 8x` → promote to `confidence: high` and copy the line into `## Confirmed behavioral heuristics`
- A line stays in `## Behavioral observations` even after promotion — `## Confirmed behavioral heuristics` is a copy, not a move

### Example after Dream has run several times
```markdown
## Behavioral observations
- Works past 22:00 before deadlines · confidence: medium · seen: 4x
- Low energy signals in afternoons · confidence: low · seen: 2x

## Confirmed behavioral heuristics
- Deep work preferred in mornings · confidence: high · seen: 12x
```

### Hard constraints
- Never remove or modify lines in `## Stable facts`
- Never write directly into `## Confirmed behavioral heuristics` during a first observation — always go through `## Behavioral observations` first
- The gatekeeper (scheduler evaluator prompt) must filter USER.md to `## Confirmed behavioral heuristics` only. If you find a place in the code where USER.md is injected into a prompt wholesale, wrap that injection with a filter that extracts only lines under that section heading.

---

## 3. `SOUL.md` — No structural changes

### What to compare
Open `SOUL.md`. Verify it contains only communication style, tone, and language preference content.

### What change is needed
None to the file itself.

The only change: find where `SOUL.md` is loaded into the agent's system prompt and confirm it is **not** being used as a source for behavioral scheduling heuristics. If it is, move those lines to `USER.md ## Stable facts` instead.

---

## 4. `GOALS.md` — New file, prospective memory

### What to compare
Check whether `memory/GOALS.md` or `GOALS.md` exists in the workspace. If it does not exist, create it.

### Target structure
```markdown
# GOALS.md

## Active goals

<!-- Format for each goal:
### <Goal name>
- Deadline: YYYY-MM-DD
- Effort logged: Nh
- Last session: YYYY-MM-DD
- Status: on-track | at-risk | stalled
-->
```

### Status rules Dream must apply
- `on-track`: effort logged is proportional to time elapsed toward deadline
- `at-risk`: deadline within 30 days and no session logged in the past 7 days
- `stalled`: no session logged in 14+ days regardless of deadline

### Hard constraints
- If no goals have been mentioned by the user yet, leave the file with only the template comment
- Do not invent goals. Only create a goal entry when the user has explicitly stated a goal in conversation or history
- Effort is logged in whole hours only. Round down.

---

## 5. Dream — Add a behavioral analysis pass

### What to compare
Find the Dream agent's analyze phase prompt. Check whether it contains any instruction to read `signals` fields from `history.jsonl`, update confidence scores in `USER.md`, or update `GOALS.md`.

### What change is needed
Add a **second reasoning step** to Dream's analyze phase, after the existing fact/decision extraction step. Insert it as a clearly labeled section in the analyze prompt:

```
## Step 2: Behavioral pattern analysis

Read all history.jsonl entries processed in this run that contain a `signals` block.

For each signals block:
- Note the `work_hour`, `affect`, `energy`, and any `stress_markers`
- Look for the same pattern appearing across multiple entries (e.g. low energy at similar hours, stress markers near the same type of deadline)

For each pattern you identify:
- If it does not yet exist in USER.md `## Behavioral observations`: add it at confidence: low · seen: 1x
- If it already exists: increment the seen count and apply the confidence promotion rules
- If a line reaches confidence: high, copy it into `## Confirmed behavioral heuristics`

For each history entry that references work on a goal listed in GOALS.md:
- Increment `Effort logged` by the estimated hours spent (infer from conversation length and topic depth, minimum 0.5h)
- Update `Last session` to the entry's timestamp date
- Recalculate `Status` using the status rules

Do not make any edits to external systems. Do not modify calendar or task data.
```

### Files Dream is now allowed to edit
Confirm the list of files Dream's edit phase has write access to includes:
- `USER.md` ✓ (existing)
- `SOUL.md` ✓ (existing)
- `memory/MEMORY.md` ✓ (existing)
- `GOALS.md` ← **add this**

### Hard constraints
- Dream's behavioral pass runs **after** the existing fact extraction pass, never instead of it
- Dream never writes a behavioral observation with confidence higher than `low` on first occurrence, regardless of how certain the inference seems
- Dream never deletes lines from `## Confirmed behavioral heuristics` — only adds
- Dream never modifies `## Stable facts`

---

## Validation checklist

After making all changes, verify:

- [ ] A new `history.jsonl` entry written after this change contains a `signals` key
- [ ] `USER.md` has both `## Behavioral observations` and `## Confirmed behavioral heuristics` sections
- [ ] `GOALS.md` exists in the workspace
- [ ] Dream's analyze prompt contains the Step 2 behavioral analysis block
- [ ] Dream's allowed-files list includes `GOALS.md`
- [ ] The scheduler gatekeeper/evaluator loads only `## Confirmed behavioral heuristics` from `USER.md`, not the full file
- [ ] `SOUL.md` is unchanged
- [ ] No existing `history.jsonl` entries were modified
- [ ] No existing `USER.md` stable fact lines were modified
