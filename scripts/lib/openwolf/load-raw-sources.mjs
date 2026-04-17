import fs from "node:fs";
import path from "node:path";

export const MEMORY_SOURCE_PATHS = Object.freeze({
  anatomy: ".wolf/anatomy.md",
  cerebrum: ".wolf/cerebrum.md",
  buglog: ".wolf/buglog.json",
  identity: ".wolf/identity.md"
});

export function requestedMemorySources(memoryPlan = {}) {
  const requested = Array.isArray(memoryPlan.sources) ? [...memoryPlan.sources] : [];
  if (memoryPlan.includeIdentity) {
    requested.push("identity");
  }

  return [...new Set(requested.filter((source) => typeof source === "string" && source in MEMORY_SOURCE_PATHS))];
}

export function loadRawSources({ workspaceRoot, memoryPlan }) {
  return requestedMemorySources(memoryPlan).map((sourceName) => {
    const relativePath = MEMORY_SOURCE_PATHS[sourceName];
    const absolutePath = path.join(workspaceRoot, relativePath);
    const exists = fs.existsSync(absolutePath);
    return {
      sourceName,
      sourcePath: relativePath,
      absolutePath,
      exists,
      content: exists ? fs.readFileSync(absolutePath, "utf8") : null
    };
  });
}
