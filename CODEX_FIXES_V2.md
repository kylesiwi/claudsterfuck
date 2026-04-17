# Codex Path / Worker Spawning Review (V2)

Date: 2026-04-16
Workspace: `C:\dev\claudsterfuck`

## Scope

This report summarizes telemetry/state/run analysis for the current `claudsterfuck` plugin session data and maps observed failures to concrete root causes and fixes.

Primary sources inspected:

- `D:\Users\kylecito\.claude\plugins\data\claudsterfuck-claudsterfuck-marketplace\state\claudsterfuck-ce5453669ac3281c\state.json`
- `D:\Users\kylecito\.claude\plugins\data\claudsterfuck-claudsterfuck-marketplace\state\claudsterfuck-ce5453669ac3281c\audit.jsonl`
- `D:\Users\kylecito\.claude\plugins\data\claudsterfuck-claudsterfuck-marketplace\state\claudsterfuck-ce5453669ac3281c\runs\*.json`
- Run artifacts under `...\runs\<run-id>\` (`stdout.live.txt`, `stderr.live.txt`, `process.json`, etc.)
- Session transcript: `D:\Users\kylecito\.claude\projects\C--dev-claudsterfuck\d0b22963-05cc-4f7a-a062-84a93c11f852.jsonl`
- Source files:
  - `scripts/orchestrator.mjs`
  - `scripts/lib/providers.mjs`
  - `scripts/lib/state.mjs`
  - `scripts/user-prompt-submit-hook.mjs`
  - `scripts/routing/classify-turn.mjs`
  - `scripts/lib/policy.mjs`

## Executive Summary

1. In captured telemetry, the most recent Codex worker run (`codex-a697d7d6`) succeeded with non-empty output.
2. The primary observed failure mode in the recent window is lifecycle/state inconsistency (stale running run records, turn-state disconnect during cancel/recover), not a proven persistent Codex binary spawn break.
3. There is still a real regression risk in the Codex path due to lack of runtime fallback when the preferred resolved executable fails at spawn.
4. The current observability is insufficient to diagnose command-resolution failures quickly (resolved command path is not persisted in process artifacts).
5. Immediate hardening should focus on: spawn fallback chain, `cancel --run-id` semantics, recover behavior for stale/dead runs, and richer process diagnostics.

## Observed Telemetry and Timeline

### Key run evidence

- `codex-a697d7d6`
  - started: `2026-04-16T14:37:30.913Z`
  - completed: `2026-04-16T14:45:11.572Z`
  - status: `completed`
  - exitCode: `0`
  - finalOutput: non-empty (implementation summary present)
- `gemini-5a48d4c8`
  - started: `2026-04-16T15:42:13.876Z`
  - run JSON status remained `running`
  - artifact stdout contains full JSON response (non-empty)
  - process PID eventually dead
  - turn state was cleared (`reset --json`) while run metadata stayed stale

### Audit sequence highlights

- `run-started codex-a697d7d6` at `14:37:30Z`
- `run-completed codex-a697d7d6` at `14:45:11Z`
- Later, `turn-created` for implement occurred without a corresponding Codex `run-started` before reroute/switch.
- `run-started gemini-5a48d4c8` at `15:42:13Z`
- `turn-cancelled` later while run record still showed running.

### Transcript-confirmed behavior (session d0b22963)

- `dispatch --watch --json` for Codex completed normally.
- For Gemini stall handling:
  - `cancel --run-id gemini-5a48d4c8` returned: `No current routed turn is stored.`
  - `recover --json` returned: `No orphaned runs found.`
  - `reset --json` cleared turn state for all sessions.
- This sequence leaves stale run status possible even though process lifecycle changed.

## Findings

### [High] F1: `cancel --run-id` is not actually run-id driven

`handleCancel` gates on `currentTurn`; when turn state is missing, cancellation fails even if a run id is provided and process is alive.

Impact:

- Operationally unsafe for detached workers.
- Users can lose control of a running/stuck process once turn state is reset or missing.

Code area:

- `scripts/orchestrator.mjs` (`handleCancel`)

### [High] F2: Recover logic can leave stale `running` records indefinitely

`recover` skips runs whose PID is alive and only finalizes dead ones on invocation time. If timing does not line up and no later recover/watch happens, stale `running` metadata persists.

Impact:

- `inspect/status` can report stale running runs.
- Misleads routing/control logic and debugging.

Code area:

- `scripts/orchestrator.mjs` (`handleRecover`)

### [High] F3: Codex Windows resolution has no runtime fallback on spawn failure

Resolution prioritizes native binary path for Codex, but dispatch attempts only one resolved command. If that specific spawn fails (`EPERM`, `ENOENT`, `EACCES`), run fails without trying next safe candidate.

Impact:

- Environment-sensitive breakage from npm layout/path/ACL changes.
- Appears as “worker spawning broken” despite viable fallback paths existing.

Code area:

- `scripts/lib/providers.mjs` (`resolveWindowsCommandWithArgs`, `runCommand`)
- `scripts/orchestrator.mjs` (`spawnDetached` call path)

### [Medium] F4: Process artifact diagnostics are incomplete

`process.json` stores logical command (`codex`) and args, but not the fully resolved command path/args actually spawned and not the attempted fallback sequence.

Impact:

- Postmortems are slow and ambiguous.
- Hard to distinguish path resolution failures from downstream CLI failures.

Code area:

- `scripts/orchestrator.mjs` process-info persistence

### [Medium] F5: Plugin data env path usage is brittle and easy to misconfigure

State path resolver expects `CLAUDE_PLUGIN_DATA` to be plugin root. If set to a workspace leaf state directory, path composition nests incorrectly and yields empty session/run views.

Impact:

- False “no sessions/no runs” diagnostics.
- Confusing behavior during manual debug workflows.

Code area:

- `scripts/lib/state.mjs` (`resolveStateDir`)
- `scripts/orchestrator.mjs` candidate resolution

### [Low] F6: Classifier accepts command-like prompts as implement intent

Prompt like `! plugin update claudsterfuck` was routed into worker flow rather than being treated as a local control command or ignored.

Impact:

- False-positive delegation.
- Increased risk of scope drift and accidental orchestration work.

Code area:

- `scripts/routing/classify-turn.mjs`
- `scripts/user-prompt-submit-hook.mjs`

## Root-Cause Map

1. Detached-run lifecycle is modeled as turn-centric; run-centric control paths are incomplete.
2. Spawn resolution is deterministic but not resilient to first-choice command failure.
3. Recovery only partially addresses orphan scenarios and does not guarantee eventual metadata convergence.
4. Artifact telemetry lacks explicit resolved command provenance.
5. Routing guardrails for shell/CLI command-style user messages are too permissive.

## Fix Plan (Priority Ordered)

### P0: Make spawn robust with fallback attempts

Implement explicit runtime fallback chain for provider spawning:

1. Codex native binary
2. Codex node entrypoint
3. PowerShell shim
4. Raw command

Apply equivalent resilient strategy for Gemini where relevant.
Retry on spawn-level failures only (`EPERM`, `ENOENT`, `EACCES`), not process exit failures.

Acceptance criteria:

- Dispatch succeeds if any fallback candidate is spawnable.
- Run artifacts record every attempted command and failure reason.

### P0: Make `cancel --run-id` authoritative

If `--run-id` is supplied:

- read run JSON directly
- read process metadata directly
- attempt process-tree kill regardless of `currentTurn`
- mark run failed/cancelled
- update turn only if matching turn exists

Acceptance criteria:

- Cancel works even when `currentTurn` is null.
- Stuck detached processes can always be terminated by run id.

### P1: Improve recover for convergence

Enhance recover with options:

- `--force-stalled` (route/provider threshold based)
- finalize dead runs even if turn linkage is missing
- optionally mark long-stalled runs failed with explicit summary

Acceptance criteria:

- Re-running recover guarantees eventual consistency between process liveness and run status.

### P1: Persist resolved spawn diagnostics

In `process.json`, persist:

- `resolvedCommand`
- `resolvedArgs`
- `attempts` array with per-attempt error (code/message)
- environment flags actually injected

Acceptance criteria:

- Postmortem requires no inference to know exactly what was spawned.

### P2: Guard command-like prompts in routing

Before route classification, detect command-style prefixes such as `!`, plugin control patterns, etc., and route to chat/non-delegated handling or explicit control guidance.

Acceptance criteria:

- `! plugin update ...` does not trigger implement/delegate path.

### P2: Add tests for regressions

Add/extend tests covering:

- spawn fallback sequence and failover behavior
- `cancel --run-id` without current turn
- recover stale/dead run scenarios
- command-like prompt classification guard
- plugin data env path handling expectations

## Recommended Immediate Actions

1. Implement P0 items first (`spawn fallback`, `cancel --run-id`).
2. Add process diagnostics persistence in same patch set for quick validation.
3. Run targeted smoke tests:
   - dispatch Codex with intentional first-path spawn failure simulation
   - cancel by run id with cleared turn
   - recover after forced worker death
4. Then address P1/P2 for hardening and misrouting prevention.

## Notes on Current Codex Path Status

- In the analyzed telemetry set, Codex did run successfully.
- The reported “Codex path broken” symptom is plausible as an environment-sensitive regression due to missing runtime fallback, but it is not conclusively demonstrated by the captured Codex run records in this state folder.
- Therefore, the fix plan treats Codex path as a reliability hardening gap, while also addressing the clearly observed lifecycle/state inconsistencies that produced user-visible failure modes.

