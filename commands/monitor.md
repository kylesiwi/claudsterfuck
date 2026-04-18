---
description: Open the claudsterfuck monitor window for this session (idempotent; safe to re-run)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Open a persistent, session-scoped monitor window. The window stays open across turns, rotating between views based on what's currently active:

- **idle** — session header + last completed run + last enrichment summary
- **enriching** — live batch + file progress bars while memory enrichment runs
- **dispatch** — active worker's event stream, provider, elapsed time, token usage
- **reviewing** — "Claude is reviewing worker output" banner with run stats

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-daemon.mjs" --session-id "${CLAUDSTERFUCK_SESSION_ID}" --spawn-window
```

The command is idempotent:
- If no monitor is currently running for this session, a new PowerShell window opens (titled `cf-monitor [<short-id>]`).
- If a monitor is already running for this session, the command prints a note and exits without opening a second window.

### Close-safe

You can close the monitor window any time — nothing in the plugin depends on it. The next time you run `/claudsterfuck:monitor`, it detects the stale lock (dead PID) and reopens a fresh window.

### What replaces it

This command supersedes the old per-run monitors:
- The dispatch monitor that used to open on every `/claudsterfuck:dispatch` — now routed into the daemon's dispatch view.
- The enrichment monitor that used to open during `/claudsterfuck:enrichmemory` — now routed into the daemon's enriching view.

If the monitor window isn't open, enrichment and dispatch still run headless with full correctness — the monitor is purely a visualization layer.

### Behavior & safety

- Window title: `cf-monitor [<first-8-chars-of-session-id>]`.
- Real screen clears between frames (scrollback included), so only the latest content is visible.
- No log files written; no ambient network calls; reads local state files only.
- Per-session lock at `.wolf/monitor.<session-id>.lock` with PID-aliveness reaping of stale entries.
