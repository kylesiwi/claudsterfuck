---
description: Alias for dispatch; send the active routed turn to its worker
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --json
```

Return the dispatch result concisely.
