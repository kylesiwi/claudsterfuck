// Default equivalence classes for vocabulary expansion.
//
// Each key → [...synonyms] array defines a bidirectional equivalence class.
// If any term in the class appears in the user's objective, every term in the
// class becomes a matching keyword for substring search against anatomy /
// cerebrum chunks. This bridges the vocabulary gap between user prose
// ("model", "config", "spawn a worker") and the codebase's own vernacular
// ("provider", "settings", "detached process").
//
// Routes can extend or override these via their own `vocabulary` field in
// routes/<name>.json. Route-level buckets merge with defaults on a key-by-key
// basis: a route key wins if both define the same key.
//
// Curation principles:
// - Keep classes tight. Overly-broad classes flood matches and produce
//   noise (e.g. don't put "file" and "module" in the same class — too generic).
// - Include both user-facing and implementation-facing terms. Users talk
//   about "models" but the code says "providers"; users say "CLI" but the
//   code says "orchestrator"/"dispatch"/"args".
// - Include plural/singular pairs when they carry meaning. The tokenizer
//   already lowercases, so case doesn't matter.
// - Include file-name stems (e.g. "policy" for policy.mjs) so that a file
//   name alone anchors a class.

export const DEFAULT_VOCABULARY = Object.freeze({
  // Core plugin control plane
  dispatch: ["orchestrator", "spawn", "worker", "runtime", "detached", "handleDispatch"],
  orchestrator: ["dispatch", "watch", "finalize", "cancel", "recover", "worker", "runtime"],
  watch: ["poll", "polling", "heartbeat", "progress", "monitor"],
  finalize: ["completion", "completed", "exit", "result", "normalized"],
  worker: ["dispatch", "orchestrator", "codex", "gemini", "subagent", "detached"],

  // Providers / models
  provider: ["codex", "gemini", "model", "binary", "backend", "llm"],
  model: ["provider", "codex", "gemini", "binary", "backend", "llm"],
  codex: ["provider", "openai", "gpt", "last-message", "windows-native"],
  gemini: ["provider", "google", "stream-json", "delta", "gemini-cli"],
  binary: ["provider", "executable", "spawn", "path-resolution", "resolveCodexNativeBinary"],

  // Routing system
  route: ["routing", "classify", "rule", "profile", "confidence", "router"],
  routing: ["route", "classify", "rule", "profile", "confidence", "router"],
  classify: ["route", "routing", "rule", "signal", "score", "confidence"],
  rule: ["signal", "classify", "route", "confidence", "ROUTE_RULES"],

  // Hooks
  hook: ["session-start", "user-prompt-submit", "pre-tool-use", "stop", "hooks.json"],
  hooks: ["session-start", "user-prompt-submit", "pre-tool-use", "stop", "hooks.json"],
  userpromptsubmit: ["hook", "routing", "classify", "turn", "additionalContext"],
  pretooluse: ["hook", "policy", "permission", "allow", "deny"],
  sessionstart: ["hook", "session", "binding"],

  // Policy / permissions
  policy: ["permission", "allow", "deny", "block", "WRITE_TOOLS", "COMPANION_ACTIONS"],
  permission: ["policy", "allow", "deny", "block", "writeEnabled"],
  allow: ["policy", "permission"],
  deny: ["policy", "permission", "block"],

  // State machine
  state: ["session", "turn", "run", "phase", "STATE_VERSION", "audit"],
  session: ["state", "turn", "sessionId", "CLAUDSTERFUCK_SESSION_ID"],
  turn: ["state", "session", "phase", "REFINING", "WORKER_RUNNING"],
  run: ["state", "turn", "runId", "artifacts", "workerRuns"],
  phase: ["state", "turn", "REFINING", "WORKER_RUNNING", "REVIEWING"],

  // Memory / OpenWolf
  memory: ["anatomy", "cerebrum", "buglog", "wolf", "openwolf", "packet", "compile"],
  anatomy: ["memory", "wolf", "openwolf", "index", "descriptions", "chunk"],
  cerebrum: ["memory", "wolf", "openwolf", "learnings", "do-not-repeat", "decision-log"],
  buglog: ["memory", "wolf", "openwolf", "errors", "fixes", "known-failure"],
  packet: ["memory", "compile", "anatomy", "cerebrum", "score", "chunks"],
  compile: ["packet", "memory", "score", "chunks", "sanitize"],

  // Events / streaming
  event: ["stream", "ndjson", "jsonl", "delta", "tool_use", "tool_result"],
  events: ["stream", "ndjson", "jsonl", "delta", "tool_use", "tool_result"],
  stream: ["event", "ndjson", "jsonl", "delta", "streaming"],
  ndjson: ["stream", "jsonl", "delta", "event", "tool_use"],

  // Config surfaces
  config: ["settings", "configuration", "options", "params", "profile"],
  settings: ["config", "configuration", "options", "params", "profile"],
  cli: ["orchestrator", "command", "argv", "flag", "parseArgs", "dispatch"],
  flag: ["cli", "argv", "option", "parseArgs"],
  argv: ["cli", "flag", "parseArgs"],

  // Spawning / processes
  spawn: ["detached", "process", "fork", "exec", "pid", "child"],
  spawning: ["spawn", "detached", "process", "fork", "exec", "pid", "child"],
  process: ["spawn", "detached", "pid", "child", "kill", "taskkill"],
  detached: ["spawn", "process", "pid", "windowsHide", "unref"],
  pid: ["spawn", "process", "detached", "kill"],
  windows: ["windowsHide", "pwsh", "powershell", "taskkill", "EPERM", "spawn"],

  // Tests
  test: ["assert", "spec", "mock", "stub", "fixture", "createTestEnv"],
  tests: ["assert", "spec", "mock", "stub", "fixture", "createTestEnv"],
  mock: ["test", "stub", "fixture", "assert"],

  // Miscellaneous plumbing
  artifacts: ["run", "run-artifacts", "prompt.md", "stdout", "events.jsonl"],
  prompt: ["artifacts", "assemble", "template", "compile"],
  timeout: ["watch", "DEFAULT_WATCH_TIMEOUT_SECONDS", "stalled"],
  token: ["usage", "tokenUsage", "input_tokens", "output_tokens", "cached"],
  tokens: ["usage", "tokenUsage", "input_tokens", "output_tokens", "cached"]
});
