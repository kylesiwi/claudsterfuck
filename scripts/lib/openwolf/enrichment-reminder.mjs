import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getEnrichmentStatus } from "./enrich-status.mjs";

// Thresholds for the hook to decide between auto-run and alert-user.
const AUTO_RUN_MAX_UNENRICHED = 10;   // 1..10 → spawn background enrichment
const ALERT_MIN_UNENRICHED = 11;       // 11+ → inject reminder, don't auto-run
const AUTO_RUN_COOLDOWN_MS = 5 * 60_000; // don't auto-run within 5 min of last run

const ENRICH_SCRIPT = path.resolve(
  fileURLToPath(import.meta.url),
  "..", "..", "..", "enrich-anatomy.mjs"
);

// Build a reminder line (or null) for the UserPromptSubmit additionalContext
// based on the current enrichment state. Also kicks off a background
// enrichment run when the unenriched count is small (≤10). Designed to
// never block the turn — all work is detached + unref'd.
//
// Returns: { reminder: string|null, autoRunStarted: boolean, status: {...} }
//
// Callers should:
//   - skip this when route === "enrichmemory" (the user is already about to run it)
//   - skip when the slash command being invoked is enrichmemory
export function buildEnrichmentReminder(workspaceRoot, options = {}) {
  const skipAutoRun = options.skipAutoRun === true;
  let status;
  try {
    status = getEnrichmentStatus(workspaceRoot);
  } catch {
    return { reminder: null, autoRunStarted: false, status: null };
  }

  if (status.anatomyMissing || status.totalFiles === 0) {
    return { reminder: null, autoRunStarted: false, status };
  }

  const unenriched = status.unenrichedProblemFiles;

  if (unenriched === 0) {
    return { reminder: null, autoRunStarted: false, status };
  }

  // Alert path: many unenriched files. Surface to main-thread Claude so the
  // user can be prompted to run /claudsterfuck:enrichmemory at their pace.
  if (unenriched >= ALERT_MIN_UNENRICHED) {
    return {
      reminder:
        `[claudsterfuck:enrichmemory] ${unenriched} anatomy files have ` +
        `retrieval-weak descriptions and are not yet enriched. Suggest to ` +
        `the user running \`/claudsterfuck:enrichmemory\` to improve memory ` +
        `packet quality (est. ~${(unenriched * 3 / 4).toFixed(0)}s at concurrency 4, ` +
        `~$${(unenriched * 0.001).toFixed(3)} in Haiku tokens).`,
      autoRunStarted: false,
      status
    };
  }

  // Auto-run path: small batch, trigger silent background enrichment.
  if (unenriched <= AUTO_RUN_MAX_UNENRICHED && !skipAutoRun) {
    if (isCoolingDown(status.lastEnriched)) {
      return {
        reminder: null,
        autoRunStarted: false,
        status
      };
    }

    const started = spawnBackgroundEnrichment(workspaceRoot);
    if (started) {
      return {
        reminder:
          `[claudsterfuck:enrichmemory] Auto-enriching ${unenriched} ` +
          `file(s) in background. Sidecar will refresh shortly.`,
        autoRunStarted: true,
        status
      };
    }
  }

  return { reminder: null, autoRunStarted: false, status };
}

function isCoolingDown(lastEnrichedIso) {
  if (!lastEnrichedIso) return false;
  const last = Date.parse(lastEnrichedIso);
  if (!Number.isFinite(last)) return false;
  return Date.now() - last < AUTO_RUN_COOLDOWN_MS;
}

// Spawn a detached Node process running enrich-anatomy.mjs --problem-only.
// Returns true if spawn succeeded. Errors are swallowed — we never want
// the hook to fail a turn because of a housekeeping issue.
function spawnBackgroundEnrichment(workspaceRoot) {
  try {
    const child = spawn(process.execPath, [ENRICH_SCRIPT, "--problem-only", "--concurrency", "3"], {
      cwd: workspaceRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
