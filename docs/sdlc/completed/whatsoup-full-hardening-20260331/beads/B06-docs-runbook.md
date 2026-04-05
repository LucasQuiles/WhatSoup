# Bead: B06-docs-runbook
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** docs/runbook.md
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** docs/sdlc/active/whatsoup-full-hardening-20260331/beads/B06-decision-trace.md
**Deterministic checks:** [file-exists]
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
No operational runbook exists. Information is scattered across handoffs, specs, and code.

Source files:
- `docs/handoff-2026-03-30-production-hardening.md` — observability + audit guide sections
- `docs/specs/2026-03-31-cutover-operations-design.md` — migration runbook
- `src/main.ts` — shutdown sequence, lock file, signal handlers
- `src/core/health.ts` — health endpoint behavior
- `src/transport/auth.ts` — re-pairing flow
- `deploy/whatsoup@.service` — systemd unit

## Output
`docs/runbook.md` containing:
1. Service management (start, stop, restart, status, logs)
2. Health endpoint reference (status meanings, degraded conditions)
3. Troubleshooting guide (common issues + diagnostic steps)
4. Recovery procedures (WhatsApp disconnect, auth expiry, stale socket, orphaned processes)
5. Admin operations (approve users, manage allowlist, re-enrich messages)
6. Database inspection (useful queries for `inbound_events`, `outbound_ops`, `messages`)
