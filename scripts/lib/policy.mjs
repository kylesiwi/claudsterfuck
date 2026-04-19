import path from "node:path";

import { PROJECT_ROOT } from "../routing/lib/config.mjs";
import { TURN_PHASES } from "./state.mjs";

const COMPANION_ACTIONS = ["setup", "dispatch", "watch", "status", "inspect", "result", "reset", "cancel", "reroute", "recover"];
const CONFIRMATION_ALLOWLIST = new Set(["AskUserQuestion", "Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const OPENWOLF_WRITABLE_FILES = new Set(["anatomy.md", "memory.md", "buglog.json", "cerebrum.md"]);

function isCompanionCommand(command, action) {
  return (
    typeof command === "string" &&
    command.includes("orchestrator.mjs") &&
    new RegExp(`\\b${action}\\b`, "i").test(command)
  );
}

export function isAllowedCompanionCommand(command) {
  return COMPANION_ACTIONS.some((action) => isCompanionCommand(command, action));
}

function isInspectCompanionCommand(command) {
  return isCompanionCommand(command, "inspect");
}

function isVerificationCommand(command) {
  return (
    typeof command === "string" &&
    /\b(git status|git diff|npm test|pnpm test|yarn test|pytest|vitest|cargo test|go test|dotnet test|mvn test|gradle test|ruff check|eslint|tsc|turbo test)\b/i.test(
      command
    )
  );
}

function isContextTool(toolName) {
  if (["Read", "Glob", "Grep", "WebSearch", "WebFetch"].includes(toolName)) {
    return true;
  }

  return /^mcp__kapture__.+/i.test(toolName) || /^mcp__.+__(read|get|fetch|search|find|list|query|capture|snapshot|extract)/i.test(toolName);
}

function normalizeForComparison(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolveToolTargetPath(toolInput) {
  const filePath = toolInput?.file_path;
  return typeof filePath === "string" && filePath.trim().length > 0 ? filePath.trim() : null;
}

function resolveOpenWolfWritableTarget(toolName, toolInput, cwd) {
  if (!WRITE_TOOLS.has(toolName)) {
    return null;
  }

  const targetPath = resolveToolTargetPath(toolInput);
  if (!targetPath) {
    return null;
  }

  const workspaceRoot = path.resolve(cwd || process.cwd());
  const wolfRoot = path.resolve(workspaceRoot, ".wolf");
  const resolvedTarget = path.resolve(workspaceRoot, targetPath);
  const relativeToWolf = path.relative(wolfRoot, resolvedTarget);

  if (!relativeToWolf || relativeToWolf.startsWith("..") || path.isAbsolute(relativeToWolf)) {
    return null;
  }

  // Keep this strictly to top-level OpenWolf bookkeeping files.
  if (relativeToWolf.includes(path.sep) || !OPENWOLF_WRITABLE_FILES.has(relativeToWolf)) {
    return null;
  }

  const allowlistedPath = path.resolve(wolfRoot, relativeToWolf);
  if (normalizeForComparison(resolvedTarget) !== normalizeForComparison(allowlistedPath)) {
    return null;
  }

  return {
    relativePath: `.wolf/${relativeToWolf}`.replace(/\\/g, "/")
  };
}

/**
 * Resolve a read target that is inside the workspace's .wolf/ directory.
 * Broader than the writable target: any file under .wolf/ is readable context
 * (anatomy, cerebrum, buglog, memory, plans, designqc captures, subfolders).
 *
 * Returns { relativePath } for .wolf/* reads, or null otherwise.
 */
function resolveOpenWolfReadableTarget(toolInput, cwd) {
  const targetPath = resolveToolTargetPath(toolInput);
  if (!targetPath) {
    return null;
  }

  const workspaceRoot = path.resolve(cwd || process.cwd());
  const wolfRoot = path.resolve(workspaceRoot, ".wolf");
  const resolvedTarget = path.resolve(workspaceRoot, targetPath);
  const relativeToWolf = path.relative(wolfRoot, resolvedTarget);

  if (!relativeToWolf || relativeToWolf.startsWith("..") || path.isAbsolute(relativeToWolf)) {
    return null;
  }

  return {
    relativePath: `.wolf/${relativeToWolf}`.replace(/[/\\]+/g, "/")
  };
}

/**
 * Some Grep/Glob calls don't have a single `file_path` — they use `path` or
 * `--include` semantics. Extract whatever target-ish field we can to check
 * whether the call is scoped to .wolf/.
 */
function resolveSearchTargetPath(toolName, toolInput) {
  if (toolName === "Grep" || toolName === "Glob") {
    const candidates = [
      toolInput?.path,
      toolInput?.file_path,
      toolInput?.pattern,
      toolInput?.glob
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }
  return toolInput?.file_path ?? null;
}

function isSearchScopedToWolf(toolName, toolInput, cwd) {
  const target = resolveSearchTargetPath(toolName, toolInput);
  if (typeof target !== "string" || !target.trim()) {
    return false;
  }

  // Accept both forward- and back-slashed paths; accept absolute paths that
  // resolve inside .wolf/ as well as short relative hints (".wolf/anatomy.md").
  const normalized = target.replace(/\\/g, "/");
  if (normalized.startsWith(".wolf/") || normalized === ".wolf") {
    return true;
  }
  // Resolve and check
  const workspaceRoot = path.resolve(cwd || process.cwd());
  const wolfRoot = path.resolve(workspaceRoot, ".wolf");
  try {
    const resolvedTarget = path.resolve(workspaceRoot, target);
    const rel = path.relative(wolfRoot, resolvedTarget);
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function buildAdditionalContext(turn) {
  return [
    `[claudsterfuck] Routed turn active.`,
    `Route: ${turn.route}`,
    `Provider: ${turn.provider}`,
    `Phase: ${turn.phase ?? "unknown"}`,
    `Status: ${turn.status}`,
    `Review depth: ${turn.reviewDepth ?? "verify"}`,
    `Required framework packs: ${turn.requiredFrameworks.join(", ") || "(none)"}`,
    `Dispatch via Bash: node "${PROJECT_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json`,
    `Do not implement directly in the main Claude thread. Delegate through the claudsterfuck orchestrator first.`
  ].join("\n");
}

function buildMinimalContext(turn) {
  return `[cf] ${turn.route}/${turn.provider}/${turn.phase ?? "unknown"}`;
}

function allow(reason, additionalContext = null) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
      ...(additionalContext ? { additionalContext } : {})
    }
  };
}

function deny(reason, additionalContext = null) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      ...(additionalContext ? { additionalContext } : {})
    }
  };
}

export function evaluatePreToolUseWithoutTurn(input) {
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};

  if (toolName !== "Bash") {
    return null;
  }

  const command = String(toolInput.command ?? "");
  if (!isAllowedCompanionCommand(command)) {
    return null;
  }

  if (isInspectCompanionCommand(command)) {
    return allow(
      "Allowed claudsterfuck inspect command without active routed turn. Treat inspect as read-only diagnostics; do not modify .wolf/* or any bookkeeping files."
    );
  }

  return allow("Allowed claudsterfuck command without active routed turn.");
}

export function evaluatePreToolUse(input, turn) {
  if (!turn) {
    return evaluatePreToolUseWithoutTurn(input);
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const phase = turn.phase ?? TURN_PHASES.REFINING;
  const cwd = input.cwd || process.cwd();
  const openWolfTarget = resolveOpenWolfWritableTarget(toolName, toolInput, cwd);
  const isWriteTool = WRITE_TOOLS.has(toolName);
  const routedContext = buildAdditionalContext(turn);

  if (phase === TURN_PHASES.AWAITING_USER) {
    if (CONFIRMATION_ALLOWLIST.has(toolName)) {
      return allow("Confirmation mode allows only clarification and lightweight inspection tools.", routedContext);
    }

    return deny(
      "Route confirmation is still pending. Ask the user to confirm the route before delegating, editing, or running shell commands.",
      routedContext
    );
  }

  if (turn.requiresDelegation === false || turn.status === "cancelled") {
    if (!turn.writeEnabled && WRITE_TOOLS.has(toolName)) {
      return deny(
        `The "${turn.route}" route is read-only. Use route:implement to write code, or route:claude for an unrestricted turn.`,
        routedContext
      );
    }
    return null;
  }

  if (toolName === "AskUserQuestion") {
    if ([TURN_PHASES.REFINING, TURN_PHASES.READY_TO_DELEGATE, TURN_PHASES.WORKER_RUNNING, TURN_PHASES.REVIEWING].includes(phase)) {
      return allow("Hybrid routing allows orchestration and clarification questions in this phase.", routedContext);
    }
  }

  if (toolName === "Agent") {
    return deny(
      `This turn is routed to ${turn.provider} (${turn.route}). Dispatch directly via Bash instead of spawning a subagent: node "${PROJECT_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json`,
      routedContext
    );
  }

  if (toolName === "Bash") {
    const command = String(toolInput.command ?? "");
    if (isAllowedCompanionCommand(command)) {
      if (isInspectCompanionCommand(command)) {
        return allow(
          "Allowed claudsterfuck inspect command. Treat inspect as read-only diagnostics; do not modify .wolf/* or any bookkeeping files.",
          routedContext
        );
      }

      return allow("Allowed claudsterfuck command.", routedContext);
    }

    if (phase === TURN_PHASES.REVIEWING && isVerificationCommand(command)) {
      return allow("Allowed verification command after worker completion.", routedContext);
    }

    return deny(
      `This routed turn must go through the claudsterfuck orchestrator. Dispatch with: node "${PROJECT_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json`,
      routedContext
    );
  }

  if ([TURN_PHASES.REFINING, TURN_PHASES.READY_TO_DELEGATE].includes(phase)) {
    if (openWolfTarget) {
      return allow(`Allowed routed OpenWolf maintenance write: ${openWolfTarget.relativePath}.`, routedContext);
    }

    // Source-read blackout: .wolf/* memory is readable (file map, conventions,
    // bug log, memory), but source files are not. The worker receives the
    // memory packet and reads source itself — Claude should not pre-digest.
    if (isContextTool(toolName)) {
      // Read / Grep / Glob: allow only when the target is inside .wolf/.
      if (toolName === "Read") {
        const memReadTarget = resolveOpenWolfReadableTarget(toolInput, cwd);
        if (memReadTarget) {
          return allow(
            `Allowed memory read: ${memReadTarget.relativePath}. .wolf/ files give Claude project context without pre-digesting source code.`,
            routedContext
          );
        }
        return deny(
          "Source-code reads are blocked before dispatch on routed turns. The worker receives the .wolf/anatomy.md + .wolf/cerebrum.md memory packet and reads source files itself. Include any specific file paths in --objective and let the worker explore. Use route:claude if you need unrestricted source access.",
          routedContext
        );
      }
      if (toolName === "Grep" || toolName === "Glob") {
        if (isSearchScopedToWolf(toolName, toolInput, cwd)) {
          return allow(
            "Memory search allowed (scoped to .wolf/). Use this to surface conventions or prior work before dispatching.",
            routedContext
          );
        }
        return deny(
          "Source-code searches (Grep/Glob over source) are blocked before dispatch on routed turns. Scope the search to .wolf/ (e.g. .wolf/anatomy.md) or let the worker explore after dispatch. Use route:claude for unrestricted search.",
          routedContext
        );
      }
      // WebSearch / WebFetch and MCP read-style tools stay blocked pre-dispatch —
      // the worker can fetch too, and Claude shouldn't pre-research.
      return deny(
        "Web/external reads are blocked before dispatch on routed turns. Include relevant URLs or context in --objective; the worker can fetch them.",
        routedContext
      );
    }
    if (isWriteTool) {
      return deny(
        "Main-thread file edits stay disabled on routed turns. Refine locally, then delegate implementation to the orchestrator.",
        routedContext
      );
    }
    return null;
  }

  if (phase === TURN_PHASES.WORKER_RUNNING) {
    if (["Read", "Glob", "Grep"].includes(toolName)) {
      return allow("Status inspection.", buildMinimalContext(turn));
    }
    if (isContextTool(toolName) || isWriteTool) {
      return deny(
        "A routed worker is already running. Inspect status or wait for the result instead of duplicating work in the main thread.",
        routedContext
      );
    }
    return null;
  }

  if (phase === TURN_PHASES.REVIEWING) {
    if (openWolfTarget) {
      return allow(`Allowed routed OpenWolf maintenance write: ${openWolfTarget.relativePath}.`, routedContext);
    }
    if (isContextTool(toolName)) {
      return allow("Review context tool.", buildMinimalContext(turn));
    }
    if (isWriteTool) {
      return deny(
        "Main-thread file edits stay disabled on routed turns. Delegate another worker task instead of editing directly.",
        routedContext
      );
    }
    return null;
  }

  if (isWriteTool) {
    return deny(
      "Main-thread file edits stay disabled on routed turns. Delegate through the orchestrator instead of editing directly.",
      routedContext
    );
  }

  return null;
}

export function evaluateStop(turn, options = {}) {
  if (!turn) {
    return null;
  }

  const phase = turn.phase ?? TURN_PHASES.REFINING;

  if (phase === TURN_PHASES.AWAITING_USER) {
    return null;
  }

  if (turn.requiresDelegation === false || turn.status === "cancelled") {
    return null;
  }

  if ([TURN_PHASES.REFINING, TURN_PHASES.REVIEWING].includes(phase)) {
    return null;
  }

  if (options.stopHookActive) {
    return null;
  }

  if (turn.latestRunStatus === "failed" || turn.status === "worker-failed") {
    const detail = turn.latestRunErrorSummary ? ` Failure detail: ${turn.latestRunErrorSummary}` : "";
    return {
      decision: "block",
      reason: `The latest ${turn.provider} worker run failed. Retry the worker task or recover with cancel/reroute before stopping.${detail}`
    };
  }

  if (phase === TURN_PHASES.READY_TO_DELEGATE) {
    return {
      decision: "block",
      reason: `This turn is routed to ${turn.provider} (${turn.route}) and is ready for delegation. Delegate or cancel/reroute before stopping.`
    };
  }

  return {
    decision: "block",
    reason: `This turn is routed to ${turn.provider} (${turn.route}) and still has no completed worker result. Delegate through the claudsterfuck orchestrator before stopping.`
  };
}
