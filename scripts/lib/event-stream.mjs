import fs from "node:fs";
import path from "node:path";

import { truncate } from "./string-utils.mjs";

const LATEST_EVENT_LABEL_MAX = 50;

export function createEventStreamRecorder({ provider, runId, route, runArtifactsDir }) {
  const eventsFile = path.join(runArtifactsDir, "events.jsonl");
  const latestEventFile = path.join(runArtifactsDir, "latest-event.json");

  let providerSessionId = null;
  let accumulatedAssistantText = "";
  let finalOutputFromEvents = null;
  let tokenUsage = null;
  let eventCount = 0;
  let providerReportedStatus = null;
  let providerReportedError = null;

  function writeLatestEvent(summary) {
    if (!summary) return;
    try {
      fs.writeFileSync(
        latestEventFile,
        `${JSON.stringify(
          {
            provider,
            runId,
            route,
            icon: summary.icon,
            label: truncate(summary.label, LATEST_EVENT_LABEL_MAX),
            eventType: summary.eventType,
            timestamp: new Date().toISOString()
          },
          null,
          2
        )}\n`,
        "utf8"
      );
    } catch {}
  }

  function appendRawLine(line) {
    try {
      fs.appendFileSync(eventsFile, `${line}\n`, "utf8");
    } catch {}
  }

  function handleCodexEvent(event) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      providerSessionId = event.thread_id;
    } else if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      finalOutputFromEvents = event.item.text.trim();
    } else if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
      tokenUsage = event.usage;
    }
  }

  function handleGeminiEvent(event) {
    if (event.type === "init" && typeof event.session_id === "string") {
      providerSessionId = event.session_id;
    } else if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
      if (event.delta === true) {
        accumulatedAssistantText += event.content;
      } else {
        accumulatedAssistantText = event.content;
      }
    } else if (event.type === "result") {
      if (typeof event.status === "string") {
        providerReportedStatus = event.status;
      }
      if (event.stats && typeof event.stats === "object") {
        tokenUsage = event.stats;
      }
      if (typeof event.error === "string") {
        providerReportedError = event.error;
      }
    }
  }

  function handleLine(rawLine) {
    const line = String(rawLine ?? "");
    if (!line) return;

    appendRawLine(line);

    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return;
    }

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (provider === "codex") {
      handleCodexEvent(event);
    } else if (provider === "gemini") {
      handleGeminiEvent(event);
    }

    eventCount += 1;
    const summary = summarizeEvent(provider, event);
    if (summary) {
      writeLatestEvent(summary);
    }
  }

  function finalize(finalStatus) {
    try {
      writeLatestEvent({
        icon: finalStatus === "completed" ? "✓" : "✗",
        label: finalStatus === "completed" ? "complete" : "failed",
        eventType: "terminal"
      });
    } catch {}
  }

  function getResult() {
    return {
      providerSessionId,
      finalOutputFromEvents: finalOutputFromEvents ?? (accumulatedAssistantText ? accumulatedAssistantText.trim() : null),
      tokenUsage,
      eventsFile: eventCount > 0 ? eventsFile : null,
      latestEventFile,
      eventCount,
      providerReportedStatus,
      providerReportedError
    };
  }

  return {
    handleLine,
    finalize,
    getResult
  };
}

export function summarizeEvent(provider, event) {
  if (!event || typeof event !== "object") return null;
  if (provider === "codex") return summarizeCodexEvent(event);
  if (provider === "gemini") return summarizeGeminiEvent(event);
  return null;
}

function summarizeCodexEvent(event) {
  switch (event.type) {
    case "thread.started":
      return { icon: "🚀", label: "starting codex", eventType: event.type };
    case "turn.started":
      return { icon: "🚀", label: "new turn", eventType: event.type };
    case "item.started": {
      const item = event.item ?? {};
      if (item.type === "command_execution") {
        const cmd = firstLine(item.command);
        return { icon: "⚙", label: `exec: ${cmd || "command"}`, eventType: event.type };
      }
      if (item.type === "agent_message") {
        return { icon: "💭", label: "thinking…", eventType: event.type };
      }
      if (item.type === "reasoning") {
        return { icon: "💭", label: "reasoning…", eventType: event.type };
      }
      if (item.type === "file_change") {
        return { icon: "📝", label: `editing ${item.path || "file"}`, eventType: event.type };
      }
      return { icon: "…", label: `item: ${item.type ?? "?"}`, eventType: event.type };
    }
    case "item.completed": {
      const item = event.item ?? {};
      if (item.type === "command_execution") {
        const ok = item.exit_code === 0;
        const status = ok ? "exec ok" : `exec fail (${item.exit_code ?? "?"})`;
        return { icon: ok ? "✓" : "✗", label: status, eventType: event.type };
      }
      if (item.type === "agent_message") {
        const text = firstLine(item.text);
        return { icon: "💬", label: text || "message", eventType: event.type };
      }
      if (item.type === "file_change") {
        return { icon: "📝", label: `wrote ${item.path || "file"}`, eventType: event.type };
      }
      if (item.type === "reasoning") {
        return { icon: "💭", label: "reasoning done", eventType: event.type };
      }
      return { icon: "✓", label: `done: ${item.type ?? "?"}`, eventType: event.type };
    }
    case "turn.completed": {
      const u = event.usage ?? {};
      const parts = [];
      if (Number.isFinite(u.input_tokens)) parts.push(`in=${u.input_tokens}`);
      if (Number.isFinite(u.output_tokens)) parts.push(`out=${u.output_tokens}`);
      return { icon: "📊", label: `turn done ${parts.join(" ")}`.trim(), eventType: event.type };
    }
    default:
      return null;
  }
}

function summarizeGeminiEvent(event) {
  switch (event.type) {
    case "init":
      return { icon: "🚀", label: `starting ${event.model || "gemini"}`, eventType: event.type };
    case "message": {
      if (event.role === "assistant") {
        if (event.delta === true) {
          return { icon: "💬", label: "generating…", eventType: event.type };
        }
        const text = firstLine(event.content);
        return { icon: "💬", label: text || "response", eventType: event.type };
      }
      if (event.role === "tool" || event.role === "function") {
        const name = event.tool || event.name || "tool";
        return { icon: "⚙", label: `tool: ${name}`, eventType: event.type };
      }
      return null;
    }
    case "tool_call":
    case "tool_use": {
      const name = event.tool_name || event.tool || event.name || "?";
      const params = event.parameters || {};
      const pathHint =
        typeof params.file_path === "string"
          ? params.file_path
          : typeof params.path === "string"
            ? params.path
            : typeof params.command === "string"
              ? firstLine(params.command)
              : "";
      const suffix = pathHint ? `: ${pathHint}` : "";
      return { icon: "⚙", label: `${name}${suffix}`, eventType: event.type };
    }
    case "tool_result": {
      const ok = event.status === "success";
      return { icon: ok ? "✓" : "✗", label: ok ? "tool done" : `tool fail`, eventType: event.type };
    }
    case "result": {
      const ok = event.status === "success";
      const tok = event.stats?.total_tokens;
      const suffix = Number.isFinite(tok) ? ` · tok=${tok}` : "";
      return { icon: ok ? "✓" : "✗", label: `${event.status}${suffix}`, eventType: event.type };
    }
    default:
      return null;
  }
}

function firstLine(s) {
  if (typeof s !== "string") return "";
  const idx = s.indexOf("\n");
  return (idx === -1 ? s : s.slice(0, idx)).trim();
}

/**
 * Parse a full NDJSON stdout buffer (from either Codex or Gemini) and reconstruct
 * the fields the finalizers need: providerSessionId, finalOutput, tokenUsage,
 * providerReportedStatus, providerReportedError.
 *
 * Used by orchestrator.mjs finalizers (reading stdout.raw.txt) and as a fallback
 * in providers.mjs when no runArtifactsDir is provided.
 */
export function reconstructFromNdjson(provider, stdout) {
  let providerSessionId = null;
  let accumulated = "";
  let completedMessage = null;
  let codexAgentMessage = null;
  let tokenUsage = null;
  let providerReportedStatus = null;
  let providerReportedError = null;

  const lines = String(stdout ?? "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (provider === "codex") {
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        providerSessionId = event.thread_id;
      } else if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        codexAgentMessage = event.item.text.trim();
      } else if (event.type === "turn.completed" && event.usage) {
        tokenUsage = event.usage;
      }
    } else if (provider === "gemini") {
      if (event.type === "init" && typeof event.session_id === "string") {
        providerSessionId = event.session_id;
      } else if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
        if (event.delta === true) {
          accumulated += event.content;
        } else {
          completedMessage = event.content;
        }
      } else if (event.type === "result") {
        if (typeof event.status === "string") providerReportedStatus = event.status;
        if (event.stats) tokenUsage = event.stats;
        if (typeof event.error === "string") providerReportedError = event.error;
      }
    }
  }

  const finalOutput =
    provider === "codex"
      ? (codexAgentMessage ?? "").trim()
      : (completedMessage ?? accumulated ?? "").trim();

  return {
    providerSessionId,
    finalOutput,
    tokenUsage,
    providerReportedStatus,
    providerReportedError
  };
}

export function readLatestEvent(runArtifactsDir) {
  const file = path.join(runArtifactsDir, "latest-event.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readEventsJsonl(runArtifactsDir, options = {}) {
  const tailLimit = Number.isFinite(options.tail) && options.tail > 0 ? options.tail : null;
  const file = path.join(runArtifactsDir, "events.jsonl");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const slice = tailLimit ? lines.slice(-tailLimit) : lines;
    const events = [];
    for (const line of slice) {
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
    return events;
  } catch {
    return [];
  }
}
