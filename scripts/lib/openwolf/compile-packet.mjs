import fs from "node:fs";
import path from "node:path";

import { chunkAnatomy, chunkBuglog, chunkCerebrum, chunkIdentity } from "./chunk.mjs";
import { loadEnrichedAnatomyMap, loadRawSources, requestedMemorySources } from "./load-raw-sources.mjs";
import { scoreChunks } from "./score.mjs";

// --- Memory Distillation: Source-level classification ---
// Maps .wolf/ source names to memory classes. Worker packets exclude
// control-plane and background classes by default for implementation routes.
const SOURCE_CLASS = Object.freeze({
  anatomy: "repo-structure",
  buglog: "known-failure-pattern",
  cerebrum: "execution-critical",  // Key Learnings + Do-Not-Repeat
  identity: "project-background"
});

// Route-specific memory budgets (hard caps, always active).
//
// PR 2 bumped 900/1100/1400 → 1800-2200 to fit 3-4 chunks with the 400-char
// per-chunk text cap. PR 3 enrichment appends LLM-backed summary+keywords+
// exports to each anatomy chunk, pushing rendered chunks closer to the cap
// ceiling (~530 chars each). Bumping another +400 to preserve diversity
// under enriched conditions. Trade-off: ~100 additional prompt tokens per
// dispatch, dramatically less than the re-discovery cost when the worker
// has to grep around for files enrichment would otherwise surface.
const ROUTE_MEMORY_BUDGETS = Object.freeze({
  implement:            { maxChars: 2300, maxFacts: 6, perSourceMax: 2 },
  "implement-artifact": { maxChars: 2300, maxFacts: 6, perSourceMax: 2 },
  debug:                { maxChars: 2300, maxFacts: 6, perSourceMax: 2 },
  "review-feedback":    { maxChars: 2300, maxFacts: 6, perSourceMax: 2 },
  review:               { maxChars: 2500, maxFacts: 6, perSourceMax: 2 },
  "adversarial-review": { maxChars: 2500, maxFacts: 6, perSourceMax: 2 },
  design:               { maxChars: 2700, maxFacts: 6, perSourceMax: 2 },
  plan:                 { maxChars: 2700, maxFacts: 6, perSourceMax: 2 }
});

// Classes to exclude from worker packets by route category
const EXCLUDED_CLASSES = Object.freeze({
  implement: new Set(["project-background", "control-plane-meta"]),
  debug:     new Set(["project-background", "control-plane-meta"]),
  review:    new Set(["control-plane-meta"]),
  design:    new Set([]),
  plan:      new Set([])
});

function getRouteBudget(route) {
  return ROUTE_MEMORY_BUDGETS[route] ?? { maxChars: 1400, maxFacts: 6, perSourceMax: 2 };
}

function getExcludedClasses(route) {
  // Map route to category for exclusion lookup
  if (["implement", "implement-artifact", "debug"].includes(route)) return EXCLUDED_CLASSES.implement;
  if (["review", "review-feedback", "adversarial-review"].includes(route)) return EXCLUDED_CLASSES.review;
  if (route === "design") return EXCLUDED_CLASSES.design;
  if (route === "plan") return EXCLUDED_CLASSES.plan;
  return EXCLUDED_CLASSES.implement; // default: strictest
}

function chunkSource(rawSource, context = {}) {
  if (!rawSource.exists || typeof rawSource.content !== "string") {
    return {
      chunks: [],
      warnings: []
    };
  }

  if (rawSource.sourceName === "anatomy") {
    return {
      chunks: chunkAnatomy(rawSource.content, rawSource.sourcePath, context.enrichedAnatomyMap),
      warnings: []
    };
  }

  if (rawSource.sourceName === "cerebrum") {
    return {
      chunks: chunkCerebrum(rawSource.content, rawSource.sourcePath),
      warnings: []
    };
  }

  if (rawSource.sourceName === "buglog") {
    return chunkBuglog(rawSource.content, rawSource.sourcePath);
  }

  if (rawSource.sourceName === "identity") {
    return {
      chunks: chunkIdentity(rawSource.content, rawSource.sourcePath),
      warnings: []
    };
  }

  return {
    chunks: [],
    warnings: []
  };
}

// Select up to maxChunks honoring per-source caps, then reorder the result
// to interleave sources (round-robin). The trimmer removes from the end, so
// interleaved ordering preserves source diversity under tight char budgets.
// Without interleaving, cerebrum chunks (often highest-scored and longest)
// cluster at the front and starve anatomy from the packet.
function selectChunks(scoredChunks, memoryPlan, route) {
  const budget = getRouteBudget(route);
  const excludedClasses = getExcludedClasses(route);

  const maxChunks = Math.min(
    budget.maxFacts,
    Number.isFinite(memoryPlan?.maxChunks) && memoryPlan.maxChunks > 0 ? memoryPlan.maxChunks : 8
  );
  const perSourceMax = budget.perSourceMax;

  const selectionOrder = [];
  const bySource = new Map();
  for (const chunk of scoredChunks) {
    if (chunk.score <= 0) continue;
    const memoryClass = SOURCE_CLASS[chunk.sourceName] ?? "project-background";
    if (excludedClasses.has(memoryClass)) continue;

    if (!bySource.has(chunk.sourceName)) {
      bySource.set(chunk.sourceName, []);
      selectionOrder.push(chunk.sourceName);
    }
    const list = bySource.get(chunk.sourceName);
    if (list.length < perSourceMax) {
      list.push(chunk);
    }
  }

  // Round-robin interleave across sources, respecting first-appearance order
  // (the source whose top chunk scored highest goes first in each round).
  const interleaved = [];
  let round = 0;
  while (interleaved.length < maxChunks) {
    let addedThisRound = false;
    for (const sourceName of selectionOrder) {
      const list = bySource.get(sourceName);
      if (list && round < list.length && interleaved.length < maxChunks) {
        interleaved.push(list[round]);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
    round += 1;
  }

  return interleaved;
}

// Anatomy entries in OpenWolf include a "(~N tok)" annotation per file.
// Parse that out as a proxy for architectural weight — large files (DEVELOPER.md,
// orchestrator.mjs) are empirically the ones a worker will need when lexical
// signal fails. Returns 0 when no annotation is present (tolerant).
function estimateAnatomyTokens(chunk) {
  if (chunk.sourceName !== "anatomy") {
    return 0;
  }
  const match = String(chunk.text ?? "").match(/\(~(\d+)\s*tok\)/);
  return match ? Number(match[1]) : 0;
}

// Fallback fires when lexical scoring produced no hits at all (typically a
// prose-heavy objective whose keywords don't substring-match any anatomy
// description). Size-ranking biases toward architecturally heavy files — they
// correlate with the files a worker would otherwise discover via grep/read.
function selectFallbackChunks(allChunks, memoryPlan) {
  const maxChunks = Number.isFinite(memoryPlan?.maxChunks) && memoryPlan.maxChunks > 0 ? memoryPlan.maxChunks : 8;
  const selected = [];

  const anatomyBySize = allChunks
    .filter((chunk) => chunk.sourceName === "anatomy")
    .map((chunk) => ({ chunk, tokens: estimateAnatomyTokens(chunk) }))
    .sort((left, right) => right.tokens - left.tokens || left.chunk.position - right.chunk.position)
    .map((entry) => entry.chunk);

  const anatomyQuota = Math.max(1, maxChunks - 2);
  for (const chunk of anatomyBySize.slice(0, anatomyQuota)) {
    if (selected.length >= maxChunks) break;
    selected.push({ ...chunk, score: 0 });
  }

  const cerebrumChunks = allChunks
    .filter((chunk) => chunk.sourceName === "cerebrum")
    .sort((left, right) => left.position - right.position)
    .slice(0, 2);
  for (const chunk of cerebrumChunks) {
    if (selected.length >= maxChunks) break;
    selected.push({ ...chunk, score: 0 });
  }

  return selected;
}

// Composite packet quality verdict. Used for observability and future
// alarm/learning. "empty" should no longer occur now that fallback is
// size-ranked — if it does, something is structurally wrong with inputs.
function computeQualityScore({
  rawTokenCount,
  keywordsKept,
  selectedChunks,
  usedFallback
}) {
  const keywordsDropped = Math.max(0, rawTokenCount - keywordsKept);
  const topChunkScore = selectedChunks[0]?.score ?? 0;
  const distinctSources = new Set(selectedChunks.map((chunk) => chunk.sourcePath)).size;
  const totalChunks = selectedChunks.length;

  let quality = "ok";
  if (totalChunks === 0) {
    quality = "empty";
  } else if (usedFallback || topChunkScore < 2 || distinctSources < 2) {
    quality = "weak";
  }

  return {
    quality,
    keywordsKept,
    keywordsDropped,
    topChunkScore,
    distinctSources,
    usedFallback,
    totalChunks
  };
}

// Raw-token count is needed for keywordsDropped accounting in the quality
// score. We mirror the tokenization from sanitize.mjs extractObjectiveTerms
// rather than couple to it — a simpler split is sufficient for the count.
function countRawTokens(objective) {
  return String(objective ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .length;
}

// Hard per-chunk cap. Cerebrum chunks are a single heading + N joined bullets,
// which can reach several thousand chars for heavings like Do-Not-Repeat. One
// oversized chunk starves the route's packet budget and the per-chunk-strip
// trimmer can't recover (it just deletes the monster from the tail-end after
// the budget has already been blown). Capping per-chunk text makes the trimmer
// well-behaved under any route budget.
const MAX_CHUNK_TEXT_CHARS = 400;

function truncateChunkText(text) {
  const clean = String(text ?? "");
  if (clean.length <= MAX_CHUNK_TEXT_CHARS) {
    return clean;
  }
  return `${clean.slice(0, MAX_CHUNK_TEXT_CHARS - 3)}...`;
}

function renderChunk(chunk) {
  return `- \`${chunk.label}\`: ${truncateChunkText(chunk.text)} (source: ${chunk.sourcePath}, score: ${chunk.score})`;
}

function buildPacket({ keywords, selectedChunks, sourceNotes }) {
  const anatomyChunks = selectedChunks.filter((chunk) => chunk.sourceName === "anatomy");
  const decisionChunks = selectedChunks.filter((chunk) => ["cerebrum", "identity"].includes(chunk.sourceName));
  const bugChunks = selectedChunks.filter((chunk) => chunk.sourceName === "buglog");
  const lines = ["## Memory Packet", "", `Objective keywords: ${keywords.join(", ") || "(none)"}`];

  if (anatomyChunks.length > 0) {
    lines.push("", "### Relevant Files", ...anatomyChunks.map(renderChunk));
  }

  if (decisionChunks.length > 0) {
    lines.push("", "### Prior Decisions / Learnings", ...decisionChunks.map(renderChunk));
  }

  if (bugChunks.length > 0) {
    lines.push("", "### Known Failure Patterns", ...bugChunks.map(renderChunk));
  }

  lines.push("", "### Source Notes", ...sourceNotes.map((note) => `- ${note}`), "");
  return lines.join("\n");
}

export function compileMemoryPacket({ workspaceRoot, objective, route, memoryPlan, vocabulary }) {
  if (!memoryPlan || !Array.isArray(memoryPlan.sources) || memoryPlan.sources.length === 0) {
    return {
      packet: "",
      usedSources: [],
      includedChunks: [],
      omittedSources: [],
      warnings: [],
      qualityScore: {
        quality: "empty",
        keywordsKept: 0,
        keywordsDropped: 0,
        topChunkScore: 0,
        distinctSources: 0,
        usedFallback: false,
        totalChunks: 0
      }
    };
  }

  const requestedSources = requestedMemorySources(memoryPlan);
  const wolfDir = path.join(workspaceRoot, ".wolf");
  if (!fs.existsSync(wolfDir)) {
    return {
      packet: "",
      usedSources: [],
      includedChunks: [],
      omittedSources: requestedSources.map((sourceName) => `.wolf/${sourceName === "buglog" ? "buglog.json" : `${sourceName}.md`}`),
      warnings: [`OpenWolf directory not found at ${wolfDir}`],
      qualityScore: {
        quality: "empty",
        keywordsKept: 0,
        keywordsDropped: 0,
        topChunkScore: 0,
        distinctSources: 0,
        usedFallback: false,
        totalChunks: 0
      }
    };
  }

  const rawSources = loadRawSources({ workspaceRoot, memoryPlan });
  const enrichedAnatomyMap = loadEnrichedAnatomyMap(workspaceRoot);
  const warnings = [];
  const allChunks = [];
  const sourceMetadata = new Map();

  for (const rawSource of rawSources) {
    const chunked = chunkSource(rawSource, { enrichedAnatomyMap });
    warnings.push(...chunked.warnings);
    allChunks.push(...chunked.chunks);
    sourceMetadata.set(rawSource.sourceName, {
      sourcePath: rawSource.sourcePath,
      exists: rawSource.exists,
      warning: chunked.warnings.length > 0
    });
  }

  const { keywords, scoredChunks, expansion } = scoreChunks({
    chunks: allChunks,
    objective,
    route,
    vocabulary
  });

  let selectedChunks = selectChunks(scoredChunks, memoryPlan, route);
  let usedFallback = false;
  if (selectedChunks.length === 0) {
    selectedChunks = selectFallbackChunks(allChunks, memoryPlan);
    usedFallback = true;
  }

  // Use route-specific budget cap, falling back to memoryPlan, then default
  const routeBudget = getRouteBudget(route);
  const maxChars = Math.min(
    routeBudget.maxChars,
    Number.isFinite(memoryPlan.maxChars) && memoryPlan.maxChars > 0 ? memoryPlan.maxChars : 6000
  );
  const buildSourceNotes = (chunks) =>
    requestedSources.map((sourceName) => {
      const metadata = sourceMetadata.get(sourceName) ?? {
        sourcePath: sourceName,
        exists: false,
        warning: false
      };
      const used = chunks.some((chunk) => chunk.sourceName === sourceName);
      let status = "no-match";
      if (!metadata.exists) {
        status = "missing";
      } else if (metadata.warning) {
        status = "warning";
      } else if (used) {
        status = "used";
      }

      return `${metadata.sourcePath}: ${status}`;
    });

  let packet = buildPacket({
    keywords,
    selectedChunks,
    sourceNotes: buildSourceNotes(selectedChunks)
  });

  while (packet.length > maxChars && selectedChunks.length > 0) {
    selectedChunks = selectedChunks.slice(0, -1);
    packet = buildPacket({
      keywords,
      selectedChunks,
      sourceNotes: buildSourceNotes(selectedChunks)
    });
  }

  const usedSources = [...new Set(selectedChunks.map((chunk) => chunk.sourcePath))];
  const omittedSources = requestedSources
    .map((sourceName) => sourceMetadata.get(sourceName)?.sourcePath ?? sourceName)
    .filter((sourcePath) => !usedSources.includes(sourcePath));

  const qualityScore = computeQualityScore({
    rawTokenCount: countRawTokens(objective),
    keywordsKept: keywords.length,
    selectedChunks,
    usedFallback
  });
  if (expansion) {
    qualityScore.expansionClassesApplied = expansion.appliedClassCount ?? 0;
    qualityScore.expandedKeywordCount = Array.isArray(expansion.expanded)
      ? Math.max(0, expansion.expanded.length - keywords.length)
      : 0;
  } else {
    qualityScore.expansionClassesApplied = 0;
    qualityScore.expandedKeywordCount = 0;
  }

  return {
    packet,
    usedSources,
    includedChunks: selectedChunks.map((chunk) => ({
      source: chunk.sourcePath,
      label: chunk.label,
      score: chunk.score
    })),
    omittedSources,
    warnings,
    qualityScore
  };
}
