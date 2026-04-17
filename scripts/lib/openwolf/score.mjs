import { extractObjectiveTerms } from "./sanitize.mjs";

const ROUTE_SOURCE_BIAS = Object.freeze({
  implement: { anatomy: 1, cerebrum: 1, buglog: 1 },
  debug: { buglog: 1, anatomy: 1 },
  review: { anatomy: 1, cerebrum: 1 },
  plan: { anatomy: 1, cerebrum: 1 },
  design: { anatomy: 1, cerebrum: 1 }
});

export function scoreChunks({ chunks, objective, route }) {
  const { keywords, phrases } = extractObjectiveTerms(objective);
  const sourceBias = ROUTE_SOURCE_BIAS[route] ?? {};

  const scoredChunks = chunks
    .map((chunk) => {
      const lowerText = chunk.text.toLowerCase();
      const phraseScore = phrases.reduce((total, phrase) => total + (lowerText.includes(phrase) ? 3 : 0), 0);
      const tokenScore = keywords.reduce((total, keyword) => total + (lowerText.includes(keyword) ? 1 : 0), 0);
      const lexicalScore = phraseScore + tokenScore;
      const score = lexicalScore > 0 ? lexicalScore + (sourceBias[chunk.sourceName] ?? 0) : 0;

      return {
        ...chunk,
        score
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.text.length - right.text.length ||
        left.position - right.position
    );

  return {
    keywords,
    phrases,
    scoredChunks
  };
}
