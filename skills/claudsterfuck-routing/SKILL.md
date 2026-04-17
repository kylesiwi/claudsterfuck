---
name: claudsterfuck-routing
description: Control-plane skill for Claude Code when claudsterfuck is active. Use it to stay in planner/reviewer mode, delegate through the worker runtime, and synthesize results without implementing directly in the main thread.
---

# Claudsterfuck Routing

Use this skill when the claudsterfuck plugin is active for the current repository.

Core stance:

- Claude is the control plane.
- Codex and Gemini are the execution plane.
- The main Claude thread plans, routes, reviews, and synthesizes.
- The main Claude thread does not implement directly when a routed worker turn is active.

## Operating Loop

1. Read route, provider, phase, and status from the hook context injected by `UserPromptSubmit`. Do NOT call `inspect` unless hook context is missing or you are debugging state issues.
2. Craft a concrete, unambiguous objective for the worker. If the user's message was conversational, a meta-instruction, or a route confirmation rather than a direct coding task, translate it into a precise task statement here.
3. **State the objective in your response before delegating** — always write something like:
   > "Delegating to Codex with objective: 'Create `scripts/lib/math-utils.mjs` exporting `multiply(a, b)` and `divide(a, b)` with a divide-by-zero guard.' Full assembled prompt will be at: `[run artifacts path]/prompt.md` (run ID in dispatch result)."
   This makes Claude's inference output auditable and ensures the token cost of step 2 actually reaches the worker.
4. Delegate by passing the objective as the **agent prompt** to the worker. The worker will forward it via `--objective`. Example:
   ```
   Agent(claudsterfuck-codex-worker, prompt="Create `scripts/lib/math-utils.mjs` exporting...")
   ```
5. When the worker completes, the agent returns the final result JSON. Apply the review depth from the hook context to it (see Review Standard below).
6. If the result is weak, delegate again with a tighter objective.
7. Only stop once a completed worker result exists and the review is done.

**Objective quality bar:** The objective passed to the worker must be self-contained — Codex or Gemini should be able to execute it with no further context from this conversation. If the objective requires background that only exists in this thread, include it inline.

## Worker Choice

- `design`, `plan`, `review`, and `adversarial-review` default to Gemini.
- `implement`, `debug`, and `review-feedback` default to Codex.
- `implement-artifact` defaults to Codex. Use it instead of `implement` when the task is likely to produce a large standalone output file — a full HTML page, a complete dashboard, a self-contained mockup, or any single generated file that would likely exceed ~30 KB. Codex returns the file as an artifact in its JSON response; the runner writes it to disk via Node.js, bypassing the Windows command-line length limit that breaks Codex's internal patch tools for large files.
- Follow the route default unless there is an explicit reason to override it.

## Delegation Paths

Preferred:

- `claudsterfuck-codex-worker`
- `claudsterfuck-gemini-worker`

Direct orchestrator (combined dispatch+watch):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json
```

This dispatches and immediately polls in one command, returning the final result. No separate `watch` call needed.

Fallback (separate dispatch then watch):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" watch --json
```

Diagnostics (use only when debugging state):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" inspect --slim --json
```

## Main-Thread Constraints

- Do not use `Read`, `Grep`, `Glob`, `WebFetch`, or `WebSearch` before the worker handoff on a routed turn.
- Do not use `Write`, `Edit`, or `MultiEdit` directly on a routed turn.
- After worker completion, review is allowed; implementation is still delegated.

## Recovery Procedures

When a worker appears stuck or cancel fails:

**Cancel by run ID** (use when turn state is missing or was reset):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" cancel --run-id <run-id> --json
```

**Force-recover stalled alive processes** (use when recover alone returns "No orphaned runs found"):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" recover --force-stalled --json
```

Decision tree:
1. Try plain `cancel` first.
2. If "No current routed turn" → use `cancel --run-id <id>` (get ID from `inspect --slim`).
3. If process is alive but producing no output → use `recover --force-stalled`.
4. If everything is clean but state is confused → use `reset`.

## Review Standard

The hook context includes a `Review depth` field. Follow it:

### `verify` (review, adversarial-review, review-feedback)
- Workers include code snippets as evidence in their output.
- Spot-check 1-2 critical claims by grepping the cited file:line.
- Do NOT re-read every referenced file. Trust evidence that includes specific line numbers and code.
- Focus your review on: did the worker miss anything obvious? Is the verdict well-reasoned?

### `test` (implement, debug, implement-artifact)
- Run `git diff --stat` and/or `npm test` / build commands to verify the change works.
- Do NOT re-read changed files line-by-line unless tests fail or the diff looks suspicious.
- Focus your review on: does it compile? Do tests pass? Is the scope correct?

### `trust` (plan, design)
- Present the worker output directly to the user with light editorial synthesis.
- Skip verification reads. The output is advisory, not code — the user will review it.
- Focus your review on: is the output coherent and actionable?
