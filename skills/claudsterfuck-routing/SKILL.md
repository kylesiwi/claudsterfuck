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

## Crafting the Objective (few-shot examples)

The objective you pass to the worker is where token efficiency lives or dies. The worker already receives a memory packet containing `.wolf/anatomy.md` (the file-by-file map), `.wolf/cerebrum.md` (conventions and preferences), and `.wolf/buglog.json` (known bugs) via the route's `defaultMemoryPlan`. **You do not need to pre-digest source code to give the worker context** — the worker reads source files itself.

### Objective-writing checklist

Before dispatching, your objective should answer:

1. **What outcome** does the user want? State it in one sentence.
2. **Where** should the work happen? A file path, a module name, or "find it" if the anatomy map lists it.
3. **Constraints** the worker might miss? Test expectations, naming conventions from cerebrum, backward-compatibility needs, inline snippets the user supplied.

If answering 1–3 requires you to read source code files, **stop — you are about to pre-solve the task.** The worker will read the files. Name the file path or module from anatomy and let the worker explore.

### Few-shot 1: "refactor the user service"

❌ **Don't do this** (Claude pre-solves → wastes tokens):

1. Grep for `UserService` → finds `src/services/user.ts`
2. Read `src/services/user.ts` (347 lines) → ~2,800 tokens
3. Read `src/services/user.test.ts` (412 lines) → ~3,300 tokens
4. Write a detailed objective quoting line numbers and proposing line-by-line changes

Total Claude cost: ~7,000 tokens. The worker then re-reads the same files to verify and implement. Claude did the work Codex was supposed to do.

✅ **Instead do this** (delegate discovery → efficient):

1. Glance at `.wolf/cerebrum.md` for DI conventions (allowed — memory, not source).
2. Write the objective:
   > "Refactor the user service to use dependency injection per our DI convention in cerebrum.md. The anatomy map shows where the service lives and who its callers are. Maintain test coverage."
3. Dispatch.

Total Claude cost: ~400 tokens. The worker explores the anatomy, reads the relevant source, and implements.

### Few-shot 2: "fix the failing payment webhook test"

❌ **Don't do this:**

1. Glob for `*payment*webhook*` test files.
2. Read the test to see what it asserts.
3. Read the production code it exercises.
4. Write an objective that proposes the fix Claude already figured out.

✅ **Instead do this:**

> "Investigate and fix the failing payment webhook test. The anatomy map points to the relevant files. Root-cause first: confirm whether the test or the production code is wrong before patching. TDD discipline: write a failing test for the true behavior if you change production code."

The worker reads, diagnoses, and fixes. Your job is to state the outcome and the discipline — not to identify the bug yourself.

### Few-shot 3: user supplies a specific symptom inline

User prompt: *"The `isValid` check in the auth middleware returns false for inputs with trailing whitespace. Please fix."*

✅ **Correct:**

> "The `isValid` check in the auth middleware incorrectly rejects inputs with trailing whitespace. Fix the validator to trim before checking. Add a unit test covering the trailing-whitespace case. The anatomy map points to the middleware file."

The user already gave you the symptom and the module (auth middleware). Pass it through. Do **not** read the auth middleware to "confirm" the function name — the worker will find `isValid` in the file and fix it.

### Few-shot 4: user asks for a new feature in a specific file

User prompt: *"Add a retry wrapper around the fetch calls in src/api/client.ts — exponential backoff, max 3 retries."*

✅ **Correct:**

> "Add an exponential-backoff retry wrapper around the fetch calls in `src/api/client.ts`. Max 3 retries with jittered delays. Honor existing error-handling patterns in the file (see cerebrum for our error-handling convention). Add tests for the retry path."

You passed the file path verbatim from the user. You passed the constraints they stated. You deferred "existing error-handling patterns" to the worker + cerebrum. You did not open `src/api/client.ts`.

### When you MAY read before dispatching

Reads to `.wolf/*` files are **allowed** during REFINING:

- `.wolf/anatomy.md` — the file map. A quick glance to confirm a module exists or to find a file path to put in the objective.
- `.wolf/cerebrum.md` — conventions, user preferences, do-not-repeat list.
- `.wolf/buglog.json` — known bugs and their fixes (avoid re-introducing).
- `.wolf/memory.md` — recent session activity.

Reads to **source files** (`src/`, `scripts/`, `lib/`, etc.) during REFINING are an anti-pattern and are blocked by policy. If you catch yourself grep'ing `src/` to understand a task, stop: you are pre-solving. Write a shorter objective instead and trust the worker.

If the user genuinely wants Claude to inspect source (rare), they should pick the right route:

- **route:chat** — discussion/clarification, Claude answers with read access but no writes.
- **route:claude** — unrestricted Claude with full tool access and no framework discipline.

Both of those are escape hatches from delegated workflow, not part of it.

## Route Reference

- `chat` — non-delegated, read-only fallback. Write tools blocked. Default for low-confidence and question-like prompts. Stores the objective so a bare `route:implement` (no text) on the next message carries it forward automatically.
- `claude` — non-delegated, full permissions. Explicit bypass only. Never auto-routed.
- `enrichmemory` — housekeeping route. Runs `scripts/enrich-anatomy.mjs` to refresh the corpus-enrichment sidecar (`.wolf/anatomy.enriched.md`). Non-delegated; Claude runs the CLI and reports back. Invoke via `/claudsterfuck:enrichmemory` or `route:enrichmemory`. The `UserPromptSubmit` hook surfaces a reminder in `additionalContext` when >10 anatomy files have retrieval-weak vanilla descriptions, and auto-runs the enrichment in background when only a handful (≤10) are unenriched.
- `monitor` — housekeeping route. Opens the persistent per-session monitor window (`scripts/monitor-daemon.mjs`). Idempotent — safe to re-run. Invoke via `/claudsterfuck:monitor` or `route:monitor`. The daemon rotates between idle / enriching / dispatch / reviewing views based on current activity; no per-run popups appear from dispatch or enrichment.

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

## Long-Running Dispatches

If `dispatch --watch --json` takes more than ~4 minutes, the user benefits from a quick liveness check. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" watch --heartbeat --json
```

Returns a minimal payload (~100 tokens):
```json
{
  "runId": "codex-abc",
  "status": "running",
  "alive": true,
  "silentSeconds": 12,
  "eventCount": 47,
  "lastEventType": "item.started",
  "lastEventLabel": "exec: npm test"
}
```

Decision rules:
- `alive:false` → worker process died. Run `recover` and report failure to user.
- `silentSeconds > 120` → worker is hung. Tell the user and offer to `cancel`.
- Otherwise → worker is making progress. Re-enter `watch` (or continue waiting).

Do **not** run heartbeat checks more than once per ~4 minutes — the statusline third line already covers continuous progress visibility for the user.

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
