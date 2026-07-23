# 2026-07-23 Suspend and Platform Hardening

## Public surface additions

- `GET /health` now includes
  `event_loop.discontinuity_count`, a saturating process-local diagnostic for
  monotonic scheduling gaps above the 10-second retained observation window.
- `npm run validate-private-operation-record` adds a read-only schema and
  validation surface for private schema-v1 host-operation receipts. The command
  emits one content-free JSON result and uses exit `0` for valid, `1` for
  actionable record failures, and `2` for infrastructure/read failures. The
  published contract uses closed action/evidence/error registries and the
  runtime adds fail-closed step ordering, cross-step chronology, strict
  calendar-valid RFC 3339 timestamps, action-specific proof, and rejection of
  formatted phone-like target IDs.

## Behavioral changes

- Event-loop health discards suspend-sized gaps rather than retaining them as
  starvation evidence. Exactly 10 seconds is still retained, and the existing
  nearest-rank p95 threshold remains strictly greater than 250 ms.
- Continuous starvation warnings repeat at most every five monotonic minutes;
  recovery and re-entry warn immediately. Health evaluation is never
  suppressed.
- Generated macOS instance plists pin `WorkingDirectory` to the reviewed
  checkout. A trimmed non-empty `WHATSOUP_REPO_ROOT` wins over cwd for ARC
  health and never silently falls back when invalid.
