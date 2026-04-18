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

// Parse .wolf/anatomy.enriched.md into a Map<relativePath, enrichedText>.
// Sidecar format:
//   ## <relative-path>
//   summary: ...
//   keywords: ...
//   exports: ...
//
// The returned text concatenates summary + keywords + exports into a single
// space-joined blob — it's appended to the anatomy chunk's own text, so
// formatting doesn't matter, only the token surface for substring matching.
//
// Returns an empty Map if the sidecar is absent or unparseable. Fail-open:
// retrieval falls back to vanilla anatomy.md unchanged.
export function loadEnrichedAnatomyMap(workspaceRoot) {
  const sidecarPath = path.join(workspaceRoot, ".wolf", "anatomy.enriched.md");
  if (!fs.existsSync(sidecarPath)) return new Map();

  let content;
  try {
    content = fs.readFileSync(sidecarPath, "utf8");
  } catch {
    return new Map();
  }

  const map = new Map();
  let currentPath = null;
  let buffer = [];

  const flush = () => {
    if (!currentPath) return;
    const joined = buffer.join(" ").trim();
    if (joined) map.set(currentPath, joined);
    buffer = [];
  };

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      flush();
      currentPath = trimmed.replace(/^##\s*/, "").trim();
      continue;
    }
    if (!currentPath) continue;
    if (trimmed.startsWith(">") || trimmed.startsWith("#")) continue;
    if (!trimmed) continue;
    const match = trimmed.match(/^(summary|keywords|exports):\s*(.+)$/i);
    if (match) buffer.push(match[2]);
  }
  flush();

  return map;
}
