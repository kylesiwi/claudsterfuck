---
description: Poll a running worker dispatch until completion or timeout
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" watch --json
```

Polls the latest running dispatch. Returns the result if completed, or fails the run if the worker exceeds the watch timeout.
Each call is bounded to ~720 seconds (12 min) by default.
