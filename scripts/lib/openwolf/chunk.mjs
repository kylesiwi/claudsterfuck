import { compactWhitespace } from "./sanitize.mjs";

function cleanBullet(text) {
  return compactWhitespace(String(text ?? "").replace(/^[-*+]\s*/, "").replace(/^`|`$/g, ""));
}

function shortenLabel(text) {
  const compact = compactWhitespace(text);
  return compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
}

export function chunkAnatomy(content, sourcePath) {
  return String(content ?? "")
    .split(/\r?\n/)
    .map((line, index) => ({
      line,
      index
    }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#");
    })
    .map(({ line, index }) => {
      const text = cleanBullet(line);
      return {
        sourceName: "anatomy",
        sourcePath,
        label: shortenLabel(text),
        text,
        position: index
      };
    });
}

export function chunkCerebrum(content, sourcePath) {
  const lines = String(content ?? "").split(/\r?\n/);
  const chunks = [];
  let heading = "General";
  let bullets = [];
  let groupStart = 0;

  const flush = () => {
    if (bullets.length === 0) {
      return;
    }

    const text = bullets.map((bullet) => `- ${bullet}`).join("\n");
    chunks.push({
      sourceName: "cerebrum",
      sourcePath,
      label: `${heading} > ${shortenLabel(bullets[0])}`,
      text: compactWhitespace(`${heading} ${text}`),
      position: groupStart
    });
    bullets = [];
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      return;
    }

    if (trimmed.startsWith("#")) {
      flush();
      heading = trimmed.replace(/^#+\s*/, "") || "General";
      return;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      if (bullets.length === 0) {
        groupStart = index;
      }
      bullets.push(cleanBullet(trimmed));
      return;
    }

    if (bullets.length > 0) {
      bullets[bullets.length - 1] = compactWhitespace(`${bullets[bullets.length - 1]} ${trimmed}`);
    }
  });

  flush();
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
