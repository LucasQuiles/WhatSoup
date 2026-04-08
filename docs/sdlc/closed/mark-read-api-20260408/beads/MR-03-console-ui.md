# Bead: MR-03
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** MR-02
**Scope:** console/src/lib/api.ts, console/src/pages/Inbox.tsx, console/src/hooks/use-fleet.ts
**Cynefin domain:** clear
**Profile:** BUILD
**Complexity source:** accidental
**Security sensitive:** false
**Decision trace:** docs/sdlc/active/mark-read-api-20260408/beads/MR-03-decision-trace.md
**Deterministic checks:** typecheck, eslint, vitest
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

**Input:** Console API pattern (api.restart, api.stopInstance), Inbox page structure (chat detail panel with quick actions)

**Output:**
1. `api.markRead(name: string, conversationKey: string)` in api.ts — POST to /api/lines/:name/mark-read
2. "Mark read" button in Inbox chat detail panel (next to Allow/Block actions)
3. On click: call api.markRead, optimistically set unreadCount to 0, invalidate ['chats', name] query
4. Button only shown when unreadCount > 0

**Acceptance Criteria:**
- api.markRead method follows existing POST pattern
- Button uses c-btn c-btn-sm design system classes
- Optimistic update: immediately set chat.unreadCount = 0 in React Query cache
- Toast on success/failure (follows existing Allow/Block pattern)
- Button hidden when unreadCount is 0
