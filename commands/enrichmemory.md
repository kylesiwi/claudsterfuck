---
description: Enrich the memory-packet corpus via headless Haiku — improves retrieval for files with weak vanilla descriptions
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Housekeeping for the OpenWolf anatomy corpus. Runs `scripts/enrich-anatomy.mjs` to generate LLM-backed summaries/keywords/exports for files whose auto-extracted description is retrieval-weak (matches WEAK_DESCRIPTION_PATTERNS in `scripts/lib/openwolf/enrich-status.mjs`).

## Workflow

1. Check current status:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/enrich-anatomy.mjs" --status
```

2. Enrich all problem files (auto-prunes orphan cache entries at start; auto-skips cached files whose content hasn't changed; batches 5 files per Haiku call):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/enrich-anatomy.mjs" --problem-only
```

3. Re-check `--status` to confirm unenriched count dropped to zero.

### Manual prune only (no enrichment)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/enrich-anatomy.mjs" --prune
```

### Flags

- `--problem-only` — enrich only files whose vanilla description is retrieval-weak
- `--files a.mjs,b.mjs` — target a specific list
- `--force` — ignore cache, re-enrich everything in scope
- `--no-prune` — skip the auto-prune step (default behavior is to prune at start)
- `--batch-size N` — files per Haiku call (default 5; larger = fewer spawns, bigger prompts)
- `--concurrency N` — parallel batches in flight (default 2 × batchSize 5 = ~10 files concurrent)
- `--dry-run` — list work without spawning any LLM calls (no monitor, no progress file)
- `--limit N` — cap count for debugging
- `--no-monitor` — suppress the visible progress window on Windows (progress file still written)

### Live monitor window

On Windows, a separate PowerShell window titled **cf-enrich-monitor** opens for the duration of the run. It shows:

- Current phase (pruning → triaging → enriching → complete/failed)
- File progress bar with per-file counts (enriched, cached, missing, errored)
- Batch progress bar
- In-flight batch's file list
- Elapsed time

The window closes automatically a few seconds after `phase: complete`. Progress state is persisted in `.wolf/enrichment.progress.json` for post-hoc inspection.

## When to run

- After a session of significant code changes (enrichment auto-invalidates per file hash, but running the command ensures the sidecar is rebuilt).
- When the main-thread hook alerts you that >10 unenriched problem files remain (hook auto-injects this reminder during turn assembly).
- After renaming or deleting files (`--prune` cleans orphan cache entries).

## Cost

- Uses `claude -p --model haiku` subprocess calls.
- Batching groups 5 files per Haiku call by default, so CLI spawns drop by ~5× vs. per-file invocation. Fewer spawns → fewer fleeting git-bash console windows on Windows.
- ~$0.001 per file at typical sizes (~500 input tokens, ~50 output tokens per file, amortized across the batch).
- Full `--problem-only` scan of this repo (~44 files): ≈ 10 batches ≈ 2-3 minutes at concurrency 2 · ≈ $0.05 total.
- Warm cache: near-zero — unchanged files are skipped by content-hash comparison before any LLM call.

## Reporting

After the enrichment run, summarize:
- Number of files enriched vs. cached (skipped)
- Duration
- Any `llm-error` or `llm-malformed` entries (these files need investigation)
- Current `--status` output for verification
