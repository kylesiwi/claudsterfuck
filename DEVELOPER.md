# claudsterfuck — Developer Reference

Architecture, internals, and contribution guide.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Directory Layout](#directory-layout)
3. [Hook Pipeline](#hook-pipeline)
4. [Routing System](#routing-system)
5. [Orchestrator & State Machine](#orchestrator--state-machine)
6. [State Management](#state-management)
7. [Provider System](#provider-system)
8. [Worker Agents](#worker-agents)
9. [Policy Enforcement](#policy-enforcement)
10. [Adding a New Route](#adding-a-new-route)
11. [Adding a New Provider](#adding-a-new-provider)
12. [Key Invariants & Gotchas](#key-invariants--gotchas)

---

## Architecture Overview

```
User prompt
    │
    ▼
UserPromptSubmit hook          ← classifies intent, builds turn, injects context
    │
    ├── chat route (low confidence / question)
    │       Claude answers directly, no worker
    │
    └── delegate route (high confidence)
            │
            ▼
        orchestrator dispatch  ← spawns provider process, writes run record
            │
            ▼
        Codex / Gemini worker  ← executes task, writes output to run artifact
            │
            ▼
        orchestrator poll      ← watches run file, returns result on completion
            │
            ▼
        Claude reviews result  ← PreToolUse hook enforces review-only constraints
```

**Control plane / execution plane split:**
- Claude is the control plane — it routes, refines, reviews, synthesizes.
- Codex and Gemini are the execution plane — they implement, debug, review, design.
- Claude never directly writes files on a routed turn. The worker does.

---

## Directory Layout

```
.claude-plugin/
  marketplace.json    ← marketplace registration (name, plugins[], source)
  plugin.json         ← plugin manifest (name, version, repository, keywords)

agents/
  claudsterfuck-codex-worker.md   ← Bash shape for Codex subagent
  claudsterfuck-gemini-worker.md  ← Bash shape for Gemini subagent

commands/
  *.md                ← slash command definitions (/claudsterfuck:<name>)

frameworks/
  implementation/     ← YAGNI, TDD, scope, verification
  design/             ← system boundaries, tradeoffs, alternatives
  debugging/          ← root cause, defense-in-depth
  review/             ← blind spots, Socratic probing, steelman
  planning/           ← no-placeholders, task granularity

hooks/
  hooks.json          ← hook event bindings (SessionStart/UserPromptSubmit/PreToolUse/Stop)

prompts/providers/
  codex/worker-base.md   ← Codex worker task preamble
  gemini/worker-base.md  ← Gemini worker task preamble

routes/
  *.json              ← route profiles

scripts/
  orchestrator.mjs    ← main CLI: dispatch, watch, inspect, cancel, reset, recover, ...
  monitor.mjs         ← live status window (spawned in a separate terminal)
  session-start-hook.mjs
  user-prompt-submit-hook.mjs
  pre-tool-use-hook.mjs
  stop-enforcement-hook.mjs
  openwolf-compat.mjs ← memory packet compiler for OpenWolf integration

  lib/
    entrypoint.mjs    ← isDirectExecution() for ESM main-module detection
    hook-io.mjs       ← readHookInput(), emitHookJson(), appendEnvVar()
    policy.mjs        ← PreToolUse policy: delegation enforcement, write-deny
    prompt-compiler.mjs  ← always-on lite compression for worker handoff
    providers.mjs     ← Codex/Gemini binary resolution, spawn, kill, I/O
    state.mjs         ← atomic JSON writes, JSONL audit, session/turn/run CRUD
    string-utils.mjs  ← truncate()

  routing/
    classify-turn.mjs        ← ROUTE_RULES, scoreRoutes(), classifyTurn()
    assemble-worker-prompt.mjs ← builds full worker prompt from route + frameworks + memory
    lib/
      config.mjs             ← PROJECT_ROOT, ROUTES_DIR, FRAMEWORKS_DIR resolution

skills/
  claudsterfuck-routing/
    SKILL.md          ← Claude's operating instructions when this plugin is active
```

---

## Hook Pipeline

All four hooks are defined in `hooks/hooks.json`. They fire in order per Claude Code's event model. Each hook reads a JSON payload from stdin and writes a JSON response to stdout.

### SessionStart — `scripts/session-start-hook.mjs`

Fires when a Claude Code session opens. Binds `session_id` from the hook input to a new session record in state, then exports `CLAUDSTERFUCK_SESSION_ID` into the environment.

```
input.session_id → createOrGetSessionRecord(cwd, sessionId)
                 → appendEnvVar("CLAUDSTERFUCK_SESSION_ID", sessionId)
```

### UserPromptSubmit — `scripts/user-prompt-submit-hook.mjs`

The routing brain. Fires on every user message before Claude sees it.

**Flow:**

```
1. Parse override prefix (route:X or /claudsterfuck:X)
2. If bare route directive (no objective text):
     - Has active turn → rerouteExistingTurn() [carry objective forward]
     - No active turn  → buildSlashRouteGuidance() [show usage]
3. Classify prompt → classifyTurn()
4. Confidence gate:
     - high or override → build delegated turn, inject buildDelegatedContext()
     - anything else    → build chat fallback turn, inject buildChatFallbackContext()
                          stores pendingObjective for bare route:X carry-forward
5. setCurrentTurn(cwd, sessionId, turn) → persist to state
6. Return { hookEventName, additionalContext } injected into Claude's context
```

**Key functions:**

| Function | Purpose |
|---|---|
| `classifyTurn(prompt)` | Returns `{ route, confidence, reason, candidates }` |
| `buildTurnFromRoute({ routeProfile, classification, extras })` | Constructs a normalized turn record |
| `rerouteExistingTurn(existingTurn, newRouteProfile)` | Changes route on an active turn, preserving objective |
| `buildDelegatedContext(turn, warning)` | Context injected when Claude should delegate |
| `buildChatFallbackContext(turn, classification, warning)` | Context injected for chat/fallback turns |
| `buildSlashRouteGuidance(route)` | Usage message when no objective is present |
| `applyRouteAdvisor(prompt, classification, options)` | Extension point for route suggestion logic |

### PreToolUse — `scripts/pre-tool-use-hook.mjs`

Fires before every tool call Claude makes. Delegates to `evaluatePreToolUse()` in `scripts/lib/policy.mjs`.

**Enforcement rules (in priority order):**

1. Worker agent tool calls are always allowed (they come from `claudsterfuck-codex-worker` / `claudsterfuck-gemini-worker`).
2. Companion commands (`inspect --slim`, `dispatch --watch`, etc.) are allowed on routed turns.
3. Turns in `worker-running` phase: block everything except companion commands.
4. Read tools (`Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`) are blocked before worker handoff on delegation turns (to prevent main-thread pre-implementation).
5. Write tools (`Write`, `Edit`, `MultiEdit`) are blocked on `requiresDelegation=false && writeEnabled=false` turns (e.g. `chat` route).
6. Write tools are blocked on reviewing/refining delegation turns.

### Stop — `scripts/stop-enforcement-hook.mjs`

Fires when Claude is about to stop responding. Blocks premature stops when a routed turn is in an unfinished state (worker still running, result not yet reviewed).

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
head = first 3 words   (or entire prompt if ≤ 5 words)
tail = last 5 words    (or entire prompt if ≤ 5 words)
```

Score per signal:

| Signal type | In head/tail | In body |
|---|---|---|
| Strong | 6 pts | 3 pts |
| Weak | 2 pts | 1 pt |

A single strong signal in the head or tail scores 6 — enough for `high` confidence on its own.

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

### Adding Signal Rules

To add signals to an existing route, edit the `ROUTE_RULES` entry in `classify-turn.mjs`. Signal order within a rule doesn't matter — all signals are evaluated against the full normalized prompt. Rule order in the array matters for tiebreaking (earlier = higher priority in score ties).

---

## Orchestrator & State Machine

`scripts/orchestrator.mjs` is the main CLI. All commands follow the pattern:

```
node orchestrator.mjs <command> [--flags] [--json]
```

### Commands

| Command | Description |
|---|---|
| `dispatch` | Build prompt, spawn provider process, write run record |
| `watch` | Poll run record until complete/failed/timeout |
| `dispatch --watch` | Combined: dispatch then immediately poll (preferred) |
| `inspect [--slim]` | Dump current session/turn/run state |
| `result` | Show last completed run output |
| `cancel [--run-id X]` | Kill active worker, mark run failed |
| `recover` | Scan for runs claiming `running` with dead processes |
| `reset [--session-id X]` | Clear all turns for a session (or all sessions) |
| `reroute --route X` | Change route on current turn |
| `setup` | Check Codex/Gemini provider availability |
| `status` | Short summary of current turn phase |

### Turn Phase State Machine

```
                    ┌─────────────────┐
                    │   NON_DELEGATED  │  ← chat/claude routes
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

`CANCELLED` is reachable from any phase via `cancel`.

### Dispatch Flow

```
handleDispatch(cwd, args)
  1. resolveStateCandidate(cwd) → load session + turn
  2. loadRouteProfile(turn.route)
  3. assembleWorkerPrompt({ route, provider, workspaceRoot, objective, frameworks })
  4. Write prompt to .tmp/.../runs/<runId>/prompt.md
  5. runProvider(provider, promptPath) → spawn Codex or Gemini process
  6. createRunRecord({ runId, pid, status: "running", ... }) → write to state
  7. Return runId immediately (process runs detached)
```

### Poll Flow (watch)

```
handleWatch(cwd, args)
  Loop every 2s for up to DEFAULT_WATCH_TIMEOUT_SECONDS (600s):
    1. readRunRecord(runId) → check status
    2. If "completed" or "failed" → return result
    3. If process PID is dead → mark failed (recover)
    4. Otherwise → sleep 2s, retry
```

---

## State Management

`scripts/lib/state.mjs` — all state operations go through here.

### Storage Location

State is stored under `${CLAUDE_PLUGIN_DATA}` (persists across plugin updates). Falls back to `os.tmpdir()/claudsterfuck` if the env var is not set.

Path pattern: `${stateDir}/state.json` and `${stateDir}/runs/<runId>/`.

`stateDir` is keyed by workspace: `${slug}-${sha256(canonicalCwd).slice(0,16)}` — so each project directory gets isolated state.

### Atomic Writes

All JSON writes use write-temp → rename:

```js
atomicWriteJson(filePath, data)
  → write to .${name}.${Date.now()}.tmp
  → fs.renameSync(tmp, target)  // atomic on same filesystem
```

### Audit Trail

Every significant state mutation appends a line to `${stateDir}/audit.jsonl`. Audit writes are best-effort (never throw). This is the source of truth for debugging stuck runs.

### Session / Turn / Run Hierarchy

```
state.json
  sessions: {
    [sessionId]: {
      currentTurn: Turn | null,
      ...
    }
  }

Turn (key fields):
  route, provider, objective, prompt
  writeEnabled, requiresDelegation
  phase, status, confidence
  latestRunId, latestRunStatus
  pendingObjective         ← stored on chat fallback turns for bare route:X carry-forward
  workerRuns: RunRef[]

runs/<runId>/
  prompt.md               ← full assembled worker prompt
  stdout.txt              ← worker output
  stderr.live.txt         ← live stderr (tailed by monitor.mjs)
  run.json                ← { runId, pid, status, route, provider, startedAt, ... }
```

### TURN_DEFAULTS

Every turn is merged over `TURN_DEFAULTS` on read — forward-compatible with new fields. See `state.mjs:13–37` for the full default shape.

---

## Provider System

`scripts/lib/providers.mjs` — binary resolution, spawn, I/O, termination.

### Codex

- Resolved via `resolveCodexNativeBinary()` — finds `codex.exe` from the platform-specific optional npm package (`@openai/codex-win32-x64-msvc` etc.), bypassing the JS wrapper `bin/codex.js`.
- Spawned with `windowsHide: true` to suppress the console window.
- Stdin: full prompt piped directly. Codex reads the prompt and acts.
- **Windows note:** Codex's Rust runtime spawns its own `pwsh.exe` subshells per `exec` command — these are Codex-internal and cannot be suppressed from the orchestrator.

### Gemini

- Resolved to the Node.js entrypoint (pure JS CLI, no native binary).
- Stdin: prompted with `"Read the complete task instructions from stdin and follow them exactly."` followed by the full prompt.
- `GEMINI_CLI_NO_RELAUNCH=true` is always set — Gemini 0.37+ relaunches itself via `spawn(process.execPath)` by default, which throws `EPERM` in detached Windows contexts.

### Process Lifecycle

```
spawnProvider(provider, promptPath, options)
  → resolveProviderBinary(provider)
  → spawn(binary, args, { stdio: ["pipe","pipe","pipe"], windowsHide: true, detached: true })
  → pipe prompt to stdin
  → onceFinished(child, { timeoutMs }) → Promise<{ stdout, stderr, exitCode }>
```

`requestTermination(child)`:
- Windows: `child.kill()` + `taskkill /F /T /PID <pid>`
- POSIX: `process.kill(-pid, "SIGTERM")` (kills process group) with single-PID fallback

**Empty output rule:**
- Write-enabled routes (`implement`, `debug`, `implement-artifact`): empty stdout is valid if exit code 0 (file changes are the output).
- Read-only routes (`review-feedback`, `review`, `design`, `plan`): empty stdout = failure regardless of exit code.

---

## Worker Agents

`agents/claudsterfuck-codex-worker.md` and `agents/claudsterfuck-gemini-worker.md` are Claude Code subagent definitions (Bash shapes). They are thin forwarders — their job is to compile the active route's framework packs and call the orchestrator.

```bash
# Inside the worker agent Bash shape:
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json
```

The worker agent runs in the same Claude Code session as the main thread, inheriting `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDSTERFUCK_SESSION_ID}`. It does not implement anything itself — it delegates to Codex or Gemini and returns the result.

---

## Policy Enforcement

`scripts/lib/policy.mjs` — single source of truth for what Claude is allowed to do during a routed turn.

### WORKER_AGENT_TYPES

```js
export const WORKER_AGENT_TYPES = new Set([
  "claudsterfuck-codex-worker",
  "claudsterfuck-gemini-worker"
]);
```

Tool calls from these agents bypass all policy checks — they are the execution plane and have full permissions.

### WRITE_TOOLS

```js
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
```

### Evaluation Logic (simplified)

```
evaluatePreToolUse(input):
  actor = resolve actor from input (worker agent vs Claude)
  if actor is worker agent → allow
  if no current turn → allow (unrouted session)
  if turn.status === "cancelled" → allow
  if turn.requiresDelegation === false:
    if !turn.writeEnabled && WRITE_TOOLS.has(toolName) → deny (read-only route)
    else → allow
  if turn.phase === WORKER_RUNNING:
    if isAllowedCompanionCommand(toolName, input) → allow
    else → deny
  if isWriteTool and phase is REFINING/REVIEWING → deny
  if isReadTool and phase is pre-handoff → deny
  else → allow
```

### OpenWolf Write Target

`resolveOpenWolfWritableTarget()` allows writes to `.wolf/` files from Claude's main thread — OpenWolf memory files (anatomy, cerebrum, memory) are exempted from the write-deny rules so Claude can maintain project context without triggering policy blocks.

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
  "requiredFrameworks": ["implementation/yagni-and-scope-control"],
  "routeBrief": "Short task brief shown in worker context.",
  "timeoutSeconds": 900,
  "reviewDepth": "test"
}
```

**Field reference:**

| Field | Type | Notes |
|---|---|---|
| `route` | string | Must match filename stem |
| `defaultProvider` | `"codex"` \| `"gemini"` \| `null` | null = non-delegated |
| `writeEnabled` | boolean | If false, Write/Edit blocked by policy |
| `requiresDelegation` | boolean | If false, Claude handles turn directly |
| `requiredFrameworks` | string[] | Paths relative to `frameworks/` (no extension) |
| `reviewDepth` | `"verify"` \| `"test"` \| `"trust"` | Instructs Claude on review intensity |
| `timeoutSeconds` | number | Worker timeout; default 900 |

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

Add the route to the Worker Choice section and Route Reference table.

### 5. Validate

```bash
claude plugin validate C:/dev/claudsterfuck
node scripts/routing/classify-turn.mjs --json --prompt "your strong signal phrase"
```

---

## Adding a New Provider

### 1. Add binary resolution to `scripts/lib/providers.mjs`

Implement `resolveYourProviderBinary()` following the Codex/Gemini patterns. Key requirements:
- Return the full path to the executable or entrypoint.
- Never use npm shims on Windows when stdin piping is required.
- Set any required env vars (e.g. `NO_RELAUNCH` equivalent) before spawn.

### 2. Add spawn logic to `spawnProvider()`

Add a branch for the new provider name. Handle:
- stdin format (does it read from stdin? does it need a prefix message?)
- `windowsHide: true` on all spawned processes
- Empty output policy (write-enabled vs read-only)

### 3. Create `agents/<name>-worker.md`

Follow the pattern of `claudsterfuck-codex-worker.md`. The Bash shape should call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" dispatch --watch --json
```

### 4. Add to `WORKER_AGENT_TYPES` in `scripts/lib/policy.mjs`

```js
export const WORKER_AGENT_TYPES = new Set([
  "claudsterfuck-codex-worker",
  "claudsterfuck-gemini-worker",
  "claudsterfuck-yourprovider-worker"   // add here
]);
```

### 5. Create `prompts/providers/<name>/worker-base.md`

Task preamble injected at the top of every prompt for this provider.

### 6. Wire routes to the provider

Set `"defaultProvider": "yourprovider"` in any route JSON files that should use it.

---

## Key Invariants & Gotchas

**Never recreate `suppressChatCandidate()`.**
It was deleted in v1.9.0. It discarded confidence and re-classified when `chat` won, causing false delegation. The routing contract is now: `high` confidence only; everything else is chat. Don't add logic that promotes medium/low classifications.

**`process.cwd()` is the user's workspace, not the plugin root.**
Plugin files (routes, frameworks, prompts) are resolved via `import.meta.url` in `scripts/routing/lib/config.mjs`. User workspace state (sessions, runs) uses `process.cwd()`. Never mix these.

**Empty provider output must fail on read-only routes.**
A provider run that exits 0 with no stdout on a non-write route (review, design, plan) is a failure — the provider likely crashed silently. The `WRITE_ROUTES` set in `providers.mjs` distinguishes the two cases.

**State is workspace-scoped.**
Two different project directories get completely isolated session/turn/run state. The workspace key is `${basename}-${sha256(canonicalCwd).slice(0,16)}`.

**Bare `route:X` with no text has two sub-cases.**
Sub-case A (active turn exists): carries `pendingObjective` forward via `rerouteExistingTurn()`. Sub-case B (no active turn): returns `buildSlashRouteGuidance()`. Never build an empty-objective turn for a bare directive.

**Question mark detection is absolute.**
A `?` anywhere in the prompt routes to `chat` regardless of strong signals. This runs before scoring. Do not add conditions that bypass it.

**`CLAUDE_PLUGIN_DATA` is the persistence boundary.**
Anything that must survive a plugin update (node_modules if added, user config) goes in `${CLAUDE_PLUGIN_DATA}`. The cached copy at `${CLAUDE_PLUGIN_ROOT}` is replaced on update. State already uses `CLAUDE_PLUGIN_DATA`; don't introduce new persistent storage under `CLAUDE_PLUGIN_ROOT`.

**On Windows, never spawn CLIs through PowerShell npm shims.**
Shims don't support stdin piping reliably and spawn a visible console. Use `resolveCodexNativeBinary()` for Codex and the Node.js entrypoint directly for Gemini. See `scripts/lib/providers.mjs`.

**Audit trail is append-only and best-effort.**
Never read `audit.jsonl` in hot paths. It's for post-hoc debugging only. Writes that fail are silently swallowed — don't rely on it for correctness.

**`DEFAULT_WATCH_TIMEOUT_SECONDS` is 600 (10 min).**
Codex real-world runs take 5–10 min. Do not lower this without testing against realistic workloads. If you change it, update `commands/watch.md` too.
