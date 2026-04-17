import path from "node:path";

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

function buildAdditionalContext(turn) {
  return [
    `[claudsterfuck] Routed turn active.`,
    `Route: ${turn.route}`,
    `Provider: ${turn.provider}`,
    `Phase: ${turn.phase ?? "unknown"}`,
    `Status: ${turn.status}`,
    `Review depth: ${turn.reviewDepth ?? "verify"}`,
    `Required framework packs: ${turn.requiredFrameworks.join(", ") || "(none)"}`,
    `Dispatch via Bash: node "\${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json`,
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
      `This turn is routed to ${turn.provider} (${turn.route}). Dispatch directly via Bash instead of spawning a subagent: node "\${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json`,
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
      `This routed turn must go through the claudsterfuck orchestrator. Dispatch with: node "\${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json`,
      routedContext
    );
  }

  if ([TURN_PHASES.REFINING, TURN_PHASES.READY_TO_DELEGATE].includes(phase)) {
    if (openWolfTarget) {
      return allow(`Allowed routed OpenWolf maintenance write: ${openWolfTarget.relativePath}.`, routedContext);
    }
    if (isContextTool(toolName)) {
      return allow("Read-only context gathering is allowed before delegation.", routedContext);
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
