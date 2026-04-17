#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildSubagentStatusRows,
  resolveStateFileForWorkspace as resolveSubagentStateFile
} from "./subagent-statusline.mjs";
import { buildStatusLineOutput, resolveStateFileForWorkspace as resolveStatusStateFile } from "./statusline.mjs";

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

await run("subagent-statusline: formats running row with route and token count", () => {
  const env = createEnv();
  try {
    const workspace = path.join(env.root, "proj");
    fs.mkdirSync(workspace, { recursive: true });
    const stateFile = resolveSubagentStateFile(workspace);
    writeState(stateFile, {
      sessions: {
        a: {
          currentTurn: {
            phase: "worker-running",
            route: "implement",
            latestRunStatus: "running"
          }
        }
      }
    });

    const nowMs = Date.parse("2026-04-17T01:00:00.000Z");
    const rows = buildSubagentStatusRows(
      {
        tasks: [
          {
            id: "t1",
            name: "claudsterfuck-codex-worker",
            status: "running",
            startTime: "2026-04-17T00:58:55.000Z",
            tokenCount: 4200,
            cwd: workspace
          },
          {
            id: "t2",
            name: "other-worker",
            status: "running",
            startTime: "2026-04-17T00:58:55.000Z",
            tokenCount: 4200,
            cwd: workspace
          }
        ]
      },
      { nowMs }
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "t1");
    assert.match(rows[0].content, /\[Codex · implement\]/);
    assert.match(rows[0].content, /● running/);
    assert.match(rows[0].content, /01:05/);
    assert.match(rows[0].content, /4.2k tok/);
  } finally {
    env.cleanup();
  }
});

await run("subagent-statusline: falls back when route missing and token count empty", () => {
  const env = createEnv();
  try {
    const workspace = path.join(env.root, "proj2");
    fs.mkdirSync(workspace, { recursive: true });
    const rows = buildSubagentStatusRows(
      {
        tasks: [
          {
            id: "t1",
            name: "claudsterfuck-gemini-worker",
            status: "completed",
            startTime: "2026-04-17T00:59:59.000Z",
            tokenCount: 0,
            cwd: workspace
          }
        ]
      },
      { nowMs: Date.parse("2026-04-17T01:00:00.000Z") }
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].content, /\[Gemini\]/);
    assert.match(rows[0].content, /0 tok/);
  } finally {
    env.cleanup();
  }
});

await run("statusline: renders route, model, progress, cost and duration", () => {
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

    const [line1, line2] = output.split("\n");
    assert.match(line1, /\[cf · debug\]/);
    assert.match(line1, /GPT-5.4/);
    assert.match(line2, /73%/);
    assert.match(line2, /\$1.23/);
    assert.match(line2, /1m 5s/);
    assert.match(line2, /█{7}░{3}/);
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

  const [line1, line2] = output.split("\n");
  assert.match(line1, /\[cf\]/);
  assert.doesNotMatch(line1, /\[cf ·/);
  assert.match(line2, /95%/);
  assert.match(line2, /\\x1b\[31m|\u001b\[31m/);
});
