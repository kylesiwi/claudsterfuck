import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";

import { runCodexTask, runGeminiTask } from "./providers.mjs";
import { computeCodexDetachedExitCode } from "../orchestrator.mjs";

function createSpawnStub({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.pid = 12345;
    child.kill = () => {};
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();

    setImmediate(() => {
      if (stdout) {
        child.stdout.write(stdout);
      }
      if (stderr) {
        child.stderr.write(stderr);
      }
      child.stdout.end();
      child.stderr.end();
      child.emit("close", exitCode, null);
    });

    return child;
  };
}

async function testCodexEmptyOutputFails() {
  // Read-only route: empty output must fail even when process exits 0
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-codex-empty-"));
  try {
    const outputFile = path.join(tempDir, "run", "last-message.txt");
    const result = await runCodexTask({
      cwd: tempDir,
      prompt: "test prompt",
      outputFile,
      writeEnabled: false,
      timeoutMs: 1000,
      spawnFn: createSpawnStub({ exitCode: 0, stdout: "", stderr: "" })
    });

    assert.equal(result.finalOutput, "");
    assert.equal(result.exitCode, 1);
    assert.equal(result.normalized.status, "failed");
    assert.match(result.errorSummary ?? "", /no output/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testCodexWriteRouteEmptyOutputSucceeds() {
  // Write-enabled route: file changes are the output; empty last-message.txt is valid on exit 0
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-codex-write-"));
  try {
    const outputFile = path.join(tempDir, "run", "last-message.txt");
    const result = await runCodexTask({
      cwd: tempDir,
      prompt: "test prompt",
      outputFile,
      writeEnabled: true,
      timeoutMs: 1000,
      spawnFn: createSpawnStub({ exitCode: 0, stdout: "", stderr: "" })
    });

    assert.equal(result.finalOutput, "");
    assert.equal(result.exitCode, 0);
    assert.equal(result.normalized.status, "completed");
    assert.equal(result.errorSummary, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testGeminiEmptyOutputFails() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-gemini-empty-"));
  try {
    const result = await runGeminiTask({
      cwd: tempDir,
      prompt: "test prompt",
      writeEnabled: false,
      timeoutMs: 1000,
      spawnFn: createSpawnStub({ exitCode: 0, stdout: "", stderr: "" })
    });

    assert.equal(result.finalOutput, "");
    assert.equal(result.exitCode, 1);
    assert.equal(result.normalized.status, "failed");
    assert.match(result.errorSummary ?? "", /no output/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n`);
    throw error;
  }
}

await run("computeCodexDetachedExitCode distinguishes write vs read-only routes", async () => {
  // Has output → always success
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "report", route: "implement", stderrRaw: "" }), 0);
  // Write route, empty output, no stderr → success (file changes are the output)
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "implement", stderrRaw: "" }), 0);
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "debug", stderrRaw: "" }), 0);
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "implement-artifact", stderrRaw: "" }), 0);
  // Write route, empty output, has stderr → failure
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "implement", stderrRaw: "error occurred" }), 1);
  // Read-only route, empty output → always failure
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "review-feedback", stderrRaw: "" }), 1);
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "review", stderrRaw: "" }), 1);
});
await run("runCodexTask read-only route: empty output is failure even when process exits 0", testCodexEmptyOutputFails);
await run("runCodexTask write-enabled route: empty output is success when process exits 0", testCodexWriteRouteEmptyOutputSucceeds);
await run("runGeminiTask marks empty output as failure even when process exits 0", testGeminiEmptyOutputFails);
