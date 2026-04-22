# Provider Rewrite Tracker

Last updated: 2026-04-19

## Slice Summary

- Python behavior reviewed for this slice:
  - provider config supports `api_key`, `api_base`, and optional headers
  - config values can reference environment variables via `${VAR}`
  - runtime provider construction validates missing credentials for API-key flows
  - OAuth login commands exist for Python-only providers
- Explicitly kept in TS for this slice:
  - real provider config in `config.json`
  - `${VAR}` environment resolution during config load
  - runtime auth precedence: config first, provider env fallback second
  - optional model `apiBase` and `headers` overrides
- Explicitly removed in TS for this slice:
  - provider OAuth/login CLI stub
  - Python-style provider class registry clone

## Decisions Locked

- Provider config is TS-first and generic, keyed by provider name
- Runtime continues to use `pi-ai` built-in providers and model objects
- `providers.<name>.apiKey` overrides env-based API key resolution
- `providers.<name>.apiBase` and `headers` override the model object, not the CLI
- No standalone provider CLI surface remains until a non-stubbed workflow exists

## Progress

| Area | Status | Notes |
| --- | --- | --- |
| Provider config shape | Done for this slice | Generic `providers` map in config |
| Env placeholder resolution | Done for this slice | `${VAR}` values resolve during config load |
| Runtime auth resolution | Done for this slice | Config API key first, `pi-ai` env fallback second |
| Runtime model overrides | Done for this slice | `apiBase` and `headers` can override built-in models |
| CLI login stub | Removed | No fake provider login command remains |

## Next Targets

1. Decide whether TS needs custom OpenAI-compatible providers beyond `pi-ai` built-ins.
2. Revisit provider UX only if a real interactive auth flow is added later.
3. Keep provider changes aligned with any future gateway streaming/policy slice.
