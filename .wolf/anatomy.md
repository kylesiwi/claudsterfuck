# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-04-17T00:39:48.799Z
> Files: 67 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `CLAUDE.md` — OpenWolf bootstrap instructions (~57 tok)
- `package.json` — Node.js package manifest (~68 tok)

## .claude-plugin/

- `marketplace.json` (~129 tok)
- `plugin.json` (~82 tok)

## .claude/

- `settings.json` — Claude Code settings (~441 tok)

## .claude/rules/

- `openwolf.md` — OpenWolf rules for Claude Code (~313 tok)

## D:/Users/kylecito/.claude/plans/

- `radiant-mapping-meteor.md` — Devil's Advocate Review: claudsterfuck Rewrite Proposal (~4645 tok)
- `velvet-beaming-ocean.md` — Routing Redesign — Implementation Plan (v1.9.0) (~4832 tok)

## D:/Users/kylecito/.claude/plugins/

- `known_marketplaces.json` (~458 tok)

## D:/Users/kylecito/.claude/projects/C--dev-claudsterfuck/memory/

- `feedback_destructive_config.md` (~259 tok)
- `MEMORY.md` (~37 tok)

## agents/

- `claudsterfuck-codex-worker.md` — Bash shape (~361 tok)
- `claudsterfuck-gemini-worker.md` — Bash shape (~362 tok)

## commands/

- `adversarial-review.md` (~62 tok)
- `cancel.md` (~178 tok)
- `chat.md` (~52 tok)
- `debug.md` (~52 tok)
- `delegate.md` (~68 tok)
- `design.md` (~53 tok)
- `dispatch.md` (~99 tok)
- `implement-artifact.md` (~62 tok)
- `implement.md` (~55 tok)
- `inspect.md` (~201 tok)
- `plan.md` (~52 tok)
- `recover.md` (~226 tok)
- `reroute.md` (~96 tok)
- `reset.md` (~68 tok)
- `result.md` (~97 tok)
- `review-feedback.md` (~60 tok)
- `review.md` (~53 tok)
- `setup.md` (~82 tok)
- `status.md` (~72 tok)
- `task.md` (~73 tok)
- `watch.md` (~107 tok)

## hooks/

- `hooks.json` — Hook definitions for SessionStart, UserPromptSubmit, PreToolUse, Stop (~314 tok)

## prompts/providers/codex/

- `worker-base.md` — Codex Worker Task (~262 tok)

## prompts/providers/gemini/

- `worker-base.md` — Gemini Worker Task (~297 tok)

## routes/

- `adversarial-review.json` (~261 tok)
- `debug.json` (~275 tok)
- `design.json` (~251 tok)
- `implement-artifact.json` (~370 tok)
- `implement.json` (~277 tok)
- `plan.json` (~226 tok)
- `review-feedback.json` (~237 tok)
- `review.json` (~246 tok)

## scripts/

- `monitor.mjs` — monitor.mjs — Live worker status window for claudsterfuck (~1567 tok)
- `openwolf-compat.mjs` — OpenWolf compatibility CLI: compiles memory packets (~400 tok)
- `orchestrator.mjs` — orchestrator.mjs - Dispatch+Poll execution model for claudsterfuck (~18923 tok)
- `orchestrator.test.mjs` — Unit + integration tests for orchestrator.mjs hardening: (~5146 tok)
- `pre-tool-use-hook.mjs` — PreToolUse hook: enforces delegation policy based on turn phase (~241 tok)
- `session-start-hook.mjs` — SessionStart hook: binds session ID, initializes session record (~200 tok)
- `stop-enforcement-hook.mjs` — Stop hook: blocks premature stops on routed turns (~269 tok)
- `user-prompt-submit-hook.mjs` — UserPromptSubmit hook: route classification, turn state, reviewDepth propagation, dispatch shortcut hint (~6600 tok)

## scripts/lib/

- `entrypoint.mjs` — isDirectExecution helper for ESM main-module detection (~100 tok)
- `hook-io.mjs` — Hook I/O helpers: readHookInput, emitHookJson, appendEnvVar, SESSION_ID_ENV (~175 tok)
- `policy.mjs` — PreToolUse + Stop policy engine with tiered context injection (minimal for read-only, full for denials) (~3300 tok)
- `prompt-compiler.mjs` — Prompt Compiler - Always-on Lite compression for worker handoff (~1467 tok)
- `providers.mjs` — Resolve the native codex.exe binary from the platform-specific optional package bundled (~5029 tok)
- `providers.test.mjs` — createSpawnStub: testCodexEmptyOutputFails, testCodexWriteRouteEmptyOutputSucceeds, testGeminiEmptyO (~1278 tok)
- `state.mjs` — State management v4: atomic JSON writes, JSONL audit trail, session/turn/run CRUD, dispatch+poll helpers (~3800 tok)
- `string-utils.mjs` — Named export: truncate(str, maxLen) — shortens string with "..." suffix (~20 tok)
- `string-utils.test.mjs` — node:assert tests for truncate: short, exact, and over-length cases (~30 tok)

## scripts/lib/openwolf/

- `compile-packet.mjs` — --- Memory Distillation: Source-level classification --- (~2430 tok)

## scripts/routing/

- `assemble-worker-prompt.mjs` — Exports assembleWorkerPrompt (~1922 tok)
- `classify-turn.mjs` — Exports ROUTE_RULES, scoreRoutes, classifyCandidates, classifyTurn (~2329 tok)

## scripts/routing/lib/

- `config.mjs` — Route/framework/prompt file resolution: loadRouteProfile, routeExists, etc. (~400 tok)

## skills/claudsterfuck-routing/

- `SKILL.md` — Claudsterfuck Routing (~1436 tok)
