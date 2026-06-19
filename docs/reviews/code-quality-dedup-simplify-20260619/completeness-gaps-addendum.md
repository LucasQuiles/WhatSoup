# Completeness-critic addendum — gaps beyond the 46-bead manifest (2026-06-19)

A follow-up completeness-critic pass over `src/` found dedup/simplification opportunities **not covered** by the 46 verified beads in `state.md`. Each was verified against current `origin/main`. GAP-3 is landed in the same PR as this addendum; GAP-1/2/4/5/6 are documented here for pickup (they overlap files the active redaction/provider beads touch, so they are left for the one driver to avoid collision).

## Landed in this PR

### GAP-3 — two over-exported (internally-only-used) functions — dead-code
- `gitErrorText` (`src/lib/git-public-remote.ts:3`): used only at `:15` (internal `shouldRetryWithPublicHttps`). 0 external/test importers, no barrel re-export. → dropped `export`.
- `listScheduledMessages` (`src/mcp/tools/scheduling.ts:258`): used only at `:353` (internal). 0 external/test importers, no barrel re-export. → dropped `export`.
- Not among CQ-42..46 (which name `checkGlobalValve`, `addSeconds`, `isValidPermissionsSettings`, the opencode parser API, `ProviderMcpToolResult`, `COOLDOWN_MS`).

## Documented for pickup

### GAP-1 — `err instanceof Error ? err.message : String(err)` has no shared util — reuse-gap (HIGH)
- **59 occurrences across 34 files** (`git grep -E 'instanceof Error \? .*\.message *: *String\(' src`). A private `errorMessage(err: unknown)` already exists at `src/runtimes/chat/providers/pinecone.ts:33`.
- **Status:** this was in the manifest's **Rejected-on-merit** list ("Use a single shared errorMessage(err) util"), but the recorded rejection rationale is only verification text — it does not state *why* it was declined, and itself notes the finding "understates scope: 64 times across 37+ files." **Recommend revisiting the rejection:** export `errorMessage` from a neutral `src/lib` module and delegate the inline sites. Mechanical, zero behavioral change. Distinct from CQ-41 (`errorResult` is an MCP tool-result builder, not message extraction).

### GAP-2 — cross-cutting `fetchWithTimeout` (AbortController + setTimeout(abort) + clearTimeout) — duplication (HIGH)
- Same abort-on-timeout wrapper hand-rolled in 6+ files: `runtimes/chat/providers/elevenlabs.ts`, `runtimes/chat/providers/transcription/openai-whisper.ts`, `runtimes/chat/providers/transcription/local-audio.ts`, `runtimes/agent/diagnostic-bundle.ts`, `runtimes/agent/handoff-summarizer.ts`, plus the provider pairs. No shared helper (`withTimeout` in `primary-model-usability.ts:149` is a different promise-race).
- **Why not covered:** CQ-04 pairs only the agent `anthropic-api`/`openai-api` duo; CQ-13 only the chat `anthropic`/`openai` duo. Neither proposes a repo-level `fetchWithTimeout(url, init, ms)`, and neither touches the transcription/elevenlabs/diagnostic-bundle/handoff-summarizer sites.

### GAP-4/5/6 — lower confidence
- **GAP-4 (MED):** `clamp(value,min,max)` idiom ~8 sites; a named `clamp` already exists at `runtimes/agent/handoff-distill-config.ts:41` that the others don't import (0..1 clamp byte-identical at `memory/consolidation-cron.ts:136`, `runtimes/chat/enrichment/extractor.ts:247`, `validator.ts:203`).
- **GAP-5 (MED):** env-int parse-and-clamp IIFE triplicated at `runtimes/agent/runtime.ts:174-196` (+ `lib/emit-alert.ts`); no shared `parseEnvInt(key, default, {min,max})`.
- **GAP-6 (LOW):** `res.writeHead(NNN, {'Content-Type':'application/json'}); res.end(JSON.stringify(...))` emitted 11× in `core/health.ts`, 8× in `fleet/routes/silence.ts`; no shared `sendJson(res, status, body)`. Adjacent to CQ-10/CQ-12 but distinct.
