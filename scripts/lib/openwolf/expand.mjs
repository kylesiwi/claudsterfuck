import { DEFAULT_VOCABULARY } from "./default-vocabulary.mjs";

// Merge two vocabulary objects. Per-route keys win over defaults; values are
// unioned (so a route can extend a default bucket rather than replace it).
export function mergeVocabularies(defaults, override) {
  const base = isPlainObject(defaults) ? defaults : {};
  const ext = isPlainObject(override) ? override : {};
  const merged = {};

  for (const [key, value] of Object.entries(base)) {
    merged[normalizeToken(key)] = dedupe(value);
  }

  for (const [key, value] of Object.entries(ext)) {
    const normKey = normalizeToken(key);
    const existing = merged[normKey] ?? [];
    merged[normKey] = dedupe([...existing, ...arrify(value)]);
  }

  return merged;
}

// Build a directed expansion lookup: keyword -> [synonyms].
//
// Earlier versions used transitive union-find across shared tokens, but this
// cascades aggressively: as soon as two buckets share any member token (say
// `compile`, which naturally appears in both the `memory` and `prompt`
// chains), every bucket that transitively touches either gets merged. The
// practical result was one giant blob of ~70 terms active for any architectural
// keyword, scoring unrelated chunks like `hooks.json` on queries about
// compile-packet.mjs.
//
// Directed expansion keeps semantics local and predictable: if the user types
// a word that is a bucket key, expand to that bucket's values. Nothing else.
// Reverse mappings (codex -> provider, etc.) must be declared explicitly by
// adding a `codex` bucket — this is intentional and documented in
// default-vocabulary.mjs.
export function buildDirectedExpansion(vocabulary) {
  const raw = isPlainObject(vocabulary) ? vocabulary : {};
  const lookup = new Map();

  for (const [key, values] of Object.entries(raw)) {
    const normKey = normalizeToken(key);
    if (!normKey) continue;
    const expansion = arrify(values)
      .map(normalizeToken)
      .filter((token) => token && token !== normKey);
    if (expansion.length === 0) continue;
    lookup.set(normKey, [...new Set(expansion)]);
  }

  return { lookup };
}

// Expand raw keywords using a vocabulary with directed (non-transitive)
// semantics. If a raw keyword is a bucket key, add the bucket's values to
// the expanded set. Nothing else is added.
//
// Returns:
// - expanded:            raw + directly-expanded synonyms
// - buckets:             map of raw-keyword -> synonyms actually added
// - appliedClassCount:   number of distinct buckets that fired
//
// Fail-open: malformed vocabulary returns { expanded: [...raw], buckets: {}, appliedClassCount: 0 }.
export function expandKeywords(rawKeywords, vocabulary) {
  const raw = Array.isArray(rawKeywords) ? rawKeywords.map(normalizeToken).filter(Boolean) : [];
  if (raw.length === 0) {
    return { expanded: [], buckets: {}, appliedClassCount: 0 };
  }

  let lookup;
  try {
    lookup = buildDirectedExpansion(vocabulary).lookup;
  } catch {
    return { expanded: [...new Set(raw)], buckets: {}, appliedClassCount: 0 };
  }

  const expandedSet = new Set(raw);
  const buckets = {};
  const firedBuckets = new Set();

  for (const keyword of raw) {
    const synonyms = lookup.get(keyword);
    if (!synonyms || synonyms.length === 0) continue;
    firedBuckets.add(keyword);
    const addedForThisKeyword = [];
    for (const synonym of synonyms) {
      if (!expandedSet.has(synonym)) {
        expandedSet.add(synonym);
        addedForThisKeyword.push(synonym);
      }
    }
    if (addedForThisKeyword.length > 0) {
      buckets[keyword] = addedForThisKeyword;
    }
  }

  return {
    expanded: [...expandedSet],
    buckets,
    appliedClassCount: firedBuckets.size
  };
}

export function resolveRouteVocabulary(routeVocabulary) {
  return mergeVocabularies(DEFAULT_VOCABULARY, routeVocabulary);
}

function normalizeToken(token) {
  return String(token ?? "").toLowerCase().trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrify(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function dedupe(list) {
  return [...new Set(arrify(list).map(normalizeToken).filter(Boolean))];
}
