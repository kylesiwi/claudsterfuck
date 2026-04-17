#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";

import { evaluatePreToolUse } from "./policy.mjs";
import { TURN_PHASES } from "./state.mjs";

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    throw error;
  }
}

function makeRoutedTurn(overrides = {}) {
  return {
    route: "implement",
    provider: "codex",
    phase: TURN_PHASES.REFINING,
    status: "needs-delegation",
    writeEnabled: true,
    requiresDelegation: true,
    reviewDepth: "test",
    requiredFrameworks: ["implementation/worker-contract.md"],
    ...overrides
  };
}

function pre(input, turn = makeRoutedTurn()) {
  return evaluatePreToolUse(input, turn);
}

const CWD = "C:/dev/claudsterfuck";

// --- R2: source-read blackout tests ---

await run("Read on .wolf/anatomy.md is allowed during REFINING", () => {
  const decision = pre({
    tool_name: "Read",
    tool_input: { file_path: ".wolf/anatomy.md" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "allow");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /memory read/i);
});

await run("Read on .wolf/cerebrum.md is allowed during REFINING", () => {
  const decision = pre({
    tool_name: "Read",
    tool_input: { file_path: ".wolf/cerebrum.md" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "allow");
});

await run("Read on .wolf/buglog.json is allowed during REFINING", () => {
  const decision = pre({
    tool_name: "Read",
    tool_input: { file_path: ".wolf/buglog.json" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "allow");
});

await run("Read on .wolf/memory.md is allowed during REFINING", () => {
  const decision = pre({
    tool_name: "Read",
    tool_input: { file_path: ".wolf/memory.md" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "allow");
});

await run("Read on source file (src/api.js) is denied during REFINING", () => {
  const decision = pre({
    tool_name: "Read",
    tool_input: { file_path: "src/api.js" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /source-code reads are blocked/i);
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /\.wolf\/anatomy\.md/);
});

await run("Read on scripts/orchestrator.mjs is denied during REFINING", () => {
  const decision = pre({
    tool_name: "Read",
    tool_input: { file_path: "scripts/orchestrator.mjs" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
});

await run("Grep scoped to .wolf/ is allowed", () => {
  const decision = pre({
    tool_name: "Grep",
    tool_input: { pattern: "TODO", path: ".wolf" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "allow");
});

await run("Grep over source is denied", () => {
  const decision = pre({
    tool_name: "Grep",
    tool_input: { pattern: "TODO", path: "src" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /source-code searches/i);
});

await run("Grep with no path specified (defaults to cwd) is denied", () => {
  const decision = pre({
    tool_name: "Grep",
    tool_input: { pattern: "TODO" },
    cwd: CWD
  });
  // No path field → search covers the whole workspace → deny
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
});

await run("Glob scoped to .wolf/ is allowed", () => {
  const decision = pre({
    tool_name: "Glob",
    tool_input: { pattern: ".wolf/*.md" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "allow");
});

await run("Glob over source is denied", () => {
  const decision = pre({
    tool_name: "Glob",
    tool_input: { pattern: "**/*.ts" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
});

await run("WebSearch is denied during REFINING", () => {
  const decision = pre({
    tool_name: "WebSearch",
    tool_input: { query: "how to handle retries" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /web\/external reads/i);
});

await run("WebFetch is denied during REFINING", () => {
  const decision = pre({
    tool_name: "WebFetch",
    tool_input: { url: "https://example.com", prompt: "summarize" },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
});

// --- Non-delegated routes should NOT hit the blackout ---

await run("chat route (non-delegated) allows source reads", () => {
  const chatTurn = makeRoutedTurn({
    route: "chat",
    requiresDelegation: false,
    writeEnabled: false,
    phase: TURN_PHASES.NON_DELEGATED
  });
  const decision = pre({
    tool_name: "Read",
    tool_input: { file_path: "src/api.js" },
    cwd: CWD
  }, chatTurn);
  // Non-delegated chat: policy returns null (pass through) for reads
  assert.equal(decision, null);
});

await run("claude route (non-delegated) allows source reads", () => {
  const claudeTurn = makeRoutedTurn({
    route: "claude",
    requiresDelegation: false,
    writeEnabled: true,
    phase: TURN_PHASES.NON_DELEGATED
  });
  const decision = pre({
    tool_name: "Read",
    tool_input: { file_path: "src/api.js" },
    cwd: CWD
  }, claudeTurn);
  assert.equal(decision, null);
});

// --- REVIEWING phase still allows source reads (post-worker) ---

await run("REVIEWING phase allows source code reads", () => {
  const reviewTurn = makeRoutedTurn({ phase: TURN_PHASES.REVIEWING });
  const decision = pre({
    tool_name: "Read",
    tool_input: { file_path: "src/api.js" },
    cwd: CWD
  }, reviewTurn);
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "allow");
});

// --- Bash dispatch still allowed ---

await run("Bash orchestrator dispatch is still allowed in REFINING", () => {
  const decision = pre({
    tool_name: "Bash",
    tool_input: { command: 'node "scripts/orchestrator.mjs" dispatch --watch --json' },
    cwd: CWD
  });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "allow");
});

// --- READY_TO_DELEGATE behaves same as REFINING ---

await run("READY_TO_DELEGATE also blocks source reads", () => {
  const readyTurn = makeRoutedTurn({ phase: TURN_PHASES.READY_TO_DELEGATE });
  const decision = pre({
    tool_name: "Read",
    tool_input: { file_path: "src/api.js" },
    cwd: CWD
  }, readyTurn);
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
});

await run("READY_TO_DELEGATE allows .wolf reads", () => {
  const readyTurn = makeRoutedTurn({ phase: TURN_PHASES.READY_TO_DELEGATE });
  const decision = pre({
    tool_name: "Read",
    tool_input: { file_path: ".wolf/anatomy.md" },
    cwd: CWD
  }, readyTurn);
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "allow");
});
