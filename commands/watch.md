---
description: Poll a running worker dispatch until completion or timeout
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" watch --json
```

Polls the latest running dispatch. Returns the result if completed, or a progress snapshot if still running.
Repeat until the run completes. Each call is bounded to ~600 seconds (10 min) by default.
