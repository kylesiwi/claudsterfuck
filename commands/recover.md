---
description: Find and finalize orphaned worker runs (dead process but state says running)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" recover --json
```

Scans for runs that claim to be running but whose process has died. Marks them as failed with proper state cleanup.

To also kill alive processes that have been running too long with no output (stalled workers):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" recover --force-stalled --json
```

Use `--force-stalled` when:
- A run shows status `running`, the process is still alive, but the worker has produced no output for longer than the route threshold (120s for most routes)
- `recover` alone returns "No orphaned runs found" but the run is clearly stuck
- Recovering after a session reset left an alive but unresponsive worker behind
