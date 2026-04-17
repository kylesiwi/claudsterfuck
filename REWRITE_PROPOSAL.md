# REWRITE_PROPOSAL.md

Date: 2026-04-15  
Workspace: `C:\dev\hybrid-companion\hybrid-tagteam`

## Executive Summary

This proposes a full orchestration rewrite focused on reliability, visibility, and deterministic recovery.

Hard constraints from product direction:

1. Keep route/provider selection logic as-is.
2. Keep route thinking frameworks as-is (`devils-advocate`, `pre-mortem`, blind-spot checks, etc.).
3. Rewrite orchestration/runtime plumbing only.

The core recommendation is to replace the current subagent-wrapper dispatch model with a first-class orchestrator runtime that:

1. Runs delegated work via explicit orchestrator commands (foreground by default, detached only when explicitly requested).
2. Uses event-sourced run tracking with leases/heartbeats.
3. Makes progress visibility first-class (`watch`, progress stream, live stage state).
4. Removes dependence on fragile “background subagent finished, now hopefully main lead resumes” behavior.
5. Uses an always-on prompt compiler (no runtime flag) that applies concise contract-style language and strips memory noise before worker handoff.

---

## Pass 1: Ground Truth and Failure Evidence

### Current Architecture (confirmed from code)

1. Routing/classification lives in `scripts/user-prompt-submit-hook.mjs`.
2. Enforcement lives in `scripts/lib/policy.mjs` (`PreToolUse` and `Stop` paths).
3. Delegation runtime lives in `scripts/hybrid-companion.mjs` + `scripts/lib/providers.mjs`.
4. State is JSON-file based in `scripts/lib/state.mjs` (single-file writes, no lock manager).
5. Worker wrappers (`agents/hybrid-codex-worker.md`, `agents/hybrid-gemini-worker.md`) call:
   - `node "${CLAUDE_PLUGIN_ROOT}/scripts/hybrid-companion.mjs" task --json`

### Real failure modes observed in live usage

1. Background task appears as running/pending indefinitely; no useful output shown in task panel.
2. Work may complete, but lead flow does not reliably “dial home” and continue automatically.
3. Permission friction can stall/derail runs mid-pipeline (especially shell/runtime differences on Windows).
4. Users cannot confidently tell “healthy long run” vs “silent stall” without manual deep inspection.
5. Main-thread control can feel blocked while background inference is active.

### Why these failures happen (causal model)

1. Current orchestration leans on background task semantics and implicit completion handoff.
2. Background task UI is not guaranteed to surface meaningful stream output unless explicitly wired.
3. Completion and continuation currently rely on hook/session timing and model behavior coupling.
4. JSON state storage lacks robust multi-process concurrency semantics.
5. Cross-platform shell/provider behavior adds nondeterminism in long chains.

### Prompt bloat evidence from live cached runs

From `D:\Users\kylecito\.claude\plugins\data\hybrid-companion-hybrid-companion-marketplace\state\PaginaAF-2696cd91b54cb638\runs`:

1. `codex-658bf6b1`: prompt `12,392` chars; memory section `4,786` chars.
2. `codex-7c316174`: prompt `9,332` chars; memory section `5,279` chars.
3. `codex-ca8d49da`: prompt `8,979` chars; memory section `4,947` chars.

Observed noise in memory packet snippets:

1. Long project background summaries (brand/history/marketing context) in implementation runs.
2. Routing-policy lessons embedded in worker memory (`awaiting-user` hook behavior) that are control-plane concerns, not worker task context.
3. Repeated stack/payment/email context across multiple runs even when objective is a narrow UI/code fix.

Additional live session evidence from `D:\Users\kylecito\.claude\projects\C--dev-PaginaAF\beb56e42-aea2-4e1b-bdca-4130c4373352.jsonl`:

1. A delegated worker result injected large `.wolf/cerebrum.md` content into context (`~9.4k tokens` truncated in transcript), including brand and legal background not required for the immediate command.
2. The same session showed repeated hook policy blocks in multiple turns that are useful for control-plane safety but noisy for worker execution packets.

Conclusion: worker prompts currently over-include background context, and memory packet verbosity is a primary overhead source.

---

## Pass 2: External Platform Constraints and Opportunities (Web Research)

### Relevant Claude Code capabilities

1. Background tasks are async, have IDs, and output is written to files ([Interactive mode](https://code.claude.com/docs/en/interactive-mode)).
2. `/tasks` exists for listing/managing background tasks, and `/status` works while Claude is responding ([Commands](https://code.claude.com/docs/en/commands)).
3. Hooks include `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Notification`, `Stop`, `PermissionDenied`, etc. ([Hooks reference](https://code.claude.com/docs/en/hooks)).
4. `Stop`/`SubagentStop` can block continuation; docs explicitly warn to check `stop_hook_active` to avoid infinite continuation loops ([Hooks reference](https://code.claude.com/docs/en/hooks)).
5. Async hooks can run in background, but their output is delivered on the next turn; if idle, it waits (except `asyncRewake` + exit code 2 behavior) ([Hooks reference](https://code.claude.com/docs/en/hooks)).
6. Plugin subagents cannot use `hooks`, `mcpServers`, or `permissionMode` frontmatter (ignored in plugin scope) ([Subagents](https://code.claude.com/docs/en/sub-agents)).
7. Background subagents pre-approve permissions; missing permissions can fail tool calls while the subagent continues ([Subagents](https://code.claude.com/docs/en/sub-agents)).
8. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_AUTO_BACKGROUND_TASKS`, and `CLAUDE_CODE_USE_POWERSHELL_TOOL` are relevant environment controls ([Environment variables](https://code.claude.com/docs/en/env-vars)).
9. Channels can push events into a running session, but are research preview and require claude.ai login; not a stable baseline for core reliability ([Channels](https://code.claude.com/docs/en/channels)).
10. Agent teams provide advanced orchestration, but are explicitly experimental with known limitations (resumption/task coordination/shutdown) ([Agent teams](https://code.claude.com/docs/en/agent-teams)).

### Implications for our rewrite

1. We should not depend on experimental features (agent teams/channels) as core control plane.
2. We should avoid architecture that requires implicit asynchronous “wake me up later” semantics to be correct.
3. We should make task lifecycle explicit, inspectable, and resumable by command.
4. We should treat progress visibility as product surface, not debug artifact.

---

## Pass 3: Design Options and Decision

### Option A: Incremental patching of current model

Pros:
1. Lower immediate code churn.

Cons:
1. Keeps implicit callback/wakeup coupling.
2. Keeps JSON-state concurrency fragility.
3. Keeps subagent-wrapper dependency as critical path.

Verdict: insufficient for recurring reliability failures.

### Option B: Move orchestration to native Agent Teams

Pros:
1. Rich coordination and task model.

Cons:
1. Experimental with known limitations.
2. Operational complexity and token cost.
3. Not ideal as deterministic production baseline right now.

Verdict: useful future mode, not core replacement.

### Option C (Selected): New explicit orchestrator runtime

Pros:
1. Deterministic lifecycle with explicit state transitions.
2. Foreground-first completion path removes callback ambiguity.
3. Detached mode remains available but explicit and observable.
4. Clean place to add first-class progress and recovery semantics.

Verdict: chosen.

---

## Pass 4: Proposed New System (Full Rewrite)

## Invariants (must stay unchanged)

1. Route detection heuristics and route override grammar remain unchanged.
2. Route-to-provider mapping remains unchanged.
3. Route framework packs and thinking frameworks remain unchanged.
4. OpenWolf allowlist policy remains unchanged unless explicitly requested later.

## New orchestration architecture

### 1) Control Plane Split

Keep:
1. `UserPromptSubmit` route decision logic.
2. `PreToolUse` safety policy concept.

Replace:
1. Worker execution and lifecycle management.
2. State storage and run tracking model.
3. Completion handoff semantics.

### 2) Runtime Components

1. `Orchestrator API` (new CLI entrypoint, ex: `scripts/orchestrator.mjs`)
   - commands: `dispatch`, `watch`, `status`, `inspect`, `result`, `cancel`, `recover`
2. `Supervisor` (provider-agnostic run manager)
   - owns child process lifecycle, timeout, kill, retry policy
3. `Provider adapters`
   - Codex adapter
   - Gemini adapter
4. `Event store` (SQLite WAL recommended)
   - append-only run events + materialized views
5. `Progress broker`
   - normalized progress envelopes independent of provider format
6. `Inbox/continuation queue`
   - explicit “run finished, pending synthesis” events

### 2.5) Prompt Compiler (Always-On, No Flag)

Prompt compression is part of core orchestration behavior in v2. It is always active for delegated worker handoff.

Source baseline copied from Caveman Lite mode semantics:

1. `lite`: **"No filler/hedging. Keep articles + full sentences. Professional but tight."**
2. Shared caveman rules applied in lite-safe form:
   - drop filler/hedging/pleasantries
   - keep technical terms exact
   - keep code blocks unchanged
   - prefer short, direct phrasing
   - structure as action-oriented contract language

Applied style for worker handoff:

1. concise, objective, contract-like language
2. LLM/agent-friendly syntax where safe (`IF`, `THEN`, `=>`, `MUST`, `MUST NOT`)
3. preserve readability enough for deterministic execution (no ultra-telegraphic degradation)

Hard immutability boundaries:

1. `OUTPUT_CONTRACT_SECTION` is byte-stable.
2. JSON schemas/examples are byte-stable.
3. fenced code / inline code / paths / commands / URLs remain exact.
4. route/framework identity fields remain exact.

Borrowed implementation pattern from Caveman Compress (`compress -> validate -> targeted-fix`) adapted for packet safety:

1. Build raw packet sections (`objective`, `constraints`, `selected-memory-facts`, `output-contract`).
2. Apply Lite compiler transform to mutable natural-language sections only.
3. Validate invariants:
   - exact preservation of code/paths/URLs/commands/JSON blocks
   - exact preservation of output contract schema section
   - no dropped required fields
4. If validation fails, run targeted fix pass that patches only failed spans (no full re-compress).
5. Retry targeted fix up to 2 times.
6. If still invalid, fail open by sending original uncompressed packet and emit telemetry event `packet_compression_fallback`.

No runtime flag exists for this in v2. The safety fallback is automatic, internal, and always available.

### 2.6) Memory Packet Distillation Pipeline (Worker-Focused)

Replace current packet strategy (broad chunk inclusion) with task-scoped distillation:

1. Retrieve candidate facts from memory sources.
2. Classify each candidate into memory classes:
   - `execution-critical`
   - `repo-structure`
   - `known-failure-pattern`
   - `project-background`
   - `control-plane-meta`
3. For worker packets:
   - prioritize `execution-critical`, `repo-structure`, `known-failure-pattern`
   - default-exclude `project-background` and `control-plane-meta`
4. Convert selected candidates into atomic facts:
   - one fact per line
   - bounded length
   - no narrative paragraphs
5. Apply Lite prompt compiler to final packet lines.

Default packet budgets (hard caps, no flag):

1. `implement` / `debug`: max `900` chars memory packet.
2. `review-feedback` / `review`: max `1100` chars.
3. `design` / `plan`: max `1400` chars.

Additional caps:

1. max 6 facts per packet.
2. max 2 facts from any single source file.
3. drop any fact with weak objective overlap.

Control-plane memory isolation:

1. route/hook/policy lessons stay in orchestrator memory, not worker memory packets.
2. worker packets contain only task-relevant implementation/design evidence.

### 2.7) Packet Build Order (Where Compression Happens)

1. Route/provider selected (existing heuristics unchanged).
2. Candidate memory facts fetched.
3. Distillation/classification trims facts to route budget.
4. Worker packet assembled from distilled facts + route framework contract.
5. Lite compiler runs on mutable natural-language fields.
6. Invariant validator checks packet.
7. If valid, dispatch.
8. If invalid after targeted repair retries, dispatch original uncompressed packet and mark fallback telemetry.

Decision: compression is applied after packet assembly (so it respects final contract structure), but only to mutable text sections.

### 3) Data Model (event-sourced)

Entities:

1. `sessions`
2. `turns`
3. `runs`
4. `run_events`
5. `run_heartbeats`
6. `continuation_inbox`
7. `locks` (short TTL lease rows)

State transitions (explicit):

1. `queued`
2. `claimed`
3. `running`
4. `verifying`
5. `completed`
6. `failed`
7. `cancelled`
8. `orphaned`

Rules:

1. All transitions are append-only events.
2. Materialized state is derived, not authoritative.
3. Lease heartbeat expiration promotes `running -> orphaned` for deterministic recovery.

### 4) Execution Modes

#### Foreground mode (default)

1. Claude dispatches run.
2. Orchestrator streams progress immediately.
3. Orchestrator returns normalized final result in same command call.
4. Claude continues same turn deterministically.

This becomes the primary path to eliminate “finished but no callback” failures.

#### Detached mode (explicit opt-in)

1. Command returns `run_id` immediately.
2. User/Claude uses `watch`/`status`/`result` explicitly.
3. Completion writes to `continuation_inbox`.
4. No hidden auto-resume assumptions.

### 5) First-Class Progress (P0 requirement)

Progress is not inferred from file timestamps only. It is a first-class API.

`watch` stream payload:

1. `run_id`
2. `provider`
3. `stage` (`setup`, `delegate`, `worker`, `verify`, `finalize`)
4. `state`
5. `elapsed_ms`
6. `last_heartbeat_at`
7. `heartbeat_gap_ms`
8. `latest_message`
9. `stderr_tail`
10. `artifact_paths`

UX surfaces:

1. `/hybrid-companion:watch` for live stream.
2. `/hybrid-companion:status` one-line health summary.
3. `/hybrid-companion:inspect` deep JSON snapshot.
4. Optional local dashboard (read-only) for cross-session monitoring.

### 6) Permission and Shell Reliability

1. Add adapter-level preflight checks before launching provider.
2. Standardize Windows command pathing and shell strategy.
3. Prefer native PowerShell path where applicable on Windows environments.
4. Treat permission-denied as structured failure stage, not opaque timeout.
5. Split implementation and verification into separate tracked stages to avoid losing successful work behind long verification hangs.

### 7) Continuation Semantics (No more implicit deadlocks)

1. Foreground default avoids asynchronous continuation dependency.
2. Detached completion writes explicit inbox event.
3. `Stop` hook no longer used as primary orchestration loop driver.
4. If hook assistance is used, it must be one-shot and guarded by `stop_hook_active`.

### 8) Hook Role in the new architecture

Hooks become policy and routing glue, not orchestration engine.

1. `UserPromptSubmit`: keep route logic.
2. `PreToolUse`: keep safety + command gating.
3. `Stop`: minimal guardrails only (avoid loop orchestration).
4. Optional async hooks for notifications only (non-authoritative).

### 9) Enforcement Model (Amended)

Deterministic enforcement should be defense-in-depth.

#### Layer A: Hard enforcement (hooks)

1. `PreToolUse` denies main-thread write tools by default on delegated turns.
2. Allowed exceptions are explicit:
   - orchestrator control commands (`dispatch`, `watch`, `status`, `result`, `inspect`, `cancel`, `recover`)
   - OpenWolf allowlisted bookkeeping files only (unchanged allowlist policy)
3. `SubagentStart/SubagentStop`, `TaskCreated/TaskCompleted`, and `PermissionDenied` are captured as lifecycle telemetry and failure-classification inputs.
4. `Stop` hook is kept minimal and loop-safe (`stop_hook_active` guard), not used as primary orchestration loop.

#### Layer B: Hard enforcement (runtime invariants)

1. Orchestrator refuses provider dispatch unless the turn is bound, route/provider are resolved, and lease is valid.
2. Writes happen only through provider adapter execution paths controlled by orchestrator state.
3. Any direct CLI override that bypasses bound turn authority is rejected.

#### Layer C: Soft reinforcement (per-turn contract prompt)

Use a compact dynamic contract injected each turn (fresh in context) to reduce model drift:

1. `ROLE=ORCHESTRATOR`
2. `MAIN_THREAD_WRITES=DENY`
3. `EXCEPTION=.wolf allowlist only`
4. `NEXT_ACTION=delegate|wait|review` (state-derived)
5. `ACTIVE_RUN=<id|none>`

This is useful, but not sufficient by itself.

#### Why not rely only on repeated instructions?

1. Prompt instructions are advisory, not deterministic policy.
2. Long contexts can still cause instruction loss or local override behavior.
3. They do not prevent unauthorized tool calls in privileged contexts.

Conclusion: repeated turn instructions are good and should be included, but only as Layer C reinforcement beneath hard controls.

Per-turn contract prompt format (always injected, concise compiler output):

1. `ROLE=ORCHESTRATOR`
2. `TURN_MODE=delegated|freechat`
3. `NEXT_ACTION=delegate|wait|review`
4. `MAIN_THREAD_WRITES=DENY`
5. `EXCEPTION=.wolf_allowlist`
6. `ACTIVE_ROUTE=<route>`
7. `ACTIVE_PROVIDER=<provider>`
8. `ACTIVE_RUN=<id|none>`

### 10) No Hookless Baseline + Explicit Freechat Override (Amended)

Deterministic enforcement is a hard requirement. Hookless mode is not a supported baseline.

#### Baseline policy

1. Hooks are required for normal delegated operation.
2. If hooks are unavailable/unhealthy, runtime sets `health=degraded` and blocks delegated execution paths.
3. In degraded state, user can run diagnostics/inspection, but not normal orchestration dispatch.

#### Explicit unrestricted override

Provide a deliberate escape hatch command for direct user↔Claude conversation:

1. `/hybrid-companion:freechat <objective>` (single turn default)
2. Optional sticky override (explicit confirmation required) for consecutive unrestricted turns

Freechat turn behavior:

1. Route enforcement is bypassed for that turn only.
2. Delegation lock rules are bypassed for that turn only.
3. Turn is marked auditable with `mode=freechat`.

#### Required post-turn reconciliation

After each freechat turn, runtime must update orchestration metadata:

1. `lastMode=freechat`
2. `lastFreechatAt=<timestamp>`
3. session health/route readiness recomputed from persisted turn/run state
4. clear next-step hint emitted:
   - resume delegated flow, or
   - continue freechat explicitly

This ensures freechat does not leave stale route/health indicators.

---

## Pass 5: Pre-Mortem (How this rewrite could fail)

### Failure: Store corruption or lock contention under concurrency

Mitigation:

1. SQLite WAL with busy timeout.
2. Transactional writes.
3. Startup integrity check and repair path.

### Failure: Foreground runs feel too blocking

Mitigation:

1. Keep explicit detached mode.
2. Make detached mode user-intent based, not automatic.

### Failure: Provider-specific output format drift

Mitigation:

1. Strict adapter contract with schema validation.
2. Per-provider contract tests with frozen fixtures.

### Failure: Verification stage dominates and appears stuck

Mitigation:

1. Stage-level telemetry and independent timeout budgets.
2. Clear separation: `worker-complete` vs `verify-complete`.
3. Partial success surfaced to user.

### Failure: Claude still waits incorrectly

Mitigation:

1. Foreground-by-default removes dependency on asynchronous callbacks.
2. Detached path requires explicit `watch/result` handshake.
3. Inbox events are explicit and inspectable.

### Failure: Rewrite breaks trusted route behavior

Mitigation:

1. Freeze route classification and framework loading codepaths.
2. Add regression suite proving route decisions unchanged.

---

## Implementation Plan (Phased)

### Phase 0: Freeze invariants

1. Snapshot tests for current route/provider decisions.
2. Snapshot tests for framework pack resolution.
3. Capture baseline prompt telemetry on real cached runs (chars/tokens by section).

### Phase 1: New store + supervisor in parallel

1. Implement new orchestrator with SQLite store.
2. Implement provider adapters and normalized progress events.
3. Implement always-on prompt compiler (Caveman Lite semantics) for objective + memory packet + orchestration contract text.
4. Implement compression validator + targeted-fix retry loop + fail-open fallback telemetry.
5. Implement memory classification/distillation pipeline and worker-focused packet budgets.
6. Keep existing commands untouched.

### Phase 2: Introduce new commands

1. Add `dispatch/watch/status/result/inspect/cancel/recover`.
2. Keep prompt compiler always on in v2 (no runtime compression flag).

### Phase 3: Switch default path

1. Make orchestrator v2 default.
2. Keep v1 fallback command for one release cycle.

### Phase 4: Remove wrapper debt

1. Retire subagent wrapper dependency for core dispatch.
2. Keep optional subagent usage as non-critical UX path only.

### Phase 5: Hardening and polish

1. Stress tests (concurrency, Windows shells, permission denials).
2. Add local dashboard if needed.
3. Finalize migration docs.

---

## Acceptance Criteria

1. A completed foreground run always returns a normalized result in the same turn.
2. Detached runs are always visible via `status/watch/inspect` with live heartbeat.
3. No run can remain “pending forever” without explicit stale/orphaned classification.
4. Route/provider choice parity with current implementation is preserved.
5. Framework pack behavior parity is preserved.
6. Windows shell/permission failures are classified explicitly (not silent hangs).
7. Hook-unavailable state blocks delegated dispatch and reports `health=degraded`.
8. `freechat` override turns are auditable and always reconcile session/runtime indicators after completion.
9. Worker handoff prompts are consistently concise contract language (Lite compiler style) with no schema/contract corruption.
10. Memory packet budgets are enforced by route and exclude control-plane/background noise by default for implementation/debug routes.
11. Real-run prompt telemetry shows sustained reduction in handoff size without regression in task completion quality.
12. Compression never blocks dispatch: invalid compressed packets automatically fall back to original packet with explicit telemetry and reason code.

---

## What this keeps vs what this rewrites

Keeps:

1. Route heuristics.
2. Route-provider mapping.
3. Thinking-framework packs and philosophy.
4. Existing route vocabulary and forced route UX.

Rewrites:

1. Delegation orchestration engine.
2. Run lifecycle/state persistence.
3. Progress and completion observability.
4. Detached/background handoff semantics.

---

## Practical Recommendation

Adopt the new orchestrator architecture with foreground-default dispatch and event-sourced state. This directly addresses the observed reliability issues while preserving the route intelligence and reasoning frameworks that are already working well.

---

## References

1. Claude Code Hooks reference: [https://code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)
2. Claude Code Interactive mode (background tasks): [https://code.claude.com/docs/en/interactive-mode](https://code.claude.com/docs/en/interactive-mode)
3. Claude Code Commands reference (`/tasks`, `/status`): [https://code.claude.com/docs/en/commands](https://code.claude.com/docs/en/commands)
4. Claude Code Subagents: [https://code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents)
5. Claude Code Agent teams: [https://code.claude.com/docs/en/agent-teams](https://code.claude.com/docs/en/agent-teams)
6. Claude Code Environment variables: [https://code.claude.com/docs/en/env-vars](https://code.claude.com/docs/en/env-vars)
7. Claude Code Channels: [https://code.claude.com/docs/en/channels](https://code.claude.com/docs/en/channels)
8. Caveman main repo: [https://github.com/JuliusBrussee/caveman/tree/main](https://github.com/JuliusBrussee/caveman/tree/main)
9. Caveman skill (`lite` mode semantics): [https://github.com/JuliusBrussee/caveman/blob/main/skills/caveman/SKILL.md](https://github.com/JuliusBrussee/caveman/blob/main/skills/caveman/SKILL.md)
10. Caveman compress design: [https://github.com/JuliusBrussee/caveman/blob/main/caveman-compress/README.md](https://github.com/JuliusBrussee/caveman/blob/main/caveman-compress/README.md)
11. Caveman compress orchestration script: [https://raw.githubusercontent.com/JuliusBrussee/caveman/main/caveman-compress/scripts/compress.py](https://raw.githubusercontent.com/JuliusBrussee/caveman/main/caveman-compress/scripts/compress.py)
