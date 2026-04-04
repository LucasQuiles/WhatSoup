# WhatSoup Duplicate Function Report

Generated: 2026-04-04
Scanned: 696 functions across 20 categories
Analysis: 16 agents (11 semantic + 5 structural)

## Executive Summary

**22 unique actionable findings** after deduplication from 16 independent agent scans.
**Estimated total LOC savings: ~1,650 lines** (conservative).
**Top 3 priorities:**
1. MCP tool factory boilerplate (groups, newsletter, community, profile, business) -- ~920 lines removable
2. Parser utility consolidation (extractMessage, extractTokenCounts) -- ~140 lines removable
3. HTTP API provider base class extraction (anthropic-api.ts, openai-api.ts) -- ~300 lines removable

---

## Priority 1: Quick Wins (< 30 min each)

### 1.1 extractMessage() triplicated across parsers
- **Confirmed by:** 8 agents | **Est. savings:** ~60 lines | **Confidence:** HIGH
- **What:** Three identical recursive text-extraction functions differing only in the list of JSON keys to probe. Copy-paste with key-list drift already occurring.
- **Where:**
  - `src/runtimes/agent/providers/codex-parser.ts:283` -- keys: text, message, error, details, content, aggregated_output, output
  - `src/runtimes/agent/providers/gemini-parser.ts:7` -- keys: message, error, details, content, text
  - `src/runtimes/agent/providers/gemini-acp-parser.ts:37` -- keys: text, message, error, details, content, output
- **Fix:** Move to `src/runtimes/agent/providers/parser-utils.ts` with a configurable `keys` parameter defaulting to the union of all keys: `['text', 'message', 'error', 'details', 'content', 'output', 'aggregated_output']`. All three parsers already import from parser-utils.ts.

### 1.2 extractTokenCounts() triplicated across parsers
- **Confirmed by:** 8 agents | **Est. savings:** ~80 lines | **Confidence:** HIGH
- **What:** Three copies of the same token-count extractor. gemini-parser.ts and gemini-acp-parser.ts are byte-for-byte identical. codex-parser.ts is a strict subset (4 paths vs 6). All use `getNestedNumber` already in parser-utils.ts.
- **Where:**
  - `src/runtimes/agent/providers/codex-parser.ts:301` -- 4 input paths, 4 output paths
  - `src/runtimes/agent/providers/gemini-parser.ts:31` -- 6 input paths, 6 output paths
  - `src/runtimes/agent/providers/gemini-acp-parser.ts:59` -- exact duplicate of gemini-parser
- **Fix:** Move to `parser-utils.ts` with the 6-path superset. Extra paths are harmless for codex (they simply won't match).

### 1.3 ToolCategory type defined in two files (out of sync)
- **Confirmed by:** 2 agents | **Est. savings:** ~15 lines | **Confidence:** HIGH
- **What:** `ToolCategory` is a discriminated union type defined independently in two files with different members. outbound-queue.ts has 12 members; tool-mapping.ts has 8. They are already out of sync.
- **Where:**
  - `src/runtimes/agent/outbound-queue.ts:13` -- 12 members
  - `src/runtimes/agent/providers/tool-mapping.ts:8` -- 8 members
- **Fix:** Define canonical `ToolCategory` in `tool-mapping.ts` (the domain module) with the union of all members. Have outbound-queue.ts import it.

### 1.4 Remove dead code: upsertAllowed (zero external callers)
- **Confirmed by:** 3 agents | **Est. savings:** ~8 lines | **Confidence:** HIGH
- **What:** `upsertAllowed` has zero external callers. The upsert semantic is already provided by `upsertAccess`. Meanwhile `insertAllowed` (called from main.ts) handles the insert path.
- **Where:** `src/core/access-list.ts:55`
- **Fix:** Delete `upsertAllowed`. If upsert semantics are needed later, `upsertAccess` already exists.

### 1.5 Remove dead code: extractPhone deprecated alias (zero callers)
- **Confirmed by:** 2 agents | **Est. savings:** ~4 lines | **Confidence:** HIGH
- **What:** `extractPhone` is an explicit deprecated alias for `extractLocal` with zero callers anywhere in the codebase.
- **Where:** `src/core/access-list.ts:126`
- **Fix:** Delete the line `export const extractPhone = extractLocal`.

### 1.6 resolvePhoneFromJid duplicates extractLocal's try-catch pattern
- **Confirmed by:** 2 agents | **Est. savings:** ~5 lines | **Confidence:** HIGH
- **What:** The non-LID branch of `resolvePhoneFromJid` reimplements the same try-toConversationKey-catch-slice pattern that `extractLocal` already provides.
- **Where:** `src/core/access-list.ts:149` (lines 163-168 duplicate extractLocal logic)
- **Fix:** Replace lines 163-168 with `return extractLocal(jid)`.

### 1.7 SSE helpers (endOnce + writeSSE) duplicated across fleet routes
- **Confirmed by:** 3 agents | **Est. savings:** ~15 lines | **Confidence:** HIGH
- **What:** Identical `endOnce` (double-end guard) and `writeSSE` (event formatter) closures in two fleet route files. `writeSSE` is byte-for-byte identical.
- **Where:**
  - `src/fleet/routes/ops.ts:645` (endOnce), `src/fleet/routes/ops.ts:653` (writeSSE)
  - `src/fleet/routes/update.ts:52` (endOnce), `src/fleet/routes/update.ts:55` (writeSSE)
- **Fix:** Extract `createSSEWriter(res, onCleanup?)` factory into `src/fleet/sse-helpers.ts`. Returns `{ writeSSE, endOnce }`.

### 1.8 Chat provider error handling duplicated (anthropic.ts / openai.ts)
- **Confirmed by:** 5 agents | **Est. savings:** ~25 lines | **Confidence:** HIGH
- **What:** The catch block in both chat providers is structurally identical: classifyApiError -> switch on errorType -> throw AppError. Only the provider name string differs.
- **Where:**
  - `src/runtimes/chat/providers/anthropic.ts:56`
  - `src/runtimes/chat/providers/openai.ts:60`
- **Fix:** Extract `handleApiError(err, providerName, model, startMs, logger)` into `src/runtimes/chat/providers/api-error-classifier.ts` (already the home for classifyApiError).

### 1.9 INSTANCE_CONFIG parsed from env twice in main.ts
- **Confirmed by:** 2 agents | **Est. savings:** ~2 lines | **Confidence:** HIGH
- **What:** `process.env.INSTANCE_CONFIG ? JSON.parse(process.env.INSTANCE_CONFIG) : null` appears twice -- once inside `acquireLock()` (line 145) and once at module level (line 181).
- **Where:** `src/main.ts:145` and `src/main.ts:181`
- **Fix:** Parse once at the earliest point and pass the result to `acquireLock`.

### 1.10 stopTyping / abortTyping are the same method with a flag
- **Confirmed by:** 2 agents | **Est. savings:** ~10 lines | **Confidence:** HIGH
- **What:** Both clear the typing interval. `stopTyping` additionally sends a 'paused' presence update. They are private methods on the same class.
- **Where:**
  - `src/runtimes/agent/outbound-queue.ts:402` (stopTyping)
  - `src/runtimes/agent/outbound-queue.ts:451` (abortTyping)
- **Fix:** Merge into `stopTyping(notify = true)`. Update the one call site for abortTyping to pass `false`.

---

## Priority 2: Medium Effort (1-2 hours each)

### 2.1 MCP sock tool factory -- eliminate ~920 lines of boilerplate
- **Confirmed by:** 6 agents | **Est. savings:** ~920 lines | **Confidence:** HIGH
- **What:** 35+ MCP tool handler functions across 6 files follow an identical template: parse zod schema -> getSock() -> null check -> await sock.methodName(args) -> return result. The boilerplate-to-logic ratio is extreme (~20 lines boilerplate per 2 lines of actual logic). groups.ts additionally wraps in redundant try/catch.
- **Where:**
  - `src/mcp/tools/newsletter.ts` -- 15 tools (~375 lines of boilerplate)
  - `src/mcp/tools/groups.ts` -- 19 tools (~520 lines, includes redundant try/catch)
  - `src/mcp/tools/community.ts` -- 8 tools (~200 lines)
  - `src/mcp/tools/profile.ts` -- 5 tools (~100 lines)
  - `src/mcp/tools/business.ts` -- 5 tools (~100 lines)
  - `src/mcp/tools/advanced.ts` -- 2 tools (~30 lines)
- **Fix:** Create `makeSimpleSockTool<T>({ name, description, schema, replayPolicy, sockMethod, buildArgs?, buildResult? })` factory in `src/mcp/tools/sock-tool-factory.ts`. Subvariants:
  - `makeJidSockTool()` for the 8+ tools that take only a JID
  - `makeJidFieldSockTool()` for tools that take JID + one string field
  - `makeBase64ImageSockTool()` for the 3 picture-upload tools
  - Remove redundant try/catch from groups.ts (MCP framework handles errors)
  - Each tool becomes a 3-7 line config object instead of 15-25 lines

### 2.2 HTTP API provider base class (anthropic-api.ts / openai-api.ts)
- **Confirmed by:** 6 agents | **Est. savings:** ~300 lines | **Confidence:** HIGH
- **What:** `AnthropicApiProvider` (424 lines) and `OpenAIApiProvider` (369 lines) share ~80% structural identity. Identical: constructor shape, initialize() lifecycle, sendTurn() tool loop with MAX_TOOL_ITERATIONS=20, SSE reader pattern (TextDecoder + sseBuffer + line splitting), shutdown()/kill()/buildEnv(), getCheckpoint(). Both even have identical "Tool execution not yet wired" placeholder comments.
- **Where:**
  - `src/runtimes/agent/providers/anthropic-api.ts:67` (424 lines)
  - `src/runtimes/agent/providers/openai-api.ts:69` (369 lines)
- **Fix:** Extract `HttpApiProvider` base class with the shared lifecycle. Parameterize via strategy object: `{ endpoint, authHeader, buildRequestBody, parseSSEChunk, buildToolResultMessages, envVarName, defaultModel }`. Each provider becomes a thin subclass providing only its strategy. Also makes adding new OpenAI-compatible providers (Azure, Ollama, vLLM) trivial.

### 2.3 buildChildEnv() triplicated across session and providers
- **Confirmed by:** 4 agents | **Est. savings:** ~40 lines | **Confidence:** HIGH
- **What:** Three separate functions construct identical base environment objects (11 system vars: PATH, HOME, USER, SHELL, LANG, TERM, NODE_PATH, XDG_RUNTIME_DIR, XDG_CONFIG_HOME, XDG_DATA_HOME, SUDO_ASKPASS), then add provider-specific vars. The claude.ts copy has a comment explicitly acknowledging the duplication.
- **Where:**
  - `src/runtimes/agent/session.ts:70` -- master version with provider switch
  - `src/runtimes/agent/providers/claude.ts:53` -- comment: "intentionally duplicated until SessionManager is wired"
  - `src/runtimes/agent/providers/opencode-adapter.ts:92` -- opencode-specific copy
- **Fix:** Extract `buildBaseChildEnv()` into a shared module. Each provider calls it and spreads provider-specific vars. Remove the switch in session.ts by delegating to each provider's own `buildEnv()` method.

### 2.4 Codex legacy parser functions (~80 lines removable)
- **Confirmed by:** 5 agents | **Est. savings:** ~80 lines | **Confidence:** MEDIUM
- **What:** Six legacy functions mirror modern parser functions with snake_case vs camelCase field names: `extractLegacyToolInput`, `extractLegacyToolResultContent`, `isLegacyToolItemType` + their modern counterparts. All in the same file.
- **Where:** `src/runtimes/agent/providers/codex-parser.ts` -- lines 342, 366, 385 (legacy) mirror lines 17, 54, 86 (modern)
- **Fix:** Check if legacy format is used in production or only test fixtures. If test-only, migrate fixtures to modern format and delete the legacy functions. If production, parameterize with a naming convention map.

### 2.5 Fleet route validation logic duplicated in ops.ts
- **Confirmed by:** 3 agents | **Est. savings:** ~60 lines | **Confidence:** HIGH
- **What:** `handleConfigUpdate` and `handleCreateLine` in ops.ts contain byte-for-byte identical validation blocks: numeric bounds (rateLimitPerHour 1-10000, maxTokens 256-200000, tokenBudget 1000-10000000), cwd confinement checks (4 sites), pluginDirs path validation (2 sites), adminPhones normalization (2 sites), and claudeDir mkdir+write patterns (5 sites).
- **Where:** `src/fleet/routes/ops.ts` -- scattered across handleConfigUpdate (lines 176-273) and handleCreateLine (lines 438-572)
- **Fix:** Extract helpers within ops.ts:
  - `validateConfigFields(body, res): boolean` -- numeric bounds + accessMode enum
  - `resolveAndValidateCwd(ao): string | null` -- resolve + homedir confinement
  - `validatePluginDirs(dirs, res): boolean` -- path validation
  - `normalizeAdminPhones(phones): string[]` -- dedup + E164
  - `ensureClaudeDir(cwd): string` -- mkdir + return path

### 2.6 Cache-with-TTL pattern repeated 5 times in lines.ts
- **Confirmed by:** 2 agents | **Est. savings:** ~50 lines | **Confidence:** HIGH
- **What:** Five functions in `lines.ts` use identical cache-check/query/store logic: get from Map -> check cachedAt vs DAILY_CACHE_TTL -> if miss, run DB query -> store with cachedAt -> return.
- **Where:** `src/fleet/routes/lines.ts` -- getTotalSessions:89, getMessageStats:109, getChatCounts:158, getTokenStats:185, getLastMessageTime:222
- **Fix:** Extract `cachedQuery<T>(cache: Map, key: string, ttl: number, queryFn: () => T): T` helper. Each function becomes a one-liner.

### 2.7 Validation constant Sets duplicated (SSOT violation)
- **Confirmed by:** 2 agents | **Est. savings:** ~6 lines | **Confidence:** HIGH
- **What:** `VALID_TYPES`, `VALID_ACCESS_MODES`, `VALID_SESSION_SCOPES` are defined identically in two files. If a new type/mode is added, both must be updated.
- **Where:**
  - `src/instance-loader.ts:16-18` (ReadonlySet)
  - `src/fleet/routes/ops.ts:390,457,471` (plain Set)
- **Fix:** Export from a single source (`src/core/instance-types.ts` or re-export from instance-loader.ts). Both files import from the shared location.

### 2.8 Inline JID construction bypasses toPersonalJid()
- **Confirmed by:** 2 agents | **Est. savings:** 0 lines (quality fix) | **Confidence:** HIGH
- **What:** Six sites use `` `${phone}@s.whatsapp.net` `` instead of the existing `toPersonalJid()` from jid-constants.ts. Hardcodes the domain string.
- **Where:**
  - `src/core/heal.ts:107`
  - `src/fleet/routes/ops.ts:41`
  - `src/runtimes/agent/runtime.ts:844, 868, 1497, 1509`
- **Fix:** Replace with `toPersonalJid(phone)` and add the import. Zero line savings but eliminates 6 hardcoded domain strings.

### 2.9 Group conversation key detection scattered with no helper
- **Confirmed by:** 2 agents | **Est. savings:** ~10 lines | **Confidence:** HIGH
- **What:** Six call sites reimplement group-key detection (checking `_at_g.us` or `@g.us`) and group-key-to-JID conversion inline. The reverse of `toConversationKey()` is missing.
- **Where:**
  - `src/fleet/routes/data.ts:82,89`
  - `src/fleet/routes/lines.ts:167`
  - `src/fleet/db-reader.ts:139`
  - `src/fleet/routes/ops.ts:40`
  - `src/fleet/group-resolver.ts:105`
- **Fix:** Add `isGroupConversationKey(key: string): boolean` and `conversationKeyToJid(key: string): string` to `src/core/conversation-key.ts`. Replace JS-side checks (SQL patterns cannot be consolidated).

---

## Priority 3: Large Refactors (half day+)

### 3.1 Typed Baileys socket interface to eliminate 77+ `(sock as any)` casts
- **Confirmed by:** 2 agents | **Est. savings:** 0 lines (adds ~50 lines of interface, removes 0) | **Confidence:** HIGH
- **What:** 77+ `(sock as any).methodName(args)` casts across 7 MCP tool files. This is the single largest type-safety gap in the codebase. Every Baileys method call in the MCP layer is untyped.
- **Where:**
  - `src/mcp/tools/newsletter.ts` -- 20 casts
  - `src/mcp/tools/business.ts` -- 18 casts
  - `src/mcp/tools/community.ts` -- 16 casts
  - `src/mcp/tools/advanced.ts` -- 10 casts
  - `src/mcp/tools/profile.ts` -- 8 casts
  - `src/mcp/tools/chat-operations.ts` -- 4 casts
  - `src/mcp/tools/calls.ts` -- 1 cast
- **Fix:** Create `ExtendedSocket` interface in `src/mcp/types.ts` declaring all Baileys methods used by MCP tools. Use as the `sock` parameter type in tool factories. Combine with the sock tool factory (finding 2.1) for maximum impact -- the factory can accept `ExtendedSocket` and each tool config just names the method.

### 3.2 Database migration table-import helper
- **Confirmed by:** 3 agents | **Est. savings:** ~75 lines | **Confidence:** MEDIUM
- **What:** `importFromLegacyDb` and `migrateFromOldDb` in database.ts contain repeated patterns: (1) 5 identical `SELECT changes() AS n` blocks, (2) 4 identical `PRAGMA table_info` column-existence checks, (3) repeated table-exists-check -> INSERT OR IGNORE -> count pattern.
- **Where:** `src/core/database.ts` -- lines 373-660
- **Fix:** Extract `hasColumn(db, table, column): boolean` and `migrateTable(db, tableName, insertSql): number` helpers. Migration code is lower priority but these helpers reduce error risk for future migrations.

### 3.3 Pinecone search method proliferation
- **Confirmed by:** 2 agents | **Est. savings:** ~15 lines | **Confidence:** MEDIUM
- **What:** Four thin wrappers (searchForChat, searchForSender, searchSelfFacts, searchEntities) around `searchByField` which itself wraps `search`. Six public methods where two would suffice.
- **Where:** `src/runtimes/chat/providers/pinecone.ts:197-274`
- **Fix:** Remove the four one-liner wrappers. Callers use `searchByField(query, fieldName, fieldValue)` directly, or define named constants for common field names.

### 3.4 Tool mapper switch statements -> lookup tables
- **Confirmed by:** 2 agents | **Est. savings:** ~50 lines | **Confidence:** MEDIUM
- **What:** Four `mapToolName` implementations use 30-line switch/if-chains for static toolName -> ToolCategory mappings. Each could be a `Record<string, ToolCategory>` lookup.
- **Where:** `src/runtimes/agent/providers/tool-mapping.ts` -- lines 31, 93, 122, 152
- **Fix:** Replace each switch with a `Record<string, ToolCategory>` lookup table + a shared `mapToolFromTable(name, table, heuristic?)` function. Adding new providers becomes a 10-line config.

---

## Priority 4: Investigate (needs human judgment)

### 4.1 formatAge vs formatRelative -- server/client time formatting
- **Confirmed by:** 4 agents | **Confidence:** MEDIUM
- **What:** `formatAge` (session.ts:1066) and `formatRelative` (console/src/lib/format-time.ts:7) do the same ISO-to-relative-time conversion. formatRelative is strictly more capable (4 tiers vs 3, NaN guard, SQLite normalization).
- **Decision needed:** Can server code import from a shared `src/lib/time-utils.ts`? If so, consolidate around formatRelative's logic. If not, the duplication is acceptable.

### 4.2 ensureSessionAndQueue sync/async variants
- **Confirmed by:** 3 agents | **Confidence:** MEDIUM
- **What:** `ensureSessionAndQueue` (async, line 1703) and `ensureSessionAndQueueSync` (sync, line 1813) in runtime.ts may share significant logic. The sync variant may be a legacy workaround.
- **Decision needed:** Can the sync call site be made async? If so, remove the sync variant. If not, extract shared logic into a helper.

### 4.3 getActiveQueue vs getQueueForChat (17-line gap, same file)
- **Confirmed by:** 2 agents | **Confidence:** MEDIUM
- **What:** Both retrieve queues from the runtime. 17 lines apart in the same file. May differ only by a state filter predicate.
- **Where:** `src/runtimes/agent/runtime.ts:1622` and `src/runtimes/agent/runtime.ts:1639`
- **Decision needed:** If getActiveQueue is getQueueForChat + active filter, consider a single `getQueue(chatJid, { activeOnly? })` method.

### 4.4 Fleet route param casts -- 13 identical `(params as any)` wrappers
- **Confirmed by:** 2 agents | **Confidence:** MEDIUM
- **What:** 13 route table entries in fleet/index.ts wrap handlers in lambdas solely to cast `params as any`.
- **Where:** `src/fleet/index.ts:53-69`
- **Decision needed:** Fix the route table generic type to carry per-route param types, eliminating all 13 casts. This is a type-level refactor with no runtime change.

### 4.5 execFileAsync hand-rolls what Node provides natively
- **Confirmed by:** 2 agents | **Confidence:** HIGH
- **What:** `execFileAsync` in ops.ts manually wraps `child_process.execFile` in a Promise, when `child_process/promises` already provides this.
- **Where:** `src/fleet/routes/ops.ts:359`
- **Fix:** Replace with `import { execFile } from 'node:child_process/promises'`. Trivial but worth doing when touching that file.

### 4.6 Mock data log entries could use a factory
- **Confirmed by:** 2 agents | **Confidence:** LOW
- **What:** `logEntries`, `devbotLogs`, `loopsLogs` in mock-data.ts are separate declarations that could be generated by a parametric factory.
- **Where:** `console/src/mock-data.ts:815-883`
- **Decision needed:** Low priority -- mock data churn is low. Worth doing only if mock data is actively maintained.

---

## Appendix: Findings Confirmed as Non-Duplicates

The following were flagged by scanners but confirmed by multiple agents as intentionally separate. They are listed here for completeness to prevent re-flagging.

- **sendTurn x5** -- polymorphic provider interface implementations (anthropic-api, claude, openai-api, opencode-adapter, session)
- **handleMessage x3** -- runtime-polymorphic handlers (agent, chat, passive)
- **shutdown x12** -- layered shutdown hooks across the architecture
- **initialize x4** -- provider lifecycle hooks
- **enqueue x2** -- different queue types (agent vs chat)
- **flush x4** -- different resources (control queue, outbound queue, tool buffer, logger)
- **ensureSchema x2** -- different tables for different subsystems
- **bootstrap x3** -- intentional decomposition (common, auth, full)
- **isLidJid/isPnJid/isGroupJid** -- intentional one-liner type guards
- **toAnthropicMessage/toOpenAIMessage** -- provider-specific serializers
- **classifyToolError/classifyApiError** -- different error domains
- **truncateForRerank/truncate** -- different use cases (reranking vs UI display)
- **XDG path wrappers** (configRoot, dataRoot, stateRoot) -- intentional facade pattern
- **deleteOldMessages/cleanupOldRateLimits** -- different domains, tables, retention windows
- **acquireLock/acquireSlot** -- process lock vs concurrency semaphore
- **convertMcpToolsToOpenAI/convertMcpToolsToAnthropic** -- one-liner maps with different output types
- **getModelTag/getProviderTag/getProviderMismatchTag** -- UI tag generators with different logic
