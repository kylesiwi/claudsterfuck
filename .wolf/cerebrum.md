# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-04-15

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** claudsterfuck

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

- [2026-04-16] Never treat empty provider output as success. Gemini runs with 0 bytes stdout were reported exitCode 0 because the old logic was `hasOutput ? 0 : (stderrRaw ? 1 : 0)`. A provider that is expected to produce output must fail when output is empty.
- [2026-04-16] Codex empty-output check must distinguish write-mode vs read-only routes. Write-enabled routes (implement/debug/implement-artifact) produce file changes as output — empty stdout is valid if exit code 0. Read-only routes (review-feedback) must produce a report; empty output = failure. Use a `WRITE_ROUTES` set keyed on `run.route` since `writeEnabled` is not persisted in the run record.
- [2026-04-16] `handleReset` with no `--session-id` only cleared the env-bound session, leaving other sessions' turns intact. Use `resolveStateCandidate(cwd).sessions` to iterate all sessions and clear every turn. The fix returns `scope: "all"` with `sessionsCleared` count.
- [2026-04-16] POSIX process group kill: use `process.kill(-pid, "SIGTERM")` on non-Windows to kill detached child's entire process group. Wrap in try/catch to fall back to single-PID kill if group kill fails (EPERM, PID reuse).
- [2026-04-16] On Windows, never spawn CLIs through PowerShell npm shims when stdin piping is required. For Codex specifically, bypass the JS wrapper (`bin/codex.js`) too — it re-spawns the native `codex.exe` without `windowsHide:true`, causing a console window on every worker run. Use `resolveCodexNativeBinary()` to find and spawn `codex.exe` directly; our spawn already has `windowsHide:true`. For Gemini, resolve to the Node.js entrypoint since it's a pure JS CLI.
- [2026-04-16] The `pwsh.exe` windows that appear during Codex runs are Codex's OWN internal subprocess behavior — Codex CLI spawns `pwsh.exe` for every shell `exec` command it issues (confirmed in stderr.live.txt). This is inside Codex's Rust runtime and cannot be suppressed from our orchestrator. Our `windowsHide:true` applies only to the `codex.exe` process we spawn, not its children. This is a known Codex-on-Windows behavior; the fix we shipped hides the initial `codex.exe` window (regression from node wrapper) but Codex's own exec subshells will still be visible.
- [2026-04-16] Gemini CLI 0.37+ relaunches itself via `spawn(process.execPath, ...)` by default. In detached process contexts on Windows this throws EPERM. Always set `GEMINI_CLI_NO_RELAUNCH=true` for orchestrated Gemini runs.
- [2026-04-16] On Windows, spawning terminal windows: CMD `/k` is unreliable (marker files not written). Use PowerShell exclusively. Write a `.ps1` launcher to `os.tmpdir()` and spawn it via `cmd /c start "title" powershell -NoProfile -ExecutionPolicy Bypass -File launcher.ps1`. This eliminates all inline quoting hell and is confirmed working.
- [2026-04-16] To spawn a visible terminal window from Node.js on Windows, `cmd /c start` is required. `detached:true` alone sets DETACHED_PROCESS — does NOT create a new visible console. Only `cmd /c start` triggers CREATE_NEW_CONSOLE. Title MUST have embedded double-quotes: `'"cf-monitor"'` (JS string with literal `"` chars), not `"cf-monitor"`. Pattern: `spawn('cmd', ['/c', 'start', '"cf-monitor"', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath], { detached: true, stdio: 'ignore' })`.
- [2026-04-16] PowerShell 5.1 `.ps1` files written from Node.js with `utf8` encoding must include a UTF-8 BOM (`\ufeff` as first chars) or avoid non-ASCII characters. Without BOM, PS5.1 uses OEM codepage and mis-decodes characters like em-dash (U+2014). Use plain ASCII in Read-Host strings or add BOM.
- [2026-04-16] `--stream` NDJSON approach was reverted in v1.8.0. The issue: subagent polling with NDJSON still requires Claude inference per intermediate read. Solution: spawn a separate visible PowerShell window (`monitor.mjs`) that tails the run at 2s intervals — zero token cost, full user visibility. Main thread calls `dispatch --watch --json` clean and gets only the final result. The `--stream` flag is preserved in orchestrator.mjs for potential advanced use but is no longer in the worker agent Bash shapes.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->

- [2026-04-16] `DEFAULT_WATCH_TIMEOUT_SECONDS` is 600s (10 min). Codex real-world runs take 5-10 min. The old 90s default caused spurious timeouts. When changing this, update `commands/watch.md` too.
- [2026-04-16] Token economics optimization: Added tiered PreToolUse context injection (minimal `[cf]` marker for read-only tools in reviewing/worker-running phases, full context only for denials and first calls), `dispatch --watch` combined command, `inspect --slim` flag, `reviewDepth` field on route profiles (verify/test/trust), and worker evidence requirement in prompts. Rationale: reduces orchestration overhead from ~11K tokens to ~2-3K tokens per routed turn, making the cost case for delegation clearer vs. Claude-only.
- [2026-04-16] Objective refinement pipeline: Claude's refined objective was previously discarded — dispatch read `currentTurn.objective` (hook-captured raw message). Fix: removed `args.objective` from the provider/route rejection guard in `handleDispatch`, added `args.objective ||` to resolution order. Worker agents pass the refined task as `--objective 'task'` when given a concrete task; omit it when prompt is generic so dispatch falls back to stored objective. The routing skill states the objective visibly before delegating ("Delegating to Codex with objective: '...'") so Claude's reasoning is auditable at `[run-artifacts]/prompt.md`.
