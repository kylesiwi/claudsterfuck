---
description: Show token usage aggregates for the current session + workspace
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" usage --json
```

Reports:
- Current session token totals (runs, input, output, cached)
- Workspace totals across all sessions
- Breakdown by provider (codex, gemini)
- Breakdown by route (implement, design, etc.)

Data source: aggregated from per-run `run.json` files written after each worker completes. Only runs that reported `tokenUsage` contribute to the totals — older runs before v2.5.0 may not be included.
