# Memory-Packet Compiler Rewrite

Staged plan to fix systemic weaknesses in the OpenWolf memory-packet compiler surfaced by run `gemini-c421c568` (27 tool calls, ~694K tokens spent re-discovering files that anatomy.md already indexed).

**Status snapshot (post-PR-3):**
| Metric | Baseline (before PR 1) | After PR 2 | After PR 3 |
|---|---|---|---|
| Quality=ok rate (8-fixture benchmark) | 3/8 (37%) | 8/8 (100%) | 8/8 (100%) |
| Surface recall (expected files in packet) | 0/13 (0%) | 8/13 (62%) | 9/13 (69%) with only 10 files enriched |
| Original failure-case packet | 2× `settings.json` | `orchestrator.mjs` + `providers.mjs` + cerebrum | Same files surfaced with higher scores (3→5.5) from enriched signal |

The retrieval **ceiling** has moved. PR 1's stopword+fallback+telemetry floor and PR 2's vocabulary expansion + per-bullet cerebrum chunking + interleaved selection together eliminated the worst-case behavior. Remaining recall gaps are no longer *query-side* problems — they are *corpus-side* problems (anatomy descriptions are auto-extracted by OpenWolf using first-JSDoc/H1 heuristics, which produces useless text for files like `policy.mjs` → "Resolve a read target..."). This reshapes PR 3.

---

## Diagnosis

The compiler at `scripts/lib/openwolf/compile-packet.mjs` is a lexical-match retrieval system whose inputs and outputs are not aligned.

| Layer | Weakness |
|---|---|
| Keyword extraction (`sanitize.mjs`) | 20-word stopword list — instruction verbs, modals, hedges, meta-nouns all pass through as "keywords" |
| Keyword truncation (`sanitize.mjs:43`) | First-8-unique-tokens-in-prompt-order wins. No priority, no IDF weighting. Topical terms can be truncated out. |
| Scoring (`score.mjs:17-21`) | Pure substring match. No stemming, no synonym expansion, no route-specific vocabulary. Vocabularies of user prose vs. anatomy descriptions don't align. |
| Selection gate (`compile-packet.mjs:105`) | Chunks with zero keyword hits are invisible to selection. Architectural importance is not a scoring factor. |
| Fallback (`compile-packet.mjs:130-148`) | When nothing scores, returns first-N anatomy chunks by file order — semantically irrelevant. |
| Corpus | Compiler only chunks `.wolf/` sources. `DEVELOPER.md` and other referenced files never enter the retrieval corpus. |
| Pipeline | Raw user prompt hits the compiler directly. No query enrichment bridging user prose to codebase vernacular. |
| Feedback | Worker tool-call telemetry is not compared against selected files. The compiler cannot learn. |
| Observability | A broken packet is emitted silently. No quality score, no alarm. |

Class of problem: **lexical retrieval on free-form prose against structured metadata fails catastrophically when vocabularies don't align, and no layer exists to bridge them.**

---

## Layered fix

Four concentric layers, each independently shippable:

### Layer 0 — Stop bleeding

Telemetry and a safety floor. No behavior change for healthy packets.

- Expand `STOPWORDS` in `sanitize.mjs` to cover instruction verbs, modals, hedges, meta-nouns, wh-words (~80 entries).
- Rank fallback chunks by embedded `(~N tok)` file size in anatomy, largest first — biases toward architecturally significant files when lexical signal fails.
- Emit `qualityScore` from `compileMemoryPacket` (composite of keyword topicality, top-chunk score, source diversity, fallback usage).
- Persist `memoryQuality` and `memoryIncludedFiles` on the run record.
- At finalize, parse `events.jsonl` for tool-use file reads, compute `packetVsReads` telemetry (overlap, missed files), persist on the run record. Source of truth for future learning.

### Layer 1 — Vocabulary bridging

Close the user-prose-vs-codebase vocabulary gap.

**1a — Route-level glossary.** Each `routes/*.json` gets an optional `vocabulary` field (synonym map). The scorer expands each objective keyword via its bucket before substring matching:

```jsonc
"vocabulary": {
  "model":    ["provider", "codex", "gemini", "binary", "backend"],
  "dispatch": ["orchestrator", "spawn", "worker", "runtime"],
  "route":    ["routing", "classify", "rule", "profile"]
}
```

**1b — TF-IDF weighting.** Replace uniform `tokenScore += 1` with `tokenScore += idf(term)`. Rare terms across the anatomy corpus get high weight; common terms get low weight. Self-tuning — eventually makes stopword list obsolete.

### Layer 2 — Query enrichment

Move structural interpretation out of the compiler.

**Status check:** The dispatch-time plumbing for objective refinement already exists. `orchestrator.mjs handleDispatch` reads `args.objective || currentTurn?.objective` (orchestrator.mjs:1435), so Claude *can* pass a refined objective via `--objective "text"` and it flows into the compiler. `skills/claudsterfuck-routing/SKILL.md` already instructs Claude to refine (see the "Before dispatching, your objective should answer…" section). What's missing is:

1. No concrete **template** for what a refined objective should look like (Claude improvises).
2. Refined objective is not **persisted** on the turn — each dispatch starts fresh; a retry after a failed run loses the refinement.
3. No **measurement** of refinement quality — we can't tell if a given refinement helped or hurt retrieval.

These gaps are the actual PR 3 scope (see below — rewritten post-PR-2). The original "main-thread enrichment in REFINING phase" framing is partially obsolete: the plumbing is there, it just needs contract and persistence.

Alternatives still valid:
- Heuristic regex expansion — superseded by PR 2's vocabulary-class expansion.
- Haiku/Flash API call — holds as a Layer 3 option for *corpus* enrichment when structural extraction is insufficient.

### Layer 3 — Backbone + semantic retrieval

**Backbone manifest.** Each route declares files that always get included regardless of scoring (`DEVELOPER.md#Architecture Overview` for design, `buglog.json#recent-5` for debug). Enforced before the budget gate.

**Snippet resolution.** Selected anatomy entries get resolved to inline source excerpts — top-K matching lines with 5-line context windows, capped at ~200 chars per snippet. The packet shifts from "file names" to "exact code locations". The compiler has legitimate source-read access (runs inside orchestrator.mjs, not the main thread).

**Optional semantic retrieval.** Behind a flag. Embed anatomy entries once via local embeddings model (`@xenova/transformers`, ~100MB), hash-invalidate. Parallel cosine-similarity rank against embedded enriched objective. Combines with lexical score. Fully replaces keyword hacks at Layer 1 if adopted.

---

## Closed feedback loop (cross-cutting)

Regardless of which layers ship, compare packet files against worker-read files from `events.jsonl`:

- `packet_file ⊂ worker_read` — packet useful, worker extended. Normal.
- `packet_file ∩ worker_read = ∅` — packet ignored. Compiler failed. Alarm.
- `worker_read ∖ packet_file` — the missed files. Mine for terms; append to route vocabulary. The compiler learns.

Persist per-turn in `.wolf/memory.md`; aggregate into `cerebrum.md` when patterns crystallize.

---

## Ship sequence

| PR | Layer | Scope | Status |
|---|---|---|---|
| **PR 1** | Layer 0 | Expanded stopwords + size-ranked fallback + 400-char per-chunk cap + `qualityScore` + `packetVsReads` telemetry at finalize | **Shipped** |
| **PR 2** | Layer 1a + chunking + trimmer fixes | Default vocabulary + directed expansion + per-bullet cerebrum chunking + interleaved source selection + bumped route budgets (900→1800) | **Shipped** |
| **PR 3** *(rewritten again)* | Corpus enrichment via headless `claude -p --model haiku`. Refinement scope **dropped** after empirical regression. | `scripts/enrich-anatomy.mjs` CLI; `.wolf/anatomy.enriched.md` sidecar; compiler merges enriched text onto base anatomy chunks; keyword budget bumped 8→16; route char budgets bumped +400 | **Shipped (initial: 10 files enriched, +7pp recall)** |
| **PR 4** | Layer 1b + Layer 2b persistence (optional) | TF-IDF weighting; optionally: `enrichedObjective` persisted on turn schema + `orchestrator.mjs refine-objective` command + policy permit | Planned |
| **PR 5+** | Layer 3 | Backbone manifest → snippet resolution → Haiku enrichment tier for files where structural extraction underperforms → semantic retrieval | Planned |

Anti-pattern to avoid: **do not have the main Claude thread hand-pick source files and paste line ranges into the objective.** That collapses the v2.5.1 source-read blackout and re-introduces the "Claude transcribes to Codex" failure mode. The fixes above keep the main thread doing control-plane work (query enrichment is legitimate) and the compiler doing retrieval.

### Why PR 3 was rewritten

The original PR 3 targeted *query-side* enrichment (structured `enrichedObjective` on turn schema). Post-PR-2 measurement changes the picture:

- PR 2 already reached 100% quality=ok and 62% surface recall. Query-side logic is not the bottleneck.
- Surface-recall misses in PR 2 benchmarks (F4, F5, F7, F8) trace to **anatomy description quality**, not query vocabulary. Examples:
  - `policy.mjs` anatomy description = "Resolve a read target that is inside the workspace's .wolf/ directory." No mention of "policy" or "PreToolUse".
  - `user-prompt-submit-hook.mjs` description = "R6: surface the prior turn's objective (or pendingObjective for chat-fallback…". An internal PR-ID reference, not topical.
  - `compile-packet.mjs` description = "--- Memory Distillation: Source-level classification ---" (first line of file, a comment header).
- OpenWolf auto-extracts these deterministically and they don't match user vocabulary.
- Query enrichment can't rescue a chunk whose description doesn't contain any of the right terms — no amount of user-side refinement will make `policy.mjs` match "policy engine" if its description says "Resolve a read target…".

**Corpus enrichment has a higher retrieval ceiling than further query enrichment.** The rewritten PR 3 fixes the corpus first, then adds a lightweight refinement template as a secondary improvement.

---

## PR 1 contents (shipped)

Files touched:
- `scripts/lib/openwolf/sanitize.mjs` — `STOPWORDS` expanded from 20 → ~250 entries (instruction verbs, modals, hedges, meta-nouns, wh-words, prepositions). Domain nouns preserved.
- `scripts/lib/openwolf/compile-packet.mjs` — size-ranked fallback via `(~N tok)` annotation; 400-char per-chunk cap (defensive fix for oversized cerebrum chunks starving the budget); `qualityScore` composite verdict returned.
- `scripts/routing/assemble-worker-prompt.mjs` — threads `memoryQuality` + `memoryIncludedChunks` through return.
- `scripts/orchestrator.mjs` — persists `memoryQuality`/`memoryIncludedFiles` on initial run record; at finalize, parses `events.jsonl` tool-use events and writes `packetVsReads` telemetry.
- `scripts/lib/openwolf/compile-packet.test.mjs` — 6 tests covering stopword drops, size-ranked fallback, quality-score shape, empty contract.

Quality-score shape:
```jsonc
{
  "quality": "ok" | "weak" | "empty",
  "keywordsKept": 4,
  "keywordsDropped": 11,
  "topChunkScore": 7,
  "distinctSources": 3,
  "usedFallback": false,
  "totalChunks": 6
}
```

Telemetry-score shape (emitted at finalize):
```jsonc
{
  "packetFiles": ["scripts/orchestrator.mjs", "scripts/lib/providers.mjs"],
  "workerReadFiles": ["scripts/orchestrator.mjs", "scripts/lib/providers.mjs", "routes/design.json"],
  "overlap": 2,
  "missedFiles": ["routes/design.json"],
  "unusedPacketFiles": [],
  "toolCallCount": 6
}
```

---

## PR 2 contents (shipped)

Files touched:
- `scripts/lib/openwolf/default-vocabulary.mjs` (new) — ~50 keyed buckets covering the control plane, providers, routing, hooks, policy, state, memory, events, config, spawning, tests.
- `scripts/lib/openwolf/expand.mjs` (new) — directed expansion logic. Keyword → bucket values only; no transitive merging across buckets. Fail-open on malformed vocabulary.
- `scripts/lib/openwolf/score.mjs` — integrates expansion at 0.5× weight vs. raw keyword at 1.0×; raw matches break ties before text length.
- `scripts/lib/openwolf/chunk.mjs` — per-bullet cerebrum chunking (was one chunk per heading).
- `scripts/lib/openwolf/compile-packet.mjs` — interleaved source selection so the trimmer preserves diversity under tight budgets; route budgets bumped 900–1400 → 1800–2200; expansion metrics exposed in `qualityScore`.
- `scripts/routing/assemble-worker-prompt.mjs` — passes `route.vocabulary` to compiler.
- `scripts/lib/openwolf/benchmark.mjs` (new) — 8-fixture harness for regression testing.
- `scripts/lib/openwolf/compile-packet.test.mjs` — extended with 8 new tests (directed expansion, per-bullet chunking, interleaving, quality expansion metrics).

Directed expansion rationale: initial union-find equivalence classes cascaded catastrophically (shared tokens like `compile`, `turn`, `routing` glued the memory/state/routing classes together — ~70 active terms per query, scoring unrelated chunks). Directed semantics (keyword → values, no transitive merge) are simpler and predictable. Reverse mappings are declared explicitly.

---

## PR 3 contents (shipped)

### Empirical finding that reshaped PR 3

The pre-benchmark compared raw-user-prose objectives against two refined forms (strict `[task-type] [affected-systems] — [goal]` template and a lighter "add 2-4 topical nouns" hint). Both refined forms **regressed** surface recall from 62% to 38%. Three mechanisms:

1. Over-specification with function names (`buildCodexArgs`) bypasses the vocabulary expansion that common words (`provider`) trigger.
2. Refined objectives add more keywords, pulling noise files (`settings.json` on "setting", `orchestrator.test.mjs` on "orchestrator") into the `perSourceMax: 2` anatomy cap.
3. More keywords means the interleave+trimmer cuts the tail, losing the last-added anatomy chunk.

Conclusion: the objective-refinement scope was dropped. The query side (post-PR-2) is already near-optimal against the existing corpus. This negative result is logged in `.wolf/cerebrum.md` (2026-04-18) so future reviewers don't re-attempt it under the assumption it's low-risk.

### Thesis (rewritten)
The retrieval ceiling is bound by anatomy description quality. OpenWolf's auto-extraction produces retrieval-weak text for many architectural files (`policy.mjs` → "Resolve a read target…"; `user-prompt-submit-hook.mjs` → "R6: surface the prior turn's objective…"). A deterministic sidecar **doesn't** fix this — the files that most need enrichment are the ones where structural extraction is shallow (no rich JSDoc, no informative H1). LLM-backed enrichment via a local headless `claude -p --model haiku` subprocess writes a sidecar that the compiler merges on top of the vanilla anatomy — filling the topical-vocabulary gap.

### Scope — LLM-backed corpus enrichment

**Goal:** Produce richer per-file descriptions that contain the topical keywords retrieval needs, without touching OpenWolf (which owns vanilla `.wolf/anatomy.md`).

**Mechanism:** `scripts/enrich-anatomy.mjs` — a Node CLI that:
1. Parses `.wolf/anatomy.md` to get the tracked file list.
2. Hashes each file's content (sha256) and compares against `.wolf/anatomy.cache.json`.
3. For files whose hash changed (or `--force`), spawns a headless `claude -p --model haiku` subprocess via child_process with a structured prompt requesting `summary`, `keywords`, and `exports` lines.
4. Parallelizes up to N concurrent calls (default 4).
5. Writes `.wolf/anatomy.enriched.md` (sidecar) + updates the cache atomically.

**Prompt shape** (see `buildEnrichmentPrompt` in enrich-anatomy.mjs): asks Haiku to emit exactly three lines — `summary:` (1 sentence, ≤20 words, domain-native nouns), `keywords:` (6-12 comma-separated topical nouns), `exports:` (identifiers). No preamble, no markdown fences.

**Example transformation (`policy.mjs`):**
- Vanilla: "Resolve a read target that is inside the workspace's .wolf/ directory."
- Enriched: `summary: Permission evaluator for claudsterfuck routed turns and orchestrator tool-use policy enforcement. keywords: routed-turn, orchestrator, tool-use-policy, turn-phase, delegation, companion-command, pre-tool-use, openwolf, confirmation-mode, write-tool, context-tool, policy-evaluation. exports: isAllowedCompanionCommand, evaluatePreToolUseWithoutTurn, evaluatePreToolUse, evaluateStop`

**Cache model:** `.wolf/anatomy.cache.json` keyed by `relativePath → { hash, enrichment, enrichedAt, model }`. A warm-cache run is seconds; cold-cache re-scan of this repo (~90 files) is ~4 minutes at concurrency 4, ~$0.01 in Haiku tokens.

**Trigger model:** on-demand (`node scripts/enrich-anatomy.mjs`). Opt-in, manual. A later PR can wire it to a SessionStart hook or pre-dispatch check; keeping it manual for PR 3 avoids startup latency and user-surprise costs.

**Supported flags:**
- `--files <a,b,c>` — enrich a targeted list
- `--problem-only` — enrich only files whose vanilla description matches retrieval-weak heuristics (empty, starts with `---` / `R\d+:` / "Resolve a " / "run:", etc.)
- `--force` — ignore cache
- `--concurrency <N>` — parallelism
- `--dry-run` — list work only
- `--limit <N>` — cap count
- `--model <name>` — override model (default: haiku)

**Merge semantics in compiler:** `load-raw-sources.mjs` exports `loadEnrichedAnatomyMap(workspaceRoot)` returning `Map<relativePath, enrichedText>`. `chunkAnatomy` in `chunk.mjs` accepts an optional third argument (this map), tracks `## <dir>` section context as it walks lines, computes the relative path per bullet, and appends enriched text to the chunk's `text` field. No new chunks — enrichment is an overlay on existing anatomy chunks, so per-source caps and interleaving behave unchanged. Fail-open: absent sidecar ⇒ PR 2 behavior.

**Dependency surface:**
- New: requires `claude` CLI on PATH (Claude Code 2.1.113+).
- New: `CLAUDE_CODE_GIT_BASH_PATH` env var required on Windows, or Git-for-Windows installed at a common location (auto-discovered).
- No new npm deps. No new network calls at compile time (only at enrichment time via the subprocess).

### Measured results

**Pre-benchmark** (PR-2-shipped, 8 fixtures):
- Raw objectives: 62% surface recall (8/13), 8/8 quality=ok
- Strict-template refined: 38% surface recall (regression)
- Light-hint refined: 38% surface recall (regression)

**Post-benchmark** (PR 3 shipped, 10 files enriched):
- 69% surface recall (9/13), 8/8 quality=ok
- F5 (plan rollout) went 0/1 → 1/1 from compile-packet.mjs enrichment
- Original failure case: `orchestrator.mjs` and `providers.mjs` still surface, scores bumped 3.0 → 5.5 from enriched signal

**Full-repo scan projection:** of 90 tracked files, the `--problem-only` heuristic identifies ~44 with retrieval-weak vanilla descriptions. Enriching all of them at concurrency 4 = ~4 minutes and ~$0.04 in Haiku tokens. Expected recall after full scan: 75-85%.

### Files touched (shipped)

- `scripts/enrich-anatomy.mjs` (new) — LLM-backed scanner, sidecar writer, hash-keyed cache manager.
- `scripts/lib/openwolf/load-raw-sources.mjs` — added `loadEnrichedAnatomyMap(workspaceRoot)`.
- `scripts/lib/openwolf/chunk.mjs` — `chunkAnatomy` extended to accept an enriched map and merge text onto chunks by relative-path lookup with section tracking.
- `scripts/lib/openwolf/compile-packet.mjs` — loads enriched map once per compile, passes through `chunkSource(rawSource, context)`; route budgets bumped +400 to accommodate larger enriched chunks.
- `scripts/lib/openwolf/sanitize.mjs` — keyword budget bumped 8 → 16 as pre-req (harmless for raw prompts; gives enriched anatomy texts room to produce more matchable terms).
- `scripts/lib/openwolf/benchmark.mjs` — extended with `rawObjective` + `refinedObjective` per fixture and a `--compare` dual-run mode used in pre-benchmark. Kept for future axes (e.g., vanilla vs enriched comparison).
- `scripts/lib/openwolf/compile-packet.test.mjs` — 5 new tests covering enriched-map merging, sidecar parsing, absent-sidecar fallback, and the policy.mjs-surfaces-via-enrichment integration case.
- `.wolf/cerebrum.md` — appended 2026-04-18 Do-Not-Repeat entry on the objective-refinement regression finding.

### Risk + mitigations

| Risk | Mitigation |
|---|---|
| Enriched descriptions drift from file content | Content-hash-keyed cache. Stale entries regenerate automatically on next run. |
| Sidecar missing or malformed | `loadEnrichedAnatomyMap` fails open to `Map()`; `chunkAnatomy` handles absent map via default. Backward compatible with pre-PR-3 behavior. |
| Haiku gives domain-abstracting summaries that miss file-specific nouns (e.g., called `chunkAnatomy`'s file "memory chunks" instead of "anatomy chunks") | Observed on F8. The `keywords:` line still carries most of the signal; failure is per-file, not systemic. Future iteration can pin domain nouns in the prompt or re-enrich with context. |
| Headless `claude` CLI requires git-bash on Windows | Auto-discovered from common paths; falls back to `CLAUDE_CODE_GIT_BASH_PATH` env var. Script exits cleanly with a clear error if neither is available. |
| Cache file growth | `.wolf/anatomy.cache.json` stores content hash + short enrichment text per file. ~2KB/entry × 90 files ≈ 180KB. |
| Running enrichment spawns claude from inside claude | Verified working (no sub-session confusion). Subprocess uses its own auth. Costs are billed to the user's claude subscription as usual. |
| Haiku can't enrich private files or hit rate limits | Fail-open per file: errors logged, cache not updated for that file, next run retries. |
