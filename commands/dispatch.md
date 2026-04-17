---
description: Dispatch the active routed turn to its worker provider (returns immediately)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --json
```

This spawns the worker process detached and returns immediately with a run ID.
After dispatch, use `/claudsterfuck:watch` to poll for completion.

Optional flags:
- `--dry-run`: Assembles the worker prompt and prints it without spawning the provider process or creating run state.
