#!/usr/bin/env node

/**
 * monitor-enrichment.mjs — Live status window for memory enrichment runs.
 *
 * Spawned in a visible PowerShell window by enrich-anatomy.mjs before it
 * starts the batched Haiku calls. Polls .wolf/enrichment.progress.json every
 * second and renders a progress screen. Exits automatically when the
 * progress file reports phase=complete or phase=failed.
 *
 * Args: --progress-file <path>
 *
 * Progress JSON contract (written atomically by enrich-anatomy.mjs):
 * {
 *   "startedAt":         "ISO-8601",
 *   "updatedAt":         "ISO-8601",
 *   "phase":             "pruning" | "triaging" | "enriching" | "complete" | "failed",
 *   "totalFiles":        N,    // files considered for this run
 *   "cached":            N,    // cache hits (skipped)
 *   "missing":           N,    // files not found on disk
 *   "pending":           N,    // needs enrichment
 *   "batchesTotal":      N,
 *   "batchesCompleted":  N,
 *   "filesEnriched":     N,
 *   "filesErrored":      N,
 *   "currentBatch":      [relativePath, ...],  // most-recent in-flight or completed
 *   "pruned":            N,
 *   "error":             null | string
 * }
 */

import fs from "node:fs";
import process from "node:process";

const POLL_INTERVAL_MS = 1000;
const AUTO_CLOSE_DELAY_MS = 4000; // after phase=complete, hold for a few seconds then exit

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

function parseArgs(argv) {
  const args = { progressFile: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--progress-file") args.progressFile = argv[++i] ?? "";
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readProgress(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function renderProgressBar(value, total, width = 28) {
  if (total <= 0) return `${DIM}${"─".repeat(width)}${RESET}`;
  const ratio = Math.max(0, Math.min(1, value / total));
  const filled = Math.round(ratio * width);
  return `${GREEN}${"█".repeat(filled)}${RESET}${DIM}${"░".repeat(width - filled)}${RESET}`;
}

function phaseColor(phase) {
  switch (phase) {
    case "complete": return GREEN;
    case "failed": return RED;
    case "enriching": return CYAN;
    case "pruning":
    case "triaging": return YELLOW;
    default: return MAGENTA;
  }
}

function render(progress) {
  clearScreen();
  if (!progress) {
    process.stdout.write(`${DIM}Waiting for enrichment progress…${RESET}\n`);
    return;
  }

  const {
    phase = "?",
    totalFiles = 0,
    cached = 0,
    missing = 0,
    pending = 0,
    batchesTotal = 0,
    batchesCompleted = 0,
    filesEnriched = 0,
    filesErrored = 0,
    currentBatch = [],
    pruned = 0,
    startedAt,
    error
  } = progress;

  const startMs = startedAt ? Date.parse(startedAt) : Date.now();
  const elapsed = formatDuration(Date.now() - startMs);

  process.stdout.write(`${CYAN}[cf-enrich]${RESET} Memory Enrichment · ${DIM}${elapsed}${RESET}\n`);
  process.stdout.write(`${"─".repeat(60)}\n`);
  process.stdout.write(`Phase:    ${phaseColor(phase)}${phase}${RESET}`);
  if (phase === "failed" && error) {
    process.stdout.write(` ${RED}· ${String(error).slice(0, 50)}${RESET}`);
  }
  process.stdout.write("\n");

  process.stdout.write(`Files:    ${renderProgressBar(filesEnriched, pending)} `);
  process.stdout.write(`${filesEnriched}/${pending} enriched`);
  if (cached > 0) process.stdout.write(` ${DIM}· ${cached} cached${RESET}`);
  if (missing > 0) process.stdout.write(` ${DIM}· ${missing} missing${RESET}`);
  if (filesErrored > 0) process.stdout.write(` ${RED}· ${filesErrored} errored${RESET}`);
  process.stdout.write("\n");

  process.stdout.write(`Batches:  ${renderProgressBar(batchesCompleted, batchesTotal)} `);
  process.stdout.write(`${batchesCompleted}/${batchesTotal}\n`);

  if (pruned > 0) {
    process.stdout.write(`Pruned:   ${YELLOW}${pruned}${RESET} orphan cache entr${pruned === 1 ? "y" : "ies"}\n`);
  }

  if (Array.isArray(currentBatch) && currentBatch.length > 0) {
    process.stdout.write(`\n${DIM}Current batch:${RESET}\n`);
    for (const file of currentBatch.slice(0, 6)) {
      process.stdout.write(`  ${DIM}·${RESET} ${file}\n`);
    }
    if (currentBatch.length > 6) {
      process.stdout.write(`  ${DIM}… +${currentBatch.length - 6} more${RESET}\n`);
    }
  }

  process.stdout.write(`\n${DIM}Total: ${totalFiles} tracked · window will close automatically on completion${RESET}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.progressFile) {
    process.stderr.write("Missing --progress-file\n");
    process.exit(1);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const progress = readProgress(args.progressFile);
    render(progress);

    if (progress && (progress.phase === "complete" || progress.phase === "failed")) {
      await sleep(AUTO_CLOSE_DELAY_MS);
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
