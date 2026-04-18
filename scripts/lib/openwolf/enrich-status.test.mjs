#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getEnrichmentStatus,
  isProblemDescription,
  isSafeToEnrich,
  parseAnatomyForEnrichment,
  pruneCacheOrphans
} from "./enrich-status.mjs";

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    throw error;
  }
}

function createWorkspace({ anatomy, cache }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-enrich-status-"));
  const wolf = path.join(dir, ".wolf");
  fs.mkdirSync(wolf, { recursive: true });
  if (anatomy !== undefined) {
    fs.writeFileSync(path.join(wolf, "anatomy.md"), anatomy, "utf8");
  }
  if (cache !== undefined) {
    fs.writeFileSync(path.join(wolf, "anatomy.cache.json"), JSON.stringify(cache, null, 2), "utf8");
  }
  return {
    root: dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

const SAMPLE_ANATOMY = `# anatomy.md

## scripts/

- \`orchestrator.mjs\` — orchestrator.mjs - Main dispatch CLI (~8000 tok)
- \`policy.mjs\` — Resolve a read target that is inside workspace (~3000 tok)
- \`weak-file.mjs\` (~500 tok)

## scripts/lib/

- \`state.mjs\` — State management v4: atomic writes (~2000 tok)
- \`test-runner.mjs\` — run: createEnv, writeState (~500 tok)

## scripts/lib/openwolf/

- \`compile-packet.mjs\` — --- Memory Distillation --- (~3000 tok)
`;

// --- isProblemDescription heuristics ---

await run("isProblemDescription flags empty / tok-only descriptions", () => {
  assert.equal(isProblemDescription(""), true);
  assert.equal(isProblemDescription("(~500 tok)"), true);
  assert.equal(isProblemDescription(undefined), true);
});

await run("isProblemDescription flags first-JSDoc extraction 'Resolve a ...'", () => {
  assert.equal(isProblemDescription("Resolve a read target that is inside workspace"), true);
});

await run("isProblemDescription flags comment-header extraction '--- Memory ...'", () => {
  assert.equal(isProblemDescription("--- Memory Distillation: Source-level classification ---"), true);
});

await run("isProblemDescription flags PR-ID references 'R6: ...'", () => {
  assert.equal(isProblemDescription("R6: surface the prior turn's objective"), true);
  assert.equal(isProblemDescription("R12: something else"), true);
});

await run("isProblemDescription flags test-runner stubs 'run: ...'", () => {
  assert.equal(isProblemDescription("run: createEnv, writeState, writeLatestEvent"), true);
});

await run("isProblemDescription passes informative descriptions", () => {
  assert.equal(isProblemDescription("orchestrator.mjs - Main dispatch CLI"), false);
  assert.equal(isProblemDescription("State management v4: atomic writes"), false);
});

// --- parseAnatomyForEnrichment ---

await run("parseAnatomyForEnrichment extracts relative paths from section context", () => {
  const entries = parseAnatomyForEnrichment(SAMPLE_ANATOMY);
  const paths = entries.map((e) => e.relativePath);
  assert.ok(paths.includes("scripts/orchestrator.mjs"));
  assert.ok(paths.includes("scripts/policy.mjs"));
  assert.ok(paths.includes("scripts/lib/state.mjs"));
  assert.ok(paths.includes("scripts/lib/openwolf/compile-packet.mjs"));
});

// --- getEnrichmentStatus ---

await run("getEnrichmentStatus counts problem files and returns unenriched list", () => {
  const { root, cleanup } = createWorkspace({ anatomy: SAMPLE_ANATOMY });
  try {
    const status = getEnrichmentStatus(root);
    assert.equal(status.anatomyMissing, false);
    assert.equal(status.totalFiles, 6);
    // Problem files: policy.mjs (Resolve a...), weak-file.mjs (no desc),
    // test-runner.mjs (run:), compile-packet.mjs (---) = 4
    assert.equal(status.problemFiles, 4);
    assert.equal(status.enrichedProblemFiles, 0);
    assert.equal(status.unenrichedProblemFiles, 4);
    assert.ok(Array.isArray(status.unenrichedProblemList));
    assert.ok(status.unenrichedProblemList.includes("scripts/policy.mjs"));
  } finally {
    cleanup();
  }
});

await run("getEnrichmentStatus counts enriched when cache has entries", () => {
  const cache = {
    version: 1,
    lastEnriched: "2026-04-18T15:00:00Z",
    entries: {
      "scripts/policy.mjs": { hash: "abc", enrichment: { summary: "..." } },
      "scripts/lib/openwolf/compile-packet.mjs": { hash: "def", enrichment: { summary: "..." } }
    }
  };
  const { root, cleanup } = createWorkspace({ anatomy: SAMPLE_ANATOMY, cache });
  try {
    const status = getEnrichmentStatus(root);
    assert.equal(status.enrichedProblemFiles, 2);
    assert.equal(status.unenrichedProblemFiles, 2);
    assert.equal(status.lastEnriched, "2026-04-18T15:00:00Z");
  } finally {
    cleanup();
  }
});

await run("getEnrichmentStatus reports anatomyMissing when .wolf/anatomy.md absent", () => {
  const { root, cleanup } = createWorkspace({});
  try {
    const status = getEnrichmentStatus(root);
    assert.equal(status.anatomyMissing, true);
    assert.equal(status.totalFiles, 0);
  } finally {
    cleanup();
  }
});

// --- pruneCacheOrphans ---

await run("pruneCacheOrphans removes cache entries whose files are gone", () => {
  const cache = {
    version: 1,
    entries: {
      "scripts/policy.mjs": { hash: "abc", enrichment: { summary: "..." } },
      "scripts/deleted.mjs": { hash: "xyz", enrichment: { summary: "gone" } }
    }
  };
  const { root, cleanup } = createWorkspace({ anatomy: SAMPLE_ANATOMY, cache });
  try {
    const { removed } = pruneCacheOrphans(root);
    assert.deepStrictEqual(removed, ["scripts/deleted.mjs"]);
    const status = getEnrichmentStatus(root);
    assert.equal(status.orphanedCacheEntries, 0);
    assert.equal(status.enrichedProblemFiles, 1);
  } finally {
    cleanup();
  }
});

await run("pruneCacheOrphans is a no-op when no orphans exist", () => {
  const cache = {
    version: 1,
    entries: { "scripts/policy.mjs": { hash: "abc", enrichment: { summary: "..." } } }
  };
  const { root, cleanup } = createWorkspace({ anatomy: SAMPLE_ANATOMY, cache });
  try {
    const { removed } = pruneCacheOrphans(root);
    assert.deepStrictEqual(removed, []);
  } finally {
    cleanup();
  }
});

// --- buildEnrichmentReminder ---

await run("buildEnrichmentReminder alerts when >10 unenriched files", async () => {
  // Construct anatomy with 15 problem files
  const lines = ["# anatomy.md", "", "## scripts/", ""];
  for (let i = 0; i < 15; i += 1) {
    lines.push(`- \`file${i}.mjs\` — Resolve a ${i} target (~100 tok)`);
  }
  const anatomy = lines.join("\n");
  const { root, cleanup } = createWorkspace({ anatomy });
  try {
    const { buildEnrichmentReminder } = await import("./enrichment-reminder.mjs");
    const { reminder, autoRunStarted } = buildEnrichmentReminder(root, { skipAutoRun: true });
    assert.ok(reminder && reminder.includes("15 anatomy files"));
    assert.ok(reminder.includes("/claudsterfuck:enrichmemory"));
    assert.equal(autoRunStarted, false);
  } finally {
    cleanup();
  }
});

await run("buildEnrichmentReminder returns null when no unenriched problem files", async () => {
  const { root, cleanup } = createWorkspace({ anatomy: "# anatomy.md\n" });
  try {
    const { buildEnrichmentReminder } = await import("./enrichment-reminder.mjs");
    const { reminder, autoRunStarted } = buildEnrichmentReminder(root);
    assert.equal(reminder, null);
    assert.equal(autoRunStarted, false);
  } finally {
    cleanup();
  }
});

await run("buildEnrichmentReminder skips auto-run during cooldown window", async () => {
  const lines = ["# anatomy.md", "", "## scripts/", ""];
  for (let i = 0; i < 3; i += 1) {
    lines.push(`- \`file${i}.mjs\` — Resolve a ${i} target (~100 tok)`);
  }
  const cache = {
    version: 1,
    lastEnriched: new Date().toISOString(), // just now
    entries: {}
  };
  const { root, cleanup } = createWorkspace({ anatomy: lines.join("\n"), cache });
  try {
    const { buildEnrichmentReminder } = await import("./enrichment-reminder.mjs");
    const { reminder, autoRunStarted } = buildEnrichmentReminder(root);
    assert.equal(autoRunStarted, false, "should not auto-run within cooldown");
    assert.equal(reminder, null, "no reminder emitted during cooldown");
  } finally {
    cleanup();
  }
});

// --- PR: safety filter (isSafeToEnrich) ---

await run("isSafeToEnrich rejects .wolf/ paths", () => {
  const root = "C:/dev/claudsterfuck";
  assert.equal(isSafeToEnrich(".wolf/anatomy.md", root), false);
  assert.equal(isSafeToEnrich(".wolf/cerebrum.md", root), false);
  assert.equal(isSafeToEnrich(".wolf/subdir/file.md", root), false);
  assert.equal(isSafeToEnrich(".wolf", root), false);
});

await run("isSafeToEnrich rejects absolute paths with drive letters", () => {
  const root = "C:/dev/claudsterfuck";
  assert.equal(isSafeToEnrich("D:/Users/me/.claude/settings.json", root), false);
  assert.equal(isSafeToEnrich("C:/other/project/file.mjs", root), false);
});

await run("isSafeToEnrich rejects POSIX absolute paths", () => {
  const root = "/home/user/project";
  assert.equal(isSafeToEnrich("/etc/passwd", root), false);
  assert.equal(isSafeToEnrich("/home/other/file", root), false);
});

await run("isSafeToEnrich rejects parent-escape paths", () => {
  const root = "C:/dev/claudsterfuck";
  assert.equal(isSafeToEnrich("../other/file.mjs", root), false);
  assert.equal(isSafeToEnrich("../../etc", root), false);
});

await run("isSafeToEnrich accepts normal in-workspace paths", () => {
  const root = "C:/dev/claudsterfuck";
  assert.equal(isSafeToEnrich("scripts/orchestrator.mjs", root), true);
  assert.equal(isSafeToEnrich("routes/design.json", root), true);
  assert.equal(isSafeToEnrich("README.md", root), true);
  assert.equal(isSafeToEnrich("scripts/lib/openwolf/compile-packet.mjs", root), true);
});

await run("isSafeToEnrich normalizes backslashes", () => {
  const root = "C:/dev/claudsterfuck";
  assert.equal(isSafeToEnrich(".wolf\\anatomy.md", root), false);
  assert.equal(isSafeToEnrich("scripts\\orchestrator.mjs", root), true);
});

await run("isSafeToEnrich rejects empty or null", () => {
  const root = "C:/dev/claudsterfuck";
  assert.equal(isSafeToEnrich("", root), false);
  assert.equal(isSafeToEnrich(null, root), false);
  assert.equal(isSafeToEnrich(undefined, root), false);
});

await run("getEnrichmentStatus skips unsafe paths and reports unsafeSkipped count", () => {
  // Construct anatomy with a mix of safe, .wolf/, and absolute paths
  const anatomy = `# anatomy.md

## ./

- \`README.md\` — Project documentation (~100 tok)

## scripts/

- \`orchestrator.mjs\` — Main CLI (~8000 tok)

## .wolf/

- \`anatomy.md\` — Self-reference (~300 tok)
- \`cerebrum.md\` — Learnings (~1000 tok)

## D:/Users/kylecito/.claude/

- \`settings.json\` (~100 tok)
`;
  const { root, cleanup } = createWorkspace({ anatomy, cache: { version: 1, entries: {} } });
  try {
    const status = getEnrichmentStatus(root);
    // Safe entries: README.md + scripts/orchestrator.mjs = 2
    // Unsafe: .wolf/anatomy.md, .wolf/cerebrum.md, D:/…/settings.json = 3
    assert.equal(status.totalFiles, 2, `expected 2 safe files, got ${status.totalFiles}`);
    assert.equal(status.unsafeSkipped, 3, `expected 3 unsafe skipped, got ${status.unsafeSkipped}`);
  } finally {
    cleanup();
  }
});

process.stdout.write("\nAll enrich-status tests completed.\n");
