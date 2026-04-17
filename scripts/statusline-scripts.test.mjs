#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildStatusLineOutput,
  resolveRunArtifactsDir as resolveStatusRunArtifactsDir,
  resolveStateFileForWorkspace as resolveStatusStateFile
} from "./statusline.mjs";

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    throw error;
  }
}

function createEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-statusline-test-"));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = root;
  return {
    root,
    cleanup() {
      if (previous == null) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = previous;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function writeState(stateFile, payload) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2), "utf8");
}

function writeLatestEvent(runDir, payload) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "latest-event.json"), JSON.stringify(payload, null, 2), "utf8");
}

await run("statusline: renders route, model, progress, cost and duration (2 lines when no run active)", () => {
  const env = createEnv();
  try {
    const workspace = path.join(env.root, "proj3");
    fs.mkdirSync(workspace, { recursive: true });
    const stateFile = resolveStatusStateFile(workspace);
    writeState(stateFile, {
      sessions: {
        "session-1": {
          currentTurn: {
            route: "debug"
          }
        }
      }
    });

    const output = buildStatusLineOutput({
      model: { display_name: "GPT-5.4" },
      workspace: { current_dir: workspace },
      context_window: { used_percentage: 73 },
      cost: { total_cost_usd: 1.234, total_duration_ms: 65000 },
      session_id: "session-1"
    });

    const lines = output.split("\n");
    assert.equal(lines.length, 2, "no active run → two lines only");
    assert.match(lines[0], /\[cf · debug\]/);
    assert.match(lines[0], /GPT-5.4/);
    assert.match(lines[1], /73%/);
    assert.match(lines[1], /\$1.23/);
    assert.match(lines[1], /1m 5s/);
    assert.match(lines[1], /█{7}░{3}/);
  } finally {
    env.cleanup();
  }
});

await run("statusline: falls back to [cf] with red bar at high usage", () => {
  const output = buildStatusLineOutput({
    model: { display_name: "GPT-5.4-mini" },
    workspace: { current_dir: "C:/no-state" },
    context_window: { used_percentage: 95 },
    cost: { total_cost_usd: 0, total_duration_ms: 0 },
    session_id: "missing"
  });

  const lines = output.split("\n");
  assert.match(lines[0], /\[cf\]/);
  assert.doesNotMatch(lines[0], /\[cf ·/);
  assert.match(lines[1], /95%/);
  assert.match(lines[1], /\\x1b\[31m|\u001b\[31m/);
});

await run("statusline: renders third line with latest event when worker is running", () => {
  const env = createEnv();
  try {
    const workspace = path.join(env.root, "proj-event");
    fs.mkdirSync(workspace, { recursive: true });
    const stateFile = resolveStatusStateFile(workspace);
    writeState(stateFile, {
      sessions: {
        "session-1": {
          currentTurn: {
            route: "implement",
            phase: "worker-running",
            latestRunId: "codex-xyz"
          }
        }
      }
    });
    const runDir = resolveStatusRunArtifactsDir(workspace, "codex-xyz");
    writeLatestEvent(runDir, {
      provider: "codex",
      runId: "codex-xyz",
      route: "implement",
      icon: "⚙",
      label: "exec: npm test",
      eventType: "item.started",
      timestamp: "2026-04-17T00:00:00Z"
    });

    const output = buildStatusLineOutput({
      model: { display_name: "Sonnet 4.6" },
      workspace: { current_dir: workspace },
      context_window: { used_percentage: 30 },
      cost: { total_cost_usd: 0.1, total_duration_ms: 10000 },
      session_id: "session-1"
    });

    const lines = output.split("\n");
    assert.equal(lines.length, 3, "active run → three lines");
    assert.match(lines[0], /\[cf · implement\]/);
    assert.match(lines[2], /⚙/);
    assert.match(lines[2], /codex:/);
    assert.match(lines[2], /exec: npm test/);
  } finally {
    env.cleanup();
  }
});

await run("statusline: skips event line when phase is not worker-running", () => {
  const env = createEnv();
  try {
    const workspace = path.join(env.root, "proj-refining");
    fs.mkdirSync(workspace, { recursive: true });
    const stateFile = resolveStatusStateFile(workspace);
    writeState(stateFile, {
      sessions: {
        "session-1": {
          currentTurn: {
            route: "design",
            phase: "refining",
            latestRunId: "gemini-abc"
          }
        }
      }
    });
    const runDir = resolveStatusRunArtifactsDir(workspace, "gemini-abc");
    writeLatestEvent(runDir, {
      provider: "gemini",
      runId: "gemini-abc",
      route: "design",
      icon: "✓",
      label: "complete",
      eventType: "terminal",
      timestamp: "2026-04-17T00:00:00Z"
    });

    const output = buildStatusLineOutput({
      model: { display_name: "Sonnet" },
      workspace: { current_dir: workspace },
      context_window: { used_percentage: 30 },
      cost: { total_cost_usd: 0, total_duration_ms: 0 },
      session_id: "session-1"
    });

    // phase:"refining" on the preferred turn means the preferred read is skipped,
    // but the fallback scan also skips non-worker-running turns — so no third line.
    const lines = output.split("\n");
    assert.equal(lines.length, 2, "refining phase → no event line");
  } finally {
    env.cleanup();
  }
});
