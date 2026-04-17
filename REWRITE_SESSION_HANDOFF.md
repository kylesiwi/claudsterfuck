# REWRITE_SESSION_HANDOFF.md

Date: 2026-04-15  
Source repo: `C:\dev\hybrid-companion`  
Target: New Codex session in a fresh workspace for full rewrite implementation

## 1) What This Plugin Is

`hybrid-companion` (a.k.a. `hybrid-tagteam`) is a Claude Code plugin that enforces a routed multi-agent workflow:

1. Classifies turns into routes (`plan`, `design`, `implement`, `debug`, `review`, etc.).
2. Locks one active turn to one route/provider at a time.
3. Delegates execution to worker providers (Codex/Gemini) via runtime scripts.
4. Uses hooks + runtime checks to keep Claude main thread in orchestrator/reviewer mode.
5. Tracks turn/run state and provides status/inspect tooling.

Core value today: deterministic routing + route-specific reasoning frameworks (pre-mortem, devil’s advocate, bias checks, etc.).

## 2) Current Limitations (Ground Truth)

These are observed in real runs and are the reason for rewrite:

1. Background task lifecycle is brittle (pending/running with poor visibility).
2. Completion handoff is unreliable in some flows (worker done but main thread does not continue cleanly).
3. Long-running delegation can appear “stuck” without clear heartbeat/stage visibility.
4. Existing JSON-file state model is fragile under concurrency/recovery cases.
5. Worker packets are too noisy and large (memory over-inclusion from `.wolf` and policy/control-plane context).

## 3) Rewrite Plan to Implement

Primary design reference:

- [REWRITE_PROPOSAL.md](C:\dev\hybrid-companion\hybrid-tagteam\REWRITE_PROPOSAL.md)

Non-negotiable constraints (must preserve):

1. Keep route heuristics/logic.
2. Keep route->provider mapping logic.
3. Keep route framework packs and reasoning philosophy.
4. Rewrite orchestration/runtime plumbing only.

Selected architecture (from proposal):

1. New explicit orchestrator runtime (foreground default, detached explicit).
2. Event-sourced state model with heartbeat/lease semantics (SQLite WAL).
3. First-class progress visibility (`dispatch/watch/status/result/inspect/cancel/recover`).
4. Hooks as hard enforcement baseline + runtime invariants + concise per-turn contract reinforcement.
5. Explicit `freechat` override path with mandatory post-turn reconciliation.
6. Always-on prompt compiler (Lite-Caveman style) with:
   - concise contract language
   - memory distillation budgets
   - immutable contract/schema/code/path boundaries
   - `compress -> validate -> targeted-fix -> fail-open fallback`

## 4) Required Rename for Rewrite Branch

The rewritten plugin is a new identity:

1. Working/new plugin name: `claudsterfuck` (working name; may become final).
2. During rewrite implementation, replace legacy references:
   - `hybrid-companion`
   - `hybrid-tagteam`
   - `tagteam`
3. Apply rename across:
   - plugin manifests
   - scripts and command surfaces
   - docs and architecture references
   - route/skill labels where user-facing

Note: Keep compatibility aliases only if explicitly planned; default is full rename in rewritten system.

## 5) Instructions for New Codex Session

Do this in the new session before coding:

1. Clone/copy source plugin from `C:\dev\hybrid-companion` into the new session workspace.
2. Work only in the fresh copy. Do not modify the original repo in place.
3. Confirm baseline compiles/tests in the fresh copy before rewrite.
4. Implement rewrite guided by `REWRITE_PROPOSAL.md` end-to-end.
5. Apply full rename to `claudsterfuck` during implementation (code + docs).
6. Keep a migration note documenting old->new command names and file path changes.

## 6) Implementation Guardrails

1. Deterministic enforcement remains required (no hookless baseline mode).
2. Visibility into active runs is first-class, not optional.
3. Compression is always active in rewrite path (no runtime flag).
4. Compression must never break schema/contract payloads.
5. Delegation must remain provider-aware and route-locked.

## 7) Minimum Deliverables for Rewrite Session

1. New orchestrator runtime integrated and default path switched.
2. Event-sourced storage + recovery semantics implemented.
3. Status/watch/inspect/result UX usable in real workflows.
4. Prompt compiler + memory distillation integrated with telemetry.
5. Renamed plugin identity (`claudsterfuck`) applied throughout code/docs.
6. Updated architecture docs reflecting new system reality.

## 8) Suggested First Actions in New Session

1. Confirm workspace path and clone target.
2. Run baseline tests/build.
3. Create rename plan (mechanical rename + compatibility decision).
4. Execute Phase 0/1 from `REWRITE_PROPOSAL.md`.
5. Validate with a real delegation simulation before Phase 2 rollout.

