#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isDirectExecution } from "./lib/entrypoint.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const RESET = "\x1b[0m";
const PROVIDER_LABELS = new Map([
  ["claudsterfuck-codex-worker", "Codex"],
  ["claudsterfuck-gemini-worker", "Gemini"]
]);
const STATUS_STYLE = {
  running: { color: "\x1b[33m", symbol: "●" },
  completed: { color: "\x1b[32m", symbol: "✓" },
  failed: { color: "\x1b[31m", symbol: "✗" },
  error: { color: "\x1b[31m", symbol: "✗" },
  default: { color: "\x1b[2m", symbol: "○" }
};

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

export function readRouteSnapshot(cwd) {
  try {
    const state = JSON.parse(fs.readFileSync(resolveStateFileForWorkspace(cwd), "utf8"));
    const sessions = Object.values(state?.sessions || {});
    const running = sessions.find((session) => session?.currentTurn?.phase === "worker-running");
    const fallback = running || sessions.find((session) => session?.currentTurn?.route != null);
    return {
      route: fallback?.currentTurn?.route ?? null,
      latestRunStatus: fallback?.currentTurn?.latestRunStatus ?? null
    };
  } catch {
    return { route: null, latestRunStatus: null };
  }
}

export function formatElapsed(startTime, nowMs = Date.now()) {
  const started = Date.parse(startTime || "");
  const elapsed = Number.isFinite(started) ? Math.max(0, Math.floor((nowMs - started) / 1000)) : 0;
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function formatTokenCount(tokenCount) {
  const numeric = Number(tokenCount || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0 tok";
  }
  return `${(numeric / 1000).toFixed(1)}k tok`;
}

export function buildSubagentStatusRows(payload, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const rows = [];
  for (const task of tasks) {
    const name = String(task?.name || "");
    if (!name.startsWith("claudsterfuck-")) {
      continue;
    }
    const provider = PROVIDER_LABELS.get(name);
    if (!provider) {
      continue;
    }
    const routeSnapshot = readRouteSnapshot(task?.cwd || process.cwd());
    const style = STATUS_STYLE[String(task?.status || "")] || STATUS_STYLE.default;
    const statusText = String(task?.status || routeSnapshot.latestRunStatus || "unknown");
    const prefix = routeSnapshot.route ? `[${provider} · ${routeSnapshot.route}]` : `[${provider}]`;
    const elapsed = formatElapsed(task?.startTime, nowMs);
    const tokens = formatTokenCount(task?.tokenCount);
    const content = `${prefix}  ${style.color}${style.symbol} ${statusText}${RESET}  ·  ${elapsed}  ·  ${tokens}`;
    rows.push({ id: String(task?.id || ""), content });
  }
  return rows;
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
  const rows = buildSubagentStatusRows(payload);
  for (const row of rows) {
    process.stdout.write(`${JSON.stringify(row)}\n`);
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
