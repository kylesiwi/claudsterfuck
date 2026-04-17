---
description: Run a silent cross-provider review of the latest completed worker output
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" second-opinion --json
```

Takes the most recent completed worker run in the current turn, re-derives a review objective, and dispatches it to the opposite-family provider (Codex → Gemini, Gemini → Codex) silently.

Returns both the original output and the second-opinion output. Present them side-by-side to the user so they can see where the two models agree and disagree.

The original turn is restored after completion — the second-opinion does not replace your active work.
