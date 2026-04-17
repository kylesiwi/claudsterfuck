---
description: Verify claudsterfuck prerequisites — Codex CLI, Gemini CLI, and provider availability
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" setup --json
```

Return a summary covering:
- Whether Codex CLI is available and which binary was resolved
- Whether Gemini CLI is available
- Any missing prerequisites the user should install

If either CLI is missing, remind the user of the requirement:
- Codex: install via `npm install -g @openai/codex` and set `OPENAI_API_KEY`
- Gemini: install via `npm install -g @google/gemini-cli` and set `GEMINI_API_KEY`

Also confirm OpenWolf is active — if `.wolf/OPENWOLF.md` exists in the project root, OpenWolf is present.
