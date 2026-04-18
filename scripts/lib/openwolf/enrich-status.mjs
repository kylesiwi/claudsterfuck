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

// Safety filter: which paths are eligible for LLM enrichment?
//
// The enrichment subprocess streams file contents into a Haiku prompt. Two
// classes of files must never leave the workspace:
//   1. .wolf/ sources — they ARE the retrieval corpus (self-referential);
//      sending them to an LLM wastes tokens and risks leaking context
//      assembled for the user's private memory/learning files.
//   2. Paths that resolve outside the workspace root (e.g. absolute paths
//      like D:/Users/<user>/.claude/settings.json that OpenWolf sometimes
//      tracks for cross-project context). Those are user-personal config
//      and must not be shipped to an LLM.
//
// Returns true when the path is safe to enrich. Uses relative-path string
// checks (cheap, called per anatomy entry) plus absolute-path containment
// verified against the workspace root.
export function isSafeToEnrich(relativePath, workspaceRoot) {
  const normalized = String(relativePath ?? "").replace(/\\/g, "/").trim();
  if (!normalized) return false;

  // Hard exclusions on relative form
  if (normalized.startsWith(".wolf/") || normalized === ".wolf") return false;
  if (normalized.startsWith("../")) return false;
  // Drive-letter or POSIX absolute forms signal out-of-workspace paths
  // that OpenWolf occasionally tracks (e.g. D:/Users/.../settings.json).
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith("/")) return false;

  // Defensive: resolve against workspace and ensure containment
  try {
    const resolved = path.resolve(workspaceRoot, normalized);
    const workspaceResolved = path.resolve(workspaceRoot);
    // Use normalized case for Windows comparisons
    const rLow = resolved.toLowerCase();
    const wLow = workspaceResolved.toLowerCase();
    if (!rLow.startsWith(wLow)) return false;
    // Guard again inside workspace to exclude .wolf/ by absolute path too
    const rel = path.relative(workspaceResolved, resolved).replace(/\\/g, "/");
    if (rel.startsWith(".wolf/") || rel === ".wolf") return false;
  } catch {
    return false;
  }

  return true;
}

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
  const allEntries = parseAnatomyForEnrichment(anatomy);
  // Safety filter: never count or process .wolf/* or out-of-workspace paths.
  const entries = allEntries.filter((e) => isSafeToEnrich(e.relativePath, workspaceRoot));
  const unsafeSkipped = allEntries.length - entries.length;
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
    unsafeSkipped,
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
