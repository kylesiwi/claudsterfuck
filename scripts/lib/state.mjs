import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_VERSION = 4;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "claudsterfuck");
const STATE_FILE_NAME = "state.json";
const RUNS_DIR_NAME = "runs";
const MAX_SESSIONS = 25;

export const TURN_DEFAULTS = Object.freeze({
  prompt: "",
  objective: "",
  route: "",
  provider: null,
  writeEnabled: false,
  requiresDelegation: true,
  requiredFrameworks: [],
  timeoutSeconds: 900,
  defaultMemoryPlan: null,
  matchedSignals: [],
  confidence: "low",
  phase: "refining",
  status: "needs-delegation",
  confirmationRequired: false,
  awaitingConfirmation: false,
  pendingObjective: null,
  pendingCandidates: [],
  pendingProvider: null,
  latestRunId: null,
  latestRunStatus: null,
  latestRunErrorSummary: null,
  workerRuns: [],
  archivedRuns: []
});

export const TURN_PHASES = Object.freeze({
  NON_DELEGATED: "non-delegated",
  REFINING: "refining",
  READY_TO_DELEGATE: "ready-to-delegate",
  AWAITING_USER: "awaiting-user",
  WORKER_RUNNING: "worker-running",
  REVIEWING: "reviewing",
  CANCELLED: "cancelled"
});

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    sessions: {}
  };
}

function buildReadHealth(status = "ok", warning = null) {
  return {
    status,
    warning: warning || null
  };
}

function workspaceHash(cwd) {
  let canonicalCwd = cwd;
  try {
    canonicalCwd = fs.realpathSync.native(cwd);
  } catch {
    canonicalCwd = cwd;
  }

  const slugSource = path.basename(cwd) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Atomic JSON writes (write-temp -> fsync -> rename)
// ---------------------------------------------------------------------------

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.tmp`);
  const content = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

// ---------------------------------------------------------------------------
// JSONL audit trail
// ---------------------------------------------------------------------------

function appendAudit(cwd, event) {
  const auditPath = path.join(resolveStateDir(cwd), "audit.jsonl");
  const entry = { ts: new Date().toISOString(), ...event };
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Audit writes are best-effort; never fail the caller.
  }
}

// ---------------------------------------------------------------------------
// Turn normalization
// ---------------------------------------------------------------------------

function resolveTurnPhase(turn) {
  if (!turn) {
    return TURN_DEFAULTS.phase;
  }

  if (turn.requiresDelegation === false || turn.status === "non-delegated") {
    return TURN_PHASES.NON_DELEGATED;
  }
  if (turn.status === "cancelled") {
    return TURN_PHASES.CANCELLED;
  }
  if (turn.awaitingConfirmation === true || turn.confirmationRequired === true) {
    return TURN_PHASES.AWAITING_USER;
  }
  if (turn.latestRunStatus === "running" || turn.status === "worker-running" || turn.phase === TURN_PHASES.WORKER_RUNNING) {
    return TURN_PHASES.WORKER_RUNNING;
  }
  if (turn.phase && typeof turn.phase === "string") {
    return turn.phase;
  }
  if (turn.latestRunStatus === "completed" || turn.status === "worker-complete") {
    return TURN_PHASES.REVIEWING;
  }
  if (turn.latestRunStatus === "failed" || turn.status === "worker-failed") {
    return TURN_PHASES.READY_TO_DELEGATE;
  }

  return turn.requiresDelegation === false ? TURN_PHASES.NON_DELEGATED : TURN_PHASES.REFINING;
}

function resolveTurnStatus(turn, phase) {
  if (!turn) {
    return TURN_DEFAULTS.status;
  }

  if (turn.requiresDelegation === false || phase === TURN_PHASES.NON_DELEGATED) {
    return "non-delegated";
  }
  if (phase === TURN_PHASES.CANCELLED) {
    return "cancelled";
  }
  if (phase === TURN_PHASES.WORKER_RUNNING) {
    return "worker-running";
  }
  if (turn.latestRunStatus === "failed" || turn.status === "worker-failed") {
    return "worker-failed";
  }
  if ([TURN_PHASES.REFINING, TURN_PHASES.READY_TO_DELEGATE, TURN_PHASES.AWAITING_USER].includes(phase)) {
    return "needs-delegation";
  }
  if (phase === TURN_PHASES.REVIEWING) {
    return "worker-complete";
  }
  if (turn.latestRunStatus === "completed" || turn.status === "worker-complete") {
    return "worker-complete";
  }

  return "needs-delegation";
}

function normalizeTurn(turn) {
  if (!turn) {
    return null;
  }

  const phase = resolveTurnPhase(turn);

  return {
    ...TURN_DEFAULTS,
    ...turn,
    provider: turn.provider ?? null,
    requiredFrameworks: ensureArray(turn.requiredFrameworks),
    matchedSignals: ensureArray(turn.matchedSignals),
    pendingCandidates: ensureArray(turn.pendingCandidates),
    workerRuns: ensureArray(turn.workerRuns),
    archivedRuns: ensureArray(turn.archivedRuns),
    pendingObjective: turn.pendingObjective ?? null,
    pendingProvider: turn.pendingProvider ?? null,
    latestRunId: turn.latestRunId ?? null,
    latestRunStatus: turn.latestRunStatus ?? null,
    latestRunErrorSummary: turn.latestRunErrorSummary ?? null,
    phase,
    status: resolveTurnStatus(turn, phase),
    timeoutSeconds:
      Number.isFinite(turn.timeoutSeconds) && turn.timeoutSeconds > 0
        ? Math.floor(turn.timeoutSeconds)
        : TURN_DEFAULTS.timeoutSeconds,
    defaultMemoryPlan:
      turn.defaultMemoryPlan && typeof turn.defaultMemoryPlan === "object" ? turn.defaultMemoryPlan : null
  };
}

function normalizeSessionRecord(sessionId, record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    sessionId,
    currentTurn: normalizeTurn(record.currentTurn ?? null)
  };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function resolveStateDir(cwd) {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, workspaceHash(cwd));
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveRunsDir(cwd) {
  return path.join(resolveStateDir(cwd), RUNS_DIR_NAME);
}

export function resolveRunArtifactsDir(cwd, runId) {
  return path.join(resolveRunsDir(cwd), runId);
}

export function resolveRunFile(cwd, runId) {
  return path.join(resolveRunsDir(cwd), `${runId}.json`);
}

function ensureStateDir(cwd) {
  fs.mkdirSync(resolveRunsDir(cwd), { recursive: true });
}

function pruneSessions(sessions) {
  const entries = Object.entries(sessions).sort((left, right) =>
    String(right[1]?.updatedAt ?? "").localeCompare(String(left[1]?.updatedAt ?? ""))
  );

  return Object.fromEntries(entries.slice(0, MAX_SESSIONS));
}

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

export function loadState(cwd) {
  return loadStateWithReadHealth(cwd).state;
}

export function loadStateWithReadHealth(cwd) {
  const filePath = resolveStateFile(cwd);
  if (!fs.existsSync(filePath)) {
    return {
      state: defaultState(),
      readHealth: buildReadHealth("ok", null)
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const sessions = parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
    return {
      state: {
        ...defaultState(),
        ...parsed,
        version: STATE_VERSION,
        sessions: Object.fromEntries(
          Object.entries(sessions).map(([sessionId, record]) => [sessionId, normalizeSessionRecord(sessionId, record)])
        )
      },
      readHealth: buildReadHealth("ok", null)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: defaultState(),
      readHealth: buildReadHealth("degraded", `Failed to parse state file "${filePath}": ${message}`)
    };
  }
}

export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const nextState = {
    version: STATE_VERSION,
    sessions: pruneSessions(state.sessions ?? {})
  };

  atomicWriteJson(resolveStateFile(cwd), nextState);
  appendAudit(cwd, { event: "state-saved", sessionCount: Object.keys(nextState.sessions).length });
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

// ---------------------------------------------------------------------------
// Session records
// ---------------------------------------------------------------------------

export function getSessionRecord(cwd, sessionId) {
  if (!sessionId) {
    return null;
  }

  const record = loadState(cwd).sessions[sessionId] ?? null;
  return normalizeSessionRecord(sessionId, record);
}

export function setSessionRecord(cwd, sessionId, patch) {
  if (!sessionId) {
    return loadState(cwd);
  }

  return updateState(cwd, (state) => {
    const previous = normalizeSessionRecord(sessionId, state.sessions[sessionId] ?? { sessionId, createdAt: nowIso() });
    const nextPatch = typeof patch === "function" ? patch(previous) : patch;
    const nextRecord = {
      ...previous,
      ...nextPatch,
      sessionId,
      updatedAt: nowIso()
    };

    if ("currentTurn" in nextRecord) {
      nextRecord.currentTurn = normalizeTurn(nextRecord.currentTurn);
    }

    state.sessions[sessionId] = nextRecord;
  });
}

// ---------------------------------------------------------------------------
// Turn management
// ---------------------------------------------------------------------------

export function setCurrentTurn(cwd, sessionId, turn) {
  appendAudit(cwd, { event: "turn-created", sessionId, route: turn?.route ?? null, provider: turn?.provider ?? null });
  return setSessionRecord(cwd, sessionId, (previous) => ({
    ...previous,
    currentTurn: {
      ...normalizeTurn(turn),
      updatedAt: nowIso()
    }
  }));
}

export function updateCurrentTurn(cwd, sessionId, mutate) {
  return setSessionRecord(cwd, sessionId, (previous) => {
    const currentTurn = normalizeTurn(previous.currentTurn ?? null);
    const nextTurn = mutate(currentTurn);

    // Audit the transition
    if (nextTurn === null && currentTurn !== null) {
      appendAudit(cwd, { event: "turn-cancelled", sessionId, route: currentTurn.route });
    } else if (nextTurn && currentTurn && nextTurn.phase !== currentTurn.phase) {
      appendAudit(cwd, { event: "turn-updated", sessionId, fromPhase: currentTurn.phase, toPhase: nextTurn.phase });
    }

    return {
      ...previous,
      currentTurn: nextTurn
        ? {
            ...normalizeTurn(nextTurn),
            updatedAt: nowIso()
          }
        : null
    };
  });
}

// ---------------------------------------------------------------------------
// Worker runs
// ---------------------------------------------------------------------------

export function appendWorkerRun(cwd, sessionId, runSummary) {
  appendAudit(cwd, { event: "run-started", sessionId, runId: runSummary.id, provider: runSummary.provider, route: runSummary.route });
  return updateCurrentTurn(cwd, sessionId, (currentTurn) => {
    if (!currentTurn) {
      return currentTurn;
    }

    const workerRuns = ensureArray(currentTurn.workerRuns);
    return {
      ...currentTurn,
      phase: runSummary.phase ?? TURN_PHASES.WORKER_RUNNING,
      status: runSummary.status ?? currentTurn.status,
      latestRunId: runSummary.id ?? currentTurn.latestRunId ?? null,
      latestRunStatus: runSummary.latestRunStatus ?? currentTurn.latestRunStatus ?? null,
      latestRunErrorSummary: runSummary.errorSummary ?? currentTurn.latestRunErrorSummary ?? null,
      workerRuns: [runSummary, ...workerRuns].slice(0, 10)
    };
  });
}

export function generateRunId(provider) {
  return `${provider}-${randomUUID().slice(0, 8)}`;
}

export function writeRun(cwd, runId, payload) {
  ensureStateDir(cwd);
  const filePath = resolveRunFile(cwd, runId);
  atomicWriteJson(filePath, payload);

  const isCompleted = payload.status === "completed" || payload.status === "failed";
  if (isCompleted) {
    appendAudit(cwd, { event: "run-completed", runId, status: payload.status, exitCode: payload.exitCode ?? null });
  }

  return filePath;
}

export function readRun(cwd, runId) {
  return JSON.parse(fs.readFileSync(resolveRunFile(cwd, runId), "utf8"));
}

// ---------------------------------------------------------------------------
// Dispatch + poll helpers
// ---------------------------------------------------------------------------

export function writeRunProcess(cwd, runId, processInfo) {
  const processFile = path.join(resolveRunArtifactsDir(cwd, runId), "process.json");
  atomicWriteJson(processFile, processInfo);
}

export function readRunProcess(cwd, runId) {
  const processFile = path.join(resolveRunArtifactsDir(cwd, runId), "process.json");
  if (!fs.existsSync(processFile)) return null;
  return JSON.parse(fs.readFileSync(processFile, "utf8"));
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
