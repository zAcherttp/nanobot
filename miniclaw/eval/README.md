# Eval

Scenarios live in [`eval/scenarios`](E:/Web/.tauri/nanobot/miniclaw/eval/scenarios).

Run from [`miniclaw`](E:/Web/.tauri/nanobot/miniclaw):

```powershell
pnpm dev eval run
```

Run one scenario by id:

```powershell
pnpm dev eval run <scenario-id>
```

Useful options:

```powershell
pnpm dev eval run --mode simulate
pnpm dev eval run --mode sandbox-live
pnpm dev eval run --output-dir .\eval-reports
pnpm dev eval run --safe-window-start 2026-06-01T00:00:00.000Z --safe-window-end 2026-06-30T23:59:59.000Z
```

Read the latest summary:

```powershell
pnpm dev eval summary
```

Defaults:

- Scenarios load from `eval/scenarios`.
- Reports write to `eval-reports` unless overridden by CLI or config.
