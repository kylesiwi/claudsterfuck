import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";

import { runCodexTask, runGeminiTask } from "./providers.mjs";
import { computeCodexDetachedExitCode } from "../orchestrator.mjs";
import { reconstructFromNdjson, summarizeEvent } from "./event-stream.mjs";

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

async function testCodexNdjsonStreamingWritesEventsJsonl() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-codex-ndjson-"));
  try {
    const outputFile = path.join(tempDir, "run", "last-message.txt");
    const ndjson = [
      `{"type":"thread.started","thread_id":"thr-123"}`,
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"HELLO_FROM_CODEX"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":5}}`
    ].join("\n");

    const result = await runCodexTask({
      cwd: tempDir,
      prompt: "test",
      outputFile,
      writeEnabled: false,
      timeoutMs: 1000,
      spawnFn: createSpawnStub({ exitCode: 0, stdout: ndjson, stderr: "" })
    });

    // events.jsonl should contain the raw NDJSON
    const runDir = path.dirname(outputFile);
    const eventsPath = path.join(runDir, "events.jsonl");
    assert.equal(fs.existsSync(eventsPath), true, "events.jsonl should be written");
    const eventsContent = fs.readFileSync(eventsPath, "utf8");
    assert.match(eventsContent, /thread\.started/);
    assert.match(eventsContent, /item\.completed/);

    // latest-event.json should hold the terminal summary (finalize called)
    const latestPath = path.join(runDir, "latest-event.json");
    assert.equal(fs.existsSync(latestPath), true, "latest-event.json should be written");
    const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
    assert.equal(latest.provider, "codex");

    // finalOutput comes from the --output-last-message file OR reconstructed events
    assert.equal(result.finalOutput, "HELLO_FROM_CODEX");
    assert.equal(result.providerSessionId, "thr-123");
    assert.ok(result.tokenUsage);
    assert.equal(result.tokenUsage.input_tokens, 100);
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

async function testGeminiAccumulatesDeltaChunks() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-gemini-delta-"));
  try {
    const runArtifactsDir = path.join(tempDir, "run");
    fs.mkdirSync(runArtifactsDir, { recursive: true });
    const ndjson = [
      `{"type":"init","timestamp":"2026-04-17T00:00:00Z","session_id":"sess-abc","model":"gemini-3"}`,
      `{"type":"message","timestamp":"2026-04-17T00:00:01Z","role":"user","content":"prompt"}`,
      `{"type":"message","timestamp":"2026-04-17T00:00:02Z","role":"assistant","content":"Part 1 ","delta":true}`,
      `{"type":"message","timestamp":"2026-04-17T00:00:03Z","role":"assistant","content":"Part 2 ","delta":true}`,
      `{"type":"message","timestamp":"2026-04-17T00:00:04Z","role":"assistant","content":"Part 3","delta":true}`,
      `{"type":"result","timestamp":"2026-04-17T00:00:05Z","status":"success","stats":{"total_tokens":200,"input_tokens":150,"output_tokens":50}}`
    ].join("\n");

    const result = await runGeminiTask({
      cwd: tempDir,
      runArtifactsDir,
      prompt: "test",
      writeEnabled: false,
      timeoutMs: 1000,
      spawnFn: createSpawnStub({ exitCode: 0, stdout: ndjson, stderr: "" })
    });

    assert.equal(result.finalOutput, "Part 1 Part 2 Part 3");
    assert.equal(result.providerSessionId, "sess-abc");
    assert.equal(result.normalized.status, "completed");
    assert.ok(result.tokenUsage);
    assert.equal(result.tokenUsage.total_tokens, 200);

    // events.jsonl should exist
    const eventsPath = path.join(runArtifactsDir, "events.jsonl");
    assert.equal(fs.existsSync(eventsPath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testReconstructFromNdjsonCodex() {
  const ndjson = [
    `{"type":"thread.started","thread_id":"t-xyz"}`,
    `{"type":"item.completed","item":{"type":"agent_message","text":"final text"}}`
  ].join("\n");
  const result = reconstructFromNdjson("codex", ndjson);
  assert.equal(result.providerSessionId, "t-xyz");
  assert.equal(result.finalOutput, "final text");
}

async function testReconstructFromNdjsonGemini() {
  const ndjson = [
    `{"type":"init","session_id":"g-1"}`,
    `{"type":"message","role":"assistant","content":"hello ","delta":true}`,
    `{"type":"message","role":"assistant","content":"world","delta":true}`
  ].join("\n");
  const result = reconstructFromNdjson("gemini", ndjson);
  assert.equal(result.providerSessionId, "g-1");
  assert.equal(result.finalOutput, "hello world");
}

async function testSummarizeEventProducesLabels() {
  const codexExecStart = summarizeEvent("codex", {
    type: "item.started",
    item: { type: "command_execution", command: "npm test" }
  });
  assert.equal(codexExecStart?.icon, "⚙");
  assert.match(codexExecStart?.label ?? "", /exec/i);

  const geminiDelta = summarizeEvent("gemini", {
    type: "message",
    role: "assistant",
    content: "hi",
    delta: true
  });
  assert.equal(geminiDelta?.icon, "💬");

  const geminiResult = summarizeEvent("gemini", {
    type: "result",
    status: "success",
    stats: { total_tokens: 42 }
  });
  assert.equal(geminiResult?.icon, "✓");
  assert.match(geminiResult?.label ?? "", /tok=42/);
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
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "report", route: "implement", stderrRaw: "" }), 0);
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "implement", stderrRaw: "" }), 0);
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "debug", stderrRaw: "" }), 0);
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "implement-artifact", stderrRaw: "" }), 0);
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "implement", stderrRaw: "error occurred" }), 1);
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "review-feedback", stderrRaw: "" }), 1);
  assert.equal(computeCodexDetachedExitCode({ finalOutput: "", route: "review", stderrRaw: "" }), 1);
});
await run("runCodexTask read-only route: empty output is failure even when process exits 0", testCodexEmptyOutputFails);
await run("runCodexTask write-enabled route: empty output is success when process exits 0", testCodexWriteRouteEmptyOutputSucceeds);
await run("runCodexTask NDJSON: writes events.jsonl and extracts thread_id + tokens", testCodexNdjsonStreamingWritesEventsJsonl);
await run("runGeminiTask marks empty output as failure even when process exits 0", testGeminiEmptyOutputFails);
await run("runGeminiTask stream-json: accumulates delta chunks into finalOutput", testGeminiAccumulatesDeltaChunks);
await run("reconstructFromNdjson(codex): extracts thread_id and agent_message text", testReconstructFromNdjsonCodex);
await run("reconstructFromNdjson(gemini): accumulates delta chunks and session_id", testReconstructFromNdjsonGemini);
await run("summarizeEvent: produces labels for Codex + Gemini events", testSummarizeEventProducesLabels);
