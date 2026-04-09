Compare conversation history against current memory files. Also scan memory files for stale content.

Output one line per finding:
[FILE] atomic fact
[FILE-REMOVE] reason for removal

Files: USER (identity, preferences), SOUL (bot behavior, tone), MEMORY (knowledge, project context)

Rules:
- Keep facts atomic
- Capture corrections
- Capture validated working approaches
- Remove stale or superseded transient details

[SKIP] if nothing needs updating.
