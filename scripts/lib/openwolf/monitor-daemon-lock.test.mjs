#!/usr/bin/env node
// Pre-implementation TDD tests for monitor-daemon-lock.mjs.
// All assertions should FAIL before the implementation file exists.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  tryAcquireLock,
  releaseLock,
  isPidAlive,
  readLock
} from "./monitor-daemon-lock.mjs";

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    throw error;
  }
}

function tmpLockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-monitor-lock-"));
  return {
    lockPath: path.join(dir, "monitor.lock"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

// --- isPidAlive ---

await run("isPidAlive returns true for current process", () => {
  assert.equal(isPidAlive(process.pid), true);
});

await run("isPidAlive returns false for impossible PID", () => {
  // PID 2_147_483_646 is near the max 32-bit signed int — no OS would have it
  assert.equal(isPidAlive(2_147_483_646), false);
});

await run("isPidAlive returns false for negative / zero / NaN", () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(Number.NaN), false);
  assert.equal(isPidAlive(null), false);
  assert.equal(isPidAlive(undefined), false);
});

// --- tryAcquireLock / releaseLock ---

await run("tryAcquireLock creates lock when file does not exist", () => {
  const { lockPath, cleanup } = tmpLockPath();
  try {
    const result = tryAcquireLock(lockPath, { sessionId: "sess-A" });
    assert.equal(result.acquired, true);
    assert.ok(fs.existsSync(lockPath));
    const body = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(body.pid, process.pid);
    assert.equal(body.sessionId, "sess-A");
    assert.ok(body.acquiredAt);
  } finally {
    cleanup();
  }
});

await run("tryAcquireLock refuses when lock held by live PID", () => {
  const { lockPath, cleanup } = tmpLockPath();
  try {
    // Write a lock owned by the CURRENT process (definitely alive)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, sessionId: "other", acquiredAt: new Date().toISOString() }), "utf8");
    const result = tryAcquireLock(lockPath, { sessionId: "sess-B" });
    assert.equal(result.acquired, false);
    assert.ok(result.heldBy);
    assert.equal(result.heldBy.pid, process.pid);
  } finally {
    cleanup();
  }
});

await run("tryAcquireLock steals lock when PID is dead", () => {
  const { lockPath, cleanup } = tmpLockPath();
  try {
    // Impossible PID — definitely not alive
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_646, sessionId: "zombie", acquiredAt: "2020-01-01T00:00:00Z" }), "utf8");
    const result = tryAcquireLock(lockPath, { sessionId: "sess-C" });
    assert.equal(result.acquired, true);
    assert.ok(result.stolenFrom);
    assert.equal(result.stolenFrom.pid, 2_147_483_646);
    const body = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(body.sessionId, "sess-C");
  } finally {
    cleanup();
  }
});

await run("tryAcquireLock acquires on malformed lock (fail-open)", () => {
  const { lockPath, cleanup } = tmpLockPath();
  try {
    fs.writeFileSync(lockPath, "{not valid json", "utf8");
    const result = tryAcquireLock(lockPath, { sessionId: "sess-D" });
    assert.equal(result.acquired, true);
  } finally {
    cleanup();
  }
});

await run("releaseLock removes file when owned by same PID", () => {
  const { lockPath, cleanup } = tmpLockPath();
  try {
    tryAcquireLock(lockPath, { sessionId: "sess-E" });
    const ok = releaseLock(lockPath, process.pid);
    assert.equal(ok, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    cleanup();
  }
});

await run("releaseLock refuses when PID mismatches (no cross-session deletes)", () => {
  const { lockPath, cleanup } = tmpLockPath();
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, sessionId: "sess-F", acquiredAt: new Date().toISOString() }), "utf8");
    const ok = releaseLock(lockPath, process.pid + 1);
    assert.equal(ok, false);
    assert.ok(fs.existsSync(lockPath), "lock must still exist when release PID doesn't match");
  } finally {
    cleanup();
  }
});

await run("readLock returns null when file absent, object when present", () => {
  const { lockPath, cleanup } = tmpLockPath();
  try {
    assert.equal(readLock(lockPath), null);
    tryAcquireLock(lockPath, { sessionId: "sess-G" });
    const lock = readLock(lockPath);
    assert.ok(lock);
    assert.equal(lock.pid, process.pid);
  } finally {
    cleanup();
  }
});

process.stdout.write("\nAll monitor-daemon-lock tests completed.\n");
