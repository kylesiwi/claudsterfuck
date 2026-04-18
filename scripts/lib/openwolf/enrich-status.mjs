import fs from "node:fs";
import path from "node:path";

// Shared helpers for the enrichment status queries used by:
//  - scripts/enrich-anatomy.mjs (the --status / --prune flags)
//  - scripts/user-prompt-submit-hook.mjs (threshold alert + auto-run trigger)
//  - scripts/orchestrator.mjs enrichmemory subcommand (if added later)
//
// All functions are pure reads except pruneCacheOrphans (which writes the
// cleaned cache atomically).

const WOLF_DIR_NAME = ".wolf";
const ANATOMY_FILE = "anatomy.md";
const ENRICHED_FILE = "anatomy.enriched.md";
const CACHE_FILE = "anatomy.cache.json";

// Heuristics shared with enrich-anatomy.mjs. Keep in sync.
const WEAK_DESCRIPTION_PATTERNS = [
  /^\(~\d+\s*tok\)$/,
  /^---/,
  /^R\d+:/,
  /^run:\s*\w+/i,
  /^Resolve a /,
  /^Hook shape\b/i
];

export function resolveWolfPaths(workspaceRoot) {
  const wolfDir = path.join(workspaceRoot, WOLF_DIR_NAME);
  return {
    wolfDir,
    anatomyPath: path.join(wolfDir, ANATOMY_FILE),
    enrichedPath: path.join(wolfDir, ENRICHED_FILE),
    cachePath: path.join(wolfDir, CACHE_FILE)
  };
}

export function parseAnatomyForEnrichment(content) {
  const entries = [];
  let currentDir = ".";
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      currentDir = trimmed.replace(/^##\s*/, "").replace(/\/$/, "") || ".";
      continue;
    }
    const bullet = trimmed.match(/^- `([^`]+)`\s*(?:—\s*(.+?))?\s*\(~(\d+)\s*tok\)\s*$/);
    if (!bullet) continue;
    const [, filename, description, tokens] = bullet;
    const relativePath = currentDir === "." ? filename : `${currentDir}/${filename}`;
    entries.push({
      relativePath,
      vanillaDescription: (description ?? "").trim(),
      tokens: Number(tokens) || 0
    });
  }
  return entries;
}

export function isProblemDescription(description) {
  if (!description || description.trim() === "") return true;
  return WEAK_DESCRIPTION_PATTERNS.some((re) => re.test(description));
}

export function loadCache(cachePath) {
  if (!fs.existsSync(cachePath)) {
    return { version: 1, entries: {}, lastEnriched: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.entries) {
      return { version: 1, entries: {}, lastEnriched: null };
    }
    return {
      version: parsed.version ?? 1,
      entries: parsed.entries,
      lastEnriched: parsed.lastEnriched ?? null
    };
  } catch {
    return { version: 1, entries: {}, lastEnriched: null };
  }
}

export function saveCache(cachePath, cache) {
  const tmp = `${cachePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  fs.renameSync(tmp, cachePath);
}

// Compute enrichment status for the workspace. Fast — reads anatomy.md and
// the cache JSON once; does not hash any source files. Designed to be called
// on every user turn inside the hook.
export function getEnrichmentStatus(workspaceRoot) {
  const paths = resolveWolfPaths(workspaceRoot);

  if (!fs.existsSync(paths.anatomyPath)) {
    return {
      anatomyMissing: true,
      totalFiles: 0,
      problemFiles: 0,
      enrichedProblemFiles: 0,
      unenrichedProblemFiles: 0,
      orphanedCacheEntries: 0,
      cacheExists: fs.existsSync(paths.cachePath),
      lastEnriched: null,
      paths
    };
  }

  const anatomy = fs.readFileSync(paths.anatomyPath, "utf8");
  const entries = parseAnatomyForEnrichment(anatomy);
  const cache = loadCache(paths.cachePath);

  const anatomyPathSet = new Set(entries.map((e) => e.relativePath));
  const cachedPaths = Object.keys(cache.entries);
  const orphanedCacheEntries = cachedPaths.filter((p) => !anatomyPathSet.has(p));

  let problemFiles = 0;
  let enrichedProblemFiles = 0;
  const unenrichedProblemList = [];
  for (const entry of entries) {
    if (!isProblemDescription(entry.vanillaDescription)) continue;
    problemFiles += 1;
    if (cache.entries[entry.relativePath]) {
      enrichedProblemFiles += 1;
    } else {
      unenrichedProblemList.push(entry.relativePath);
    }
  }

  return {
    anatomyMissing: false,
    totalFiles: entries.length,
    problemFiles,
    enrichedProblemFiles,
    unenrichedProblemFiles: unenrichedProblemList.length,
    unenrichedProblemList,
    orphanedCacheEntries: orphanedCacheEntries.length,
    orphanedCacheList: orphanedCacheEntries,
    cacheExists: fs.existsSync(paths.cachePath),
    lastEnriched: cache.lastEnriched,
    paths
  };
}

// Prune cache entries whose relative path is no longer tracked in
// anatomy.md (file deleted/renamed). Writes the cache atomically. Returns
// the list of removed paths.
export function pruneCacheOrphans(workspaceRoot) {
  const status = getEnrichmentStatus(workspaceRoot);
  if (status.orphanedCacheEntries === 0) return { removed: [] };

  const cache = loadCache(status.paths.cachePath);
  const removed = [];
  for (const orphan of status.orphanedCacheList) {
    if (cache.entries[orphan]) {
      delete cache.entries[orphan];
      removed.push(orphan);
    }
  }
  saveCache(status.paths.cachePath, cache);
  return { removed };
}
