# D6 Investigation Packet — enforcement promotion (scoped-error flips · EXIT_ON_FAIL · CI wiring · waiver dispositions)

Pre-implementation packet required by the working checklist (A0 gate). Implementation is
blocked until this packet carries a `Ready` or `Ready with Constraints` verdict. Scope:
promote shadow-stage design lints to scoped-error per the lint-plan lifecycle
(`04-enforcement/lint-plan.md` §2), promote PASS-stable design-regression checks to
EXIT_ON_FAIL, wire the suite into CI and pre-push, and disposition the waiver registry.
Sources: `d6-survey.md` (with its corrections applied and four further corrections found
here, §2), verified read-only against `soup-impl` @ `feat/soup-v3-foundation`
(`6f0e9289`, 2026-06-12) with live tool runs (§3).

## 1. Gate 0 output (placeholder)

Packet drafted read-only against the impl tree; standard gate 0 (worktree inventory,
lint, typecheck, full vitest run) executes at implementation start and is recorded in the
D6 evidence packet. Facts below are pinned with live runs dated 2026-06-12:
`design-regression.sh` (full suite), `check-shadow-baseline.mjs`, `guard:lint:src`,
`vitest run tests/console/design-lints.test.ts`.

**Dirty-tree warning (gate-0 blocker until coordinated):** `soup-impl` carries
uncommitted in-flight work — untracked `console/src/components/ChatList.tsx` +
`tests/console/chat-list.test.tsx`, modified `console/src/pages/Inbox.tsx`,
`console/src/components/ChatListItem.tsx`, `tests/console/chat-list-item.test.tsx`
(a ChatList extraction, B4-lane work). The shadow ratchet **fails on this tree today**
(`react-hooks/set-state-in-effect :: ChatList.tsx +2`,
`soup/no-legacy-tokens :: ChatList.tsx +1`) — entirely attributable to the untracked
WIP file, not to committed state. D6 implementation must start on a clean tree or
explicitly sequence after the B4 wave lands; any baseline regen on this tree would bake
WIP counts into the ratchet.

## 2. Survey claims — verified and corrected

| d6-survey.md claim | Verdict | Evidence |
|---|---|---|
| `check-theme-parity.mjs` exists and runs | CONFIRMED | `console/scripts/check-theme-parity.mjs`; regression check 9 PASS in today's run |
| WVR-010 retired | CONFIRMED | absent from `console/eslint-waivers.yaml` (registry now WVR-001..009, 011, 012) |
| "no committed design-lint fixture suite exists" (the blocking gap) | **CLOSED since survey** | `tests/console/design-lints.test.ts` committed (`1ccaa271`), 10 describe blocks covering all ten shadow rules, **46 tests, 46 passing** (run 2026-06-12, 892ms). The lint-plan promotion gate (§2: fixture before any rule leaves shadow) is satisfied for every selector in this packet |
| QrDisplay — "verify whether the QR surface migrated" | **PARTIALLY MIGRATED — WVR-004 retirable** | `QrDisplay.tsx` no longer contains any hex literal: it resolves `--color-t1`/`--color-d1` via `getComputedStyle` at render (the exact replacement plan WVR-004 named), landed in `7a592488` (D1.5 oversight remediation, 2026-06-11). Only the WVR-002 suppression (`margin: 2`, QR cell count) remains at `QrDisplay.tsx:17`. Caveat: it reads **legacy** token names — the v2-semantic re-point rides the alias-layer/no-legacy-tokens wave, not a waiver |
| chart-utils WVR-001/003/007 trigger-fired | **WVR-003 retirable; 001/007 keep** | zero hex literals remain in `chart-utils.ts` (grep verified) — WVR-003's subject is gone. Live suppressions: WVR-001 (`:10`), WVR-007 (`:14`); their trigger (C3 chart slice) has NOT landed |
| Shadow selectors "ready for scoped-error on MIGRATED dirs (their buckets there are 0)" | **PARTIALLY CORRECTED** | True for LineDetail/SoupKitchen pages, TagInput, CardSelector, ConfirmDialog, RelinkModal, SaveContactDialog, CreateGroupModal. **False for LinePicker** (`no-raw-button: 2`, `no-legacy-tokens: 2` remain) and **the pickers** (ChatPicker/ContactSearchPicker: `no-raw-button: 2` each + utility-smell + legacy tokens). Baseline `95ab4aa5` reduced LinePicker (4→2, 8→2) but did not zero it |
| no-focus-suppression "only 2 hits total, both composers" | CONFIRMED | baseline + regression check 12: `Inbox.tsx:434`, `HistoryTab.tsx:206` |
| design-regression checks 1, 2, 6, 8, 10, 13, 14, 16 "all PASS-stable today" | **CORRECTED — 6 of 8** | Live run 2026-06-12: checks 2, 6, 10, 13, 14, 16 PASS. **Check 1 emits WARN on both code branches** (it can never report OK as written — promoting it would fail every run) and its 9 current matches are all **false positives**: order/build/issue numbers (`#4921`, `#512`, `#237`, `#523`, `#420`) in `mock-data.ts` and block comments — the `#[0-9a-fA-F]{3,8}\b` regex matches pure-decimal IDs and the comment filter misses `* …` block-comment lines. Zero real hex colors remain in console TS/TSX. **Check 8 is vacuous**: it unconditionally reports OK (asserts a `<title>` line exists, never compares content; even the NOT-FOUND path reports OK) |
| repo fitness ring "separate domain — do not couple"; main-side fitness-ring red | CONFIRMED domain split; **red not reproducing** | `npm run guard:lint:src` today: 20 warnings, 0 errors — "passed (warnings are non-blocking)". The red recorded in `b2-evidence.md` / `execution-log.md` ("verify:push:branch RED on main-side fitness-ring findings in five server files") does not reproduce on `6f0e9289`. Coordination note in §8 |

Minor: lint-plan §5 says "15 labeled checks"; the script implements **16** (check 16
added at C2.3, `a24d09e5`). The lifecycle-table/lint-plan changelog should absorb this.

## 3. Current enforcement state (live-verified)

- **Shadow baseline:** `console/lint-shadow-baseline.json` total **563**, regenerated
  post-B2/B3-wave-1 at `95ab4aa5` ("ten buckets gone"). Ratchet is rule×file granular
  (`check-shadow-baseline.mjs`, keyed by the `[soup/...]` message-tag prefix).
- **Buckets at zero console-wide:** `soup/no-raw-table`, `soup/no-raw-sortable-header`,
  `soup/no-legacy-log-lanes` (no keys in the baseline; check 16 PASS confirms lane vars).
- **Migrated surfaces with zero structural buckets** (only shadow-staying rules remain):
  `pages/LineDetail.tsx` (legacy-tokens 7), `pages/SoupKitchen.tsx` (legacy-tokens 8),
  `TagInput.tsx` (form-control 1 — its own input, form-kit-gated), `CardSelector.tsx`
  (legacy-tokens 4), `ConfirmDialog.tsx` (legacy-tokens 1), `RelinkModal.tsx` (fully
  clean, no keys), `SaveContactDialog.tsx` (form-control 1 — relocated from Inbox by
  extraction), `line-detail/CreateGroupModal.tsx` (form-control 1, legacy-tokens 2).
- **`no-adhoc-modal` remaining buckets (5):** AddLineWizard, ConfigEditDialog,
  GroupDetailModal, ScheduleComposerModal, UpdateModal — all gated to later waves.
- **Primitives dir (`components/primitives/`, 11 components):** grep-verified clean of
  legacy tokens/utilities (`bg-d*`, `text-t*`, `var(--color-[dt]N)`, `var(--b1..4)`) and
  of non-`var()` arbitrary-value utilities. A strict primitives tier is zero-cost today.
- **Config composition (read from both configs):** `console/eslint.config.js` is flat
  config via `defineConfig`; per-file-list blocks REPLACE the `no-restricted-syntax`
  entry for matched files (last-match-wins) — the existing scheduled/groups block
  (`:688-706`) re-carries the full base array for exactly this reason.
  `eslint.config.shadow.mjs` spreads the base config, then a final warn-severity block
  (ignoring `components/primitives/**`) carries `dedupeSelectors([...baseSyntaxSelectors,
  ...shadowSyntaxRules])`, where `baseSyntaxSelectors` is flat-mapped from EVERY base
  block regardless of its `files` scope. Two consequences D6 must honor (§5).
- **Pre-commit:** lint-staged runs `eslint --max-warnings 0` on staged console files
  with the default config — promoted errors gate pre-commit automatically, no wiring.
- **Pre-push:** root `.husky/pre-push` → `scripts/pre-push-guard.ts` →
  `npm run verify:push:branch` (branch pushes) / `verify:release`. Neither currently
  invokes the design-regression suite. `quality.yml` has no design step either (console
  steps today: `npm --prefix console ci` + build).

## 4. Scoped-error flip list (what flips, where, fixture citations)

All selectors keep their `[soup/<rule>]` message-tag prefix (drop the ` SHADOW` suffix)
so the ratchet's tag-keying (`/^\[([a-z/-]+)[ \]]/`) stays continuous across promotion.

| Group | Selector(s) | Error scope | Current violations in scope | Fixture citation (tests/console/design-lints.test.ts) |
|---|---|---|---|---|
| **S — structural, console-wide** | `soup/no-raw-table`, `soup/no-raw-sortable-header`, `soup/no-legacy-log-lanes` | all `console/src` TS/TSX **except** `components/primitives/**` (Table/LogStream are the canonical renderers) | 0 (no baseline keys; check 16 PASS) | Rule 5 block (3 tests), Rule 4 block (3 tests), Rule 6 block (3 tests) — each with fire + compliant + exemption/negative case |
| **F — focus, console-wide with carve-out** | `soup/no-focus-suppression` | all `console/src` **except** `pages/Inbox.tsx`, `components/line-detail/HistoryTab.tsx` (the two composer hits; absorbed by their migration waves) | 0 outside the carve-out (check 12: exactly 2 hits, both carved out) | Rule 7 block (4 tests: fires solo + in compound class; silent when paired with `focus-visible:`; silent when absent) |
| **M — migrated surfaces** | `soup/no-raw-button`, `soup/no-adhoc-modal` (both prongs) | files: `pages/LineDetail.tsx`, `pages/SoupKitchen.tsx`, `components/TagInput.tsx`, `components/CardSelector.tsx`, `components/ConfirmDialog.tsx`, `components/RelinkModal.tsx`, `components/SaveContactDialog.tsx`, `components/line-detail/CreateGroupModal.tsx` | 0 (no baseline keys for these rules in these files) | Rule 1 block (3 tests incl. primitives exemption), Rule 2 block (5 tests, both prongs) |
| **P — primitives strict tier** | `soup/no-legacy-tokens` (all 3 selectors), `soup/no-utility-smell` | `components/primitives/**` only (born-clean enforcement) | 0 (grep-verified §3) | Rule 8 block (8 tests), Rule 9 block (6 tests). NOTE: shadow config exempts primitives, so these fixtures prove fire/silent semantics but not the primitives path — the promoted-path probe (§6) covers that |

**Explicitly NOT flipped** (each with reason): `no-raw-button`/`no-adhoc-modal` outside
the M list (LinePicker still at 2/2; pickers still dirty — survey correction §2);
`no-raw-form-control` everywhere (form kit not landed; TagInput/SaveContact each carry
their own input); `no-legacy-tokens` outside primitives (alias-layer gate, 180 refs +
319 utility hits live per checks 3/4); `no-utility-smell` outside primitives (lint-plan
ceiling is warn-on-changed-files); `soup/no-brand-regression` (flips to error in the
same PR as the C4/P4 copy flip — Nav split wordmark + UpdateModal:344 are live, by
design); all zero-fire stub rules (no behavior to promote).

## 5. Exact changes — mechanism (decided by reading how the configs compose)

**Mechanism: shared selector module + per-tier config blocks in `eslint.config.js`.**
A new scoped-error block is the established house pattern (the scheduled/groups block);
duplicating selector text between default and shadow configs is not acceptable, so the
promoted selectors move to a shared module both configs import.

1. **NEW `console/eslint-rules/design-selectors.mjs`** — exports named arrays with
   error-grade messages (tag prefix preserved): `structuralSelectors` (S),
   `focusSuppressionSelectors` (F), `migratedSurfaceSelectors` (M),
   `legacyTokenSelectors` + `utilitySmellSelectors` (P).
2. **`console/eslint.config.js`** — block layout (order is semantic; every block that
   declares `no-restricted-syntax` composes its FULL array from the named exports,
   because last-match-wins replaces, never merges):
   - Block 1 (base, all ts/tsx): `['error', ...designSystemRestrictions,
     ...structuralSelectors, ...focusSuppressionSelectors]`
   - Block 2 (composer carve-out: `pages/Inbox.tsx`, `line-detail/HistoryTab.tsx`):
     base + structural, WITHOUT focus selectors.
   - Block 3 (existing scheduled/groups list): existing array + `structuralSelectors`
     + `focusSuppressionSelectors` (must be re-carried or the block would silently
     strip them for its files).
   - Block 4a (M list minus CreateGroupModal): base + structural + focus + migrated.
   - Block 4b (`line-detail/CreateGroupModal.tsx` — the one file in BOTH the scheduled
     list and the M list): the full union (base + scheduled + structural + focus +
     migrated). It already passes the scheduled set at error today, so this is safe.
   - Block 5 (`components/primitives/**`): base + focus + legacyToken + utilitySmell —
     deliberately NO structural/migrated selectors (canonical-renderer exemption).
3. **`console/eslint.config.shadow.mjs`** — REMOVE the promoted entries from
   `shadowSyntaxRules` (S, F, M selectors; the legacy-token trio stays only if removed —
   see below). Rationale: `baseSyntaxSelectors` flat-maps selectors out of every base
   block (ignoring `files` scoping) into the shadow run at warn for ALL files, so
   promoted selectors keep producing shadow counts for not-yet-flipped files
   automatically. Leaving the old copies in `shadowSyntaxRules` would double-count every
   violation (the error-message text differs, so `dedupeSelectors` cannot collapse the
   pair) and inflate the ratchet. The legacy-token and utility-smell selectors likewise
   move out of `shadowSyntaxRules` (they now flow in via the primitives block).
4. **`console/lint-shadow-baseline.json`** — regen in the SAME commit (ratchet law).
   Expected: total unchanged or lower with identical keys (tag continuity), since the
   promoted selectors keep firing at warn in the shadow run for unflipped files and at
   zero for flipped files.
5. **`console/scripts/design-regression.sh`** —
   - `EXIT_ON_FAIL=(1 2 6 8 10 13 14 16)` (after the two check fixes below).
   - **Check 1 fix (precondition):** tighten the pattern to color contexts (require a
     quote-adjacent `#` and at least one `[a-fA-F]` OR 6/8-length form — the current
     pattern matches `#4921`-style decimal IDs), extend the comment filter to block-
     comment continuation lines, and emit `OK` at count 0 / `FAIL` above 0 (it can
     never currently report OK). Also update its stale echo line — "Waivered:
     chart-utils.ts (WVR-003), QrDisplay.tsx (WVR-004)" describes retired waivers (§7).
   - **Check 8 fix (precondition):** assert title content equals the pinned current
     value `<title>WhatSoup Console</title>` (FAIL on drift or missing), with the pin
     re-pointed in the C4 branding flip PR. Without this, promotion is theatre.
   - Checks 2, 6, 10, 13, 14, 16 promote as-is (live PASS, real FAIL paths).
6. **`console/eslint-waivers.yaml`** — dispositions per §7.
7. **`.github/workflows/quality.yml`** — after "Install console dependencies", two
   advisory steps (`continue-on-error: true`): `npm --prefix console run
   design:regression` and `npm --prefix console run lint:shadow:baseline`. Advisory for
   one full lifecycle phase (lint-plan §2 gate (b)), then a follow-up commit drops
   `continue-on-error`.
8. **root `package.json`** — `verify:push:branch` gains
   `&& npm --prefix console run design:regression` (cheap, rg-based; becomes a real
   pre-push gate once EXIT_ON_FAIL is populated). `verify:release` inherits nothing new
   (it already builds console; the pre-push path carries the suite per lint-plan §5).
9. **`docs/design-system/04-enforcement/lint-plan.md`** — lifecycle-table State column
   one-line diffs: no-raw-button shadow→scoped-error, no-adhoc-modal shadow→scoped-error
   (partial list), no-focus-suppression shadow→scoped-error (carve-out),
   no-legacy-tokens proposed/shadow→scoped-error (primitives), no-utility-smell
   shadow→scoped-error (primitives), theme-parity shadow→CI-blocking (it already runs
   green inside the suite); changelog notes the 15→16 check count.

### Files table

| File | Change | New? |
|---|---|---|
| `console/eslint-rules/design-selectors.mjs` | shared promoted-selector arrays | YES |
| `console/eslint.config.js` | import + blocks 1–5 per §5.2 | no |
| `console/eslint.config.shadow.mjs` | remove promoted entries from `shadowSyntaxRules` | no |
| `console/lint-shadow-baseline.json` | regen, same commit | no |
| `console/scripts/design-regression.sh` | EXIT_ON_FAIL + check 1/8 fixes + stale waiver echo | no |
| `console/eslint-waivers.yaml` | retire WVR-003/004; WVR-002 permanent; WVR-011 line re-pin; WVR-012 re-evaluation | no |
| `tests/console/design-lints-promoted.test.ts` | promoted-path probes (§6) | YES |
| `.github/workflows/quality.yml` | 2 advisory steps | no |
| `package.json` (root) | `verify:push:branch` += design:regression | no |
| `docs/design-system/04-enforcement/lint-plan.md` | lifecycle table State diffs + changelog | no |

Any file beyond this table is added here before commit.

## 6. Test plan

1. **Negative-fixture reuse:** `tests/console/design-lints.test.ts` (46 tests) continues
   to run unmodified against the shadow config — it remains the fire/silent proof for
   every promoted selector. (Message-text change tolerated by design: `hasWarning`
   matches rule-name keywords, not full strings; severity filter (`=== 1`) is unaffected
   because the shadow run's final block downgrades everything to warn.)
2. **NEW promoted-path probe — `tests/console/design-lints-promoted.test.ts`:** uses the
   DEFAULT config (`overrideConfigFile: console/eslint.config.js`) via `lintText`, and
   for EACH promoted rule asserts a violation **fails lint (severity 2)** at a promoted
   path and does NOT error at a non-promoted path:
   - raw `<table>` / `<th onClick>` / `var(--log-col-*)` → error at `src/pages/__x__.tsx`,
     silent at `src/components/primitives/__x__.tsx`;
   - raw `<button>` → error at `src/pages/LineDetail.tsx`, NO error at
     `src/components/LinePicker.tsx` (unflipped surface);
   - `c-dialog-backdrop` / `role="dialog"` → error at `src/components/RelinkModal.tsx`;
   - `outline-none` without `focus-visible:` → error at `src/pages/SoupKitchen.tsx`, NO
     error at `src/pages/Inbox.tsx` (carve-out);
   - `bg-d3` and `w-[40%]` → error at `src/components/primitives/__x__.tsx`, NO error at
     `src/pages/__x__.tsx`;
   - composition sanity: `eslint.calculateConfigForFile('…/CreateGroupModal.tsx')`
     contains scheduled + structural + focus + migrated selectors (block 4b union), and
     the Inbox carve-out config does NOT contain the focus selector.
3. **Clean-tree gates:** `npm --prefix console run lint` exits 0 (proves zero violations
   exist in promoted scopes); `lint:shadow:baseline` green after regen; full vitest
   suite; `bash console/scripts/design-regression.sh` exits 0 with
   `EXIT_ON_FAIL=(1 2 6 8 10 13 14 16)`.
4. **EXIT_ON_FAIL negative probe (manual, recorded in evidence packet):** temporarily
   plant a violation per promoted check (e.g. a quoted hex in a page, `>What<`/`>Soup<`
   spans, delete the `whatsoup:` literal copy in a scratch branch) and capture the
   nonzero exit; revert. One probe per check, mirroring the C2.3 tripwire proofs.

## 7. Waiver dispositions (registry: WVR-001..009, 011, 012)

| Waiver | Trigger state | D6 disposition |
|---|---|---|
| WVR-001 (chart-utils, recharts margins) | trigger (C3 chart slice) NOT landed; suppression live `chart-utils.ts:10` | KEEP — re-affirm, owning slice C3 |
| WVR-002 (QrDisplay `margin: 2`) | trigger (QR slice) effectively fired via D1.5; suppression live `QrDisplay.tsx:17`; third-party numeric API, no CSS expression exists | CONVERT TO PERMANENT with the spec citation its own `replacement_plan` pre-authorizes (lint-plan §4 "third-party numeric API") — this is the D6 decision the registry asked for |
| WVR-003 (chart-utils hex) | subject GONE (zero hex in file, grep-verified) | RETIRE — remove entry; update design-regression check 1 echo text in the same commit |
| WVR-004 (QrDisplay hex) | subject GONE (`getComputedStyle` resolution landed `7a592488`); no referencing suppression in source | RETIRE — remove entry; same check-1 text co-update. Follow-up (NOT a waiver): QrDisplay still reads legacy `--color-t1`/`--color-d1` names — rides the alias-layer wave |
| WVR-005 / WVR-006 (shimmer, typing-bounce infinite) | C5 motion disposition pending | KEEP — check 13 counts them sanctioned (5 occurrences exactly) |
| WVR-007 (chart-utils `contentStyle`) | trigger (C3) not landed; suppression live `:14` | KEEP |
| WVR-008 (use-websocket HMR), WVR-009 (react-virtual) | external limitations | KEEP |
| WVR-011 (ConfigStep mount-only effect) | wizard unmigrated (heaviest baseline buckets); suppression live at `ConfigStep.tsx:176` — registry scope says `:174` | KEEP; re-pin scope line 174→176 |
| WVR-012 (Popover co-located exports) | `expiration_phase: D6` — this packet IS the re-evaluation; neither retirement trigger (react-refresh capability, helper extraction) has occurred | KEEP; re-point `expiration_phase` to the next review milestone (D-series close or C4) with a one-line justification |

**Expiry time-bomb:** every entry expires 2026-12-31 and check 14 (promoted, blocking)
fails CI on expiry day. The retirements above shrink exposure to 9 entries; remaining
entries whose owning slice lands earlier should be retired with their slices, and any
survivor needs a deliberate re-date before 2026-12-31 — note this in the
design-debt register during D6.

## 8. CI wiring and the fitness-ring boundary

- **quality.yml:** two advisory (`continue-on-error: true`) steps after console deps
  install (§5.7). Runs on PRs and main pushes; gives baseline visibility on main-side
  changes (which have twice moved console counters: UnlockScreen #754, Lock control
  #758 — see baseline commits `7cfa1027`, `95ab4aa5`). Blocking flip is a separate
  later commit per lifecycle gate (b).
- **Pre-push:** via `verify:push:branch` (§5.8). The pre-push guard
  (`scripts/pre-push-guard.ts`) is just a dispatcher — no edits to it.
- **Fitness-ring boundary (constraint):** the repo-level ring
  (`guard:lint:src` → `scripts/eslint-fitness-check.ts`, `eslint-rules/` at repo root,
  `scripts/lib/fitness/`) is a SEPARATE domain — D6 touches none of it, adds no design
  rules to it, and does not reorder quality.yml's existing steps (lint-plan §1: the
  registry may mirror design-debt counts, never gate).
- **Coordination dependency:** the ring is GREEN today (20 warnings / 0 errors,
  warn-only — live run). The earlier main-side red recorded in `b2-evidence.md` and
  `execution-log.md` does not reproduce on `6f0e9289`. However, because
  `verify:push:branch` chains `guard:lint:src` BEFORE anything D6 appends, any future
  ring red re-blocks the same pre-push path D6 lands its gate in — if the ring is red at
  D6 implementation time, land the quality.yml advisory steps anyway and hold the
  `verify:push:branch` edit until the ring is green (it is dead weight behind a failing
  chain link, not a correctness risk).

## 9. Reliability — false-positive rollback path per rule

- Lint-plan demotion law applies unchanged: two confirmed false positives in a week
  demote one state and open a fix task.
- Mechanically, per selector: delete it from the promoted array in
  `design-selectors.mjs`, restore the warn-severity copy to `shadowSyntaxRules`, regen
  the baseline — one small, reviewable diff; the shared-module design makes the
  demotion a single-array edit rather than a config surgery.
- Per regression check: remove the number from `EXIT_ON_FAIL` (one-line diff).
- The carve-out and exemption blocks (Inbox/HistoryTab, primitives) mean the riskiest
  false-positive surfaces (composers, canonical renderers) are excluded by construction.
- Selector-regex risk is lowest for S/M groups (tag/attribute shapes, 46-test proven);
  highest for `no-utility-smell` (lookahead regex) — which is why its error scope is
  primitives-only, where the current count is zero and authorship is spec-driven.

## 10. Rollback — one commit per promotion group

| Commit | Content | Revert effect |
|---|---|---|
| 1 | selector module + Group S + Group F flips + shadow co-update + baseline regen + promoted-path probe tests | single revert restores pure-shadow state |
| 2 | Group M + Group P flips (+ probe additions) | independent of commit 1 |
| 3 | design-regression check 1/8 fixes + `EXIT_ON_FAIL=(1 2 6 8 10 13 14 16)` + waiver dispositions (003/004 retire travels here, with the check-1 text fix) | revert returns the suite to report-only |
| 4 | quality.yml advisory steps + `verify:push:branch` wiring | revert detaches CI/pre-push without touching enforcement |
| 5 (docs lane) | lint-plan lifecycle table + changelog + debt-register expiry note | docs-only |

Each commit leaves the tree green in isolation (probes and baseline travel with their
flips). No commit mixes enforcement-domain and fitness-ring files (the latter set is
empty by constraint).

## 11. Debt / waiver deltas

- Waivers: 11 → 9 entries (WVR-003, WVR-004 retired); 1 temporary→permanent
  (WVR-002, with spec citation); 2 metadata re-pins (WVR-011 line, WVR-012 phase).
- Shadow baseline: keys unchanged, total ≤563 expected (no count moves from promotion
  itself; flipped surfaces were already at zero).
- Lifecycle table: 6 State-column rows advance one state (§5.9).
- New structural guarantees: raw tables/sortable headers/log lanes cannot re-enter
  anywhere; raw buttons/ad-hoc modals cannot re-enter 8 migrated surfaces; focus
  suppression cannot re-enter outside 2 carved-out composers; legacy tokens/utility
  smells cannot enter primitives; brand/contract/animation/waiver regressions block at
  push once EXIT_ON_FAIL lands.
- Expiry-date debt explicitly registered (§7).

## 12. Constraints

1. **Dirty impl tree** (§1): coordinate with the in-flight ChatList/B4 lane before any
   baseline regen; gate 0 must show clean `git status` or an explicit sequencing note.
2. **Check 1 and check 8 fixes are preconditions** for their EXIT_ON_FAIL entries —
   promoting either as-is would, respectively, permanently fail or never fail.
3. **CreateGroupModal must live in the union block (4b)** — placing it in 4a would
   silently strip the scheduled/groups ratchet from it (flat-config replace semantics).
4. **Shadow co-update is mandatory in the same commit as each flip** — otherwise the
   flat-mapped duplicate selectors double-count and the ratchet fails spuriously.
5. **Message-tag continuity** (`[soup/<rule>]` prefix) is load-bearing for baseline
   keying — error messages may change text after the tag, never the tag.
6. **Fitness ring untouched**; `verify:push:branch` edit holds if the ring re-reds (§8).
7. **Out of scope:** Inbox promotions (until B4 lands), wizard promotions (until its
   wave; WVR-011 holds), `no-legacy-tokens` outside primitives (alias-layer completion
   gate), `no-raw-form-control` (form kit), brand-regression error flip (C4 copy-flip
   PR), pickers/LinePicker raw-button (not at zero — survey correction).

## 13. Verdict

**Ready with Constraints.** All promotion preconditions verified live: the fixture gate
is closed (46/46), every flip target is at zero in scope, the regression suite's
promotable set is 6-of-8 as-is with two mechanical script fixes upgrading it to 8, the
config-composition mechanism is decided from the real flat-config semantics, and waiver
dispositions are evidence-pinned. The two hard constraints are sequencing (dirty B4 WIP
in the impl tree) and the check 1/8 fixes; neither changes scope.
