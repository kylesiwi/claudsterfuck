#!/usr/bin/env node

import process from "node:process";

import { isDirectExecution } from "./lib/entrypoint.mjs";
import { compileMemoryPacket } from "./lib/openwolf/compile-packet.mjs";
import { loadRouteProfile } from "./routing/lib/config.mjs";

function parseArgs(argv) {
  const args = {
    command: "",
    workspace: "",
    route: "",
    objective: "",
    json: false
  };

  const values = [...argv];
  args.command = values.shift() ?? "";

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--workspace") {
      args.workspace = values[index + 1] ?? "";
      index += 1;
    } else if (value === "--route") {
      args.route = values[index + 1] ?? "";
      index += 1;
    } else if (value === "--objective") {
      args.objective = values[index + 1] ?? "";
      index += 1;
    } else if (value === "--json") {
      args.json = true;
    } else if (!value.startsWith("--")) {
      args.objective = args.objective ? `${args.objective} ${value}` : value;
    }
  }

  return args;
}

function emitPacket(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const lines = [];
  if (result.packet) {
    lines.push(result.packet.trim(), "");
  }
  lines.push(`Used sources: ${result.usedSources.join(", ") || "(none)"}`);
  lines.push(`Warnings: ${result.warnings.join(" | ") || "(none)"}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "packet") {
    throw new Error('Unsupported command. Use: packet --workspace <path> --route <route> --objective <text>');
  }
  if (!args.workspace) {
    throw new Error("Missing required --workspace.");
  }
  if (!args.route) {
    throw new Error("Missing required --route.");
  }

  const route = loadRouteProfile(args.route);
  const result = compileMemoryPacket({
    workspaceRoot: args.workspace,
    objective: args.objective,
    route: route.route,
    memoryPlan: route.defaultMemoryPlan ?? null
  });

  emitPacket(result, args.json);
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
