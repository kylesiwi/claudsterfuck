---
description: Dispatch the active routed turn to its configured worker via orchestrator dispatch
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --json
```

Return the dispatch result concisely.
