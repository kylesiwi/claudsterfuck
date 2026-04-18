#!/usr/bin/env node
// Benchmark harness for packet-compiler quality across realistic objectives.
// Run before and after retrieval changes to quantify regressions and wins.
//
//   node scripts/lib/openwolf/benchmark.mjs            # human-readable table
//   node scripts/lib/openwolf/benchmark.mjs --json     # machine output
//
// The fixtures below are curated to exercise multiple route types, multiple
// vocabulary registers (architectural, debugging, policy, memory), and the
// original gemini-c421c568 failure case.

import process from "node:process";

import { compileMemoryPacket } from "./compile-packet.mjs";
import { loadRouteProfile } from "../../routing/lib/config.mjs";

const WORKSPACE = process.cwd();

// Each fixture has both a `rawObjective` (the kind of thing a user actually
// types) and a `refinedObjective` (what Claude should produce per the
// refinement template in SKILL.md). The dual-run mode compares retrieval
// quality between these two forms to measure the contribution of objective
// refinement in isolation from corpus quality.
//
// Refinement template: [task-type] [affected-systems] — [concrete-goal]
const FIXTURES = [
  {
    id: "F1-design-failure-case",
    route: "design",
    rawObjective:
      "Look into what are the possible approaches for setting specific models per provider through CLI in the dispatch calls",
    refinedObjective:
      "[configuration-design] [orchestrator, dispatch, route-config, provider-spawn, CLI-flags] — Design how per-provider model selection is passed via CLI flags through orchestrator dispatch into codex and gemini provider spawn args.",
    expectSurfaces: ["orchestrator.mjs", "providers.mjs"],
    note: "Original gemini-c421c568 failure — 27 tool calls, 694K tokens"
  },
  {
    id: "F2-implement-model-flag",
    route: "implement",
    rawObjective:
      "Add a --model flag to the dispatch command that plumbs through to provider args builders",
    refinedObjective:
      "[implementation-change] [orchestrator, dispatch, CLI-flags, parseArgs, buildCodexArgs, buildGeminiArgs] — Add a --model flag on dispatch, parse in parseArgs, plumb through into buildCodexArgs and buildGeminiArgs.",
    expectSurfaces: ["orchestrator.mjs", "providers.mjs"]
  },
  {
    id: "F3-debug-windows-spawn",
    route: "debug",
    rawObjective:
      "Codex is not spawning on Windows, investigate why the process fails silently",
    refinedObjective:
      "[debug-investigation] [providers, spawn, detached, Windows, codex-binary, resolveCodexNativeBinary] — Investigate silent Codex spawn failure on Windows, checking detached process lifecycle, windowsHide behavior, and native binary resolution.",
    expectSurfaces: ["providers.mjs"]
  },
  {
    id: "F4-design-hook-pipeline",
    route: "design",
    rawObjective:
      "Design a new hook that fires on worker completion and summarizes token usage",
    refinedObjective:
      "[architecture-design] [hooks, UserPromptSubmit, orchestrator, finalize, tokenUsage, run-record] — Design a new completion hook that fires after finalizeRun, reads tokenUsage from the run record, and summarizes for user feedback.",
    expectSurfaces: ["hooks.json", "user-prompt-submit-hook.mjs", "orchestrator.mjs"]
  },
  {
    id: "F5-plan-rollout",
    route: "plan",
    rawObjective:
      "Plan the rollout of the packet compiler rewrite into five sequenced PRs",
    refinedObjective:
      "[plan-synthesis] [packet, compile-packet, anatomy, cerebrum, retrieval, chunk, score, sanitize] — Plan the rollout of packet compiler changes across five sequenced PRs touching sanitize, compile-packet, chunk, score, and assemble-worker-prompt.",
    expectSurfaces: ["compile-packet.mjs"]
  },
  {
    id: "F6-review-changes",
    route: "review",
    rawObjective:
      "Review the recent changes to compile-packet.mjs for completeness and correctness",
    refinedObjective:
      "[code-review] [packet, compile-packet, qualityScore, chunking, interleave, fallback] — Review recent changes to compile-packet.mjs: stopword expansion, size-ranked fallback, qualityScore shape, per-bullet chunking, interleaved source selection.",
    expectSurfaces: ["compile-packet.mjs"]
  },
  {
    id: "F7-policy-agent-denial",
    route: "implement",
    rawObjective:
      "Add a PreToolUse denial for Agent tool invocations during routed turns",
    refinedObjective:
      "[implementation-change] [policy, PreToolUse, hook, permission, routed-turns, Agent] — Add Agent tool denial in policy.mjs evaluatePreToolUse, branching on route.requiresDelegation and tool name.",
    expectSurfaces: ["policy.mjs", "pre-tool-use-hook.mjs"]
  },
  {
    id: "F8-memory-refactor",
    route: "design",
    rawObjective:
      "Refactor anatomy compilation to include richer structural descriptions from markdown files",
    refinedObjective:
      "[architecture-design] [packet, anatomy, compile-packet, chunk, openwolf, enrichment, sanitize] — Refactor anatomy compilation flow to include richer structural descriptions from markdown H1/H2 and from JSDoc/export lists.",
    expectSurfaces: ["compile-packet.mjs"]
  }
];

function runFixtureWithObjective(fixture, objective) {
  const route = loadRouteProfile(fixture.route);
  const compiled = compileMemoryPacket({
    workspaceRoot: WORKSPACE,
    objective,
    route: route.route,
    memoryPlan: route.defaultMemoryPlan,
    vocabulary: route.vocabulary
  });

  const includedSources = [...new Set(
    compiled.includedChunks.map((chunk) => {
      const match = chunk.label.match(/^([\w.\-/]+)/);
      return match ? match[1].replace(/`$/, "") : chunk.source;
    })
  )];

  const surfaceHits = fixture.expectSurfaces.filter((expected) =>
    includedSources.some((included) => included.includes(expected))
  );

  return {
    id: fixture.id,
    route: fixture.route,
    keywords: extractKeywords(compiled.packet),
    quality: compiled.qualityScore.quality,
    topChunkScore: compiled.qualityScore.topChunkScore,
    distinctSources: compiled.qualityScore.distinctSources,
    usedFallback: compiled.qualityScore.usedFallback,
    totalChunks: compiled.qualityScore.totalChunks,
    expansionClassesApplied: compiled.qualityScore.expansionClassesApplied ?? 0,
    expectedSurfaces: fixture.expectSurfaces,
    surfaceHits,
    surfaceHitRatio: surfaceHits.length / fixture.expectSurfaces.length,
    includedChunkLabels: compiled.includedChunks.map((chunk) => chunk.label.slice(0, 50)),
    includedSources
  };
}

function runFixture(fixture) {
  // Back-compat: default run uses rawObjective. For new callers, use
  // runFixtureWithObjective directly to select raw vs refined.
  return runFixtureWithObjective(fixture, fixture.rawObjective ?? fixture.objective);
}

function extractKeywords(packet) {
  const match = String(packet ?? "").match(/Objective keywords: ([^\n]+)/);
  return match ? match[1].split(/,\s*/) : [];
}

function formatTable(results) {
  const headers = ["ID", "Route", "Quality", "TopScore", "Chunks", "Fallback", "Surfaces", "HitRatio"];
  const rows = results.map((r) => [
    r.id,
    r.route,
    r.quality,
    String(r.topChunkScore),
    String(r.totalChunks),
    r.usedFallback ? "yes" : "no",
    `${r.surfaceHits.length}/${r.expectedSurfaces.length}`,
    `${(r.surfaceHitRatio * 100).toFixed(0)}%`
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  const out = [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
  return out.join("\n");
}

function aggregates(results) {
  const total = results.length;
  const qualityOk = results.filter((r) => r.quality === "ok").length;
  const fallbackFired = results.filter((r) => r.usedFallback).length;
  const avgHitRatio = results.reduce((acc, r) => acc + r.surfaceHitRatio, 0) / total;
  const totalSurfaceHits = results.reduce((acc, r) => acc + r.surfaceHits.length, 0);
  const totalExpected = results.reduce((acc, r) => acc + r.expectedSurfaces.length, 0);
  return {
    fixtures: total,
    qualityOk,
    qualityOkRate: qualityOk / total,
    fallbackFired,
    avgSurfaceHitRatio: avgHitRatio,
    totalSurfaceHits,
    totalExpected,
    overallSurfaceRecall: totalSurfaceHits / totalExpected
  };
}

function formatCompareTable(pairs) {
  const headers = ["ID", "Route", "RawQ", "RefQ", "RawTop", "RefTop", "RawHit", "RefHit", "Δ"];
  const rows = pairs.map(({ raw, refined }) => [
    raw.id,
    raw.route,
    raw.quality,
    refined.quality,
    raw.topChunkScore.toFixed(1),
    refined.topChunkScore.toFixed(1),
    `${raw.surfaceHits.length}/${raw.expectedSurfaces.length}`,
    `${refined.surfaceHits.length}/${refined.expectedSurfaces.length}`,
    String(refined.surfaceHits.length - raw.surfaceHits.length)
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function main() {
  const json = process.argv.includes("--json");
  const compare = process.argv.includes("--compare");

  if (compare) {
    const pairs = FIXTURES.map((fixture) => ({
      raw: runFixtureWithObjective(fixture, fixture.rawObjective),
      refined: runFixtureWithObjective(fixture, fixture.refinedObjective)
    }));
    const aggRaw = aggregates(pairs.map((p) => p.raw));
    const aggRef = aggregates(pairs.map((p) => p.refined));

    if (json) {
      process.stdout.write(`${JSON.stringify({ raw: aggRaw, refined: aggRef, pairs }, null, 2)}\n`);
      return;
    }

    process.stdout.write(formatCompareTable(pairs));
    process.stdout.write("\n\n");
    process.stdout.write(
      `RAW:      ${aggRaw.qualityOk}/${aggRaw.fixtures} quality=ok · ` +
      `surface recall ${(aggRaw.overallSurfaceRecall * 100).toFixed(0)}% ` +
      `(${aggRaw.totalSurfaceHits}/${aggRaw.totalExpected})\n`
    );
    process.stdout.write(
      `REFINED:  ${aggRef.qualityOk}/${aggRef.fixtures} quality=ok · ` +
      `surface recall ${(aggRef.overallSurfaceRecall * 100).toFixed(0)}% ` +
      `(${aggRef.totalSurfaceHits}/${aggRef.totalExpected})\n`
    );
    const deltaHits = aggRef.totalSurfaceHits - aggRaw.totalSurfaceHits;
    const deltaRecallPct = ((aggRef.overallSurfaceRecall - aggRaw.overallSurfaceRecall) * 100);
    process.stdout.write(
      `Δ:        +${deltaHits} surface hits · ${deltaRecallPct >= 0 ? "+" : ""}${deltaRecallPct.toFixed(0)}pp recall\n`
    );
    return;
  }

  const results = FIXTURES.map(runFixture);
  const agg = aggregates(results);

  if (json) {
    process.stdout.write(`${JSON.stringify({ aggregates: agg, results }, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatTable(results));
  process.stdout.write("\n\n");
  process.stdout.write(
    `Aggregates: ${agg.qualityOk}/${agg.fixtures} quality=ok · ` +
    `${agg.fallbackFired}/${agg.fixtures} fallback · ` +
    `surface recall ${(agg.overallSurfaceRecall * 100).toFixed(0)}% ` +
    `(${agg.totalSurfaceHits}/${agg.totalExpected} expected files surfaced)\n`
  );
}

main();
