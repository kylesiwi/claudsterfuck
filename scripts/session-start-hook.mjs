#!/usr/bin/env node

import process from "node:process";

import { isDirectExecution } from "./lib/entrypoint.mjs";
import { appendEnvVar, readHookInput, SESSION_ID_ENV } from "./lib/hook-io.mjs";
import { setSessionRecord } from "./lib/state.mjs";

export function handleSessionStart(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || "";
  if (!sessionId) {
    return;
  }

  appendEnvVar(SESSION_ID_ENV, sessionId);
  setSessionRecord(cwd, sessionId, {
    sessionId,
    currentTurn: null
  });
}

function main() {
  handleSessionStart(readHookInput());
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
