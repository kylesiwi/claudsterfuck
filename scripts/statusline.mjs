#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isDirectExecution } from "./lib/entrypoint.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const EVENT_LABEL_MAX = 50;

export function workspaceHash(cwd) {
  const fallback = cwd || process.cwd();
  const slug = (path.basename(fallback) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  let canonical = fallback;
  try {
    canonical = fs.realpathSync.native(fallback);
  } catch {}
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function resolveStateFileForWorkspace(cwd) {
  const pluginData = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginData ? path.join(pluginData, "state") : path.join(os.tmpdir(), "claudsterfuck");
  return path.join(stateRoot, workspaceHash(cwd || process.cwd()), "state.json");
}

export function resolveRunArtifactsDir(cwd, runId) {
  const pluginData = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginData ? path.join(pluginData, "state") : path.join(os.tmpdir(), "claudsterfuck");
  return path.join(stateRoot, workspaceHash(cwd || process.cwd()), "runs", runId);
}

export function readRouteForSession(cwd, sessionId) {
  try {
    const state = JSON.parse(fs.readFileSync(resolveStateFileForWorkspace(cwd), "utf8"));
    return state?.sessions?.[sessionId]?.currentTurn?.route || null;
  } catch {
    return null;
  }
}

export function readCurrentTurnForSession(cwd, sessionId) {
  try {
    const state = JSON.parse(fs.readFileSync(resolveStateFileForWorkspace(cwd), "utf8"));
    return state?.sessions?.[sessionId]?.currentTurn || null;
  } catch {
    return null;
  }
}

export function readActiveRunEvent(cwd, sessionId) {
  try {
    const state = JSON.parse(fs.readFileSync(resolveStateFileForWorkspace(cwd), "utf8"));
    const session = state?.sessions?.[sessionId];
    const turn = session?.currentTurn;
    if (!turn) return null;
    // Prefer the current turn's latest run if it is still running; otherwise scan
    // all sessions for any worker-running turn (handles the case where the user's
    // session_id doesn't match the one that dispatched).
    const preferredRunId = turn.latestRunId;
    if (preferredRunId && turn.phase === "worker-running") {
      const event = readLatestEventFile(cwd, preferredRunId);
      if (event) return event;
    }
    const sessions = Object.values(state?.sessions ?? {});
    for (const s of sessions) {
      const t = s?.currentTurn;
      if (t?.phase === "worker-running" && t?.latestRunId) {
        const event = readLatestEventFile(cwd, t.latestRunId);
        if (event) return event;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readLatestEventFile(cwd, runId) {
  try {
    const dir = resolveRunArtifactsDir(cwd, runId);
    const raw = fs.readFileSync(path.join(dir, "latest-event.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizePercent(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function progressColor(usedPercentage) {
  if (usedPercentage >= 90) {
    return RED;
  }
  if (usedPercentage >= 70) {
    return YELLOW;
  }
  return GREEN;
}

function buildProgressBar(usedPercentage) {
  const filled = Math.max(0, Math.min(10, Math.round(usedPercentage / 10)));
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

function formatDuration(msValue) {
  const ms = Number(msValue || 0);
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function truncate(s, n) {
  const str = String(s ?? "");
  return str.length <= n ? str : str.slice(0, n - 1) + "…";
}

function buildFallbackTurnLabel(turn) {
  if (!turn) {
    return null;
  }

  const route = typeof turn.route === "string" ? turn.route.trim() : "";
  const provider = typeof turn.provider === "string" ? turn.provider.trim() : "";
  const phase = typeof turn.phase === "string" ? turn.phase.trim() : "";
  const status = typeof turn.status === "string" ? turn.status.trim() : "";
  const confidence = typeof turn.confidence === "string" ? turn.confidence.trim() : "";

  const primary = phase || status || confidence;
  if (route && primary) {
    return `[${route}] ${primary}`;
  }
  if (provider && primary) {
    return `-> ${provider}: ${primary}`;
  }
  if (route) {
    return `[${route}]`;
  }
  if (provider) {
    return `-> ${provider}`;
  }
  return primary || null;
}

export function buildStatusLineOutput(payload) {
  const modelName = payload?.model?.display_name || payload?.model?.id || "unknown";
  const workspaceDir = payload?.workspace?.current_dir || process.cwd();
  const usedPercentage = normalizePercent(payload?.context_window?.used_percentage || 0);
  const totalCost = Number(payload?.cost?.total_cost_usd || 0);
  const safeCost = Number.isFinite(totalCost) ? totalCost : 0;
  const durationMs = Number(payload?.cost?.total_duration_ms || 0);
  const sessionId = payload?.session_id || "";
  const route = readRouteForSession(workspaceDir, sessionId);
  const currentTurn = readCurrentTurnForSession(workspaceDir, sessionId);
  const activeEvent = readActiveRunEvent(workspaceDir, sessionId);
  const label = route ? `[cf · ${route}]` : "[cf]";
  const color = progressColor(usedPercentage);
  const bar = buildProgressBar(usedPercentage);
  const line1 = `${CYAN}${label}${RESET}  ${DIM}${modelName}${RESET}`;
  const line2 = `${color}${bar}${RESET} ${usedPercentage}% · $${safeCost.toFixed(2)} · ${formatDuration(durationMs)}`;

  // Third line: live worker event summary (only while a run is active/terminal)
  if (activeEvent && activeEvent.label) {
    const icon = activeEvent.icon || "·";
    const eventLabel = truncate(activeEvent.label, EVENT_LABEL_MAX);
    const line3 = `${MAGENTA}${icon}${RESET} ${DIM}${activeEvent.provider || "?"}:${RESET} ${eventLabel}`;
    return `${line1}\n${line2}\n${line3}`;
  }

  const fallbackTurnLabel = buildFallbackTurnLabel(currentTurn);
  if (fallbackTurnLabel) {
    const line3 = `${MAGENTA}·${RESET} ${DIM}${truncate(fallbackTurnLabel, EVENT_LABEL_MAX)}${RESET}`;
    return `${line1}\n${line2}\n${line3}`;
  }

  return `${line1}\n${line2}`;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

export async function main() {
  const payload = await readStdinJson();
  process.stdout.write(buildStatusLineOutput(payload));
}

if (isDirectExecution(import.meta.url)) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
