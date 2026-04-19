#!/usr/bin/env node

/**
 * orchestrator.mjs - Dispatch+Poll execution model for claudsterfuck
 *
 * Replaces the old synchronous orchestration model with a detached-process
 * model that survives Claude Code's Bash timeout limits. Provider processes
 * (Codex, Gemini) are spawned detached; the orchestrator returns immediately
 * after dispatch. A separate `watch` command polls for completion.
 *
 * Commands:
 *   dispatch  - Assemble prompt, spawn provider detached, return immediately
 *   watch     - Poll a running dispatch until completion or timeout
 *   status    - Session/turn state snapshot
 *   inspect   - Deep diagnostic snapshot (read-only)
 *   result    - Read completed run result
 *   cancel    - Kill running process, update state
 *   recover   - Find orphaned runs, mark them failed
 *   setup     - Check provider availability
 *   reroute   - Change route on current turn
 *   reset     - Clear current turn
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assembleWorkerPrompt } from "./routing/assemble-worker-prompt.mjs";
import { isDirectExecution } from "./lib/entrypoint.mjs";
import { SESSION_ID_ENV } from "./lib/hook-io.mjs";
import {
  appendWorkerRun,
  generateRunId,
  getSessionRecord,
  loadStateWithReadHealth,
  readRun,
  resolveRunArtifactsDir,
  resolveRunFile,
  resolveRunsDir,
  resolveStateFile,
  setCurrentTurn,
  TURN_DEFAULTS,
  TURN_PHASES,
  updateCurrentTurn,
  writeRun
} from "./lib/state.mjs";
import { loadRouteProfile } from "./routing/lib/config.mjs";
import {
  resolveWindowsCommandWithArgs,
  resolveCodexNodeEntrypoint,
  extractJson,
  isPathSafe,
  getProviderAvailability
} from "./lib/providers.mjs";
import { reconstructFromNdjson, summarizeEvent } from "./lib/event-stream.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const PLUGIN_DATA_SCAN_ROOT_ENV = "CLAUDSTERFUCK_PLUGIN_DATA_SCAN_ROOT";
const DEFAULT_STALLED_THRESHOLD_SECONDS = 120;
const DEFAULT_WATCH_TIMEOUT_SECONDS = 600; // 10 min — Codex can take 5-10 min in real runs
const WATCH_POLL_INTERVAL_MS = 2000;
const WATCH_PROGRESS_INTERVAL_MS = 10000; // 10s between events — limits token cost; output > telemetry

const GEMINI_STDIN_PROMPT =
  "Read the complete task instructions from stdin and follow them exactly. Treat stdin as the authoritative task.";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    command: "",
    provider: "",
    route: "",
    objective: "",
    sessionId: "",
    runId: "",
    timeout: DEFAULT_WATCH_TIMEOUT_SECONDS,
    json: false,
    watch: false,
    slim: false,
    forceStalled: false,
    heartbeat: false,
    stream: false,
    noMonitor: false,
    dryRun: false
  };

  const values = [...argv];
  args.command = values.shift() ?? "";

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--provider") {
      args.provider = values[index + 1] ?? "";
      index += 1;
    } else if (value === "--route") {
      args.route = values[index + 1] ?? "";
      index += 1;
    } else if (value === "--objective") {
      args.objective = values[index + 1] ?? "";
      index += 1;
    } else if (value === "--session-id") {
      args.sessionId = values[index + 1] ?? "";
      index += 1;
    } else if (value === "--run-id") {
      args.runId = values[index + 1] ?? "";
      index += 1;
    } else if (value === "--timeout") {
      const parsed = Number(values[index + 1]);
      args.timeout = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_WATCH_TIMEOUT_SECONDS;
      index += 1;
    } else if (value === "--json") {
      args.json = true;
    } else if (value === "--watch") {
      args.watch = true;
    } else if (value === "--slim") {
      args.slim = true;
    } else if (value === "--force-stalled") {
      args.forceStalled = true;
    } else if (value === "--heartbeat") {
      args.heartbeat = true;
    } else if (value === "--stream") {
      args.stream = true;
    } else if (value === "--no-monitor") {
      args.noMonitor = true;
    } else if (!value.startsWith("--")) {
      args.objective = args.objective ? `${args.objective} ${value}` : value;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function emit(payload, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const text =
    typeof payload?.finalOutput === "string" && payload.finalOutput.trim()
      ? payload.finalOutput.trim()
      : typeof payload?.message === "string"
        ? payload.message.trim()
        : JSON.stringify(payload, null, 2);

  process.stdout.write(`${text}\n`);
}

function emitLog(event, payload = null) {
  const stamp = new Date().toISOString();
  const serializedPayload = payload ? ` ${JSON.stringify(payload)}` : "";
  process.stderr.write(`[orchestrator] ${stamp} ${event}${serializedPayload}\n`);
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const contents = fs.readFileSync(filePath, "utf8");
    return contents.trim() ? JSON.parse(contents) : null;
  } catch {
    return null;
  }
}

function safeReadText(filePath, maxChars = 4000) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    return fs.readFileSync(filePath, "utf8").slice(0, maxChars);
  } catch {
    return null;
  }
}

function safeReadTail(filePath, maxChars = 2000) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, "utf8");
    if (content.length <= maxChars) {
      return content;
    }

    return content.slice(-maxChars);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Monitor window (Windows only)
// ---------------------------------------------------------------------------

/**
 * Spawn a visible PowerShell terminal window that tails the run's stdout
 * and polls the run record until the worker completes or fails.
 * The window stays open (Read-Host) after the run so the user can review output.
 * No-op on non-Windows platforms.
 */
function spawnMonitorWindow({ runId, runFile, stdoutFile }) {
  if (process.platform !== "win32") return;

  const monitorScript = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "monitor.mjs"
  );
  const launcherPath = path.join(os.tmpdir(), `cf-monitor-${runId}.ps1`);

  // Escape single quotes in paths by replacing ' with '' (PowerShell escaping)
  const safeExec = process.execPath.replaceAll("'", "''");
  const safeScript = monitorScript.replaceAll("'", "''");
  const safeRunFile = runFile.replaceAll("'", "''");
  const safeStdout = stdoutFile.replaceAll("'", "''");

  const launcherContent = [
    // UTF-8 BOM so PowerShell 5.1 reads the file as UTF-8 without codepage issues
    "\ufeff",
    `$host.ui.RawUI.WindowTitle = 'cf-monitor [${runId}]'`,
    `& '${safeExec}' '${safeScript}' --run-id '${runId}' --run-file '${safeRunFile}' --stdout-file '${safeStdout}'`,
    `Read-Host 'Worker done - press Enter to close'`,
  ].join("\r\n");

  try {
    fs.writeFileSync(launcherPath, launcherContent, "utf8");
    // cmd /c start is required to open a new visible console window (CREATE_NEW_CONSOLE).
    // detached:true alone only sets DETACHED_PROCESS — no visible window is created.
    // Title arg MUST carry its own double-quote chars: '"cf-monitor"' not "cf-monitor".
    const proc = spawn(
      "cmd",
      ["/c", "start", '"cf-monitor"', "powershell",
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath],
      { detached: true, stdio: "ignore" }
    );
    proc.unref();
    emitLog("monitor-spawned", { runId, pid: proc.pid });
  } catch (error) {
    // Non-fatal — main dispatch continues regardless
    emitLog("monitor-spawn-failed", { runId, error: String(error.message) });
  }
}

/**
 * Parse the first complete JSON object from text that may have trailing content
 * (e.g. Gemini CLI appends usage telemetry after its response JSON).
 * Handles escaped characters inside strings so nested { } in code snippets
 * don't confuse the depth counter.
 */
function extractFirstJsonObject(text) {
  const str = (text ?? "").trim();
  if (!str.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === "\"") { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(str.slice(0, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function resolveCurrentTurn(cwd, sessionId) {
  const session = getSessionRecord(cwd, sessionId);
  return session?.currentTurn ?? null;
}

function parseIsoMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolvePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.floor(numeric);
}

// ---------------------------------------------------------------------------
// Plugin data / state resolution (updated scan pattern: /claudsterfuck/i)
// ---------------------------------------------------------------------------

function withPluginDataDir(pluginDataDir, callback) {
  const previous = process.env[CLAUDE_PLUGIN_DATA_ENV];
  if (pluginDataDir) {
    process.env[CLAUDE_PLUGIN_DATA_ENV] = pluginDataDir;
  } else {
    delete process.env[CLAUDE_PLUGIN_DATA_ENV];
  }

  try {
    return callback();
  } finally {
    if (previous == null) {
      delete process.env[CLAUDE_PLUGIN_DATA_ENV];
    } else {
      process.env[CLAUDE_PLUGIN_DATA_ENV] = previous;
    }
  }
}

function discoverPluginDataCandidates() {
  const explicit = process.env[CLAUDE_PLUGIN_DATA_ENV];
  if (explicit) {
    return [explicit];
  }

  const scanRoot =
    process.env[PLUGIN_DATA_SCAN_ROOT_ENV] || path.join(os.homedir(), ".claude", "plugins", "data");
  if (!fs.existsSync(scanRoot)) {
    return [];
  }

  return fs
    .readdirSync(scanRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /claudsterfuck/i.test(entry.name))
    .map((entry) => path.join(scanRoot, entry.name));
}

function listSessionsByRecency(state) {
  const sessions = state?.sessions ?? {};
  return Object.entries(sessions)
    .map(([sessionId, record]) => ({
      sessionId,
      record
    }))
    .sort((left, right) =>
      String(right.record?.updatedAt ?? "").localeCompare(String(left.record?.updatedAt ?? ""))
    );
}

function buildStateCandidate(cwd, pluginDataDir) {
  const loadResult = withPluginDataDir(pluginDataDir, () => loadStateWithReadHealth(cwd));
  const state = loadResult.state;
  const sessions = listSessionsByRecency(state);
  const latestUpdatedMs = sessions.reduce(
    (max, entry) => Math.max(max, parseIsoMs(entry.record?.updatedAt ?? entry.record?.createdAt)),
    0
  );
  const hasCurrentTurn = sessions.some((entry) => Boolean(entry.record?.currentTurn));
  const paths = withPluginDataDir(pluginDataDir, () => ({
    stateFile: resolveStateFile(cwd),
    runsDir: resolveRunsDir(cwd)
  }));

  return {
    pluginDataDir: pluginDataDir ?? null,
    source: pluginDataDir ? "plugin-data" : "fallback-temp",
    state,
    readHealth: loadResult.readHealth ?? { status: "ok", warning: null },
    sessions,
    sessionCount: sessions.length,
    hasCurrentTurn,
    latestUpdatedMs,
    paths
  };
}

function resolveStateCandidate(cwd) {
  if (process.env[CLAUDE_PLUGIN_DATA_ENV]) {
    return buildStateCandidate(cwd, process.env[CLAUDE_PLUGIN_DATA_ENV]);
  }

  const candidates = [null, ...discoverPluginDataCandidates()].map((pluginDataDir) =>
    buildStateCandidate(cwd, pluginDataDir)
  );
  const withSessions = candidates.filter((candidate) => candidate.sessionCount > 0);
  if (withSessions.length === 0) {
    const pluginCandidate = candidates.find((candidate) => Boolean(candidate.pluginDataDir));
    return pluginCandidate ?? candidates[0];
  }

  withSessions.sort((left, right) => {
    if (left.hasCurrentTurn !== right.hasCurrentTurn) {
      return Number(right.hasCurrentTurn) - Number(left.hasCurrentTurn);
    }
    if (left.latestUpdatedMs !== right.latestUpdatedMs) {
      return right.latestUpdatedMs - left.latestUpdatedMs;
    }
    return right.sessionCount - left.sessionCount;
  });

  return withSessions[0];
}

function ensureResolvedPluginDataEnv(cwd) {
  if (process.env[CLAUDE_PLUGIN_DATA_ENV]) {
    return;
  }

  const stateCandidate = resolveStateCandidate(cwd);
  if (stateCandidate?.pluginDataDir) {
    process.env[CLAUDE_PLUGIN_DATA_ENV] = stateCandidate.pluginDataDir;
  }
}

// ---------------------------------------------------------------------------
// State source / liveness / session helpers
// ---------------------------------------------------------------------------

function buildStateSourceWarning(stateCandidate) {
  if (stateCandidate?.source !== "fallback-temp") {
    return null;
  }

  return "Using fallback temp state source. This is expected pre-session-binding; for bound sessions prefer plugin-data state to guarantee cross-terminal consistency.";
}

function resolveStalledThresholdSeconds(route) {
  const defaultThreshold = DEFAULT_STALLED_THRESHOLD_SECONDS;
  if (!route) {
    return defaultThreshold;
  }

  try {
    const profile = loadRouteProfile(route);
    return resolvePositiveInteger(
      profile.stalledThresholdSeconds ?? profile.stalled_threshold_seconds ?? defaultThreshold,
      defaultThreshold
    );
  } catch {
    return defaultThreshold;
  }
}

function computeSecondsAgo(timestampMs, nowMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return null;
  }

  return Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
}

function computeRunLiveness(run, nowMs = Date.now()) {
  const status = String(run?.status ?? "").toLowerCase();
  const isRunning = status === "running" || status === "worker-running";
  if (!isRunning) {
    return {
      ageSeconds: null,
      lastHeartbeatSecondsAgo: null,
      stalled: null,
      stalledThresholdSeconds: null,
      stalledSource: null,
      stalledNote: null
    };
  }

  const startedAtMs = parseIsoMs(run?.startedAt);
  const ageSeconds = computeSecondsAgo(startedAtMs, nowMs);
  const provider = String(run?.provider ?? "").toLowerCase();
  if (provider !== "codex") {
    return {
      ageSeconds,
      lastHeartbeatSecondsAgo: null,
      stalled: null,
      stalledThresholdSeconds: null,
      stalledSource: null,
      stalledNote: "Heartbeat telemetry unavailable for this provider."
    };
  }

  const thresholdSeconds = resolveStalledThresholdSeconds(run?.route);
  const progressFile = run?.artifacts?.progressFile ?? null;
  let heartbeatSecondsAgo = null;
  if (progressFile && fs.existsSync(progressFile)) {
    try {
      heartbeatSecondsAgo = computeSecondsAgo(fs.statSync(progressFile).mtimeMs, nowMs);
    } catch {
      heartbeatSecondsAgo = null;
    }
  }

  let stalledSource = null;
  let stalled = null;
  let stalledNote = null;

  if (heartbeatSecondsAgo != null) {
    stalledSource = "progress-file";
    stalled = heartbeatSecondsAgo > thresholdSeconds;
  } else if (ageSeconds != null) {
    stalledSource = "run-age";
    stalled = ageSeconds > thresholdSeconds;
    stalledNote = "Progress telemetry missing; using run age fallback.";
  }

  return {
    ageSeconds,
    lastHeartbeatSecondsAgo: heartbeatSecondsAgo,
    stalled,
    stalledThresholdSeconds: thresholdSeconds,
    stalledSource,
    stalledNote
  };
}

function resolveSessionForStatus(orderedSessions, sessionId) {
  if (sessionId) {
    const found = orderedSessions.find((entry) => entry.sessionId === sessionId);
    return {
      sessionId,
      session: found?.record ?? null
    };
  }

  const withTurn = orderedSessions.find((entry) => entry.record?.currentTurn);
  const chosen = withTurn ?? orderedSessions[0] ?? null;
  if (!chosen) {
    return {
      sessionId: "",
      session: null
    };
  }

  return {
    sessionId: chosen.sessionId,
    session: chosen.record ?? null
  };
}

function loadRecentRuns(runsDir, maxRuns = 10) {
  if (!runsDir || !fs.existsSync(runsDir)) {
    return [];
  }

  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(runsDir, entry.name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
    .slice(0, maxRuns)
    .map((filePath) => {
      try {
        const run = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const progressFile = run?.artifacts?.progressFile;
        let progress = null;
        if (progressFile && fs.existsSync(progressFile)) {
          try {
            progress = JSON.parse(fs.readFileSync(progressFile, "utf8"));
          } catch {
            progress = null;
          }
        }

        const runSummary = {
          runId: run.id ?? path.basename(filePath, ".json"),
          status: run.status ?? null,
          sessionId: run.sessionId ?? null,
          route: run.route ?? null,
          provider: run.provider ?? null,
          startedAt: run.startedAt ?? null,
          completedAt: run.completedAt ?? null,
          timeoutSeconds: run.timeoutSeconds ?? null,
          exitCode: run.exitCode ?? null,
          errorSummary: run.errorSummary ?? null,
          artifacts: {
            progressFile: run?.artifacts?.progressFile ?? null,
            liveStdoutFile: run?.artifacts?.liveStdoutFile ?? null
          },
          progress
        };
        return {
          ...runSummary,
          liveness: computeRunLiveness(runSummary)
        };
      } catch {
        return {
          runId: path.basename(filePath, ".json"),
          unreadable: true
        };
      }
    });
}

// ---------------------------------------------------------------------------
// Artifact helpers
// ---------------------------------------------------------------------------

function ensureRunArtifactsDir(cwd, runId) {
  const directory = resolveRunArtifactsDir(cwd, runId);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function writeTextArtifact(filePath, contents) {
  if (typeof contents !== "string" || contents.length === 0) {
    return null;
  }

  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function writeJsonArtifact(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

/**
 * Emit the terminal latest-event.json record once a run has finished, so consumers
 * (statusline, monitor) see the final status immediately after the watch loop
 * finalizes the run.
 */
function writeLatestEventTerminal(runArtifactsDir, { provider, runId, route, status }) {
  try {
    const payload = {
      provider,
      runId,
      route: route ?? null,
      icon: status === "completed" ? "✓" : "✗",
      label: status === "completed" ? "complete" : "failed",
      eventType: "terminal",
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(
      path.join(runArtifactsDir, "latest-event.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8"
    );
  } catch {}
}

/**
 * Tail the detached run's stdout file, parse each new NDJSON line since the last
 * position, and update latest-event.json with a compact summary of the most recent
 * event. This lets the statusline reflect live worker progress while the watch
 * loop polls.
 *
 * Maintains state via the options object so the caller can preserve the byte offset
 * across watch iterations.
 */
function tailStdoutForEvents(stdoutFile, runArtifactsDir, state) {
  if (!stdoutFile || !runArtifactsDir || !state) return;
  let stat;
  try {
    stat = fs.statSync(stdoutFile);
  } catch {
    return;
  }
  if (!stat || stat.size <= state.offset) {
    return;
  }

  let fd;
  try {
    fd = fs.openSync(stdoutFile, "r");
    const length = stat.size - state.offset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, state.offset);
    state.offset = stat.size;
    const chunk = buffer.toString("utf8");
    const lines = (state.carry + chunk).split(/\r?\n/);
    state.carry = lines.pop() ?? "";

    let lastSummary = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const summary = summarizeEvent(state.provider, event);
      if (summary) lastSummary = summary;
    }

    if (lastSummary) {
      try {
        fs.writeFileSync(
          path.join(runArtifactsDir, "latest-event.json"),
          `${JSON.stringify(
            {
              provider: state.provider,
              runId: state.runId,
              route: state.route ?? null,
              icon: lastSummary.icon,
              label: lastSummary.label,
              eventType: lastSummary.eventType,
              timestamp: new Date().toISOString()
            },
            null,
            2
          )}\n`,
          "utf8"
        );
      } catch {}
    }
  } catch {} finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function normalizeException(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  return {
    exitCode: -1,
    stdout: "",
    stderr: message,
    finalOutput: "",
    providerSessionId: null,
    errorSummary: error instanceof Error ? error.message : String(error)
  };
}

// ---------------------------------------------------------------------------
// Turn finalization
// ---------------------------------------------------------------------------

function finalizeCurrentTurn(cwd, sessionId, runId, finalStatus, completedAt, result) {
  if (!sessionId) {
    return;
  }

  updateCurrentTurn(cwd, sessionId, (turn) => {
    if (!turn) {
      return turn;
    }

    const workerRuns = Array.isArray(turn.workerRuns) ? turn.workerRuns : [];
    const updatedRuns = workerRuns.map((entry) =>
      entry.id === runId
        ? {
            ...entry,
            status: finalStatus,
            completedAt,
            exitCode: result.exitCode,
            providerSessionId: result.providerSessionId ?? null,
            errorSummary: result.errorSummary ?? null
          }
        : entry
    );

    return {
      ...turn,
      phase: finalStatus === "completed" ? TURN_PHASES.REVIEWING : TURN_PHASES.READY_TO_DELEGATE,
      status: finalStatus === "completed" ? "worker-complete" : "worker-failed",
      latestRunId: runId,
      latestRunStatus: finalStatus,
      latestRunErrorSummary: finalStatus === "completed" ? null : result.errorSummary ?? null,
      workerRuns: updatedRuns
    };
  });
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

/**
 * Check if a process with the given PID is still alive.
 * Sends signal 0 (no actual signal) to probe existence.
 */
function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process (it exited). EPERM = exists but we can't signal it (still alive).
    if (error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * Kill a process by PID. On Windows, uses taskkill /F /T /PID to kill the
 * entire process tree. On other platforms, sends SIGTERM.
 */
function killProcess(pid) {
  if (!pid) {
    return false;
  }

  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("error", () => {});
      killer.unref();
    } else {
      // Use negative PID to kill the entire process group (detached children become group leaders)
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // Fall back to killing just the PID if group kill fails (e.g. EPERM, PID reuse)
        process.kill(pid, "SIGTERM");
      }
    }
    return true;
  } catch {
    return false;
  }
}

// Spawn errors that warrant trying a fallback candidate instead of failing immediately.
const SPAWN_RETRY_CODES = new Set(["EPERM", "ENOENT", "EACCES", "ENOTDIR"]);

/**
 * Build the ordered list of spawn candidates for a provider command.
 *
 * For Codex on Windows the priority is:
 *   1. Native codex.exe (our primary; windowsHide applies end-to-end)
 *   2. Node.js wrapper (bin/codex.js) — fallback if native binary spawn fails
 *
 * PowerShell and cmd.exe shims are intentionally excluded from the runtime
 * fallback chain: PowerShell's ExpectingInput gate silently drops piped stdin,
 * and cmd.exe has quoting/length fragility. Both failure modes are documented
 * in cerebrum.md Do-Not-Repeat.
 */
function buildSpawnCandidates(command, args) {
  const primary = resolveWindowsCommandWithArgs(command, args);
  const candidates = [primary];

  if (command === "codex" && process.platform === "win32") {
    const isPrimaryNative = primary.command.endsWith(".exe") &&
      !primary.command.toLowerCase().includes("node");
    if (isPrimaryNative) {
      // Add node-wrapper as safe fallback (avoids PowerShell/cmd)
      const npmShimDir = process.env.APPDATA
        ? path.join(process.env.APPDATA, "npm")
        : "";
      const nodeEntrypoint = resolveCodexNodeEntrypoint(npmShimDir);
      if (nodeEntrypoint) {
        candidates.push({ command: process.execPath, args: [nodeEntrypoint, ...args] });
      }
    }
  }

  return candidates;
}

/**
 * Core implementation of spawnDetached. Accepts an injectable `_spawnFn` for
 * testing; production code uses the real `spawn` from node:child_process.
 *
 * Returns { pid, stdoutFile, stderrFile, resolvedCommand, resolvedArgs, spawnAttempts }.
 */
export function spawnDetachedWithFn(command, args, options) {
  const spawnFn = options._spawnFn ?? spawn;
  const candidates = options._candidates ?? buildSpawnCandidates(command, args);
  const stdoutPath = options.stdoutFile;
  const stderrPath = options.stderrFile;
  const spawnAttempts = [];

  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");

  let child;
  let lastError;
  let successfulCandidate;

  for (const candidate of candidates) {
    try {
      child = spawnFn(candidate.command, candidate.args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: ["pipe", stdoutFd, stderrFd],
        // On POSIX, detached makes the child a process group leader so killProcess()
        // can send signals to the whole group via kill(-pid). On Windows, detached
        // conflicts with windowsHide (Node.js #21825) causing console window flashes;
        // taskkill /T handles tree kills without needing a process group.
        detached: process.platform !== "win32",
        windowsHide: true
      });
      spawnAttempts.push({ command: candidate.command, args: candidate.args, success: true });
      successfulCandidate = candidate;
      break;
    } catch (error) {
      const code = error?.code ?? "";
      spawnAttempts.push({
        command: candidate.command,
        args: candidate.args,
        success: false,
        errorCode: code || null,
        errorMessage: error?.message ?? String(error)
      });
      lastError = error;
      if (!SPAWN_RETRY_CODES.has(code)) {
        // Non-retryable error — stop trying
        break;
      }
      // Continue to next candidate
    }
  }

  if (!child) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    throw lastError;
  }

  // Write prompt to stdin then close
  if (options.stdin) {
    child.stdin.write(options.stdin);
  }
  child.stdin.end();

  // Close file descriptors so parent doesn't hold them open
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  // Allow the parent process to exit without waiting for this child
  child.unref();

  return {
    pid: child.pid,
    stdoutFile: stdoutPath,
    stderrFile: stderrPath,
    resolvedCommand: successfulCandidate.command,
    resolvedArgs: successfulCandidate.args,
    spawnAttempts
  };
}

/**
 * Spawn a provider process detached from the parent. The child's stdout and
 * stderr are redirected to files so they can be read later. The parent does
 * not wait for the child to exit.
 *
 * Returns { pid, stdoutFile, stderrFile, resolvedCommand, resolvedArgs, spawnAttempts }.
 */
function spawnDetached(command, args, options) {
  return spawnDetachedWithFn(command, args, options);
}

/**
 * Read process info from the run artifacts directory.
 * Returns { pid, stdoutFile, stderrFile, startedAt } or null.
 */
function readRunProcess(cwd, runId) {
  const artifactsDir = resolveRunArtifactsDir(cwd, runId);
  const processInfoPath = path.join(artifactsDir, "process.json");
  return readJsonFileSafe(processInfoPath);
}

/**
 * Write process info to the run artifacts directory.
 */
function writeRunProcess(cwd, runId, processInfo) {
  const artifactsDir = resolveRunArtifactsDir(cwd, runId);
  const processInfoPath = path.join(artifactsDir, "process.json");
  writeJsonArtifact(processInfoPath, processInfo);
}

// ---------------------------------------------------------------------------
// Provider-specific argument builders
// ---------------------------------------------------------------------------

function buildCodexArgs(options) {
  const args = [
    "exec", "-",
    "-C", options.cwd,
    "--skip-git-repo-check",
    "--sandbox", options.writeEnabled ? "workspace-write" : "read-only",
    "--json",
    "--output-last-message", options.outputFile
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  return args;
}

function buildGeminiArgs(options) {
  const args = [
    "-p", GEMINI_STDIN_PROMPT,
    "--output-format", "stream-json",
    "--approval-mode", options.writeEnabled ? "yolo" : "plan"
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Result parsing (post-completion)
// ---------------------------------------------------------------------------

function summarizeError(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  return lines.slice(-6).join(" | ");
}

/**
 * Parse finalOutput as JSON and write any declared artifacts to disk inside cwd.
 * Returns an array of per-artifact status records, or null if no artifacts.
 */
function writeArtifactsFromOutput(finalOutput, cwd, runArtifactsDir) {
  const parsed = extractJson(finalOutput);

  if (!parsed || !Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0) {
    return null;
  }

  const results = [];

  for (const artifact of parsed.artifacts) {
    if (typeof artifact.path !== "string" || artifact.path.trim() === "") {
      results.push({ path: artifact.path ?? null, status: "skipped", reason: "missing path" });
      continue;
    }
    if (typeof artifact.content !== "string") {
      results.push({ path: artifact.path, status: "skipped", reason: "missing content" });
      continue;
    }
    if (!isPathSafe(cwd, artifact.path)) {
      results.push({ path: artifact.path, status: "rejected", reason: "path outside workspace" });
      continue;
    }

    const targetPath = path.resolve(cwd, artifact.path);
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, artifact.content, artifact.encoding ?? "utf8");
      results.push({ path: artifact.path, status: "written", targetPath });
    } catch (error) {
      results.push({
        path: artifact.path,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  try {
    fs.writeFileSync(
      path.join(runArtifactsDir, "artifacts.json"),
      `${JSON.stringify(results, null, 2)}\n`,
      "utf8"
    );
  } catch {}

  return results;
}

// Routes that produce file-system changes as their primary output.
// For these, empty last-message.txt with a clean exit is valid — file edits are the real artifact.
const WRITE_ROUTES = new Set(["implement", "debug", "implement-artifact"]);

export function computeCodexDetachedExitCode({ finalOutput, route, stderrRaw }) {
  const hasOutput = String(finalOutput ?? "").trim().length > 0;
  if (hasOutput) return 0;
  if (WRITE_ROUTES.has(route ?? "")) {
    // Write-mode: only fail if stderr signals a problem; silent exit 0 with no message is ok.
    return String(stderrRaw ?? "").trim().length > 0 ? 1 : 0;
  }
  return 1;
}

/**
 * Finalize a Codex run: read the output file, parse artifacts, compute error summary.
 */
function finalizeCodexResult(cwd, runId, run, processInfo) {
  const runArtifactsDir = resolveRunArtifactsDir(cwd, runId);
  const outputFile = run.artifacts?.lastMessageFile ?? path.join(runArtifactsDir, "last-message.txt");
  const stdoutRaw = safeReadText(processInfo.stdoutFile, 500000) ?? "";
  const stderrRaw = safeReadText(processInfo.stderrFile, 100000) ?? "";

  const fileFinalOutput = fs.existsSync(outputFile)
    ? fs.readFileSync(outputFile, "utf8").trim()
    : "";

  // Parse NDJSON events from stdout to extract providerSessionId (thread_id) and, if the
  // --output-last-message file is missing or empty, the final agent_message text.
  const reconstructed = reconstructFromNdjson("codex", stdoutRaw);
  const finalOutput = fileFinalOutput || reconstructed.finalOutput || "";

  const exitCode = computeCodexDetachedExitCode({ finalOutput, route: run.route, stderrRaw });
  const errorSummary = exitCode === 0
    ? null
    : summarizeError(stderrRaw || stdoutRaw) || (finalOutput.length === 0 ? "Codex produced no output" : null);

  // Write raw stdout/stderr artifacts
  writeTextArtifact(path.join(runArtifactsDir, "stdout.raw.txt"), stdoutRaw);
  writeTextArtifact(path.join(runArtifactsDir, "stderr.raw.txt"), stderrRaw);

  // Mirror the NDJSON stream into events.jsonl and emit a terminal latest-event.json
  // so downstream consumers (statusline, monitor) have a canonical event source.
  if (stdoutRaw) {
    writeTextArtifact(path.join(runArtifactsDir, "events.jsonl"), stdoutRaw);
  }
  writeLatestEventTerminal(runArtifactsDir, {
    provider: "codex",
    runId,
    route: run.route,
    status: exitCode === 0 ? "completed" : "failed"
  });

  // Artifact handoff for return-artifacts mode
  const artifactMode = run.artifactMode ?? null;
  const writtenArtifacts =
    artifactMode === "return-artifacts" && finalOutput
      ? writeArtifactsFromOutput(finalOutput, cwd, runArtifactsDir)
      : null;

  const normalizedResult = {
    runId,
    provider: "codex",
    route: run.route,
    status: exitCode === 0 ? "completed" : "failed",
    finalOutput,
    providerSessionId: reconstructed.providerSessionId,
    tokenUsage: reconstructed.tokenUsage ?? null,
    errorSummary,
    writtenArtifacts
  };

  writeJsonArtifact(path.join(runArtifactsDir, "result.normalized.json"), normalizedResult);

  return {
    exitCode,
    stdout: stdoutRaw,
    stderr: stderrRaw,
    finalOutput,
    providerSessionId: reconstructed.providerSessionId,
    tokenUsage: reconstructed.tokenUsage ?? null,
    errorSummary,
    writtenArtifacts
  };
}

/**
 * Finalize a Gemini run: parse NDJSON stream-json output to reconstruct the
 * session_id and assistant response from the event stream.
 */
function finalizeGeminiResult(cwd, runId, run, processInfo) {
  const runArtifactsDir = resolveRunArtifactsDir(cwd, runId);
  const stdoutRaw = safeReadText(processInfo.stdoutFile, 500000) ?? "";
  const stderrRaw = safeReadText(processInfo.stderrFile, 100000) ?? "";

  const reconstructed = reconstructFromNdjson("gemini", stdoutRaw);
  const providerSessionId = reconstructed.providerSessionId;
  const finalOutput = reconstructed.finalOutput;
  const hasOutput = finalOutput.length > 0;

  // Empty output from Gemini is always a failure — a successful run must produce output.
  const exitCode = hasOutput ? 0 : 1;
  const errorSummary = exitCode === 0
    ? null
    : summarizeError(reconstructed.providerReportedError || stderrRaw) ||
      "Gemini produced no output (possible spawn or relaunch failure)";

  // Write raw artifacts
  writeTextArtifact(path.join(runArtifactsDir, "stdout.raw.txt"), stdoutRaw);
  writeTextArtifact(path.join(runArtifactsDir, "stderr.raw.txt"), stderrRaw);

  // Mirror NDJSON into events.jsonl and emit terminal latest-event.json
  if (stdoutRaw) {
    writeTextArtifact(path.join(runArtifactsDir, "events.jsonl"), stdoutRaw);
  }
  writeLatestEventTerminal(runArtifactsDir, {
    provider: "gemini",
    runId,
    route: run.route,
    status: exitCode === 0 ? "completed" : "failed"
  });

  const normalizedResult = {
    runId,
    provider: "gemini",
    route: run.route,
    status: exitCode === 0 ? "completed" : "failed",
    finalOutput,
    providerSessionId,
    tokenUsage: reconstructed.tokenUsage ?? null,
    errorSummary
  };

  writeJsonArtifact(path.join(runArtifactsDir, "result.normalized.json"), normalizedResult);

  return {
    exitCode,
    stdout: stdoutRaw,
    stderr: stderrRaw,
    finalOutput,
    providerSessionId,
    tokenUsage: reconstructed.tokenUsage ?? null,
    errorSummary
  };
}

/**
 * Finalize a completed run by reading its output and updating state.
 */
// Extracts file paths the worker actually touched during the run from the
// structured event stream. Used to compare against the files the memory
// packet surfaced — the overlap/miss signal drives future compiler learning
// and is the observability floor for packet quality regressions.
function computePacketVsReadsTelemetry(runArtifactsDir, memoryIncludedFiles) {
  const eventsFile = path.join(runArtifactsDir, "events.jsonl");
  if (!fs.existsSync(eventsFile)) {
    return null;
  }

  const readPathKeys = ["file_path", "path", "absolute_path", "dir_path", "filename"];
  const workerReadFiles = new Set();
  let toolCallCount = 0;

  let raw;
  try {
    raw = fs.readFileSync(eventsFile, "utf8");
  } catch {
    return null;
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "tool_use") continue;
    toolCallCount += 1;
    const parameters = event.parameters ?? {};
    for (const key of readPathKeys) {
      const value = parameters[key];
      if (typeof value === "string" && value.trim()) {
        workerReadFiles.add(normalizeReadPath(value));
      }
    }
  }

  const packetFiles = Array.isArray(memoryIncludedFiles) ? [...new Set(memoryIncludedFiles)] : [];
  const workerReadArray = [...workerReadFiles];
  const packetSet = new Set(packetFiles);
  const workerReadBaseNames = new Set(workerReadArray.map(baseName));

  // A packet file is "used" if the worker read the exact normalized path OR a
  // file with the same basename. Loose match tolerates workspace-root drift.
  const unusedPacketFiles = packetFiles.filter((file) => {
    if (workerReadFiles.has(file)) return false;
    return !workerReadBaseNames.has(baseName(file));
  });
  const overlap = packetFiles.length - unusedPacketFiles.length;
  const missedFiles = workerReadArray.filter((file) => !packetSet.has(file) && !packetSet.has(baseName(file)));

  return {
    packetFiles,
    workerReadFiles: workerReadArray,
    overlap,
    missedFiles,
    unusedPacketFiles,
    toolCallCount
  };
}

function normalizeReadPath(input) {
  return String(input).replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
}

function baseName(filePath) {
  const normalized = normalizeReadPath(filePath);
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function finalizeRun(cwd, runId, run, processInfo) {
  const provider = String(run.provider ?? "").toLowerCase();

  let result;
  if (provider === "codex") {
    result = finalizeCodexResult(cwd, runId, run, processInfo);
  } else if (provider === "gemini") {
    result = finalizeGeminiResult(cwd, runId, run, processInfo);
  } else {
    // Generic fallback: just read stdout
    const runArtifactsDir = resolveRunArtifactsDir(cwd, runId);
    const stdoutRaw = safeReadText(processInfo.stdoutFile, 500000) ?? "";
    const stderrRaw = safeReadText(processInfo.stderrFile, 100000) ?? "";
    const exitCode = stderrRaw.trim().length > 0 ? 1 : 0;

    writeTextArtifact(path.join(runArtifactsDir, "stdout.raw.txt"), stdoutRaw);
    writeTextArtifact(path.join(runArtifactsDir, "stderr.raw.txt"), stderrRaw);

    result = {
      exitCode,
      stdout: stdoutRaw,
      stderr: stderrRaw,
      finalOutput: stdoutRaw.trim(),
      providerSessionId: null,
      errorSummary: exitCode === 0 ? null : summarizeError(stderrRaw || stdoutRaw)
    };
  }

  const completedAt = new Date().toISOString();
  const finalStatus = result.exitCode === 0 ? "completed" : "failed";

  const runArtifactsDir = resolveRunArtifactsDir(cwd, runId);
  const packetVsReads = computePacketVsReadsTelemetry(runArtifactsDir, run.memoryIncludedFiles ?? []);

  // Update the run record
  const completedRun = {
    ...run,
    status: finalStatus,
    completedAt,
    exitCode: result.exitCode,
    finalOutput: result.finalOutput,
    providerSessionId: result.providerSessionId ?? null,
    tokenUsage: result.tokenUsage ?? null,
    errorSummary: result.errorSummary ?? null,
    packetVsReads,
    artifacts: {
      ...run.artifacts,
      stdoutFile: processInfo.stdoutFile,
      stderrFile: processInfo.stderrFile,
      eventsFile: path.join(runArtifactsDir, "events.jsonl"),
      latestEventFile: path.join(runArtifactsDir, "latest-event.json"),
      normalizedResultFile: path.join(runArtifactsDir, "result.normalized.json")
    }
  };

  writeRun(cwd, runId, completedRun);

  // Update turn state
  const sessionId = run.sessionId ?? null;
  if (sessionId) {
    finalizeCurrentTurn(cwd, sessionId, runId, finalStatus, completedAt, result);
  }

  return {
    runId,
    provider: run.provider,
    route: run.route,
    status: finalStatus,
    exitCode: result.exitCode,
    finalOutput: result.finalOutput,
    providerSessionId: result.providerSessionId ?? null,
    errorSummary: result.errorSummary ?? null,
    completedAt,
    writtenArtifacts: result.writtenArtifacts ?? null
  };
}

// ---------------------------------------------------------------------------
// Command: dispatch
// ---------------------------------------------------------------------------

export async function handleDispatch(cwd, args, overrides = {}) {
  ensureResolvedPluginDataEnv(cwd);

  // Resolve session
  let sessionId = args.sessionId || process.env[SESSION_ID_ENV] || "";
  if (!sessionId) {
    const stateCandidate = resolveStateCandidate(cwd);
    sessionId = resolveSessionForStatus(stateCandidate.sessions, "").sessionId || "";
  }
  if (!sessionId) {
    throw new Error(
      "Missing session binding for dispatch. Resolve routed state first with status/inspect, then dispatch in the same session or pass --session-id."
    );
  }

  // Resolve current turn
  const currentTurn = resolveCurrentTurn(cwd, sessionId);
  if (!currentTurn) {
    throw new Error(
      `No active routed turn found for session "${sessionId}". Create or reroute a turn first, then dispatch.`
    );
  }

  if (args.route || args.provider) {
    throw new Error(
      "Bound-session dispatch rejects CLI overrides (--provider/--route). Route and provider come from the active turn. Use reroute to change route/provider."
    );
  }

  const route = currentTurn?.route || "";
  const provider = currentTurn?.provider || undefined;
  // args.objective lets Claude pass a refined objective without touching turn state.
  // Route and provider remain authoritative from turn state; only the task description
  // can be refined here.
  const objective = args.objective || currentTurn?.objective || currentTurn?.prompt || "";

  if (!route) {
    throw new Error("Missing route. Provide --route or start from a routed Claude turn.");
  }
  if (!objective.trim()) {
    throw new Error("Missing objective text for dispatch.");
  }

  // Assemble prompt
  const assembled = (overrides.assembleWorkerPromptFn ?? assembleWorkerPrompt)({
    workspaceRoot: cwd,
    route,
    provider,
    objective
  });

  if (assembled.requiresDelegation === false) {
    throw new Error(`Route "${assembled.route}" does not require delegation.`);
  }
  if (!assembled.provider) {
    throw new Error(`Route "${assembled.route}" does not declare a worker provider.`);
  }

  const supportedProviders = ["codex", "gemini"];
  if (!supportedProviders.includes(assembled.provider)) {
    throw new Error(`Unsupported provider "${assembled.provider}".`);
  }

  if (args.dryRun) {
    const payload = {
      success: true,
      dryRun: true,
      route: assembled.route,
      provider: assembled.provider,
      objective,
      promptLength: assembled.prompt.length,
      prompt: assembled.prompt,
      message: `[DRY RUN]\nRoute: ${assembled.route}\nProvider: ${assembled.provider}\nObjective: ${objective}\nPrompt length: ${assembled.prompt.length} chars\n\n=== PROMPT START ===\n${assembled.prompt}\n=== PROMPT END ===`
    };
    emit(payload, args.json);
    return;
  }

  // Generate run and artifacts
  const timeoutSeconds = assembled.timeoutSeconds ?? 900;
  const runId = generateRunId(assembled.provider);
  const runArtifactsDir = ensureRunArtifactsDir(cwd, runId);
  const promptFile = writeTextArtifact(path.join(runArtifactsDir, "prompt.md"), assembled.prompt);
  const runOutputFile = path.join(runArtifactsDir, "last-message.txt");
  const stdoutFile = path.join(runArtifactsDir, "stdout.live.txt");
  const stderrFile = path.join(runArtifactsDir, "stderr.live.txt");
  const startedAt = new Date().toISOString();

  // Build provider-specific args
  let providerCommand;
  let providerArgs;

  if (assembled.provider === "codex") {
    providerCommand = "codex";
    providerArgs = buildCodexArgs({
      cwd,
      writeEnabled: assembled.writeEnabled,
      outputFile: runOutputFile,
      model: ""
    });
  } else {
    providerCommand = "gemini";
    providerArgs = buildGeminiArgs({
      writeEnabled: assembled.writeEnabled,
      model: ""
    });
  }

  // Write initial run record
  const initialRun = {
    id: runId,
    sessionId: sessionId || null,
    route: assembled.route,
    provider: assembled.provider,
    objective,
    status: "running",
    timeoutSeconds,
    startedAt,
    artifactMode: assembled.artifactMode ?? null,
    memoryQuality: assembled.memoryQuality ?? null,
    memoryIncludedFiles: Array.isArray(assembled.memoryIncludedChunks)
      ? [...new Set(assembled.memoryIncludedChunks.map((chunk) => chunk?.source).filter(Boolean))]
      : [],
    artifacts: {
      promptFile,
      lastMessageFile: runOutputFile,
      stdoutFile,
      stderrFile,
      normalizedResultFile: null,
      liveStdoutFile: stdoutFile,
      progressFile: path.join(runArtifactsDir, "progress.json")
    }
  };

  writeRun(cwd, runId, initialRun);

  // Register in turn state
  if (sessionId) {
    appendWorkerRun(cwd, sessionId, {
      id: runId,
      provider: assembled.provider,
      route: assembled.route,
      phase: TURN_PHASES.WORKER_RUNNING,
      status: "worker-running",
      latestRunStatus: "running",
      errorSummary: null,
      startedAt
    });
  }

  // Build spawn environment — inject provider-specific env vars
  const spawnEnv = { ...process.env };
  if (assembled.provider === "gemini") {
    // Gemini CLI 0.37+ relaunches itself via spawn(process.execPath, ...) by default.
    // In a detached process context on Windows this fails with EPERM.
    // Suppress the relaunch so Gemini runs in-process.
    spawnEnv.GEMINI_CLI_NO_RELAUNCH = "true";
  }

  // Spawn detached process
  let spawnResult;
  try {
    spawnResult = spawnDetached(providerCommand, providerArgs, {
      cwd,
      env: spawnEnv,
      stdin: assembled.prompt,
      stdoutFile,
      stderrFile
    });
  } catch (error) {
    // Spawn itself failed - mark run as failed immediately
    const errorResult = normalizeException(error);
    const completedAt = new Date().toISOString();
    const failedRun = {
      ...initialRun,
      status: "failed",
      completedAt,
      exitCode: -1,
      errorSummary: errorResult.errorSummary
    };
    writeRun(cwd, runId, failedRun);
    finalizeCurrentTurn(cwd, sessionId, runId, "failed", completedAt, errorResult);

    throw new Error(`Failed to spawn ${assembled.provider}: ${errorResult.errorSummary}`);
  }

  // Write process info for watch to pick up.
  // Include resolved command path and injected env flags for post-mortem diagnostics.
  const injectedEnvFlags = {};
  if (spawnEnv.GEMINI_CLI_NO_RELAUNCH) {
    injectedEnvFlags.GEMINI_CLI_NO_RELAUNCH = spawnEnv.GEMINI_CLI_NO_RELAUNCH;
  }
  const processInfo = {
    pid: spawnResult.pid,
    stdoutFile: spawnResult.stdoutFile,
    stderrFile: spawnResult.stderrFile,
    startedAt,
    provider: assembled.provider,
    providerCommand,
    providerArgs,
    resolvedCommand: spawnResult.resolvedCommand ?? null,
    resolvedArgs: spawnResult.resolvedArgs ?? null,
    spawnAttempts: spawnResult.spawnAttempts?.length > 1 ? spawnResult.spawnAttempts : undefined,
    injectedEnv: Object.keys(injectedEnvFlags).length > 0 ? injectedEnvFlags : undefined
  };
  writeRunProcess(cwd, runId, processInfo);

  // Per-dispatch monitor popups were removed — the persistent monitor
  // daemon (scripts/monitor-daemon.mjs, launched via /claudsterfuck:monitor)
  // handles dispatch visibility. `--no-monitor` is retained as a no-op flag
  // for backwards compatibility with older worker-agent Bash shapes.
  void args.noMonitor;

  emitLog("dispatch", {
    runId,
    pid: spawnResult.pid,
    sessionId,
    provider: assembled.provider,
    route: assembled.route,
    timeoutSeconds
  });

  // If --watch was passed, dispatch and immediately poll in one call
  if (args.watch) {
    emitLog("dispatch-and-watch", { runId, pid: spawnResult.pid, provider: assembled.provider });
    await handleWatch(cwd, { ...args, runId });
    return;
  }

  // Return immediately
  emit(
    {
      runId,
      pid: spawnResult.pid,
      status: "running",
      startedAt,
      provider: assembled.provider,
      route: assembled.route,
      sessionId: sessionId || null,
      timeoutSeconds,
      message: `Worker dispatched (${assembled.provider}, PID ${spawnResult.pid}). Use 'watch --run-id ${runId}' to poll for completion.`
    },
    args.json
  );
}

// ---------------------------------------------------------------------------
// Command: watch
// ---------------------------------------------------------------------------

export async function handleWatch(cwd, args) {
  ensureResolvedPluginDataEnv(cwd);

  // Resolve run ID
  let runId = args.runId || "";
  if (!runId) {
    const sessionId = args.sessionId || process.env[SESSION_ID_ENV] || "";
    const currentTurn = sessionId ? resolveCurrentTurn(cwd, sessionId) : null;
    runId = currentTurn?.latestRunId || "";
  }
  if (!runId) {
    throw new Error("No run ID specified. Provide --run-id or ensure a dispatch is active.");
  }

  const timeoutSeconds = args.timeout || DEFAULT_WATCH_TIMEOUT_SECONDS;
  const run = readRun(cwd, runId);

  // R3: --heartbeat — cheap non-blocking snapshot Claude can call between long
  // watch calls to confirm the worker is alive and making progress without
  // burning tokens on a full watch payload.
  if (args.heartbeat) {
    const processInfo = readRunProcess(cwd, runId);
    const alive = processInfo?.pid ? isProcessAlive(processInfo.pid) : false;
    const runArtifactsDir = resolveRunArtifactsDir(cwd, runId);
    const latestEventPath = path.join(runArtifactsDir, "latest-event.json");
    let lastEvent = null;
    try {
      lastEvent = JSON.parse(fs.readFileSync(latestEventPath, "utf8"));
    } catch {
      lastEvent = null;
    }
    const lastEventAtMs = lastEvent?.timestamp ? Date.parse(lastEvent.timestamp) : null;
    const silentSeconds = lastEventAtMs && Number.isFinite(lastEventAtMs)
      ? Math.floor((Date.now() - lastEventAtMs) / 1000)
      : null;

    // Event count from events.jsonl (cheap — count newlines)
    let eventCount = 0;
    try {
      const content = fs.readFileSync(path.join(runArtifactsDir, "events.jsonl"), "utf8");
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim().length > 0) eventCount += 1;
      }
    } catch {
      eventCount = 0;
    }

    emit({
      runId,
      status: run.status,
      alive,
      silentSeconds,
      eventCount,
      lastEventType: lastEvent?.eventType ?? null,
      lastEventLabel: lastEvent?.label ?? null,
      lastEventIcon: lastEvent?.icon ?? null
    }, args.json);
    return;
  }

  // Already completed?
  if (run.status === "completed" || run.status === "failed") {
    const alreadyDonePayload = {
      runId,
      provider: run.provider,
      route: run.route,
      status: run.status,
      exitCode: run.exitCode ?? null,
      finalOutput: run.finalOutput ?? null,
      providerSessionId: run.providerSessionId ?? null,
      errorSummary: run.errorSummary ?? null,
      completedAt: run.completedAt ?? null,
      message: `Run already ${run.status}.`
    };
    if (args.stream) {
      process.stdout.write(JSON.stringify({ type: "result", ...alreadyDonePayload }) + "\n");
    } else {
      emit(alreadyDonePayload, args.json);
    }
    return;
  }

  const processInfo = readRunProcess(cwd, runId);
  if (!processInfo) {
    throw new Error(`No process info found for run ${runId}. Was it dispatched with the new orchestrator?`);
  }

  const pid = processInfo.pid;
  const deadline = Date.now() + (timeoutSeconds * 1000);
  const startedAtMs = parseIsoMs(processInfo.startedAt);
  const runArtifactsDirForTail = resolveRunArtifactsDir(cwd, runId);
  const tailState = {
    offset: 0,
    carry: "",
    provider: run.provider,
    runId,
    route: run.route
  };

  emitLog("watch-start", { runId, pid, timeoutSeconds });

  // Stream mode: emit initial event so user knows the worker is running
  let lastProgressMs = 0;
  if (args.stream) {
    process.stdout.write(
      JSON.stringify({ type: "progress", elapsed_s: 0, provider: run.provider, route: run.route, message: "Worker running" }) + "\n"
    );
    lastProgressMs = Date.now();
  }

  // Poll loop
  while (Date.now() < deadline) {
    const alive = isProcessAlive(pid);

    // Drain NDJSON events from the detached stdout file so latest-event.json reflects
    // live worker progress (statusline consumes this every refresh).
    tailStdoutForEvents(processInfo.stdoutFile, runArtifactsDirForTail, tailState);

    if (!alive) {
      // Process finished - finalize and return full result
      emitLog("watch-process-exited", { runId, pid });

      // Brief pause to let OS flush file buffers
      await sleep(500);

      // Drain any final events that landed after the process exited
      tailStdoutForEvents(processInfo.stdoutFile, runArtifactsDirForTail, tailState);

      const result = finalizeRun(cwd, runId, run, processInfo);

      emitLog("watch-finalized", {
        runId,
        status: result.status,
        exitCode: result.exitCode
      });

      const resultPayload = {
        ...result,
        message: `Run ${result.status}. ${result.status === "completed" ? "Result available." : `Error: ${result.errorSummary ?? "unknown"}`}`
      };
      if (args.stream) {
        process.stdout.write(JSON.stringify({ type: "result", ...resultPayload }) + "\n");
      } else {
        emit(resultPayload, args.json);
      }
      return;
    }

    // Still running - emit progress snapshot if --stream and interval has elapsed
    if (args.stream) {
      const now = Date.now();
      if (now - lastProgressMs >= WATCH_PROGRESS_INTERVAL_MS) {
        const elapsedS = startedAtMs > 0 ? Math.floor((now - startedAtMs) / 1000) : 0;
        const outputSnippet = safeReadTail(processInfo.stdoutFile, 400) || null;
        const ev = { type: "progress", elapsed_s: elapsedS, provider: run.provider, route: run.route };
        if (outputSnippet) ev.output = outputSnippet;
        process.stdout.write(JSON.stringify(ev) + "\n");
        lastProgressMs = now;
      }
    }

    // Still running - sleep before next check
    await sleep(WATCH_POLL_INTERVAL_MS);
  }

  // Timeout reached - process still running, return progress snapshot
  const elapsedSeconds = startedAtMs > 0 ? Math.floor((Date.now() - startedAtMs) / 1000) : null;
  const progressFile = run.artifacts?.progressFile ?? null;
  const progress = readJsonFileSafe(progressFile);
  const latestStdout = safeReadTail(processInfo.stdoutFile, 1500);
  const latestStderr = safeReadTail(processInfo.stderrFile, 500);

  emitLog("watch-timeout", { runId, pid, elapsedSeconds, timeoutSeconds });

  const timeoutPayload = {
    runId,
    pid,
    status: "running",
    elapsed: elapsedSeconds,
    watchTimeoutReached: true,
    watchTimeoutSeconds: timeoutSeconds,
    provider: run.provider,
    route: run.route,
    progress: progress ?? null,
    latestStdout: latestStdout ?? null,
    latestStderr: latestStderr ?? null,
    liveness: computeRunLiveness({
      ...run,
      startedAt: processInfo.startedAt
    }),
    message: `Still running after ${timeoutSeconds}s watch. PID ${pid} alive. Call watch again to keep polling.`
  };
  if (args.stream) {
    process.stdout.write(JSON.stringify({ type: "result", ...timeoutPayload }) + "\n");
  } else {
    emit(timeoutPayload, args.json);
  }
}

// ---------------------------------------------------------------------------
// Command: status (preserved from old code)
// ---------------------------------------------------------------------------

export async function handleStatus(cwd, args) {
  const requestedSessionId = args.sessionId || process.env[SESSION_ID_ENV] || "";
  const stateCandidate = resolveStateCandidate(cwd);
  const resolved = resolveSessionForStatus(stateCandidate.sessions, requestedSessionId);
  const sessionId = resolved.sessionId || "";
  const session = resolved.session;
  const resolvedFromLatest = !requestedSessionId && Boolean(sessionId);
  emit(
    {
      message: session?.currentTurn
        ? `Current turn phase: ${session.currentTurn.phase} (status: ${session.currentTurn.status})`
        : "No routed turn is stored for this session.",
      requestedSessionId: requestedSessionId || null,
      sessionId: sessionId || null,
      resolvedFromLatest,
      stateSource: stateCandidate.source,
      stateSourceWarning: buildStateSourceWarning(stateCandidate),
      stateFile: stateCandidate.paths.stateFile,
      stateReadHealth: stateCandidate.readHealth?.status ?? "ok",
      stateReadWarning: stateCandidate.readHealth?.warning ?? null,
      currentTurn: session?.currentTurn ?? null
    },
    args.json
  );
}

// ---------------------------------------------------------------------------
// Command: inspect (preserved from old code, enhanced with process info)
// ---------------------------------------------------------------------------

export async function handleInspect(cwd, args) {
  const requestedSessionId = args.sessionId || process.env[SESSION_ID_ENV] || "";
  const stateCandidate = resolveStateCandidate(cwd);
  const orderedSessions = stateCandidate.sessions;
  const resolved = resolveSessionForStatus(orderedSessions, requestedSessionId);
  const session = resolved.session;
  const sessionId = resolved.sessionId || "";
  const currentTurn = session?.currentTurn ?? null;
  const latestRunId = currentTurn?.latestRunId ?? "";

  // Slim mode: return only essential fields for low-token orchestration
  if (args.slim) {
    emit(
      {
        route: currentTurn?.route ?? null,
        provider: currentTurn?.provider ?? null,
        phase: currentTurn?.phase ?? null,
        status: currentTurn?.status ?? null,
        runId: latestRunId || null,
        runStatus: currentTurn?.latestRunStatus ?? null,
        sessionId: sessionId || null,
        reviewDepth: currentTurn?.reviewDepth ?? null
      },
      args.json
    );
    return;
  }
  let latestRun = null;

  if (latestRunId) {
    try {
      const run = readRun(cwd, latestRunId);
      const processInfo = readRunProcess(cwd, latestRunId);
      const latestRunSummary = {
        runId: latestRunId,
        provider: run.provider,
        route: run.route,
        status: run.status,
        startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null,
        providerSessionId: run.providerSessionId ?? null,
        errorSummary: run.errorSummary ?? null,
        artifacts: run.artifacts ?? null,
        pid: processInfo?.pid ?? null,
        processAlive: processInfo?.pid ? isProcessAlive(processInfo.pid) : null,
        transcriptPreview: {
          prompt: safeReadText(run.artifacts?.promptFile ?? null, 2500),
          lastMessage: safeReadText(run.artifacts?.lastMessageFile ?? null, 4000),
          stdout: safeReadText(run.artifacts?.stdoutFile ?? null, 1800),
          stderr: safeReadText(run.artifacts?.stderrFile ?? null, 1800)
        }
      };
      latestRun = {
        ...latestRunSummary,
        liveness: computeRunLiveness(latestRunSummary)
      };
    } catch {
      latestRun = {
        runId: latestRunId,
        missing: true
      };
    }
  }

  const sessionSummaries = orderedSessions.map(({ sessionId: id, record }) => {
    const turn = record?.currentTurn ?? null;
    return {
      sessionId: id,
      createdAt: record?.createdAt ?? null,
      updatedAt: record?.updatedAt ?? null,
      hasCurrentTurn: Boolean(turn),
      route: turn?.route ?? null,
      provider: turn?.provider ?? null,
      phase: turn?.phase ?? null,
      status: turn?.status ?? null,
      latestRunId: turn?.latestRunId ?? null,
      latestRunStatus: turn?.latestRunStatus ?? null,
      workerRuns: Array.isArray(turn?.workerRuns) ? turn.workerRuns.length : 0,
      archivedRuns: Array.isArray(turn?.archivedRuns) ? turn.archivedRuns.length : 0
    };
  });
  const recentRuns = loadRecentRuns(stateCandidate.paths.runsDir, 12);

  emit(
    {
      message: "Orchestrator inspector snapshot (read-only).",
      readOnlyContract: {
        readOnly: true,
        forbidsFileWrites: true,
        forbidsOpenWolfWrites: true
      },
      workspace: {
        cwd,
        stateSource: stateCandidate.source,
        stateSourceWarning: buildStateSourceWarning(stateCandidate),
        pluginDataDir: stateCandidate.pluginDataDir,
        stateFile: stateCandidate.paths.stateFile,
        runsDir: stateCandidate.paths.runsDir,
        stateReadHealth: stateCandidate.readHealth?.status ?? "ok",
        stateReadWarning: stateCandidate.readHealth?.warning ?? null
      },
      requestedSessionId: requestedSessionId || null,
      resolvedSessionId: sessionId || null,
      stateMachine: {
        phases: Object.values(TURN_PHASES),
        statuses: [
          "needs-delegation",
          "worker-running",
          "worker-complete",
          "worker-failed",
          "cancelled",
          "non-delegated"
        ]
      },
      sessions: sessionSummaries,
      currentTurn,
      latestRun,
      recentRuns
    },
    args.json
  );
}

// ---------------------------------------------------------------------------
// Command: result (preserved from old code)
// ---------------------------------------------------------------------------

export async function handleResult(cwd, args) {
  ensureResolvedPluginDataEnv(cwd);
  const sessionId = args.sessionId || process.env[SESSION_ID_ENV] || "";
  const currentTurn = resolveCurrentTurn(cwd, sessionId);
  const runId = args.runId || currentTurn?.latestRunId || "";
  if (!runId) {
    throw new Error("No run ID available. Dispatch a worker first or provide --run-id.");
  }

  const run = readRun(cwd, runId);
  emit(
    {
      runId,
      provider: run.provider,
      route: run.route,
      status: run.status,
      finalOutput: run.finalOutput,
      providerSessionId: run.providerSessionId ?? null,
      errorSummary: run.errorSummary ?? null
    },
    args.json
  );
}

// ---------------------------------------------------------------------------
// Command: cancel (UPDATED: now kills the running process)
// ---------------------------------------------------------------------------

/**
 * Cancel a specific run directly by run-id, bypassing the turn-state requirement.
 * Used when turn state is missing (e.g. after a reset) but a detached process is
 * still running and needs to be terminated.
 */
async function handleCancelByRunId(cwd, args) {
  const runId = args.runId;

  let run;
  try {
    run = readRun(cwd, runId);
  } catch {
    emit({ cancelled: false, runId, reason: `Run "${runId}" not found.` }, args.json);
    return;
  }

  if (run.status !== "running") {
    emit({ cancelled: false, runId, reason: `Run is already "${run.status}".` }, args.json);
    return;
  }

  const processInfo = readRunProcess(cwd, runId);
  let killed = false;
  if (processInfo?.pid && isProcessAlive(processInfo.pid)) {
    killed = killProcess(processInfo.pid);
    emitLog("cancel-kill", { runId, pid: processInfo.pid, killed });
  }

  const cancelledRun = {
    ...run,
    status: "failed",
    completedAt: new Date().toISOString(),
    exitCode: -1,
    errorSummary: "Cancelled by user"
  };
  writeRun(cwd, runId, cancelledRun);

  // Update matching session turn if one exists
  const targetSessionId = run.sessionId || args.sessionId || process.env[SESSION_ID_ENV] || "";
  if (targetSessionId) {
    updateCurrentTurn(cwd, targetSessionId, (turn) => {
      if (!turn || turn.latestRunId !== runId) {
        return turn;
      }
      return {
        ...turn,
        phase: TURN_PHASES.CANCELLED,
        status: "cancelled",
        latestRunStatus: "failed",
        latestRunErrorSummary: "Cancelled by user",
        confirmationRequired: false,
        awaitingConfirmation: false,
        pendingObjective: null,
        pendingCandidates: [],
        pendingProvider: null
      };
    });
  }

  emit({ cancelled: true, runId, killed, status: "cancelled" }, args.json);
}

export async function handleCancel(cwd, args) {
  ensureResolvedPluginDataEnv(cwd);

  // If an explicit run-id is given, operate run-centrically without requiring turn state.
  if (args.runId) {
    return handleCancelByRunId(cwd, args);
  }

  const sessionId = args.sessionId || process.env[SESSION_ID_ENV] || "";
  const currentTurn = resolveCurrentTurn(cwd, sessionId);

  if (!currentTurn) {
    emit(
      {
        cancelled: false,
        reason: "No current routed turn is stored."
      },
      args.json
    );
    return;
  }

  if (currentTurn.status === "non-delegated") {
    emit(
      {
        cancelled: false,
        reason: "Current turn does not require delegation."
      },
      args.json
    );
    return;
  }

  if (currentTurn.status === "cancelled") {
    emit(
      {
        cancelled: false,
        reason: "Turn is already cancelled."
      },
      args.json
    );
    return;
  }

  // If worker is running, kill it
  if (currentTurn.phase === TURN_PHASES.WORKER_RUNNING || currentTurn.status === "worker-running") {
    const runId = currentTurn.latestRunId;
    let killed = false;

    if (runId) {
      const processInfo = readRunProcess(cwd, runId);
      if (processInfo?.pid && isProcessAlive(processInfo.pid)) {
        killed = killProcess(processInfo.pid);
        emitLog("cancel-kill", { runId, pid: processInfo.pid, killed });
      }

      // Mark run as failed
      try {
        const run = readRun(cwd, runId);
        const cancelledRun = {
          ...run,
          status: "failed",
          completedAt: new Date().toISOString(),
          exitCode: -1,
          errorSummary: "Cancelled by user"
        };
        writeRun(cwd, runId, cancelledRun);
      } catch {}
    }

    // Update turn state to cancelled
    updateCurrentTurn(cwd, sessionId, (turn) => {
      if (!turn) {
        return turn;
      }

      return {
        ...turn,
        phase: TURN_PHASES.CANCELLED,
        status: "cancelled",
        latestRunStatus: "failed",
        latestRunErrorSummary: "Cancelled by user",
        confirmationRequired: false,
        awaitingConfirmation: false,
        pendingObjective: null,
        pendingCandidates: [],
        pendingProvider: null
      };
    });

    emit(
      {
        cancelled: true,
        status: "cancelled",
        killed,
        runId: runId ?? null
      },
      args.json
    );
    return;
  }

  // Non-running states that can be cancelled
  if (
    ["needs-delegation", "worker-failed", "worker-complete"].includes(currentTurn.status) ||
    [TURN_PHASES.REFINING, TURN_PHASES.READY_TO_DELEGATE, TURN_PHASES.REVIEWING].includes(currentTurn.phase)
  ) {
    updateCurrentTurn(cwd, sessionId, (turn) => {
      if (!turn) {
        return turn;
      }

      return {
        ...turn,
        phase: TURN_PHASES.CANCELLED,
        status: "cancelled",
        confirmationRequired: false,
        awaitingConfirmation: false,
        pendingObjective: null,
        pendingCandidates: [],
        pendingProvider: null
      };
    });

    emit(
      {
        cancelled: true,
        status: "cancelled"
      },
      args.json
    );
    return;
  }

  emit(
    {
      cancelled: false,
      reason: `Turn cannot be cancelled from status "${currentTurn.status}".`
    },
    args.json
  );
}

// ---------------------------------------------------------------------------
// Command: recover
// ---------------------------------------------------------------------------

export async function handleRecover(cwd, args) {
  ensureResolvedPluginDataEnv(cwd);
  const stateCandidate = resolveStateCandidate(cwd);
  const runsDir = stateCandidate.paths.runsDir;

  if (!runsDir || !fs.existsSync(runsDir)) {
    emit(
      {
        recovered: 0,
        message: "No runs directory found."
      },
      args.json
    );
    return;
  }

  const recovered = [];

  // Scan all run JSON files
  const runFiles = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(runsDir, entry.name));

  for (const filePath of runFiles) {
    let run;
    try {
      run = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }

    // Only interested in runs that claim to be running
    if (run.status !== "running") {
      continue;
    }

    const runId = run.id ?? path.basename(filePath, ".json");
    const processInfo = readRunProcess(cwd, runId);

    if (!processInfo) {
      // No process info at all - mark as failed
      const failedRun = {
        ...run,
        status: "failed",
        completedAt: new Date().toISOString(),
        exitCode: -1,
        errorSummary: "Recovered: no process info found"
      };
      fs.writeFileSync(filePath, `${JSON.stringify(failedRun, null, 2)}\n`, "utf8");
      recovered.push({ runId, reason: "no-process-info" });
      continue;
    }

    // Check if the process is still alive
    if (isProcessAlive(processInfo.pid)) {
      // --force-stalled: kill runs that have exceeded their stall threshold
      if (args.forceStalled) {
        const thresholdSeconds = resolveStalledThresholdSeconds(run.route);
        const startedAtMs = run.startedAt ? new Date(run.startedAt).getTime() : 0;
        const ageSeconds = startedAtMs > 0 ? Math.floor((Date.now() - startedAtMs) / 1000) : 0;

        if (ageSeconds > thresholdSeconds) {
          const stdoutFile = run.artifacts?.stdoutFile ?? processInfo.stdoutFile;
          const stdoutEmpty = !stdoutFile || !fs.existsSync(stdoutFile) ||
                              fs.statSync(stdoutFile).size === 0;

          if (stdoutEmpty) {
            const killed = killProcess(processInfo.pid);
            emitLog("recover-force-stalled", { runId, pid: processInfo.pid, ageSeconds, thresholdSeconds, killed });

            const stalledRun = {
              ...run,
              status: "failed",
              completedAt: new Date().toISOString(),
              exitCode: -1,
              errorSummary: `Recovered: stalled (age ${ageSeconds}s > threshold ${thresholdSeconds}s, empty output)`
            };
            fs.writeFileSync(filePath, `${JSON.stringify(stalledRun, null, 2)}\n`, "utf8");
            recovered.push({ runId, reason: "force-stalled", pid: processInfo.pid, ageSeconds, killed });
            continue;
          }
        }
      }

      // Still running and not force-stalled — skip
      continue;
    }

    // Process dead but run says running - finalize it
    emitLog("recover-orphan", { runId, pid: processInfo.pid });

    try {
      const result = finalizeRun(cwd, runId, run, processInfo);
      recovered.push({
        runId,
        reason: "process-dead",
        finalizedAs: result.status,
        pid: processInfo.pid
      });
    } catch (error) {
      // If finalization fails, just mark as failed
      const failedRun = {
        ...run,
        status: "failed",
        completedAt: new Date().toISOString(),
        exitCode: -1,
        errorSummary: `Recovered: process dead, finalization error: ${error instanceof Error ? error.message : String(error)}`
      };
      fs.writeFileSync(filePath, `${JSON.stringify(failedRun, null, 2)}\n`, "utf8");
      recovered.push({ runId, reason: "process-dead-finalization-failed", pid: processInfo.pid });
    }
  }

  emit(
    {
      recovered: recovered.length,
      runs: recovered,
      message: recovered.length > 0
        ? `Recovered ${recovered.length} orphaned run(s).`
        : "No orphaned runs found."
    },
    args.json
  );
}

// ---------------------------------------------------------------------------
// Command: setup (preserved from old code)
// ---------------------------------------------------------------------------

export async function handleSetup(cwd, args) {
  emit(
    {
      message: "Worker availability checked.",
      availability: await getProviderAvailability(cwd)
    },
    args.json
  );
}

// ---------------------------------------------------------------------------
// Command: reset (preserved from old code)
// ---------------------------------------------------------------------------

export async function handleReset(cwd, args) {
  ensureResolvedPluginDataEnv(cwd);
  const explicitSessionId = args.sessionId || "";

  if (explicitSessionId) {
    // Explicit session: clear only that session's turn
    updateCurrentTurn(cwd, explicitSessionId, () => null);
    emit({ reset: true, status: "cleared", scope: "session", sessionId: explicitSessionId }, args.json);
  } else {
    // No explicit session: clear all sessions' turns so state is fully clean
    const stateCandidate = resolveStateCandidate(cwd);
    const sessionIds = stateCandidate.sessions.map((entry) => entry.sessionId);
    for (const id of sessionIds) {
      updateCurrentTurn(cwd, id, () => null);
    }
    emit({ reset: true, status: "cleared", scope: "all", sessionsCleared: sessionIds.length }, args.json);
  }
}

// ---------------------------------------------------------------------------
// Command: reroute (preserved from old code)
// ---------------------------------------------------------------------------

export async function handleReroute(cwd, args) {
  ensureResolvedPluginDataEnv(cwd);
  const sessionId = args.sessionId || process.env[SESSION_ID_ENV] || "";
  const currentTurn = resolveCurrentTurn(cwd, sessionId);
  if (!currentTurn) {
    throw new Error("No current routed turn is stored for reroute.");
  }
  if (!args.route) {
    throw new Error("Missing required --route for reroute.");
  }

  const routeProfile = loadRouteProfile(args.route);
  updateCurrentTurn(cwd, sessionId, (turn) => {
    if (!turn) {
      return turn;
    }

    const archivedRuns = Array.isArray(turn.archivedRuns) ? [...turn.archivedRuns] : [];
    const workerRuns = Array.isArray(turn.workerRuns) ? turn.workerRuns : [];
    const requiresDelegation = Boolean(routeProfile.requiresDelegation);

    return {
      ...turn,
      route: routeProfile.route,
      provider: routeProfile.defaultProvider ?? null,
      writeEnabled: Boolean(routeProfile.writeEnabled),
      requiresDelegation,
      requiredFrameworks: Array.isArray(routeProfile.requiredFrameworks) ? routeProfile.requiredFrameworks : [],
      timeoutSeconds:
        Number.isFinite(routeProfile.timeoutSeconds) && routeProfile.timeoutSeconds > 0
          ? Math.floor(routeProfile.timeoutSeconds)
          : 900,
      defaultMemoryPlan:
        routeProfile.defaultMemoryPlan && typeof routeProfile.defaultMemoryPlan === "object"
          ? routeProfile.defaultMemoryPlan
          : null,
      confidence: "override",
      matchedSignals: ["explicit-reroute"],
      phase: requiresDelegation ? TURN_PHASES.REFINING : TURN_PHASES.NON_DELEGATED,
      status: requiresDelegation ? "needs-delegation" : "non-delegated",
      latestRunId: null,
      latestRunStatus: null,
      latestRunErrorSummary: null,
      workerRuns: [],
      archivedRuns: [...archivedRuns, ...workerRuns],
      confirmationRequired: false,
      awaitingConfirmation: false,
      pendingObjective: null,
      pendingCandidates: [],
      pendingProvider: null
    };
  });

  emit(
    {
      rerouted: true,
      route: routeProfile.route,
      status: routeProfile.requiresDelegation ? "needs-delegation" : "non-delegated"
    },
    args.json
  );
}

// ---------------------------------------------------------------------------
// Command: usage (token aggregates for current session + workspace)
// ---------------------------------------------------------------------------

/**
 * Extract the normalized token counts from a run's tokenUsage field, which
 * has different shapes per provider:
 *   Codex:  { input_tokens, cached_input_tokens, output_tokens }
 *   Gemini: { total_tokens, input_tokens, output_tokens, cached, duration_ms, ... }
 */
function normalizeTokenUsage(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== "object") {
    return { input: 0, output: 0, cached: 0, total: 0 };
  }
  const input = Number.isFinite(tokenUsage.input_tokens)
    ? tokenUsage.input_tokens
    : Number.isFinite(tokenUsage.input)
      ? tokenUsage.input
      : 0;
  const output = Number.isFinite(tokenUsage.output_tokens) ? tokenUsage.output_tokens : 0;
  const cached = Number.isFinite(tokenUsage.cached_input_tokens)
    ? tokenUsage.cached_input_tokens
    : Number.isFinite(tokenUsage.cached)
      ? tokenUsage.cached
      : 0;
  const total = Number.isFinite(tokenUsage.total_tokens) ? tokenUsage.total_tokens : input + output;
  return { input, output, cached, total };
}

function emptyAggregate() {
  return { runs: 0, input: 0, output: 0, cached: 0, total: 0 };
}

function addToAggregate(agg, tokens) {
  agg.runs += 1;
  agg.input += tokens.input;
  agg.output += tokens.output;
  agg.cached += tokens.cached;
  agg.total += tokens.total;
}

function readAllRunRecords(cwd) {
  const runsDir = resolveRunsDir(cwd);
  if (!fs.existsSync(runsDir)) return [];
  const entries = fs.readdirSync(runsDir);
  const runs = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const runFile = path.join(runsDir, entry);
    try {
      const record = JSON.parse(fs.readFileSync(runFile, "utf8"));
      if (record && record.id) {
        runs.push(record);
      }
    } catch {
      // Skip unreadable records
    }
  }
  return runs;
}

export async function handleUsage(cwd, args) {
  const requestedSessionId = args.sessionId || process.env[SESSION_ID_ENV] || "";
  const allRuns = readAllRunRecords(cwd);

  const workspace = emptyAggregate();
  const session = emptyAggregate();
  const byProvider = {};
  const byRoute = {};

  for (const run of allRuns) {
    const tokens = normalizeTokenUsage(run.tokenUsage);
    addToAggregate(workspace, tokens);
    if (requestedSessionId && run.sessionId === requestedSessionId) {
      addToAggregate(session, tokens);
    }
    const provider = run.provider || "unknown";
    const route = run.route || "unknown";
    byProvider[provider] = byProvider[provider] ?? emptyAggregate();
    byRoute[route] = byRoute[route] ?? emptyAggregate();
    addToAggregate(byProvider[provider], tokens);
    addToAggregate(byRoute[route], tokens);
  }

  const payload = {
    sessionId: requestedSessionId || null,
    workspace,
    session: requestedSessionId ? session : null,
    byProvider,
    byRoute
  };

  if (args.json) {
    emit(payload, true);
    return;
  }

  // Pretty print
  const out = [];
  out.push("claudsterfuck usage");
  out.push("");
  if (requestedSessionId) {
    out.push(`Session ${requestedSessionId}: ${session.runs} run(s)`);
    out.push(`  tokens: ${session.total.toLocaleString()} (in=${session.input.toLocaleString()} out=${session.output.toLocaleString()} cached=${session.cached.toLocaleString()})`);
    out.push("");
  }
  out.push(`Workspace total: ${workspace.runs} run(s)`);
  out.push(`  tokens: ${workspace.total.toLocaleString()} (in=${workspace.input.toLocaleString()} out=${workspace.output.toLocaleString()} cached=${workspace.cached.toLocaleString()})`);
  out.push("");
  out.push("By provider:");
  for (const [provider, agg] of Object.entries(byProvider)) {
    out.push(`  ${provider.padEnd(10)} ${String(agg.runs).padStart(3)} run(s) · ${agg.total.toLocaleString()} tok`);
  }
  out.push("");
  out.push("By route:");
  for (const [route, agg] of Object.entries(byRoute)) {
    out.push(`  ${route.padEnd(22)} ${String(agg.runs).padStart(3)} run(s) · ${agg.total.toLocaleString()} tok`);
  }
  process.stdout.write(out.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Command: second-opinion (cross-provider review of the latest completed run)
// ---------------------------------------------------------------------------

function parseLastJsonBlock(text) {
  const s = String(text ?? "");
  const lastOpen = s.lastIndexOf("{");
  if (lastOpen === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = lastOpen; i < s.length; i += 1) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(lastOpen, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function handleSecondOpinion(cwd, args) {
  ensureResolvedPluginDataEnv(cwd);

  const sessionId = args.sessionId || process.env[SESSION_ID_ENV] || "";
  if (!sessionId) {
    throw new Error("No session ID available. Second-opinion requires an active session with a completed run.");
  }

  const session = getSessionRecord(cwd, sessionId);
  const currentTurn = session?.currentTurn ?? null;

  // Find the most recent completed run from this turn's workerRuns.
  const lastCompletedRef = (currentTurn?.workerRuns ?? []).find(
    (r) => r && r.status === "completed" && r.id
  );
  if (!lastCompletedRef) {
    throw new Error(
      "No completed worker run found in the current turn. Dispatch + complete a task first, then invoke second-opinion."
    );
  }

  const originalRun = readRun(cwd, lastCompletedRef.id);
  const originalProvider = String(originalRun.provider ?? "").toLowerCase();
  if (originalProvider !== "codex" && originalProvider !== "gemini") {
    throw new Error(`Cannot determine opposite provider for "${originalProvider}".`);
  }
  const oppositeProvider = originalProvider === "codex" ? "gemini" : "codex";

  // Re-derive a review objective from the original output. Explicitly frame it as
  // a cross-model second opinion — not a rubber-stamp — so the reviewer pushes
  // back rather than agreeing with the original worker's conclusions.
  const originalObjective = String(originalRun.objective ?? "").trim();
  const originalOutput = String(originalRun.finalOutput ?? "").trim();
  const reviewObjective = [
    `Silent cross-model second-opinion review.`,
    ``,
    `Original worker: ${originalProvider}`,
    `Original route:  ${originalRun.route}`,
    `Original objective: "${originalObjective || "(not recorded)"}"`,
    ``,
    `Your job: review the output below with calibrated skepticism. You are the OTHER model, trained differently, and the user wants a genuinely independent perspective. Surface:`,
    `  - Missed edge cases or failure modes`,
    `  - Incorrect assumptions`,
    `  - Alternative approaches you would have taken`,
    `  - Concrete risks the original worker did not call out`,
    `Do NOT rubber-stamp. Disagreement is the point. Cite file paths and line numbers when possible.`,
    ``,
    `--- ORIGINAL OUTPUT BEGIN ---`,
    originalOutput || "(no output recorded)",
    `--- ORIGINAL OUTPUT END ---`
  ].join("\n");

  // Stage a second-opinion turn: route=review, provider=oppositeProvider, override
  // confidence. Save the current turn so we can restore it after the dispatch.
  const reviewProfile = loadRouteProfile("review");
  const archivedRuns = [
    ...(currentTurn?.archivedRuns ?? []),
    ...(currentTurn?.workerRuns ?? [])
  ];

  const secondOpinionTurn = {
    ...TURN_DEFAULTS,
    prompt: reviewObjective,
    objective: reviewObjective,
    route: "review",
    provider: oppositeProvider,
    writeEnabled: false,
    requiresDelegation: true,
    requiredFrameworks: Array.isArray(reviewProfile.requiredFrameworks) ? reviewProfile.requiredFrameworks : [],
    reviewDepth: reviewProfile.reviewDepth ?? "verify",
    timeoutSeconds:
      Number.isFinite(reviewProfile.timeoutSeconds) && reviewProfile.timeoutSeconds > 0
        ? Math.floor(reviewProfile.timeoutSeconds)
        : 900,
    defaultMemoryPlan: reviewProfile.defaultMemoryPlan ?? null,
    matchedSignals: ["second-opinion"],
    confidence: "override",
    phase: TURN_PHASES.REFINING,
    status: "needs-delegation",
    latestRunId: null,
    latestRunStatus: null,
    latestRunErrorSummary: null,
    workerRuns: [],
    archivedRuns
  };

  setCurrentTurn(cwd, sessionId, secondOpinionTurn);

  let secondOpinionResult = null;
  let dispatchError = null;
  try {
    // Dispatch via a subprocess so we capture the JSON result cleanly without
    // colliding with the parent process's stdout. --no-monitor keeps it silent.
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawn(
      process.execPath,
      [selfPath, "dispatch", "--watch", "--json", "--no-monitor"],
      {
        cwd,
        env: { ...process.env, [SESSION_ID_ENV]: sessionId },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const outChunks = [];
    const errChunks = [];
    child.stdout.on("data", (d) => outChunks.push(d));
    child.stderr.on("data", (d) => errChunks.push(d));
    const childExitCode = await new Promise((resolve) => child.on("close", resolve));
    const stdoutText = Buffer.concat(outChunks).toString();
    const stderrText = Buffer.concat(errChunks).toString();

    secondOpinionResult = parseLastJsonBlock(stdoutText);
    if (!secondOpinionResult) {
      dispatchError = `Second-opinion dispatch produced no parseable JSON (exit ${childExitCode}). stderr tail: ${stderrText.slice(-400)}`;
    }
  } catch (error) {
    dispatchError = error instanceof Error ? error.message : String(error);
  }

  // Restore the original turn so the user's next prompt continues from there.
  // Append the second-opinion's workerRuns into archivedRuns so the history is preserved.
  if (currentTurn) {
    const refreshedSession = getSessionRecord(cwd, sessionId);
    const refreshedTurn = refreshedSession?.currentTurn;
    const newlyArchived = [
      ...(currentTurn.archivedRuns ?? []),
      ...(refreshedTurn?.workerRuns ?? []),
      ...(currentTurn.workerRuns ?? [])
    ];
    setCurrentTurn(cwd, sessionId, {
      ...currentTurn,
      archivedRuns: newlyArchived
    });
  }

  if (dispatchError) {
    throw new Error(dispatchError);
  }

  const payload = {
    original: {
      runId: originalRun.id,
      provider: originalProvider,
      route: originalRun.route,
      objective: originalObjective,
      finalOutput: originalRun.finalOutput,
      providerSessionId: originalRun.providerSessionId ?? null,
      completedAt: originalRun.completedAt ?? null
    },
    secondOpinion: {
      runId: secondOpinionResult?.runId ?? null,
      provider: oppositeProvider,
      route: "review",
      status: secondOpinionResult?.status ?? null,
      finalOutput: secondOpinionResult?.finalOutput ?? null,
      providerSessionId: secondOpinionResult?.providerSessionId ?? null,
      tokenUsage: secondOpinionResult?.tokenUsage ?? null,
      errorSummary: secondOpinionResult?.errorSummary ?? null,
      completedAt: secondOpinionResult?.completedAt ?? null
    }
  };

  emit(payload, args.json);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const COMMANDS = {
  dispatch: handleDispatch,
  watch: handleWatch,
  status: handleStatus,
  inspect: handleInspect,
  result: handleResult,
  cancel: handleCancel,
  recover: handleRecover,
  setup: handleSetup,
  reroute: handleReroute,
  reset: handleReset,
  usage: handleUsage,
  "second-opinion": handleSecondOpinion,
  // Backward compat: "task" still works but prints a deprecation warning
  task: async (cwd, args) => {
    process.stderr.write(
      "[orchestrator] DEPRECATED: 'task' command is replaced by 'dispatch' + 'watch'. Redirecting to dispatch.\n"
    );
    await handleDispatch(cwd, args);
  }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (!args.command) {
    throw new Error(
      "Missing command. Use: dispatch, watch, status, inspect, result, cancel, recover, setup, reroute, or reset."
    );
  }

  const handler = COMMANDS[args.command];
  if (!handler) {
    throw new Error(
      `Unknown command "${args.command}". Available: ${Object.keys(COMMANDS).join(", ")}.`
    );
  }

  await handler(cwd, args);
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
