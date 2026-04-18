import { compactWhitespace } from "./sanitize.mjs";

function cleanBullet(text) {
  return compactWhitespace(String(text ?? "").replace(/^[-*+]\s*/, "").replace(/^`|`$/g, ""));
}

function shortenLabel(text) {
  const compact = compactWhitespace(text);
  return compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
}

// chunkAnatomy tracks the current `## <dir>` section as it walks lines,
// computes per-bullet relative paths, and (when an enriched map is provided)
// appends LLM-backed enrichment text to the chunk's text before emission.
// The enrichedMap is a Map<relativePath, enrichedText> produced from
// .wolf/anatomy.enriched.md by the corpus-enrichment sidecar.
//
// The enriched text is concatenated into the same chunk so scoring,
// interleaved selection, and the trimmer continue to treat one file as one
// unit of evidence (no new source, no extra per-source cap pressure).
export function chunkAnatomy(content, sourcePath, enrichedMap = null) {
  const map = enrichedMap instanceof Map ? enrichedMap : new Map(Object.entries(enrichedMap ?? {}));
  const chunks = [];
  let currentDir = ".";

  const lines = String(content ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Section header — track current directory for relative-path computation.
    if (trimmed.startsWith("## ")) {
      currentDir = trimmed.replace(/^##\s*/, "").replace(/\/$/, "") || ".";
      continue;
    }
    if (trimmed.startsWith("#")) continue;

    const text = cleanBullet(line);
    if (!text) continue;

    // Extract the backticked filename from the bullet (format:
    // `filename.ext` — description ... (~N tok)`). cleanBullet has already
    // stripped the first `- ` and one pair of outer backticks if present.
    const filenameMatch = text.match(/^([^`\s]+?)(?:`|\s+—|\s+$)/) || text.match(/^(\S+)/);
    const filename = filenameMatch ? filenameMatch[1].replace(/`/g, "") : text.split(/\s/)[0];
    const relativePath = currentDir === "." ? filename : `${currentDir}/${filename}`;
    const enrichedText = map.get(relativePath);
    const mergedText = enrichedText ? `${text} ${enrichedText}` : text;

    chunks.push({
      sourceName: "anatomy",
      sourcePath,
      label: shortenLabel(text),
      text: mergedText,
      position: index
    });
  }

  return chunks;
}

// Per-bullet chunking for cerebrum. Previously every heading was collapsed
// into a single mega-chunk containing every bullet under it. That made an
// individual learning invisible to retrieval — the "Do-Not-Repeat" block
// would match every keyword in the project and either flood the packet or
// hog the budget, starving anatomy. Per-bullet chunking lets each learning
// be selected independently based on its own text match.
export function chunkCerebrum(content, sourcePath) {
  const lines = String(content ?? "").split(/\r?\n/);
  const chunks = [];
  let heading = "General";
  let currentBullet = null;
  let currentPosition = 0;

  const flushBullet = () => {
    if (!currentBullet) return;
    const bulletText = compactWhitespace(currentBullet);
    if (!bulletText) {
      currentBullet = null;
      return;
    }
    chunks.push({
      sourceName: "cerebrum",
      sourcePath,
      label: `${heading} > ${shortenLabel(bulletText)}`,
      text: compactWhitespace(`${heading}: ${bulletText}`),
      position: currentPosition
    });
    currentBullet = null;
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullet();
      return;
    }

    if (trimmed.startsWith("#")) {
      flushBullet();
      heading = trimmed.replace(/^#+\s*/, "") || "General";
      return;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      flushBullet();
      currentBullet = cleanBullet(trimmed);
      currentPosition = index;
      return;
    }

    if (currentBullet) {
      currentBullet = compactWhitespace(`${currentBullet} ${trimmed}`);
    }
  });

  flushBullet();
  return chunks;
}

export function chunkBuglog(content, sourcePath) {
  let parsed;
  try {
    parsed = JSON.parse(String(content ?? ""));
  } catch (error) {
    return {
      chunks: [],
      warnings: [`${sourcePath}: failed to parse JSON (${error instanceof Error ? error.message : String(error)})`]
    };
  }

  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.bugs) ? parsed.bugs : [];
  const chunks = records
    .map((record, index) => ({
      id: String(record?.id ?? `bug-${index + 1}`),
      problem: compactWhitespace(record?.problem),
      rootCause: compactWhitespace(record?.rootCause),
      fix: compactWhitespace(record?.fix),
      position: index
    }))
    .filter((record) => record.rootCause && record.fix)
    .map((record) => ({
      sourceName: "buglog",
      sourcePath,
      label: `${record.id}: ${shortenLabel(record.problem || record.rootCause)}`,
      text: compactWhitespace(
        [
          record.problem ? `Problem: ${record.problem}` : "",
          `Root cause: ${record.rootCause}`,
          `Fix: ${record.fix}`
        ]
          .filter(Boolean)
          .join(" ")
      ),
      position: record.position
    }));

  return {
    chunks,
    warnings: []
  };
}

export function chunkIdentity(content, sourcePath) {
  const text = compactWhitespace(content);
  if (!text) {
    return [];
  }

  return [
    {
      sourceName: "identity",
      sourcePath,
      label: "Project identity",
      text,
      position: 0
    }
  ];
}
