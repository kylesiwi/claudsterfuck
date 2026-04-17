---
description: Cancel the current routed turn or a specific worker run by ID
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" cancel --json
```

To cancel a specific run by ID (works even when the active turn has been reset or is missing):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" cancel --run-id <run-id> --json
```

Use `--run-id` when:
- A run is stuck and `cancel` alone returns "No current routed turn is stored"
- The turn was reset but the worker process may still be alive
- You know the run ID from `inspect` or from a previous dispatch result

Return the structured cancel response concisely.
