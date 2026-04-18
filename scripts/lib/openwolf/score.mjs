import { extractObjectiveTerms } from "./sanitize.mjs";
import { expandKeywords, resolveRouteVocabulary } from "./expand.mjs";

const ROUTE_SOURCE_BIAS = Object.freeze({
  implement: { anatomy: 1, cerebrum: 1, buglog: 1 },
  debug: { buglog: 1, anatomy: 1 },
  review: { anatomy: 1, cerebrum: 1 },
  plan: { anatomy: 1, cerebrum: 1 },
  design: { anatomy: 1, cerebrum: 1 }
});

// Score weights. Raw keyword matches (tokens from the user's actual prompt)
// score higher than expansion-only matches (synonyms pulled from the route
// vocabulary). This preserves precedence for tokens the user actually typed
// while still letting expansion rescue the zero-overlap case.
const SCORE_RAW_TOKEN = 1;
const SCORE_PHRASE = 3;
const SCORE_EXPANSION_TOKEN = 0.5;

export function scoreChunks({ chunks, objective, route, vocabulary }) {
  const { keywords, phrases } = extractObjectiveTerms(objective);
  const sourceBias = ROUTE_SOURCE_BIAS[route] ?? {};

  const mergedVocab = resolveRouteVocabulary(vocabulary);
  const expansion = expandKeywords(keywords, mergedVocab);
  const rawSet = new Set(keywords);
  const expansionOnly = expansion.expanded.filter((term) => !rawSet.has(term));

  const scoredChunks = chunks
    .map((chunk) => {
      const lowerText = chunk.text.toLowerCase();
      const phraseScore = phrases.reduce(
        (total, phrase) => total + (lowerText.includes(phrase) ? SCORE_PHRASE : 0),
        0
      );
      const rawTokenScore = keywords.reduce(
        (total, keyword) => total + (lowerText.includes(keyword) ? SCORE_RAW_TOKEN : 0),
        0
      );
      const expansionScore = expansionOnly.reduce(
        (total, term) => total + (lowerText.includes(term) ? SCORE_EXPANSION_TOKEN : 0),
        0
      );
      const lexicalScore = phraseScore + rawTokenScore + expansionScore;
      const score = lexicalScore > 0 ? lexicalScore + (sourceBias[chunk.sourceName] ?? 0) : 0;

      return {
        ...chunk,
        score,
        rawTokenScore,
        expansionScore,
        phraseScore
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        // Prefer chunks that matched user's raw tokens over expansion-only matches
        right.rawTokenScore - left.rawTokenScore ||
        // Then prefer more-concise chunks, then file-order tiebreak
        left.text.length - right.text.length ||
        left.position - right.position
    );

  return {
    keywords,
    phrases,
    scoredChunks,
    expansion
  };
}
