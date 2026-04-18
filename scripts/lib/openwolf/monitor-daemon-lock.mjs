import fs from "node:fs";
import process from "node:process";

// Process-liveness check used for reaping stale monitor-daemon locks.
// `process.kill(pid, 0)` in Node.js is a POSIX+Windows-supported way to
// query whether a PID exists without actually signaling it: it throws
// ESRCH when no such process, EPERM when the process exists but we can't
// signal it (on Windows this is treated as "alive"). Any validation error
// (NaN, negative, zero) → false.
export function isPidAlive(pid) {
  if (pid === null || pid === undefined) return false;
  const n = Number(pid);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it.
    // On Windows this commonly manifests when the target PID belongs to a
    // more-privileged process — still counts as alive for our purpose.
    return err && err.code === "EPERM";
  }
}

export function readLock(lockPath) {
  if (!fs.existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// Lock acquisition semantics:
//   1. No lock file → acquire.
//   2. Lock file exists, malformed → fail-open, acquire (corruption).
//   3. Lock file exists, PID alive → refuse.
//   4. Lock file exists, PID dead → steal.
// Atomic write-temp-rename so crash-mid-write can't corrupt.
export function tryAcquireLock(lockPath, ownerInfo) {
  const existing = readLock(lockPath);
  let stolenFrom = null;

  if (existing && existing.pid && isPidAlive(existing.pid)) {
    return { acquired: false, heldBy: existing };
  }
  if (existing) {
    stolenFrom = existing;
  }

  const record = {
    pid: process.pid,
    sessionId: ownerInfo?.sessionId ?? "",
    workspaceRoot: ownerInfo?.workspaceRoot ?? "",
    acquiredAt: new Date().toISOString()
  };

  try {
    const tmp = `${lockPath}.${Date.now()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
    fs.renameSync(tmp, lockPath);
  } catch (err) {
    return { acquired: false, error: err && err.message };
  }

  return stolenFrom
    ? { acquired: true, stolenFrom }
    : { acquired: true };
}

export function releaseLock(lockPath, pid) {
  const existing = readLock(lockPath);
  if (!existing) return false;
  if (existing.pid !== pid) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
