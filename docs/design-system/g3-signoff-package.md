# G3 Sign-Off Package — SOUP Design System v3

Status: **APPROVED 2026-06-11** — implementation authorized under the operator driver. Approval format:
`Approved G3 on YYYY-MM-DD: specs/enforcement/cutover accepted; implementation proceeds under the operator driver.`

## What is being signed off

| Artifact | Location | State |
|---|---|---|
| Token SSOT (180-token disposition, dual themes, OkLCh method, alias schedule) | `03-spec/tokens-v3.md` | v3.0.0-draft complete |
| Foundations (color/typography/layout-density/motion/interaction/iconography/brand) | `03-spec/*.md` | complete |
| Component specs ×13 (incl. drawer squeeze rule, table both-densities, log-stream, toolbar) | `03-spec/components/` | complete |
| Lint plan (22-rule catalog, 7-state lifecycle, 5-field waiver policy, 15-check regression suite) | `04-enforcement/lint-plan.md` | complete |
| Cutover plan (C0–C4 reversible, rehearsal rule, 8-axis visual QA matrix, rollback per phase) | `05-cutover/cutover-plan.md` | complete |
| Branding touchpoints (exhaustive, every hit tagged, 3 unknowns queued) | `05-cutover/branding-touchpoints.md` | complete |
| Implementation QA hardening (omission audit, negative paths, drift sentinels, coverage, debt, exceptions) | `06-implementation/qa-hardening.md` | binding add-on |
| Decision log (G1, G2 Option-A conditional lock, T8 declined-superseded) | `02-directions/decision-log.md` | current |
| Evidence ledger | `execution-log.md` | current |

All three G2 conditional items are resolved in spec: drawer squeeze-layout (container-query dual mode +
column-collapse priority, `components/drawer.md`), nameplate tuning (tracking cancellation + optical
centering, `brand.md`), utility/spec-smell disposition (Stack/Cluster/Container/Prose primitives +
forbidden-pattern list, `tokens-v3.md` §8).

## Unresolved risks and open decisions

1. **Light-theme AA failures in the locked mockup values** — four pairs fail; binding fixes are specified
   in `color.md` (ok/warn/passive wash-fg darkened; `--text-3` → `#7C8490`). The spec is authoritative;
   v2.html still carries pre-fix hexes (update at next mockup touch).
2. **Four existing infinite animations** (`breathe-ring`, `breathe`, `typing-bounce`, `shimmer`) vs the
   single-ambient-budget law — ok-breathing is sanctioned; shimmer (loading) and typing-bounce need
   explicit disposition at the motion-polish stage; waivered until then (lint plan).
3. **Feed BEM styling** — fold into Card/Panel or charter as documented exception; decision owed at
   primitive-consolidation stage.
4. **Three branding unknowns** (does the server-side product name stay "WhatSoup"? generated agent
   CLAUDE.md phrasing; comment-header sweep scope) — queued in `branding-touchpoints.md`.
5. **`SoupKitchen` component/file rename** — recommended at C3/C4 with 4 src identifiers + 28 coupled
   test lines blast radius (mapped in branding audit).
6. **Stale program reference corrected:** `eslint-rules/` does not exist in the repo (the 106 design rules
   are inline `no-restricted-syntax`); custom AST rules will be created at `console/eslint-rules/` per
   lint plan.

## T8 disposition

Declined/superseded (recorded at G2): no throwaway spike; the C1 token-foundation stage provides
real-screen palette validation under full review.

## Verification matrix (program-level)

| Area | Verdict | Evidence |
|---|---|---|
| Worktree isolation | Pass | design branch only; main checkout untouched throughout |
| Docs-only scope | Pass | every commit under `docs/design-system/**` |
| Artifact completeness | Pass | all plan-tree artifacts exist (this file + readiness packet added under the implementation driver) |
| Assumptions A1–A12 | Pass/corrected | README table; A11 partially inconclusive (headless deep-scroll captures; real-browser review used) |
| Research discipline | Pass | reference library + digest + 4 reconciled operator seeds |
| Mockups & gates | Pass | 3 directions → G1 blend → v2 → G2 Option A |
| Token architecture | Pass | components reference semantic/component tokens only; 180/180 dispositioned |
| Theme parity | Pass w/ MUST-FIX | dual values everywhere; 4 light-theme fixes specified |
| Motion discipline | Pass | tokenized, reduced-motion contract, ambient budget law |
| Brand safety | Pass | protected identifiers tagged; UI-copy flips scheduled C3/C4 |
| Lint/cutover readiness | Pass | lifecycle, waivers, rollback, rehearsal rule all defined |

## Recommendation

**Sign off G3.** The design program is complete and implementation-ready. Implementation proceeds under
the operator driver (D0 readiness → D1 tokens → D2 primitives → D3 pilot → D4 screens → D5 motion →
D6 enforcement → D7 testing → D8 cleanup), mapped to cutover stages C0–C4, starting with the D0
readiness packet (`06-implementation/d0-readiness-packet.md`).
