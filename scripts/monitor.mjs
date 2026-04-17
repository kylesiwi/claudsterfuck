#!/usr/bin/env node

/**
 * monitor.mjs — Live worker status window for claudsterfuck
 *
 * Spawned as a separate visible terminal window by orchestrator.mjs dispatch.
 * Polls the run record and stdout file, refreshing the screen every 2 seconds.
 * Exits automatically when the run completes or fails.
 *
 * Args: --run-id <id>  --run-file <path>  --stdout-file <path>
 */

import fs from "node:fs";
import process from "node:process";

const POLL_INTERVAL_MS = 2000;
const TAIL_LINES = 25;
const HR = "─".repeat(60);

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { runId: "", runFile: "", stdoutFile: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run-id") { args.runId = argv[++i] ?? ""; }
    else if (argv[i] === "--run-file") { args.runFile = argv[++i] ?? ""; }
    else if (argv[i] === "--stdout-file") { args.stdoutFile = argv[++i] ?? ""; }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

/**
 * For Gemini: stdout starts with {session_id, response} then appends telemetry.
 * The raw tail is telemetry JSON, not the actual response. Extract the response
 * field from the first JSON object so the monitor shows useful content.
 */
function extractGeminiResponse(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content.startsWith("{")) return null;
    // Walk the string respecting escape sequences and string boundaries
    let depth = 0, inString = false, escape = false;
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === "\"") { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") { depth++; }
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const parsed = JSON.parse(content.slice(0, i + 1));
          return typeof parsed?.response === "string" ? parsed.response.trim() : null;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function clearScreen() {
  // ANSI: clear screen + move cursor to top-left
  process.stdout.write("\x1B[2J\x1B[0;0H");
}

function formatElapsed(startedAt) {
  if (!startedAt) return "?";
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

if (!args.runId || !args.runFile || !args.stdoutFile) {
  console.error("Usage: monitor.mjs --run-id <id> --run-file <path> --stdout-file <path>");
  process.exit(1);
}

// Give the run record a moment to land on disk before first read
await sleep(500);

while (true) {
  const run = readJsonSafe(args.runFile);

  clearScreen();

  // Header
  process.stdout.write(HR + "\n");
  process.stdout.write("  claudsterfuck — worker monitor\n");
  process.stdout.write(HR + "\n");

  // Run info
  if (run) {
    process.stdout.write(`  Run:      ${args.runId}\n`);
    process.stdout.write(`  Provider: ${run.provider ?? "?"}\n`);
    process.stdout.write(`  Route:    ${run.route ?? "?"}\n`);
    process.stdout.write(`  Status:   ${run.status ?? "?"}\n`);
    process.stdout.write(`  Elapsed:  ${formatElapsed(run.startedAt)}\n`);
    if (run.completedAt) {
      process.stdout.write(`  Done:     ${run.completedAt}\n`);
    }
  } else {
    process.stdout.write(`  Run:      ${args.runId}\n`);
    process.stdout.write(`  Status:   initializing...\n`);
  }

  // Worker output — for Gemini, extract the response field from the first JSON
  // object so the monitor shows the actual review content, not trailing telemetry.
  const isGemini = run?.provider === "gemini";
  const geminiResponse = isGemini ? extractGeminiResponse(args.stdoutFile) : null;
  const outputLabel = geminiResponse ? "  GEMINI RESPONSE" : "  WORKER OUTPUT (last 25 lines)";

  process.stdout.write(HR + "\n");
  process.stdout.write(outputLabel + "\n");
  process.stdout.write(HR + "\n");

  if (geminiResponse) {
    // Show last ~50 lines of the response so it fits the terminal
    const lines = geminiResponse.split("\n");
    process.stdout.write(lines.slice(Math.max(0, lines.length - 50)).join("\n") + "\n");
  } else {
    const tail = readTailLines(args.stdoutFile, TAIL_LINES);
    if (tail) {
      process.stdout.write(tail + "\n");
    } else {
      process.stdout.write("  (no output yet)\n");
    }
  }

  process.stdout.write("\n");

  // Terminal condition
  if (run && (run.status === "completed" || run.status === "failed")) {
    process.stdout.write(HR + "\n");
    if (run.status === "completed") {
      process.stdout.write("  COMPLETED\n");
    } else {
      process.stdout.write(`  FAILED: ${run.errorSummary ?? "unknown error"}\n`);
    }
    process.stdout.write(HR + "\n");
    break;
  }

  await sleep(POLL_INTERVAL_MS);
}
