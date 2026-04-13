## The central reframe

Before any chunking, you need to settle the thesis's philosophical claim: **a calendar is the shadow of a life.** Managing it is a behavioral problem, not a logistics problem. Google Calendar already knows *what* is happening. The agent's entire value proposition is knowing *how and why you work*—and using that knowledge to protect you from yourself when you try to schedule against your own biology or values.

This one sentence dissolves a lot of vagueness in the current plan: the agent isn't a smarter calendar interface, it's a **cognitive prosthetic**. That framing demands a proper cognitive science foundation.

---

## The anchor framework: ACT-R

The best established cognitive architecture to model this from is **ACT-R** (Adaptive Control of Thought-Rational), developed by John Anderson from the 1980s onward. ACT-R describes human cognition as a set of interacting modules:

A **perceptual buffer** decodes raw sensory input. A **goal buffer** (working memory) holds the active problem. **Declarative memory** stores facts as retrievable chunks. **Procedural memory** stores if-then production rules that govern behavior. A **central executive** mediates competition between modules to produce action.

Most AI assistants implement only two of these: a perceptual buffer (input parsing) and a procedural memory (tool definitions). This thesis's contribution is implementing the full stack—especially the layered declarative memory—which is what makes personalization actually possible.The clickable boxes drill into each memory type for further exploration.

---

## Chunk 1: Memory architecture — Tulving's taxonomy

The most important theoretical decision in this thesis is recognizing that **declarative memory is not flat.** Endel Tulving's 1972 distinction between memory types is what separates a naive fact-store from a behavioral profiler.

**Episodic memory** (history.jsonl) records specific events anchored in time with their emotional and contextual tags. "User sent three messages after 11 PM on a Tuesday, all of them mentioning 'deadline'" is an episodic record. The agent doesn't interpret it yet—it just faithfully records *that it happened, when, and in what affective context*. The key design requirement that flows from this: episodic entries need timestamps, inferred affect signals (from language), and links to whatever calendar events were relevant at that moment.

**Semantic memory** (USER.md) is *knowledge extracted from repeated episodes*. It's what Dream consolidates episodic events into: "User exhibits deadline-anxiety behavior after 8 PM when a deliverable is within 72 hours." This is a behavioral heuristic, not a specific memory. The critical constraint: semantic memory should never be hand-authored. It must emerge from episodic evidence. A USER.md field you write yourself is just a preference list; one that Dream extracted from 30 days of history.jsonl is a behavioral model.

**Prospective memory** (SOUL.md) is memory about future intentions—what you plan to do, not what you know. This is a genuinely distinct cognitive category that most systems collapse into tasks. Its special property is that it carries *effort context*: "I intend to master Rust" is not a task, it's an identity claim with a trajectory. The effort tracking in SOUL.md is the agent maintaining awareness of how far along that trajectory you are, which is exactly what intrinsic motivation research says you need to sustain long-term goals.

**Procedural memory** (tool adapters, evaluator.md, prompt templates) is how-to knowledge. In humans this is mostly unconscious and fast. In the agent, it's explicit but should be treated as stable infrastructure—the layer you change least often.

---

## Chunk 2: Behavioral profiling — chronobiology

The USER.md schema (core hours, high/low energy blocks, burnout signals) needs scientific grounding, not just intuition. That comes from **chronobiology**.

Two levels of rhythm are relevant. The first is circadian rhythms—the ~24-hour biological clock governing cortisol, alertness, and body temperature. The user's "chronotype" (Horne & Östberg, 1976) determines whether they are a morning type or evening type, and this is fairly stable. The agent should *learn* the user's chronotype from episodic patterns rather than asking for it, because most people don't accurately self-report.

The second level is **ultradian rhythms**, ~90-minute cycles of alertness that occur throughout the waking day (Kleitman, who also discovered REM sleep, observed these). This is why the "High Energy Block" in your plan shouldn't be modeled as a vague time-of-day preference but as a set of discrete windows. A 90-minute deep work block is not arbitrary productivity advice—it matches the ultradian cycle almost exactly.

The **Yerkes-Dodson law** grounds the burnout signal detection: performance is an inverted U-function of arousal. Over-arousal (too many stressors) degrades performance just as severely as under-arousal, but it feels like productivity because you're *doing a lot*. When the agent detects skipped meals, messages at unusual hours, and complaint language co-occurring with a packed calendar, it's detecting over-arousal—which predicts performance degradation even when the user thinks they're grinding productively.

---

## Chunk 3: The gatekeeper — Self-Determination Theory

The consent-first architecture ("should I add this to your calendar?") is not just a UX nicety. It's grounded in **Self-Determination Theory** (Deci & Ryan, 1985), which is one of the most replicated frameworks in behavioral psychology.

SDT identifies a spectrum of motivation regulation: from external (doing it because of pressure) to introjected (guilt-driven) to identified (rationally endorsed) to integrated (fully aligned with identity). Research consistently shows that higher autonomy on this spectrum produces better sustained behavior, lower burnout, and higher subjective wellbeing.

This has a direct architectural implication: an agent that schedules things *for you* trains you into external regulation, which undermines intrinsic motivation over time. An agent that presents proposals and requests consent keeps you in identified or integrated regulation. The proposal bundle system in `scheduler_autonomy.md` is—whether you knew it or not—an implementation of SDT's autonomy support principle.

The deeper design principle: when the agent invokes SOUL.md to say "this task connects to your goal of mastering Rust," it's not just adding context. It's helping you move from identified to integrated regulation—connecting external calendar events to your internal value system. That's the most behaviorally powerful thing the agent can do.

---

## Chunk 4: The Dream process — memory consolidation theory

The "Dream" cron job has a theoretical twin in sleep science. **Memory consolidation during sleep** (Walker's research is the accessible entry point; the deeper theory comes from McClelland et al.'s complementary learning systems, 1995) works as follows: during NREM sleep, the hippocampus replays the day's episodic memories in compressed form. The neocortex gradually extracts statistical regularities—patterns that appear across many episodes—and stores them as semantic knowledge. This process also clears working memory for the next day.

Dream does exactly this. It reads history.jsonl (hippocampal replay), extracts behavioral patterns into USER.md (neocortical semantic extraction), and trims the log (working memory clearing). The dashed arrow on the left side of the diagram above shows this consolidation path—Dream reads episodic, writes back to semantic.

This parallel is not just a metaphor. It's a structural argument you can make in the thesis: the architecture derives from how biological memory actually works. The "weekly audit" function (analyzing calendar health and flagging overwork patterns) maps to what sleep researchers call **emotional memory processing**—the brain's recontextualizing of stressful events during REM sleep to reduce their emotional charge.

---

## Chunk 5: The reflection loop — implementation intentions

The phase-end reflection mechanism in `scheduler_autonomy.md` maps to **implementation intention theory** (Gollwitzer, 1999). Gollwitzer showed that abstract goal intentions ("I want to exercise more") rarely change behavior, but specific if-then plans ("if it is Monday at 7 AM, I will go for a run") produce dramatically higher follow-through rates. The mechanism is that the situation cue (Monday morning) becomes automatically linked to the behavior in memory, reducing the need for willpower.

The reflection loop trains exactly these if-then associations. By asking at phase-end "did you complete your deep work block this morning?"—and logging the response—the agent is both measuring and reinforcing the implementation intention. The confidence-scored working-hour signals in `scheduler_autonomy.md` are a Bayesian version of this: repeated confirmation of the same behavioral pattern strengthens the agent's model of when those cue-response links are active.

---

## The synthesis: what the thesis claims

You can now state the thesis with precision. You're not building a scheduling tool. You're exploring whether an LLM-based agent can instantiate the full Tulving memory taxonomy—with a chronobiology-informed behavioral layer extracted from episodic evidence, a consent architecture grounded in SDT's autonomy continuum, and a consolidation mechanism that parallels the hippocampal-neocortical memory system—and whether that produces meaningfully better scheduling behavior than existing tools.

The three things that need rigorous exploration to make this work are: (1) how episodic affect signals should be extracted and represented, since the quality of semantic consolidation depends entirely on what Dream has to work with; (2) the confidence threshold at which a low-confidence habit observation becomes a hard behavioral heuristic, since premature promotion creates false models; and (3) how the proposal bundle system actually affects user autonomy perception over time—which is the thesis's most interesting empirical question and the one most worth designing an evaluation around.

Each of those three is a chunk you can model further when you're ready.