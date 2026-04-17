---
description: Show the latest worker result for the current routed turn
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" result --json
```

Return only the normalized worker result envelope concisely. Do not expand raw provider stats or stderr unless the user explicitly asks for debugging details.
