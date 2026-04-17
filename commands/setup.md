---
description: Check whether the local Codex and Gemini CLIs are available for claudsterfuck routing
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" setup --json
```

Return a short summary of whether Codex and Gemini are available locally.
