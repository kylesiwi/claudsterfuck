#!/usr/bin/env node

import assert from "node:assert/strict";

import { buildIdleRecoveryHint } from "./lib/openwolf/monitor-daemon-view.mjs";

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    if (error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    throw error;
  }
}

await run("buildIdleRecoveryHint: points idle users at recover --force-stalled", () => {
  const hint = buildIdleRecoveryHint();
  assert.equal(
    hint,
    "Orphaned workers? Run: node orchestrator.mjs recover --force-stalled"
  );
});

process.stdout.write("\nAll tests completed.\n");
