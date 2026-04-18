#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isDirectExecution } from "./lib/entrypoint.mjs";
import { appendEnvVar, readHookInput, SESSION_ID_ENV } from "./lib/hook-io.mjs";
import { setSessionRecord } from "./lib/state.mjs";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function handleSessionStart(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || "";
  if (!sessionId) {
    return;
  }

  appendEnvVar(SESSION_ID_ENV, sessionId);
  appendEnvVar("CLAUDE_PLUGIN_ROOT", PLUGIN_ROOT);
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
