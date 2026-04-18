# claudsterfuck

A Claude Code plugin for deterministic multi-provider orchestration. Routes your prompts to Codex or Gemini workers based on intent — implementation tasks go to Codex, design/review tasks go to Gemini — with automatic delegation, live NDJSON event streaming into the Claude statusline and a separate monitor window, and dispatch+poll execution so Claude stays in control the whole time.

## Requirements

- [Claude Code](https://claude.ai/code)
- [OpenWolf](https://github.com/cytostack/openwolf) — Claude Code context management system (required; provides `.wolf/` memory, anatomy, and cerebrum files)
- [Codex CLI](https://github.com/openai/codex) — `npm install -g @openai/codex` — for implementation/debug routes
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `npm install -g @google/gemini-cli` — for design/review/plan routes

> Both CLIs use OAuth. Log in to each before use (`codex auth login`, `gemini auth login`). No API keys required.

> **Windows note:** Codex CLI spawns PowerShell subshells internally on Windows. This is expected behavior; the orchestrator hides the root `codex.exe` window but Codex's own exec subshells may be visible briefly during runs.

## Installation

### 1. Add the marketplace

```bash
claude plugin marketplace add kylesiwi/claudsterfuck
```

### 2. Enable the plugin

```bash
claude plugin enable claudsterfuck
```

### 3. Install OpenWolf

Follow the [OpenWolf setup instructions](https://github.com/cytostack/openwolf) to initialize the `.wolf/` directory in your project. OpenWolf provides the context memory system that claudsterfuck depends on.

### 4. Log in to Codex and Gemini

```bash
codex auth login
gemini auth login
```

### 5. Verify providers

In any Claude Code session, run:

```
/claudsterfuck:setup
```

This checks that both CLIs are available and reports which binaries were resolved.

## Usage

Just write naturally. The plugin classifies your prompt (keyword heuristics with positional weighting + first-word intent boost, falling back to chat for low-confidence prompts) and routes it:

```
write a retry wrapper around the fetch calls in api.ts
```
→ auto-routes to `implement`, dispatches Codex

```
what's the best approach for handling rate limits?
```
→ routes to `chat` (question detected), Claude answers and suggests `route:design` if useful

To force a route, you can either use slash commands or the route:X keyword:

```
route:implement Build the backend for the payment system
/claudsterfuck:implement add retry logic to api.ts
```

Note that if you force the route without any other parameters, it will use the stored objective from the prior chat turn. Example of a multi-turn conversation:
```
>>> route:chat What are some payment system alternatives for my site? I'm based in Chile.
- (Claude replies normally with information)
>>> route:design
- (Claude keeps the objective you mentioned in your last turn and now routes it to "design"; i.e. Gemini)
```

## Routes

The plugin works via an internal routing system.
Natural language user prompts are first deterministically checked for intent (keyword heuristics with weighted positioning). If keywords strongly match to a route, that route is selected.
If the system doesn't have high enough confidence that it understood the user's request, then Claude will prompt the user to choose the most likely route according to keywords + simple intent inferencing.

In summary, routing is automatic: high-confidence prompts delegate immediately; everything else falls back to `chat` where Claude answers and suggests a route.

You can either let the system guide you, or DIRECTLY use the routes and bypass detection. To directly call a route, either use slash commands OR the special sentinel keyword:
```
/claudsterfuck:design I am thinking about adding a payment system to the website in this workspace
```
```
route:design I am thinking about adding a payment system to the website in this workspace
```
Both of these have the exact same effect.

* Route list

Main routes (normally used in sequence):
| Route | Provider | Description |
|---|---|---|
| `design` | Gemini | Architecture and design exploration |
| `plan` | Gemini | Implementation planning |
| `implement` | Codex | Write or modify code |

Secondary routes:
| Route | Provider | Description |
|---|---|---|
| `review` | Gemini | Code review |
| `debug` | Codex | Diagnose and fix a bug |
| `implement-artifact` | Codex | Generate a large standalone file (HTML, dashboard, etc.) |
| `review-feedback` | Codex | Apply review feedback |
| `adversarial-review` | Gemini | Devil's advocate critique |

SPECIAL ROUTES
These routes bypass using other workers (Gemini/Codex) and let you talk directly to Claude.
| Route | Provider | Description |
|---|---|---|
| `chat` | Claude | Read-only fallback (default for low-confidence prompts) |
| `claude` | Claude | Explicit full-permissions bypass, never auto-routed |
| `enrichmemory` | Claude | Housekeeping — refreshes the memory-packet corpus enrichment (see *Memory-Packet Retrieval* below) |
| `monitor` | Claude | Housekeeping — opens the persistent monitor window (see *Live Visibility* above) |

- Use "chat" when you just want Claude's advice but you DON'T want Claude to just start coding on its own (which it tends to do unprompted in normal Claude Code sessions, as you might have unfortunately found out). This route is READ-ONLY; Claude has NO write permissions.
- Use "claude" when you want the normal Claude Code experience; it has full permissions and basically "skips" the plugin
- Use "enrichmemory" (or `/claudsterfuck:enrichmemory`) when the retrieval layer asks for a refresh. It spawns one-shot Haiku calls to enrich file descriptions in `.wolf/anatomy.md`. Cache is content-hash-keyed so warm runs are instant.

Even though these special routes are "free chat", they do NOT break the plugin's internals because they preserve run state and objectives (e.g. if you state you want to build a website and then use route:chat to ask Claude clarifying questions, the next time you use route:design it should automatically go back to the website building task and not break the plugin flow).




## Commands

| Command | Description |
|---|---|
| `/claudsterfuck:setup` | Check provider availability |
| `/claudsterfuck:status` | Show current turn status |
| `/claudsterfuck:inspect` | Show full session state (diagnostics) |
| `/claudsterfuck:dispatch` | Manually dispatch to the active route |
| `/claudsterfuck:watch` | Poll for a running worker result |
| `/claudsterfuck:cancel` | Cancel the active run |
| `/claudsterfuck:reset` | Clear all session state |
| `/claudsterfuck:recover` | Mark dead workers as failed |
| `/claudsterfuck:result` | Show the last completed run result |
| `/claudsterfuck:reroute` | Change route on the active turn |
| `/claudsterfuck:usage` | Token totals for the current session + workspace, by provider and route |
| `/claudsterfuck:second-opinion` | Silently run a cross-provider review of the last completed run (Codex ↔ Gemini) and return both outputs side-by-side |
| `/claudsterfuck:enrichmemory` | Rebuild the memory-packet corpus enrichment (headless Haiku summaries, auto-prune, batched calls). Progress reflected in the monitor daemon window when open |
| `/claudsterfuck:monitor` | Open the persistent per-session monitor window (idle/enriching/dispatch/reviewing views). Idempotent; safe to re-run |

## Live Visibility

While a worker runs, you get progress on two surfaces without the main Claude thread burning any tokens on telemetry:

- **Statusline third line** in the Claude Code UI shows the most recent worker event — e.g. `⚙ codex: exec: npm test` or `💬 gemini: generating…`. Updates every ~2 seconds.
- **Monitor daemon window** (optional; opened via `/claudsterfuck:monitor`). A single persistent per-session PowerShell window that stays open across turns and rotates between views based on current activity: idle / enriching / dispatch / reviewing. Safe to close any time; reopen with the same slash command.

The monitor daemon reads the same NDJSON event streams emitted natively by the provider CLIs (`codex exec --json`, `gemini --output-format stream-json`). Events are archived per run in `events.jsonl` under `${CLAUDE_PLUGIN_DATA}/state/<workspace>/runs/<runId>/` for post-hoc inspection.

Per-run popups are intentionally **not** spawned — dispatch and enrichment both run headless with full correctness. The monitor is purely a visualization layer the user opts into. If the monitor isn't open, the statusline third line and `events.jsonl` still provide everything needed.

For long-running tasks, Claude can poll a lightweight heartbeat endpoint (`watch --heartbeat --json`, ~50 tokens) to confirm a worker is still making progress without burning tokens on a full watch payload.

## Memory-Packet Retrieval

Each worker dispatch receives a compiled "memory packet" — a small bundle of relevant file descriptions and prior learnings pulled from `.wolf/anatomy.md` and `.wolf/cerebrum.md`. The compiler keeps packets tight (1800-2700 chars per route) while surfacing the files a worker is actually likely to need, instead of forcing the worker to grep the codebase from scratch.

What the compiler does:

- **Aggressive stopword filtering** on the user's objective, so instruction-framing words ("look into what are the possible approaches…") don't crowd out topical nouns.
- **Vocabulary expansion** bridges user prose to codebase vernacular (e.g. `model → provider, codex, gemini, binary, backend`). Routes can extend the default vocabulary via an optional `vocabulary` field in their JSON profile.
- **Per-bullet cerebrum chunking** makes individual learnings independently selectable (a single "Do-Not-Repeat" entry can surface on its own instead of the whole section).
- **Interleaved source selection** preserves diversity under tight budgets — anatomy and cerebrum chunks alternate so the trimmer can't starve one source.
- **Size-ranked fallback** when nothing matches — biases toward architecturally heavy files by their anatomy `(~N tok)` annotation.
- **Quality telemetry** on every run: `memoryQuality` (score, fallback usage, distinct sources) and `packetVsReads` (how much of the packet the worker actually used) are persisted on the run record for post-hoc analysis and future learning.

### Corpus enrichment

OpenWolf's auto-scanner extracts anatomy descriptions from the first JSDoc / H1 line of each tracked file. That works well when files have rich headers but breaks down for files whose first line is a decoration, a function-level comment, or a test stub. For those, `/claudsterfuck:enrichmemory` spawns headless `claude -p --model haiku` calls to generate richer per-file descriptions (summary, keywords, exports) written to `.wolf/anatomy.enriched.md`. The compiler merges the enriched text on top of the vanilla anatomy chunks before scoring.

- **Batched calls.** Files are grouped 5-per-prompt (configurable), cutting CLI spawn count by ~5× — fewer fleeting console windows on Windows.
- **Content-hash cache.** Only files whose content changed since last run re-trigger an LLM call. Warm runs are instant.
- **Auto-prune.** Each run removes cache entries for files no longer tracked in anatomy.md (renamed/deleted), keeping the sidecar tidy.
- **Live monitor.** A `cf-enrich-monitor` window opens during real runs showing phase, file progress bar, batch progress bar, and the in-flight batch's file list. Auto-closes on completion.
- **Threshold-driven reminders.** The `UserPromptSubmit` hook surfaces a reminder in Claude's context when >10 anatomy files have retrieval-weak descriptions. For ≤10 unenriched files the hook silently triggers a background refresh.

Run `/claudsterfuck:enrichmemory` manually any time, or simply type the route (`route:enrichmemory`). No API key is required — the plugin uses your existing `claude` CLI auth. Cost is ~$0.001/file in Haiku tokens; a full ~45-file repo scan is roughly $0.05 and 2-3 minutes.

## License

MIT
