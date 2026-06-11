# Execution Log — SOUP Design System v3

Append-only. One entry per task/gate. Verdicts: Pass / Fail / Inconclusive / Blocked.

---

## T1 — Worktree, Discovery, Scaffold — 2026-06-11

**Verdict: Pass**

Commands run:
```
git fetch origin
git worktree add <worktrees>/soup-design -b design/soup-rebrand origin/main
git rev-parse --show-toplevel && git branch --show-current && git rev-parse HEAD
git status --short                       # clean
git -C <main-checkout> status --short | wc -l   # 51 (pre-existing baseline, untouched)
git worktree list                        # 14 worktrees incl. this one
```

State recorded:
- Worktree: `soup-design`, branch `design/soup-rebrand`, base `0ff1fe0ae2f9166a7e25000242283200aa78e457` (origin/main).
- Main checkout on `chore/ff038-eslint-ring` with 51 pre-existing dirty files — NOT touched.
- Remote: `git@github.com:LucasQuiles/WhatSoup.git`. No push authorized this program.

Assumption verification (see README table): A1 ✅, A2 corrected 16.7K→17,971 LOC, A3 ✅ 60, A4 ✅ 4 pages,
A5 ✅ 1,236 lines, A6 corrected 150+→106 selector rules, A7 ✅ 6 v2 mockup files, A9 corrected 120+→113 test files,
A10 ✅, A12 ✅ (`dev`/`build`/`lint`/`preview`).

Gaps/decisions:
- `docs/console-mockups/` has no README/index file → v3 forward pointer SKIPPED per plan rule
  ("only if the relevant file exists"). Gap recorded here; cutover plan may add one later.
- A8 (branding grep audit) deferred to T2/T7 as planned. A11 (screenshot tooling) deferred to T4.

Files created: `docs/design-system/{README.md,execution-log.md}`, `docs/sdlc/active/soup-design-system-v3/state.md`, `beads/`.

Commit: `docs(design): scaffold SOUP design-system v3 program`

---

## T2 — Inventory, IA, Workflow, DRY Audit — 2026-06-11

**Verdict: Pass**

Produced all six `00-inventory/` artifacts via dedicated audit agent; integrator reviewed and committed.

Key verified facts:
- LineDetail tabs: **9** (7 base + 2 MCP-gated: Scheduled, Groups — `console/src/pages/LineDetail.tsx:37-52`).
- A8: `WhatSoup` occurs **6 times in console/src** (1 each: `types.ts`, `mock-data.ts`, `hooks/use-keyboard-shortcuts.ts`, `hooks/use-fleet.ts`, `components/wizard/ConfigStep.tsx`, `components/UpdateModal.tsx`).
- Token census: **180 custom properties** (50 `@theme` / 130 `:root`), 60 `c-*` composite classes, 7 orphan tokens.
- Controls: 135 `<button>`s (24 raw outside `c-btn`/`c-tab` across ~8 recipes), 11 dialog surfaces (0 focus traps, 3 missing Escape), 9+ pill recipes, 4 custom popover dropdowns.
- Drift: 26 ranked entries — 6 P1 (button sprawl; no modal primitive; dark-only token values; status/mode color logic ×8 TS maps + 7 visuals; no pill primitive; token tier pollution), 12 P2, 8 P3.
- Disconfirmed briefing hypotheses logged in `duplication-register.md` (CardSelector/ChartPanel/Nav are not dropdowns; avatar-hue hashing single-sited).
- Hygiene note: guard flagged a doc line naming the literal lint-suppression directive; reworded.

Commit: `8fdc6a37 docs(design): T2 inventory — components, controls, IA, duplication, tokens, drift`

---

## T3 — Research + Reference Library — 2026-06-11

**Verdict: Pass** (motion addendum in progress — see T3b below)

Produced `01-research/reference-library.md` (~50 refs, 10 categories, authority + verification status per ref)
and `01-research/research-digest.md` (per-reference steal/adapt/reject, topics a–g, 13 "SOUP Design Direction Signals").

Honesty marks: Grafana Saga pages JS-gated; Apple dark-mode page fetch failed (known-canon);
Raycast via secondary teardown; galleries/TE marked not-browsed stimulus-only. Search-verified/known-canon
claims need re-confirmation before becoming normative in T6.

Headline conclusions: Radix contrast-by-construction + Carbon theme-as-token-remap + Primer role-first
naming as the token architecture; two designed densities; 4-surface elevation ladder with per-theme
elevation law; Geist > Plex > Inter typeface shortlist (Outfit as control); "mechanical calm" motion;
SOUP wordmark as instrument nameplate; positioning = "instrument-grade calm".

Commit: `44bcb5c8 docs(design): T3 research — reference library and design-direction digest`

---

## T3b — Motion Addendum + Operator Synthesis Seed — 2026-06-11

**Verdict: Pass**

Plan addendum (user-integrated) required motion-reference research. Research agent expanded
`reference-library.md` §8 into 5 sub-sections (philosophy / design-system specs / implementation /
hard gates / expressive boundary) covering Atlassian Motion (fetched: 50–150/150–400ms bands, 4 easings,
exits-faster), Fluent 2 motion taxonomy (fetched), Motion/motion.dev, Sonner, Vaul, Rive (rejected for v3
adoption), MDN reduced-motion + compositor discipline, WCAG 2.2.2 (Level A — directly regulates v2's
breathing dots and live feed; resolved via pause control + static degradation) and 2.3.3 (AAA, adopted
as target), BUCK/Clay/basement (stimulus-only, honestly marked not-browsed).
Digest signal #10 expanded: duration tokens (instant / fast ~120 / base ~180 / slow ~280 / ambient ≥1500ms),
two easings, transform/opacity allowlist + waiver, anchored-overlay specifics, ~150–200ms loader delay,
error-shake banned, full reduced/no-motion contract ("no information may exist only in motion").
Unverifiable: Geist motion docs (none found), Teams specifics, Clay/basement specifics — all marked.

Also added `01-research/synthesis-seed.md`: distillation of operator-provided comprehensive synthesis
report (non-authoritative seed per plan addendum) — studio craft-bar refs (LoveFrom, Clay, BUCK, Instrument,
Work & Co, Fantasy, Metalab), Android/MDN/W3C foundation validation set, seed sizing matrix, T7 lint
tripwires, screenshot QA matrix, and reconciliation notes (digest's ~300ms ceiling stands over seed's
400ms; typeface decision deferred to T4 side-by-side).

Commit: `1a39add8 docs(design): T3b motion research addendum + operator synthesis seed`

---

## T4 — Direction Mockups — 2026-06-11 (IN PROGRESS)

Three parallel direction agents dispatched (criteria incl. plan motion addendum: structural motion,
reduced-motion neutralization, anchored overlays, loading feedback, immediate focus/validation feedback).

- **Direction B (Editorial Precision): Pass.** `direction-b-editorial.html`, 2,337 lines, self-contained,
  dual designed themes, headless-Chrome render clean both themes at 900px+. Geist + Geist Mono;
  electric blue accent (#6BA6FF dark / #2563EB light); "soup." lowercase wordmark with passive-teal
  period. Vocabulary proposal: Soup Kitchen→Fleet, one user-facing noun "Line", "Attention" metric.
  Self-critique recorded (Vercel-adjacency risk; inline-style shortcut; drill-in is a vignette).
  Hygiene note: `====` CSS banners false-positived the conflict-marker guard → converted to dashes.
  Commit: `dc56dd3c`.
- **Direction A (Instrument): Pass after resume** — subagent hit session token limit at 1,544 lines;
  resumed and completed to 1,744 lines (balanced HTML verified). IBM Plex Mono+Sans, instrument orange,
  faceplate nameplate, lamp/shape status coding, focus trap + single-fire Escape in modal,
  stated AA contrast 15.7:1/15.2:1. Render-checked in headless Chrome (dark, top sections).
- **Direction C (Ops): Pass after resume** — same limit at 1,656 lines; completed to 2,265 lines
  (balanced HTML + `node --check` on JS verified by builder). Plex Condensed/Sans/Mono, achromatic
  chrome (color = semantics only), two table densities, toolbar + log-stream specimens, working
  drill-in drawer, SOUP rack-label lozenge. Render-checked (dark, top sections incl. live modal demo).

**T4 Verdict: Pass.** All three directions complete + committed with comparison launcher `index.html`
(neutral chrome) and critique/scorecards in `decision-log.md`. Vocabulary convergence across all three
builders: Soup Kitchen→Fleet, noun "Line", unified "attention" metric.

**A11 (screenshot tooling): Partially Inconclusive.** Headless Chrome viewport captures work at
top-of-page (both themes verified for B, dark verified for A/C); deep-scroll viewport captures return
blank frames in this environment and fullpage capture downscales — content verified via DOM/markdown
extraction instead. G1 review should use a real browser via `file://`; that is the designed review path.

→ **G1 gate: OPEN, awaiting user review.**

---

## G1 — Direction Selection — 2026-06-11

**Approved G1 on 2026-06-11** (via gate question): blend = B-Editorial chassis + A grafts
(nameplate/wordmark, lamp/shape status coding) + C grafts (table densities, toolbar, log-stream);
converged naming vocabulary locked. Full record in `02-directions/decision-log.md` and README.
Commit: `be38e9f8` (also added `01-research/synthesis-seed-2.md` — second operator report distilled).

---

## T5 — Winner Refinement (Round 1) — 2026-06-11

**Verdict: Pass**

`02-directions/iterations/v2.html` (2,799 lines) built by the Direction-B agent resumed with full
chassis context. Verified: balanced HTML (closing tag, zero eq-runs, zero local paths), both themes
render-checked in headless Chrome (dark + light, control sheet + nameplate + shape-law + graft tags
visible). Grafts: A nameplate (`--type-nameplate`, mono spaced-caps + teal tick; crit-blink REJECTED,
ambient budget spent once on ok-breathing), A shape law (.shape--ok/warn/crit/off everywhere),
C densities (--row-default 36 / --row-compressed 28, Fleet compressed), C toolbar (×3 identical),
C log-stream (×3 incl. drawer-scoped). Seed-2 constraints honored (easing pair, exits-faster,
reduced-motion off-and-instant, glass chrome-only, 24px floor, 80ch measure). All three B
self-critique items resolved (nameplate vs Vercel-adjacency; functional drawer/inspector replaces
vignette; inline-style rule: var() refs / data-driven custom properties only).

Open items carried to G2 review (from builder's fresh self-critique):
1. Drawer overlays compressed-table right columns when open — production needs squeeze-layout.
2. Nameplate trailing letter-space + untuned optical centering.
3. `.w-160`/`.mt-3` utility classes are spec-smell — T6 must replace with composition primitives.

Also added `01-research/synthesis-seed-3.md` (third operator report distilled per plan Seed addendum 3:
OkLCh ramp method, DTCG/Style Dictionary/Storybook/Chromatic/Playwright as reference-only, enforcement
ladder refinement, focus-visible + modal-focus-restoration lint intents, dense/expressive/transactional
cutover-rehearsal rule, studio watchlist).

→ **G2 gate: OPEN, awaiting user review of v2 (both themes).** Decisions: lock visual language/type/
palettes/motion/naming/state taxonomy/density/table+log strategy; T8 spike allowed yes/no.

---

## G2 — Visual/Spec Lock — 2026-06-11

**Approved G2 on 2026-06-11: Option A conditional lock** (source: operator implementation driver
declaring v2 Blend the locked direction). Three open items carried as mandatory T6 resolution criteria.
**T8 DECLINED (superseded by authorized implementation).** Record: `02-directions/decision-log.md`.
Also distilled fourth operator dossier → `01-research/synthesis-seed-4.md` (scorecard rubric, NN/g
rules, pointer/hover resilience, Stylelint precedent, Awwwards leaderboard as stimulus-only).
Commit: `3b601252`.

---

## T6 — Formal Design-System Spec — 2026-06-11

**Verdict: Pass.** 21 files under `03-spec/` (tokens-v3 + 7 foundations + 13 component specs).
All 180 census tokens dispositioned (49 formalized / 40 component / 84 superseded / 7 orphan-rejected);
all 72 v2.html properties mapped. G2 items resolved: drawer squeeze rule (container-query dual mode +
column-collapse priority), nameplate tuning (tracking cancellation, optical centering, tick spec),
utility-class disposition (Stack/Cluster/Container/Prose primitives + forbidden list). Four light-theme
AA failures found and FIXED in spec (ok/warn/passive wash-fg + --text-3). Open: feed BEM decision (C2),
squeeze transition mode (implementer), v2.html carries pre-fix hexes (spec authoritative).
Hygiene: "Phase N" prose labels guard-blocked → renamed to C-stage labels. Commit: `7b3889ef`.

---

## T7 — Enforcement + Cutover Plans — 2026-06-11

**Verdict: Pass.** `04-enforcement/lint-plan.md` (22-rule catalog, 7-state lifecycle, 5-field waiver
policy w/ YAML registry, 15-check rg regression suite (opt-in scripts; husky/verify wiring is a P6 enforcement-stage task), readiness
scorecard), `05-cutover/cutover-plan.md` (C0–C4 reversible, driver mapping, rehearsal rule
dense/expressive/transactional, 8-axis visual QA matrix, rollback per stage), `05-cutover/
branding-touchpoints.md` (exhaustive: 27 console/src lines, 84 test lines, 8 docs/html — all tagged;
3 unknowns queued). Contradictions caught: eslint-rules/ dir does not exist (stale reference; custom
rules will live at console/eslint-rules/); Nav wordmark grep-invisible (split spans — rule includes
split-sibling detector); P2-11 line cites off-by-one; tabular-nums has zero current occurrences
(whole-surface gap, rule enters at proposed); four infinite animations vs ambient budget (shimmer/
typing-bounce waivered pending motion-stage disposition). Commit: `5105f8b2`.

---

## G3 package + D0 readiness — 2026-06-11

`g3-signoff-package.md` (sign-off recommendation, unresolved risks, verification matrix) and
`06-implementation/d0-readiness-packet.md` (pilot slice = Fleet table+toolbar+chips+drawer+log;
implementation worktree proposal soup-impl / feat/soup-v3-foundation off origin/main; first three
D1 slices specified). **Awaiting operator: G3 sign-off + D0 packet approval → D1 begins.**

---

## G2 Review Package Preparation — 2026-06-11

**Verdict: Pass**

Prepared `02-directions/g2-review-package.md` as the driver for G2 review, T6 formal specification,
T7 enforcement/cutover planning, and the optional T8 spike decision.

Commands run:
```
pwd
git status --short
git branch --show-current
git rev-parse --show-toplevel
git log --oneline -8
rg --files -g 'AGENTS.md' -g 'CLAUDE.md' -g 'docs/design-system/**'
sed -n '1,220p' CLAUDE.md
sed -n '1,260p' docs/design-system/README.md
sed -n '1,260p' docs/design-system/02-directions/decision-log.md
sed -n '1,260p' docs/design-system/execution-log.md
rg -n 'SOUP|v2|Blend|nameplate|drawer|row-default|row-compressed|shape--|log|toolbar|reduced|motion|glass|target|80' docs/design-system/02-directions/iterations/v2.html
sed -n '40,185p' docs/design-system/02-directions/iterations/v2.html
sed -n '1,240p' docs/design-system/02-directions/g2-review-package.md
find docs/design-system/03-spec docs/design-system/04-enforcement docs/design-system/05-cutover -maxdepth 3 -type f | sort
rg -n 'Option A|Option B|Option C|T8|conditional lock|No T6/T7/T8|G2 review package|squeeze-layout|nameplate|utility/spec-smell' docs/design-system/README.md docs/design-system/02-directions/decision-log.md docs/design-system/02-directions/g2-review-package.md docs/design-system/execution-log.md
```

Package contents:
- Direction lock summary for visual language, typography, dark/light palettes, accent, motion, naming/nameplate,
  state taxonomy, shape-coded status law, density model, tables, logs, drawer/inspector, and toolbar anatomy.
- Open item disposition for drawer squeeze-layout, nameplate optical centering/tracking, and utility/spec-smell
  conversion.
- G2 options A/B/C and optional T8 approval/decline decision.
- Post-G2 T6/T7 drivers and G3 readiness checklist.

Recommendation recorded: **Option A — conditional lock**. T8 is optional, not required.

Files changed:
- `docs/design-system/README.md`
- `docs/design-system/02-directions/decision-log.md`
- `docs/design-system/02-directions/g2-review-package.md`
- `docs/design-system/execution-log.md`

No T6/T7/T8 work started. No production implementation, push, PR, deploy, main checkout edit, or internal
identifier rename performed.

---

## G3 — Design Program Sign-Off — 2026-06-11

**Approved G3 on 2026-06-11: specs/enforcement/cutover accepted; implementation proceeds under the
operator driver.** D0 readiness packet approved in the same decision (pilot slice, worktree strategy,
D1 slices). Implementation worktree: `soup-impl` @ `feat/soup-v3-foundation` off origin/main.
Design worktree remains the docs/spec SSOT.

---

## Implementation QA Hardening Add-On — 2026-06-11

**Verdict: Pass**

Added `06-implementation/qa-hardening.md` as a binding assurance layer for frontend implementation
slices. It requires positive-path, negative-path, omission, regression, and design-system conformance
reviews before a slice can be accepted. It also adds `/frontend-design` review checkpoints, an
omission audit, negative-path matrix, visual drift sentinel, deterministic coverage matrix, no-silent-
fallback rule, design debt register, exception aging rules, spec ambiguity protocol, cross-surface
consistency audit, regression traps, reviewer challenge prompts, real-data stress validation, manual
QA scripts, final acceptance rubric, and "done means durable" rule.

Files changed:
- `docs/design-system/06-implementation/qa-hardening.md`
- `docs/design-system/06-implementation/d0-readiness-packet.md`
- `docs/design-system/05-cutover/cutover-plan.md`
- `docs/design-system/04-enforcement/lint-plan.md`
- `docs/design-system/g3-signoff-package.md`
- `docs/design-system/README.md`
- `docs/design-system/execution-log.md`

No production implementation, push, PR, deploy, main checkout edit, or protocol/internal rename performed.

---

## D1.1 — C0 Token Split (implementation worktree) — 2026-06-11

**Verdict: Pass.** Worktree `soup-impl` created (`feat/soup-v3-foundation` @ `2d5f813c`, zero console
drift from spec baseline). index.css (1,236 lines) split into styles/tokens.{primitive,semantic,
component}.css + composites.css with slim importer; 41-token semantic vocabulary added (aliasing
legacy canonical values at C0); 7 orphans deleted; avatar-hue dynamic-consumer comment added.
Evidence: token-resolution diff exact (7 removals = orphans, 41 additions = semantic, all else
byte-identical); lint clean; build green; 1,614/1,614 console tests (3 design-token test files
updated to read the tier set; orphan assertion corrected); dev render + computed-style probes
identical. One spec ambiguity resolved and documented (alias direction at C0 — cutover plan
precedence over tokens-v3 §7; inverts at C1). Full packet: `06-implementation/d1-1-evidence.md`.
Implementation commit: `4e98f0b5`.

---

## D1.2 — C1 Token Values + Dual Themes (implementation worktree) — 2026-06-11

**Verdict: Pass.** Commit `9b0087ef`. Semantic tokens canonical with per-theme values (50 tokens both
scopes, parity-checked); legacy @theme inverted to @theme inline aliases (sanctioned shifts: d4→
translucent interaction surface, t3/t4→text-2, d5→overlay, base #050709→#0E1013); all four AA fixes
confirmed in light scope; Geist + Geist Mono landed (Google Fonts fallback, DD-4 self-host by C2);
motion tokens v3; theme toggle in Nav (lucide Sun/Moon, aria-label, pre-paint init, persisted
whatsoup:theme). lint clean, build green, 1,614/1,614 tests (5 assertions tightened for the new nav
button — name-specific queries). Visual review: Fleet dark + LIGHT and Inbox light verified live —
light theme is designed (hairlines/shadows/darker chromatics), not inverted. Evidence:
`06-implementation/d1-2-evidence.md`.

---

## D1.3 + D1.4 — Lint Shadow Stage + QA Remediation — 2026-06-11

**Verdict: Pass (both).** D1.3 `5e7a9979`: soup/* shadow plugin (9 rules + stubs), opt-in shadow
config (default lint untouched), 15-check regression suite, waiver registry WVR-001..006; baseline
615 warnings (legacy tokens 406, raw buttons 135, controls 38, modals 19). D1.4 `472c5b5a` answers
three operator audit passes: global reduced-motion off-and-instant, instant focus ring, responsive
nav (390px overflow 657→390 fixed, accessible names kept), 5 theme-persistence tests, rebase onto
origin/main, design docs merged branch-local. 1,619/1,619 tests. Commit-email finding dispositioned
as push-gate (origin/main's own author identity; controlled at squash). All remaining audit items
dispositioned as DD-6..DD-10 debt with phases or scheduled C2-C4 work. Full table:
`06-implementation/d1-3-4-evidence.md`. **D1 token-foundation stage COMPLETE.**

---

## D1.5 — Oversight Round-2 Remediation — 2026-06-11

**Verdict: Pass.** Ten fresh findings, all closed or formally dispositioned:
1. D1.3 evidence packet — already on branch (audit raced the e88af6ae merge); confirmed present.
2. "Wired to husky/verify" over-claim — execution-log wording corrected; actual wiring is a P6
   enforcement-stage task (regression suite + baseline + parity remain opt-in scripts until then).
3. Report-only language — script summary now states "Report-only baseline: no checks promoted to
   blocking (EXIT_ON_FAIL empty)".
4. Theme parity — REAL script created (`console/scripts/check-theme-parity.mjs`, 101 tokens verified
   in both scopes); regression check 9 now executes it; npm script `design:theme-parity`.
5. Shadow drift ceiling — `console/lint-shadow-baseline.json` committed (615 warnings across 8
   per-rule buckets, keyed by [soup/*] message tags) + `check-shadow-baseline.mjs` ratchet (counts
   may fall, never rise; `--update` to tighten); npm script `lint:shadow:baseline`.
6. Stub rules — acknowledged as designed: each stub activates with its enabling primitive per the
   lint-plan lifecycle table (no change).
7. Waiver closed-loop — registry extended with expiration_phase / cleanup_trigger /
   user_approval_required on all entries; WVR-007..011 added; ALL 7 inline suppressions now carry
   waiver:<id> tags (check 15 = 0 untagged).
8. Brand SSOT — regression check 5 now exempts ConfigStep.tsx (bot-identity/protocol copy) in
   lockstep with the ESLint rule; branding-touchpoints.md is the classification SSOT; remaining
   non-contract count = 1 (UpdateModal, P4 flip).
9. Trailing whitespace in button.md / interaction-patterns.md — fixed.
10. Scope framing — recorded PR strategy: the branch is a FOUNDATION PACKAGE (C0+C1 tokens, shadow
    lint infra, docs, tests). At push-gate, evaluate splitting into stacked PRs (docs / C0 / C1 /
    lint-infra) per the one-PR-per-phase rule; single-package framing requires explicit operator
    choice. Push remains gated on operator approval + author-email decision.
