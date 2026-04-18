#!/usr/bin/env node
// enrich-anatomy.mjs — Deterministic cache + LLM-backed corpus enrichment.
//
// Reads .wolf/anatomy.md (OpenWolf-auto-scanned), enriches per-file
// descriptions via headless `claude -p --model haiku` invocations, and
// writes the output as a sidecar at .wolf/anatomy.enriched.md. The memory
// packet compiler merges enriched text onto base anatomy chunks before
// scoring, directly addressing the corpus-quality ceiling surfaced in the
// PR 2 benchmark (files like policy.mjs where the auto-extracted description
// contains zero topical keywords).
//
// Usage:
//   node scripts/enrich-anatomy.mjs                       # full repo scan
//   node scripts/enrich-anatomy.mjs --files a.mjs,b.mjs   # targeted
//   node scripts/enrich-anatomy.mjs --problem-only        # only enrich files
//                                                           whose vanilla
//                                                           description is
//                                                           retrieval-weak
//   node scripts/enrich-anatomy.mjs --force               # ignore cache
//   node scripts/enrich-anatomy.mjs --concurrency 5       # parallel calls
//   node scripts/enrich-anatomy.mjs --dry-run             # list work only
//
// Cache: .wolf/anatomy.cache.json keyed by (path, content_sha256).
// Sidecar: .wolf/anatomy.enriched.md, format:
//   ## <relative-path>
//   summary: ...
//   keywords: ...
//   exports: ...

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  getEnrichmentStatus,
  isProblemDescription,
  isSafeToEnrich,
  loadCache,
  parseAnatomyForEnrichment,
  pruneCacheOrphans,
  resolveWolfPaths,
  saveCache
} from "./lib/openwolf/enrich-status.mjs";

const WORKSPACE = process.cwd();
const { anatomyPath: ANATOMY_PATH, enrichedPath: ENRICHED_PATH, cachePath: CACHE_PATH, wolfDir: WOLF_DIR } = resolveWolfPaths(WORKSPACE);
const PROGRESS_PATH = path.join(WOLF_DIR, "enrichment.progress.json");

const CLAUDE_BIN = "claude";
const DEFAULT_MODEL = "haiku";
const DEFAULT_CONCURRENCY = 2;     // 2 concurrent batches × batch size = ~10 files in flight
const DEFAULT_BATCH_SIZE = 5;      // files per Haiku call — reduces CLI spawn count ~5×
const MAX_INPUT_CHARS = 16000;     // per-file cap before truncation; safe for batched prompts
const MAX_BATCH_INPUT_CHARS = 60_000; // ~15K tokens, keeps batch prompts inside Haiku context
const PER_FILE_TIMEOUT_MS = 60_000;
const PER_BATCH_TIMEOUT_MS = 180_000;

// Heuristic markers live in enrich-status.mjs; isProblemDescription is
// re-exported from there to this module's imports above.

function parseArgs(argv) {
  const out = {
    files: null,
    force: false,
    dryRun: false,
    problemOnly: false,
    concurrency: DEFAULT_CONCURRENCY,
    model: DEFAULT_MODEL,
    limit: Infinity,
    status: false,
    prune: false,
    json: false,
    batchSize: DEFAULT_BATCH_SIZE,
    noPrune: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--files") out.files = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (v === "--force") out.force = true;
    else if (v === "--dry-run") out.dryRun = true;
    else if (v === "--problem-only") out.problemOnly = true;
    else if (v === "--concurrency") out.concurrency = Number(argv[++i]) || DEFAULT_CONCURRENCY;
    else if (v === "--model") out.model = argv[++i] ?? DEFAULT_MODEL;
    else if (v === "--limit") out.limit = Number(argv[++i]) || Infinity;
    else if (v === "--status") out.status = true;
    else if (v === "--prune") out.prune = true;
    else if (v === "--json") out.json = true;
    else if (v === "--batch-size") out.batchSize = Math.max(1, Number(argv[++i]) || DEFAULT_BATCH_SIZE);
    else if (v === "--no-prune") out.noPrune = true;
    else if (v === "--no-monitor") out.noMonitor = true;
  }
  return out;
}

// --- Progress + monitor integration ---
//
// enrich-anatomy.mjs writes progress state to .wolf/enrichment.progress.json
// atomically after every significant transition (pruning → triaging →
// enriching → per-batch → complete/failed). A sibling script
// monitor-enrichment.mjs (spawned in a visible PowerShell window at the
// start of a real run) tails that file and renders a live screen. The
// monitor is entirely optional — if it fails to spawn, enrichment proceeds
// headless and the progress file is still written for post-hoc inspection.

function writeProgress(state) {
  try {
    const tmp = `${PROGRESS_PATH}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    fs.renameSync(tmp, PROGRESS_PATH);
  } catch {
    // Never let progress-file I/O fail the enrichment run.
  }
}

function clearProgress() {
  try {
    if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
  } catch {
    // non-fatal
  }
}

function spawnEnrichmentMonitor() {
  if (process.platform !== "win32") return null;

  const monitorScript = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "monitor-enrichment.mjs"
  );
  const launcherPath = path.join(os.tmpdir(), `cf-enrich-monitor-${Date.now()}.ps1`);

  const safeExec = process.execPath.replaceAll("'", "''");
  const safeScript = monitorScript.replaceAll("'", "''");
  const safeProgress = PROGRESS_PATH.replaceAll("'", "''");

  const launcherContent = [
    "\ufeff",
    `$host.ui.RawUI.WindowTitle = 'cf-enrich-monitor'`,
    `& '${safeExec}' '${safeScript}' --progress-file '${safeProgress}'`
  ].join("\r\n");

  try {
    fs.writeFileSync(launcherPath, launcherContent, "utf8");
    const proc = spawn(
      "cmd",
      ["/c", "start", '"cf-enrich-monitor"', "powershell",
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath],
      { detached: true, stdio: "ignore" }
    );
    proc.unref();
    return proc.pid ?? null;
  } catch {
    return null;
  }
}

// Parsing + cache helpers were moved to ./lib/openwolf/enrich-status.mjs so
// the hook can reuse them without bringing in this script's LLM-invocation
// paths. parseAnatomyForEnrichment / isProblemDescription / loadCache /
// saveCache are re-imported from there.

function hashContent(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

// --- Git bash auto-discovery (required by headless claude CLI on Windows) ---

function resolveGitBashPath() {
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) return process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (process.platform !== "win32") return null;
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "D:\\Program Files\\Git\\bin\\bash.exe"
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// --- Headless Claude invocation ---

// Single-file enrichment helpers (buildEnrichmentPrompt / runClaudeOnce)
// were removed in favor of batched enrichment — see runClaudeBatch below.
// Batching cuts CLI spawns by ~5× which matters on Windows where each spawn
// briefly flashes a git-bash console despite windowsHide:true on our outer
// process (the inner claude.exe launches its own subprocesses we can't
// suppress). For one-off debugging, use `--batch-size 1` to fall back to
// per-file invocations via the batched path.

function parseEnrichment(rawOutput) {
  const result = { summary: "", keywords: "", exports: "" };
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(summary|keywords|exports):\s*(.+)$/i);
    if (match) {
      result[match[1].toLowerCase()] = match[2].trim();
    }
  }
  return result;
}

// --- Batched enrichment ---
//
// Batching reduces the number of claude CLI spawns (and therefore the number
// of fleeting git-bash console windows that can appear despite windowsHide on
// the outer process). N files per prompt → 1 Haiku call instead of N.
//
// Format: each file is delimited by a strict marker "=== path ===" so the
// multi-file response is unambiguous even if Haiku's per-file output drifts
// slightly in formatting.

function buildBatchEnrichmentPrompt(entries) {
  const header = `You are generating retrieval metadata for a code index. Read each file below and, for each one, emit a block in EXACTLY this format. No preamble, no explanation, no markdown fences. Separate blocks with a blank line.

=== <relative-path> ===
summary: <one sentence, <=20 words, stating the file's purpose using specific domain nouns>
keywords: <comma-separated topical nouns an engineer would grep for, 6-12 terms>
exports: <comma-separated exported identifiers; "none" if the file has no exports>

Files:
`;
  const sections = entries.map(({ entry, fileContent }) => {
    const trimmed = fileContent.length > MAX_INPUT_CHARS
      ? `${fileContent.slice(0, MAX_INPUT_CHARS)}\n\n[...file truncated...]`
      : fileContent;
    return `--- BEGIN ${entry.relativePath} ---\n${trimmed}\n--- END ${entry.relativePath} ---`;
  });
  return header + sections.join("\n\n");
}

// Parse a batched response into a Map<relativePath, { summary, keywords, exports }>.
// Robust to extra text between sections and missing fields.
function parseBatchEnrichment(rawOutput) {
  const map = new Map();
  const blocks = String(rawOutput ?? "").split(/^={2,}\s*(.+?)\s*={2,}\s*$/m);
  // After split, blocks alternate: [prelude, path1, body1, path2, body2, ...]
  for (let i = 1; i < blocks.length; i += 2) {
    const relativePath = (blocks[i] ?? "").trim();
    const body = blocks[i + 1] ?? "";
    if (!relativePath) continue;
    const parsed = parseEnrichment(body);
    if (parsed.summary || parsed.keywords || parsed.exports) {
      map.set(relativePath, parsed);
    }
  }
  return map;
}

async function runClaudeBatch({ entries, model, gitBashPath }) {
  const prompt = buildBatchEnrichmentPrompt(entries);
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (gitBashPath) env.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;

    // Tool lockdown for the Haiku subprocess:
    //
    // We stream file content into the prompt via stdin and parse summaries
    // from stdout. The subprocess is a pure text-in/text-out transformer —
    // it has no legitimate reason to invoke ANY tool. Passing `--tools ""`
    // disables every tool in the built-in set (Read, Write, Edit, Bash,
    // Agent, WebFetch, WebSearch, etc.), which:
    //   (a) prevents prompt-injection from file content coercing Haiku
    //       into reading/writing arbitrary paths;
    //   (b) hard-bounds future refactors of this script — an agentic
    //       enrichment prompt would fail fast rather than silently acquire
    //       capabilities;
    //   (c) keeps write access to the enrichment sidecar entirely owned by
    //       this parent Node process, which only ever writes .wolf/
    //       artifacts (anatomy.enriched.md, anatomy.cache.json).
    const args = [
      "-p",
      "--model", model,
      "--output-format", "text",
      "--tools", ""
    ];
    const child = spawn(CLAUDE_BIN, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, PER_BATCH_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ ok: false, error: "batch timeout", stdout, stderr });
      else if (code !== 0) resolve({ ok: false, error: `exit ${code}: ${stderr.slice(0, 400)}`, stdout, stderr });
      else resolve({ ok: true, stdout: stdout.trim(), stderr });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Chunk entries into batches sized by both file count AND total prompt size.
// A single enormous file shouldn't drag 4 other files into a massive prompt.
function chunkIntoBatches(entries, fileContentMap, batchSize) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const entry of entries) {
    const content = fileContentMap.get(entry.relativePath) ?? "";
    const entryChars = Math.min(content.length, MAX_INPUT_CHARS) + entry.relativePath.length + 100;
    if (current.length > 0 && (current.length >= batchSize || currentChars + entryChars > MAX_BATCH_INPUT_CHARS)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push({ entry, fileContent: content });
    currentChars += entryChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// --- Main workflow ---

// Pre-process: filter entries into {needsEnrichment, cached, missing}.
// Reads file contents once (needed both for hash check and for batching).
function triage({ entries, cache, options }) {
  const triaged = {
    needsEnrichment: [],   // { entry, fileContent, hash }
    cached: [],            // { entry, enrichment } - cache hits
    missing: [],           // { entry } - file not found
    readError: []          // { entry, error }
  };

  for (const entry of entries) {
    const absolutePath = path.join(WORKSPACE, entry.relativePath);
    if (!fs.existsSync(absolutePath)) {
      triaged.missing.push({ entry });
      continue;
    }
    let fileContent;
    try {
      fileContent = fs.readFileSync(absolutePath, "utf8");
    } catch (err) {
      triaged.readError.push({ entry, error: err.message });
      continue;
    }
    const hash = hashContent(fileContent);
    const cached = cache.entries[entry.relativePath];
    if (cached && cached.hash === hash && !options.force) {
      triaged.cached.push({ entry, enrichment: cached.enrichment });
      continue;
    }
    triaged.needsEnrichment.push({ entry, fileContent, hash });
  }

  return triaged;
}

async function enrichBatch({ batch, cache, options, gitBashPath }) {
  if (options.dryRun) {
    return batch.map(({ entry }) => ({ entry, status: "would-enrich", enrichment: null }));
  }

  const invocation = await runClaudeBatch({
    entries: batch,
    model: options.model,
    gitBashPath
  });

  if (!invocation.ok) {
    return batch.map(({ entry }) => ({
      entry,
      status: "llm-error",
      enrichment: null,
      error: invocation.error
    }));
  }

  const parsedMap = parseBatchEnrichment(invocation.stdout);
  const results = [];
  const enrichedAt = new Date().toISOString();
  for (const { entry, fileContent } of batch) {
    const parsed = parsedMap.get(entry.relativePath);
    if (!parsed || (!parsed.summary && !parsed.keywords)) {
      results.push({
        entry,
        status: "llm-malformed",
        enrichment: null,
        error: `no block for ${entry.relativePath} in batch response (first 200 chars: ${invocation.stdout.slice(0, 200)})`
      });
      continue;
    }
    const hash = hashContent(fileContent);
    cache.entries[entry.relativePath] = {
      hash,
      enrichment: parsed,
      enrichedAt,
      model: options.model
    };
    results.push({ entry, status: "enriched", enrichment: parsed, hash });
  }
  return results;
}

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}

function renderSidecar(cache) {
  const lines = [
    "# anatomy.enriched.md",
    "",
    "> Auto-generated by scripts/enrich-anatomy.mjs. Do not edit manually.",
    "> LLM-backed summaries, keywords, and exports per file. Merged into the",
    "> memory packet compiler on top of .wolf/anatomy.md.",
    ""
  ];
  const entries = Object.entries(cache.entries).sort(([a], [b]) => a.localeCompare(b));
  for (const [relativePath, record] of entries) {
    const e = record.enrichment ?? {};
    if (!e.summary && !e.keywords && !e.exports) continue;
    lines.push(`## ${relativePath}`);
    if (e.summary) lines.push(`summary: ${e.summary}`);
    if (e.keywords) lines.push(`keywords: ${e.keywords}`);
    if (e.exports) lines.push(`exports: ${e.exports}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.status) {
    const status = getEnrichmentStatus(WORKSPACE);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }
    if (status.anatomyMissing) {
      process.stdout.write(`anatomy.md missing. Nothing to enrich.\n`);
      return;
    }
    process.stdout.write(
      `Tracked files:        ${status.totalFiles}\n` +
      `Unsafe skipped:       ${status.unsafeSkipped ?? 0} (.wolf/* or outside workspace)\n` +
      `Problem files:        ${status.problemFiles}\n` +
      `  - enriched:         ${status.enrichedProblemFiles}\n` +
      `  - unenriched:       ${status.unenrichedProblemFiles}\n` +
      `Orphaned cache rows:  ${status.orphanedCacheEntries}\n` +
      `Last enrichment run:  ${status.lastEnriched ?? "(never)"}\n`
    );
    return;
  }

  if (options.prune) {
    const { removed } = pruneCacheOrphans(WORKSPACE);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ removed }, null, 2)}\n`);
      return;
    }
    if (removed.length === 0) {
      process.stdout.write(`Nothing to prune.\n`);
    } else {
      process.stdout.write(`Pruned ${removed.length} orphan cache entries:\n`);
      for (const p of removed) process.stdout.write(`  - ${p}\n`);
    }
    // Always rewrite the sidecar after prune so it matches the pruned cache.
    const cache = loadCache(CACHE_PATH);
    const sidecar = renderSidecar(cache);
    fs.writeFileSync(ENRICHED_PATH, sidecar, "utf8");
    return;
  }

  if (!fs.existsSync(ANATOMY_PATH)) {
    process.stderr.write(`No anatomy.md found at ${ANATOMY_PATH}\n`);
    process.exit(1);
  }

  const anatomy = fs.readFileSync(ANATOMY_PATH, "utf8");
  let entries = parseAnatomyForEnrichment(anatomy);

  // Safety gate: exclude .wolf/* and out-of-workspace paths before any
  // downstream processing (dry-run reporting, batch building, LLM calls).
  // This is defense-in-depth against OpenWolf tracking changes, user-side
  // anatomy edits, and path-resolution quirks.
  const unsafeCount = entries.length;
  entries = entries.filter((e) => isSafeToEnrich(e.relativePath, WORKSPACE));
  const skippedUnsafe = unsafeCount - entries.length;
  if (skippedUnsafe > 0) {
    process.stdout.write(`Skipped ${skippedUnsafe} unsafe path(s) (.wolf/* or outside workspace).\n`);
  }

  if (Array.isArray(options.files) && options.files.length > 0) {
    const wanted = new Set(options.files.map((f) => f.replace(/\\/g, "/")));
    entries = entries.filter((e) => wanted.has(e.relativePath));
  }

  if (options.problemOnly) {
    entries = entries.filter((e) => isProblemDescription(e.vanillaDescription));
  }

  if (Number.isFinite(options.limit)) {
    entries = entries.slice(0, options.limit);
  }

  const startedAtIso = new Date().toISOString();

  // Initialize progress file + spawn the visible monitor window BEFORE
  // pruning. If the monitor is suppressed or fails to spawn, the progress
  // file still records the run for post-hoc inspection.
  const progress = {
    startedAt: startedAtIso,
    phase: "pruning",
    totalFiles: entries.length,
    cached: 0,
    missing: 0,
    pending: 0,
    batchesTotal: 0,
    batchesCompleted: 0,
    filesEnriched: 0,
    filesErrored: 0,
    currentBatch: [],
    pruned: 0,
    error: null
  };
  if (!options.dryRun) {
    writeProgress(progress);
    // Per-run monitor popups were removed — the persistent monitor daemon
    // (scripts/monitor-daemon.mjs, launched via /claudsterfuck:monitor)
    // picks up the progress file and renders it. `--no-monitor` is retained
    // as a no-op flag for backwards compatibility. `spawnEnrichmentMonitor`
    // stays in the file but is intentionally not invoked here.
    void options.noMonitor;
  }

  // Auto-prune stale cache entries at the start of every enrichment run
  // (unless --no-prune or --dry-run). This keeps the sidecar tidy without
  // requiring the user to remember a separate invocation — the whole point
  // of /claudsterfuck:enrichmemory is one-shot housekeeping.
  let prunedCount = 0;
  if (!options.noPrune && !options.dryRun) {
    const { removed } = pruneCacheOrphans(WORKSPACE);
    prunedCount = removed.length;
    progress.pruned = prunedCount;
    if (prunedCount > 0) {
      process.stdout.write(`Pruned ${prunedCount} orphan cache entries before enrichment.\n`);
    }
  }

  progress.phase = "triaging";
  writeProgress(progress);

  const cache = loadCache(CACHE_PATH);

  const gitBashPath = resolveGitBashPath();
  if (process.platform === "win32" && !gitBashPath) {
    progress.phase = "failed";
    progress.error = "git-bash not found";
    writeProgress(progress);
    process.stderr.write("Could not locate git-bash. Set CLAUDE_CODE_GIT_BASH_PATH or install Git for Windows.\n");
    process.exit(1);
  }

  // Triage once (reads files, checks cache) — avoids reading + hashing during
  // each batch and ensures cache hits are excluded from batches entirely.
  const triaged = triage({ entries, cache, options });
  const counts = {
    enriched: 0,
    cached: triaged.cached.length,
    "would-enrich": 0,
    missing: triaged.missing.length,
    "read-error": triaged.readError.length,
    "llm-error": 0,
    "llm-malformed": 0
  };

  progress.cached = triaged.cached.length;
  progress.missing = triaged.missing.length;
  progress.pending = triaged.needsEnrichment.length;

  process.stdout.write(
    `Enriching ${triaged.needsEnrichment.length} files (model=${options.model}, ` +
    `concurrency=${options.concurrency}, batchSize=${options.batchSize}` +
    `${options.dryRun ? ", DRY-RUN" : ""}) · ` +
    `${triaged.cached.length} cached · ${triaged.missing.length} missing\n`
  );

  const batches = chunkIntoBatches(
    triaged.needsEnrichment.map((t) => t.entry),
    new Map(triaged.needsEnrichment.map((t) => [t.entry.relativePath, t.fileContent])),
    options.batchSize
  );
  progress.batchesTotal = batches.length;
  progress.phase = triaged.needsEnrichment.length > 0 ? "enriching" : "writing";
  writeProgress(progress);

  const batchTasks = batches.map((batch) => () => {
    // Publish which files are in flight for this batch so the monitor can
    // render them as they're being processed.
    const inFlightPaths = batch.map(({ entry }) => entry.relativePath);
    progress.currentBatch = inFlightPaths;
    writeProgress(progress);
    return enrichBatch({ batch, cache, options, gitBashPath }).then((results) => {
      progress.batchesCompleted += 1;
      for (const r of results) {
        if (r.status === "enriched") progress.filesEnriched += 1;
        if (r.status === "llm-error" || r.status === "llm-malformed") progress.filesErrored += 1;
      }
      writeProgress(progress);
      return results;
    });
  });

  const startedAt = Date.now();
  const batchResults = await runPool(batchTasks, options.concurrency);
  const elapsedMs = Date.now() - startedAt;

  for (const batchResult of batchResults) {
    for (const result of batchResult) {
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      if (result.status === "llm-error" || result.status === "llm-malformed") {
        process.stderr.write(`  ! ${result.entry.relativePath}: ${result.error ?? "unknown"}\n`);
      }
    }
  }
  for (const { entry } of triaged.readError) {
    process.stderr.write(`  ! ${entry.relativePath}: read error\n`);
  }

  if (!options.dryRun) {
    cache.lastEnriched = new Date().toISOString();
    saveCache(CACHE_PATH, cache);
    const sidecar = renderSidecar(cache);
    fs.writeFileSync(ENRICHED_PATH, sidecar, "utf8");
    progress.phase = progress.filesErrored > 0 && progress.filesEnriched === 0
      ? "failed"
      : "complete";
    writeProgress(progress);
  }

  process.stdout.write(
    `Done in ${(elapsedMs / 1000).toFixed(1)}s (${batches.length} batch${batches.length === 1 ? "" : "es"}) · ` +
    Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${status}:${count}`)
      .join(" · ") +
    "\n"
  );
  if (!options.dryRun) {
    process.stdout.write(`Sidecar: ${ENRICHED_PATH}\n`);
    process.stdout.write(`Cache:   ${CACHE_PATH}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
