# claudsterfuck — Developer Reference

Architecture, internals, and contribution guide. Current as of v2.1.0.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Directory Layout](#directory-layout)
3. [Hook Pipeline](#hook-pipeline)
4. [Routing System](#routing-system)
5. [Orchestrator & State Machine](#orchestrator--state-machine)
6. [State Management](#state-management)
7. [Provider System](#provider-system)
8. [Event Streaming Pipeline](#event-streaming-pipeline)
9. [Statusline & Monitor Window](#statusline--monitor-window)
10. [Policy Enforcement](#policy-enforcement)
11. [Adding a New Route](#adding-a-new-route)
12. [Adding a New Provider](#adding-a-new-provider)
13. [Key Invariants & Gotchas](#key-invariants--gotchas)

---

## Architecture Overview

```
User prompt
    │
    ▼
UserPromptSubmit hook          ← classifies intent, builds turn, injects context
    │
    ├── chat / claude route (low confidence or explicit bypass)
    │       Claude answers directly, no worker
    │
    └── delegated route (high confidence or explicit override)
            │
            ▼
        Claude main thread runs Bash directly:
          orchestrator.mjs dispatch --watch --json
            │
            ▼
        orchestrator:
          • assembles worker prompt
          • spawns detached Codex/Gemini process
          • tails stdout NDJSON → updates latest-event.json
          • polls the process until exit
          • reconstructs finalOutput / providerSessionId / tokenUsage
          • writes run.json and events.jsonl
            │
            ▼
        Bash returns → Claude reviews per route's reviewDepth
```

**Control plane / execution plane split:**
- Claude is the control plane — it routes, refines, reviews, synthesizes.
- Codex and Gemini are the execution plane — they implement, debug, review, design.
- Claude never directly writes files on a routed turn. The worker process does.

**v2.0 design decision: direct Bash dispatch from the main thread.**
Previous versions spawned a thin `claudsterfuck-codex-worker` / `claudsterfuck-gemini-worker` subagent that just forwarded one Bash command to the orchestrator. Claude Code subagents don't inherit runtime-granted Bash permissions from the parent session, so that forwarder frequently stalled on permission prompts it couldn't satisfy. Collapsing dispatch into the main thread uses already-granted permissions and removes an entire failure class.

**v2.1 design decision: NDJSON event streaming.**
Both provider CLIs now run in streaming modes (`codex exec --json`, `gemini --output-format stream-json`). The orchestrator's watch loop tails the detached process's stdout file, parses each new NDJSON line, and updates `latest-event.json` per run. The statusline reads that file to render live worker progress (third line). The monitor window renders the structured event stream with icons. Telemetry cost stays low because nothing is reported back to Claude mid-turn — the Bash tool still buffers until exit, so live visibility is entirely external (statusline + monitor terminal).

---

## Directory Layout

```
.claude-plugin/
  marketplace.json           ← marketplace registration
  plugin.json                ← plugin manifest (name, version 2.1.0, repo, keywords)

commands/
  <route>.md                 ← slash command definitions (/claudsterfuck:<name>)
  dispatch.md watch.md cancel.md recover.md inspect.md result.md
  reset.md reroute.md setup.md status.md task.md delegate.md

frameworks/
  implementation/            ← worker-contract, tdd, yagni, verification, anti-patterns
  design/                    ← design-gates, alternatives-and-tradeoffs, system-boundaries
  debugging/                 ← root-cause, defense-in-depth, tracing
  review/                    ← blind-spots, ai-blind-spots, pre-mortem, inversion,
                               socratic-probing, steelman-and-verdict, review-feedback-reception
  planning/                  ← plan-rigor, task-granularity, no-placeholders

hooks/
  hooks.json                 ← hook event bindings (SessionStart / UserPromptSubmit /
                               PreToolUse / Stop)

prompts/providers/
  codex/worker-base.md       ← Codex worker task preamble (IMMUTABLE-marked sections)
  gemini/worker-base.md      ← Gemini worker task preamble

routes/
  adversarial-review.json chat.json claude.json debug.json design.json
  implement-artifact.json implement.json plan.json review-feedback.json review.json

scripts/
  orchestrator.mjs           ← main CLI: dispatch/watch/inspect/cancel/reset/recover/...
  monitor.mjs                ← live worker-status terminal window
  statusline.mjs             ← Claude Code statusLine renderer (3 lines when running)
  session-start-hook.mjs
  user-prompt-submit-hook.mjs
  pre-tool-use-hook.mjs
  stop-enforcement-hook.mjs
  openwolf-compat.mjs        ← memory packet compiler for OpenWolf integration
  orchestrator.test.mjs      ← unit + integration tests for orchestrator
  statusline-scripts.test.mjs ← statusline rendering tests

  lib/
    entrypoint.mjs           ← isDirectExecution() for ESM main-module detection
    event-stream.mjs         ← shared NDJSON recorder + summarizer (v2.1)
    hook-io.mjs              ← readHookInput(), emitHookJson(), appendEnvVar()
    policy.mjs               ← PreToolUse policy engine
    prompt-compiler.mjs      ← always-on Lite compression for worker handoff
    providers.mjs            ← Codex/Gemini binary resolution, spawn, I/O, kill
    state.mjs                ← atomic JSON, JSONL audit, session/turn/run CRUD
    string-utils.mjs         ← truncate()
    providers.test.mjs       ← provider tests (NDJSON parsing, delta accumulation)
    string-utils.test.mjs
    openwolf/compile-packet.mjs

  routing/
    classify-turn.mjs        ← ROUTE_RULES, scoreRoutes(), classifyTurn()
    assemble-worker-prompt.mjs ← builds full worker prompt from route + frameworks + memory
    lib/config.mjs           ← PROJECT_ROOT / routes / frameworks / prompts resolution

skills/
  claudsterfuck-routing/
    SKILL.md                 ← Claude's operating instructions when this plugin is active
```

There is intentionally no `agents/` directory — worker subagents were removed in v2.0.

---

## Hook Pipeline

All four hooks are registered in `hooks/hooks.json`. Each hook reads a JSON payload from stdin and writes a JSON response to stdout.

### SessionStart — `scripts/session-start-hook.mjs`

Fires when a Claude Code session opens. Binds `session_id` from the hook payload to a session record in state, then exports `CLAUDSTERFUCK_SESSION_ID` into the environment.

```
input.session_id → createOrGetSessionRecord(cwd, sessionId)
                 → appendEnvVar("CLAUDSTERFUCK_SESSION_ID", sessionId)
```

### UserPromptSubmit — `scripts/user-prompt-submit-hook.mjs`

The routing brain. Fires on every user message before Claude sees it.

**Flow:**

```
1. Parse override prefix (route:X, [route:X], or /claudsterfuck:X)
2. If bare route directive (no objective text):
     - Has active turn → rerouteExistingTurn() [carry objective forward]
     - No active turn  → buildSlashRouteGuidance() [show usage]
3. Classify prompt → classifyTurn()
4. Confidence gate:
     - high or override  → build delegated turn, inject buildDelegatedContext()
     - anything else     → build chat fallback turn, inject buildChatFallbackContext()
                          stores pendingObjective for bare route:X carry-forward
5. setCurrentTurn(cwd, sessionId, turn) → persist to state
6. Return { hookEventName, additionalContext } injected into Claude's context
```

**Key functions:**

| Function | Purpose |
|---|---|
| `classifyTurn(prompt)` | Returns `{ route, confidence, reason, candidates }` |
| `buildTurnFromRoute({ routeProfile, classification, extras })` | Constructs a normalized turn record |
| `rerouteExistingTurn(existingTurn, newRouteProfile)` | Changes route on active turn, preserving objective |
| `buildDelegatedContext(turn, warning)` | Context injected when Claude should delegate |
| `buildChatFallbackContext(turn, classification, warning)` | Context injected for chat/fallback turns |
| `buildSlashRouteGuidance(route)` | Usage message when no objective text is present |
| `applyRouteAdvisor(prompt, classification, options)` | Extension point for route suggestion logic |

### PreToolUse — `scripts/pre-tool-use-hook.mjs`

Fires before every tool call Claude makes. Delegates to `evaluatePreToolUse()` in `scripts/lib/policy.mjs`. See [Policy Enforcement](#policy-enforcement) for the full ruleset.

### Stop — `scripts/stop-enforcement-hook.mjs`

Fires when Claude is about to stop responding. Delegates to `evaluateStop()` in policy.mjs. Blocks premature stops when a routed turn is in an unfinished state (worker still running, result not yet reviewed).

---

## Routing System

### Signal Matching — `scripts/routing/classify-turn.mjs`

Routes are defined as `ROUTE_RULES` — an ordered array of objects:

```js
{
  route: "implement",
  reason: "implementation language",
  strongSignals: ["write code", "implement this", "add support"],
  weakSignals: ["implement", "build", "add", "create", "refactor", "patch"]
}
```

**Strong signals** match as substrings. **Weak signals** match as whole words (word-boundary regex). Signal matching is case-insensitive on a normalized (lowercased, whitespace-collapsed) prompt.

### Positional Scoring

Prompts are split into positional zones:

```
head = first 3 words    (or entire prompt if ≤ 5 words)
tail = last 5 words     (or entire prompt if ≤ 5 words)
```

Score per signal:

| Signal type | In head/tail | In body |
|---|---|---|
| Strong | 6 pts | 3 pts |
| Weak | 2 pts | 1 pt |

A single strong signal in head or tail scores 6 — enough for `high` confidence on its own.

### Confidence Thresholds

```
high   = strongCount >= 2  OR  score >= 6
medium = strongCount >= 1  OR  score >= 3
low    = otherwise
```

Only `high` (or explicit `override`) auto-delegates. Everything else falls back to `chat`.

### Question Detection (absolute overrides)

Applied in `classifyTurn()` before scoring:

- **Rule A:** `?` anywhere in the prompt → `{ route: "chat", confidence: "high", reason: "question-mark-detected" }`. Absolute — overrides even strong signals.
- **Rule B:** Prompt starts with a question word (`what`, `how`, `why`, `where`, `when`, `who`, `which`, `can`, `could`, `should`, `would`, `is`, `are`, `does`, `do`, `did`, `tell me`, `explain`, `walk me`, `help me understand`) AND `strongCount === 0` → chat.
- **Rule C:** Prompt begins with `!` (shell command prefix) → chat with reason `shell-command-prefix`.

### Route Reference

| Route | Default provider | writeEnabled | requiresDelegation | reviewDepth |
|---|---|---|---|---|
| `implement` | codex | true | true | test |
| `implement-artifact` | codex | true | true | test |
| `debug` | codex | true | true | test |
| `review-feedback` | codex | true | true | verify |
| `design` | gemini | false | true | trust |
| `plan` | gemini | false | true | trust |
| `review` | gemini | false | true | verify |
| `adversarial-review` | gemini | false | true | verify |
| `chat` | (none) | false | false | — |
| `claude` | (none) | true | false | — |

The `chat` route is a read-only non-delegated fallback (write tools blocked by policy). The `claude` route is an explicit bypass with full permissions — never auto-routed.

### Adding Signal Rules

To add signals to an existing route, edit the `ROUTE_RULES` entry in `classify-turn.mjs`. Rule order matters for tiebreaking (earlier = higher priority in score ties).

---

## Orchestrator & State Machine

`scripts/orchestrator.mjs` is the main CLI. All commands follow the pattern:

```
node orchestrator.mjs <command> [--flags] [--json]
```

### Commands

| Command | Description |
|---|---|
| `dispatch` | Assemble prompt, spawn provider detached, return immediately |
| `watch` | Poll a running dispatch until completion or timeout |
| `dispatch --watch` | Combined: dispatch then immediately poll (preferred path in v2.0+) |
| `inspect [--slim]` | Dump current session/turn/run state |
| `result` | Show last completed run output |
| `cancel [--run-id X]` | Kill active worker, mark run failed |
| `recover [--force-stalled]` | Scan for runs claiming `running` with dead (or stalled) processes |
| `reset [--session-id X]` | Clear all turns for a session (or all sessions) |
| `reroute --route X` | Change route on current turn |
| `setup` | Check Codex/Gemini provider availability |
| `status` | Short summary of current turn phase |

### Flags

| Flag | Effect |
|---|---|
| `--json` | Emit machine-readable JSON instead of human text |
| `--watch` | On `dispatch`, immediately poll for completion |
| `--stream` | On `watch`, emit `{type:"progress"}` NDJSON events on a 10s interval (not wired to workers by default) |
| `--objective "text"` | On `dispatch`, override the stored turn objective |
| `--dry-run` | On `dispatch`, print the assembled worker prompt without spawning |
| `--no-monitor` | On `dispatch`, skip spawning the monitor window |
| `--force-stalled` | On `recover`, kill alive processes that exceeded the stalled threshold |
| `--run-id X` | Target a specific run (cancel, watch, etc.) |
| `--route X` | On `reroute`, target route |
| `--slim` | On `inspect`, return a compact single-session snapshot |

### Turn Phase State Machine

```
                    ┌─────────────────┐
                    │  NON_DELEGATED   │  ← chat / claude routes
                    └─────────────────┘

UserPromptSubmit
        │
        ▼
    REFINING ──────────────────► READY_TO_DELEGATE
        │                               │
        │ (high confidence)             │ dispatch
        └───────────────────────────────┘
                                        │
                                        ▼
                                WORKER_RUNNING
                                        │
                              ┌─────────┴─────────┐
                              │                   │
                          completed            failed
                              │                   │
                              ▼                   ▼
                          REVIEWING         READY_TO_DELEGATE
                              │
                          (reviewed)
                              │
                              ▼
                         (next prompt)
```

`CANCELLED` is reachable from any phase via `cancel`. `AWAITING_USER` is used for explicit route confirmation flows (low-confidence turns that the user was asked to confirm).

### Dispatch Flow

```
handleDispatch(cwd, args)
  1. resolveStateCandidate(cwd) → load session + active turn
  2. loadRouteProfile(turn.route)
  3. assembleWorkerPrompt({ route, provider, workspaceRoot, objective, frameworks })
  4. Write assembled prompt to <runDir>/prompt.md
  5. Spawn provider process detached (stdout → <runDir>/stdout.raw.txt,
     stderr → <runDir>/stderr.raw.txt). Pipe assembled prompt to stdin.
  6. Write process.json (pid, startedAt, resolved command/args, stdout/stderr paths).
  7. Create initial run record (status: "running") + append to turn.workerRuns.
  8. If --watch → fall into handleWatch (below).
     If --no-monitor not set → spawn monitor.mjs in a separate visible terminal.
  9. Return the runId.
```

### Poll Flow (watch)

```
handleWatch(cwd, args)
  Loop every WATCH_POLL_INTERVAL_MS (2000ms) for up to timeoutSeconds
  (default DEFAULT_WATCH_TIMEOUT_SECONDS = 600s):
    1. tailStdoutForEvents(stdoutFile) → parse new NDJSON lines,
       write <runDir>/latest-event.json (statusline reads this).
    2. If process PID is dead:
         a. Drain any final events
         b. finalizeRun() → read stdout + (Codex) last-message.txt,
            reconstruct finalOutput + providerSessionId + tokenUsage from NDJSON,
            write run.json completion fields + result.normalized.json +
            events.jsonl + terminal latest-event.json
         c. Return result
    3. Otherwise → sleep 2s, retry
  On timeout → return a snapshot {status: "running", latestStdout, liveness}.
```

---

## State Management

`scripts/lib/state.mjs` — all state operations go through here. Current schema version is `STATE_VERSION = 4`.

### Storage Location

State lives under `${CLAUDE_PLUGIN_DATA}/state/` (persists across plugin updates). Falls back to `${os.tmpdir()}/claudsterfuck/` if the env var is not set.

State directory per workspace: `${stateRoot}/${slug}-${sha256(canonicalCwd).slice(0,16)}`. This is how two different project directories get fully isolated session/turn/run state.

Path pattern:
```
${stateDir}/
  state.json              ← all sessions for this workspace
  audit.jsonl             ← append-only JSONL audit trail
  runs/
    <runId>.json          ← per-run record (flat file, live)
    <runId>/              ← per-run artifacts directory
      prompt.md           ← assembled worker prompt
      process.json        ← pid, startedAt, resolved command/args
      stdout.raw.txt      ← detached process stdout (NDJSON from providers)
      stderr.raw.txt      ← detached process stderr
      stdout.live.txt     ← non-detached providers.mjs line tailer
      events.jsonl        ← canonical NDJSON event archive (v2.1)
      latest-event.json   ← compact summary of most recent event (v2.1)
      progress.json       ← line-count + last-line timestamp
      last-message.txt    ← Codex's --output-last-message file
      result.normalized.json  ← post-run canonical result
```

### Atomic Writes

All JSON writes use write-temp → rename:

```js
atomicWriteJson(filePath, data)
  → write to .${name}.${Date.now()}.tmp
  → fs.renameSync(tmp, target)        // atomic on same filesystem
```

### Audit Trail — `audit.jsonl`

Every significant state mutation appends a JSONL line:

| Event | Emitted when |
|---|---|
| `session-created` | First time a session_id is seen |
| `turn-created` | A new routed turn is set on a session |
| `turn-updated` | Worker run attached to a turn |
| `run-started` | Run record written in `running` state |
| `run-completed` | Run record written in `completed`/`failed` state |
| `state-saved` | Any atomic write of state.json |

Audit writes are best-effort (never throw). They are the source of truth for post-hoc debugging of stuck runs.

### Session / Turn / Run Hierarchy

```
state.json
  version: 4
  sessions: {
    [sessionId]: {
      currentTurn: Turn | null,
      updatedAt: ISO-8601
    }
  }

Turn (key fields):
  route, provider, objective, prompt
  writeEnabled, requiresDelegation
  phase, status, confidence
  latestRunId, latestRunStatus, latestRunErrorSummary
  pendingObjective           ← stored on chat fallback turns for bare route:X carry-forward
  pendingCandidates          ← alternative routes surfaced for user confirmation
  workerRuns: RunRef[]       ← last 10 runs, newest first
  archivedRuns: RunRef[]     ← older runs moved here on reroute/retry

Run (persisted to runs/<runId>.json):
  id, sessionId, route, provider
  status, startedAt, completedAt, exitCode
  objective, timeoutSeconds, artifactMode
  finalOutput
  providerSessionId          ← Codex thread_id or Gemini session_id
  tokenUsage                 ← from turn.completed / result event stats
  errorSummary
  artifacts: {
    promptFile, lastMessageFile,
    stdoutFile, stderrFile,
    liveStdoutFile, progressFile,
    eventsFile, latestEventFile,
    normalizedResultFile
  }
```

### TURN_DEFAULTS

Every turn is merged over `TURN_DEFAULTS` on read — forward-compatible with new fields. See `state.mjs:13-37` for the full default shape.

---

## Provider System

`scripts/lib/providers.mjs` — binary resolution, spawn, I/O, termination, and result reconstruction.

### Codex

- Binary resolution: `resolveCodexNativeBinary()` — finds `codex.exe` from the platform-specific optional npm package (`@openai/codex-win32-x64-msvc` etc.), bypassing the JS wrapper `bin/codex.js` (which itself re-spawns codex.exe without `windowsHide`, flashing a console window on Windows).
- Spawn args (v2.1):
  ```
  codex exec - -C <cwd>
        --skip-git-repo-check
        --sandbox <read-only|workspace-write>
        --json                                  ← NEW in v2.1
        --output-last-message <run>/last-message.txt
        [--model <m>]
  ```
- `--json` makes stdout emit NDJSON events (see [Event Streaming Pipeline](#event-streaming-pipeline)). `--output-last-message` still populates alongside `--json`.
- Stdin: full assembled prompt piped directly.
- Detached worker spawned with `windowsHide: true`.
- **Windows note:** Codex's Rust runtime spawns its own `pwsh.exe` subshells per `exec` command — these are Codex-internal and cannot be suppressed from the orchestrator.

### Gemini

- Binary resolution: `resolveGeminiNodeEntrypoint()` — direct Node.js entrypoint (pure JS CLI, no native binary).
- Spawn args (v2.1):
  ```
  gemini -p "<GEMINI_STDIN_PROMPT preamble>"
         --output-format stream-json              ← CHANGED in v2.1 (was `json`)
         --approval-mode <yolo|plan>
         [--model <m>]
  ```
- `--output-format stream-json` makes stdout emit NDJSON with `delta:true` incremental chunks, `tool_use`/`tool_result` events, and a final `result` event.
- Stdin: authoritative task prompt piped after the CLI's `-p` preamble directive.
- `GEMINI_CLI_NO_RELAUNCH=true` is always set — Gemini 0.37+ relaunches itself via `spawn(process.execPath)` by default, which throws `EPERM` in detached Windows contexts.

### Process Lifecycle (detached)

```
spawnDetachedWithFn(command, args, options)
  → resolveProviderBinary(provider) with spawn-candidate fallback chain
  → spawn(binary, args, {
       stdio: ["pipe", stdoutFd, stderrFd],  // stdout/stderr pre-opened file FDs
       detached: true,
       windowsHide: true
     })
  → pipe prompt to stdin, child.unref()
```

`requestTermination(child)`:
- Windows: `child.kill()` + `taskkill /F /T /PID <pid>`
- POSIX: `process.kill(-pid, "SIGTERM")` with single-PID fallback

### Result Reconstruction

After the process exits, the orchestrator calls provider-specific finalizers:

**`finalizeCodexResult`:**
- finalOutput: primary = `last-message.txt`; fallback = reconstructed from NDJSON (`item.completed` agent_message)
- providerSessionId: from `thread.started.thread_id` (v2.1 — was always `null` before)
- tokenUsage: from `turn.completed.usage`
- Empty-output policy: read-only routes fail on empty output; write-enabled routes (implement, debug, implement-artifact) accept empty output if exit code 0 (file changes are the output)

**`finalizeGeminiResult`:**
- finalOutput: accumulated `delta:true` chunks from assistant message events (or full `content` if a non-delta completed message landed)
- providerSessionId: from `init.session_id`
- tokenUsage: from `result.stats`
- Empty-output policy: always a failure — a successful Gemini run must produce output. (Pre-v1.3 logic incorrectly treated empty-stdout + empty-stderr as exit 0, masking silent failures like stdin-forwarding bugs.)

Both finalizers:
- Mirror raw stdout into `events.jsonl`
- Write terminal `latest-event.json` (icon ✓ or ✗, label "complete" / "failed")
- Emit `result.normalized.json`

---

## Event Streaming Pipeline

Introduced in v2.1. `scripts/lib/event-stream.mjs`.

### Wire format (per provider)

**Codex `--json`:**
```jsonc
{"type":"thread.started","thread_id":"<uuid>"}
{"type":"turn.started"}
{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}
{"type":"item.completed","item":{"type":"command_execution","exit_code":0,"status":"completed","aggregated_output":"..."}}
{"type":"item.completed","item":{"type":"agent_message","text":"<full response>"}}
{"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
```
Codex emits at item granularity (reasoning messages, tool calls, file edits) — no token-level deltas.

**Gemini `--output-format stream-json`:**
```jsonc
{"type":"init","session_id":"<uuid>","model":"<name>"}
{"type":"message","role":"user","content":"<prompt echo>"}
{"type":"message","role":"assistant","content":"chunk1 ","delta":true}
{"type":"message","role":"assistant","content":"chunk2","delta":true}
{"type":"tool_use","tool_name":"read_file","tool_id":"<id>","parameters":{...}}
{"type":"tool_result","tool_id":"<id>","status":"success","output":"..."}
{"type":"result","status":"success","stats":{"total_tokens":N,"input_tokens":N,"output_tokens":N,"duration_ms":N,"tool_calls":N,"models":{...}}}
```
Gemini emits at token granularity via `delta:true` messages.

### Event recorder API

`createEventStreamRecorder({ provider, runId, route, runArtifactsDir })` returns:

| Method | Effect |
|---|---|
| `handleLine(rawLine)` | Append raw line to events.jsonl; parse, extract per-provider state fields, write compact summary to latest-event.json |
| `finalize(status)` | Write terminal latest-event.json (✓ complete / ✗ failed) |
| `getResult()` | `{ providerSessionId, finalOutputFromEvents, tokenUsage, eventsFile, latestEventFile, eventCount, providerReportedStatus, providerReportedError }` |

Used by:
- `providers.mjs` `runCodexTask` / `runGeminiTask` (non-detached path)
- `orchestrator.mjs` watch loop (`tailStdoutForEvents`) for live updates
- `orchestrator.mjs` finalizers (via `reconstructFromNdjson`) for post-exit reconstruction

### Event summarization

`summarizeEvent(provider, event)` maps each event type to `{ icon, label, eventType }`:

| Event | Codex | Gemini |
|---|---|---|
| Session start | 🚀 starting codex | 🚀 starting <model> |
| Reasoning | 💭 thinking… / reasoning… | 💬 generating… (delta) |
| Tool call start | ⚙ exec: `<cmd>` | ⚙ `<tool>`: `<path>` |
| Tool call done | ✓ exec ok / ✗ exec fail | ✓ tool done / ✗ tool fail |
| File edit | 📝 editing/wrote `<path>` | — (via tool_use) |
| Message complete | 💬 `<first line>` | 💬 `<first line>` |
| Turn / result | 📊 turn done in=N out=N | ✓ success · tok=N |
| Terminal (finalize) | ✓ complete / ✗ failed | ✓ complete / ✗ failed |

### Where events are consumed

| Consumer | Source | Use |
|---|---|---|
| `statusline.mjs` | `<runDir>/latest-event.json` | Third line of the Claude UI statusline |
| `monitor.mjs` | `<runDir>/events.jsonl` (falls back to stdout tail) | Structured live progress terminal |
| `orchestrator.mjs` finalizers | `<runDir>/stdout.raw.txt` | Reconstruct providerSessionId, finalOutput, tokenUsage |

---

## Statusline & Monitor Window

### Statusline — `scripts/statusline.mjs`

Rendered by Claude Code from `.claude/settings.json` (`statusLine` entry points at this script). Receives a JSON payload from Claude Code every refresh.

**2-line output (default / no active run):**
```
[cf · implement]  Sonnet 4.6
██████░░░░ 60% · $1.23 · 1m 5s
```

**3-line output (worker running):**
```
[cf · implement]  Sonnet 4.6
██████░░░░ 60% · $1.23 · 1m 5s
⚙ codex: exec: npm test
```

The third line only renders when a worker-running turn has a `latest-event.json` in its run artifacts. Truncated to ~50 chars. Reads the payload's `session_id`; falls back to scanning all sessions for a worker-running turn.

### Monitor Window — `scripts/monitor.mjs`

Spawned as a separate visible terminal window on `dispatch` (unless `--no-monitor` is passed). Polls every 2s; exits on terminal status.

**Rendering:**
- Header: run ID, provider, route, status (colorized), elapsed, token usage breakdown
- Event stream: last ~18 events from `events.jsonl` rendered as `<icon> <label>` lines
- Fallback: if `events.jsonl` is missing, renders the last 25 lines of raw stdout

### Dev note

`statusline.mjs` exports `workspaceHash`, `resolveStateFileForWorkspace`, `resolveRunArtifactsDir`, `readRouteForSession`, `readActiveRunEvent`, `buildStatusLineOutput` for test reuse.

---

## Policy Enforcement

`scripts/lib/policy.mjs` — single source of truth for what Claude is allowed to do during a routed turn.

### Companion Commands

```js
const COMPANION_ACTIONS = [
  "setup", "dispatch", "watch", "status", "inspect",
  "result", "reset", "cancel", "reroute", "recover"
];
```

Any Bash command that invokes `scripts/orchestrator.mjs` with one of these actions is recognized as a companion command and allowed on routed turns. This is the primary dispatch channel for the main thread in v2.0+.

### Write tools

```js
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
```

### OpenWolf exemption

Writes to `.wolf/anatomy.md`, `.wolf/memory.md`, `.wolf/buglog.json`, `.wolf/cerebrum.md` are allowed on routed turns even when main-thread writes are otherwise denied — OpenWolf memory bookkeeping must stay functional.

### Evaluation logic (simplified)

```
evaluatePreToolUse(input, turn):
  if no current turn:
    allow Bash companion commands, else pass through
  if turn.status === "cancelled":
    pass through (respect read-only flag on non-delegated routes)
  if turn.phase === AWAITING_USER (confirmation):
    allow AskUserQuestion/Read/Glob/Grep only; deny everything else
  if turn.requiresDelegation === false:
    deny WRITE_TOOLS if !writeEnabled; else pass through
  if toolName === "AskUserQuestion" → allow (orchestration Q&A)
  if toolName === "Agent" → deny (dispatch via Bash instead — no subagent wrappers in v2.0+)
  if toolName === "Bash":
    if companion command (orchestrator.mjs <action>) → allow
    if REVIEWING + verification command (git status/diff, npm/pnpm/yarn test,
        pytest, vitest, cargo/go/dotnet/mvn/gradle test, ruff, eslint, tsc, turbo test) → allow
    else → deny
  if phase REFINING / READY_TO_DELEGATE:
    allow OpenWolf writes, allow context reads (Read/Glob/Grep/Web*),
    deny write tools
  if phase WORKER_RUNNING:
    allow Read/Glob/Grep (status inspection),
    deny all other tools (prevents duplicating worker work from the main thread)
  if phase REVIEWING:
    allow OpenWolf writes, allow context reads,
    deny write tools
  else → pass through
```

### Stop enforcement — `evaluateStop`

Blocks premature stops in these phases:
- `READY_TO_DELEGATE` (worker not yet dispatched)
- `WORKER_RUNNING` (result not yet in)
- Any phase where `latestRunStatus === "failed"` (retry or recover before stopping)

Does not block on `REFINING`, `REVIEWING`, `AWAITING_USER`, `NON_DELEGATED`, or when `stop_hook_active` is set (second-pass stop).

---

## Adding a New Route

### 1. Create `routes/<name>.json`

```json
{
  "route": "your-route",
  "description": "One-line description of what this route does.",
  "defaultProvider": "codex",
  "writeEnabled": true,
  "requiresDelegation": true,
  "requiredFrameworks": ["implementation/yagni-and-scope-control.md"],
  "routeBrief": "Short task brief shown in worker context.",
  "timeoutSeconds": 900,
  "reviewDepth": "test",
  "defaultMemoryPlan": {
    "sources": ["anatomy", "cerebrum"],
    "maxChars": 4500,
    "maxChunks": 6,
    "perSourceMaxChunks": { "anatomy": 3, "cerebrum": 3, "buglog": 1, "identity": 1 },
    "includeIdentity": false
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `route` | string | Must match filename stem |
| `defaultProvider` | `"codex"` \| `"gemini"` \| `null` | null = non-delegated |
| `writeEnabled` | boolean | If false, Write/Edit blocked by policy |
| `requiresDelegation` | boolean | If false, Claude handles turn directly |
| `requiredFrameworks` | string[] | Paths relative to `frameworks/` with extension |
| `reviewDepth` | `"verify"` \| `"test"` \| `"trust"` | Instructs Claude how intensely to review worker output |
| `timeoutSeconds` | number | Worker timeout; default 900 |
| `defaultMemoryPlan` | object | OpenWolf memory compilation plan |

### 2. Add signals to `scripts/routing/classify-turn.mjs`

Add an entry to `ROUTE_RULES`. Place it before `implement` (the last catch-all) if it should take priority:

```js
{
  route: "your-route",
  reason: "descriptive reason for logging",
  strongSignals: ["phrase that clearly means this route"],
  weakSignals: ["single-word-hint"]
}
```

### 3. Create `commands/<name>.md`

```markdown
---
description: One-line slash command description
---

Route command.

Usage:

- `/claudsterfuck:your-route <objective>` to start immediately
- `/claudsterfuck:your-route` to reroute the active turn
```

### 4. Update `skills/claudsterfuck-routing/SKILL.md`

Add the route to the Provider Choice section and any reference tables.

### 5. Validate

```bash
claude plugin validate C:/dev/claudsterfuck
node scripts/routing/classify-turn.mjs --json --prompt "your strong signal phrase"
```

---

## Adding a New Provider

Providers are pure Node.js — no subagent files needed. The main Claude thread dispatches directly to the orchestrator, which spawns whatever binary the route's `defaultProvider` points at.

### 1. Add binary resolution to `scripts/lib/providers.mjs`

Implement `resolveYourProviderBinary()` or `resolveYourProviderNodeEntrypoint()` following the Codex/Gemini patterns. Key requirements:
- Return the full path to the executable or entrypoint.
- On Windows, never go through PowerShell/cmd.exe shims if stdin piping is required (shim stdin forwarding is unreliable).
- Set any required env vars (e.g. `NO_RELAUNCH` equivalent) before spawn.

### 2. Teach `resolveWindowsCommandWithArgs` about the new command name

The resolver falls back through native binary → Node entrypoint → PowerShell shim → cmd.exe shim. Add a branch in the resolver if your provider needs a non-default order.

### 3. Add args builders + finalizer

In `scripts/orchestrator.mjs`:
- `buildYourProviderArgs(options)` — build the CLI argv, including a streaming flag if the CLI supports one.
- `finalizeYourProviderResult(cwd, runId, run, processInfo)` — post-exit result reconstruction. If the CLI emits NDJSON, reuse `reconstructFromNdjson(provider, stdoutRaw)` from `lib/event-stream.mjs`.
- Wire both into `finalizeRun` and the dispatch flow.

### 4. Support structured events (optional but recommended)

If the CLI emits NDJSON events, extend `scripts/lib/event-stream.mjs`:
- Add provider branches to `handleCodexEvent`/`handleGeminiEvent` or create `handleYourProviderEvent`.
- Add a `summarizeYourProviderEvent` case returning `{ icon, label, eventType }` for each event type.

This makes the live statusline line + monitor window work automatically for your provider.

### 5. Create `prompts/providers/<name>/worker-base.md`

Task preamble injected at the top of every prompt for this provider. Wrap immutable sections in `<!-- IMMUTABLE -->` / `<!-- /IMMUTABLE -->` markers so `prompt-compiler.mjs` preserves them through Lite compression.

### 6. Wire routes to the provider

Set `"defaultProvider": "yourprovider"` in any route JSON files that should use it.

No subagent definition needed — the main Claude thread dispatches directly via `Bash(orchestrator.mjs dispatch --watch --json)`.

---

## Key Invariants & Gotchas

**Main thread dispatches via Bash, not subagents.**
The `Agent` tool is denied on routed turns as of v2.0. If you add an integration that needs to call the orchestrator from a subagent context, it will hit permission prompts — use a new CLI entry point instead.

**Never recreate `suppressChatCandidate()`.**
It was deleted in v1.9.0. It discarded confidence and re-classified when `chat` won, causing false delegation. The routing contract is: `high` confidence only auto-delegates; everything else is chat. Don't add logic that promotes medium/low classifications.

**`process.cwd()` is the user's workspace, not the plugin root.**
Plugin files (routes, frameworks, prompts, scripts) are resolved via `import.meta.url` in `scripts/routing/lib/config.mjs` and friends. User workspace state (sessions, runs) uses `process.cwd()`. Never mix these.

**Empty provider output must fail on read-only routes.**
A provider run that exits 0 with no stdout on a non-write route (review, design, plan, adversarial-review, review-feedback when empty last-message.txt) is a failure — the provider likely crashed silently. The route's `writeEnabled` flag disambiguates the two cases.

**State is workspace-scoped.**
Two different project directories get completely isolated session/turn/run state. The workspace key is `${basename}-${sha256(canonicalCwd).slice(0,16)}`. Do not assume state from another workspace is visible.

**Bare `route:X` with no text has two sub-cases.**
Sub-case A (active turn exists): carries `pendingObjective` forward via `rerouteExistingTurn()`. Sub-case B (no active turn): returns `buildSlashRouteGuidance()`. Never build an empty-objective turn for a bare directive.

**Question mark detection is absolute.**
A `?` anywhere in the prompt routes to `chat` regardless of strong signals. This runs before scoring. Do not add conditions that bypass it.

**`CLAUDE_PLUGIN_DATA` is the persistence boundary.**
Anything that must survive a plugin update (state, audit, run artifacts, events) goes in `${CLAUDE_PLUGIN_DATA}`. The cached copy at `${CLAUDE_PLUGIN_ROOT}` is replaced on update. Do not introduce new persistent storage under `CLAUDE_PLUGIN_ROOT`.

**On Windows, never spawn CLIs through PowerShell npm shims when stdin matters.**
Shims don't forward stdin reliably and spawn a visible console. Use `resolveCodexNativeBinary()` for Codex and the Node.js entrypoint directly for Gemini. See `scripts/lib/providers.mjs`.

**Audit trail is append-only and best-effort.**
Never read `audit.jsonl` in hot paths. It's for post-hoc debugging only. Writes that fail are silently swallowed — don't rely on it for correctness.

**`DEFAULT_WATCH_TIMEOUT_SECONDS` is 600 (10 min).**
Codex real-world runs take 5–10 min. Do not lower this without testing against realistic workloads. If you change it, update `commands/watch.md` too.

**NDJSON streaming flags are load-bearing.**
`codex exec` without `--json` emits plain text that breaks the event pipeline. `gemini` with `--output-format json` (not `stream-json`) emits a single object that breaks `delta` accumulation. The finalizers and tests assume the v2.1 formats.

**Claude Code's `Bash` tool buffers stdout.**
NDJSON events emitted during `dispatch --watch` do not reach Claude mid-turn — they all arrive as a batch when the command exits. Live visibility for the user is entirely via the statusline third line and the monitor window, both of which read disk artifacts directly. Do not add a "progress to Claude's context" path under the assumption that Bash streams.
