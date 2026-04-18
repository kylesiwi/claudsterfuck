#!/usr/bin/env node
// Pre-implementation TDD tests for monitor-daemon-view.mjs.
// All assertions should FAIL before the implementation file exists.

import assert from "node:assert/strict";

import {
  selectView,
  buildClearScreenSequence,
  summarizeEnrichmentState,
  extractSessionPromptPreview
} from "./monitor-daemon-view.mjs";

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    throw error;
  }
}

// --- selectView ---

await run("selectView -> 'dispatch' when turn phase is WORKER_RUNNING", () => {
  assert.equal(selectView({ turnPhase: "WORKER_RUNNING" }), "dispatch");
});

await run("selectView -> 'reviewing' when turn phase is REVIEWING", () => {
  assert.equal(selectView({ turnPhase: "REVIEWING" }), "reviewing");
});

await run("selectView -> 'enriching' when enrichmentPhase is enriching", () => {
  assert.equal(
    selectView({ turnPhase: "REFINING", enrichmentPhase: "enriching" }),
    "enriching"
  );
});

await run("selectView -> 'enriching' for pruning/triaging/writing phases too", () => {
  for (const phase of ["pruning", "triaging", "writing"]) {
    assert.equal(
      selectView({ enrichmentPhase: phase }),
      "enriching",
      `phase=${phase} should map to enriching`
    );
  }
});

await run("selectView -> 'idle' when enrichment phase is complete or failed", () => {
  assert.equal(selectView({ enrichmentPhase: "complete" }), "idle");
  assert.equal(selectView({ enrichmentPhase: "failed" }), "idle");
});

await run("selectView priorities dispatch over enriching when both are active", () => {
  assert.equal(
    selectView({ turnPhase: "WORKER_RUNNING", enrichmentPhase: "enriching" }),
    "dispatch"
  );
});

await run("selectView -> 'idle' on empty input", () => {
  assert.equal(selectView({}), "idle");
  assert.equal(selectView(null), "idle");
  assert.equal(selectView(undefined), "idle");
});

// --- buildClearScreenSequence ---

await run("buildClearScreenSequence clears scrollback AND screen AND moves cursor home AND resets terminal", () => {
  const seq = buildClearScreenSequence();
  assert.ok(seq.startsWith("\x1bc"), "must start with \\x1bc (full reset) for conhost scrollback wipe");
  assert.ok(seq.includes("\x1b[3J"), "must include \\x1b[3J to clear scrollback");
  assert.ok(seq.includes("\x1b[2J"), "must include \\x1b[2J to clear visible area");
  assert.ok(seq.includes("\x1b[H"), "must include \\x1b[H to home the cursor");
});

// --- summarizeEnrichmentState ---

await run("summarizeEnrichmentState returns null when input is empty/missing", () => {
  assert.equal(summarizeEnrichmentState(null), null);
  assert.equal(summarizeEnrichmentState({}), null);
});

await run("summarizeEnrichmentState surfaces phase + counts when progress exists", () => {
  const state = summarizeEnrichmentState({
    phase: "enriching",
    filesEnriched: 10,
    pending: 41,
    batchesCompleted: 2,
    batchesTotal: 9,
    startedAt: "2026-04-18T20:00:00Z"
  });
  assert.ok(state);
  assert.equal(state.phase, "enriching");
  assert.equal(state.filesEnriched, 10);
  assert.equal(state.pending, 41);
  assert.equal(state.batchesCompleted, 2);
  assert.equal(state.batchesTotal, 9);
});

// --- extractSessionPromptPreview ---

await run("extractSessionPromptPreview returns '(no turn)' when there's no currentTurn", () => {
  assert.equal(extractSessionPromptPreview(null), "(no turn)");
  assert.equal(extractSessionPromptPreview({ currentTurn: null }), "(no turn)");
});

await run("extractSessionPromptPreview returns the turn's prompt, truncated if long", () => {
  const longPrompt = "a".repeat(200);
  const preview = extractSessionPromptPreview({ currentTurn: { prompt: longPrompt } });
  assert.ok(preview.length <= 120, `preview should be truncated; got length=${preview.length}`);
  assert.ok(preview.startsWith("aaa"), "preview should start with the prompt");
});

await run("extractSessionPromptPreview prefers .prompt over .objective when both present", () => {
  const preview = extractSessionPromptPreview({
    currentTurn: { prompt: "THE PROMPT", objective: "the objective" }
  });
  assert.equal(preview, "THE PROMPT");
});

await run("extractSessionPromptPreview falls back to objective when prompt missing", () => {
  const preview = extractSessionPromptPreview({
    currentTurn: { objective: "fallback objective" }
  });
  assert.equal(preview, "fallback objective");
});

process.stdout.write("\nAll monitor-daemon-view tests completed.\n");
