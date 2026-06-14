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

---

## C2.1 — Badge/Button Primitives + Oversight Waves 3-4 — 2026-06-11

**Verdict: Pass.** Commit `fb67b43f` (impl). Shape law LIVE (DD-6 closed): disc/diamond/square/outline
+ label everywhere status renders, canonical status-map as single rendering driver, ModeBadge via map,
Button 6x3 + ActionButton with type-level icon-only aria contract, accent primary live on Fleet.
Pre+post frontend-design checkpoints both themes (Fleet/LineDetail/Ops/LinePicker — no overflow).
1,674/1,674 tests. All 16 findings from oversight waves 3-4 fixed or dispositioned (check-15 bug,
rule x file ratchet 153 buckets, shadow superset run, map SSOT, px tokenization, mojibake, weak
assertions; evidence-vs-baseline reconciled; DD-11 opened). Full packet:
`06-implementation/c2-1-evidence.md`. Stale agent worktree removal pending operator approval.

---

## C2.2 — Pill + Modal/useDismissable + Oversight Waves 5-7 — 2026-06-11

**Verdict: Pass.** Commit `59ceeb4f` (impl). DD-7 CLOSED: useDismissable (stack-aware Escape AND
outside-click, focus trap, restoration), Modal composite (title-id context — aria-labelledby
verified resolving live), Pill (tone x size x static/interactive/removable, aria-describedby count
pattern, 24px hit floor via pseudo-element). Migrations: ConfirmDialog, KeyboardShortcutsHelp
(fixed its real no-Escape bug), FilterPill (legacy activeColor->tone mapping preserves semantics at
all callers). Invariant correction: Escape/X always cancel (WAI); dismissable = outside-click only.
Wave-7 quick fixes: wizard min-w bug, h-dvh, transition:all removal. Responsive backlog = DD-18
(per-surface, status INCONCLUSIVE until landed). 1,736/1,736 tests; baseline 635->614.
DD-12..18 opened. Stale agent worktrees removed (operator-approved, zero unique commits verified).
Packet: `06-implementation/c2-2-evidence.md`.

---

## C2.2b — Oversight Wave 8 — 2026-06-11

**Verdict: Pass.** Three P1s fixed: backdrop double-close (single owner = useDismissable pointerdown;
backdrop onClick removed; regression test pins pointerdown->pointerup->click = exactly one onClose);
#root 100vh -> 100dvh (viewport contract aligned with App h-dvh); --modal-min-h -> min(500px, 85dvh)
(short-window wizard). Modal comments now truthful (instant exit + no background inert = DD-19).
Schema-compliant SSOT debt register created (`06-implementation/design-debt-register.md`, DD-4..21
full qa-hardening fields; DD-19/20/21 newly opened from waves 7-8: modal exit/inert, Framer
reduced-motion path, table/tablist keyboard). FilterPill suffix rule documented (decorative-only).
origin/main merged (+6, console untouched). 1,753/1,753 tests.
"Modal law live" scope clarified: migrated surfaces only; remaining 8 ad-hoc dialogs tracked by
ratchet buckets and their migration slices (W8-4 acknowledged).

---

## C2.3 — Table / Toolbar / LogStream / Drawer + Fleet pilot — 2026-06-12

**Verdict: Pass.** Eight code commits (`701a7ff7` Table+Toolbar, `1d27f116` LogStream+Drawer,
`33a3788b` LogsTab/Ops adoption, `1f9bde39` Fleet pilot, `a24d09e5` enforcement, `682558f7`
live-QA D2+D3, `d451262c`+`85707997` stacking/short-height, `0ff73055` assertion hardening) after
investigation packet `bfe42920` (Ready with Constraints; the A0 gate introduced this slice).
Adoption proof: Fleet renders via the four new primitives; LogsTab+Ops unified onto LogStream;
raw table / th-onClick / sk-col / log-col all at ZERO with shadow tripwires (probe-proven) pinning
them there. Drawer law live: container-query squeeze at 900px (spec amended from 1080px with
rationale — full-width-container assumption), retarget swaps in place, Escape stack-aware,
focus restores to the CURRENT row via new useDismissable restoreFocus override. Row activation
now opens the drawer per spec; LineDetail navigation moved to the drawer's "Open line" action.
Sort follows the spec asc/desc/none cycle (deliberate change from legacy default-desc).
Three live browser QA rounds (both themes, 390/768/1024/1280/1440 + 1440×500): two squeeze/
focus defects and two responsive defects found and fixed in-slice; one QA "crash" was a harness
artifact (dev server piped through head — never pipe a dev server). 1,878/1,878 tests (+125);
ratchet 614→602; verify:push:branch PASS (5 weak assertions strengthened). DD-18 Fleet legs +
DD-21 table half CLOSED (register split into DD-18r/DD-21r); DD-22 opened (log virtualization
deferred until a streaming source exists). origin/main merged ×3 mid-slice, zero conflicts.
Packet: `06-implementation/c2-3-evidence.md`.

---

## B1 — LineDetail: Tabs / header buttons / overflow / DD-11 — 2026-06-12

**Verdict: Pass.** Subagent-driven plan execution (one commit per task, A0 gate first):
`048a26f7` CONNECTION_MAP fold (DD-11 closed; disconnected ink neutral→crit, deliberate, pinned),
`d7feb2a4` Tabs primitive (roving tabindex, arrows+wrap, Home/End, MANUAL activation,
disabled-with-reason; accent underline — the mode-colored treatment was the tabs.md anti-pattern),
`3f4e4d0b` LineDetail adoption (bar 38→10 lines; first page-level LineDetail test harness; real
MCP-tab condition = passive OR agent-without-sandboxPerChat), `92deece2` header (ActionButton back,
ghost actions, danger Delete per button.md — live design review confirmed it "sits calmly"),
`883a13b4` live-QA fixes (meta hidden through lg — Tailwind md fires AT 768; header wraps below md;
heartbeat meta-tier hidden; name-row wrap + tokenized 160px identity floor after a three-stage
flex-collapse chase that only live measurement could catch — truncation classes were asserted green
the whole time the name rendered at 12px), `2121ad34` ratchet 602→594 (LineDetail raw-button bucket
ELIMINATED; status-map +2 = relocated ternary literals, documented interim). 1,904/1,904 tests
(+16); verify:push:branch PASS; four browser QA rounds, both themes. DD-11 + LineDetail legs of
DD-18r/DD-21r closed; remainders re-scoped to B2/B3. SummaryTab ACTIONS sidebar c-btn = D3,
already ratchet-tracked, burns down with its surface slice.
Packet: `06-implementation/b1-evidence.md`. Pre-staged for next slices: `b2-survey.md`,
`b3-survey.md`, `conformance-manifest.md` (12 PASS / 9 INCONCLUSIVE / 3 PENDING).

---

## B2 (pickers/inputs) + B3 wave 1 (dialogs) — 2026-06-12

**B2 verdict: Pass with deferred proof. B3 wave 1 verdict: Pass.** B2: Popover primitive (capture-phase
Escape stack fixes the picker-in-dialog double-close BY CONSTRUCTION; additive useDismissable
trapFocus/autoFocus opt-outs proven 152/152 regression-free) → LinePicker/ChatPicker/
ContactSearchPicker rebuilt as comboboxes, orphan ContactSearch deleted (grep-proven), TagInput→
removable Pill (labeled removes; accent-tone chip change accepted at the C-B2-3 screenshot
checkpoint, both themes), CardSelector→WAI radiogroup, ToolbarTimeRange adopted at both time
segs (DD-15 narrows to B3 dialog toggles). DD-12/13/14/16 CLOSED. B3 wave 1: Modal --modal-w-* tokens
+ initialFocus (sizing-SSOT leg started), SaveContact extracted (dismissable=false ends
backdrop-destroys-typed-name), Relink (dismissable=true), CreateGroup (dismissable=false,
assertion deliberately inverted) — all dialog contracts live-verified PASS. Checkpoint honesty:
five browser sessions, three context-deaths; the CDP harness proved unreliable for keyboard QA
(global dispatch without focus discipline) — the two reported picker defects investigated to mechanism
(the dialog-collapse report exonerated by captured DOM; the Enter-commit report jsdom-pinned); trusted-event keyboard proof FORMALLY
DEFERRED TO D7 (packet staged, GO). verify:push:branch currently red on main-side fitness-ring
findings in files byte-identical to origin/main — push-gate dependency, server lane owns it.
2,073/2,073; first merge conflict of the program resolved as union (Lock control). Packets:
b2-evidence.md, b3-wave1-evidence.md.

---

## B3 wave 2 — ConfigEditDialog + ScheduleComposerModal — 2026-06-12

**Verdict: Inconclusive — committed; acceptance evidence packet outstanding.**

Commit `71d77108` after packet `b3-wave2-investigation.md` (`7145769d`, Ready with Constraints —
the composer 95vw claim falsified and the ConfigEditDialog open-prop requirement found in
investigation, not implementation). ConfigEditDialog gains an open prop with reset-on-open,
dismissable=false, and ModalHeader/Footer replacing the ad-hoc shell; ScheduleComposerModal drops
its own Escape handling and null-gate for Modal at size=md; both binary toggle pairs move to the
segmented-control pattern (role=group, exactly-one aria-pressed — a DD-15 leg). Five orphaned
per-dialog sizing tokens deleted at zero functional references. The wave-level live
dialog-contract verification that closed wave 1 has not been produced for this wave.

---

## B3 wave 3 — ToolbarTimeRange prep + UpdateModal/GroupDetailModal — 2026-06-12

**Verdict: Inconclusive — committed; acceptance evidence packet outstanding.**

After packet `b3-wave3-investigation.md` (`fab8a11c`, Ready with Constraints). Prep `6500b7f3`:
ToolbarTimeRange gains an additive disabled prop (disabled segments render the attribute and
never fire onChange; three new pins; default behavior byte-stable) so the dialog seg migrations
can keep their saving-key double-fire guard. Migration `d73bef54`: UpdateModal onto Modal at
size=sm, dismissable=false with the single abort-and-cleanup close path — Escape and X stay live
at every update phase while the dangerous scrim-close path is removed; six action sites move to
Button. GroupDetailModal onto Modal at size=lg via the labelledById hatch, the tab strip adopts
the Tabs primitive, all four settings toggle pairs move to ToolbarTimeRange with the disabled
guard, and the dialog gains its first-ever rendering suite (21 tests: backdrop inversion, Escape
stack incl. confirm double-fire, tablist roving, seg contracts, admin gating). The console's last
two hand-rolled document-Escape handlers are gone; zero-consumer dialog CSS blocks and two
orphaned panel tokens deleted grep-gated. Ratchet 533→511 at packet-expected bucket values;
2,193 tests green; typecheck clean (per the commit record).

---

## B4 commits 1–3 — Inbox: ChatList listbox, pane collapse, MessageBubble — 2026-06-12

**Verdict: Inconclusive — lane in flight; acceptance evidence packet outstanding (DD-17 and the
Inbox DD-18r legs close on acceptance, not on these commits).**

After packet `b4-investigation.md` (`7d01d729`, Ready with Constraints). ChatList (`bb9ba869` +
`099caaa4` + `517e4485`): listbox with roving tabindex — arrow navigation moves focus without
selecting (no fetch per keystroke), Enter/Space select, focus survives reorder and removal
(the DD-17 code leg); two assertions strengthened on the integrity flag (label attribute and
no-op contract replace bare presence); the legacy text-t4 token in the empty state replaced,
clearing the shadow-ratchet exceedance the new file introduced (new file, ceiling 0). Pane
collapse (`68a7beda`): the Inbox flex root becomes a container-query root and the contact pane
collapses below the 1080px container threshold — the Fleet squeeze idiom, container not
viewport; legacy pane tokens reconciled onto spec names and values (288→264px chats, 256→248px
contact — deliberate visible change recorded for the live design checkpoint); new Inbox page
harness pins layout class, tokens, collapse target, and listbox wiring; 2,131 green, ratchet
flat at 533. MessageBubble (`d5627923`): the hover-card gains a keyboard path — focus reveals
the detail card instantly, blur hides it, Escape closes one layer only, hover and focus hold the
card independently — and placement is now measured via getBoundingClientRect with a
data-placement attribute and a zero-rect jsdom guard; 14 new tests, the 10 existing hover tests
unchanged as the regression proof; 2,145 green, ratchet flat.

---

## Origin merge — health-confidence conflict set — 2026-06-12

**Verdict: Pass.**

`23710d64` absorbed origin/main's safeguard-diagnostics / health-confidence work (`f617e708`,
`aef8ccd2`, plus `5c70acd7` keyring) through the program's first multi-file conflict set: six
console files (StatusDot, SummaryTab, LineDetail, SoupKitchen, and two test files). Resolved per
the standing rule (our structure, their data): StatusDot resolved wholly to the branch side —
zero diff against our parent, status-map stays the single rendering driver — while SoupKitchen
(+26 lines), SummaryTab, and LineDetail absorb main's health-signal data through the migrated
rendering paths, and main's test additions came through (+4 badge-components, +46 soup-kitchen).

---

## DD-8 — ghost-tier decision (Option B) + execution — 2026-06-12

**Verdict: Pass.**

Decision package `22de54e7` (`dd8-decision-package.md`): the color.md incidental-ink law vs
log-stream.md time-lane spec conflict stated with contrast recomputed from live token values
(text-3 fails AA on every bed in both themes), all 69 ghost-tier hits classified (six essential),
three user-gated options presented. Operator approved Option B (`34f040f3`): the log time lane
promotes to AA ink; log-stream.md amended. Executed `ae46d5b3`: LogStream time lane and
expanded-detail component name move text-3→text-2 — 7.60:1 dark / 6.03:1 light on the log bed,
AA pass both themes; recession preserved via the 11px data-sm size and mono weight, not sub-AA
color. The DD-8 register row narrows to the per-screen essential-text corrections owned by C3
(still blocking).

---

## D6 — enforcement promotion wave — 2026-06-12

**Verdict: Inconclusive — committed per packet; acceptance evidence packet outstanding.**

Four commits after packet `d6-investigation.md` (`db02d0a2`, Ready with Constraints).
`db165001`: design-regression checks 1 and 8 made meaningful — the raw-hex pattern now requires
a color context so decimal issue numbers stop false-positiving, the comment filter is anchored
so it actually excludes commented-out hex, and check 8 pins the expected title against a
missing/match/drift branch instead of an unconditional OK. `ba4ed643`: four rule groups flip per
the lint-plan lifecycle — structural rules global-error outside primitives, focus suppression
scoped-error console-wide with two surveyed carve-outs, raw-button and ad-hoc-modal scoped-error
across the eight migrated files, legacy tokens and utility smells scoped-error inside primitives
— each with negative fixtures proving the promoted severity fires (suite 46→68) and a live
tree-clean proof; promoted selectors move to a shared module so base and shadow configs flow
from one source; WVR-003/004 retired; ratchet keys continuous at 533. `44897b16`: eight matured
regression checks promote to blocking via EXIT_ON_FAIL; verify:push:branch gains the four design
gates — theme parity and the shadow ratchet had been asserted wired but were not (discrepancy
found and closed here); new deterministic design-metrics emitter (per-rule buckets,
live-vs-baseline drift, waiver expiries, register state; fail-closed parsing; 24 fixture tests).
`64332ce8`: four CSS tier-boundary checks from the token layer law; the dangling-var() check
found the spec'd type ramp has zero CSS definitions — eight names, 24 consumers — DD-26 filed
(`2eb066d2`) and every bare reference now carries an explicit fallback.

---

## D7 commit 1 — browser harness + trusted-event smoke gate — 2026-06-12

**Verdict: Inconclusive — lane in flight (the computed-box and deterministic-viewport batteries
this lane owns are not yet built).**

`c3b1ac52` after packet `d7-investigation.md` (`ebc6f29c`, Ready with Constraints): vitest
browser mode on the playwright/chromium provider with exact dep pins and a separate browser
config; a setup sentinel blocks accidental backend fetches and sockets; the smoke gate proves
what jsdom cannot — Tab moves real focus, :focus-visible activates from keyboard-origin events,
Enter fires with isTrusted true, and mock interception works under the provider. The jsdom suite
is excluded and untouched (2,131 green); test:browser stays out of verify chains until the
promotion commit. This is the lane the B2 trusted-event deferral and the DD-10/DD-18r proofs
wait on.

---

## Test-integrity baseline driven to zero — 2026-06-12

**Verdict: Pass.**

`2d829a64`: full-tree scan classified all five grandfathered baseline findings as stale — each
site already strengthened or the scanner grammar gap closed — and surfaced one true weak
assertion in the new GroupDetailModal suite (bare toBeDefined after a throwing getByRole), now
asserting the aria-label value the test name promises. The baseline carries zero findings; any
new weak assertion blocks at the guard.

---

## Coverage audit cover-now closure (+72 tests) — 2026-06-12

**Verdict: Pass.**

`168f63b2` after the coverage audit (`771575ca`, `test-coverage-audit.md`): UnlockScreen from
effectively untested to full coverage incl. the probe-failure catch branch; first Ops page
harness (25 tests: LogStream adoption contract, level filters, empty and error states); FeedCard
degraded-state mappers each driven to rendered severity; SoupKitchen error-panel retry lane with
spy-proven refetch; use-dismissable dark branches pinned (empty-container Tab trap, Shift+Tab
escape recovery, stacked outside-click single-fire). Suite 2,193→2,265; integrity baseline stays
at zero; remaining gaps named honestly — jsdom-impossible SSR guards accepted, clipboard action
deferred by name.

---

## Gate-placement parity — 2026-06-12

**Verdict: Pass.**

`f09f5dc3`: the four design gates (theme parity, shadow ratchet, design regression, design
metrics) now run in CI and in verify:release — previously they fired only on the local pre-push
path, so a no-verify push or web merge landed with zero design enforcement and a release push
enforced less design law than a branch push. The two fitness drift tests join the branch-push
subset so registry/config skew surfaces at branch pushes. Pre-commit gains three sub-second
deterministic guards plus theme parity conditioned on the semantic tokens file being staged. The
fitness taxonomy stops claiming a blocking file-size ratchet guard that does not exist;
implement-or-demote recorded as an open operator decision.

2026-06-14 follow-up: the shared design chain (`npm run verify:console-design`) replaces the partial
quality.yml design mini-list and is also wired into tag-release CI. It covers the former four/five
gates plus token drift, contrast, raw-form inventory, color semantics, resilience, font assets,
brand assets, and design-lint fixtures. `guard:safeguard-diagnostics` now pins both workflow calls.

---

## Per-directory coverage ratchet (report-only) — 2026-06-12

**Verdict: Pass.**

`b4140452`: a threshold checker evaluates vitest v8 coverage against the audit's glob-keyed area
floors (primitives 98/94, hooks 97/93, shared 98/93, lib 84/88 — deliberately no global gate
that would freeze incidental coverage). Deterministic sorted output; fail-closed exit taxonomy
distinguishing coverage-not-run and schema errors from threshold violations; strict mode tested
but unwired pending the gate-placement decision. All four areas pass their floors today; 37
fixture tests; integrity baseline stays empty.

---

## Stale-ceiling metric + pre-push fail-open closure — 2026-06-12

**Verdict: Pass.**

`d761d01d`: design metrics now surface stale-high ratchet ceilings as a first-class field —
baseline buckets whose live count fell below the ceiling are silent slack where new violations
can hide — reported sorted with a per-bucket warning, report-only, stdout determinism preserved;
seven new fixture tests pin the null-vs-empty contract (24→31). The pre-push hook no longer
gates the whole metrics call on eslint presence: the file-based blocking checks (expired
waivers, malformed inputs) run regardless — the old gate was fail-open on exactly the
deterministic path that is supposed to block. Integrator probe: a synthetically inflated ceiling
yields the stale-ceiling count and warning at exit 0; tree restored clean. Harvested from a
context-limit-terminated hardening lane and independently verified by the integrator before
commit.

---

## DD-21r — Wizard in-step tablists onto Tabs (ConfigStep + ModelAuthStep) — 2026-06-12

**Verdict: Pass.**

`ed6391e7`: ConfigStep's five-section tablist and ModelAuthStep's provider tablist replace
their hand-rolled onClick-only role=tab arrays with the Tabs primitive — roving tabindex
single stop, arrow traversal with wrap, Home/End, manual activation; the disabled Local
provider tab becomes arrow-reachable with its reason exposed instead of click-dead; panels
gain tabpanel role wiring. Thirteen keyboard-contract tests pin the behavior. Protected
system-prompt content unchanged; the WVR-011 suppression pin moves one line with its import
and the registry scope follows. Ratchet 509→501 with the regen riding the change (eight tab
buttons leave the raw-button buckets); the wizard files stay off the scoped-error M list
until their remaining raw buttons migrate (per the commit record — superseded for
AddLineWizard by B3 wave 4 below).

---

## B5 — Modal exit motion + refcounted background inert + toast portal — 2026-06-12

**Verdict: Pass** (DD-19 CLOSED — register flip on the D7 evidence packet).

`25629451` after packet `b5-investigation.md`: Modal gains the decided exit mechanism — a
closing phase drives the exit keyframes (120ms ease-exit per the motion law) with unmount on
guarded animationend plus a computed-duration timeout fallback, in a dedicated
use-exit-presence hook; jsdom's empty computed duration takes the synchronous-instant path so
the existing modal suite stayed byte-stable, and reduced motion rides the CSS kill plus the
zero-duration read. Background inert is a refcounted hook on the app root, Modal-only (the
drawer keeps its documented non-modal exception); the toast live region portals to body in
the same change so alerts are never silenced under inert; inert release precedes focus
restore, pinned by test. A separate no-reduce browser-motion config + suite proves the
animated exit path (3/3, reproduced fresh in d7-evidence.md; deliberately NOT in test:browser
or CI pending the gate-placement decision — C-B5-7, recorded not silent). Suite 2,296 green,
ratchet flat (commit record). Harvested from a context-terminated lane; integrator-verified.
The per-directory coverage ratchet later caught the two new hooks under the hooks floor —
closed by the B5 hook suites entry below. DD-25 (toast motion literals) remains open against
the B5 phase.

---

## DD-8 — TSX essential ghost-tier promotions to AA ink — 2026-06-12

**Verdict: Pass.**

`2cd0d5b0`: the decision package's remaining TSX-classified essential sites leave ghost tier
per the approved Option B law — the Inbox chat meta lane (sole rendering of owning line and
chat kind), the MessageBubble at-rest timestamp and media-type row, and the Nav Polling badge
(degraded-transport status). Recession stays size/weight-borne. Thirteen new tests pin each
promotion with positive controls and branch-isolation proofs; exempt de-emphasis sites
verified untouched. Ratchet counts fall below ceiling; the baseline regen deliberately waited
for the in-flight wizard lane so its mid-slice falls could not contaminate the ceiling.
Remaining DD-8 legs (c-col-header tier, empty-state tiering, the log-theme orphan) stay
queued on the wizard lane's CSS files and the C3 per-screen pass — the register row stays
open and blocking.

---

## Console-lint CI parity — 2026-06-12

**Verdict: Pass.**

`b260800e`: the full console eslint step lands in `quality.yml` (verified live: "Console
lint" step ahead of the four design gates). Closes the gate audit's console-lint parity gap —
lint-staged covered only staged files at pre-commit, so merge-introduced or bypassed files
were never linted by the general config anywhere. The audit had held this as needs-decision
pending backlog verification; every integration battery since proved the full run clean, so
the step landed zero-risk additive.

---

## Origin merge — deterministic guard train (#787) — 2026-06-12

**Verdict: Pass.**

`a78737a9` absorbed origin/main's guard train (`2cd4c4d8`, PR #787): restart-safety
pre-flight gate (import-closure link probe blocking the restart-landmine class),
tree-provenance guard for bot hosts, ring import-boundary guard with a 31-edge grandfather
baseline, the fail-closed-gate guard IMPLEMENTED and wired (the registry had declared the
rule with nothing enforcing it), service-unit validity guard (which caught and fixed a real
launchd ${VAR} defect), hardened secret/redaction patterns + advisory history scan (closing
the documented \b-anchored false-negative class), and instance-config integrity (silent-dead-
memory and port-collision classes). Verify chains unioned cleanly: `verify:push:branch` and
`verify:release` now run main's guard set (guard:boundaries, guard:fail-closed-gate,
guard:service-units, guard:instance-config) alongside the branch's four design gates —
verified live in root `package.json`. Console untouched by the merge.

---

## D6 — enforcement promotion wave ACCEPTED — 2026-06-12

**Verdict: Pass with deferred debt** (supersedes the interim "Inconclusive — acceptance
evidence packet outstanding" D6 entry above).

Evidence packet `d6-evidence.md` (design commit `2442ddfd`), gate runs executed fresh
2026-06-12 at impl HEAD `b260800e`: console lint exit 0 (S/F/M/P scopes all hold live),
shadow ratchet 489 ≤ ceiling 501, design-regression 20 checks with blocking set
`1 2 6 8 10 13 14 16` all PASS, design-metrics exit 0 with byte-identical double run and 0
expired waivers, design-lints fixture suite 69/69. All five qa-hardening reviews recorded
(positive, negative, omission, regression, conformance). Flip groups verified against the
live config: S structural global-error outside primitives; F focus-suppression console-wide
with the carve-out narrowed to HistoryTab only (B4 close `9bfde5c3` retired the Inbox
carve-out); M raw-button/ad-hoc-modal scoped-error with the M list growing with migrations
(UpdateModal at `d73bef54`); P legacy-tokens/utility-smell error inside primitives. Shared
selector SSOT `console/eslint-rules/design-selectors.mjs` feeds both configs. Gate wiring
parity closed across pre-push, branch verify, release verify, and CI. Register/waiver delta:
DD-26 opened; WVR-003/004 retired, WVR-002 → permanent with spec citation, WVR-013/014
filed. Deferred debt, named and owned: the lint-plan lifecycle table update (owed to the docs
lane — closed by this docs pass, see lint-plan changelog 2026-06-12), the unrecorded
per-check EXIT_ON_FAIL tripwire transcripts, the `--strict` coverage flip behind the
gate-placement decision, the file-size implement-or-demote operator decision, and the
immature checks each behind a named landing gate.

---

## D7 — browser harness wave ACCEPTED — 2026-06-12

**Verdict: Pass with deferred debt** (supersedes the "Inconclusive — lane in flight" D7
commit-1 entry above). **Zero conformance-manifest flips** — tally stays 14 PASS / 7
INCONCLUSIVE / 3 PENDING by design.

Evidence packet `d7-evidence.md` (design commit `b966fd84`), runs reproduced
integrator-independent from an unmutated clone of committed head `b260800e`: browser suite
76/76 (viewport-matrix 23, keyboard-proofs 9, smoke 4, target-size 37, b5-inert-toast 3) and
the no-reduce motion suite 3/3. The harness performed its designed function on first full
pass: the wave-3 "self-healing recapture" claim (C-B3W3-7) was FALSIFIED under trusted
Chromium Tab — DD-27 filed, the wave-3 disposition formally revised. B2's deferred keyboard
proof debt retired: both reported picker P1s positively exonerated under isTrusted events.
DD-10 narrowed by the computed-box battery with two measured findings — FINDING 1: table
sort buttons measure ~16px, below the 24px floor (pinned as a numeric FINDING case, fix
direction recorded; fix lane dispatched, see below); FINDING 2: pseudo-element hit-areas
confirmed top-side only. DD-18r narrowed (Fleet/LineDetail/Ops viewport matrix in CI; Inbox
rows unblocked but unwritten; drawer-flip case undelivered). DD-19 closed by the integrator
on this packet's evidence. The packet's own strong-claim audit recorded one commit-message
overclaim, one false test pointer, and one name/assertion mismatch — all listed, none
silent. Omissions named: drawer-squeeze suite, focus-ring battery, honesty-label edits,
DD-23 fold case, CI cache + failure-screenshot artifacts, the C-D7-2 live glance.

---

## B3 wave 4 — AddLineWizard onto Modal; dialog burn-down COMPLETE — 2026-06-12

**Verdict: Inconclusive — committed; acceptance evidence packet outstanding** (same standing
as waves 2–3; live QA pending).

`061986ee` after packet `b3-wave4-investigation.md` (`6be734a6`, Blocked(decision)) and the
operator-approved wave-4 decisions (`b970a138`: wizard-local step composite + save-unlinked
discard). The last ad-hoc dialog adopts the shell: open-prop latched lazy mount with
reset-on-open (SoupKitchen's conditional mount would have silently lost focus restore and
exit motion), the step strip rebuilt as the wizard-local composite to the locked v2 anatomy
with aria-current and tokenized step accents, instant step transitions with framer-motion
leaving the file, and the operator-approved discard fix: abandoning after creation keeps the
line unlinked as the confirmation copy always promised — deletion no longer silent
(test-pinned: deleteLine never fires on discard). Static data-line-type accents replace the
runtime injection, retiring WVR-014 — the retirement the D6 packet had flagged as sitting
uncommitted in the wizard lane (registry 11→10 active, matching the metrics expectation
recorded there). Token endgame grep-proven: panel-wizard, modal-min-h, the orphaned
overlay alias, and the stepper one-offs deleted; the c-dialog-backdrop block is dead
console-wide. AddLineWizard joins the scoped-error M list and **the ad-hoc-modal shadow set
is EMPTY across the console** — the dialog burn-down that began at C2.2 is complete; every
dialog surface renders through Modal. New 23-test written-first behavioral suite; ratchet
501→486 with every wizard bucket eliminated (commit record). Resumed from a session-limit-
terminated lane; integrator-verified end to end.

---

## B5 hook unit suites — coverage floor breach closed — 2026-06-12

**Verdict: Pass.**

`889bff89`: closes the coverage-floor breach the per-directory ratchet caught at D6
(test-coverage-audit refresh: hooks 91.79% statements vs the 97 floor, wholly attributable
to the two new B5 hooks). use-exit-presence rises 32→88.5% statements (stubbed computed
durations drive the closing phase in jsdom: guarded animationend, timeout fallback under
fake timers, instant path, StrictMode double-invoke, rapid reopen); use-background-inert
reaches full statement coverage (refcount across stacked consumers, release ordering,
missing-root guard, unmount-while-open cleanup). 42 tests; suite 2,374 green (commit
record). Remaining gaps held honestly: jsdom-unreachable SSR guards accepted, and one
structurally-dead branch the suite analysis exposed — the cancelClosingRef reopen-cancel
mechanism never executes because React effect cleanup nulls the ref before the open=true
check runs — filed as **DD-30** (C3 hook-design finding; whether reopen-mid-dwell can leave
the closing phase stale needs a browser round-trip proof, not a blind delete).

---

## DD-10 sort-button floor — fix lane DISPATCHED — 2026-06-12

**Verdict: Inconclusive — lane in flight.**

Fix lane dispatched for the D7 packet's FINDING 1: give `.soup-table-th__sort-btn` a
min-height meeting the 24px floor and flip the target-size suite's numeric FINDING case to
the floor assertion as the fix proof (the remediation direction the suite itself records).
No commit yet; the DD-10 register row carries the remaining scope (sort-button fix +
bottom hit-extension proof or accepted ruling).

---

## B3 wave 2 — ACCEPTANCE — 2026-06-12

**Verdict: Pass with deferred debt** (supersedes the "Inconclusive — committed; acceptance
evidence packet outstanding" wave-2 entry).

`b3-wave2-evidence.md`: all seven C-B3W2-* constraints verified at tip with file:line evidence;
fresh 201/201 across the seven wave suites (config-edit-dialog 57, schedule-composer 65, pins,
scheduled-tab, chat-picker, primitives-popover); ratchet 563→533 at exactly the packet-§11
bucket values, only-fall held through current 486 with zero ad-hoc-modal buckets repo-wide;
all five orphaned sizing tokens confirmed deleted. Live QA via the visual-qa matrix: composer
segs PASS (row 3); ConfigEditDialog environment-INCONCLUSIVE (row 4 — no mock line carries
`config`; compensated by the shared Modal shell confirmed on sibling dialogs + the 57-test
suite; fixture fix rides C3). Deviations recorded, not hidden: one combined commit instead of
the planned two; per-dialog focus-restore pins never written (DD-33); the C-B3W2-4 seg ruling
never registered (DD-32). Deferred debt: DD-32, DD-33, ConfigEditDialog live confirmation.

---

## B3 wave 3 — ACCEPTANCE — 2026-06-12

**Verdict: Pass with deferred debt** (supersedes the wave-3 "Inconclusive" entry).

`b3-wave3-evidence.md`: C-B3W3-1/2/4/5/6/8 verified with file:line evidence (inverted backdrop
pin, abort-path signal.aborted pin, ToolbarTimeRange disabled contract, baseline diff matching
every §11 bucket); fresh 94/94 (group-detail-modal 21, update-modal 39, a11y 3, sse-error 2,
primitives-toolbar 29). **C-B3W3-7 recorded as FAILED-then-rescoped to DD-27** — the
transient-self-healing disposition falsified in real Chromium (d7-evidence); the browser suite
pins actual escape behavior as characterization. C-B3W3-3 partially discharged: GroupDetailModal
live-confirmed (matrix rows 5/6, corroborated by 13); UpdateModal has no live row — honest
residue filed as DD-34. New integrity findings routed: two test name/claim mismatches in the
update-modal/new suites (primitive-level pins compensate), program-directives execution-log
path corrected same evening. Deferred debt: DD-27, DD-34, DD-18r modal-sizing strike pending
the wave-4 packet.

---

## B4 Inbox — ACCEPTANCE — 2026-06-12

**Verdict: Pass with deferred debt** (supersedes the "Inconclusive — lane in flight" B4 entry).

`b4-evidence.md`: all seven impl commits verified with file:line evidence; sequencing
constraints proven by commit order; fresh runs 125/125 across the five B4 suites + 73/73
enforcement suites, eslint exit 0, ratchet 486≤486, parity 100, typecheck 0. The 10
pre-existing hover-card tests byte-unchanged through the positioning commit. **DD-17
narrowed, not closed:** traversal half done (listbox + roving + arrow contract); the
focus-visible ring never reaches the ChatListItem divs (designed ring block covers only
form elements/anchors) — ring leg stays P2/blocking, C3-owned. DD-18r re-narrowed: Inbox
viewport rows + drawer-flip delivered at `4fbad4ef`; MessageBubble positioning closed at
`d5627923` with a geometry-glance residue for the C3 visual round. Two integrity findings
recorded (weak inbox-page additions with the real proof living in the inverted fixture +
live lint; an unattributed SummaryTab +1 inherited from a main-side merge). Visual rows 1–2
re-verified from surviving frames; no frame shows a selected conversation — those glances
routed to C3, not claimed.

---

## B5 motion polish — ACCEPTANCE — 2026-06-12

**Verdict: Pass with deferred debt** (supersedes the B5 slice's interim standing; the earlier
"B5 hook unit suites — Pass" entry covered only the coverage-floor closure).

`b5-evidence.md`: all nine C-B5-* constraints verified with file:line evidence (instant path,
toast portal, inert-release-before-focus-restore, guarded animationend, duration-stub seam);
fresh hook suites 42/42 + adjacent 87/87; browser proofs cited as records and subsequently
re-validated under the vitest-4 stack (93/93 + motion 3/3 at `76012b68`). The packet's
full-suite run FOUND F-B5-1 — the default vitest config collected the browser-motion lane,
failing full-repo `npm test` — fixed same evening (`76012b68`, fresh 601 files/10,148 green,
zero unhandled errors; the EventSource rejections it also surfaced fixed in the same commit).
C-B5-7 met with recorded deviation (motion config delivered; npm script deliberately unwired
pending the gate-placement decision). Deferred debt: DD-25 re-homed to C3, DD-30 escalated
per c3-investigation (make-live), escape-while-closing pin + header corrections bundled to C3.

---

## B3 wave 4 — ACCEPTANCE — 2026-06-12

**Verdict: Pass with deferred debt** (supersedes the wave-4 "Inconclusive — committed;
acceptance evidence packet outstanding" entry; dialog burn-down acceptance now packet-backed).

`b3-wave4-evidence.md`: all nine C-B3W4-* constraints verified fresh with file:line evidence —
the option-α discard pin (handleConfirmDiscard contains no deleteLine; confirm branches with
"Save and close" primary post-creation), latched lazy mount in SoupKitchen, static
data-line-type accent block replacing the runtime injection (WVR-014 retirement reproduced
post-commit: regression check 19 count=0), baseline diff removing exactly the five predicted
wizard buckets (501→486), ad-hoc-modal shadow set empty console-wide. Fresh runs: wave suites
179/179 (add-line-wizard exactly 23), consumed-contract primitives 61/61, eslint exit 0.
Live QA via matrix rows 8/10/11/12 PASS; row 9 environment-INCONCLUSIVE (502 path) with the
fail-visible banner + jsdom compensations. Honest gaps recorded: four §8 consumer-level pins
absent (primitive-level compensations cited), one suite-header overclaim, one stale Modal.tsx
comment, the `--panel-shortcuts` zero-consumer orphan — all routed to C3. Register delta
executed by the integrator: DD-18r modal-sizing leg STRUCK (all four consumed panel tokens
verified deleted).

## 2026-06-13 — raw-button + accent-law burndown checkpoint; colour/brand decision lock

- `171a6d2c` cleared **raw-button → 0**: 70 raw `<button>` across 29 files migrated to
  `Button` / `ActionButton`; the Button primitive gained an object `ref` (React 19 ref-as-prop),
  unblocking LinePicker's Popover-anchored triggers.
- `100287db` cleared **accent-law → 0**: green action accents rebound `var(--color-s-ok)` →
  `var(--accent)` / `--accent-fg`; dead `.c-btn-send` / `.c-btn-add` recipes deleted. Ride-along:
  legacy-var-css 260 → 221, half-step 68 → 64.
- Self-feeding queue moved **826 → 702** (blocking 756 → 636); two blocking categories eliminated.
- **Validation lesson:** scoped eslint/tsc was insufficient — the first raw-button commit shipped
  4 stale assertions still pinning legacy `c-btn` classes, caught only by the full repo suite.
  Migration commits now require full `npm test` (or full console) validation before commit.
- **Decision lock (this entry):** the four colour/brand follow-on decisions are recorded in
  `02-directions/decision-log.md` and codified in `color.md §2.1` + `brand.md §1.4`, so the colour
  waves no longer depend on agent memory. See those docs for the binding text.
