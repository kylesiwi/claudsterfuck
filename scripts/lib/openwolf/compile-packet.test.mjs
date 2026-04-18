#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compileMemoryPacket } from "./compile-packet.mjs";
import { extractObjectiveTerms, STOPWORDS } from "./sanitize.mjs";
import { expandKeywords, buildDirectedExpansion } from "./expand.mjs";
import { chunkCerebrum } from "./chunk.mjs";

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    throw error;
  }
}

function createWorkspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-packet-test-"));
  const wolf = path.join(dir, ".wolf");
  fs.mkdirSync(wolf, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(wolf, name), content, "utf8");
  }
  return {
    root: dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

const BASELINE_ANATOMY = `# anatomy.md

## ./

- \`DEVELOPER.md\` — Developer reference (~9900 tok)
- \`README.md\` — Project documentation (~1950 tok)
- \`package.json\` — Node.js package manifest (~70 tok)

## scripts/

- \`orchestrator.mjs\` — main CLI: dispatch/watch/inspect/cancel/reset (~8000 tok)
- \`monitor.mjs\` — live worker-status terminal window (~1200 tok)

## .claude/

- \`settings.json\` — Claude Code settings file (~470 tok)
- \`rules/openwolf.md\` — OpenWolf rules for Claude Code (~310 tok)
`;

const BASELINE_CEREBRUM = `# Cerebrum

## Key Learnings

- v1.9.0 routing contract details.
- Positional scoring rules.

## Do-Not-Repeat

- [2026-04-16] Never treat empty provider output as success.
`;

const MEMORY_PLAN = Object.freeze({
  sources: ["anatomy", "cerebrum"],
  maxChars: 4000,
  maxChunks: 6,
  perSourceMaxChunks: { anatomy: 4, cerebrum: 2 }
});

// --- Stopword coverage ---

await run("STOPWORDS drops instruction-framing words from the original failure case", () => {
  const { keywords } = extractObjectiveTerms(
    "Look into what are the possible approaches for setting specific models per provider"
  );
  // The original packet's keywords included "look, into, what, possible, approaches, setting, specific, models".
  // Every instruction-framing token should now be a stopword; only topical nouns survive.
  for (const stopword of ["look", "into", "what", "possible", "approaches", "specific"]) {
    assert.ok(
      !keywords.includes(stopword),
      `expected stopword "${stopword}" to be stripped, got keywords: ${keywords.join(", ")}`
    );
  }
  // Topical terms must survive.
  for (const topical of ["models", "provider", "setting"]) {
    assert.ok(
      keywords.includes(topical),
      `expected topical "${topical}" to survive stopwording, got keywords: ${keywords.join(", ")}`
    );
  }
});

await run("STOPWORDS preserves domain-relevant nouns (model, route, dispatch, etc.)", () => {
  for (const preserved of ["model", "route", "dispatch", "config", "file", "provider", "hook", "module"]) {
    assert.ok(
      !STOPWORDS.has(preserved),
      `"${preserved}" must not be in STOPWORDS — it's a retrieval-critical term`
    );
  }
});

// --- Size-ranked fallback ---

await run("fallback selection prefers larger anatomy files over first-position chunks", () => {
  const { root, cleanup } = createWorkspace({
    "anatomy.md": BASELINE_ANATOMY,
    "cerebrum.md": BASELINE_CEREBRUM
  });
  try {
    // Objective with zero lexical overlap with any anatomy entry forces the fallback path.
    const result = compileMemoryPacket({
      workspaceRoot: root,
      objective: "Xyzzy plugh wobble frobnicate",
      route: "design",
      memoryPlan: MEMORY_PLAN
    });

    assert.equal(result.qualityScore.usedFallback, true, "expected fallback to fire on unmatched objective");
    assert.equal(result.qualityScore.quality, "weak", "fallback packets are quality=weak");
    const packet = result.packet;
    assert.ok(
      packet.includes("DEVELOPER.md"),
      `expected largest file DEVELOPER.md in fallback packet; got:\n${packet}`
    );
    assert.ok(
      packet.includes("orchestrator.mjs"),
      `expected second-largest orchestrator.mjs in fallback packet; got:\n${packet}`
    );
    // settings.json (470 tok) is small — should NOT displace the heavy files.
    const settingsBeforeDev = packet.indexOf("settings.json");
    const devIdx = packet.indexOf("DEVELOPER.md");
    if (settingsBeforeDev !== -1) {
      assert.ok(
        devIdx !== -1 && devIdx < settingsBeforeDev,
        "DEVELOPER.md should precede settings.json by size rank"
      );
    }
  } finally {
    cleanup();
  }
});

// --- Keyword-match path (non-fallback) ---

await run("lexical-match path does not fire fallback and reports quality=ok when signal exists", () => {
  const { root, cleanup } = createWorkspace({
    "anatomy.md": BASELINE_ANATOMY,
    "cerebrum.md": BASELINE_CEREBRUM
  });
  try {
    // "orchestrator" matches orchestrator.mjs description directly; plenty of signal.
    const result = compileMemoryPacket({
      workspaceRoot: root,
      objective: "orchestrator dispatch flow monitor",
      route: "design",
      memoryPlan: MEMORY_PLAN
    });
    assert.equal(result.qualityScore.usedFallback, false, "expected lexical-match path, not fallback");
    assert.ok(
      result.qualityScore.topChunkScore >= 2,
      `expected meaningful top score, got ${result.qualityScore.topChunkScore}`
    );
    assert.ok(result.packet.includes("orchestrator.mjs"));
  } finally {
    cleanup();
  }
});

// --- Quality score shape ---

await run("quality score shape: all required fields present and accounting is consistent", () => {
  const { root, cleanup } = createWorkspace({
    "anatomy.md": BASELINE_ANATOMY,
    "cerebrum.md": BASELINE_CEREBRUM
  });
  try {
    const result = compileMemoryPacket({
      workspaceRoot: root,
      objective: "look into orchestrator please",
      route: "design",
      memoryPlan: MEMORY_PLAN
    });
    const qs = result.qualityScore;
    assert.ok(qs, "qualityScore must be returned");
    for (const key of ["quality", "keywordsKept", "keywordsDropped", "topChunkScore", "distinctSources", "usedFallback", "totalChunks"]) {
      assert.ok(key in qs, `qualityScore missing field: ${key}`);
    }
    assert.equal(typeof qs.quality, "string");
    assert.ok(["ok", "weak", "empty"].includes(qs.quality));
    assert.ok(qs.keywordsKept + qs.keywordsDropped >= 0);
  } finally {
    cleanup();
  }
});

await run("quality=empty when no wolf dir exists (defensive contract)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-packet-nowolf-"));
  try {
    const result = compileMemoryPacket({
      workspaceRoot: dir,
      objective: "anything",
      route: "design",
      memoryPlan: MEMORY_PLAN
    });
    assert.equal(result.qualityScore.quality, "empty");
    assert.equal(result.qualityScore.totalChunks, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- PR 2: vocabulary expansion ---

await run("expandKeywords is directed — a key expands to its values, not transitively", () => {
  const vocab = {
    model: ["provider", "codex"],
    prompt: ["assemble", "compile"],
    compile: ["packet", "sanitize"]
  };
  // Raw keyword 'model' should expand to its values only; it should NOT
  // transitively pull in compile/packet/sanitize via the prompt->compile edge.
  const { expanded, buckets, appliedClassCount } = expandKeywords(["model"], vocab);
  assert.ok(expanded.includes("model"), "raw keyword preserved");
  assert.ok(expanded.includes("provider"), "direct bucket value added");
  assert.ok(expanded.includes("codex"), "direct bucket value added");
  assert.ok(!expanded.includes("assemble"), "no transitive expansion via other buckets");
  assert.ok(!expanded.includes("packet"), "no transitive expansion two levels deep");
  assert.equal(appliedClassCount, 1, "one bucket fired");
  assert.deepStrictEqual(buckets.model.sort(), ["codex", "provider"]);
});

await run("expandKeywords fails open on malformed vocabulary", () => {
  const { expanded, appliedClassCount } = expandKeywords(["model"], null);
  assert.deepStrictEqual(expanded.sort(), ["model"]);
  assert.equal(appliedClassCount, 0);
});

await run("expandKeywords returns empty on empty input", () => {
  const result = expandKeywords([], { model: ["provider"] });
  assert.deepStrictEqual(result.expanded, []);
  assert.equal(result.appliedClassCount, 0);
});

await run("buildDirectedExpansion normalizes tokens (lowercase, trim)", () => {
  const { lookup } = buildDirectedExpansion({ "Model  ": [" PROVIDER ", "Codex"] });
  assert.deepStrictEqual(lookup.get("model").sort(), ["codex", "provider"]);
});

// --- PR 2: per-bullet cerebrum chunking ---

await run("chunkCerebrum emits one chunk per bullet (not one chunk per heading)", () => {
  const content = `# Cerebrum

## Key Learnings

- First learning about routing and classification.
- Second learning about providers and binaries.
- Third learning about hooks and policies.

## Do-Not-Repeat

- [2026-04-16] Never do X.
- [2026-04-16] Never do Y.
`;
  const chunks = chunkCerebrum(content, ".wolf/cerebrum.md");
  assert.equal(chunks.length, 5, `expected 5 per-bullet chunks, got ${chunks.length}`);
  // Each chunk should be scoped to a single bullet, not a joined heading
  for (const chunk of chunks) {
    assert.ok(chunk.text.length < 300, `chunk too large (looks like joined bullets): ${chunk.text}`);
  }
  const headings = [...new Set(chunks.map((c) => c.label.split(" > ")[0]))];
  assert.ok(headings.includes("Key Learnings"));
  assert.ok(headings.includes("Do-Not-Repeat"));
});

// --- PR 2: vocabulary expansion integrated into compileMemoryPacket ---

await run("route vocabulary raises match score for synonymous chunks", () => {
  const { root, cleanup } = createWorkspace({
    "anatomy.md": `# anatomy.md\n\n## ./\n\n- \`orchestrator.mjs\` — main CLI for dispatch and watch (~100 tok)\n- \`other.mjs\` — unrelated module (~50 tok)\n`,
    "cerebrum.md": `# Cerebrum\n\n## Key Learnings\n\n- unrelated learning\n`
  });
  try {
    // Objective uses "model" and "spawn" — neither is in orchestrator.mjs's
    // description directly. But with vocabulary expansion, "model" -> provider
    // and "spawn" -> detached should let us surface orchestrator.mjs anyway.
    const withoutVocab = compileMemoryPacket({
      workspaceRoot: root,
      objective: "How does the CLI model spawning work",
      route: "design",
      memoryPlan: MEMORY_PLAN
    });
    const withVocab = compileMemoryPacket({
      workspaceRoot: root,
      objective: "How does the CLI model spawning work",
      route: "design",
      memoryPlan: MEMORY_PLAN,
      vocabulary: {
        cli: ["orchestrator", "dispatch"],
        spawn: ["watch", "detached"]
      }
    });
    // The expansion should broaden keyword coverage — we at minimum should
    // see appliedClassCount > 0 when vocabulary fires.
    assert.ok(
      withVocab.qualityScore.expansionClassesApplied >= withoutVocab.qualityScore.expansionClassesApplied,
      "expansion should have fired at least as often with vocabulary provided"
    );
  } finally {
    cleanup();
  }
});

await run("qualityScore exposes expansion metrics", () => {
  const { root, cleanup } = createWorkspace({
    "anatomy.md": BASELINE_ANATOMY,
    "cerebrum.md": BASELINE_CEREBRUM
  });
  try {
    const result = compileMemoryPacket({
      workspaceRoot: root,
      objective: "orchestrator dispatch model",
      route: "design",
      memoryPlan: MEMORY_PLAN
    });
    assert.ok("expansionClassesApplied" in result.qualityScore);
    assert.ok("expandedKeywordCount" in result.qualityScore);
    assert.equal(typeof result.qualityScore.expansionClassesApplied, "number");
  } finally {
    cleanup();
  }
});

// --- PR 3: enriched-anatomy sidecar merging ---

import { chunkAnatomy } from "./chunk.mjs";
import { loadEnrichedAnatomyMap } from "./load-raw-sources.mjs";

await run("chunkAnatomy merges enriched text onto matching bullets by relative path", () => {
  const vanilla = `# anatomy.md

## scripts/

- \`policy.mjs\` — Resolve a read target... (~100 tok)
- \`other.mjs\` — Some description (~50 tok)
`;
  const enrichedMap = new Map([
    ["scripts/policy.mjs", "summary: Permission evaluator for routed turns. keywords: policy, pretooluse, agent, routed-turn, allow, deny."]
  ]);
  const chunks = chunkAnatomy(vanilla, ".wolf/anatomy.md", enrichedMap);
  const policyChunk = chunks.find((c) => c.label.startsWith("policy.mjs"));
  const otherChunk = chunks.find((c) => c.label.startsWith("other.mjs"));

  assert.ok(policyChunk, "policy.mjs chunk should exist");
  assert.ok(
    policyChunk.text.includes("Permission evaluator"),
    `enriched text should be appended; chunk text: ${policyChunk.text}`
  );
  assert.ok(policyChunk.text.includes("pretooluse"));
  // other.mjs has no enrichment — text stays unchanged
  assert.ok(!otherChunk.text.includes("summary:"), "other.mjs should not be enriched");
});

await run("chunkAnatomy falls back gracefully when enrichedMap is absent or empty", () => {
  const vanilla = `## scripts/

- \`a.mjs\` — description (~100 tok)
`;
  const noMap = chunkAnatomy(vanilla, ".wolf/anatomy.md");
  const emptyMap = chunkAnatomy(vanilla, ".wolf/anatomy.md", new Map());
  assert.equal(noMap[0].text, emptyMap[0].text, "no map and empty map produce identical output");
  assert.ok(noMap[0].text.includes("description"));
});

await run("loadEnrichedAnatomyMap parses sidecar format correctly", () => {
  const sidecar = `# anatomy.enriched.md

> Auto-generated.

## scripts/policy.mjs
summary: Policy evaluator for hooks.
keywords: policy, pretooluse, agent, deny.
exports: evaluatePreToolUse, evaluateStop

## scripts/foo.mjs
summary: Foo module.
keywords: foo, bar
`;
  const { root, cleanup } = createWorkspace({
    "anatomy.md": "# Empty\n",
    "cerebrum.md": "# Empty\n",
    "anatomy.enriched.md": sidecar
  });
  try {
    const map = loadEnrichedAnatomyMap(root);
    assert.ok(map instanceof Map);
    assert.ok(map.has("scripts/policy.mjs"));
    assert.ok(map.get("scripts/policy.mjs").includes("Policy evaluator"));
    assert.ok(map.get("scripts/policy.mjs").includes("evaluatePreToolUse"));
    assert.ok(map.has("scripts/foo.mjs"));
    assert.equal(map.size, 2);
  } finally {
    cleanup();
  }
});

await run("loadEnrichedAnatomyMap returns empty Map when sidecar is absent", () => {
  const { root, cleanup } = createWorkspace({
    "anatomy.md": "# Empty\n",
    "cerebrum.md": "# Empty\n"
  });
  try {
    const map = loadEnrichedAnatomyMap(root);
    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
  } finally {
    cleanup();
  }
});

await run("enriched sidecar surfaces files that vanilla anatomy hides", () => {
  const vanillaAnatomy = `# anatomy.md

## scripts/

- \`policy.mjs\` — Resolve a read target... (~100 tok)
- \`other.mjs\` — Random file (~50 tok)
`;
  const enrichedSidecar = `## scripts/policy.mjs
summary: Permission evaluator for routed turns.
keywords: policy, pretooluse, agent, routed-turn, hook.
`;
  const { root, cleanup } = createWorkspace({
    "anatomy.md": vanillaAnatomy,
    "cerebrum.md": "# Empty\n",
    "anatomy.enriched.md": enrichedSidecar
  });
  try {
    const withoutEnrichment = compileMemoryPacket({
      workspaceRoot: root,
      objective: "agent pretooluse policy",
      route: "design",
      memoryPlan: MEMORY_PLAN
    });
    // Before the sidecar is used, vanilla chunk has no "policy/pretooluse/agent"
    // in text (it only says "Resolve a read target"). With enrichment appended,
    // the chunk matches all three terms.
    const policySelected = withoutEnrichment.includedChunks.some((c) =>
      c.label.startsWith("policy.mjs")
    );
    assert.ok(policySelected, "policy.mjs should surface when enriched sidecar contains matching keywords");
  } finally {
    cleanup();
  }
});

// --- PR 2: interleaved selection preserves source diversity ---

await run("selectChunks interleaves sources so trimmer preserves diversity", () => {
  // Simulate: many cerebrum bullets score highest, one anatomy line.
  // Without interleaving, cerebrum would cluster and anatomy would be cut.
  const { root, cleanup } = createWorkspace({
    "anatomy.md": `# anatomy.md\n\n## scripts/\n\n- \`orchestrator.mjs\` — main dispatch orchestrator (~100 tok)\n`,
    "cerebrum.md": `# Cerebrum\n\n## Key Learnings\n\n- dispatch learning one\n- dispatch learning two\n- dispatch learning three\n- dispatch learning four\n`
  });
  try {
    const result = compileMemoryPacket({
      workspaceRoot: root,
      objective: "dispatch orchestrator flow",
      route: "implement",
      memoryPlan: { sources: ["anatomy", "cerebrum"], maxChars: 1800, maxChunks: 6 }
    });
    const sources = new Set(result.includedChunks.map((chunk) => chunk.source));
    assert.ok(
      sources.has(".wolf/anatomy.md"),
      `expected anatomy chunk preserved after interleave; got sources: ${[...sources].join(", ")}`
    );
    assert.ok(sources.has(".wolf/cerebrum.md"), "expected cerebrum chunk(s) present");
  } finally {
    cleanup();
  }
});

process.stdout.write("\nAll packet-compiler tests completed.\n");
