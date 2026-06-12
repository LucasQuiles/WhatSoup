# D6 Pre-Investigation Survey — enforcement promotion + waiver audit

Analysis snapshot (2026-06-12) feeding the D6 A0 packet. CORRECTIONS applied to the raw
agent analysis: check-theme-parity.mjs EXISTS and runs in every slice battery (the raw
report claimed otherwise); WVR-010 was retired same-day (UpdateModal SSE payload typed,
suppression + registry entry removed — commit on feat/soup-v3-foundation).

## Waiver audit (registry now WVR-001..009, 011)

- TRIGGER-FIRED (cleanup due with their owning slices): WVR-001/003/007 (chart-utils —
  chart theming consolidation, C3), WVR-002/004 (QrDisplay — verify whether the QR
  surface migrated; packet must check), WVR-011 (ConfigStep mount-only effect — wizard
  slice B2/B3).
- STILL-VALID: WVR-005/006 (sanctioned infinite animations, C5 motion disposition),
  WVR-008 (HMR limitation), WVR-009 (react-virtual library gap, external).
- RETIRED: WVR-010 (2026-06-12, ahead of its 2026-07-01 expiry).

## Promotion readiness

- Shadow selectors ready for scoped-error on MIGRATED dirs (their buckets there are 0):
  no-raw-button, no-adhoc-modal, no-raw-table, no-raw-sortable-header, no-legacy-log-lanes,
  no-focus-suppression (only 2 hits total, both composers). Sequence per cutover order;
  every promotion REQUIRES a negative fixture first (lint-plan lifecycle) — fixture
  coverage today is the biggest gap (only the C2.3 tripwires were probe-proven; no
  committed design-lint fixture suite exists).
- KEEP SHADOW: no-legacy-tokens (large burn-down, gated to alias-layer completion),
  no-utility-smell, no-raw-form-control (until form-kit lands).
- design-regression: candidates for the blocking list (EXIT_ON_FAIL) once D6 opens:
  checks 1, 2, 6, 8, 10, 13, 14, 16 (all PASS-stable today); 3/4/5/7/12 stay gated to
  their phase milestones (C4 branding, composer migration).

## Wiring proposal (P6)

CI: add design-regression.sh as a non-blocking always-run step in quality.yml first
(baseline visibility), then flip EXIT_ON_FAIL entries per promotion. Pre-push: gated run
when console/ files changed. The repo-level fitness ring (eslint-rules/ on main) is a
separate domain — do not couple.

## D6 packet must-dos

1. Negative-fixture suite (tests/console/design-lints/) BEFORE any promotion.
2. Verify QrDisplay migration state (WVR-002/004 disposition).
3. Per-directory scoped-error flip sequence mirroring the cutover order.
