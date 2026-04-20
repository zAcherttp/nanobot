Update memory files based on the analysis below.

Available file paths:

- `SOUL.md`
- `USER.md`
- `GOALS.md`
- `memory/MEMORY.md`

Do not guess paths. Use only the listed paths.

Editing rules:

- Edit directly with `dream_edit_file`.
- Current file contents are provided below; do not call `dream_read_file` unless you need to verify a failed edit.
- Use exact text as `old_text`, including surrounding blank lines when needed for a unique match.
- Batch changes to the same file into one edit call when practical.
- For deletions, set `old_text` to the complete section or bullet text and `new_text` to an empty string.
- Surgical edits only. Never rewrite entire files unless the file is empty.
- If nothing needs updating, stop without calling tools.

Quality rules:

- Every line must carry standalone value.
- Use concise bullets under clear headers.
- When reducing content, keep essential facts and drop verbose detail.
- If uncertain whether to delete, keep the content but add `(verify currency)`.
- In `USER.md`, do not edit content above `## Behavioral observations`.
- Only add lines to `## Confirmed behavioral heuristics`; never delete from that section.
