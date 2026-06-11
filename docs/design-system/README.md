# SOUP Design System v3 — Design Program

Design-phase program: inventory, research, mockups, specs, enforcement plan, and cutover plan
for rebranding the WhatSoup console UI to **SOUP** and formalizing Design System v3
(dual dark/light themes, primitive → semantic → component token architecture).

**Scope: docs/mockups/specs only. No production implementation.** Implementation requires a
separate plan after G3 sign-off. Plan SSOT lives in the operator's local plans directory
(`let-s-review-the-current-woolly-turtle.md`).

- Branch: `design/soup-rebrand` (dedicated worktree `soup-design`), base `0ff1fe0a` (origin/main, 2026-06-11)
- Predecessor: Design System v2 — `docs/console-mockups/` (April 2026). This program supersedes it.

## Status

| Task | Description | Status |
|---|---|---|
| T1 | Worktree, discovery, scaffold | ✅ Complete |
| T2 | Inventory, IA, workflow, DRY audit | ✅ Complete |
| T3 | Research + reference library (+motion addendum, +synthesis seed) | ✅ Complete |
| T4 | Three direction mockups | ✅ Complete |
| **G1** | **Direction selection gate** | 🔶 **OPEN — awaiting user review** |
| T5 | Winner refinement | ⬜ Blocked on G1 |
| **G2** | **Visual/spec lock gate** | ⬜ Awaiting user |
| T6 | Formal design-system spec | ⬜ Blocked on G2 |
| T7 | Enforcement + cutover plans | ⬜ Blocked on G2 |
| T8 | Optional throwaway token spike | ⬜ Blocked on G2 + explicit approval |
| **G3** | **Design program sign-off** | ⬜ Awaiting user |

## Gate decisions

_None recorded yet. Format: `Approved G<N> on YYYY-MM-DD: <decisions>`._

## User decisions (locked 2026-06-11)

1. **Naming voice:** professional, calm, precise, slightly distinctive/playful-ambiguous. Candidate vocabularies mocked in T4; locked at G1/G2.
2. **Brand scope:** console UI only. All protocol/internal/system-prompt `WhatSoup` identifiers stay.
3. **Theme scope:** dual dark + light, both first-class designs (light is not an inversion).
4. **Creative stance:** serious industrial polish, Apple-level consistency, dense operator-console usability, restrained motion, enforceable discipline.

## Verified assumptions (T1, 2026-06-11, @ 0ff1fe0a)

| ID | Claim | Verified |
|---|---|---|
| A1 | Stack | ✅ React 19.2.4, Vite 8.0.11, Tailwind 4.2.2, TS 5.9.3, react-router-dom 7.13.2, framer-motion 12.38.0, lucide-react 1.7.0, recharts 3.8.1 |
| A2 | Console LOC | ✅ 17,971 (`find console/src -name '*.ts' -o -name '*.tsx' -o -name '*.css' | xargs wc -l`) — plan's 16.7K was stale |
| A3 | Components | ✅ 60 `.tsx` under `console/src/components/**` |
| A4 | Pages | ✅ 4 (`Inbox`, `LineDetail`, `Ops`, `SoupKitchen`); tab count verified in T2 |
| A5 | index.css | ✅ 1,236 lines; token definition census in T2 (raw `--` grep = 553 occurrences incl. references) |
| A6 | ESLint design rules | ⚠️ 106 `selector:` restriction rules in 707-line `console/eslint.config.js` — plan's "150+" was stale |
| A7 | v2 mockups | ✅ 6 files in `docs/console-mockups/` (no README/index there — forward pointer skipped, gap logged) |
| A9 | Tests | ⚠️ 113 test files under `tests/console/` — plan's "120+" was stale |
| A10 | mock-data | ✅ `console/src/mock-data.ts`, 1,652 lines |
| A12 | Scripts | ✅ console: `dev`, `build` (tsc -b && vite build), `lint` (eslint .), `preview` |

A8 (branding occurrences) and A11 (screenshot tooling) verified during T2/T4.

## Artifact map

- `00-inventory/` — component inventory, control catalogue, IA/workflow review, duplication register, token census, inconsistency register (T2)
- `01-research/` — reference library + research digest (T3)
- `02-directions/` — direction mockups A/B/C, comparison launcher, iterations, decision log (T4/T5)
- `03-spec/` — tokens v3, typography, color, layout/density, motion, interaction, iconography, component specs, brand (T6)
- `04-enforcement/lint-plan.md` (T7)
- `05-cutover/` — cutover plan + branding touchpoints (T7)
- `execution-log.md` — per-task evidence log
