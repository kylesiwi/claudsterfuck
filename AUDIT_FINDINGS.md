# claudsterfuck — Audit Findings

**Version audited:** 2.5.0
**Date:** 2026-04-17
**Auditor:** Claude (Opus 4.7, max effort)
**Scope:** Full plugin audit against stated mission, with focus on token efficiency, second-opinion utility, UX clarity, and telemetry/visibility during long-running tasks.

---

## Executive Summary

The plugin is **well-engineered at the infrastructure layer** and **mission-aligned at the philosophy layer**, but **has meaningful UX friction at the top of the funnel** (routing classifier) and **telemetry gaps for the single most painful user moment** (the 5–10 minute worker wait).

**Overall verdict:** 🟢 Ships the core value. 🟡 Several specific frictions prevent it from feeling effortless.

Top three findings by impact:

1. **The routing classifier is too strict for natural prompts.** Common implementation asks like "refactor the user service", "fix the payment webhook", "write the backend for X" all score `low` and fall to chat, forcing users to learn `route:X` overrides or slash commands. The safety net works (chat mode asks the user to confirm), but each fallback adds a conversation turn.
2. **The main Claude thread still inferences meaningfully per turn.** Hook context injects ~250 tokens per routed turn on top of SKILL.md (~1800 tokens, loaded per session). The biggest leak is Claude's objective-refinement step, which can unintentionally pre-solve the task — the SKILL.md discourages it but policy doesn't enforce it.
3. **Long-running tasks are poorly observable from inside the main Claude thread.** The statusline third line and monitor window give the *user* live visibility, but **Claude sees nothing mid-run** because Claude Code's Bash tool buffers stdout until the command exits. If a worker hangs at minute 6 of 10, Claude can't notice, narrate, or intervene until Bash returns.

Secondary findings (discussed in detail below) cover second-opinion routing, recovery UX, and framework-pack cost.

---

## 1. Mission Assessment

The stated mission:

> Users delegate tasks to other LLMs to save tokens and get second opinions from frontier models with different training. Claude is the "big brain" control plane; workers do the menial execution without Claude burning inference tokens on boilerplate. Main Claude inferences as little as needed, never "builds the whole project then tells Codex to implement it verbatim." Offload inferencing to workers whenever possible.

### How the plugin realizes this

| Mission requirement | How it's implemented | Verdict |
|---|---|---|
| Delegate to other LLMs | `runCodexTask` / `runGeminiTask` spawn detached CLIs; orchestrator returns structured results | 🟢 Works |
| Save tokens | Main-thread policy forbids Write/Edit/MultiEdit on routed turns; worker-contract framework forbids the worker from silent scope expansion | 🟢 Structural, enforced |
| Second opinions from different frontier models | Routes split: Gemini owns design/plan/review/adversarial-review; Codex owns implement/debug/review-feedback. `adversarial-review` explicitly runs Gemini against Codex's output | 🟢 Architecturally supported |
| Claude = big brain | SKILL.md "Core stance" section says so four times; policy.mjs backs it with enforcement | 🟢 Stance is clear |
| Workers do menial tasks | Each route ships framework packs that constrain scope, forbid overbuilding (YAGNI), and mandate verification evidence | 🟢 Contract is explicit |
| Claude inferences as little as needed | Hook policy blocks Claude from running Write/Edit/Agent before dispatch; framework packs push work to the worker | 🟡 Partially — see Finding 2 |
| Offload inferencing to workers | Worker prompt includes memory packet (anatomy, cerebrum, buglog) so the worker has project context without Claude pre-digesting it | 🟢 Memory packet is a real offload |
| Avoid "Claude builds whole project, tells Codex to transcribe" | SKILL.md warns against it; policy blocks main-thread writes; framework packs discourage it on both sides | 🟡 Discouraged, not prevented |

**Net assessment:** The architecture is correctly shaped for the mission. The remaining gaps are behavioral (how Claude actually plays the role) rather than structural.

---

## 2. Strengths

### 2.1 Control/execution split is clean and enforced

The two-plane model is rigorous:
- `policy.mjs` denies `Write`/`Edit`/`MultiEdit` on routed turns (except `.wolf/*` bookkeeping)
- `Agent` tool is denied entirely on routed turns (v2.0 decision — collapses subagents)
- Arbitrary `Bash` is denied except companion commands (orchestrator.*) and verification commands (git/npm test/etc.) in the REVIEWING phase
- Non-routed turns (`chat`, `claude`) have their own rules (chat denies writes; claude allows everything)

This prevents accidental drift: Claude cannot implement on a routed turn even if instructed to try.

### 2.2 Framework-pack discipline on the worker side

Every routed worker prompt bakes in:
- YAGNI ("build only what the task needs; don't add generalized options")
- Worker contract ("implement exactly the scoped task; ask for clarification; do not silently expand scope")
- Verification-before-completion ("no completion claim without fresh verification evidence; agent reports are not proof")
- Review-specific frameworks (blind-spots, AI-blind-spots, pre-mortem, steelman-and-verdict)

These are short, imperative, and wired into every run. The `prompts/providers/<name>/worker-base.md` template uses `<!-- IMMUTABLE -->` markers to preserve them through Lite compression.

### 2.3 v2.0 dispatch collapse was the right call

The pre-v2.0 subagent wrapper was fragile (permission inheritance failures). Direct Bash dispatch from the main thread eliminates an entire failure class. The v2.0 commit landed this cleanly, with comprehensive tests and migration of docs.

### 2.4 v2.1 native NDJSON streaming is correctly scoped

Both CLIs have native streaming modes (`codex exec --json`, `gemini --output-format stream-json`). The shared `event-stream.mjs` module parses both formats and emits a canonical `events.jsonl` per run plus a compact `latest-event.json` for UI consumers. The design correctly resists the temptation to stream events *back to Claude* (since Bash buffers anyway), keeping telemetry cost off Claude's context.

### 2.5 State and audit trail are serious

- Atomic JSON writes (write-temp + rename)
- JSONL audit trail for every state mutation (session-created, turn-created, run-started, run-completed, state-saved)
- Per-run directory with prompt.md, stdout.raw.txt, stderr.raw.txt, events.jsonl, latest-event.json, result.normalized.json, process.json
- Workspace isolation (`${slug}-${sha256(canonicalCwd).slice(0,16)}`)

Debugging a stuck run has real forensic material to work with.

### 2.6 Recovery procedures are documented

`SKILL.md` has a recovery decision tree: try `cancel` first, then `cancel --run-id X`, then `recover --force-stalled`, then `reset`. The flags and their trade-offs are explained.

---

## 3. Weaknesses — Findings & Evidence

### Finding 1 — Routing classifier is too strict for natural prompts 🔴 High impact

**Evidence (live classifier runs):**

| Prompt | Route | Confidence | Score | Outcome |
|---|---|---|---|---|
| `write the backend for a CSV import feature with tests` | chat | low | 0 | Falls to chat fallback |
| `refactor the user service` | implement | low | 2 | Falls to chat fallback |
| `fix the failing payment webhook test` | debug | low | 1 | Falls to chat fallback |
| `I noticed the auth middleware is broken after the migration` | debug | low | 2 | Falls to chat fallback |
| `the CI is red` | chat | low | 0 | Falls to chat fallback |
| `check if my migration plan is safe` | plan | low | 2 | Falls to chat fallback |
| `add a retry wrapper around the fetch calls in src/api/client.ts` | implement | low | 1 | Falls to chat fallback |

**Root cause:** Confidence thresholds require `strongCount >= 2` or `score >= 6`. Single-word weak signals like "refactor", "broken", "plan", "add" score 1–2 points. "write" isn't even in the weak signal list. The strong-signal list favors very specific phrases ("write code", "implement this", "retry logic") that normal humans don't type.

**Why it matters:** Every low-confidence prompt triggers the chat fallback, which:
1. Appends the classified-route hint to Claude's context (helpful)
2. Asks Claude to confirm the route with the user (extra turn)
3. User replies `route:implement` (extra turn)
4. Plugin now delegates

That's a 2-turn cost for every natural-language prompt that the classifier couldn't confidently bucket. Over a normal session, this adds up.

**Counterpoint:** The strict threshold is defensible if the false-positive cost of auto-delegating on ambiguous intent is high. Delegating a vague prompt to a worker wastes a worker run + Claude review.

**The real trade-off:** Where does the friction belong — on pre-delegation confirmation, or on post-delegation retry? Right now the plugin chose "pre" (chat fallback confirmation). The user-message feedback suggests "pre" friction is felt more.

### Finding 2 — Pre-delegation inferencing is not bounded 🟡 Medium impact

The SKILL.md operating loop says:

> Step 2: Craft a concrete, unambiguous objective for the worker.
> Step 3: State the objective in your response before delegating.

This is necessary — workers need refined objectives. But:

- Claude MAY read files before delegation (policy.mjs explicitly allows context tools in REFINING phase — `return allow("Read-only context gathering is allowed before delegation.", ...)`).
- SKILL.md's main-thread constraint says "Do not use Read, Grep, Glob, WebFetch, or WebSearch before dispatch on a routed turn."
- **The two conflict.** Policy allows reading; SKILL.md forbids it. A Claude that follows the policy (the stricter enforcer) will read files; a Claude that follows SKILL.md won't.

**Evidence:** `scripts/lib/policy.mjs:280-284` allows `isContextTool` (Read/Glob/Grep/WebSearch/WebFetch) in REFINING phase. `skills/claudsterfuck-routing/SKILL.md:75` forbids the same tools.

**Consequence:** If Claude reads 3 files to understand the codebase before delegating, that's ~5K–15K tokens of context into the main thread. Then Claude crafts a detailed objective (often containing snippets, constraints, or paraphrases of what it read) and hands off. The worker now gets both the memory packet AND Claude's digested summary — but Claude paid for the digestion.

This is exactly the "Claude pre-solves and tells Codex to transcribe" anti-pattern the user mentioned.

### Finding 3 — Claude cannot observe long-running workers 🔴 High impact for debugging

**The architecture:**
- Main Claude runs `Bash(orchestrator.mjs dispatch --watch --json)`
- Bash tool buffers stdout until the command exits
- Watch loop runs up to 10 minutes (`DEFAULT_WATCH_TIMEOUT_SECONDS = 600`)
- If the worker stalls, Claude doesn't know until the timeout

**The v2.1 telemetry (statusline + monitor) lives entirely external to Claude's context:**
- Statusline third line: visible to the user in the Claude Code UI; Claude doesn't see it
- Monitor window: visible in a separate terminal; Claude doesn't see it
- events.jsonl / latest-event.json: on disk, readable by Claude only *after* dispatch returns

**What Claude sees when a worker stalls:**
1. Bash has been running for N seconds
2. Eventually returns either `status:"completed"` or `status:"running"` + `watchTimeoutReached:true` (if 10 min elapses)
3. If watchTimeoutReached, Claude must call `watch` again to keep polling

**Missing signals:**
- No way for Claude to inspect run progress *during* the 10-minute wait without aborting the turn
- No mid-run cancel path that doesn't kill the session
- The monitor window can be invisible (if `--no-monitor` is set, or if the user simply isn't looking at it)
- If the user isn't at the terminal, they have zero visibility until Bash returns

**What works today:** The user can run `/claudsterfuck:watch --json` in a *different* Claude Code session to poll progress. But that's a workaround, not a feature.

### Finding 4 — Hook context is injected every turn, not cached 🟡 Medium impact

`buildDelegatedContext` injects 9 lines (~250 tokens) on every user message that lands on a routed turn. Over a 10-turn conversation that's 2500+ tokens of repeated framing.

**Example:**
```
[claudsterfuck] Route this turn through the worker runtime.
Classified route: implement
Route confidence: override
Default worker provider: codex
Write mode: worker-write
Review depth: test (run tests/build to verify, skip line-by-line code review)
Required framework packs: implementation/worker-contract.md, implementation/tdd.md, ...
Route lock behavior: one active turn maps to one route/provider at a time.
If you need the next phase in another route, ask the user to reroute explicitly.
No-text reroute preserves the objective, e.g. /claudsterfuck:implement
Dispatch shortcut: use 'dispatch --watch --json' to dispatch and poll in a single command.
Main-thread rule: plan, delegate, review, and synthesize. Do not implement directly in Claude's main thread.
```

Much of this is static (the last ~4 lines repeat every turn). Compressing or caching would be nice but is a minor optimization.

### Finding 5 — Classifier edge cases are not gracefully handled 🟡 Medium impact

Several short natural prompts produce confusing behavior:

- `"yes"` / `"okay now do it"` → chat, no existing-turn continuation signal. If the user just approved a design and expected delegation to start, nothing happens.
- `"use the recommended approach"` → design, low confidence. Should chain onto the previous route, not re-route.
- `"the CI is red"` → chat, score 0. Clear debug intent, but no signals match.
- `"route:design the new payment gateway"` → design via override, but the classifier alone scores it low (it only sees "design" as a weak signal).

The `shouldContinueExistingTurn` logic in `user-prompt-submit-hook.mjs:424` catches *some* of these by continuing an active turn when confidence is low, but the behavior is subtle and not obviously visible to the user.

### Finding 6 — Second-opinion utility is partially realized 🟡 Medium impact

Mission: get second opinions from different frontier models.

What works:
- `design` (Gemini) → `implement` (Codex) is a natural handoff
- `adversarial-review` (Gemini) explicitly critiques something Codex produced

What's absent:
- No "consensus" route that dispatches the same objective to both providers and surfaces disagreement
- No "second-opinion" route that re-runs an implementation through the other provider
- `review` (Gemini reviews Codex output) requires the user to explicitly reroute; not automatic after implement

This might be fine — power users can sequence routes manually. But it's not a one-step second-opinion flow.

### Finding 7 — No cost/quota telemetry 🟡 Medium impact

`tokenUsage` is now persisted per run (v2.5.0). But there's no:
- Session-level aggregate ("you've used 45K tokens across 5 runs today")
- Provider-specific quota warning
- Running estimated $ spend across runs
- Per-route token efficiency comparison ("design routes avg 3K tokens, implement routes avg 12K")

The data exists in `run.json` files under `${CLAUDE_PLUGIN_DATA}/state/<workspace>/runs/`. Exposing it via `/claudsterfuck:usage` or adding aggregates to `/claudsterfuck:status` would make cost discipline first-class.

### Finding 8 — Monitor window UX is undiscoverable 🟡 Medium impact

The monitor terminal opens automatically on dispatch (unless `--no-monitor`). But:
- No README or SKILL.md screenshot of what it looks like
- No explanation that *this* is the primary live-visibility channel
- Users on Windows may see a flash of a terminal that they dismiss as noise
- If the user is running Claude Code in a cloud IDE or remote terminal, the monitor window may not render at all

The statusline third line partially compensates but is ephemeral.

### Finding 9 — Recovery path requires prior knowledge 🟡 Medium impact

When things break, the user needs to know:
- Run IDs are hex-suffixed (`codex-4f629e80`)
- `cancel --run-id X` exists
- `recover --force-stalled` exists
- The difference between stale-process recovery and alive-but-hung recovery

None of this surfaces proactively. If a worker is stuck at minute 9, the plugin doesn't tell Claude "try `recover --force-stalled`" — Claude has to remember that tree from the SKILL.md or guess.

### Finding 10 — Framework packs don't adapt to objective scope 🟢 Low impact

Every `implement` route ships 5 framework packs (worker-contract, tdd, testing-anti-patterns, yagni, verification-before-completion) totaling ~1300 chars. For a 2-line bugfix, that's overhead. For a large feature, it's fine.

Routes have no scope-sensitive framework selection. Small fixes pay the same framework-pack tax as greenfield implementations.

---

## Status (post-audit interventions — v2.6.0)

| # | Intervention | Status |
|---|---|---|
| R1 | Soften classifier (generous verbs + first-word boost + dominance) | ✅ Shipped v2.6.0 |
| R2 | Source-read denial with `.wolf/*` whitelist | ✅ Shipped v2.6.0 (policy + SKILL.md few-shots) |
| R3 | Heartbeat endpoint (`watch --heartbeat`, ~50 tokens) | ✅ Shipped v2.6.0 |
| R4 | Escape-hatches line in hook context | ✅ Shipped v2.6.0 |
| R5 | `/claudsterfuck:usage` command | ✅ Shipped v2.6.0 |
| R6 | Continue-turn delegated to Claude (prior-context injection) | ✅ Shipped v2.6.0 |
| R7 | README demo GIF | ⏳ Deferred (requires human recording) |
| R8 | Scope-adaptive framework packs | ⏳ Deferred (low-impact, high-effort) |
| R9 | `/claudsterfuck:second-opinion` route | ✅ Shipped v2.6.0 |

## 4. Concrete Recommendations (ranked by impact)

### R1 — Soften the classifier confidence gate (or expand signals) 🔴 High impact, low effort

The simplest win:

**Option A — Lower the threshold for `medium` to auto-delegate when the top candidate has clear dominance:**
```js
// Currently: only high auto-delegates
if (classification.confidence !== "high" && classification.confidence !== "override")
  → chat fallback

// Proposed: medium with strong dominance also auto-delegates
if (confidence === "medium" &&
    top.score - runnerUp.score >= 3 &&
    top.strongCount >= 1)
  → auto-delegate with a soft warning in the hook context
```

**Option B — Expand weak signals to cover common verbs:**
- Add to `implement`: "write", "make", "add ... to", "modify", "update"
- Add to `debug`: "fix", "broken", "not working", "issue with"
- Add to `plan`: "outline", "steps to", "approach for"

**Option C — Boost positional scoring when the head word is a clear action verb:**
```js
const VERB_HEAD_BOOST = {
  "implement": ["write", "build", "add", "create", "refactor", "make"],
  "debug": ["fix", "debug", "investigate"],
  "plan": ["plan", "outline"]
};
```

Recommended: ship A + B together. They compound (more weak-signal matches → more medium confidence → more auto-delegates), but the safety net (chat fallback for truly ambiguous cases) remains.

Ship with telemetry: track the rate of auto-delegation vs chat fallback and tune over a week.

### R2 — Close the pre-delegation source-reading leak (distinguish memory from source) 🔴 High impact, medium effort

The real anti-pattern is not "Claude reads anything before delegation" — it's "Claude reads **source code** to pre-digest the task, then hands a pre-solved plan to the worker." OpenWolf already provides the structured-memory mechanism that solves the legitimate context need. This revised R2 leans on it instead of blanket-blocking reads.

#### Context flow today

```
User prompt → Claude (main thread)
                ↓ (crafts objective)
              Bash(orchestrator dispatch)
                ↓
              assembleWorkerPrompt():
                ├── Worker system prompt
                ├── Objective (what Claude refined)
                ├── MEMORY PACKET ← compileMemoryPacket() pulls:
                │     • .wolf/anatomy.md  (file-by-file map)
                │     • .wolf/cerebrum.md (conventions, DNR list)
                │     • .wolf/buglog.json (known bugs)
                │   per the route's defaultMemoryPlan
                ├── Framework packs
                └── Output contract
                ↓
              Worker (Codex/Gemini) ← has anatomy, reads source itself
```

The worker already gets the anatomy + cerebrum. **Claude does not need to pre-read source to give the worker context** — the memory packet ships that context directly.

#### What Claude needs to know pre-delegation

| Context Claude needs | Where it lives | File read needed? |
|---|---|---|
| What the user wants | User's prompt | No |
| Project conventions / preferred patterns | `.wolf/cerebrum.md` | Yes — memory file |
| Known bugs / gotchas | `.wolf/buglog.json` | Yes — memory file |
| What files exist (name + 2–3 line summary) | `.wolf/anatomy.md` | Yes — memory file |
| The actual source code | `src/**/*` | **No** — the worker reads it |
| Route constraints / framework packs | Hook context | No |

Claude needs memory, not source. The policy should allow memory reads and deny source reads during REFINING.

#### Proposed policy change

Introduce a sibling to the existing `resolveOpenWolfWritableTarget` helper that accepts any file under `.wolf/` (not just the 4 writeable bookkeeping files):

```js
// In policy.mjs
function resolveOpenWolfReadableTarget(toolName, toolInput, cwd) {
  if (!isContextTool(toolName)) return null;
  const targetPath = resolveToolTargetPath(toolInput);
  if (!targetPath) return null;
  const workspaceRoot = path.resolve(cwd || process.cwd());
  const wolfRoot = path.resolve(workspaceRoot, ".wolf");
  const resolved = path.resolve(workspaceRoot, targetPath);
  const rel = path.relative(wolfRoot, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return { relativePath: `.wolf/${rel}`.replace(/\\/g, "/") };
}

// REFINING / READY_TO_DELEGATE branch
if ([TURN_PHASES.REFINING, TURN_PHASES.READY_TO_DELEGATE].includes(phase)) {
  if (openWolfTarget) {
    return allow(`Allowed routed OpenWolf maintenance write: ${openWolfTarget.relativePath}.`, routedContext);
  }
  if (isContextTool(toolName)) {
    const memRead = resolveOpenWolfReadableTarget(toolName, toolInput, cwd);
    if (memRead) {
      return allow(
        `Allowed memory read: ${memRead.relativePath}. OpenWolf files give you project context without paying source-reading tokens.`,
        routedContext
      );
    }
    return deny(
      "Source-code reads are blocked before dispatch on routed turns. The worker receives the .wolf/anatomy.md + .wolf/cerebrum.md memory packet and reads source files itself. Include any specific file paths in --objective and let the worker explore. Use route:claude if you need unrestricted source access.",
      routedContext
    );
  }
  if (isWriteTool) { return deny(/* unchanged */); }
  return null;
}
```

For `Grep` and `Glob` the check is the same (target `.wolf/` paths allowed, source paths denied). `WebFetch` and `WebSearch` don't touch the workspace — they can stay blocked in REFINING since the worker can web-fetch too.

#### Paired SKILL.md guidance (shipped alongside)

Policy alone is a blunt hammer. The SKILL.md needs explicit few-shot examples so Claude internalizes the pattern:

1. An "Objective-Writing Checklist" section with 3 questions Claude must answer before dispatching.
2. Three few-shot examples showing bad vs good objective crafting for common scenarios (refactor request, failing-test bug report, specific-symptom bug report).
3. A "when you may read before dispatching" callout listing the allowed `.wolf/*` files and noting that source reads signal a pre-solving anti-pattern.

The SKILL.md additions are live in `skills/claudsterfuck-routing/SKILL.md` in the same commit that ships this R2.

#### Why this is better than the original R2

- **Memory remains accessible.** Anatomy, cerebrum, buglog, and memory stay readable — Claude can honor project conventions, avoid known bugs, and resolve file paths before delegating.
- **Source stays delegated.** The worker does its own source exploration, which is what we want.
- **The escape hatch is preserved.** `route:claude` still lets users opt into unrestricted Claude when the task genuinely needs it.
- **The error message teaches.** When Claude hits the deny, the reason string tells it exactly what to do instead (include paths in `--objective`, let the worker explore).

Combined with R1 (soften classifier) and the SKILL.md few-shots, this is the single highest-leverage mission-alignment change.

### R3 — Add mid-run progress surfacing to Claude via `--watch` NDJSON stream-through 🟠 High impact, medium effort

Currently `--stream` on `watch` is implemented (orchestrator.mjs:1653-1663) but not wired to the default dispatch path. The reason it was unwired in v1.8 was that Bash buffers stdout.

But: **the user doesn't need real-time token deltas.** They need to know:
- Worker is alive and doing something (not hung)
- Approximate progress (items completed, tools used)
- If the worker goes silent for 60+ seconds, Claude should notice

**Proposal:** Write a heartbeat file (`heartbeat.json`) per run that the watch loop updates every 2s. The file contains `{ lastEventAt, eventsSinceLast, alive }`. Expose a `--heartbeat-check` flag on `watch` that returns quickly with the heartbeat snapshot.

Then: have the SKILL.md instruct Claude to periodically run `watch --heartbeat-check --json` if `dispatch --watch` is taking longer than expected. This lets Claude proactively check on long-running workers without aborting the turn.

Alternative (simpler): extend the existing `tailStdoutForEvents` function to also write a `progress.json` with `{ eventsCount, lastEventType, silentSeconds }`. Claude can be instructed to call `inspect --slim --json` partway through a long dispatch.

### R4 — Expand hook context with a "what the user can do next" section 🟡 Medium impact, low effort

Today's hook context is one-directional (tells Claude what to do). Add a brief user-oriented section Claude can relay:

```
User next steps (relay as needed):
- Interrupt the worker: /claudsterfuck:cancel
- Reroute to another provider: /claudsterfuck:plan (preserves objective)
- Inspect progress: open the monitor window (should be visible)
- Switch to free chat: route:chat <your question>
```

Claude can paste this when the user seems lost.

### R5 — Add `/claudsterfuck:usage` with session/run aggregates 🟡 Medium impact, low effort

Read all run.json files in the workspace's runs/ directory, aggregate:
- Total tokens by provider
- Total runs by route
- Avg tokens per route
- Estimated cost (with configurable per-provider rates)

Surface in `/claudsterfuck:status` as a summary line.

### R6 — Make `route:continue` / "yes let's do it" work intuitively 🟡 Medium impact, medium effort

Add a dedicated `continue` route (or extend existing turn-continuation logic) so phrases like "yes do it", "okay proceed", "let's start", "sounds good, implement" auto-continue an existing turn's stored objective. Today the behavior is hidden in `shouldContinueExistingTurn` and only fires on specific phrasings.

### R7 — Ship a 30-second demo GIF in README 🟢 Low impact, low effort

Users who read the README don't see the statusline or monitor window until they install. A recorded GIF showing:
- User types a prompt
- Statusline third line updates live
- Monitor window shows structured events
- Claude synthesizes the worker result

Would dramatically improve first-run comprehension.

### R8 — Scope-adaptive framework packs 🟢 Low impact, high effort

Not urgent. But: a small objective (<200 chars) could ship a trimmed framework set. A large objective (>2000 chars) could ship the full set. This is a token-efficiency optimization that requires careful tuning.

### R9 — Add a `second-opinion` route 🟢 Low impact, medium effort

Route that takes the previous route's finalOutput and dispatches it to the other provider for review. Explicitly wires up the cross-provider second-opinion flow the mission mentions.

```
/claudsterfuck:second-opinion
```

Pulls `currentTurn.workerRuns[0].finalOutput`, builds a review objective, dispatches to the opposite-family provider (Gemini if last was Codex, and vice versa).

---

## 5. Risk Assessment

### Non-trivial risks not covered by existing safeguards

1. **Silent model drift on the router.** If a provider CLI changes its NDJSON event schema (Codex adds `item.progress`, Gemini renames `delta` to `incremental`), the event pipeline degrades silently. No schema version check exists today. → Add a version probe on `setup` that checks event schema compatibility.

2. **Workspace state corruption during concurrent dispatches.** Two parallel sessions in the same workspace would race on `state.json`. The atomic-write pattern handles rename atomicity but not reader-visible ordering. → Not seen in testing but theoretically possible with very active multi-session use. Document as a known constraint or add a lockfile.

3. **Prompt injection via worker output.** A worker could emit stdout that looks like an event/command and confuse downstream tooling. The current parser is tolerant (skips unparseable lines) but doesn't sanitize. → Low risk; workers are OAuth-authenticated CLIs, not adversarial. Worth noting.

4. **Windows-specific permission prompts on native binary resolution.** The `resolveCodexNativeBinary` path walks into `AppData` and assumes npm global install. If the user installed Codex via pnpm / bun / a custom location, resolution fails and falls back to PowerShell shim. The fallback is slower and flashes a console window. → Document the npm-global assumption; maybe support `CLAUDSTERFUCK_CODEX_BINARY` env var override.

5. **The 10-minute watch timeout is aggressive but can be breached.** Very large Codex implementations can exceed 10 minutes. The watch returns `status:"running"` and Claude has to call `watch` again. Claude might interpret the timeout as "failed" if the SKILL.md isn't clear. → Verify SKILL.md explains this, or make `dispatch --watch` re-enter the watch loop automatically for a second window.

---

## 6. What NOT to Change

To avoid regression, these elements should stay as they are:

- **`chat` as the universal fallback for low confidence.** This is the safety net. Removing it would auto-delegate on ambiguous intent.
- **Question-mark detection is absolute.** Questions must never auto-delegate. Keep Rule A in classify-turn.mjs.
- **`claude` route as explicit bypass.** Gives users a known escape hatch when the plugin is in the way.
- **Workspace-scoped state isolation.** Two project directories = isolated session state. Never merge.
- **Atomic writes + audit trail.** State durability is foundational.
- **No subagent wrappers (v2.0 decision).** Keep dispatch direct.
- **NDJSON events kept off Claude's main-thread context.** Telemetry lives on disk + external surfaces; don't pipe back into Bash output.

---

## 7. Verdict

**The plugin ships its core promise.** The control/execution split is real, enforced, and measurable. Workers do receive self-contained objectives + constraints + memory context; they're not just transcribing Claude's pre-solved work (except when Claude reads files pre-delegation, which is the biggest mission leak and R2 closes it).

**The highest-value improvements are small:**
- R1 (classifier threshold) + R2 (block pre-delegation reads) together realign the plugin with its stated mission.
- R3 (mid-run progress) fixes the worst UX moment.
- R4–R7 polish onboarding and power-user flow.

**Mission alignment score: 82%.** Infrastructure is at 95%. Behavior and UX are at ~70% because the classifier is too conservative and pre-delegation reads are unrestricted. Close those two gaps and the plugin becomes genuinely effortless.

---

## Appendix A — Token-efficiency back-of-envelope

Per routed turn, the main Claude thread sees:

| Component | Tokens (approx) | Cached? |
|---|---|---|
| SKILL.md | ~1800 | Yes (per session) |
| Hook additionalContext (delegated) | ~250 | No (per turn) |
| User prompt | variable | No |
| Worker result JSON (after dispatch returns) | ~500–5000 depending on route | No |
| Claude's own output: "Delegating to X with objective..." | ~80–200 | No |

**Per-turn marginal cost:** ~250 (context) + prompt + 500–5000 (worker result) + 80–200 (Claude narration).

**Worker-side cost (not billed to Claude):**

| Route | Framework packs | Prompt size | Memory packet |
|---|---|---|---|
| implement | 5 packs / ~1300 chars | ~5300 chars total | ≤6000 chars |
| design | 6 packs / ~1100 chars | ~4500 chars total | ≤4500 chars |

Lite compression currently yields 0% reduction on these prompts (framework packs are already terse). Not a bug — just a ceiling.

**Where tokens are actually saved vs. a vanilla Claude session:** Claude never writes code, never explores the codebase with dozens of Read/Grep calls, never iterates on a test loop. Codex/Gemini handle all of that. Concretely, a 1000-line feature implementation in Claude would cost ~50K–100K tokens end-to-end; the same delegated to Codex costs Claude ~3K–8K tokens (context + result review).

---

## Appendix B — UX flow walkthrough

**Happy path (user types a clear implement task):**
1. User: "write code that retries failed fetches with exponential backoff"
2. Hook: classifier → high confidence implement; Codex
3. Claude: reads hook context, crafts objective, runs `Bash(orchestrator dispatch --watch --json --objective '...')`
4. Monitor window opens in separate terminal; statusline shows `[cf · implement]` with third line updating
5. ~60s later: Bash returns with `{status:"completed", finalOutput: "..."}`
6. Claude: runs `git diff --stat` and `npm test` (allowed in REVIEWING phase), reports diff + test results

**Friction path (user types a moderately clear task):**
1. User: "fix the payment webhook test"
2. Hook: classifier → low confidence debug; chat fallback
3. Claude: reads hook context, tells user "I could dispatch to Codex for debug, or you can elaborate. Shall I?"
4. User: "yes go"
5. Hook: low confidence chat fallback (no auto-delegation); but `shouldContinueExistingTurn` may or may not match
6. Potential confusion: user thinks they approved, Claude thinks intent is still unclear
7. User eventually types `route:debug` explicitly → delegation

**Long-run path (user types a big feature):**
1. User: "route:implement build a user preferences API with CRUD endpoints and migrations"
2. Hook: explicit override → Codex
3. Claude: dispatches
4. Codex runs for 7 minutes. Statusline updates every 2s. Monitor shows `⚙ exec: cargo test`, `📝 writing migrations/add_user_prefs.sql`, `💭 item.completed`, etc.
5. Claude's main thread sees nothing for 7 minutes
6. Bash returns, Claude reviews, reports

**Failure path (worker stalls at minute 6):**
1. ...same as long-run path, until...
2. Codex emits a tool_use at minute 6, then goes silent
3. No new events; latest-event.json doesn't update for 3+ minutes
4. Watch timeout at minute 10: returns `{status:"running", watchTimeoutReached:true}`
5. Claude doesn't know if this is progress or stall
6. Claude either: calls `watch` again (clock keeps ticking) or calls `cancel` (loses work)
7. No good fallback.

---

*End of audit.*
