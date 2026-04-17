#!/usr/bin/env node

/**
 * monitor.mjs — Live worker status window for claudsterfuck
 *
 * Spawned as a separate visible terminal window by orchestrator.mjs dispatch.
 * Polls the run record and events stream, refreshing the screen every 2 seconds.
 * Exits automatically when the run completes or fails.
 *
 * Args: --run-id <id>  --run-file <path>  --stdout-file <path>
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { summarizeEvent } from "./lib/event-stream.mjs";

const POLL_INTERVAL_MS = 2000;
const EVENT_HISTORY_LINES = 18;
const TAIL_LINES_FALLBACK = 25;
const HR = "─".repeat(60);

// ANSI colors
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

function parseArgs(argv) {
  const args = { runId: "", runFile: "", stdoutFile: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run-id") { args.runId = argv[++i] ?? ""; }
    else if (argv[i] === "--run-file") { args.runFile = argv[++i] ?? ""; }
    else if (argv[i] === "--stdout-file") { args.stdoutFile = argv[++i] ?? ""; }
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readTailLines(filePath, n) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) return null;
    const lines = content.split("\n");
    return lines.slice(Math.max(0, lines.length - n)).join("\n");
  } catch {
    return null;
  }
}

function readNdjsonEvents(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) return [];
    const events = [];
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {}
    }
    return events;
  } catch {
    return [];
  }
}

function clearScreen() {
  process.stdout.write("\x1B[2J\x1B[0;0H");
}

function formatElapsed(startedAt) {
  if (!startedAt) return "?";
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function colorForStatus(status) {
  if (status === "completed") return GREEN;
  if (status === "failed" || status === "error") return RED;
  if (status === "running") return YELLOW;
  return DIM;
}

function renderEventLine(provider, event) {
  const summary = summarizeEvent(provider, event);
  if (!summary) return null;
  const icon = summary.icon || "·";
  return `  ${MAGENTA}${icon}${RESET} ${summary.label}`;
}

const args = parseArgs(process.argv.slice(2));

if (!args.runId || !args.runFile || !args.stdoutFile) {
  console.error("Usage: monitor.mjs --run-id <id> --run-file <path> --stdout-file <path>");
  process.exit(1);
}

// The stdoutFile for the detached worker contains NDJSON events directly (Codex --json,
// Gemini --output-format stream-json). Events can also live alongside at events.jsonl
// in the same run directory when the non-detached providers path wrote them there.
const runArtifactsDir = path.dirname(args.stdoutFile);
const eventsFile = path.join(runArtifactsDir, "events.jsonl");

await sleep(500);

while (true) {
  const run = readJsonSafe(args.runFile);

  // Prefer events.jsonl when it exists (populated by non-detached path or finalizer),
  // else fall back to stdoutFile (contains NDJSON in detached mode).
  const eventSource = fs.existsSync(eventsFile) ? eventsFile : args.stdoutFile;
  const events = readNdjsonEvents(eventSource);

  clearScreen();

  // Header
  process.stdout.write(`${DIM}${HR}${RESET}\n`);
  process.stdout.write(`  ${CYAN}claudsterfuck${RESET} — worker monitor\n`);
  process.stdout.write(`${DIM}${HR}${RESET}\n`);

  // Run info
  if (run) {
    const statusColor = colorForStatus(run.status);
    process.stdout.write(`  Run:      ${args.runId}\n`);
    process.stdout.write(`  Provider: ${run.provider ?? "?"}\n`);
    process.stdout.write(`  Route:    ${run.route ?? "?"}\n`);
    process.stdout.write(`  Status:   ${statusColor}${run.status ?? "?"}${RESET}\n`);
    process.stdout.write(`  Elapsed:  ${formatElapsed(run.startedAt)}\n`);
    if (run.completedAt) {
      process.stdout.write(`  Done:     ${run.completedAt}\n`);
    }
    if (run.tokenUsage) {
      const u = run.tokenUsage;
      const parts = [];
      if (Number.isFinite(u.input_tokens ?? u.input)) parts.push(`in=${u.input_tokens ?? u.input}`);
      if (Number.isFinite(u.output_tokens)) parts.push(`out=${u.output_tokens}`);
      if (Number.isFinite(u.cached_input_tokens ?? u.cached)) parts.push(`cached=${u.cached_input_tokens ?? u.cached}`);
      if (parts.length) {
        process.stdout.write(`  Tokens:   ${DIM}${parts.join(" ")}${RESET}\n`);
      }
    }
  } else {
    process.stdout.write(`  Run:      ${args.runId}\n`);
    process.stdout.write(`  Status:   initializing…\n`);
  }

  process.stdout.write(`${DIM}${HR}${RESET}\n`);

  // Event stream: render structured events when available, fall back to raw tail
  if (events.length > 0) {
    process.stdout.write(`  ${CYAN}EVENT STREAM${RESET} (last ${Math.min(EVENT_HISTORY_LINES, events.length)} of ${events.length})\n`);
    process.stdout.write(`${DIM}${HR}${RESET}\n`);
    const tail = events.slice(-EVENT_HISTORY_LINES);
    const provider = run?.provider || "";
    for (const event of tail) {
      const line = renderEventLine(provider, event);
      if (line) {
        process.stdout.write(line + "\n");
      }
    }
  } else {
    process.stdout.write(`  ${CYAN}WORKER OUTPUT${RESET} (last ${TAIL_LINES_FALLBACK} lines)\n`);
    process.stdout.write(`${DIM}${HR}${RESET}\n`);
    const tail = readTailLines(args.stdoutFile, TAIL_LINES_FALLBACK);
    if (tail) {
      process.stdout.write(tail + "\n");
    } else {
      process.stdout.write(`  ${DIM}(no output yet)${RESET}\n`);
    }
  }

  process.stdout.write("\n");

  // Terminal condition
  if (run && (run.status === "completed" || run.status === "failed")) {
    process.stdout.write(`${DIM}${HR}${RESET}\n`);
    if (run.status === "completed") {
      process.stdout.write(`  ${GREEN}✓ COMPLETED${RESET}\n`);
    } else {
      process.stdout.write(`  ${RED}✗ FAILED${RESET}: ${run.errorSummary ?? "unknown error"}\n`);
    }
    process.stdout.write(`${DIM}${HR}${RESET}\n`);
    break;
  }

  await sleep(POLL_INTERVAL_MS);
}
