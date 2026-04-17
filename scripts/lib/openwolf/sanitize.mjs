export const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "or",
  "the",
  "is",
  "are",
  "to",
  "of",
  "for",
  "in",
  "on",
  "with",
  "at",
  "by",
  "from",
  "this",
  "that",
  "it",
  "as"
]);

export function compactWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function extractObjectiveTerms(objective) {
  const rawTokens = String(objective ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const keywords = [];
  const seen = new Set();
  for (const token of rawTokens) {
    if (STOPWORDS.has(token) || seen.has(token)) {
      continue;
    }

    seen.add(token);
    keywords.push(token);
    if (keywords.length >= 8) {
      break;
    }
  }

  const phrases = [];
  const phraseSeen = new Set();
  for (let index = 0; index < keywords.length - 1; index += 1) {
    const pair = `${keywords[index]} ${keywords[index + 1]}`;
    if (!phraseSeen.has(pair)) {
      phraseSeen.add(pair);
      phrases.push(pair);
    }

    if (index < keywords.length - 2) {
      const triple = `${keywords[index]} ${keywords[index + 1]} ${keywords[index + 2]}`;
      if (!phraseSeen.has(triple)) {
        phraseSeen.add(triple);
        phrases.push(triple);
      }
    }
  }

  return {
    keywords,
    phrases
  };
}
