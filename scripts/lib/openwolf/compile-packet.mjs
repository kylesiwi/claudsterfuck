import fs from "node:fs";
import path from "node:path";

import { chunkAnatomy, chunkBuglog, chunkCerebrum, chunkIdentity } from "./chunk.mjs";
import { loadRawSources, requestedMemorySources } from "./load-raw-sources.mjs";
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

// Route-specific memory budgets (hard caps, always active)
const ROUTE_MEMORY_BUDGETS = Object.freeze({
  implement:          { maxChars: 900,  maxFacts: 6, perSourceMax: 2 },
  "implement-artifact": { maxChars: 900,  maxFacts: 6, perSourceMax: 2 },
  debug:              { maxChars: 900,  maxFacts: 6, perSourceMax: 2 },
  "review-feedback":  { maxChars: 1100, maxFacts: 6, perSourceMax: 2 },
  review:             { maxChars: 1100, maxFacts: 6, perSourceMax: 2 },
  "adversarial-review": { maxChars: 1100, maxFacts: 6, perSourceMax: 2 },
  design:             { maxChars: 1400, maxFacts: 6, perSourceMax: 2 },
  plan:               { maxChars: 1400, maxFacts: 6, perSourceMax: 2 }
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

function chunkSource(rawSource) {
  if (!rawSource.exists || typeof rawSource.content !== "string") {
    return {
      chunks: [],
      warnings: []
    };
  }

  if (rawSource.sourceName === "anatomy") {
    return {
      chunks: chunkAnatomy(rawSource.content, rawSource.sourcePath),
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

function selectChunks(scoredChunks, memoryPlan, route) {
  const budget = getRouteBudget(route);
  const excludedClasses = getExcludedClasses(route);

  // Use distillation budget if available, fall back to legacy memoryPlan
  const maxChunks = Math.min(
    budget.maxFacts,
    Number.isFinite(memoryPlan?.maxChunks) && memoryPlan.maxChunks > 0 ? memoryPlan.maxChunks : 8
  );
  const perSourceMax = budget.perSourceMax;

  const selected = [];
  const perSourceCounts = {};
  for (const chunk of scoredChunks) {
    if (chunk.score <= 0 || selected.length >= maxChunks) {
      continue;
    }

    // Distillation: exclude classes not relevant to this route
    const memoryClass = SOURCE_CLASS[chunk.sourceName] ?? "project-background";
    if (excludedClasses.has(memoryClass)) {
      continue;
    }

    const sourceCount = perSourceCounts[chunk.sourceName] ?? 0;
    if (sourceCount >= perSourceMax) {
      continue;
    }

    perSourceCounts[chunk.sourceName] = sourceCount + 1;
    selected.push(chunk);
  }

  return selected;
}

function selectFallbackChunks(allChunks, memoryPlan) {
  const maxChunks = Number.isFinite(memoryPlan?.maxChunks) && memoryPlan.maxChunks > 0 ? memoryPlan.maxChunks : 8;
  const selected = [];
  for (const sourceName of ["anatomy", "cerebrum"]) {
    const sourceChunks = allChunks
      .filter((chunk) => chunk.sourceName === sourceName)
      .sort((left, right) => left.position - right.position)
      .slice(0, 2);

    for (const chunk of sourceChunks) {
      if (selected.length >= maxChunks) {
        return selected;
      }
      selected.push({
        ...chunk,
        score: 0
      });
    }
  }

  return selected;
}

function renderChunk(chunk) {
  return `- \`${chunk.label}\`: ${chunk.text} (source: ${chunk.sourcePath}, score: ${chunk.score})`;
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

export function compileMemoryPacket({ workspaceRoot, objective, route, memoryPlan }) {
  if (!memoryPlan || !Array.isArray(memoryPlan.sources) || memoryPlan.sources.length === 0) {
    return {
      packet: "",
      usedSources: [],
      includedChunks: [],
      omittedSources: [],
      warnings: []
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
      warnings: [`OpenWolf directory not found at ${wolfDir}`]
    };
  }

  const rawSources = loadRawSources({ workspaceRoot, memoryPlan });
  const warnings = [];
  const allChunks = [];
  const sourceMetadata = new Map();

  for (const rawSource of rawSources) {
    const chunked = chunkSource(rawSource);
    warnings.push(...chunked.warnings);
    allChunks.push(...chunked.chunks);
    sourceMetadata.set(rawSource.sourceName, {
      sourcePath: rawSource.sourcePath,
      exists: rawSource.exists,
      warning: chunked.warnings.length > 0
    });
  }

  const { keywords, scoredChunks } = scoreChunks({
    chunks: allChunks,
    objective,
    route
  });

  let selectedChunks = selectChunks(scoredChunks, memoryPlan, route);
  if (selectedChunks.length === 0) {
    selectedChunks = selectFallbackChunks(allChunks, memoryPlan);
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

  return {
    packet,
    usedSources,
    includedChunks: selectedChunks.map((chunk) => ({
      source: chunk.sourcePath,
      label: chunk.label,
      score: chunk.score
    })),
    omittedSources,
    warnings
  };
}
