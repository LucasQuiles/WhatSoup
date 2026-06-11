# Cutover Plan — SOUP Design System v3 (T7)

Status: plan only — implements nothing. Authorized by G2 (Option A conditional lock of "SOUP — v2
(Blend)", `docs/design-system/02-directions/decision-log.md`) and the operator's phased
implementation driver. Production edits begin only with the driver token stage (D1) after the readiness stage (D0)
packet is approved; hard-stops (no push/PR/deploy/main-checkout edits/protocol renames without
approval) apply throughout.

Companion documents: `docs/design-system/04-enforcement/lint-plan.md` (rule catalog + lifecycle),
`docs/design-system/05-cutover/branding-touchpoints.md` (exhaustive brand audit),
`docs/design-system/03-spec/` (T6 formal spec — tokens, typography, color, layout/density, motion,
interaction, iconography, components, brand; per `docs/design-system/README.md:70`).

---

## 1. Phase model and driver mapping

This plan's cutover phases C0-C4 are the *code-change* slices. They map onto the operator driver's
phases as follows (driver: D0 readiness → D1 tokens → P2 primitives → P3 pilot → P4 core
screens → P5 motion → P6 enforcement → P7 testing → P8 cleanup):

| Cutover phase | Driver phase(s) | One-line scope |
|---|---|---|
| C0 — alias layer + CSS split | D0 / D1 entry | restructure token files, zero visual change |
| C1 — token value swap + theme toggle | P1 | new values behind old names; light theme ships |
| C2 — primitive consolidation | P2 + P3 (pilot rehearsal gates broad use) | Button/Modal/Pill/Select/Table/Toolbar/LogStream/Drawer; per-directory migration + lint flips |
| C3 — screen polish | P4 + P5 (motion) | Fleet → LineDetail (9 tabs) → Inbox → Ops |
| C4 — branding flip | P4 tail / P8 | wordmark, title, favicon, copy, docs, tests |
| post-cutover controls | P6 + P7 | enforcement to global-error; regression suite; QA matrix |

Universal rules (apply to every phase):

- **One PR per phase** (large phases may split into stacked sub-PRs per directory, each
  independently revertable).
- **Single-concern rule:** migration PRs contain codemods and token adapters only — no unrelated
  refactors, no opportunistic cleanups (synthesis-seed-3 migration guardrail).
- **Branch hygiene:** implementation work happens in a dedicated implementation worktree/branch,
  never in this design worktree (`soup-design` stays docs-only); never directly on the default
  branch.
- **Rollback = one-commit revert per phase.** The alias-layer design (C0) is what makes C1+
  reverts safe: visual changes are value swaps behind stable names.
- **Stop/go is evaluated at phase exit** against the listed criteria; a red criterion stops the
  next phase, not the current revert (revert only on regression evidence).

## 2. C0 — Alias layer + CSS file split (zero visual change)

**Scope.** Split the 1,236-line `console/src/index.css` token monolith (50 `@theme` tokens at
`console/src/index.css:4-70`, 130 `:root` tokens at `:72-222`; census in
`docs/design-system/00-inventory/token-census.md` §17) into tiered files:

- `tokens.primitive.css` — raw palette/scale values (mode-agnostic; OkLCh-derived ramps per
  synthesis-seed-3 are a C1 concern, C0 carries current values verbatim)
- `tokens.semantic.css` — semantic aliases (`--surface-*`, `--border-*`, `--text-*`, status/mode
  roles per the v2.html vocabulary), each defined per theme scope; at C0 the dark scope simply
  aliases the legacy values
- `tokens.component.css` — the 60+ single-consumer component dimensions currently polluting
  `:root` (`--sk-col-*`, `--panel-*`, `--feed-*`, `--log-col-*`, `--qr-size`…; inconsistency-
  register P1-6)
- `composites.css` — the `c-*` composite classes and feed BEM family, unchanged

**Legacy aliases:** every legacy name (`--color-d0..d6`, `--color-t1..t5`, `--b1..b4`, tints,
spacing, etc.) remains defined, pointing at the new tier — consumers see identical computed values.
The 7 orphan tokens (token-census §15: `--radius-circle`, `--avatar-lg`, `--chat-name-max`,
`--feed-col-time`, `--feed-indent`, `--z-dropdown`, `--opacity-disabled`) are deleted here (dead
weight, zero consumers — the one safe deletion class in a zero-visual-change PR). The 8
`--avatar-hue-*` tokens get an explicit comment documenting the dynamic template-string consumer
(`console/src/components/line-detail/groups-utils.ts:41`) so static-analysis sweeps never remove
them.

**Acceptance criteria.**
- `npm --prefix console run lint` clean; `npm --prefix console run build` succeeds.
- `npm test` green (root vitest covers `tests/console/`, 113 files).
- Pixel-identical screenshots on the QA matrix's smoke row (§6): Fleet, LineDetail Summary, Inbox,
  one modal, dark theme only (no light theme exists yet).
- `rg "var\(--" console/src` count unchanged within ±0 for TSX files (no consumer edits at all).

**Stop/go.** Go to C1 only if zero visual diffs. Rollback: revert the single PR — no consumer
files changed, so revert risk is nil.

## 3. C1 — Token value swap + theme toggle

**Scope.** Behind the C0 names: swap primitive values to the locked v2 palette (Geist typography
stack, electric-blue accent, both palettes — decision-log G2 lock), define the light scope, derive
tints via `color-mix` instead of the 14 hand-copied rgba duplicates (token-census §4; in-repo
precedent `console/src/index.css:1145-1146`), separate the colliding semantic roles
(`--focus-ring` vs `--action-primary` vs `--status-ok` vs `--mode-passive` — inconsistency-register
P2-12, even where dark values coincide), and ship the theme toggle (persisted via the existing
preferences store, `console/src/lib/preferences.ts:5` namespace — key name per T6 spec; note a
`whatsoup:theme` key already appears in test fixtures, `tests/console/preferences.test.ts:43`).

Fonts: Geist + Geist Mono delivery method per T6 `03-spec/typography.md` (self-hosted under
`console/public/` — no new runtime dependency without driver approval).

**Acceptance criteria.**
- Theme-parity script green (lint-plan §5 check 9): both scopes define identical semantic name
  sets.
- `npm --prefix console run lint && npm --prefix console run build` clean; `npm test` green —
  expected casualties: none (tests assert classes/copy, not computed colors; verify with a full
  run, and if any color-literal assertions surface, they flip in this PR and are enumerated in the
  PR body).
- Contrast: AA spot-check table for text ramps × both themes (per T6 color spec; the t4/t5 ramp is
  flagged visually close in token-census §2).
- Visual QA matrix smoke row in BOTH themes.
- soup/no-raw-color and soup/no-untokenized-values evasion-shape closures land here (lint-plan
  catalog); soup/icon-family and soup/protected-identifiers go scoped-error.

**Stop/go.** Go to C2 when both themes render every existing screen without unreadable regions
(manual sweep of the 4 pages + 9 LineDetail tabs). This phase IS the real-screen palette
validation that replaced the declined T8 spike (decision-log: "T8: DECLINED (superseded)").
Rollback: one-commit revert restores old values; names unchanged.

## 4. C2 — Primitive consolidation

**Scope.** Build the primitives in `console/src/components/primitives/`, then migrate consumers
in dependency order **shared → wizard → modals → pages**, flipping per-directory lint scopes as
each directory completes (lint-plan: soup/no-raw-button, soup/no-raw-form-control,
soup/no-adhoc-modal, soup/no-inline-dismiss-handler).

Per-primitive targets (every count evidence-backed in
`docs/design-system/00-inventory/`):

| Primitive | Absorbs | Evidence |
|---|---|---|
| `Button` | 11 `c-btn*` CSS variants + 24 raw buttons + 4 copies of the hover-reveal label mechanic; ad-hoc size overrides in Ops/SummaryTab | inconsistency-register P1-1; control-catalogue §1; duplication-register DUP-01 |
| `Modal` + `useDismissable` | 11 dialog surfaces (table at control-catalogue §9), 9 Escape effects (DUP-04 list), backdrop/shell/header/footer split, focus trap + restore (zero exist today), stacking-aware close (fixes GroupDetailModal+ConfirmDialog double-Escape, ia-workflow-review §5.1) | P1-2; DUP-04 |
| `Pill` | 9+ chrome recipes: FilterPill, TagInput chips, LineTags, ModeBadge, fc-inst, fc-badge, picker chips, AlertBanner chips, GroupCard badges; tone × size × interactive × removable | P1-5; control-catalogue §5; DUP-02 |
| `Select` policy | 3 native selects (3 stylings, one dressed as a ghost button at `console/src/components/line-detail/GroupDetailModal.tsx:676-685`), `.c-select` 1 consumer; popover dropdowns (LinePicker ×2, ChatPicker, ContactSearchPicker — the last has no dismiss at all) onto `useDismissable` + a `Popover` panel | P2-1; control-catalogue §3; DUP-03 |
| `Table` (+ density) | one-table strategy with `--row-default: 36px` / `--row-compressed: 28px` (G2 lock); adopt `c-cell` semantics beyond SoupKitchen; AccessTab re-typed padding | P2-10/DUP-10; decision-log "C → densities" |
| `Toolbar` | `[filters | time-range · search · primary]` anatomy used identically ×3 in v2 | decision-log "C → toolbar" |
| `LogStream` | the two drifted log-viewer twins (`console/src/components/line-detail/LogsTab.tsx:43-62` vs `console/src/pages/Ops.tsx:258-289`) onto one component; E/W/I/D letter tags per v2 | DUP-10 |
| `Drawer` | drill-in inspector with the **squeeze-layout rule** — table reflows rather than pure overlay (G2 mandatory item 1; spec home `03-spec/components/drawer.md`) | decision-log G2 conditions |
| Form kit promotion | `console/src/components/wizard/form-primitives.tsx` → `components/form/` (or shared/); migrate the 4 re-rolling dialog surfaces | P2-2; DUP-12 |
| `StatusDot`/status helper | one `lib/status.ts` map; StatusDot/ModeBadge as sole renderers; delete the 7 re-implementations incl. the inline LineDetail header copy (`console/src/pages/LineDetail.tsx:148-162`) and the radius-token-as-width dot (`console/src/components/line-detail/ScheduledMessageRow.tsx:92-98`) | P1-4; DUP-06/07 |
| `Spinner` + EmptyState compact | 9 ad-hoc `Loader2 + animate-spin` sites; ChartPanel's 3 hand-rolled states; `.feed-empty` CSS | DUP-11; P2-9 |

Each migrated directory's PR flips that directory into the scoped-error list in
`console/eslint.config.js` (the existing per-file-list block pattern at
`console/eslint.config.js:688-706`). Dead CSS deleted as adoption completes: `.c-toggle`
(`console/src/index.css:1162`), `.c-dialog-body` (`:932`) — adopt-or-delete per P3-1.

### Cutover REHEARSAL rule (binding)

Before C2 migration extends beyond the shared directory — and as the gate into broad C3 — the
system must be validated end-to-end on exactly three flows (synthesis-seed-3 rehearsal rule; this
is the driver's P3 pilot):

1. **Dense:** Fleet table + toolbar + log stream (compressed density, status shapes, drawer)
2. **Expressive:** Inbox (conversation idiom, bubbles, composer)
3. **Transactional:** AddLineWizard (form kit, stepper, modal shell, QR link step)

Each rehearsal flow runs the full visual QA matrix (§6) and keyboard-only pass. Findings feed back
into primitives BEFORE other directories migrate. No broad C3 work starts until all three
rehearsal flows are signed off.

**Acceptance criteria (per directory PR).**
- `npm --prefix console run lint` clean with the directory newly in scoped-error.
- `npm test` green; tests that pin current class strings are updated in the same PR and listed in
  the PR body (known sensitive structural tests: `tests/console/design-token-classes.test.ts`,
  `tests/console/design-system-compliance-pages.test.ts`,
  `tests/console/line-detail-card-shells.test.tsx`,
  `tests/console/line-detail-ds-compliance-round2.test.ts`,
  `tests/console/design-system-scheduled-groups-primitives.test.ts`,
  `tests/console/form-primitives.test.tsx`, `tests/console/confirm-dialog.test.tsx`,
  `tests/console/modal-workflows.test.ts`, `tests/console/update-modal-a11y.test.tsx`).
- Modal primitive PR additionally proves: Tab cycle trapped, Escape closes top layer only, focus
  restored to invoker, `aria-modal` on the panel (not the backdrop — current AddLineWizard bug,
  control-catalogue §9).
- Visual QA matrix rows for every surface the directory touches.

**Stop/go.** Per-directory; a failed directory pauses ONLY that directory's flip (revert the
directory PR), the primitive layer stays.

## 5. C3 — Screen polish (core screens + motion)

**Order:** Fleet (SoupKitchen page) → LineDetail (9 tabs: Summary, Metrics, History, Logs, Access,
Mode, Pipeline, Scheduled, Groups) → Inbox → Ops. Rationale: Fleet is the rehearsed dense surface;
LineDetail is the largest blast radius (its tab bar is also the biggest non-`.c-tab` system,
`console/src/pages/LineDetail.tsx:228-252`, P2-6); Inbox rehearsed; Ops shrinks once LogStream
absorbs its viewer.

In-scope per screen: v2 layout/density adoption, semantic-token-only styling, Tabs primitive
adoption, the screen-level fixes the register binds to consistency (dead affordances P2-8: wire or
remove Cmd/Ctrl+K, alert click-through, not-found state for unknown `/lines/:name`; empty/loading/
error canonicalization P2-9; confirmation policy `useConfirm` P2-7). Motion tokens (driver P5)
land with the screens that use them: instant/120/180/280 bands, paired easings, exits faster,
reduced-motion off-and-instant, single ambient ok-breathing (G2 lock); soup/no-infinite-animation
and soup/motion-needs-reduced-variant move up the ladder here.

**Acceptance criteria (per screen PR).**
- `npm --prefix console run lint` clean; `npm test` green; `npm run typecheck:all` clean at the
  repo root.
- Full visual QA matrix for the screen (§6) in both themes, both densities where applicable.
- Keyboard-only walkthrough recorded in the PR body (focus order, traps, shortcuts).
- `npm run verify:push:branch` green before push (root `package.json:50`).

**Stop/go.** Screen-by-screen. SoupKitchen→Fleet *naming* does not flip here (C4) — C3 changes
chrome, not vocabulary, to keep PRs single-concern. Exception: if a screen rewrite would touch the
same lines twice (e.g. Nav labels), the operator may approve folding the rename into C3 for that
file — record the decision in the PR body.

## 6. C4 — Branding flip

Exhaustive inventory with per-occurrence tags: `docs/design-system/05-cutover/branding-touchpoints.md`.
Summary of the flip set (UI-copy / docs / test-assertion categories only — protocol contracts are
PROTECTED and do not change):

- **Nav wordmark → SOUP nameplate:** `console/src/components/Nav.tsx:36-41` (currently split spans
  `What` + `Soup`) → nameplate per `03-spec/brand.md` (mono spaced-caps SOUP + teal tick;
  tracking/optical-centering tuning is G2 mandatory item 2).
- **Nav label "Soup Kitchen" → "Fleet":** `console/src/components/Nav.tsx:53`; shortcuts help
  label `console/src/components/KeyboardShortcutsHelp.tsx:8`; Ops empty-state copy
  `console/src/pages/Ops.tsx:119`; comment `console/src/hooks/use-keyboard-shortcuts.ts:23`.
- **index.html title:** `console/index.html:7` `<title>WhatSoup Console</title>` → per brand spec.
- **Favicon spec:** `console/public/favicon.svg` is a purple/blue bolt mark (fills `#863bff`,
  `#7e14ff`, `#47bfff`) unrelated to the locked SOUP identity — replace per `03-spec/brand.md`
  (deliverable: new SVG, plus `console/index.html:6` link unchanged).
- **UpdateModal copy:** `console/src/components/UpdateModal.tsx:318` "Update WhatSoup" → "Update
  SOUP" (or specced phrasing).
- **SoupKitchen.tsx file/component rename → Fleet:** recommended at C3/C4 boundary as its own
  sub-PR; blast radius enumerated in branding-touchpoints §3 (component+file+lazy import
  `console/src/App.tsx:11,55`, CSS comment `console/src/index.css:153`, 8 test files incl. the
  source-string assertion `tests/console/error-boundary.test.ts:42` and path-readers
  `tests/console/design-token-classes.test.ts:26`,
  `tests/console/design-system-compliance-pages.test.ts:96`).
- **Docs:** `docs/console-guide.md:3,9,110,163` (3=product name, 9=section heading "Soup Kitchen
  (Fleet Overview)", 110=view name; 163 contains `~/.config/whatsoup/` paths — PROTECTED, rename
  the prose around them only); `console/README.md:1,3,22` (22 references the whatsoup config —
  prose flips, paths stay).
- **Test assertions** (flip in the same PR; exact list in branding-touchpoints §4):
  `tests/console/update-modal.test.tsx:171-173`; `tests/console/nav-status.test.tsx:59-63` and
  `:46-48`; `tests/console/nav.test.tsx:55,62-71,78,86,96`; `tests/console/app.test.tsx:326-330`;
  `tests/console/keyboard-shortcuts-help.test.tsx:164,193` — approximately 8-10 assertion sites
  across 5 files, plus the rename-coupled files above.
- **UI-copy vocabulary audit:** sweep status language, action verbs, confirmations, tooltips,
  empty states against the locked vocabulary (Fleet / Line / attention): "instances" survives only
  in process-level copy (e.g. `console/src/pages/Ops.tsx:119` "No instances discovered" flips to
  Line phrasing; UpdateModal's "restart-instances" *phase id* is internal and stays, its visible
  copy flips). The wizard's generated CLAUDE.md (`console/src/components/wizard/ConfigStep.tsx:114`)
  is EXEMPT-PROTECTED (agent-contract content, outlives UI rebrand) unless the operator separately
  approves a product-level rename.

soup/no-brand-regression flips to error in this PR (lint-plan lifecycle table).

**Acceptance criteria.** lint + build + `npm test` green; design-regression checks 5-8 green
(WhatSoup-in-UI, split-wordmark, Soup Kitchen, title); check 10 (protected contracts present)
green — proving the flip did NOT touch `whatsoup:` prefix, socket paths, workspace paths,
`mcp__whatsoup__*`, or `WhatSoupError`-adjacent contracts.

**Stop/go.** Visual sign-off on nameplate in both themes at both nav densities. Rollback: single
revert (copy + assets + tests in one commit).

## 7. Safeguards

**Pre-phase (every phase).**
- Fresh branch from current default-branch head in the implementation worktree; record base SHA in
  PR body.
- Run the design-regression suite to capture the BEFORE counts; attach to PR.
- Confirm no concurrent console PRs in flight (single-writer rule for `console/src` during
  cutover).

**During.**
- Codemods/token adapters only; any hand edit beyond the phase's stated scope is a review-blocking
  finding.
- Baseline counts may only go down (ratchet): the suite's check counts are compared against the
  recorded BEFORE.
- Hard-stops honored: no push/PR/deploy without explicit approval per the driver.

**Post.**
- Screenshot set archived per phase (matrix rows) for the next phase's BEFORE.
- Lifecycle table in lint-plan updated in the same PR as any rule-state change.
- Phase retro note appended to `docs/design-system/02-directions/decision-log.md` (one paragraph:
  what diverged from plan).

### Future-PR review checklist (applies to ALL console PRs after C1)

1. Semantic tokens only — no raw values, no legacy `--color-d*/t*/b*` names (post-C2).
2. Reuse before invent — existing primitive/composite checked first; duplication-register
   consulted for known patterns.
3. Both-theme parity — change verified in dark AND light.
4. Reduced-motion usable — feature works with animations off-and-instant.
5. Keyboard/focus/24px targets preserved — tab order, visible focus, WCAG 2.2 target floor.
6. One migration concern per PR.
7. Screenshots for all affected states: default/hover/focus/disabled, loading/empty/error/
   degraded, both themes, both densities where the surface supports them.

### New-primitive request process

A PR may not introduce a new component under `components/primitives/` without: (1) a duplication
check against `docs/design-system/00-inventory/duplication-register.md` and the existing primitive
set; (2) a one-page request (problem, why no existing primitive/composition fits, proposed API,
token needs) appended to `docs/design-system/03-spec/components/` for review; (3) operator or
design-owner approval recorded in the PR. The soup/no-duplicate-shell advisory message points
here. Waivers (lint-plan §4) are the escape hatch for one-off needs that do not warrant a
primitive.

## 8. Visual QA matrix

Dimensions (from synthesis-seeds + G2 lock). A full matrix run is the cross-product pruned to the
cells that exist for the surface under test:

| Axis | Values |
|---|---|
| Theme | dark, light |
| Density | default (36px rows), compressed (28px rows) — table/log surfaces only |
| Interaction state | default, hover, focus(-visible), disabled |
| Data state | loading, empty, error, degraded |
| Layer | base page, drawer open (squeeze-layout verified), modal open |
| Input mode | pointer, keyboard-only |
| Motion | normal, prefers-reduced-motion |
| Viewport | desktop wide, 320px reflow floor (no 2-D scrolling — seed-2) |

Screenshot comparison expectations: deterministic captures with volatile content masked
(timestamps, sparklines, live counters — the mock-data layer `console/src/mock-data.ts` is the
deterministic fixture source, per its header "Deterministic sample data for documentation
screenshots and demos"). C0 expects pixel-identical; C1+ expects intentional diffs only, each
explained in the PR body. Tooling (Storybook/Chromatic/Playwright) remains reference-only per
synthesis-seed-3 — until adopted, comparison is manual against the archived per-phase screenshot
set.

## 9. Post-cutover regression controls and completion definition

Controls (steady state):
- Design-regression suite blocking in pre-push and `verify:push:branch` (lint-plan §5).
- soup/* rules at their target lifecycle states (lint-plan table); waiver registry with enforced
  expiry; quarterly lifecycle review.
- Theme-parity script blocking; brand checks 5-8 blocking.
- New-primitive request process + advisory shell tripwire as the anti-entropy pressure.

**Completion definition.** The cutover is COMPLETE when every legacy path is exactly one of:
1. **removed** — legacy token names, `.c-section`, `.c-toggle`, `.c-dialog-body`, the 4 reveal-
   label CSS copies, the feed BEM family (absorbed or chartered), the orphan component
   `console/src/components/ContactSearch.tsx` (zero importers, component-inventory orphan note) —
   deleted from the tree;
2. **quarantined** — explicitly chartered exceptions documented in the spec with a waiver entry
   (e.g. recharts style objects); or
3. **lint-enforced** — impossible to reintroduce silently (soup/* at scoped/global error +
   regression suite).

Driver P8 (cleanup) closes by running the full suite, confirming the lifecycle table shows every
rule at target state, and archiving the cutover screenshot history.
