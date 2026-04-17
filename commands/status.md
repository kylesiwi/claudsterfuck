---
description: Show the current routed-turn status for the claudsterfuck worker runtime
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" status --json
```

Return the status summary in a concise way.
