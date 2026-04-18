// Stopwords strip instruction-framing noise so the topical query dominates
// scoring. User prompts are ~70% instruction-meta ("look into what possible
// approaches...") — only ~30% is topical. Without aggressive stopwording, the
// first-N-tokens truncation in extractObjectiveTerms picks up framing words
// and pushes topical nouns out of the keyword budget.
//
// Words preserved on purpose: anything that could plausibly match a real file
// or concept in a codebase (model, route, dispatch, config, code, file, etc.).
export const STOPWORDS = new Set([
  // Articles / determiners
  "a", "an", "the", "this", "that", "these", "those", "such",
  // Pronouns
  "i", "me", "my", "mine", "myself",
  "you", "your", "yours", "yourself",
  "we", "us", "our", "ours", "ourselves",
  "he", "him", "his", "himself",
  "she", "her", "hers", "herself",
  "it", "its", "itself",
  "they", "them", "their", "theirs", "themselves",
  // Conjunctions
  "and", "or", "but", "so", "yet", "nor",
  "if", "then", "else", "because", "although", "though",
  "while", "whereas", "unless", "until",
  // Prepositions
  "of", "to", "in", "on", "at", "by", "for", "from", "with", "without",
  "into", "onto", "upon", "over", "under", "through",
  "during", "before", "after", "above", "below", "around",
  "about", "against", "between", "among", "across",
  "behind", "beyond", "within", "near", "per", "via",
  // Be-verbs
  "is", "are", "was", "were", "be", "been", "being", "am",
  // Auxiliaries / modals
  "have", "has", "had", "having",
  "do", "does", "did", "doing", "done",
  "will", "would", "could", "should", "might", "may", "must",
  "can", "shall", "ought",
  // Generic/instruction verbs (low retrieval signal)
  "get", "got", "gotten", "make", "makes", "made", "making",
  "go", "goes", "went", "going", "gone",
  "come", "comes", "came", "coming",
  "see", "sees", "saw", "seen", "seeing",
  "know", "knows", "knew", "known", "knowing",
  "think", "thinks", "thought", "thinking",
  "say", "says", "said", "saying",
  "tell", "tells", "told", "telling",
  "ask", "asks", "asked", "asking",
  "want", "wants", "wanted", "wanting",
  "need", "needs", "needed", "needing",
  "try", "tries", "tried", "trying",
  "use", "uses", "used", "using",
  "find", "finds", "found", "finding",
  "look", "looks", "looked", "looking",
  "check", "checks", "checked", "checking",
  "figure", "figures", "figured", "figuring",
  "determine", "determines", "determined", "determining",
  "consider", "considers", "considered", "considering",
  "investigate", "investigates", "investigated", "investigating",
  "explore", "explores", "explored", "exploring",
  "examine", "examines", "examined", "examining",
  "understand", "understands", "understood", "understanding",
  "take", "takes", "took", "taken", "taking",
  "give", "gives", "gave", "given", "giving",
  "put", "puts", "putting",
  "show", "shows", "showed", "shown", "showing",
  "let", "lets", "letting",
  "keep", "keeps", "kept", "keeping",
  "seem", "seems", "seemed", "seeming",
  // Hedges / discourse / modals
  "maybe", "perhaps", "possible", "possibly", "probably", "actually",
  "basically", "essentially", "really", "just", "only",
  "quite", "simply", "very", "often", "sometimes", "usually",
  "always", "never", "ever", "even", "also", "too",
  "still", "already", "yet", "now", "then", "here", "there",
  "well", "okay", "ok", "please", "sorry", "like", "as",
  // Meta / filler nouns (low retrieval signal)
  "thing", "things", "stuff", "way", "ways",
  "part", "parts", "kind", "kinds", "type", "types",
  "sort", "sorts", "approach", "approaches",
  "option", "options", "possibility", "possibilities",
  "case", "cases", "example", "examples",
  "issue", "issues", "problem", "problems",
  "question", "questions", "matter", "matters",
  "reason", "reasons", "point", "points",
  // Quantifiers / generic qualifiers
  "specific", "general", "various", "different",
  "several", "some", "any", "all", "each", "every",
  "many", "much", "more", "most", "less", "least",
  "few", "other", "another", "same", "whole", "entire",
  // Wh-words / question frames
  "what", "why", "how", "when", "where", "who", "whom", "whose",
  "which", "whether",
  // Polarity / response tokens
  "not", "no", "yes"
]);

export function compactWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// Keyword budget cap. Bumped from 8 -> 16 in PR 3 after benchmark evidence
// that 8 truncates refined objectives (which follow the PR 3 template
// "[task-type] [affected-systems] — [goal]") mid-stream, dropping topical
// tail terms like "codex", "gemini", "model" that are retrieval-critical.
// Aggressive stopwording (PR 1) already prevents low-signal words from
// sneaking in; 16 gives refined objectives room to breathe without diluting
// raw-prose queries (which typically yield only 4-8 surviving tokens).
const KEYWORD_BUDGET = 16;

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
    if (keywords.length >= KEYWORD_BUDGET) {
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
