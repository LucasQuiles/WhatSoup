# P8b Admission Invariant — ruling record (#2822)

Ruled 2026-08-27 (owner decision, merge-gate burn-down campaign). This document
records the semantic choice that unblocked the P8b residual of #2084, per the
precedent of the #2601 design-doc record for the prior semantic stop.

## The question

`classification-admission.ts` (P8b, held on the #2084 anchor) captures a
`Uint8Array` at load time. Main, since #2309, uses a global-reader pattern for
comparable byte access. The two models disagree about WHEN the bytes being
classified are read, which changes what the admission check proves.

## The ruling

**Captured-Uint8Array-at-load.** Receipt bytes are snapshotted through pinned
intrinsics at the admission boundary (`snapshotReceiptBytes`), canonicalized,
digest-bound, and re-verified on every same-process admission match.

## Consequence for what admission verifies

- An admitted classification binds to the exact bytes presented at admission
  time. Use-time re-reads cannot substitute content; a caller that mutates its
  buffer after admission cannot alter what was admitted.
- Tampering with an admitted object's bytes is caught by the digest re-check in
  `matchesSameProcessRiskClassificationAdmission` (proven by mutation control:
  removing the re-check fails the receipt-byte tamper test).
- The load-time snapshot copy additionally defends cross-thread TOCTOU; that
  half is not observable single-threaded and is retained as defense in depth.

## Scope and residual

P8b landed the three modules (`classification-admission.ts`,
`execution-plan.ts`, `execution-kernel-preflight.ts`) with their anchor test
suites (preflight coverage lives inside `ci-control-execution-plan.test.ts`,
as on the anchor). Production adoption is a disclosed residual on #2822: on
the #2084 anchor, `drift-classify.ts` consumed the admission module; that
wiring did not port, so until a consumer is wired the invariant defends the
admission boundary, not a live pipeline.
