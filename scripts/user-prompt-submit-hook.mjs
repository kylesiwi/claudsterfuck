#!/usr/bin/env node

import process from "node:process";

import { classifyCandidates, classifyTurn } from "./routing/classify-turn.mjs";
import { isDirectExecution } from "./lib/entrypoint.mjs";
import { appendEnvVar, emitHookJson, readHookInput, SESSION_ID_ENV } from "./lib/hook-io.mjs";
import { buildEnrichmentReminder } from "./lib/openwolf/enrichment-reminder.mjs";
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

function clipText(value, maxChars) {
  const str = String(value ?? "").trim();
  if (str.length <= maxChars) return str;
  return `${str.slice(0, maxChars - 1)}…`;
}

/**
 * R6: surface the prior turn's objective (or pendingObjective for chat-fallback
 * turns) so Claude can decide whether the user's new prompt continues the prior
 * thread or starts fresh. Returns a 3-line block or [] when no prior context.
 */
function buildPriorContextLines(priorTurn) {
  if (!priorTurn) return [];
  const priorObjective = String(priorTurn.objective ?? priorTurn.pendingObjective ?? "").trim();
  if (!priorObjective) return [];
  return [
    `Prior turn objective: "${clipText(priorObjective, 300)}"`,
    `Prior route: ${priorTurn.route ?? "?"} (phase: ${priorTurn.phase ?? "?"})`,
    `Continuation inference: if the new user prompt continues, clarifies, or confirms the prior objective, use the prior objective as the basis for the new delegation. If the prompt introduces a new topic, treat it as fresh.`
  ];
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

function buildDelegatedContext(turn, warning, extraLines = [], priorTurn = null) {
  const priorLines = buildPriorContextLines(priorTurn);
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
      `Dispatch shortcut: use 'dispatch --watch --json' to dispatch and poll in a single command.`,
      `User escape hatches (relay if asked): /claudsterfuck:cancel (stop) · /claudsterfuck:<route> (switch, keeps objective) · route:chat (pause delegation) · route:claude (bypass plugin)`,
      ...priorLines,
      ...extraLines,
      `Main-thread rule: plan, delegate, review, and synthesize. Do not implement directly in Claude's main thread.`
    ],
    warning
  ).join("\n");
}

function buildNonDelegatedContext(turn, warning, extraLines = [], priorTurn = null) {
  const priorLines = buildPriorContextLines(priorTurn);
  return withWarning(
    [
      `[claudsterfuck] Non-delegated turn. You may read, explain, and discuss freely. No worker delegation is required for this turn.`,
      `Classified route: ${turn.route}`,
      ...priorLines,
      ...extraLines
    ],
    warning
  ).join("\n");
}

function buildChatFallbackContext(turn, classification, warning, priorTurn = null) {
  const lines = [
    `[claudsterfuck] Routing to chat — confidence too low for automatic delegation (${classification.confidence}).`,
    `Classified route: ${turn.route}`,
    `This is a read-only turn. Answer the user's question or request, then suggest a route if it seems useful.`
  ];

  const delegationCandidates = (classification.candidates ?? [])
    .filter((c) => c.route !== "chat")
    .slice(0, 2);

  if (delegationCandidates.length > 0) {
    const names = delegationCandidates.map((c) => c.route).join(", ");
    lines.push(`Likely delegation routes if user wants action: ${names}`);
    lines.push(`User can confirm intent with: route:<name> or /claudsterfuck:<name>`);
    lines.push(`The objective has been stored and will carry forward if the user provides a bare route override.`);
  }

  const priorLines = buildPriorContextLines(priorTurn);
  if (priorLines.length > 0) {
    lines.push(...priorLines);
  }

  return withWarning(lines, warning).join("\n");
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

  const promptClassification = classifyTurn(cleanedPrompt);
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

  // Bare route directive (no objective text): match slash-command behavior exactly.
  if (override.valid && !cleanedPrompt) {
    if (existingTurn) {
      // Sub-case A: carry objective from prior turn (mirrors /claudsterfuck:X with active turn)
      const rerouted = rerouteExistingTurn(existingTurn, routeProfile);
      if (sessionId) {
        setCurrentTurn(cwd, sessionId, rerouted);
      }
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: rerouted.requiresDelegation
            ? buildDelegatedContext(rerouted, null, [
                `Rerouted active turn via route directive to: ${rerouted.route}`,
                `Preserved objective from the active turn.`
              ])
            : buildNonDelegatedContext(rerouted, null, [
                `Rerouted active turn via route directive to: ${rerouted.route}`,
                `Preserved objective from the active turn.`
              ])
        }
      };
    }
    // Sub-case B: no active turn, no text — mirror slash command guidance
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: buildSlashRouteGuidance(override.route)
      }
    };
  }

  // Only high confidence or explicit override auto-delegates.
  // Everything else routes to chat so Claude can ask the user what they want.
  if (classification.confidence !== "high" && classification.confidence !== "override") {
    const chatProfile = loadRouteProfile("chat");
    const { pendingCandidates, advisorExplanation } = applyRouteAdvisor(cleanedPrompt, classification, options);
    const chatTurn = buildTurnFromRoute({
      prompt: cleanedPrompt,
      objective: cleanedPrompt,
      routeProfile: chatProfile,
      classification,
      extras: {
        phase: TURN_PHASES.NON_DELEGATED,
        status: "non-delegated",
        confirmationRequired: false,
        awaitingConfirmation: false,
        pendingObjective: cleanedPrompt,
        pendingCandidates,
        pendingProvider: null
      }
    });

    if (sessionId) {
      setCurrentTurn(cwd, sessionId, chatTurn);
    }

    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: buildChatFallbackContext(chatTurn, classification, warning, existingTurn)
      }
    };
  }

  // High confidence or explicit override: route to the classified/overridden destination.
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
        ? buildDelegatedContext(currentTurn, warning, [], existingTurn)
        : buildNonDelegatedContext(currentTurn, warning, [], existingTurn)
    }
  };
}

// Append an enrichment-memory reminder (and optionally trigger background
// enrichment) onto whatever additionalContext the core hook decision built.
// Skip entirely when the current turn IS the enrichmemory housekeeping turn
// (to avoid recursion and to let the user run it uninterrupted).
function augmentWithEnrichmentReminder(decision, rawInput) {
  try {
    const prompt = String(rawInput?.prompt ?? "");
    const mentionsEnrichMemory =
      /^\s*\/claudsterfuck:enrichmemory\b/i.test(prompt) ||
      /^\s*\[?route:enrichmemory\]?\b/i.test(prompt);
    if (mentionsEnrichMemory) return decision;

    const cwd = rawInput?.cwd || process.cwd();
    const { reminder } = buildEnrichmentReminder(cwd);
    if (!reminder) return decision;

    const existing = decision?.hookSpecificOutput?.additionalContext ?? "";
    const separator = existing.endsWith("\n") ? "" : "\n";
    return {
      ...decision,
      hookSpecificOutput: {
        ...(decision?.hookSpecificOutput ?? { hookEventName: "UserPromptSubmit" }),
        additionalContext: existing ? `${existing}${separator}${reminder}` : reminder
      }
    };
  } catch {
    return decision;
  }
}

function main() {
  const rawInput = readHookInput();
  const decision = buildUserPromptDecision(rawInput);
  emitHookJson(augmentWithEnrichmentReminder(decision, rawInput));
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
