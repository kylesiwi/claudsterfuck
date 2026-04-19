// Pure helpers for the monitor daemon's view-state routing and rendering
// primitives. No filesystem or spawn concerns — those live in the daemon
// script that imports these. Testable in isolation.

// Full terminal clear sequence.
//
// Start with `\x1bc` (ESC c — full terminal reset). This is more broadly
// honored than `\x1b[3J` alone on classic Windows conhost.exe, which may
// ignore the 3J scrollback-clear opcode but does honor the reset. Follow
// with belt-and-suspenders `\x1b[3J` (scrollback) + `\x1b[2J` (visible
// area) + `\x1b[H` (cursor home) so modern terminals (Windows Terminal,
// ConPTY, xterm-class) that don't need the reset still behave correctly.
//
// This addresses the UX complaint that per-frame redraws left stale
// content visible in the scrollback buffer — in practice any one of the
// sequences above is enough on a given terminal, and the combination is
// a no-op when unnecessary.
export function buildClearScreenSequence() {
  return "\x1bc\x1b[3J\x1b[2J\x1b[H";
}

// Decide which view to render based on the live state snapshot. Rules:
//   - WORKER_RUNNING turn phase dominates everything else (user cares most
//     about the active worker)
//   - REVIEWING turn phase shows the reviewing banner
//   - enrichment in progress (pruning/triaging/enriching/writing) shows
//     enrichment view
//   - otherwise idle
//
// Input shape (all fields optional):
//   { turnPhase, enrichmentPhase }
export function selectView(state) {
  if (!state || typeof state !== "object") return "idle";
  const { turnPhase, enrichmentPhase } = state;

  if (turnPhase === "worker-running") return "dispatch";
  if (turnPhase === "reviewing") return "reviewing";

  const active = new Set(["pruning", "triaging", "enriching", "writing"]);
  if (active.has(enrichmentPhase)) return "enriching";

  return "idle";
}

// Extract a compact summary of enrichment state for the banner/idle screen.
// Returns null when there's nothing meaningful to show. The shape mirrors
// the progress file so callers can render it directly.
export function summarizeEnrichmentState(progress) {
  if (!progress || typeof progress !== "object") return null;
  const hasAnything = progress.phase || progress.pending || progress.filesEnriched || progress.batchesTotal;
  if (!hasAnything) return null;
  return {
    phase: progress.phase ?? "unknown",
    filesEnriched: progress.filesEnriched ?? 0,
    pending: progress.pending ?? 0,
    batchesCompleted: progress.batchesCompleted ?? 0,
    batchesTotal: progress.batchesTotal ?? 0,
    startedAt: progress.startedAt ?? null,
    updatedAt: progress.updatedAt ?? null,
    filesErrored: progress.filesErrored ?? 0,
    pruned: progress.pruned ?? 0,
    currentBatch: Array.isArray(progress.currentBatch) ? progress.currentBatch : []
  };
}

export function buildIdleRecoveryHint() {
  return "Orphaned workers? Run: node orchestrator.mjs recover --force-stalled";
}

// Display-friendly truncation of the current turn's user prompt. Used for
// the "Last prompt:" header line so the user can always see which session/
// prompt the monitor window is tracking.
const PROMPT_PREVIEW_MAX = 120;

export function extractSessionPromptPreview(sessionRecord) {
  if (!sessionRecord || typeof sessionRecord !== "object") return "(no turn)";
  const turn = sessionRecord.currentTurn;
  if (!turn || typeof turn !== "object") return "(no turn)";
  const text = String(turn.prompt ?? turn.objective ?? "").trim();
  if (!text) return "(no prompt)";
  if (text.length <= PROMPT_PREVIEW_MAX) return text;
  return `${text.slice(0, PROMPT_PREVIEW_MAX - 3)}...`;
}
