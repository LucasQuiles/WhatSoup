# Handoff: Duplicate Function Consolidation & Provider UI Phase 2

**From:** L (lab agent) — multi-provider UI Phase 2 + codebase dedup
**To:** Next agent — continue dedup Priority 2 large refactors + Priority 3/4
**Date:** 2026-04-04
**Branch:** `main` (pushed, 13 commits since `1fec020`)
**HEAD:** `4ca5d4a`
**Tests:** 141 files, 3,115 passed, 7 skipped, 0 failed
**Build:** clean (vite build exit 0, lint clean)

---

## What This Session Accomplished

### 1. Provider UI Phase 2 (2 commits: `be9e810`, `c5c310c`)

Completed the 6-task Phase 2 spec from `HANDOFF-PROVIDER-UI-PHASE2.md`. All 6 tasks implemented, reviewed (2 code reviews — initial + formal), and pushed.

| Task | What | File |
|------|------|------|
| 1 | LineTags badges in LineDetail header | `console/src/pages/LineDetail.tsx` |
| 2 | LineTags badges in Ops dashboard cards | `console/src/pages/Ops.tsx` |
| 3 | Provider KPI card (replaces MODE for agents) | `console/src/pages/LineDetail.tsx` |
| 4 | Provider row in config panel | `console/src/pages/LineDetail.tsx` |
| 5 | `provider` field in health endpoint + frontend type | `src/core/health.ts`, `console/src/types.ts` |
| 6 | Config-vs-running mismatch "restart needed" tag | `console/src/components/LineTags.tsx` |

**Design decisions already made (do not revisit):**
- `DEFAULT_PROVIDER_ID` from `console/src/lib/providers.ts` is the single source of truth — never hardcode `'claude-cli'`
- `getProvider()` for display names — never show raw provider IDs to users
- Provider badge hidden for default provider (claude-cli) — only non-default shows
- Task 3 KPI fallback: raw provider ID (user-facing). Task 4 config panel fallback: `DEFAULT_PROVIDER_ID` (system-facing). Asymmetry is intentional.
- Restart notice lives in `EditConfigModal`, not `ConfigStep`
- Config panel provider row border is conditional on `config.length > 0` (improvement over spec — prevents orphaned border when config entries are empty)

**Provider UI is now COMPLETE.** No remaining work. `HANDOFF-PROVIDER-UI-PHASE2.md` can be archived.

---

### 2. Deep Duplicate Function Scan (16 agents, 2 waves)

Ran a comprehensive duplicate-intent scan across the entire WhatSoup codebase.

**Pipeline:** 696 functions extracted -> 20 categories -> 11 semantic agents (wave 1) + 5 structural agents (wave 2) -> 80+ raw findings -> 22 unique actionable + 6 investigate

**Wave 1 (semantic):** Haiku categorizer + 8 Opus + 3 Sonnet duplicate detectors across all 20 categories.

**Wave 2 (structural):** 5 Opus agents running:
- AST signature matching (identical param/return types)
- Regex body-pattern detection (repeated code blocks)
- LSP call-hierarchy analysis (wrappers, dead code, import graph)
- Fuzzy body matching (content similarity, template patterns)
- Parameterizability analysis (same logic, different constants)

**Full report:** `docs/duplicates-report.md` (279 lines, oracle-quality)

---

### 3. Duplicate Consolidation (11 commits: `2c838b1`..`4ca5d4a`)

Executed Priority 1 (quick wins) and selected Priority 2 items. 3 parallel implementation agents + 2 parallel Priority 2 agents. Each batch reviewed and verified.

**Net impact:** 26 files changed, 433 insertions, 473 deletions (-40 net lines)

#### Priority 1 Completed (8 of 10 items)

| ID | What | Commit | Impact |
|----|------|--------|--------|
| 1.1 | `extractMessage()` x3 parsers -> `parser-utils.ts` | `2c838b1` | -60 lines |
| 1.2 | `extractTokenCounts()` x3 parsers -> `parser-utils.ts` | `2c838b1` | -47 lines |
| 1.3 | `ToolCategory` type SSOT (tool-mapping.ts canonical) | `e9e2dcf` | -15 lines |
| 1.6 | `resolvePhoneFromJid` delegates to `extractLocal` | `5d8f219` | -5 lines |
| 1.7 | SSE helpers -> `src/fleet/sse-helpers.ts` | `9e51ac3` | -15 lines |
| 1.8 | Chat provider error handler -> `api-error-classifier.ts` | `e197470` | -25 lines |
| 1.9 | `INSTANCE_CONFIG` parsed once in `main.ts` | `a0f7a81` | -2 lines |
| 1.10 | `stopTyping`/`abortTyping` merged | `e9e2dcf` | -10 lines |

#### Priority 1 DEFERRED (2 items — need test migration first)

| ID | What | Why Deferred |
|----|------|-------------|
| 1.4 | Remove `upsertAllowed` (reported as dead code) | Has callers in 2 test files. Need to update tests to use `upsertAccess` first. |
| 1.5 | Remove `extractPhone` alias (reported as dead code) | Has callers in 7 test files. Need to update tests to use `extractLocal` first. |

#### Priority 2 Completed (5 of 9 items)

| ID | What | Commit | Impact |
|----|------|--------|--------|
| 2.5 | Fleet ops validation helpers extracted | `4ca5d4a` | -60 lines |
| 2.6 | `cachedQuery<T>` helper in `lines.ts` | `a597656` | -40 lines |
| 2.7 | Validation constant Sets SSOT | `dba939f` | -6 lines |
| 2.8 | Inline JID -> `toPersonalJid()` (6 sites) | `19ba2e4` | quality fix |
| 2.9 | Group conversation key helpers | `1992bf8` | +10 lines (new utils) |

---

## What Remains (Priority 2-4, ordered by impact)

### Priority 2 DEFERRED — Large Refactors (highest value)

#### 2.1 MCP Sock Tool Factory (~920 lines removable)

**The single largest consolidation opportunity.** 35+ MCP tool handlers across 6 files follow identical boilerplate: parse zod schema -> `getSock()` -> null check -> `await sock.methodName(args)` -> return result.

**Files:**
- `src/mcp/tools/newsletter.ts` — 15 tools (~375 lines boilerplate)
- `src/mcp/tools/groups.ts` — 19 tools (~520 lines, includes redundant try/catch)
- `src/mcp/tools/community.ts` — 8 tools
- `src/mcp/tools/profile.ts` — 5 tools
- `src/mcp/tools/business.ts` — 5 tools
- `src/mcp/tools/advanced.ts` — 2 tools

**Approach:** Create `makeSimpleSockTool<T>()` factory in `src/mcp/tools/sock-tool-factory.ts`. Subvariants: `makeJidSockTool()`, `makeJidFieldSockTool()`, `makeBase64ImageSockTool()`. Each tool becomes a 3-7 line config object. Remove redundant try/catch from `groups.ts`.

**Risk:** Medium — many files, but each tool is independent. Can be done file-by-file with regression tests between each.

**Estimated effort:** 2-3 hours

#### 2.2 HTTP API Provider Base Class (~300 lines removable)

`AnthropicApiProvider` (424 lines) and `OpenAIApiProvider` (369 lines) share ~80% structure. Identical: constructor, `initialize()`, `sendTurn()` tool loop with `MAX_TOOL_ITERATIONS=20`, SSE reader pattern, `shutdown()`/`kill()`/`buildEnv()`, `getCheckpoint()`. Both have identical "Tool execution not yet wired" placeholder comments.

**Approach:** Extract `HttpApiProvider` base class parameterized by strategy object: `{ endpoint, authHeader, buildRequestBody, parseSSEChunk, buildToolResultMessages, envVarName, defaultModel }`.

**Files:**
- `src/runtimes/agent/providers/anthropic-api.ts`
- `src/runtimes/agent/providers/openai-api.ts`
- New: `src/runtimes/agent/providers/http-api-provider.ts`

**Risk:** Medium — behavior-preserving but touches core agent runtime. Test carefully.

**Estimated effort:** 2-3 hours

#### 2.3 buildChildEnv() Consolidation (~40 lines removable)

Three copies of the same 11-var environment builder:
- `src/runtimes/agent/session.ts:70` — master with provider switch
- `src/runtimes/agent/providers/claude.ts:53` — has comment: "intentionally duplicated until SessionManager is wired"
- `src/runtimes/agent/providers/opencode-adapter.ts:92`

**Approach:** Extract `buildBaseChildEnv()` shared module. Each provider adds its own vars.

**Estimated effort:** 30 min

#### 2.4 Codex Legacy Parser Functions (~80 lines removable)

Six legacy functions mirror modern ones with snake_case vs camelCase:
- `extractLegacyToolInput` / `extractToolInput`
- `extractLegacyToolResultContent` / `extractToolResultContent`
- `isLegacyToolItemType` / `isToolItemType`

**Decision needed:** Check if legacy Codex format is used in production or only test fixtures.

**Estimated effort:** 1 hour (including investigation)

### Priority 3 — Large Structural Improvements

#### 3.1 Typed Baileys Socket Interface (77+ `(sock as any)` casts)

Create `ExtendedSocket` interface in `src/mcp/types.ts` declaring all Baileys methods used by MCP tools. Combine with the sock tool factory (2.1) for maximum impact.

**Files affected:** 7 MCP tool files (newsletter.ts, business.ts, community.ts, advanced.ts, profile.ts, chat-operations.ts, calls.ts)

**Estimated effort:** 2-3 hours (best done alongside 2.1)

#### 3.2 Database Migration Helper (~75 lines)

Extract `hasColumn()` and `migrateTable()` helpers from `src/core/database.ts:373-660`.

#### 3.3 Pinecone Search Simplification (~15 lines)

Remove 4 thin wrappers in `src/runtimes/chat/providers/pinecone.ts:197-274`. Callers use `searchByField()` directly.

#### 3.4 Tool Mapper Switch -> Lookup Tables (~50 lines)

Replace 4 `mapToolName` switch/if-chains in `src/runtimes/agent/providers/tool-mapping.ts` with `Record<string, ToolCategory>` lookups.

### Priority 4 — Investigate (needs human judgment)

| ID | What | Decision Needed |
|----|------|----------------|
| 4.1 | `formatAge` vs `formatRelative` | Can server import from shared `src/lib/time-utils.ts`? |
| 4.2 | `ensureSessionAndQueue` sync/async | Can the sync call site be made async? |
| 4.3 | `getActiveQueue` vs `getQueueForChat` | Is one a filtered version of the other? |
| 4.4 | Fleet route param casts (13x `params as any`) | Fix route table generic types? |
| 4.5 | `execFileAsync` hand-rolled Promise | Replace with `node:child_process/promises`? |
| 4.6 | Mock data log entry factory | Low priority — mock data churn is low |

### Deferred Priority 1 Items (need test file updates)

| ID | What | Test Files to Update |
|----|------|---------------------|
| 1.4 | Delete `upsertAllowed` | `tests/core/access-list-upsert.test.ts`, `tests/core/lid-phone-resolution.test.ts` |
| 1.5 | Delete `extractPhone` alias | 7 test files: `access-list.test.ts`, `ingest.test.ts`, `ingest-control.test.ts`, `access-policy.test.ts`, `lid-phone-resolution.test.ts`, `heal-flow.test.ts`, `runtime.test.ts` |

---

## Confirmed Non-Duplicates (Do Not Re-Flag)

These were flagged by scanners but confirmed as intentionally separate by multiple agents:

- `sendTurn` x5 — polymorphic provider interface
- `handleMessage` x3 — runtime-polymorphic handlers
- `shutdown` x12 — layered shutdown hooks
- `initialize` x4 — provider lifecycle hooks
- `enqueue` x2 — different queue types
- `flush` x4 — different resources
- `ensureSchema` x2 — different tables
- `bootstrap` x3 — intentional decomposition
- `toAnthropicMessage` / `toOpenAIMessage` — provider-specific serializers
- `classifyToolError` / `classifyApiError` — different error domains
- `truncateForRerank` / `truncate` — different use cases
- XDG path wrappers — intentional facade
- `deleteOldMessages` / `cleanupOldRateLimits` — different domains
- `acquireLock` / `acquireSlot` — process lock vs concurrency semaphore
- `convertMcpToolsToOpenAI` / `convertMcpToolsToAnthropic` — different output types

---

## Key Architecture Context

### Provider System (Phase 1+2 complete)

The provider system supports 6 AI backends defined in `console/src/lib/providers.ts`:

| ID | Display Name | Type |
|----|-------------|------|
| `claude-cli` | Claude Code | cli |
| `codex-cli` | Codex CLI | cli |
| `gemini-cli` | Gemini CLI | cli |
| `opencode-cli` | OpenCode | cli |
| `openai-api` | OpenAI API | api |
| `anthropic-api` | Anthropic API | api |

**Frontend surfaces (all complete):**
- Wizard: provider selection in ConfigStep Permissions tab
- Edit modal: delegates to ConfigStep, restart notice for non-default
- SoupKitchen table: LineTags with provider badge
- LineDetail header: LineTags with provider badge
- LineDetail KPI: PROVIDER card for agents (MODE for passive/chat)
- LineDetail config panel: provider row above flat config entries
- Ops dashboard: LineTags in instance cards
- Health endpoint: `instance.provider` field
- Mismatch detection: "restart needed" tag when config != running provider

### New Shared Utilities Created This Session

| Module | Exports | Used By |
|--------|---------|---------|
| `src/runtimes/agent/providers/parser-utils.ts` | `extractMessage(obj, keys?)`, `extractTokenCounts(data)` | codex-parser, gemini-parser, gemini-acp-parser |
| `src/fleet/sse-helpers.ts` | `createSSEWriter(res, onEnd?)` | ops.ts, update.ts |
| `src/runtimes/chat/providers/api-error-classifier.ts` | `handleApiError(err, provider, model, startMs, logger)` | anthropic.ts, openai.ts |
| `src/core/conversation-key.ts` | `isGroupConversationKey(key)`, `conversationKeyToJid(key)` | data.ts, ops.ts, group-resolver.ts |
| `src/fleet/routes/ops.ts` (helpers) | `validateNumericBounds()`, `resolveAndValidateCwd()`, `validatePluginDirs()`, `normalizeAdminPhones()` | handleConfigUpdate, handleCreateLine |
| `src/fleet/routes/lines.ts` (helper) | `cachedQuery<T>(cache, key, ttl, queryFn)` | 5 cache functions |

### SSOT Consolidations

| What | Canonical Location | Previously Also In |
|------|-------------------|-------------------|
| `ToolCategory` type | `src/runtimes/agent/providers/tool-mapping.ts` | outbound-queue.ts (re-exports) |
| `VALID_TYPES`, `VALID_ACCESS_MODES`, `VALID_SESSION_SCOPES` | `src/instance-loader.ts` | ops.ts (removed) |
| `extractMessage()`, `extractTokenCounts()` | `src/runtimes/agent/providers/parser-utils.ts` | codex-parser, gemini-parser, gemini-acp-parser (removed) |

---

## Quality Gates Passed

- Build: vite build exit 0, lint clean (every commit)
- Tests: 141 files, 3,115 passed, 0 failed (verified at each batch boundary + final)
- Code reviews: 4 formal reviews (Phase 2 initial, Phase 2 formal, dedup initial in-progress, dedup final)
- All reviews approved with zero critical/important issues above threshold

---

## Verification Commands

```bash
# Build check
cd /home/q/LAB/WhatSoup/console && npx vite build 2>&1 | tail -5

# Console tests (57 tests — provider UI + unit)
cd /home/q/LAB/WhatSoup && npx vitest run tests/console/ 2>&1 | tail -5

# Full regression (3,115 tests)
cd /home/q/LAB/WhatSoup && npx vitest run 2>&1 | tail -5

# Parser tests specifically (100 tests — most affected by dedup)
cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/parsers/ 2>&1 | tail -5
```

---

## Kickoff Prompt for Next Agent

```
You are continuing the duplicate function consolidation for WhatSoup.

## Context

Phase 1 (quick wins) and partial Phase 2 are complete and pushed to main (HEAD: 4ca5d4a).
A 16-agent deep scan identified 22 unique actionable findings. 13 are done. 9 remain.

## Your Spec

Read HANDOFF-DEDUP-CONSOLIDATION.md at the repo root. It has the full state:
- What was completed (with commit SHAs)
- What remains (with exact file paths, line numbers, and approaches)
- Confirmed non-duplicates (do not re-flag)
- New shared utilities created (use them, don't duplicate)
- SSOT consolidations (respect canonical locations)

## What to Do Next (in priority order)

1. **Deferred 1.4 + 1.5** — Update test files to use `upsertAccess`/`extractLocal`,
   then delete `upsertAllowed` and `extractPhone` from access-list.ts
2. **2.3 buildChildEnv** — Extract shared base env builder (30 min, 3 files)
3. **2.1 MCP sock tool factory** — The biggest win (~920 lines). Create
   `makeSimpleSockTool()` factory, convert tools file-by-file. Start with
   `newsletter.ts` (simplest pattern), then `groups.ts` (needs try/catch removal).
4. **2.2 HTTP API provider base class** — Extract `HttpApiProvider` from
   anthropic-api.ts and openai-api.ts (~300 lines saved)
5. **3.1 Typed Baileys socket** — Best done alongside 2.1

## Key Constraints

- Every change is behavior-preserving. No new features.
- Run `npx vitest run` after each file-level change. All 3,115 tests must pass.
- Use existing shared utilities (parser-utils.ts, sse-helpers.ts, etc.) — see
  the "New Shared Utilities" table in the handoff doc.
- Respect SSOT canonical locations — see the "SSOT Consolidations" table.
- Do NOT re-flag items in the "Confirmed Non-Duplicates" section.
- Commit each logical change separately with `refactor:` conventional commit prefix.

## Verification

After each change:
  cd /home/q/LAB/WhatSoup && npx vitest run 2>&1 | tail -5
  # Expected: 3115+ passed, 0 failed

After all changes:
  cd /home/q/LAB/WhatSoup/console && npx vite build 2>&1 | tail -5
  # Expected: exit 0

## Start

Read HANDOFF-DEDUP-CONSOLIDATION.md, then begin with item 1 (deferred test
migrations) as a warmup before tackling the larger refactors.
```
