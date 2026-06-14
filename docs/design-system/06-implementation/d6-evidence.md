# Slice Evidence — D6 (enforcement promotion wave: check fixes · flip groups · gate wiring · CSS tier checks)

Worktree `soup-impl`. Core commits: `db165001` checks 1+8 made meaningful · `ba4ed643`
four-group scoped-error flips · `44897b16` EXIT_ON_FAIL + verify-chain wiring + design-metrics ·
`d761d01d` stale-ceiling metric + pre-push fail-open closure · `64332ce8` CSS tier checks 17–20 +
dangling-token fixes. Wave continuations: `8c26fbb1` WVR-013/014 + browser suite into CI ·
`b4140452` per-directory coverage ratchet · `f09f5dc3` gate-placement parity (CI + release) ·
`b260800e` full console lint into CI · M-list growth riding `d73bef54` (UpdateModal). Gate
packet: `d6-investigation.md` (Ready with Constraints, `db02d0a2`). This packet replaces the
execution log's interim "Inconclusive — acceptance evidence packet outstanding" verdict for D6.

**Evidence anchor:** all gate runs and live-tree reads below executed 2026-06-12 at impl HEAD
`b260800e` with a dirty tree: an in-progress origin merge (conflicts content-resolved, unstaged,
in `.gitignore` + root `package.json` — zero conflict markers, unrelated server-side lane) and
the in-flight B3 wave-4 wizard lane (modified `AddLineWizard.tsx`, `eslint.config.js` +1 M-list
line, `eslint-waivers.yaml` WVR-014 retirement, `SoupKitchen.tsx`, three style files; untracked
wizard/exit-presence tests). Gate outputs therefore reflect committed D6 state PLUS the wizard
lane's mid-slice deltas; every place a number differs from committed state is flagged inline.

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Positive-path | **PASS** | all five gates green fresh (block below): console lint exit 0 · shadow ratchet 489 ≤ ceiling 501 · design-regression 20 checks, blocking set `1 2 6 8 10 13 14 16` all PASS, exit 0 · design-metrics exit 0, 0 expired waivers, byte-identical double run re-proven · design-lints fixture suite 69/69 |
| Negative-path | **PASS with recorded gaps** | promoted severities proven by fixtures: severity-2 at promoted paths, silence at carve-outs/exemptions, composition sanity for the union block (suite 46→68 at flip, 69 today); metrics fail-closed parsing + null-vs-empty contract pinned by 31 fixture tests; pre-push fail-open closed (`d761d01d`, hook text verified); integrator tripwires (synthetic raw button, inflated ceiling) recorded in commit messages — but the packet §6.4 per-check EXIT_ON_FAIL probes are NOT recorded anywhere (omission audit) |
| Omission review | below | |
| Regression review | **PASS** | ratchet tag-keying continuous across promotion (`[soup/<rule>]` prefix preserved; keys verified live); baseline fall-only through the wave: 563→533 (B3w2) →533 flat at flip→511 (B3w3) →501 today, live 489; no flipped surface regressed (lint exit 0 proves zero violations in every promoted scope); fixture count never fell — B4 close swapped one obsolete carve-out test for a stronger fires-at-Inbox proof (net 68→69) |
| Design-system conformance | **PASS with one doc gap** | lint-plan §2 promotion gate honored per flip: fixtures landed before promotion (`1ccaa271` predates `ba4ed643`), every flip target at zero in scope, demotion law unexercised (no false-positive reports on record); §4 waiver law upheld — WVR-002 permanent WITH the spec citation §4 demands, 7-field schema intact; **but the §2 lifecycle tracking table was never updated** (omission audit item 4) |

## The D6 record, verified

### Commit 1 — checks 1 and 8 made meaningful (`db165001`)

Verified against the diff. Check 1: hex pattern now requires a color context (6/8-digit or at
least one hex letter), so decimal issue/order IDs (`#4921`, `#512`) stop false-positiving;
result branch now OK-at-zero / FAIL-above instead of the old both-branches-WARN that could
never pass. The two integrator corrections are in the diff: (a) the comment filter is anchored
past the rg `path:line:` prefix (`grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)'`) — the prior
bare `^\s*//` never matched rg output, and block-comment `*` continuation lines are now
excluded; (b) the stale waiver echo "Waivered: chart-utils.ts (WVR-003), QrDisplay.tsx
(WVR-004)" was rewritten to state the subjects are eliminated and registry retirement rides a
later D6 commit. Check 8: pins `<title>WhatSoup Console</title>` with missing/match/drift
branches, replacing the unconditional OK that asserted nothing (re-pin owed by the C4 flip).
Script header corrected 15→16 checks. Stayed report-only by design until `44897b16`.

### Flip groups (`ba4ed643`)

Four groups promoted per the lint-plan lifecycle, each verified against the live config:

- **S (structural, global-error outside primitives):** no-raw-table, no-raw-sortable-header,
  no-legacy-log-lanes — in the base block, re-carried through every later-match block.
- **F (focus, console-wide with carve-out):** no-focus-suppression; carve-out block verified —
  originally Inbox + HistoryTab, today **HistoryTab only** (B4 close `9bfde5c3` retired the
  Inbox carve-out and added the fires-at-Inbox fixture; HistoryTab retained per C-B4-6).
- **M (migrated surfaces, scoped-error):** no-raw-button + no-adhoc-modal across the eight
  surveyed files (seven in block 4a, CreateGroupModal alone in the 4b full-union block exactly
  as constraint §3 required — verified in the config comments and composition).
- **P (primitives strict tier):** no-legacy-tokens (3 selectors) + no-utility-smell error inside
  `components/primitives/**`, deliberately without S/M selectors (canonical-renderer exemption).

Shared module `console/eslint-rules/design-selectors.mjs` is the SSOT both configs import;
promoted entries removed from `shadowSyntaxRules` in the same commit (the double-count trap,
constraint §4); ratchet keys continuous, baseline 533 flat. Fixture suite 46→68 with
promoted-path probes — folded into `tests/console/design-lints.test.ts` rather than the
packet's planned separate `design-lints-promoted.test.ts` (file does not exist; benign plan
deviation, the probes themselves are present and passing). Waiver registry in the same commit:
WVR-003/004 retired with subjects grep-proven gone, WVR-002 → permanent with the lint-plan §4
"third-party numeric API" citation, WVR-011 scope re-pinned 174→176 (later 176→177 with
DD-21r), WVR-012 expiry re-pointed with neither retirement trigger fired. Integrator probe
recorded in the commit: synthetic raw button in a scoped file errors; restored tree lints clean.

### Wiring + metrics (`44897b16`, hardened by `d761d01d`, parity closed by `f09f5dc3`)

- **EXIT_ON_FAIL=(1 2 6 8 10 13 14 16)** live in `design-regression.sh` with a per-check
  justification block (verified in the script header: each promoted check cites its live-PASS +
  real-fail-path rationale; each immature check cites its named gate — checks 3/4 alias-layer,
  5/7 copy flip, 9 via the parity script path, 11 warn ceiling, 12 carve-out, 15 non-blocking).
- **The lane-found discrepancy, closed:** theme parity and the shadow ratchet had been treated
  as wired into the verify chain but `verify:push:branch` invoked neither (the commit records
  the finding). Verified now: root `package.json` chains all four design gates —
  `design:theme-parity`, `lint:shadow:baseline`, `design:regression`, `design:metrics` — on
  BOTH `verify:push:branch` and `verify:release`; `f09f5dc3` closed the remaining parity gaps
  (the four gates into CI `quality.yml` and `verify:release`, where previously a no-verify push
  or web merge landed with zero design enforcement).
- **design-metrics.mjs:** deterministic machine-readable burndown (per-rule ratchet buckets
  with live-vs-baseline drift, regression counts, waiver expiries, debt state), fail-closed
  parsing, 24 fixture tests. Determinism re-proven fresh in this packet: two consecutive runs
  byte-identical. `d761d01d` added the stale-ceiling field — baseline buckets whose live count
  fell below the ceiling are reported as named slack (silent head-room where new violations
  hide), 7 more fixture tests (24→31), and it is live-firing today on exactly the in-flight
  wizard lane (4 AddLineWizard buckets, slack 2/6/3/1 — the metric doing its job mid-slice).
- **Pre-push fail-open fix** (`d761d01d`): the hook no longer gates the metrics call on eslint
  presence — the blocking conditions (expired waivers, malformed inputs) are file-based and run
  regardless; verified in the current `.husky/pre-push` text.

### CSS tier checks 17–20 (`64332ce8`)

Four report-only checks from the token layer law: raw colors in component-tier CSS (found one
rgba literal → now WVR-013), legacy alias names defined in the primitive tier (20, duplicating
the semantic-tier alias block — burndown at C2 consolidation), dangling `var()` refs without
fallback, cross-tier duplicate property definitions (20, SSOT). The dangling-ref check —
flagged in the commit as the highest-value one — found the spec'd type ramp had ZERO CSS
definitions (eight token names, 24 consumers; **DD-26 filed**, design commit `2eb066d2`,
register entry verified) plus undefined radius and wizard-accent tokens; all 11 dangling sites
across 5 named tokens were given the explicit fallbacks their sibling call sites already used,
including the **wizard focus ring, which was silently absent** and now renders. Check 19 PASS
count=0 today. Check fixes integrator-authored; check additions harvested from a
context-terminated lane and live-fire verified per the commit record.

### Wave continuations

- **`8c26fbb1`:** the two dangling waiver markers became registry entries — WVR-013 (kpi-hover
  rgba shadow until a semantic elevation token, polish stage) and WVR-014 (runtime-injected
  wizard accent until the wizard rebuild); registry 9→11; CI gained the playwright chromium
  install and the browser test suite (the trusted-event proof surface previously never ran in
  CI). Working-tree note: the in-flight wizard lane already retires WVR-014 (static
  `data-line-type` accents replace the injection) — uncommitted, hence metrics reads 10 active
  against 11 committed.
- **M-list growth with migrations:** UpdateModal joined the scoped-error M list in the same
  commit as its Modal migration (`d73bef54`, ratchet 533→511) — the enforcement ratchet
  advancing with the migration, exactly the lifecycle intent. AddLineWizard's M-list entry is
  **pending**: it sits uncommitted in the wizard lane's working-tree diff alongside its
  migration, same pattern.
- **`b4140452`:** per-directory coverage ratchet, report-only — glob-keyed floors (primitives
  98/94, hooks 97/93, shared 98/93, lib 84/88; deliberately no global gate), deterministic
  sorted output, fail-closed exit taxonomy (exit 2 for coverage-not-run/schema vs exit 1 for
  strict threshold violations), 37 fixture tests; `--strict` tested but unwired pending the
  gate-placement decision. **The floor caught B5's hooks:** the coverage-refresh audit
  (test-coverage-audit.md) shows hooks 91.79% statements vs the 97 floor — FAIL wholly
  attributable to the two new B5 hooks (`use-exit-presence.ts` 32.1% st, `use-background-inert.ts`
  80.6% st); disposition recorded (B5 lane owes the tests before strict promotion; an untracked
  `use-exit-presence.test.tsx` is in flight at gate time). The ratchet catching new untested
  exports on a contract surface is the design working as built.
- **`b260800e`:** full console eslint step into CI — closes the gate-audit finding that
  lint-staged covered only staged files, so merge-introduced or bypassed files were never
  linted by the general config anywhere; landed after every integration battery proved the full
  run clean.

## Fresh gate evidence (run 2026-06-12, impl HEAD `b260800e`, dirty-tree caveat above)

| Gate | Command | Result |
|---|---|---|
| 1 | `npm --prefix console run lint` | **exit 0** — zero violations in every promoted scope (S/F/M/P all hold on the live tree, wizard WIP included) |
| 2 | `npm --prefix console run lint:shadow:baseline` | **exit 0** — "shadow baseline OK: 489 warnings (ceiling 501)"; 4 below-ceiling buckets noted, all `AddLineWizard.tsx` (in-flight lane slack; ratchet tightens when that lane's commit regens) |
| 3 | `npm --prefix console run design:regression` | **exit 0** — 20 checks: 10 PASS / 10 WARN; "Blocking checks: 1 2 6 8 10 13 14 16 (all PASS)". Notable: check 1 count=0 (real hex truly zero), check 8 "title matches pinned value", check 10 all three contracts present, check 12 count=1 (HistoryTab only — Inbox retired at B4), check 13 count=5 all sanctioned, check 19 count=0 (dangling refs stayed closed) |
| 4 | `npm --prefix console run design:metrics` | **exit 0** — waivers 10 active / 0 expired (10 = committed 11 minus the lane's uncommitted WVR-014 retirement); stale-ceiling WARN ×4 (the AddLineWizard slack, report-only as designed); double run byte-identical |
| 5 | `npx vitest run --root . tests/console/design-lints.test.ts` | **69/69 passed** (1 file, 734ms) — fire + silence + promoted-path + composition-sanity proofs for every promoted selector |

## Omission audit

- **Immature checks remain report-only behind named gates** (by design; each gate named in the
  script's justification block): checks 3/4 legacy tokens/utilities (176 + 315 live — alias-layer
  completion gate), checks 5/7 brand copy (1 + 5 live — C4/P4 copy flip), check 11 utility smell
  (4 waivered — lint-plan ceiling is warn-on-changed-files), check 12 focus suppression (1 live —
  HistoryTab carve-out, C-B4-6), check 15 untagged suppressions (1 — shadow), checks 17/18/20
  CSS tier (1 waivered + 20 + 20 — C2 alias-consolidation gate). `soup/no-brand-regression`
  stays shadow until the C4 copy-flip PR; pickers/LinePicker raw-button, `no-raw-form-control`
  everywhere, and `no-legacy-tokens`/`no-utility-smell` outside primitives stay unflipped per
  packet §4 (not at zero, or their landing gate has not fired).
- **Historical D6 note:** `--strict` coverage gating was unwired at D6 landing. Current tree
  promotes it through root `npm run coverage:check`: Vitest coverage runs first, then the
  per-directory checker runs with `--strict`, so threshold regressions fail `verify:release`
  and the quality workflow.
- **File-size block-severity is an open operator decision.** `f09f5dc3` stopped the fitness
  taxonomy claiming a blocking file-size ratchet guard that does not exist (the eslint mirror is
  warn-only, no guard reads the baseline); implement-or-demote is recorded as needs-decision and
  D6 did not decide it.
- **lint-plan lifecycle table never updated** — packet §5.9 / rollback commit 5 (docs lane) did
  not land: `04-enforcement/lint-plan.md` still shows pre-flip entry states (e.g. no-raw-button
  "shadow"), its changelog ends 2026-06-11, and the 15→16→20 check-count drift is unabsorbed.
  Found by this packet; owed as a docs-lane follow-up before stage close.
- **Packet §6.4 per-check EXIT_ON_FAIL negative probes were not recorded.** The plan called for
  one planted-violation probe per promoted check with captured nonzero exits; no transcript
  exists. The blocking checks' fail paths rest on the (verified) branch structure of the script,
  the flip-commit raw-button probe, and the stale-ceiling probe — adequate but thinner than the
  packet specified. Owed at the next regression-suite touch.
- **CI advisory phase skipped (deviation, justified):** the packet planned
  `continue-on-error: true` advisory steps for one lifecycle phase; `f09f5dc3` landed the four
  design gates blocking immediately, justified by the gate audit (unenforced no-verify/web-merge
  paths). All four run green in the verify chain, so the blocking flip carried no risk, but it
  is a recorded packet deviation.
- **Waiver expiry time-bomb not separately registered:** packet §7 asked for a debt-register
  note on the 2026-12-31 expiry cluster; the register's standing policy ("WVR-* live in the
  registry YAML, not duplicated here") means no entry was filed. Check 14 (blocking) remains the
  enforcement; survivors still need deliberate re-dates before expiry day.
- **Full-suite claims not re-run here:** whole-battery counts quoted from commit records
  ("2,265 green", "ratchet flat") were not re-executed for this packet — the five enforcement
  gates were; the tree is mid-merge with an unrelated server lane and a full battery would
  measure that lane, not D6.

## Claims verified only from commit/log records (not independently reproducible read-only)

- The flip-commit synthetic raw-button probe and restored-clean lint (`ba4ed643`) and the
  inflated-ceiling probe (`d761d01d`) — reproducing them requires planting violations in the
  shared tree, which this read-only lane must not do. The recorded outcomes are consistent with
  the fixture suite's equivalent assertions, which do run (gate 5).
- The original site where theme parity and the shadow ratchet were "asserted wired": not located
  in any design doc (the d6-investigation itself correctly reported them absent from the verify
  chain). The discrepancy's closure is fully verified (root `package.json` live text); its
  provenance is the wiring commit's own record.
- The `44897b16`-era byte-identical double run — original transcript not preserved; superseded
  by this packet's fresh byte-identical proof.

## Debt / waiver register delta

| ID | Change |
|---|---|
| DD-26 | **OPENED by this wave** — type ramp undefined in CSS (8 names, 24 consumers); interim fallbacks at all sites; ramp definition owed at C3 with live visual checkpoint |
| WVR-003, WVR-004 | **RETIRED** — subjects grep-proven gone (chart-utils hex, QrDisplay hex via computed-style resolution) |
| WVR-002 | temporary → **PERMANENT** with the lint-plan §4 spec citation (third-party numeric API) |
| WVR-013, WVR-014 | **FILED** — kpi-hover rgba (polish-stage token) and wizard accent injection; WVR-014's retirement is already in the wizard lane's uncommitted diff |
| WVR-011 / WVR-012 | metadata re-pins (scope line; expiry phase re-pointed with triggers unfired) |
| Registry net | 11 → 9 → 11 committed (two retired, two filed); 0 expired; will be 10 when the wizard lane lands |

## Verdict: **PASS WITH DEFERRED DEBT.**

Every promotion the packet authorized is committed, live, and green: four flip groups enforced
at error severity with fixture and composition proofs (69/69), eight regression checks blocking
with all eight passing fresh, the four design gates wired into pre-push, branch verify, release
verify, and CI (parity closed after the lane-found discrepancy), deterministic fail-closed
metrics with stale-ceiling detection live-firing on real mid-slice slack, CSS tier checks
shipping with their dangling-token findings fixed, and the enforcement ratchet demonstrably
advancing with migrations (UpdateModal landed, AddLineWizard mid-flight) and catching real debt
(B5 hooks under the coverage floor). The deferred debt is named, owned, and bounded: the
lint-plan lifecycle table update (docs lane, owed before stage close), the unrecorded per-check
tripwire transcripts, the `--strict` coverage flip behind the gate-placement decision plus B5's
hook tests, the file-size implement-or-demote operator decision, and the immature checks each
behind a named landing gate. Nothing failed; nothing was papered over. Next: the wizard lane's
own evidence packet absorbs the AddLineWizard M-list entry, WVR-014 retirement, and ratchet
regen; C4 owns the check 5/7/8 re-pins.
