#!/usr/bin/env node

import { isDirectExecution } from "../lib/entrypoint.mjs";

function normalizePrompt(prompt) {
  return String(prompt ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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
    return { head: normalized, tail: normalized };
  }
  return {
    head: words.slice(0, 3).join(" "),
    tail: words.slice(-5).join(" ")
  };
}

function isPositional(signal, zones) {
  const s = signal.toLowerCase();
  return zones.head.includes(s) || zones.tail.includes(s);
}

function candidateShape(rule, matchedStrong, matchedWeak, zones) {
  const strongCount = matchedStrong.length;
  const weakCount = matchedWeak.length;
  const count = strongCount + weakCount;

  const score =
    matchedStrong.reduce((sum, s) => sum + (isPositional(s, zones) ? 6 : 3), 0) +
    matchedWeak.reduce((sum, s) => sum + (isPositional(s, zones) ? 2 : 1), 0);

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
      "reviewer said"
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
      "failure modes"
    ],
    weakSignals: ["premortem", "adversarial"]
  },
  {
    route: "review",
    reason: "review-oriented request",
    strongSignals: [
      "code review",
      "review this",
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
      "execution plan"
    ],
    weakSignals: ["plan", "roadmap"]
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
      "architecture"
    ],
    weakSignals: ["design", "spec", "approach", "options"]
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
      "reproduce the bug"
    ],
    weakSignals: ["bug", "error", "broken", "regression", "debug", "failure", "failing"]
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
      "implement this",
      "add support",
      "retry logic"
    ],
    weakSignals: ["implement", "build", "add", "create", "refactor", "patch"]
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
  const normalized = normalizePrompt(prompt);
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

  const confidence =
    top.strongCount >= 2 || top.score >= 6
      ? "high"
      : top.strongCount >= 1 || top.score >= 3
        ? "medium"
        : "low";

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

  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    return {
      route: "chat",
      reason: "empty prompt fallback",
      confidence: "low",
      matchedSignals: [],
      candidates: []
    };
  }

  // Rule A: question mark anywhere in prompt → always chat, regardless of strong signals.
  // A "?" signals the user wants dialogue, not delegation.
  if (hasQuestionMark(normalized)) {
    return {
      route: "chat",
      reason: "question-mark-detected",
      confidence: "high",
      matchedSignals: [],
      candidates: []
    };
  }

  const result = classifyCandidates(scoreRoutes(prompt).candidates);

  // Rule B: question-starter phrasing with no strong delegation signal → chat.
  if (isQuestionLike(normalized) && (result.candidates[0]?.strongCount ?? 0) === 0) {
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
