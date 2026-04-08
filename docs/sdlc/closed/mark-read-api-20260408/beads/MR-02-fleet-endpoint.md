# Bead: MR-02
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** MR-01
**Scope:** src/fleet/routes/ops.ts, src/fleet/routes/index.ts (or wherever routes are registered)
**Cynefin domain:** clear
**Profile:** BUILD
**Complexity source:** accidental
**Security sensitive:** false
**Decision trace:** docs/sdlc/active/mark-read-api-20260408/beads/MR-02-decision-trace.md
**Deterministic checks:** typecheck, vitest
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

**Input:** Fleet ops pattern (handleSend, handleAccessUpdate — both proxy to instance health server via proxyToInstance)

**Output:** POST /api/lines/:name/mark-read fleet endpoint that:
1. Resolves instance from name (same pattern as handleSend)
2. Reads { conversation_key } from request body
3. Proxies to instance health server POST /mark-read via proxyToInstance
4. Returns the proxied response

**Acceptance Criteria:**
- Handler follows handleAccessUpdate pattern exactly
- 404 if instance not found
- Proxies body to health server /mark-read
- Publishes publishFeedEvent after success (consistent with other ops)
- Route registered in fleet router
- Test: mock proxyToInstance, verify correct proxy call
