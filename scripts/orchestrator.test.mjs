#!/usr/bin/env node
/**
 * Unit + integration tests for orchestrator.mjs hardening:
 *
 *   F1  handleCancel --run-id  (bypass turn-state requirement)
 *   F2  handleRecover --force-stalled  (kill alive-but-stale runs)
 *   F3  spawnDetached fallback  (retry on spawn-level EPERM/ENOENT)
 *   F4  spawn diagnostics  (resolvedCommand/resolvedArgs in process.json)
 *   F6  classifyTurn shell-command guard  (! prefix → chat)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Orchestrator exports
import {
  handleCancel,
  handleRecover,
  handleDispatch,
  computeCodexDetachedExitCode,
  spawnDetachedWithFn
} from "./orchestrator.mjs";

// State helpers
import {
  resolveRunsDir,
  resolveRunArtifactsDir,
  resolveRunFile,
  writeRun,
  readRun,
  setCurrentTurn,
  TURN_DEFAULTS
} from "./lib/state.mjs";

// Routing
import { classifyTurn } from "./routing/classify-turn.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    if (error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    throw error;
  }
}

/** Redirect stdout writes during fn(), return captured string. */
async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

/**
 * Create an isolated temp environment with CLAUDE_PLUGIN_DATA pointed at a
 * fresh temp directory.  Returns { cwd, cleanup }.
 */
function createTestEnv() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-orch-test-"));
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir;

  return {
    cwd: tempDir,
    cleanup() {
      if (savedPluginData != null) {
        process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
      } else {
        delete process.env.CLAUDE_PLUGIN_DATA;
      }
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  };
}

/** Write a minimal run record and process.json for a given runId. */
function seedRun(cwd, runId, { status = "running", provider = "codex", route = "implement", pid = 999999999, startedAtOffset = 0 } = {}) {
  const runsDir = resolveRunsDir(cwd);
  const artifactsDir = resolveRunArtifactsDir(cwd, runId);
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  const startedAt = new Date(Date.now() - startedAtOffset * 1000).toISOString();
  const runRecord = {
    id: runId,
    sessionId: null,
    status,
    provider,
    route,
    startedAt,
    artifacts: {
      stdoutFile: path.join(artifactsDir, "stdout.live.txt"),
      stderrFile: path.join(artifactsDir, "stderr.live.txt"),
      progressFile: path.join(artifactsDir, "progress.json")
    }
  };
  fs.writeFileSync(resolveRunFile(cwd, runId), JSON.stringify(runRecord, null, 2), "utf8");

  const processRecord = {
    pid,
    stdoutFile: path.join(artifactsDir, "stdout.live.txt"),
    stderrFile: path.join(artifactsDir, "stderr.live.txt"),
    startedAt
  };
  fs.writeFileSync(path.join(artifactsDir, "process.json"), JSON.stringify(processRecord, null, 2), "utf8");

  // Create empty stdout file (required for stall check)
  fs.writeFileSync(path.join(artifactsDir, "stdout.live.txt"), "", "utf8");

  return { runRecord, processRecord, artifactsDir };
}

// ---------------------------------------------------------------------------
// F1: handleCancel --run-id
// ---------------------------------------------------------------------------

await run("handleCancel --run-id: cancels run when process is dead (no active turn)", async () => {
  const env = createTestEnv();
  try {
    const runId = "codex-cancel-test-1";
    seedRun(env.cwd, runId, { status: "running", pid: 999999999 });

    const output = await captureStdout(() =>
      handleCancel(env.cwd, { runId, json: true, sessionId: "" })
    );

    const result = JSON.parse(output);
    assert.equal(result.cancelled, true, "should report cancelled: true");
    assert.equal(result.runId, runId);

    const updated = readRun(env.cwd, runId);
    assert.equal(updated.status, "failed", "run status should be failed after cancel");
    assert.ok(updated.errorSummary?.toLowerCase().includes("cancel"), "errorSummary should mention cancel");
  } finally {
    env.cleanup();
  }
});

await run("handleCancel --run-id: returns not-cancelled when run does not exist", async () => {
  const env = createTestEnv();
  try {
    const output = await captureStdout(() =>
      handleCancel(env.cwd, { runId: "codex-nonexistent-99", json: true, sessionId: "" })
    );

    const result = JSON.parse(output);
    assert.equal(result.cancelled, false, "should report cancelled: false for missing run");
  } finally {
    env.cleanup();
  }
});

await run("handleCancel --run-id: returns not-cancelled when run is already completed", async () => {
  const env = createTestEnv();
  try {
    const runId = "codex-cancel-test-done";
    seedRun(env.cwd, runId, { status: "completed", pid: 999999999 });

    const output = await captureStdout(() =>
      handleCancel(env.cwd, { runId, json: true, sessionId: "" })
    );

    const result = JSON.parse(output);
    assert.equal(result.cancelled, false, "should not cancel an already-completed run");
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// F2: handleRecover --force-stalled
// ---------------------------------------------------------------------------

await run("handleRecover: finalizes dead-process runs (existing behaviour preserved)", async () => {
  const env = createTestEnv();
  try {
    const runId = "gemini-recover-dead";
    seedRun(env.cwd, runId, { status: "running", pid: 999999999 }); // dead PID

    const output = await captureStdout(() =>
      handleRecover(env.cwd, { json: true, forceStalled: false })
    );

    const result = JSON.parse(output);
    assert.ok(result.recovered >= 1, "should recover at least one dead run");

    const updated = readRun(env.cwd, runId);
    assert.notEqual(updated.status, "running", "dead run should no longer be 'running'");
  } finally {
    env.cleanup();
  }
});

await run("handleRecover --force-stalled: skips alive process that is within threshold", async () => {
  const env = createTestEnv();
  // Spawn a real short-lived child to get an alive PID
  const child = spawn("node", ["-e", "setTimeout(()=>{},10000)"], { stdio: "ignore", windowsHide: true });
  try {
    const runId = "codex-recover-fresh";
    // startedAtOffset = 10s (well under any threshold)
    seedRun(env.cwd, runId, { status: "running", pid: child.pid, startedAtOffset: 10 });

    const output = await captureStdout(() =>
      handleRecover(env.cwd, { json: true, forceStalled: true })
    );

    const result = JSON.parse(output);
    const found = result.runs?.find((r) => r.runId === runId);
    assert.ok(!found, "fresh alive run should NOT be force-recovered");

    const updated = readRun(env.cwd, runId);
    assert.equal(updated.status, "running", "status should remain running");
  } finally {
    child.kill();
    env.cleanup();
  }
});

await run("handleRecover --force-stalled: kills alive process that has exceeded threshold", async () => {
  const env = createTestEnv();
  const child = spawn("node", ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore", windowsHide: true });
  try {
    const runId = "gemini-recover-stale";
    // startedAtOffset = 400s — exceeds the default 120s threshold for Gemini
    seedRun(env.cwd, runId, { status: "running", provider: "gemini", route: "review", pid: child.pid, startedAtOffset: 400 });

    const output = await captureStdout(() =>
      handleRecover(env.cwd, { json: true, forceStalled: true })
    );

    const result = JSON.parse(output);
    const found = result.runs?.find((r) => r.runId === runId);
    assert.ok(found, "stale alive run SHOULD be force-recovered");
    assert.equal(found.reason, "force-stalled");

    const updated = readRun(env.cwd, runId);
    assert.equal(updated.status, "failed", "stale run should be marked failed");
  } finally {
    // child may already be killed by recover; ignore errors
    try { child.kill(); } catch {}
    env.cleanup();
  }
});

await run("handleRecover: alive+not-stalled run is NOT touched when --force-stalled is false", async () => {
  const env = createTestEnv();
  const child = spawn("node", ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore", windowsHide: true });
  try {
    const runId = "codex-alive-no-force";
    seedRun(env.cwd, runId, { status: "running", pid: child.pid, startedAtOffset: 400 });

    const output = await captureStdout(() =>
      handleRecover(env.cwd, { json: true, forceStalled: false })
    );

    const result = JSON.parse(output);
    const found = result.runs?.find((r) => r.runId === runId);
    assert.ok(!found, "alive run should be skipped when --force-stalled is false");

    const updated = readRun(env.cwd, runId);
    assert.equal(updated.status, "running", "status should remain running");
  } finally {
    try { child.kill(); } catch {}
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Shared mock helpers for spawn tests (F3 + F4)
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

function makeMockChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.unref = () => {};
  return child;
}

function makeEpermThenSucceedSpawn(calls) {
  let callIndex = 0;
  return function mockSpawn(cmd, args) {
    calls.push({ cmd, args });
    callIndex++;
    if (callIndex === 1) {
      const err = new Error("spawn EPERM");
      err.code = "EPERM";
      throw err;
    }
    return makeMockChild(88888);
  };
}

function makeAlwaysSucceedSpawn(calls, pid = 77777) {
  return function mockSpawn(cmd, args) {
    calls.push({ cmd, args });
    return makeMockChild(pid);
  };
}

// ---------------------------------------------------------------------------
// F3: spawnDetached spawn-level fallback
// ---------------------------------------------------------------------------

await run("spawnDetached: falls back to node wrapper when native binary throws EPERM", async () => {
  if (typeof spawnDetachedWithFn !== "function") {
    throw new Error("spawnDetachedWithFn is not exported yet (RED)");
  }

  const env = createTestEnv();
  try {
    const stdoutFile = path.join(env.cwd, "stdout.txt");
    const stderrFile = path.join(env.cwd, "stderr.txt");
    const calls = [];

    // Inject explicit candidates so the test is independent of filesystem state.
    // Candidate 1 = native binary (will throw EPERM from mock spawn)
    // Candidate 2 = node wrapper fallback (mock spawn succeeds)
    const result = spawnDetachedWithFn("codex", ["exec", "-"], {
      cwd: env.cwd,
      env: process.env,
      stdin: "test",
      stdoutFile,
      stderrFile,
      _candidates: [
        { command: "C:\\fake\\codex.exe", args: ["exec", "-"] },
        { command: process.execPath, args: ["/fake/codex-wrapper.js", "exec", "-"] }
      ],
      _spawnFn: makeEpermThenSucceedSpawn(calls)
    });

    assert.equal(calls.length, 2, "should have attempted spawn twice");
    assert.ok(result.pid, "result should have a pid");
    assert.ok(result.spawnAttempts?.length === 2, "should record both spawn attempts");
    assert.equal(result.spawnAttempts[0].success, false, "first attempt should be failed");
    assert.equal(result.spawnAttempts[1].success, true, "second attempt should succeed");
  } finally {
    env.cleanup();
  }
});

await run("spawnDetached: does not retry on non-spawn errors (EINVAL)", () => {
  const env = createTestEnv();
  try {
    const stdoutFile = path.join(env.cwd, "stdout.txt");
    const stderrFile = path.join(env.cwd, "stderr.txt");
    const calls = [];

    function alwaysEinval(cmd, args) {
      calls.push({ cmd, args });
      const err = new Error("spawn EINVAL");
      err.code = "EINVAL";
      throw err;
    }

    let thrownError = null;
    try {
      spawnDetachedWithFn("codex", ["exec", "-"], {
        cwd: env.cwd, env: process.env, stdin: "test", stdoutFile, stderrFile,
        _candidates: [
          { command: "C:\\fake\\codex.exe", args: ["exec", "-"] },
          { command: process.execPath, args: ["/fake/codex-wrapper.js", "exec", "-"] }
        ],
        _spawnFn: alwaysEinval
      });
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError !== null, "should have thrown an error");
    assert.ok(
      thrownError.code === "EINVAL" || thrownError.message.includes("EINVAL"),
      `should throw EINVAL, got: ${thrownError?.code} / ${thrownError?.message}`
    );
    assert.equal(calls.length, 1, "EINVAL should not trigger retry");
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// F4: spawn diagnostics in process.json
// ---------------------------------------------------------------------------

await run("spawnDetached: returns resolvedCommand and resolvedArgs for diagnostics", async () => {
  const env = createTestEnv();
  try {
    const stdoutFile = path.join(env.cwd, "stdout.txt");
    const stderrFile = path.join(env.cwd, "stderr.txt");
    const calls = [];

    const result = spawnDetachedWithFn("codex", ["exec", "-"], {
      cwd: env.cwd,
      env: process.env,
      stdin: "test",
      stdoutFile,
      stderrFile,
      _candidates: [
        { command: "C:\\fake\\codex.exe", args: ["exec", "-"] }
      ],
      _spawnFn: makeAlwaysSucceedSpawn(calls)
    });

    assert.ok(result.resolvedCommand, "result should include resolvedCommand");
    assert.ok(Array.isArray(result.resolvedArgs), "result should include resolvedArgs array");
    assert.ok(Array.isArray(result.spawnAttempts), "result should include spawnAttempts array");
    assert.equal(result.spawnAttempts[0].success, true, "single attempt should be success");
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// F6: classifyTurn shell-command guard
// ---------------------------------------------------------------------------

await run("classifyTurn: '! plugin update foo' routes to chat (not delegated)", () => {
  const result = classifyTurn("! plugin update claudsterfuck");
  assert.equal(result.route, "chat", "should route to chat");
  assert.equal(result.confidence, "override", "should have override confidence");
});

await run("classifyTurn: '!ls' routes to chat", () => {
  const result = classifyTurn("!ls");
  assert.equal(result.route, "chat");
  assert.equal(result.confidence, "override");
});

await run("classifyTurn: '  ! cmd' (leading whitespace) routes to chat", () => {
  const result = classifyTurn("  ! some shell command");
  assert.equal(result.route, "chat");
});

await run("classifyTurn: normal implement prompt is NOT caught by shell guard", () => {
  const result = classifyTurn("implement a new feature for the login page");
  assert.notEqual(result.route, "chat", "normal prompts should not be forced to chat");
  assert.notEqual(result.confidence, "override");
});

await run("classifyTurn: '! prefix' reason is shell-command-prefix", () => {
  const result = classifyTurn("! git status");
  assert.equal(result.reason, "shell-command-prefix");
});

// ---------------------------------------------------------------------------
// F7: dispatch --objective override
// ---------------------------------------------------------------------------

/** Seed a minimal active turn so handleDispatch can find it. */
function seedTurn(cwd, sessionId, { objective = "stored objective", route = "implement" } = {}) {
  setCurrentTurn(cwd, sessionId, {
    ...TURN_DEFAULTS,
    prompt: objective,
    objective,
    route,
    provider: "codex",
    requiresDelegation: true,
    writeEnabled: true
  });
}

await run("dispatch --objective: overrides turn objective passed to assembleWorkerPromptFn", async () => {
  const env = createTestEnv();
  try {
    const sessionId = "test-obj-override";
    seedTurn(env.cwd, sessionId, { objective: "stored objective — should NOT reach worker" });

    let capturedObjective = null;
    const mockAssembleFn = (opts) => {
      capturedObjective = opts.objective;
      // Throw after capture to abort before spawn — we only need the objective
      throw new Error("MOCK_STOP_BEFORE_SPAWN");
    };

    let threw = null;
    try {
      await handleDispatch(env.cwd, { objective: "override objective — should reach worker", json: true, sessionId }, { assembleWorkerPromptFn: mockAssembleFn });
    } catch (err) {
      threw = err;
    }

    // The mock throws MOCK_STOP_BEFORE_SPAWN to abort early — that's expected
    assert.ok(threw?.message === "MOCK_STOP_BEFORE_SPAWN", `expected early abort, got: ${threw?.message}`);
    assert.equal(capturedObjective, "override objective — should reach worker", "assembleWorkerPromptFn should receive the override objective, not the stored one");
  } finally {
    env.cleanup();
  }
});

await run("dispatch --objective: absent override falls back to turn objective", async () => {
  const env = createTestEnv();
  try {
    const sessionId = "test-obj-fallback";
    seedTurn(env.cwd, sessionId, { objective: "stored objective — should reach worker" });

    let capturedObjective = null;
    const mockAssembleFn = (opts) => {
      capturedObjective = opts.objective;
      throw new Error("MOCK_STOP_BEFORE_SPAWN");
    };

    try {
      await handleDispatch(env.cwd, { json: true, sessionId }, { assembleWorkerPromptFn: mockAssembleFn });
    } catch {}

    assert.equal(capturedObjective, "stored objective — should reach worker", "no override: assembleWorkerPromptFn should receive the turn's stored objective");
  } finally {
    env.cleanup();
  }
});

await run("dispatch: --route override is still rejected (routing authority stays with turn state)", async () => {
  const env = createTestEnv();
  try {
    const sessionId = "test-route-guard";
    seedTurn(env.cwd, sessionId);

    let threw = null;
    try {
      await handleDispatch(env.cwd, { route: "review", json: true, sessionId }, {});
    } catch (err) {
      threw = err;
    }

    assert.ok(threw !== null, "should have thrown");
    assert.ok(threw.message.includes("Bound-session dispatch rejects CLI overrides"), `wrong error: ${threw.message}`);
  } finally {
    env.cleanup();
  }
});

await run("dispatch: --dry-run prints assembled prompt without spawning or writing state", async () => {
  const env = createTestEnv();
  try {
    const sessionId = "test-dry-run";
    seedTurn(env.cwd, sessionId, { objective: "do a dry run", route: "implement", provider: "codex" });

    const mockAssembleFn = (opts) => {
      return {
        route: opts.route,
        provider: opts.provider,
        objective: opts.objective,
        requiresDelegation: true,
        timeoutSeconds: 900,
        prompt: "FAKE_PROMPT_CONTENT"
      };
    };

    const output = await captureStdout(() => 
      handleDispatch(env.cwd, { dryRun: true, json: true, sessionId }, { assembleWorkerPromptFn: mockAssembleFn })
    );

    const result = JSON.parse(output);
    assert.equal(result.dryRun, true, "Should include dryRun flag");
    assert.equal(result.prompt, "FAKE_PROMPT_CONTENT", "Should include prompt content");
    assert.equal(result.provider, "codex", "Provider should match");
    assert.equal(result.route, "implement", "Route should match");
  } finally {
    env.cleanup();
  }
});

process.stdout.write("\nAll tests completed.\n");
