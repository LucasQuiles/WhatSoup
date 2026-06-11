# D0 — Implementation Readiness Packet (first execution packet, for review)

Owned by the operator implementation driver. Status: **approved for implementation readiness; QA
hardening added before D1 execution.** No production files have been touched. D1 execution must use
the QA hardening protocol before any slice can be accepted.

## 1. Grounding (driver D0 requirements)

- **Specs read and final:** `03-spec/` (21 files), `04-enforcement/lint-plan.md`, `05-cutover/*`,
  decision log, research seeds 1–4. No accepted decision lives only in the mockup (verified by the
  180-token disposition table).
- **Repo state re-verified (2026-06-11):** design worktree `soup-design` @ `design/soup-rebrand`,
  clean; main checkout untouched on its own branch. Console scripts: `dev`, `build` (tsc -b && vite
  build), `lint` (eslint, husky pre-push at --max-warnings 0), root `npm test` (vitest), `typecheck`.
- **Counts re-verified same-day (T1/T2):** 60 components, 4 pages, 9 LineDetail tabs, 1,236-line
  `index.css` with 180 custom properties, 106 design-lint selectors, 113 test files, 27 branding
  lines in console/src (full audit in `05-cutover/branding-touchpoints.md`).
- **Corrections found during grounding:** `eslint-rules/` directory does not exist (stale program
  reference); Nav wordmark is split-span and grep-invisible; four infinite animations exist against
  the ambient budget law. All dispositioned in the lint plan / G3 package.

## 2. Branch and worktree strategy (proposal)

- **New implementation worktree:** `WhatSoup-wt/soup-impl`, branch `feat/soup-v3-foundation`,
  created off `origin/main` at D1 start. The design worktree stays docs-only and remains the spec SSOT.
- One branch per cutover stage thereafter (C0/C1 may share `feat/soup-v3-foundation`; C2+ get
  per-stage branches), one PR per stage, single-concern rule, one-commit revert as rollback.
- No push/PR/deploy/merge without explicit operator approval (standing guardrail).

## 3. Pilot slice selection (driver D3, chosen now for planning)

**Pilot = Fleet table + toolbar + status chips, with the drawer/inspector and its scoped log stream.**
Rationale: exercises the largest share of the locked system in one slice — both table densities,
toolbar anatomy, shape-coded status law, semantic tokens in both themes, drawer squeeze-layout rule,
log-stream block, loading/empty/error/degraded states — while staying inside one page (`SoupKitchen.tsx`
+ table/toolbar components) and its tests. It is also the "dense" leg of the binding cutover rehearsal
(dense Fleet / expressive Inbox / transactional wizard) so rehearsal evidence accrues immediately.

## 4. First implementation slices (D1 execution packets, pending approval)

| Slice | Scope | Files (expected) | Verification |
|---|---|---|---|
| D1.1 | CSS split + alias layer (C0): `tokens.primitive.css` / `tokens.semantic.css` / `tokens.component.css` / `composites.css`; legacy aliases; zero visual change | `console/src/index.css` → `console/src/styles/*` + import shim | `npm --prefix console run lint && build`, `npm test`, both-theme screenshot diff ≈ zero |
| D1.2 | Semantic token values land (C1): dual `[data-theme]` value sets incl. the four AA must-fix values; theme toggle wiring | `styles/tokens.semantic.css`, small Nav addition | same + manual both-theme review of all 4 pages |
| D1.3 | Lint shadow stage: regression-suite greps + first soup/* rules at report-only | `console/eslint.config.js` (+`console/eslint-rules/` scaffold) | `lint` green, violation baseline recorded |

## 5. Migration checklist pointer

The per-stage checklists, acceptance criteria, visual QA matrix (8 axes), rehearsal rule, and rollback
procedures live in `05-cutover/cutover-plan.md` and are not duplicated here.

The per-slice omission audit, negative-path QA, visual drift sentinel, coverage matrix, design debt
register, exception aging, ambiguity protocol, cross-surface consistency audit, manual QA scripts,
and final design acceptance rubric live in `06-implementation/qa-hardening.md`. That protocol is
binding for every D1+ implementation slice.

## 6. Stop conditions (inherited, binding)

Backend/protocol behavior changes, protected `WhatSoup` identifier risk, main-checkout edits,
push/PR/deploy, new production dependencies, locked-direction unworkability, unrelated-refactor
pressure, unexplained lint/test failures, visual drift from v2 Blend, or a11y-driven interaction
changes beyond spec → stop and ask.

## 7. Acceptance (D0)

- [x] Implementation path aligned to locked v2 Blend + specs.
- [x] First change and rationale explained (D1.1 above).
- [x] QA hardening protocol added: `06-implementation/qa-hardening.md`.
- [x] Zero production changes made during readiness.
- [ ] Before D1 begins, the implementation agent must use `qa-hardening.md` as the slice evidence
      template and may not accept a slice without PASS or documented non-PASS verdicts across every
      required review dimension.
