#!/usr/bin/env node

import { isDirectExecution } from "../lib/entrypoint.mjs";

function rawNormalize(prompt) {
  return String(prompt ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Filler prefixes that dilute positional scoring without changing intent.
// Stripped for scoring only — question detection and display use the raw form.
const FILLER_PREFIX_PATTERNS = [
  /^please\s+/i,
  /^i\s+want\s+(?:you\s+)?to\s+/i,
  /^i\s+need\s+(?:you\s+)?to\s+/i,
  /^i'?d\s+like\s+(?:you\s+)?to\s+/i,
  /^we\s+(?:want|need)\s+to\s+/i,
  /^let'?s\s+/i,
  /^let\s+us\s+/i,
  /^could\s+you\s+/i,
  /^would\s+you\s+/i,
  /^can\s+you\s+/i,
  /^hey\s+claude[,\s]+/i,
  /^ok\s+/i,
  /^okay\s+/i,
  /^alright\s+/i,
  /^so\s+/i
];

function stripFillerPrefixes(normalized) {
  let stripped = normalized;
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of FILLER_PREFIX_PATTERNS) {
      const next = stripped.replace(pattern, "");
      if (next !== stripped) {
        stripped = next;
        changed = true;
      }
    }
  }
  return stripped;
}

function normalizeForScoring(prompt) {
  return stripFillerPrefixes(rawNormalize(prompt));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values) {
  return [...new Set(values)];
}

function matchStrongSignals(text, signals) {
  return unique(signals.filter((signal) => text.includes(signal.toLowerCase())));
}

function matchWeakSignals(text, signals) {
  return unique(
    signals.filter((signal) => {
      const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(signal.toLowerCase())}($|[^a-z0-9])`, "i");
      return pattern.test(text);
    })
  );
}

function extractPositionalZones(normalized) {
  const words = normalized.split(" ");
  if (words.length <= 5) {
    return { head: normalized, tail: normalized, firstWord: words[0] ?? "", firstTwo: normalized, firstThree: normalized };
  }
  return {
    head: words.slice(0, 3).join(" "),
    tail: words.slice(-5).join(" "),
    firstWord: words[0] ?? "",
    firstTwo: words.slice(0, 2).join(" "),
    firstThree: words.slice(0, 3).join(" ")
  };
}

function isPositional(signal, zones) {
  const s = signal.toLowerCase();
  return zones.head.includes(s) || zones.tail.includes(s);
}

/**
 * First-word boost (R1C): if the signal matches the very first word or the
 * first 2–3 words of the prompt (after filler stripping), the user's intent is
 * unambiguous and the signal carries outsized weight.
 *
 * - strong signal as first word/phrase → 8 points
 * - weak signal as first word/phrase   → 6 points (treated as strong-in-head)
 * - strong signal in head/tail zone    → 6 points (unchanged)
 * - weak signal in head/tail zone      → 2 points (unchanged)
 * - body                               → 3 / 1 (unchanged)
 */
function isFirstWordMatch(signal, zones) {
  const s = signal.toLowerCase();
  return s === zones.firstWord || s === zones.firstTwo || s === zones.firstThree;
}

function candidateShape(rule, matchedStrong, matchedWeak, zones) {
  const strongCount = matchedStrong.length;
  const weakCount = matchedWeak.length;
  const count = strongCount + weakCount;

  const score =
    matchedStrong.reduce((sum, s) => {
      if (isFirstWordMatch(s, zones)) return sum + 8;
      if (isPositional(s, zones)) return sum + 6;
      return sum + 3;
    }, 0) +
    matchedWeak.reduce((sum, s) => {
      if (isFirstWordMatch(s, zones)) return sum + 6;
      if (isPositional(s, zones)) return sum + 2;
      return sum + 1;
    }, 0);

  return {
    route: rule.route,
    reason: rule.reason,
    signals: [...matchedStrong, ...matchedWeak],
    count,
    strongCount,
    weakCount,
    score
  };
}

function compareCandidates(left, right) {
  return (
    right.score - left.score ||
    right.strongCount - left.strongCount ||
    right.count - left.count ||
    left.route.localeCompare(right.route)
  );
}

export const ROUTE_RULES = [
  {
    route: "review-feedback",
    reason: "incoming review feedback",
    strongSignals: [
      "review feedback",
      "review comments",
      "pr comments",
      "code review feedback",
      "feedback from reviewer",
      "reviewer said",
      "reviewer comments",
      "reviewer's comments"
    ],
    weakSignals: ["feedback"]
  },
  {
    route: "adversarial-review",
    reason: "challenge or pre-mortem language",
    strongSignals: [
      "devil's advocate",
      "devils advocate",
      "pre-mortem",
      "pressure test",
      "pressure-test",
      "challenge this",
      "what could go wrong",
      "blind spots",
      "failure modes",
      "stress test",
      "stress-test",
      "red team",
      "red-team"
    ],
    weakSignals: ["premortem", "adversarial", "critique"]
  },
  {
    route: "review",
    reason: "review-oriented request",
    strongSignals: [
      "code review",
      "review this",
      "review my",
      "review the",
      "look for issues",
      "check this diff",
      "inspect this",
      "audit this"
    ],
    weakSignals: ["review", "audit"]
  },
  {
    route: "plan",
    reason: "planning language",
    strongSignals: [
      "implementation plan",
      "write a plan",
      "break this down",
      "task list",
      "step by step plan",
      "rollout plan",
      "execution plan",
      "plan for",
      "outline the steps",
      "plan this out"
    ],
    weakSignals: ["plan", "roadmap", "outline", "breakdown", "blueprint"]
  },
  {
    route: "design",
    reason: "design or brainstorming language",
    strongSignals: [
      "brainstorm",
      "design options",
      "system design",
      "tradeoffs",
      "alternative approaches",
      "design this",
      "architecture",
      "architect this"
    ],
    weakSignals: ["design", "spec", "approach", "options", "architect"]
  },
  {
    route: "debug",
    reason: "bug or failure language",
    strongSignals: [
      "failing test",
      "root cause",
      "investigate why",
      "fix failing",
      "why is this failing",
      "stack trace",
      "reproduce the bug",
      "not working",
      "doesn't work",
      "does not work",
      "fix the bug",
      "fix this bug"
    ],
    weakSignals: [
      "bug",
      "error",
      "broken",
      "regression",
      "debug",
      "failure",
      "failing",
      "fix",
      "fails",
      "crash",
      "crashes",
      "crashing",
      "hangs",
      "hanging",
      "stuck",
      "issue",
      "breaking"
    ]
  },
  {
    route: "implement-artifact",
    reason: "large generated file likely",
    strongSignals: [
      "full html page",
      "complete html",
      "html mockup",
      "page mockup",
      "webpage mockup",
      "web page mockup",
      "self-contained",
      "full webpage",
      "complete webpage",
      "full web page",
      "generate a page",
      "generate the page",
      "build a page",
      "build the page",
      "create a page",
      "create the page",
      "build a dashboard",
      "create a dashboard",
      "build a landing",
      "create a landing"
    ],
    weakSignals: ["mockup", "landing page", "full page", "html file", "single file"]
  },
  {
    route: "implement",
    reason: "implementation language",
    strongSignals: [
      "write code",
      "write the code",
      "implement this",
      "add support",
      "retry logic",
      "build this",
      "build this out"
    ],
    weakSignals: [
      "implement",
      "build",
      "add",
      "create",
      "refactor",
      "patch",
      "write",
      "make",
      "update",
      "modify",
      "remove",
      "delete",
      "rename",
      "extract",
      "split",
      "merge",
      "simplify",
      "replace",
      "optimize",
      "move",
      "rewrite",
      "port",
      "wire"
    ]
  },
  {
    route: "chat",
    reason: "discussion-only language",
    strongSignals: [
      "help me understand",
      "walk me through",
      "how does",
      "what does",
      "what is",
      "explain how",
      "explain what",
      "tell me about",
      "clarify how"
    ],
    weakSignals: []
  }
];

export function scoreRoutes(prompt) {
  const normalized = normalizeForScoring(prompt);
  if (!normalized) {
    return {
      normalized,
      candidates: []
    };
  }

  const zones = extractPositionalZones(normalized);
  const candidates = ROUTE_RULES.map((rule) =>
    candidateShape(
      rule,
      matchStrongSignals(normalized, rule.strongSignals),
      matchWeakSignals(normalized, rule.weakSignals),
      zones
    )
  )
    .filter((candidate) => candidate.score > 0)
    .sort(compareCandidates);

  return {
    normalized,
    candidates
  };
}

function summarizeCandidates(candidates) {
  return candidates.map(({ route, reason, signals, count, strongCount, score, weakCount }) => ({
    route,
    reason,
    signals,
    count,
    strongCount,
    weakCount,
    score
  }));
}

function inferAmbiguity(candidates) {
  if (candidates.length < 2) {
    return null;
  }

  const [top, runnerUp] = candidates;
  if (top.score === runnerUp.score && top.strongCount === runnerUp.strongCount) {
    return `ambiguous between ${top.route} and ${runnerUp.route}`;
  }

  if (top.strongCount === 0 && runnerUp.strongCount > 0) {
    return `ambiguous weak-signal win between ${top.route} and ${runnerUp.route}`;
  }

  if (top.strongCount > 0 && runnerUp.strongCount > 0 && top.score - runnerUp.score <= 2) {
    return `ambiguous overlapping intent between ${top.route} and ${runnerUp.route}`;
  }

  if (top.score - runnerUp.score <= 1) {
    return `ambiguous closely-scored intent between ${top.route} and ${runnerUp.route}`;
  }

  return null;
}

export function classifyCandidates(candidates) {
  const summary = summarizeCandidates(candidates);
  if (summary.length === 0) {
    return {
      route: "chat",
      reason: "default chat fallback",
      confidence: "low",
      matchedSignals: [],
      candidates: []
    };
  }

  const top = summary[0];
  const ambiguityReason = inferAmbiguity(summary);
  if (ambiguityReason) {
    return {
      route: top.route,
      reason: ambiguityReason,
      confidence: "ambiguous",
      matchedSignals: top.signals,
      candidates: summary
    };
  }

  let confidence;
  if (top.strongCount >= 2 || top.score >= 6) {
    confidence = "high";
  } else if (top.strongCount >= 1 || top.score >= 3) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  // R1A: promote medium to high when the top candidate clearly dominates.
  // Dominance definition: runner-up is materially behind (gap >= 3) AND the
  // top candidate has either a strong signal or a meaningful score.
  if (confidence === "medium") {
    const runnerUp = summary[1];
    const dominanceGap = runnerUp ? top.score - runnerUp.score : top.score;
    const strongDominance = top.strongCount >= 1 && dominanceGap >= 3;
    const scoreDominance = top.score >= 5 && dominanceGap >= 3;
    if (strongDominance || scoreDominance) {
      confidence = "high";
      return {
        route: top.route,
        reason: `${top.reason} (medium-with-dominance)`,
        confidence,
        matchedSignals: top.signals,
        candidates: summary
      };
    }
  }

  return {
    route: top.route,
    reason: top.reason,
    confidence,
    matchedSignals: top.signals,
    candidates: summary
  };
}

const QUESTION_STARTERS =
  /^(what|how|why|where|when|who|which|can |could |should |would |is |are |does |do |did |tell me|explain|walk me|help me understand)/i;

function hasQuestionMark(text) {
  return text.includes("?");
}

function isQuestionLike(normalized) {
  return QUESTION_STARTERS.test(normalized);
}

export function classifyTurn(prompt) {
  // Shell command prefix (! ...) should never be delegated to a worker.
  if (typeof prompt === "string" && prompt.trimStart().startsWith("!")) {
    return {
      route: "chat",
      reason: "shell-command-prefix",
      confidence: "override",
      matchedSignals: [],
      candidates: []
    };
  }

  const rawNormalized = rawNormalize(prompt);
  if (!rawNormalized) {
    return {
      route: "chat",
      reason: "empty prompt fallback",
      confidence: "low",
      matchedSignals: [],
      candidates: []
    };
  }

  // Rule A: question mark in SHORT prompts → chat override.
  // Short prompts with "?" are almost always questions wanting dialogue.
  // Long prompts often contain incidental questions inside a task description,
  // so we let normal signal scoring decide.
  const QUESTION_MARK_WORD_THRESHOLD = 20;
  const wordCount = rawNormalized.split(/\s+/).length;
  if (hasQuestionMark(rawNormalized) && wordCount <= QUESTION_MARK_WORD_THRESHOLD) {
    return {
      route: "chat",
      reason: "question-mark-detected",
      confidence: "high",
      matchedSignals: [],
      candidates: []
    };
  }

  const result = classifyCandidates(scoreRoutes(prompt).candidates);

  // Rule A2: question mark in LONG prompts with no strong delegation signal → chat.
  // The "?" didn't override above because the prompt is long, but if signal
  // scoring found nothing strong, fall back to chat.
  if (hasQuestionMark(rawNormalized) && wordCount > QUESTION_MARK_WORD_THRESHOLD && (result.candidates[0]?.strongCount ?? 0) === 0) {
    return {
      route: "chat",
      reason: "question-mark-long-prompt-no-strong-signal",
      confidence: "medium",
      matchedSignals: [],
      candidates: result.candidates
    };
  }

  // Rule B: question-starter phrasing with no strong delegation signal → chat.
  // Uses rawNormalized (pre-strip) so stripped filler prefixes don't hide the question starter.
  if (isQuestionLike(rawNormalized) && (result.candidates[0]?.strongCount ?? 0) === 0) {
    return {
      route: "chat",
      reason: "question-starter-no-strong-signal",
      confidence: "high",
      matchedSignals: [],
      candidates: result.candidates
    };
  }

  return result;
}

function parseArgs(argv) {
  const args = { prompt: "", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--prompt") {
      args.prompt = argv[i + 1] ?? "";
      i += 1;
    } else if (value === "--json") {
      args.json = true;
    } else if (!value.startsWith("--")) {
      args.prompt = args.prompt ? `${args.prompt} ${value}` : value;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = classifyTurn(args.prompt);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `route=${result.route}`,
      `reason=${result.reason}`,
      `confidence=${result.confidence}`,
      `signals=${result.matchedSignals.join(",") || "-"}`,
      `candidates=${result.candidates.map((candidate) => `${candidate.route}:${candidate.score}`).join(",") || "-"}`,
      ""
    ].join("\n")
  );
}

if (isDirectExecution(import.meta.url)) {
  main();
}
