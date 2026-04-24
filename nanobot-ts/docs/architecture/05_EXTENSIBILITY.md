# Extensibility: Providers, Tools, and Skills

To keep the agent modular, all interfaces to LLM models, API actions, and behavioral rulesets are implemented as injected dependencies rather than hardcoded core logic.

## 1. Providers (`src/providers/runtime.ts`)

Nanobot abstracts the concept of a "Model Provider" using the generic `@mariozechner/pi-ai` upstream library. 
- **API Definition**: An app specifies `provider: "openrouter"` and `modelId: "anthropic/claude-3-opus"`.
- **Resolution**: `resolveProviderModel()` maps these strings to concrete provider API interfaces, resolving API keys from dot-env configurations or `.nanobot` config files automatically.
- **Why it matters**: The `GatewayRuntime` and `Agent` loops do not care if they are talking to a local `Ollama` instance or `OpenAI`. They simply invoke `model.generate()` or `model.stream()`.

## 2. Tools (`src/tools/`)

Tools are functions the LLM can call during execution.
- Defined as standard standard definitions (e.g., `zod` parameter schemas).
- Passed generically as an array to `createSessionAgent(tools)`.
- During execution, the LLM emits a `ToolCall` hook. The `Agent Loop` catches it, executes the javascript function defined by the tool, blocks downstream execution until the Promise resolves, and feeds the `ToolResult` back to the LLM.

### Dynamic Scoping
In Nanobot, tools aren't global. They are scoped per-agent. The Gateway calls a function `getTools({ sessionKey, message })` to dynamically resolve which tools a specific user is allowed to access. An admin channel might get `shell_execute` while a random Telegram user only gets `search_web`.

## 3. Skills (`src/skills/`)

Skills (or Plugins) are groupings of System Instructions (`prompt.ts`) and Tools.
- In `config/schema.ts`, a user might declare `skills: ["calendar", "memory"]`.
- The agent loop reads this array and dynamically imports/loads the corresponding prompt templates and tool closures.
- **Rule of Thumb**: A Tool is a physical action (`create_calendar_event()`). A Skill is a conceptual capability (The "Calendar Scheduler" skill includes the `create` tool, the `delete` tool, and the system prompt explaining *how* to use them).

## Porting Considerations for Miniclaws (Python)

When building an intuitive rewrite of this structure:
1. **Schema Generation**: Python's `Pydantic` and `Instructor` or the built-in `typing` modules are incredible at automatically generating OpenAI compatible JSON schemas for tools directly from Python function signatures. Leverage this heavily so you don't have to write raw JSON schemas.
2. **Provider Abstraction**: Use the official `openai` Python package, but configure the `base_url` to point at whatever provider you are using (OpenRouter, Ollama) since almost all providers support the OpenAI API standard shape now. Avoid writing custom HTTP handlers for Anthropic/Google if a unified bridge exists.
3. **Pluggable Architecture**: Rather than hardcoding tool arrays, define a `Protocol` or `ABC` for a `Skill`. When the Python app starts up, use a simple module registry or `pkgutil.iter_modules()` to automatically discover and load all Python files in a `skills/` directory.
