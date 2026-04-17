---
description: Show a deep snapshot of claudsterfuck internals (sessions, routed turn, latest run artifacts, transcript previews)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

This command is strictly read-only diagnostics.

- Never use `Write`, `Edit`, or `MultiEdit`.
- Never modify any `.wolf/*` file while running inspect.
- Do not alter OpenWolf bookkeeping from this command path.

Run (prefer `--slim` to minimize token cost):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" inspect --slim --json
```

Use `--slim` for routine status checks — it returns route/provider/phase/status/runId without full artifact content. Use the full form (no `--slim`) only when you need artifact previews or deep run history.

Return a concise summary plus key IDs and paths.
