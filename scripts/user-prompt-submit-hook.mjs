#!/usr/bin/env node

import process from "node:process";

import { classifyCandidates, classifyTurn } from "./routing/classify-turn.mjs";
import { isDirectExecution } from "./lib/entrypoint.mjs";
import { appendEnvVar, emitHookJson, readHookInput, SESSION_ID_ENV } from "./lib/hook-io.mjs";
import { loadRouteProfile, routeExists } from "./routing/lib/config.mjs";
import { getSessionRecord, setCurrentTurn, setSessionRecord, TURN_DEFAULTS, TURN_PHASES } from "./lib/state.mjs";

function isSlashCommandPrompt(prompt) {
  return /^\s*\/\S+/.test(prompt);
}

const PLUGIN_COMMAND_NAMES = ["claudsterfuck"];

function parsePluginSlashCommand(prompt) {
  const match = String(prompt ?? "")
    .trim()
    .match(new RegExp(`^/(?:${PLUGIN_COMMAND_NAMES.join("|")}):([a-z-]+)(?:\\s+([\\s\\S]*))?$`, "i"));

  if (!match) {
    return {
      action: "",
      argsText: "",
      isPluginCommand: false
    };
  }

  return {
    action: match[1].toLowerCase(),
    argsText: String(match[2] ?? "").trim(),
    isPluginCommand: true
  };
}

function getSlashCommandAction(prompt) {
  return parsePluginSlashCommand(prompt).action;
}

function parseRouteDirective(prompt) {
  const rawPrompt = String(prompt ?? "");
  const bracketPattern = /^\s*\[route:([a-z0-9-]+)\]\s*/i;
  const bracketMatch = rawPrompt.match(bracketPattern);

  let route = "";
  let cleanedPrompt = rawPrompt;

  if (bracketMatch) {
    route = bracketMatch[1].trim().toLowerCase();
    cleanedPrompt = rawPrompt.replace(bracketPattern, "").trim();
  } else {
    const prefixPatterns = [
      /^\s*route\s*:\s*([a-z0-9-]+)\b\s*/i,
      /^\s*route\s*=\s*([a-z0-9-]+)\b\s*/i,
      /^\s*route\s+([a-z0-9-]+)\b\s*/i
    ];
    for (const pattern of prefixPatterns) {
      const prefixMatch = rawPrompt.match(pattern);
      if (prefixMatch) {
        route = prefixMatch[1].trim().toLowerCase();
        cleanedPrompt = rawPrompt.replace(pattern, "").trim();
        break;
      }
    }
  }

  if (!route) {
    return {
      cleanedPrompt: rawPrompt.trim(),
      route: "",
      valid: false,
      warning: null
    };
  }

  if (routeExists(route)) {
    return {
      cleanedPrompt,
      route,
      valid: true,
      warning: null
    };
  }

  return {
    cleanedPrompt,
    route,
    valid: false,
    warning: `[claudsterfuck] Ignored invalid explicit route override: ${route}. Use route:<name> at the start of your message (or [route:<name>]).`
  };
}

function buildTurnFromRoute({ prompt, objective, routeProfile, classification, extras = {} }) {
  const requiresDelegation = Boolean(routeProfile.requiresDelegation);
  return {
    ...TURN_DEFAULTS,
    prompt,
    objective,
    route: routeProfile.route,
    provider: routeProfile.defaultProvider ?? null,
    writeEnabled: Boolean(routeProfile.writeEnabled),
    requiresDelegation,
    requiredFrameworks: Array.isArray(routeProfile.requiredFrameworks) ? routeProfile.requiredFrameworks : [],
    reviewDepth: routeProfile.reviewDepth ?? "verify",
    timeoutSeconds:
      Number.isFinite(routeProfile.timeoutSeconds) && routeProfile.timeoutSeconds > 0
        ? Math.floor(routeProfile.timeoutSeconds)
        : 900,
    defaultMemoryPlan:
      routeProfile.defaultMemoryPlan && typeof routeProfile.defaultMemoryPlan === "object"
        ? routeProfile.defaultMemoryPlan
        : null,
    matchedSignals: classification?.matchedSignals ?? [],
    confidence: classification?.confidence ?? "low",
    phase: requiresDelegation ? TURN_PHASES.REFINING : TURN_PHASES.NON_DELEGATED,
    status: requiresDelegation ? "needs-delegation" : "non-delegated",
    ...extras
  };
}

function withWarning(lines, warning) {
  return warning ? [warning, ...lines] : lines;
}

function formatFrameworkList(turn) {
  return turn.requiredFrameworks.length > 0 ? turn.requiredFrameworks.join(", ") : "(none)";
}

function formatReviewDepth(turn) {
  const depth = turn.reviewDepth ?? "verify";
  if (depth === "test") return "test (run tests/build to verify, skip line-by-line code review)";
  if (depth === "trust") return "trust (present worker output directly, minimal verification)";
  return "verify (spot-check 1-2 critical claims from worker evidence)";
}

function buildDelegatedContext(turn, warning, extraLines = []) {
  return withWarning(
    [
      `[claudsterfuck] Route this turn through the worker runtime.`,
      `Classified route: ${turn.route}`,
      `Route confidence: ${turn.confidence}`,
      `Default worker provider: ${turn.provider}`,
      `Write mode: ${turn.writeEnabled ? "worker-write" : "read-only"}`,
      `Review depth: ${formatReviewDepth(turn)}`,
      `Required framework packs: ${formatFrameworkList(turn)}`,
      `Route lock behavior: one active turn maps to one route/provider at a time.`,
      `If you need the next phase in another route, ask the user to reroute explicitly.`,
      `No-text reroute preserves the objective, e.g. /claudsterfuck:implement`,
      `Dispatch shortcut: use 'dispatch --watch --json' to dispatch and poll in a single command.`,
      ...extraLines,
      `Main-thread rule: plan, delegate, review, and synthesize. Do not implement directly in Claude's main thread.`
    ],
    warning
  ).join("\n");
}

function buildNonDelegatedContext(turn, warning, extraLines = []) {
  return withWarning(
    [
      `[claudsterfuck] Non-delegated turn. You may read, explain, and discuss freely. No worker delegation is required for this turn.`,
      `Classified route: ${turn.route}`,
      ...extraLines
    ],
    warning
  ).join("\n");
}

function trimConfirmationReply(prompt) {
  return String(prompt ?? "")
    .trim()
    .replace(/^[\s"'`([{<]+/, "")
    .replace(/[\s"'`)\]}>.,!?;:]+$/, "")
    .trim()
    .toLowerCase();
}

function resolvePendingConfirmation(turn, override, prompt) {
  if (!turn?.awaitingConfirmation) {
    return null;
  }

  if (override.valid) {
    return {
      accepted: true,
      route: override.route,
      confidence: "override",
      matchedSignals: ["explicit-override"]
    };
  }

  const normalizedReply = trimConfirmationReply(prompt);
  const candidates = Array.isArray(turn.pendingCandidates) ? turn.pendingCandidates : [];
  const names = candidates.map((candidate) => String(candidate?.route ?? "").toLowerCase()).filter(Boolean);
  if (normalizedReply && names.includes(normalizedReply)) {
    return {
      accepted: true,
      route: normalizedReply,
      confidence: "medium",
      matchedSignals: ["route-confirmation"]
    };
  }

  return {
    accepted: false
  };
}

function buildOverrideClassification(routeName) {
  return {
    route: routeName,
    reason: "explicit route override",
    confidence: "override",
    matchedSignals: ["explicit-override"],
    candidates: [
      {
        route: routeName,
        signals: ["explicit-override"],
        count: 1,
        strongCount: 1,
        weakCount: 0,
        score: 999
      }
    ]
  };
}

function buildOverrideConflictWarning(overrideRoute, classification) {
  if (!overrideRoute || !classification || !Array.isArray(classification.candidates) || classification.candidates.length === 0) {
    return null;
  }

  const topCandidate = classification.candidates[0];
  if (!topCandidate || topCandidate.route === overrideRoute) {
    return null;
  }

  const hasStrongSignals = Number(topCandidate.strongCount ?? 0) > 0;
  const isSignificantConflict =
    classification.confidence === "high" || (classification.confidence === "medium" && hasStrongSignals);

  if (!isSignificantConflict) {
    return null;
  }

  const likelyRoutes = classification.candidates
    .slice(0, 3)
    .map((candidate) => candidate.route)
    .join(", ");

  return [
    `[claudsterfuck] Explicit override route:${overrideRoute} conflicts with detected intent (${topCandidate.route}, confidence ${classification.confidence}).`,
    `Continuing with your override.`,
    `Available likely routes from this prompt: ${likelyRoutes}.`,
    `If you wanted ${topCandidate.route}, use route:${topCandidate.route} at the start, [route:${topCandidate.route}], or /claudsterfuck:reroute --route ${topCandidate.route}.`
  ].join(" ");
}

function fallbackPendingCandidates(classification) {
  const candidates = Array.isArray(classification?.candidates) ? classification.candidates : [];
  if (candidates.length > 0) {
    return candidates;
  }

  return [
    {
      route: classification?.route || "implement",
      signals: classification?.matchedSignals ?? [],
      count: Array.isArray(classification?.matchedSignals) ? classification.matchedSignals.length : 0,
      strongCount: 0,
      weakCount: 0,
      score: 0
    }
  ];
}

function suppressChatCandidate(classification) {
  const candidates = Array.isArray(classification.candidates) ? classification.candidates : [];
  if (classification.route !== "chat" || candidates.length === 0) {
    return classification;
  }

  const delegatedCandidates = candidates.filter((candidate) => {
    if (candidate.route === "chat") {
      return false;
    }

    try {
      return loadRouteProfile(candidate.route).requiresDelegation === true;
    } catch {
      return false;
    }
  });
  if (delegatedCandidates.length === 0) {
    return classification;
  }

  return classifyCandidates(delegatedCandidates);
}

function normalizeAdvisorCandidate(candidate) {
  if (typeof candidate === "string") {
    return {
      route: candidate.toLowerCase(),
      advisorReason: null
    };
  }

  if (candidate && typeof candidate === "object" && typeof candidate.route === "string") {
    return {
      route: candidate.route.toLowerCase(),
      advisorReason: typeof candidate.reason === "string" ? candidate.reason : null
    };
  }

  return null;
}

function applyRouteAdvisor(prompt, classification, options = {}) {
  if (!["low", "ambiguous"].includes(classification.confidence) || typeof options.routeAdvisor !== "function") {
    return {
      pendingCandidates: fallbackPendingCandidates(classification),
      advisorExplanation: null
    };
  }

  try {
    const advisory = options.routeAdvisor({
      prompt,
      classification
    });

    if (!advisory || !Array.isArray(advisory.candidates)) {
      return {
        pendingCandidates: fallbackPendingCandidates(classification),
        advisorExplanation: null
      };
    }

    const advisorCandidates = advisory.candidates
      .map(normalizeAdvisorCandidate)
      .filter((candidate) => candidate && routeExists(candidate.route))
      .slice(0, 3);

    if (advisorCandidates.length === 0) {
      return {
        pendingCandidates: fallbackPendingCandidates(classification),
        advisorExplanation: null
      };
    }

    const existing = new Map(
      (classification.candidates ?? []).map((candidate) => [candidate.route, candidate])
    );
    const combined = [];
    for (const candidate of advisorCandidates) {
      combined.push({
        ...(existing.get(candidate.route) ?? {
          route: candidate.route,
          signals: [],
          count: 0,
          strongCount: 0,
          weakCount: 0,
          score: 0
        }),
        advisorReason: candidate.advisorReason
      });
    }
    for (const candidate of classification.candidates ?? []) {
      if (!combined.find((entry) => entry.route === candidate.route)) {
        combined.push(candidate);
      }
    }

    return {
      pendingCandidates: combined,
      advisorExplanation:
        typeof advisory.explanation === "string" && advisory.explanation.trim()
          ? advisory.explanation.trim()
          : null
    };
  } catch {
    return {
      pendingCandidates: fallbackPendingCandidates(classification),
      advisorExplanation: null
    };
  }
}

function buildConfirmationContext(turn, warning, advisorExplanation) {
  const candidates = Array.isArray(turn.pendingCandidates) ? turn.pendingCandidates : [];
  const candidateLines = candidates.length
    ? candidates.map((candidate) => {
        const scoreText =
          typeof candidate.score === "number" && candidate.score > 0 ? ` (score ${candidate.score})` : "";
        const reasonText = candidate.advisorReason ? ` - ${candidate.advisorReason}` : "";
        return `- ${candidate.route}${scoreText}${reasonText}`;
      })
    : ["- implement"];

  return withWarning(
    [
      `[claudsterfuck] Route confirmation required before delegation.`,
      `Preserve the original objective and do not delegate yet.`,
      `Ask the user to confirm one of these routes:`,
      ...candidateLines,
      `Preferred reply form: route:<name> (or [route:<name>])`,
      `Implicit confirmation is allowed only if the user's entire reply is exactly one candidate route name.`,
      ...(advisorExplanation ? [`Advisor note: ${advisorExplanation}`] : [])
    ],
    warning
  ).join("\n");
}

function isClarificationLikePrompt(prompt) {
  const normalized = String(prompt ?? "").trim();
  if (!normalized) {
    return false;
  }

  return /^(yes|no|use|keep|remove|add|change|focus|prioritize|option\s+\d+|1\.|2\.|3\.|my answers|answers:|here are|also|and |make it|include|plus|one more thing)/i.test(
    normalized
  );
}

function shouldContinueExistingTurn(existingTurn, classification, prompt) {
  if (!existingTurn || existingTurn.requiresDelegation === false || existingTurn.status === "cancelled") {
    return false;
  }

  if (existingTurn.awaitingConfirmation === true || existingTurn.confirmationRequired === true) {
    return false;
  }

  const phase = existingTurn.phase ?? TURN_PHASES.REFINING;
  if (![TURN_PHASES.REFINING, TURN_PHASES.REVIEWING, TURN_PHASES.READY_TO_DELEGATE].includes(phase)) {
    return false;
  }

  if (classification.route === existingTurn.route) {
    if (phase === TURN_PHASES.REVIEWING) {
      return true;
    }

    return !["low", "ambiguous"].includes(classification.confidence) || isClarificationLikePrompt(prompt);
  }

  if (phase === TURN_PHASES.REVIEWING && ["low", "ambiguous"].includes(classification.confidence)) {
    return true;
  }

  return phase === TURN_PHASES.REVIEWING && isClarificationLikePrompt(prompt) && classification.confidence !== "high";
}

function mergeObjective(existingObjective, prompt) {
  const previous = String(existingObjective ?? "").trim();
  const addition = String(prompt ?? "").trim();
  if (!previous) {
    return addition;
  }
  if (!addition) {
    return previous;
  }
  if (previous.includes(addition)) {
    return previous;
  }
  return `${previous}\n\nUser clarification:\n${addition}`;
}

function buildContinuationContext(turn, warning) {
  return buildDelegatedContext(turn, warning, [
    `Continuing the active ${turn.route} turn with new user clarification.`,
    `Stay in planning/review mode locally until you need to delegate again.`
  ]);
}

function buildSlashRouteGuidance(routeAction) {
  return [
    `[claudsterfuck] Route command detected (${routeAction}) but no objective text was provided and no active turn exists.`,
    `Add objective text after the command, for example: /claudsterfuck:${routeAction} redesign the hero section`,
    `Or start a normal message with route:${routeAction} followed by your objective.`
  ].join("\n");
}

function rerouteExistingTurn(existingTurn, routeProfile) {
  const archivedRuns = Array.isArray(existingTurn?.archivedRuns) ? [...existingTurn.archivedRuns] : [];
  const workerRuns = Array.isArray(existingTurn?.workerRuns) ? existingTurn.workerRuns : [];
  const objective = String(existingTurn?.objective ?? existingTurn?.prompt ?? "").trim();
  const requiresDelegation = Boolean(routeProfile.requiresDelegation);

  return buildTurnFromRoute({
    prompt: objective,
    objective,
    routeProfile,
    classification: buildOverrideClassification(routeProfile.route),
    extras: {
      confidence: "override",
      phase: requiresDelegation ? TURN_PHASES.REFINING : TURN_PHASES.NON_DELEGATED,
      status: requiresDelegation ? "needs-delegation" : "non-delegated",
      confirmationRequired: false,
      awaitingConfirmation: false,
      pendingObjective: null,
      pendingCandidates: [],
      pendingProvider: null,
      latestRunId: null,
      latestRunStatus: null,
      latestRunErrorSummary: null,
      workerRuns: [],
      archivedRuns: [...archivedRuns, ...workerRuns]
    }
  });
}

export function buildUserPromptDecision(input, options = {}) {
  const cwd = input.cwd || process.cwd();
  const rawPrompt = String(input.prompt ?? "");
  const sessionId = input.session_id || "";

  if (sessionId) {
    appendEnvVar(SESSION_ID_ENV, sessionId);
  }

  const existingTurn = sessionId ? getSessionRecord(cwd, sessionId)?.currentTurn ?? null : null;

  if (isSlashCommandPrompt(rawPrompt)) {
    const slash = parsePluginSlashCommand(rawPrompt);

    if (slash.isPluginCommand && routeExists(slash.action)) {
      const routeProfile = loadRouteProfile(slash.action);

      if (slash.argsText) {
        const currentTurn = buildTurnFromRoute({
          prompt: slash.argsText,
          objective: slash.argsText,
          routeProfile,
          classification: buildOverrideClassification(routeProfile.route)
        });

        if (sessionId) {
          setCurrentTurn(cwd, sessionId, currentTurn);
        }

        return {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: currentTurn.requiresDelegation
              ? buildDelegatedContext(currentTurn, null, [
                  `Forced route via slash command: ${currentTurn.route}`,
                  `Objective captured from command text.`
                ])
              : buildNonDelegatedContext(currentTurn, null, [
                  `Forced route via slash command: ${currentTurn.route}`,
                  `Objective captured from command text.`
                ])
          }
        };
      }

      if (existingTurn) {
        const currentTurn = rerouteExistingTurn(existingTurn, routeProfile);

        if (sessionId) {
          setCurrentTurn(cwd, sessionId, currentTurn);
        }

        return {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: currentTurn.requiresDelegation
              ? buildDelegatedContext(currentTurn, null, [
                  `Rerouted active turn via slash command to: ${currentTurn.route}`,
                  `Preserved objective from the active turn.`
                ])
              : buildNonDelegatedContext(currentTurn, null, [
                  `Rerouted active turn via slash command to: ${currentTurn.route}`,
                  `Preserved objective from the active turn.`
                ])
          }
        };
      }

      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: buildSlashRouteGuidance(slash.action)
        }
      };
    }

    if (sessionId && getSlashCommandAction(rawPrompt) === "reset") {
      setSessionRecord(cwd, sessionId, {
        currentTurn: null
      });
    }

    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "[claudsterfuck] Plugin slash command detected. Treat this as a control turn only. Do not delegate, implement, or continue beyond the command result."
      }
    };
  }

  const override = parseRouteDirective(rawPrompt);
  const cleanedPrompt = override.cleanedPrompt;

  if (existingTurn?.awaitingConfirmation) {
    const confirmation = resolvePendingConfirmation(existingTurn, override, cleanedPrompt);
    if (confirmation?.accepted) {
      const routeProfile = loadRouteProfile(confirmation.route);
      const restoredObjective = String(existingTurn.pendingObjective ?? existingTurn.objective ?? "").trim();
      const classification = {
        route: routeProfile.route,
        reason: confirmation.confidence === "override" ? "explicit route override" : "route confirmed by user",
        confidence: confirmation.confidence,
        matchedSignals: confirmation.matchedSignals,
        candidates: existingTurn.pendingCandidates ?? []
      };
      const currentTurn = buildTurnFromRoute({
        prompt: restoredObjective,
        objective: restoredObjective,
        routeProfile,
        classification,
        extras: {
          phase: routeProfile.requiresDelegation ? TURN_PHASES.REFINING : TURN_PHASES.NON_DELEGATED,
          confirmationRequired: false,
          awaitingConfirmation: false,
          pendingObjective: null,
          pendingCandidates: [],
          pendingProvider: null,
          latestRunId: null,
          latestRunStatus: null,
          latestRunErrorSummary: null,
          workerRuns: [],
          archivedRuns: existingTurn.archivedRuns ?? []
        }
      });

      if (sessionId) {
        setCurrentTurn(cwd, sessionId, currentTurn);
      }

      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: currentTurn.requiresDelegation
            ? buildDelegatedContext(currentTurn, null, [`Confirmed route: ${currentTurn.route}`])
            : buildNonDelegatedContext(currentTurn, null, [`Confirmed route: ${currentTurn.route}`])
        }
      };
    }
  }

  const promptClassification = suppressChatCandidate(classifyTurn(cleanedPrompt));
  const overrideConflictWarning = override.valid ? buildOverrideConflictWarning(override.route, promptClassification) : null;
  const classification = override.valid ? buildOverrideClassification(override.route) : promptClassification;
  const warning = [override.warning, overrideConflictWarning].filter(Boolean).join(" ");

  if (!override.valid && shouldContinueExistingTurn(existingTurn, classification, cleanedPrompt)) {
    const currentTurn = {
      ...existingTurn,
      prompt: cleanedPrompt,
      objective: mergeObjective(existingTurn.objective, cleanedPrompt),
      matchedSignals: classification.matchedSignals ?? existingTurn.matchedSignals,
      confidence:
        classification.route === existingTurn.route || ["low", "ambiguous"].includes(classification.confidence)
          ? existingTurn.confidence
          : classification.confidence,
      phase: TURN_PHASES.REFINING,
      status: "needs-delegation",
      confirmationRequired: false,
      awaitingConfirmation: false,
      pendingObjective: null,
      pendingCandidates: [],
      pendingProvider: null
    };

    if (sessionId) {
      setCurrentTurn(cwd, sessionId, currentTurn);
    }

    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: buildContinuationContext(currentTurn, warning)
      }
    };
  }

  const routeProfile = loadRouteProfile(classification.route);

  if (["low", "ambiguous"].includes(classification.confidence)) {
    const { pendingCandidates, advisorExplanation } = applyRouteAdvisor(cleanedPrompt, classification, options);
    const tentativeTurn = buildTurnFromRoute({
      prompt: cleanedPrompt,
      objective: cleanedPrompt,
      routeProfile,
      classification,
      extras: {
        phase: TURN_PHASES.AWAITING_USER,
        status: "needs-delegation",
        confirmationRequired: true,
        awaitingConfirmation: true,
        pendingObjective: cleanedPrompt,
        pendingCandidates,
        pendingProvider: routeProfile.defaultProvider ?? null
      }
    });

    if (sessionId) {
      setCurrentTurn(cwd, sessionId, tentativeTurn);
    }

    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: buildConfirmationContext(tentativeTurn, warning, advisorExplanation)
      }
    };
  }

  const currentTurn = buildTurnFromRoute({
    prompt: cleanedPrompt,
    objective: cleanedPrompt,
    routeProfile,
    classification
  });

  if (sessionId) {
    setCurrentTurn(cwd, sessionId, currentTurn);
  }

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: currentTurn.requiresDelegation
        ? buildDelegatedContext(currentTurn, warning)
        : buildNonDelegatedContext(currentTurn, warning)
    }
  };
}

function main() {
  emitHookJson(buildUserPromptDecision(readHookInput()));
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
