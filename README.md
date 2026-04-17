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

## Routes

| Route | Provider | Description |
|---|---|---|
| `implement` | Codex | Write or modify code |
| `debug` | Codex | Diagnose and fix a bug |
| `implement-artifact` | Codex | Generate a large standalone file (HTML, dashboard, etc.) |
| `review` | Gemini | Code review |
| `review-feedback` | Codex | Apply review feedback |
| `design` | Gemini | Architecture and design exploration |
| `plan` | Gemini | Implementation planning |
| `adversarial-review` | Gemini | Devil's advocate critique |
| `chat` | Claude | Read-only fallback (default for low-confidence prompts) |
| `claude` | Claude | Explicit full-permissions bypass, never auto-routed |

Routing is automatic: high-confidence prompts delegate immediately; everything else falls back to `chat` where Claude answers and suggests a route.

## Usage

Just write naturally. The plugin classifies your prompt and routes it:

```
write a retry wrapper around the fetch calls in api.ts
```
→ auto-routes to `implement`, dispatches Codex

```
what's the best approach for handling rate limits?
```
→ routes to `chat` (question detected), Claude answers and suggests `route:design` if useful

To force a route:

```
route:design  (uses the stored objective from the prior chat turn)
/claudsterfuck:implement add retry logic to api.ts
```

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
