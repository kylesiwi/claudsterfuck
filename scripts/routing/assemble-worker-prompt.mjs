#!/usr/bin/env node

import process from "node:process";

import {
  ensureExists,
  frameworkPath,
  loadRouteProfile,
  providerPromptPath,
  readText
} from "./lib/config.mjs";
import { compileMemoryPacket } from "../lib/openwolf/compile-packet.mjs";
import { compilePrompt } from "../lib/prompt-compiler.mjs";
import { isDirectExecution } from "../lib/entrypoint.mjs";

const VALID_PROVIDERS = new Set(["codex", "gemini"]);

function buildOutputContractSection(artifactMode, writeEnabled) {
  if (artifactMode === "return-artifacts") {
    return `## Output Contract

ARTIFACT RETURN MODE: Do NOT use write_file, apply_patch, or any file-writing tool to produce
output files. Instead, generate the complete content for each output file and return it in the
\`artifacts\` array of your final JSON response. The runner will write these files to disk safely.

Your final response MUST be a valid JSON object (not markdown, not prose) with this structure:

\`\`\`json
{
  "status": "Complete",
  "summary": "Brief description of what was done",
  "filesChanged": ["path/to/file.ext"],
  "verification": ["Verification step taken"],
  "concerns": [],
  "artifacts": [
    {
      "path": "relative/path/to/file.ext",
      "content": "...complete file content...",
      "encoding": "utf8"
    }
  ]
}
\`\`\`

You may still use read-only tools and shell inspection commands during your work.
Only the final file output must be returned as artifacts rather than written directly.

`;
  }

  if (!writeEnabled) {
    return `## Output Contract

READ-ONLY ROUTE. Do NOT write, edit, patch, or modify any files.
Return a concise document with:

- Status
- Summary
- Findings / Proposed approach (analysis, plan, or review — no implementation)
- Risks / Concerns

`;
  }

  return `## Output Contract

Return a concise structured report with:

- Status
- Summary
- Files changed
- Verification
- Concerns

`;
}

function renderFrameworkSection(frameworks) {
  return frameworks
    .map(
      (framework) =>
        [
          `### ${framework.path}`,
          framework.content.trim(),
          ""
        ].join("\n")
    )
    .join("\n");
}

function replaceAll(template, replacements) {
  return Object.entries(replacements).reduce(
    (current, [key, value]) => current.replaceAll(`{{${key}}}`, value),
    template
  );
}

function loadFrameworks(frameworkPaths) {
  return frameworkPaths.map((relativePath) => {
    const filePath = ensureExists(frameworkPath(relativePath), "Framework pack");
    return {
      path: relativePath,
      content: readText(filePath)
    };
  });
}

function buildMemoryPacket(route, options) {
  if (!route.requiresDelegation || !route.defaultMemoryPlan || !options.workspaceRoot) {
    return "";
  }

  try {
    return (
      compileMemoryPacket({
        workspaceRoot: options.workspaceRoot,
        objective: options.objective,
        route: route.route,
        memoryPlan: route.defaultMemoryPlan
      }).packet || ""
    );
  } catch {
    return "";
  }
}

export function assembleWorkerPrompt(options) {
  const route = loadRouteProfile(options.route);
  const provider = options.provider ?? route.defaultProvider ?? null;
  const artifactMode = route.artifactMode ?? null;
  const timeoutSeconds =
    Number.isFinite(route.timeoutSeconds) && route.timeoutSeconds > 0 ? Math.floor(route.timeoutSeconds) : 900;

  if (route.requiresDelegation === false) {
    return {
      route: route.route,
      provider,
      writeEnabled: Boolean(route.writeEnabled),
      requiresDelegation: false,
      requiredFrameworks: Array.isArray(route.requiredFrameworks) ? route.requiredFrameworks : [],
      frameworks: Array.isArray(route.requiredFrameworks) ? route.requiredFrameworks : [],
      timeoutSeconds,
      defaultMemoryPlan: route.defaultMemoryPlan ?? null,
      artifactMode,
      prompt: String(options.objective ?? "").trim()
    };
  }

  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported provider "${provider}".`);
  }

  const frameworks = loadFrameworks(route.requiredFrameworks);
  const template = readText(ensureExists(providerPromptPath(provider), "Provider prompt"));
  const memoryPacket = buildMemoryPacket(route, {
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    objective: options.objective
  });
  const outputContractSection = buildOutputContractSection(artifactMode, route.writeEnabled);
  const rawPrompt = replaceAll(template, {
    ROUTE_NAME: route.route,
    WRITE_MODE: route.writeEnabled ? "write-enabled" : "read-only",
    OBJECTIVE: String(options.objective ?? "").trim() || "No objective provided.",
    ROUTE_BRIEF: route.routeBrief,
    MEMORY_PACKET: memoryPacket ? `${memoryPacket}\n` : "",
    FRAMEWORKS_SECTION: renderFrameworkSection(frameworks),
    OUTPUT_CONTRACT_SECTION: outputContractSection
  });

  // Always-on prompt compilation (Lite compression)
  // Only mutable text outside <!-- IMMUTABLE --> markers gets compressed.
  // Fail-open: if compression breaks invariants, original prompt is used.
  const compiled = compilePrompt(rawPrompt);
  const prompt = compiled.prompt;

  return {
    route: route.route,
    provider,
    writeEnabled: Boolean(route.writeEnabled),
    requiresDelegation: Boolean(route.requiresDelegation),
    requiredFrameworks: frameworks.map((framework) => framework.path),
    frameworks: frameworks.map((framework) => framework.path),
    timeoutSeconds,
    defaultMemoryPlan: route.defaultMemoryPlan ?? null,
    artifactMode,
    description: route.description,
    prompt,
    promptCompilation: {
      compressed: compiled.compressed,
      fallback: compiled.fallback,
      originalLength: compiled.originalLength,
      compressedLength: compiled.compressedLength,
      reduction: compiled.reduction
    }
  };
}

function parseArgs(argv) {
  const args = {
    route: "",
    provider: "",
    objective: "",
    workspace: "",
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--route") {
      args.route = argv[i + 1] ?? "";
      i += 1;
    } else if (value === "--provider") {
      args.provider = argv[i + 1] ?? "";
      i += 1;
    } else if (value === "--objective") {
      args.objective = argv[i + 1] ?? "";
      i += 1;
    } else if (value === "--workspace") {
      args.workspace = argv[i + 1] ?? "";
      i += 1;
    } else if (value === "--json") {
      args.json = true;
    } else if (!value.startsWith("--")) {
      args.objective = args.objective ? `${args.objective} ${value}` : value;
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.route) {
    throw new Error("Missing required --route.");
  }
  const result = assembleWorkerPrompt({
    workspaceRoot: args.workspace || process.cwd(),
    route: args.route,
    provider: args.provider || undefined,
    objective: args.objective
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(result.prompt);
  if (!result.prompt.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}
