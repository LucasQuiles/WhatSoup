# Phase 4: Real-Time & Performance

> **HISTORICAL — superseded by PR #310 (WS ticket + rotatable tokens) and PR #287 (HTTP API token auth). For current operator commands see `docs/runbook.md` and `docs/runbooks/`. Examples below referencing `~/.config/whatsoup/fleet-token` or `/ws?token=...` reflect the pre-rotation design and should not be used as guidance.**

**Status:** unknown — stalled at SPEC DRAFT stage; never became an SDLC epic. Kept for historical reference. _Originally marked "SPEC DRAFT — converging from team analysis"._  
**Date:** 2026-04-05  
**Contributors:** Q (orchestrator), Shannon (console analysis), BES Bot (polling analysis)

## Overview

Replace polling-based console updates with WebSocket push, add virtual scrolling for unbounded message lists, code-split the 671KB bundle, and optimize React Query caching.

## Current State

### Polling Architecture
| Hook | Endpoint | Interval | Purpose |
|------|----------|----------|---------|
| `useTyping()` | `GET /api/typing` | 2,000ms | Typing indicators |
| `useMessages()` | `GET /api/lines/:name/messages` | 3,000ms | Message history |
| `useLogs()` | `GET /api/lines/:name/logs` | 3,000ms | Structured logs |
| `useLines()` | `GET /api/lines` | 5,000ms | All instances |
| `useLine()` | `GET /api/lines/:name` | 5,000ms | Single instance |
| `useChats()` | `GET /api/lines/:name/chats` | 5,000ms | Chat list |
| `useFeed()` | `GET /api/feed` | 5,000ms | Activity feed |
| `useAccess()` | `GET /api/lines/:name/access` | on-demand | Access control |

### Bundle Size
- Single JS chunk: **671.7 KB** minified / **193.6 KB** gzip
- `mock-data.ts` (58 KB) bundled into production via static import
- Largest components: LineDetail (91KB), ConfigStep (40KB), Inbox (32KB)

### Message Rendering
- Initial fetch: 50 messages
- "Load older" appends 50 more per click
- **Effectively unbounded** — no virtual scrolling
- 1,000 messages = only 20 older-page loads

---

## Deliverables

### 4.1 — WebSocket Server (replace polling)

**Approach:** Node.js `ws` library on fleet server, upgrade handler on existing HTTP server.

**Implementation:**
1. Add `ws` dependency to package.json
2. Create `src/fleet/websocket-server.ts`:
   - Auth validation (reuse Bearer token from HTTP routes)
   - Client subscription management (subscribe to instance/conversation events)
   - Event broadcasting
3. Wire upgrade handler in `src/fleet/index.ts:349`
4. Emit events from HealthPoller status changes and instance proxied data

**Design Decision (team consensus):** Invalidation-first v1.
- WS events carry minimal routing metadata (`type`, `instance`, `conversationKey`/`key`)
- Console calls `queryClient.invalidateQueries()` on receipt — reuses existing HTTP fetch paths
- **Exception:** `typing_update` pushes full state (too latency-sensitive for refetch round-trip)
- After M4 structural sharing, consider hybrid full-payload push for active message streams

**Event Types:**
```typescript
// Invalidation events — trigger React Query refetch
type WsInvalidationEvent =
  | { type: 'instance_status'; instance: string }
  | { type: 'message_received'; instance: string; conversationKey: string; messagePk?: number }
  | { type: 'chat_updated'; instance: string; conversationKey: string }
  | { type: 'log_entry'; instance: string }
  | { type: 'feed_event'; instance: string }
  | { type: 'access_changed'; instance: string }

// Full-payload events — pushed directly into state
type WsPayloadEvent =
  | { type: 'typing_update'; instance: string; jid: string; composing: boolean; since: number }
```

**Console migration:**
- New `useWebSocket()` hook with auto-reconnect + graceful fallback to polling
- On WS event: `queryClient.invalidateQueries({ queryKey: [type, instance, ...] })`
- On `typing_update`: direct state update (bypass HTTP)
- On WS disconnect: resume polling intervals automatically

**Effort:** Medium (2-3 sessions)

### 4.2 — Code Splitting

**Priority order:**
1. **Mock data lazy import** — move `mock-data.ts` to dynamic `import()` only when fallback needed (biggest quick win: -58KB from main chunk)
2. **Route-level splitting** — `React.lazy()` for all page components in `App.tsx`:
   - `LineDetail` (91KB)
   - `Inbox` (32KB)  
   - `SoupKitchen` (19KB)
   - `Ops` (19KB)
3. **Modal/wizard splitting** — lazy load on open:
   - `AddLineWizard` + steps + QrDisplay + qrcode (16KB + deps)
   - `UpdateModal` (17KB)
   - `RelinkModal`

**Target:** Main chunk under 250KB minified (from 671KB).

**Effort:** Small (1 session)

### 4.3 — Virtual Scrolling

**Where needed:**
- `Inbox.tsx` message list (unbounded via "Load older")
- `LineDetail.tsx` history tab

**Approach:** `@tanstack/react-virtual` (same ecosystem as react-query)
- Virtualize message list with estimated row heights
- Keep scroll position stable during prepend (older messages)
- Maintain sticky-scroll-to-bottom behavior for new messages

**Effort:** Medium (1-2 sessions)

### 4.4 — React Query Structural Sharing

**Current gaps:**
- No `select` transforms — full response objects re-render on every poll
- No `structuralSharing` customization — default works but isn't optimized for message arrays with stable PKs
- No `useInfiniteQuery` — pagination is manual state management
- Search results in local state instead of query cache

**Improvements:**
1. Enable keyed structural sharing for `messages` (compare by `pk`)
2. Move pagination to `useInfiniteQuery` with `getNextPageParam`
3. Move search results into query cache for caching/dedup
4. Add `select` to hooks that only need subset of data

**Effort:** Small (1 session)

---

## Implementation Order

1. **Code splitting** (smallest effort, biggest immediate impact on load time)
2. **WebSocket server** (biggest architectural change, highest value for UX)
3. **Virtual scrolling** (needed for WS to work well — real-time messages grow lists fast)
4. **React Query optimization** (polish, after WS changes caching patterns)

## Milestones

| Milestone | Deliverable | Tests | Build |
|-----------|-------------|-------|-------|
| M1 | Mock data lazy + route splitting | Console tests pass | Bundle < 400KB |
| M2 | WS server + console hook | Fleet + console tests pass | WS connects |
| M3 | Virtual scrolling in Inbox + History | Scroll behavior tests | No regressions |
| M4 | React Query optimization | All hooks tested | Full suite green |

## Risks & Mitigations (from team review)

1. **WS auth gap:** Browser `WebSocket` can't send `Authorization` headers. **Mitigation:** Use `?token=` query auth (already supported by fleet SSE/EventSource paths).
2. **Event source gap:** No native inbound message event bus — fleet serves DB snapshots. **Mitigation:** HealthPoller already detects status changes; for messages, poll DB change counter or use SQLite WAL hook.
3. **Hot endpoints:** `/api/typing` fans out to every instance per request; `/api/feed` reparses logs. **Mitigation:** These are the highest-value WS targets — eliminate polling entirely.
4. **Missing protocol details:** Subscription scope, reconnect/resync, backpressure. **Mitigation:** Design in M2 spec — global subscription in v1, per-instance in v2.

## Design Decisions (team consensus 2026-04-05)

- **Library:** `ws` (not Socket.IO, not SSE)
- **Event model:** Invalidation-first v1 (small events trigger RQ refetch)
- **Exception:** `typing_update` pushes full payload (latency-sensitive)
- **Auth:** `?token=` query parameter (browser WS limitation)
- **Sequencing adjustment (BES Bot):** Merge `useInfiniteQuery` into M3 with virtual scrolling, not M4
- **Effort revised:** WS = medium-high (3-4 sessions), not medium (2-3)

## M2 WebSocket — Implementation Status (2026-04-05)

**Status: COMPLETE**

### Commits
| Task | Commit | Description |
|------|--------|-------------|
| 1 | `1d1faea` | Realtime publisher + ops mutation broadcasts |
| 2 | `1db0ae1` | Snapshot-diff event poller (messages/access/typing) |
| 3 | `611dd05` | Console WS client + RealtimeProvider |
| 4 | `c1786ba` | Conditional polling (disabled while WS connected) |
| 6 | `bebe70a` | Nav WS connection indicator (Live/Polling) |

### Verification Evidence
- **Focused WS tests:** `websocket-server` + `realtime-event-poller` + `websocket-events` = 22/22
- **Ops/realtime tests:** `ops` + `ops-config-patch` + `ops-settings-json` = 45/45
- **Full regression:** 182 files, 3,553 tests passing
- **Typecheck:** clean
- **Console build:** clean, split chunks preserved

### Task 5/7 Coverage Map
- Task 5 (verification): covered by green WS + poller + console event suites above
- Task 7 (close gate): all gate steps satisfied — focused tests, full regression, typecheck, build

### Residual Gaps
- Feed/log invalidations are coarse-grained (per-instance, not per-entry)
- No per-conversation message granularity in v1 (invalidates all messages for instance)
- `typecheck:all` has 76 pre-existing strict-mode errors in runtime/core test files (not M2-related)

## RAG Context

RAG_DEGRADED: Plan authored from direct codebase analysis by 3 agents (Q, Shannon, BES Bot) with full file access. No Pinecone retrieval needed — all data sourced from live code reads of `console/src/hooks/use-fleet.ts`, `src/fleet/index.ts`, `src/fleet/health-poller.ts`, `console/src/lib/api.ts`, and `npm --prefix console run build` output. Team consensus captured in WHATSOUP group chat.
