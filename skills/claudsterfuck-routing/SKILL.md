---
name: claudsterfuck-routing
description: Control-plane skill for Claude Code when claudsterfuck is active. Use it to stay in planner/reviewer mode, delegate through the orchestrator, and synthesize results without implementing directly in the main thread.
---

# Claudsterfuck Routing

Use this skill when the claudsterfuck plugin is active for the current repository.

Core stance:

- Claude is the control plane.
- Codex and Gemini are the execution plane.
- The main Claude thread plans, routes, reviews, and synthesizes.
- The main Claude thread does not implement directly when a routed worker turn is active.
- **`chat` is the universal fallback.** Only `high`-confidence classification (2+ strong signals, or a single strong signal in the first 3 or last 5 words) auto-delegates. Everything else lands in `chat` and Claude asks the user to confirm intent before delegating.
- **`claude` is the explicit bypass.** Never auto-routed. Full permissions, no framework packs. Use when you need unrestricted Claude interaction.

## Operating Loop

1. Read route, provider, phase, and status from the hook context injected by `UserPromptSubmit`. Do NOT call `inspect` unless hook context is missing or you are debugging state issues.
2. Craft a concrete, unambiguous objective for the worker. If the user's message was conversational, a meta-instruction, or a route confirmation rather than a direct coding task, translate it into a precise task statement here.
3. **State the objective in your response before delegating** — always write something like:
   > "Delegating to Codex with objective: 'Create `scripts/lib/math-utils.mjs` exporting `multiply(a, b)` and `divide(a, b)` with a divide-by-zero guard.' The orchestrator assembles the full prompt at `[run artifacts path]/prompt.md`."
   This makes Claude's inference output auditable and ensures the token cost of step 2 actually reaches the worker.
4. Dispatch directly via the Bash tool:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json --objective 'YOUR OBJECTIVE HERE'
   ```
   Use single quotes around the objective; escape any literal single quotes as `'\''`. If the turn already has a stored objective and you don't need to refine it, omit `--objective` to use the stored value.
5. The `--watch` flag blocks until the worker completes and returns the final result as JSON. Apply the review depth from the hook context (see Review Standard below).
6. If the result is weak, dispatch again with a tighter objective.
7. Only stop once a completed worker result exists and the review is done.

**Objective quality bar:** The objective passed to the orchestrator must be self-contained — Codex or Gemini should be able to execute it with no further context from this conversation. If the objective requires background that only exists in this thread, include it inline.

**Why direct Bash dispatch (v2.0):** Previous versions spawned a subagent wrapper that called the orchestrator via Bash. Subagents do not inherit runtime-granted Bash permissions from the parent session, so the wrapper frequently stalled on permission prompts. Direct Bash from the main thread uses already-granted permissions and eliminates the stuck-forwarder failure mode.

## Route Reference

- `chat` — non-delegated, read-only fallback. Write tools blocked. Default for low-confidence and question-like prompts. Stores the objective so a bare `route:implement` (no text) on the next message carries it forward automatically.
- `claude` — non-delegated, full permissions. Explicit bypass only. Never auto-routed.

## Provider Choice

- `design`, `plan`, `review`, and `adversarial-review` default to Gemini.
- `implement`, `debug`, and `review-feedback` default to Codex.
- `implement-artifact` defaults to Codex. Use it instead of `implement` when the task is likely to produce a large standalone output file — a full HTML page, a complete dashboard, a self-contained mockup, or any single generated file that would likely exceed ~30 KB. Codex returns the file as an artifact in its JSON response; the orchestrator writes it to disk via Node.js, bypassing the Windows command-line length limit that breaks Codex's internal patch tools for large files.
- Follow the route default unless there is an explicit reason to override it.

## Dispatch Commands

Primary (combined dispatch+poll in one call):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json --objective 'refined objective text'
```

Fallback (separate dispatch then poll — rarely needed):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" watch --json
```

Diagnostics (use only when debugging state):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" inspect --slim --json
```

## Main-Thread Constraints

- Do not use `Read`, `Grep`, `Glob`, `WebFetch`, or `WebSearch` before dispatch on a routed turn.
- Do not use `Write`, `Edit`, or `MultiEdit` directly on a routed turn.
- Do not spawn subagents via the `Agent` tool on a routed turn — dispatch directly via Bash.
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
