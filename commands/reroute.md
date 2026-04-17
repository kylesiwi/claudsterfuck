---
description: Change the current routed turn to a different route while preserving the original objective
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Ask the user which route to switch to if they did not specify one.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" reroute --route <route> --json
```

Return the reroute result concisely.
