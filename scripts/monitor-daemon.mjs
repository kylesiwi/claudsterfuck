#!/usr/bin/env node

/**
 * monitor-daemon.mjs — Persistent per-session monitor for claudsterfuck.
 *
 * Unifies the previous one-shot monitors (monitor.mjs for dispatch runs,
 * monitor-enrichment.mjs for memory enrichment) into a single long-running
 * visible terminal window. The window stays open across turns, rotating
 * between views based on what's currently active:
 *
 *   idle       → last completed run + last enrichment + session banner
 *   enriching  → batch progress bars + current batch file list
 *   dispatch   → active worker's event stream and token usage
 *   reviewing  → "Claude is reviewing worker output" banner
 *
 * Invoked via the `/claudsterfuck:monitor` slash command (see commands/
 * monitor.md). Idempotent: if a daemon for this session is already running,
 * the launcher exits quietly.
 *
 * Modes:
 *   --spawn-window --session-id <id>   ← launcher: open a PowerShell window
 *                                        running this script in daemon mode,
 *                                        then exit. The only public entry.
 *   --session-id <id>                  ← daemon loop: acquire lock, poll,
 *                                        render. Invoked by the launcher.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  tryAcquireLock,
  releaseLock,
  readLock,
  isPidAlive
} from "./lib/openwolf/monitor-daemon-lock.mjs";
import {
  buildIdleRecoveryHint,
  buildClearScreenSequence,
  extractSessionPromptPreview,
  selectView,
  summarizeEnrichmentState
} from "./lib/openwolf/monitor-daemon-view.mjs";
import { resolveWolfPaths } from "./lib/openwolf/enrich-status.mjs";
import { ensurePluginDataEnv, resolveRunArtifactsDir, resolveRunFile, resolveStateFile } from "./lib/state.mjs";
import { summarizeEvent } from "./lib/event-stream.mjs";

const POLL_INTERVAL_MS = 1000;
const CLEAR = buildClearScreenSequence();

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

function parseArgs(argv) {
  const out = { sessionId: "", spawnWindow: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--session-id") out.sessionId = argv[++i] ?? "";
    else if (argv[i] === "--spawn-window") out.spawnWindow = true;
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readNdjsonTail(filePath, maxLines) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) return [];
    const events = [];
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try { events.push(JSON.parse(trimmed)); } catch {}
    }
    return events.slice(-maxLines);
  } catch {
    return [];
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function lockPathFor(workspaceRoot, sessionId) {
  const wolf = path.join(workspaceRoot, ".wolf");
  const safeId = String(sessionId || "unknown").replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(wolf, `monitor.${safeId}.lock`);
}

// ---------- Launcher mode ----------

function spawnVisibleWindow({ sessionId, workspaceRoot }) {
  if (process.platform !== "win32") {
    process.stderr.write("Monitor daemon window is currently only implemented for Windows.\n");
    process.exit(1);
  }

  const daemonScript = fileURLToPath(import.meta.url);
  const launcherPath = path.join(os.tmpdir(), `cf-monitor-daemon-${Date.now()}.ps1`);

  const safeExec = process.execPath.replaceAll("'", "''");
  const safeScript = daemonScript.replaceAll("'", "''");
  const safeSession = String(sessionId).replaceAll("'", "''");
  const safeCwd = String(workspaceRoot).replaceAll("'", "''");

  const launcherContent = [
    "\ufeff",
    `$host.ui.RawUI.WindowTitle = 'cf-monitor [${sessionId.slice(0, 8)}]'`,
    // Clear both the visible buffer AND scrollback at launch. The daemon's
    // per-frame clear handles ongoing redraws; this one-shot wipe ensures
    // the PowerShell window opens blank even on hosts (classic conhost)
    // that ignore the daemon's \x1b[3J sequence.
    `Clear-Host`,
    `Set-Location -LiteralPath '${safeCwd}'`,
    `& '${safeExec}' '${safeScript}' --session-id '${safeSession}'`
  ].join("\r\n");

  fs.writeFileSync(launcherPath, launcherContent, "utf8");

  const proc = spawn(
    "cmd",
    ["/c", "start", '"cf-monitor"', "powershell",
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath],
    { detached: true, stdio: "ignore" }
  );
  proc.unref();
  return proc.pid ?? null;
}

// ---------- Snapshot collection (filesystem → in-memory state) ----------

function loadSnapshot({ workspaceRoot, sessionId }) {
  const wolfPaths = resolveWolfPaths(workspaceRoot);
  const progress = readJsonSafe(path.join(wolfPaths.wolfDir, "enrichment.progress.json"));

  let sessionRecord = null;
  let currentTurn = null;
  const state = readJsonSafe(resolveStateFile(workspaceRoot));
  if (state && state.sessions && sessionId && state.sessions[sessionId]) {
    sessionRecord = state.sessions[sessionId];
    currentTurn = sessionRecord.currentTurn ?? null;
  }

  let latestRun = null;
  let events = [];
  if (currentTurn && currentTurn.latestRunId) {
    latestRun = readJsonSafe(resolveRunFile(workspaceRoot, currentTurn.latestRunId));
    const runDir = resolveRunArtifactsDir(workspaceRoot, currentTurn.latestRunId);
    events = readNdjsonTail(path.join(runDir, "events.jsonl"), 14);
  }

  return {
    progress,
    sessionRecord,
    currentTurn,
    latestRun,
    events,
    turnPhase: currentTurn?.phase ?? null,
    enrichmentPhase: progress?.phase ?? null
  };
}

// ---------- Rendering ----------

function renderHeader({ sessionId, snapshot }) {
  const lines = [];
  lines.push(`${BOLD}${CYAN}claudsterfuck monitor${RESET}  ${DIM}session ${sessionId.slice(0, 12)}...${RESET}`);
  const preview = extractSessionPromptPreview(snapshot.sessionRecord);
  lines.push(`${DIM}Prompt:${RESET} ${preview}`);
  const route = snapshot.currentTurn?.route;
  const phase = snapshot.currentTurn?.phase;
  if (route || phase) {
    lines.push(`${DIM}Route:${RESET}  ${route ?? "—"}  ${DIM}Phase:${RESET} ${phase ?? "—"}`);
  }
  lines.push("─".repeat(70));
  return lines.join("\n");
}

function renderBar(value, total, width = 30) {
  if (total <= 0) return `${DIM}${"─".repeat(width)}${RESET}`;
  const ratio = Math.max(0, Math.min(1, value / total));
  const filled = Math.round(ratio * width);
  return `${GREEN}${"█".repeat(filled)}${RESET}${DIM}${"░".repeat(width - filled)}${RESET}`;
}

function renderEnrichingView(snapshot) {
  const p = summarizeEnrichmentState(snapshot.progress);
  if (!p) return `${DIM}(no enrichment state)${RESET}`;
  const elapsed = p.startedAt ? formatDuration(Date.now() - Date.parse(p.startedAt)) : "—";
  const lines = [];
  lines.push(`${MAGENTA}▶ Memory enrichment${RESET}  ${DIM}${elapsed}${RESET}`);
  lines.push("");
  lines.push(`Phase:    ${p.phase}`);
  lines.push(`Files:    ${renderBar(p.filesEnriched, p.pending)}  ${p.filesEnriched}/${p.pending}`);
  lines.push(`Batches:  ${renderBar(p.batchesCompleted, p.batchesTotal)}  ${p.batchesCompleted}/${p.batchesTotal}`);
  if (p.filesErrored > 0) lines.push(`Errored:  ${RED}${p.filesErrored}${RESET}`);
  if (p.pruned > 0) lines.push(`Pruned:   ${YELLOW}${p.pruned}${RESET}`);
  if (p.currentBatch.length > 0) {
    lines.push("");
    lines.push(`${DIM}Current batch:${RESET}`);
    for (const file of p.currentBatch.slice(0, 5)) {
      lines.push(`  ${DIM}·${RESET} ${file}`);
    }
    if (p.currentBatch.length > 5) {
      lines.push(`  ${DIM}… +${p.currentBatch.length - 5} more${RESET}`);
    }
  }
  return lines.join("\n");
}

function renderDispatchView(snapshot) {
  const run = snapshot.latestRun;
  const turn = snapshot.currentTurn;
  const lines = [];
  const routeStr = turn?.route ?? "—";
  const providerStr = run?.provider ?? turn?.provider ?? "—";
  const runId = run?.id ?? turn?.latestRunId ?? "—";
  const elapsedMs = run?.startedAt ? Date.now() - Date.parse(run.startedAt) : 0;
  lines.push(`${BLUE}▶ Worker dispatch${RESET}  ${DIM}${formatDuration(elapsedMs)}${RESET}`);
  lines.push("");
  lines.push(`Route:    ${routeStr} → ${providerStr}`);
  lines.push(`Run:      ${runId}`);
  if (run?.status) lines.push(`Status:   ${run.status}`);

  if (snapshot.events.length > 0) {
    lines.push("");
    lines.push(`${DIM}Events:${RESET}`);
    for (const event of snapshot.events) {
      const summary = summarizeEvent(providerStr, event);
      if (!summary) continue;
      const label = String(summary.label ?? "").slice(0, 60);
      lines.push(`  ${summary.icon ?? "·"} ${label}`);
    }
  }
  return lines.join("\n");
}

function renderReviewingView(snapshot) {
  const run = snapshot.latestRun;
  const lines = [];
  lines.push(`${YELLOW}▶ Claude is reviewing worker output${RESET}`);
  lines.push("");
  if (run?.id) lines.push(`Run:      ${run.id}`);
  if (run?.status) lines.push(`Status:   ${run.status}`);
  if (run?.tokenUsage) {
    const usage = run.tokenUsage;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cached = usage.cached ?? 0;
    lines.push(`Tokens:   in=${input}  out=${output}  cached=${cached}`);
  }
  return lines.join("\n");
}

function renderIdleView(snapshot) {
  const lines = [];
  lines.push(`${DIM}▶ Idle — no active run or enrichment${RESET}`);
  lines.push("");

  // Last completed run (if any)
  const run = snapshot.latestRun;
  if (run && run.completedAt) {
    lines.push(`${DIM}Last run:${RESET} ${run.id}  ${run.status === "completed" ? GREEN : RED}${run.status}${RESET}  ${DIM}${new Date(run.completedAt).toLocaleString()}${RESET}`);
  }

  // Last enrichment (from progress file)
  if (snapshot.progress) {
    const p = snapshot.progress;
    const ts = p.updatedAt ?? p.startedAt;
    if (p.phase === "complete" || p.phase === "failed") {
      lines.push(`${DIM}Last enrichment:${RESET} ${p.phase === "complete" ? GREEN : RED}${p.phase}${RESET}  ${p.filesEnriched ?? 0} enriched  ${DIM}${ts ? new Date(ts).toLocaleString() : ""}${RESET}`);
    }
  }

  lines.push("");
  lines.push(buildIdleRecoveryHint());
  lines.push(`${DIM}Refresh: 1s. Close this window any time; reopen with /claudsterfuck:monitor${RESET}`);
  return lines.join("\n");
}

function renderFrame({ sessionId, snapshot }) {
  const view = selectView(snapshot);
  const parts = [CLEAR, renderHeader({ sessionId, snapshot }), ""];

  if (view === "dispatch") parts.push(renderDispatchView(snapshot));
  else if (view === "enriching") parts.push(renderEnrichingView(snapshot));
  else if (view === "reviewing") parts.push(renderReviewingView(snapshot));
  else parts.push(renderIdleView(snapshot));

  parts.push("");
  return parts.join("\n");
}

// ---------- Daemon loop ----------

async function runDaemonLoop({ sessionId, workspaceRoot }) {
  // Ensure CLAUDE_PLUGIN_DATA is populated. Subprocesses spawned via
  // `cmd /c start` don't inherit the env var that Claude Code hooks
  // otherwise set, so the daemon must discover the plugin-data dir
  // itself by probing conventional locations. Without this, we'd fall
  // back to an empty %TEMP% state dir and see "(no turn)" forever.
  ensurePluginDataEnv(workspaceRoot);

  const lockPath = lockPathFor(workspaceRoot, sessionId);
  const lockResult = tryAcquireLock(lockPath, { sessionId, workspaceRoot });
  if (!lockResult.acquired) {
    // Window already has a daemon for this session. Render a one-shot
    // notice and exit so the user can close this stale window.
    process.stdout.write(CLEAR);
    process.stdout.write(`${YELLOW}Another monitor daemon is already running${RESET}\n`);
    process.stdout.write(`  pid: ${lockResult.heldBy?.pid}\n`);
    process.stdout.write(`  since: ${lockResult.heldBy?.acquiredAt}\n\n`);
    process.stdout.write(`${DIM}Close this window. The existing monitor is at cf-monitor [${sessionId.slice(0, 8)}].${RESET}\n`);
    await sleep(5000);
    return;
  }

  const release = () => {
    try { releaseLock(lockPath, process.pid); } catch {}
  };
  process.on("SIGINT", () => { release(); process.exit(0); });
  process.on("SIGTERM", () => { release(); process.exit(0); });
  process.on("exit", release);

  let errorStreak = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const snapshot = loadSnapshot({ workspaceRoot, sessionId });
      process.stdout.write(renderFrame({ sessionId, snapshot }));
      errorStreak = 0;
    } catch (err) {
      errorStreak += 1;
      if (errorStreak >= 5) {
        process.stdout.write(`${RED}Monitor encountered repeated errors; exiting.${RESET}\n${err?.stack ?? err}\n`);
        return;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------- Entrypoint ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = process.cwd();

  if (!args.sessionId) {
    // Fallback: pull from env (hook-set variable). The launcher always
    // passes it explicitly; this just protects against manual invocation.
    args.sessionId = process.env.CLAUDSTERFUCK_SESSION_ID || "";
  }

  if (!args.sessionId) {
    process.stderr.write("Missing --session-id and no CLAUDSTERFUCK_SESSION_ID env var.\n");
    process.exit(1);
  }

  if (args.spawnWindow) {
    // Idempotent launch: if a daemon is already live for this session,
    // don't open another window.
    const lockPath = lockPathFor(workspaceRoot, args.sessionId);
    const existing = readLock(lockPath);
    if (existing && existing.pid && isPidAlive(existing.pid)) {
      process.stdout.write(`Monitor daemon already running (pid ${existing.pid}).\n`);
      return;
    }
    const pid = spawnVisibleWindow({ sessionId: args.sessionId, workspaceRoot });
    if (pid) {
      process.stdout.write(`Spawned monitor daemon window for session ${args.sessionId.slice(0, 8)}... (launcher pid ${pid}).\n`);
    } else {
      process.stderr.write("Failed to spawn monitor daemon window.\n");
      process.exit(1);
    }
    return;
  }

  await runDaemonLoop({ sessionId: args.sessionId, workspaceRoot });
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
