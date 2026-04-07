# Thesis Goal: The Personalized Agentic Scheduler
*Pivoting from basic task management to deeply personalized behavioral scheduling.*

Since **Google Calendar** and **Google Tasks** will act as the native databases for *what* is happening, the Nanobot memory system doesn’t need to hold deterministic schedules. Instead, its job is to understand **how and why** you work. 

The Memory System must evolve from a generic fact-store into a **Behavioral Profiler and Gatekeeper** that respects your consent. Here is how we modify the architecture to achieve those specific, personalized perks:

## 1. Repurpose `USER.md` into a Strict Behavioral Profile
Currently, `USER.md` passively holds random facts about the user. We must strictify it to hold explicit scheduling heuristics.
* **The Upgrade:** The `Dream` cron job uses a specialized prompt to extract *Work/Rest Patterns*, *Energy Levels*, and *Habits*.
* **Example `USER.md` Schema:**
  * `Core Hours`: 09:00 - 17:00
  * `High Energy Block`: Mornings (Prefers deep work).
  * `Low Energy Block`: 14:00 - 16:00 (Prefers admin tasks or rest).
  * `Burnout Signals`: Skipping lunch, complaints of tiredness in chat.
* **The Perk:** When you say *"Schedule a 2-hour brainstorming meeting tomorrow afternoon,"* the agent intercepts it, reads `USER.md`, and counters: *"You usually have low energy in the afternoons. Since brainstorming requires high energy, should I suggest 10 AM instead?"*

## 2. Interceptive Agentic Scheduling (The Gatekeeper)
Instead of blindly translating user text to Google APIs, the agent acts as a proactive filter.
* **The Upgrade:** Wrap the Google Calendar/Tasks tool calls within an evaluation step that cross-references `MEMORY.md` and `USER.md`.
* **The Perk (Work-Rest Balance):** If you try to schedule a meeting at 7 PM, the agent checks your work hours and recent activity. *"I see you've had 6 hours of meetings today already. Scheduling this at 7 PM violates your work-life balance rules. Are you sure, or should I draft an email to reschedule for tomorrow?"*

## 3. Contextual Memory (Text & Image)
Since you plan to leverage multimodal inputs, memory shouldn't just be text facts. *(Voice support deferred to future iterations).*
* **The Upgrade:** When processing text messages or images (e.g., sending a picture of a messy desk or a whiteboard full of tasks), the agent extracts *State of Mind*. 
* **The Perk:** If you upload an image of a daunting to-do list alongside a text saying "Just throw this into my tasks, I'm exhausted," the agent logs `[User State: Highly Fatigued]` into the short-term `history.jsonl`. The agent then responds: *"I notice you're feeling exhausted. Should I set the due dates for these tasks to next week instead of tomorrow to protect your capacity?"* (Always requesting confirmation).

## 4. `Dream` as a Weekly Balance Auditor
Currently, `Dream` just edits text files to keep them small. We will repurpose it to act as a proactive health and schedule auditor.
* **The Upgrade:** Build a specific `Dream` tool called `analyze_calendar_health`. Once a week (e.g., Sunday night), `Dream` aggregates your `history.jsonl` sentiment with your Google Calendar history.
* **The Perk:** The agent proactively messages you: *"Weekly Audit: You worked past 7 PM three times this week and skipped your scheduled deep-work blocks. I recommend clearing your Tuesday morning schedule to allow recovery. Do you approve?"* (Never autonomously shaking up the calendar).

## 5. Integrating `SOUL.md` for Priority Alignment & Effort Tracking
Your long-term goals live in `SOUL.md` (e.g., "Master Rust", "Spend more time with family"). We will architect this to track "efforts" and completion context.
* **The Upgrade (Goal Architecture):** `SOUL.md` will strictly link goals with clear deadlines and track `efforts`—the time you or the agent actively spent progressing towards the goal. Whenever the agent interacts with Google Tasks, it runs a priority check against these tracked efforts.
* **The Perk:** *"I see 15 administrative items on your Google Tasks today, but you have no time assigned for your 'Master Rust' goal. We have put in 12 hours of effort towards this deadline so far, and it's due next month. I recommend time-blocking 45 minutes at 11 AM today to ensure you stay on track. Should I add this to your Calendar?"* (Proactively reminding you of paid efforts while asking for consent).

## 6. State Reconciliation & Diff Insights (Handling Offline & Manual Edits)
Because this is a self-hosted assistant, there will be periods where it is offline, or where the user heavily modifies Google Calendar/Tasks manually via mobile apps. The agent must flawlessly sync external state changes without burning context limits.
* **The Upgrade (Boot-Up Catch-up):** Upon initialization, the agent fetches a delta (`syncToken` in Google Calendar API) of what changed while it was offline. Instead of loading the full updated calendar, it generates an internal "Diff Insight" notification (e.g., `[SYSTEM]: User deleted meeting "Sync" at 9AM and added "Doctor" at 2PM`). 
* **The Upgrade (On-Demand Active Catch-Up):** When the user sends a vague message like: *"I have just configured my task, catch up on the changes"*, the LLM invokes a specific `get_calendar_diff` tool. Rather than pulling yesterday's schedule and today's schedule and comparing them via brute-force using LLM tokens, the underlying tool calculates the exact unified diff programmaticially. 
* **The Perk:** The tool returns heavily token-optimized insights back to the LLM (e.g., `Diff Results: Task 'Update Thesis' deadline shifted from Tuesday -> Friday.`). The agent then seamlessly replies: *"I see you pushed the Thesis Update to Friday! I've updated my efforts tracker in SOUL.md to reflect this new runway."* 

## 7. Zero-Latency Telegram Streaming (`sendMessageDraft`)
Since Telegram is going to be the absolute primary first-class interface, the standard legacy polling message edit loop degrades the conversational illusion.
* **The Upgrade:** Migrate the `send_delta` streaming logic inside `telegram.py` away from the throttled `bot.edit_message_text` to the modern `sendMessageDraft` token-by-token API. 
* **The Perk:** Rather than seeing text chunks pop in every 0.6 seconds, the LLM's thought process and response generation will cleanly stream character-by-character native to the Telegram client.

---

## Technical Next Steps
We now have a comprehensive blueprint for the thesis architecture spanning Behavioral Memory (`USER.md`/`SOUL.md`), Differential Logic (Token syncing), and Native Channel optimization (`sendMessageDraft`).

If you are ready to begin execution on any of these phases, let me know where to start!
