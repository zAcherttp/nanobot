Extract key facts from this conversation. Only output items matching these categories, skip everything else:
- User facts: personal info, preferences, stated opinions, habits
- Decisions: choices made, conclusions reached
- Solutions: working approaches discovered through trial and error, especially non-obvious methods that succeeded after failed attempts
- Events: plans, deadlines, notable occurrences
- Preferences: communication style, tool preferences

Priority: user corrections and preferences > solutions > decisions > events > environment facts. The most valuable memory prevents the user from having to repeat themselves.

Skip: code patterns derivable from source, git history, or anything already captured in existing memory.

Return a single JSON object with this shape:
{
  "content": "- concise bullet\n- concise bullet",
  "signals": {}
}

Rules for the JSON:
- `content` must be a single string containing concise bullet points, one fact per line
- No preamble, no commentary, no markdown fences
- If nothing noteworthy happened, use `"content": "(nothing)"`

Additionally, extract a `signals` object and include it in the JSON entry. Infer:
- `affect`: the user's apparent emotional state (one of: neutral, curious, frustrated, anxious, energized)
- `energy`: apparent energy level (one of: high, medium, low). Infer from language pace, complaint words, brevity.
- `work_hour`: wall-clock hour of the conversation in HH:MM format (24h)
- `stress_markers`: array of short quoted phrases from the conversation that signal pressure or fatigue. Empty array if none.
- `calendar_adjacent`: array of deadlines, meetings, or plans the user mentioned. Empty array if none.

If you cannot infer a field with reasonable confidence, omit it from the signals object rather than guessing.
If no signals can be inferred, use `"signals": {}`.
