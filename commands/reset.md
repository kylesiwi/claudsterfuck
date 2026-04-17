---
description: Clear the current routed turn without deleting stored run artifacts
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" reset --json
```

Return the reset result concisely.
