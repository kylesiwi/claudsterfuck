#!/usr/bin/env node

import process from "node:process";

import { isDirectExecution } from "./lib/entrypoint.mjs";
import { emitHookJson, readHookInput } from "./lib/hook-io.mjs";
import { evaluatePreToolUse } from "./lib/policy.mjs";
import { getSessionRecord } from "./lib/state.mjs";

export function buildPreToolDecision(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env.CLAUDSTERFUCK_SESSION_ID || "";
  const turn = getSessionRecord(cwd, sessionId)?.currentTurn ?? null;
  return evaluatePreToolUse(input, turn);
}

function main() {
  const decision = buildPreToolDecision(readHookInput());
  if (decision) {
    emitHookJson(decision);
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
