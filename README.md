# claudsterfuck

A Claude Code plugin for deterministic multi-provider orchestration. Routes your prompts to Codex or Gemini workers based on intent — implementation tasks go to Codex, design/review tasks go to Gemini — with automatic delegation, a live monitor window, and dispatch+poll execution so Claude stays in control the whole time.

## Requirements

- [Claude Code](https://claude.ai/code)
- [OpenWolf](https://github.com/cytostack/openwolf) — Claude Code context management system (required; provides `.wolf/` memory, anatomy, and cerebrum files)
- [Codex CLI](https://github.com/openai/codex) — `npm install -g @openai/codex` — for implementation/debug routes
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `npm install -g @google/gemini-cli` — for design/review/plan routes
- Environment variables: `OPENAI_API_KEY`, `GEMINI_API_KEY`

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

### 4. Set API keys

```bash
# In your shell profile or .env (not committed):
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=AI...
```

### 5. Verify providers

In any Claude Code session, run:

```
/claudsterfuck:setup
```

This checks that both CLIs are available and reports which binaries were resolved.

## Usage

Just write naturally. The plugin classifies your prompt (keyword heuristics + weighting, or inferenced intent if low confidence) and routes it:

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
- route:chat I am thinking about building a website, and I want to include a payment system. I am located in Chile.
(Claude replies normally with information)
- route:design
(Claude keeps the objective you mentioned in your last turn and now routes it to "design"; i.e. Gemini)
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
- route:design I am thinking about adding a payment system to the website in this workspace
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

- Use "chat" when you just want Claude's advice but you DON'T want Claude to just start coding on its own (which it tends to do unprompted in normal Claude Code sessions, as you might have unfortunately found out). This route is READ-ONLY; Claude has NO write permissions.
- Use "claude" when you want the normal Claude Code experience; it has full permissions and basically "skips" the plugin

Even though these two routes are "free chat", they do NOT break the plugin's internals because they preserve run state and objectives (e.g. if you state you want to build a website and then use route:chat to ask Claude clarifying questions, the next time you use route:design it should automatically go back to the website building task and not break the plugin flow).




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

## License

MIT
