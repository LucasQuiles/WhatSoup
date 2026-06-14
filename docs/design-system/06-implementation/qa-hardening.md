# Frontend QA Hardening Protocol

Status: **binding for SOUP v3 implementation slices.** This document adds the oversight layer for
the implementation driver. It prevents "mostly done" UI work from passing without proof.

Scope: frontend implementation only. It does not authorize production changes by itself. It applies
once an implementation slice is otherwise approved to run in the implementation worktree.

## 1. Acceptance Rule

No implementation slice may be accepted until it has passed all five reviews:

| Review | Purpose | Required result |
|---|---|---|
| Positive-path review | Prove the intended workflow works. | PASS or FAIL |
| Negative-path review | Prove non-happy states are handled or classified. | PASS / FAIL / BLOCKED / DEFERRED / NOT APPLICABLE / INCONCLUSIVE |
| Omission review | Prove the reviewer looked for what was missed. | Explicit omissions list, even if "none found" |
| Regression review | Prove old behavior, related surfaces, and rollback are safe. | PASS or INCONCLUSIVE |
| Design-system conformance review | Prove fidelity to SOUP v2 Blend and T6/T7 rules. | PASS or FAIL |

If proof is missing, the verdict is **INCONCLUSIVE**, not PASS.

## 2. Required `/frontend-design` Checkpoints

Use `/frontend-design` as a named review checkpoint:

- before accepting any screen as complete;
- when reviewing visual drift from SOUP v2 Blend;
- when resolving ambiguous design decisions;
- when verifying density, spacing, hierarchy, and state coverage;
- before final implementation sign-off.

For each checkpoint, record: reviewer, surface, screenshots/manual evidence, findings, disposition,
and whether the slice remains PASS / FAIL / INCONCLUSIVE.

## 3. Per-Slice Omission Audit

After every slice, answer each question in the slice evidence packet:

- What did we not touch?
- What did we assume was already covered?
- What states did we not render?
- What viewport did we not check?
- What theme did we not inspect?
- What interaction did we not test?
- What primitive did we bypass?
- What old pattern still remains?
- What duplicate code still exists?
- What lint rule does not yet protect this?
- What screenshot evidence is missing?
- What user workflow is still unproven?
- What might look correct but fail under real data?

"None found" is valid only after a concrete scan/review is described.

## 4. Negative-Path QA Matrix

Every migrated surface must classify these cases:

| Case | Status | Evidence / reason |
|---|---|---|
| no data | TBD before acceptance | TBD before acceptance |
| partial data | TBD before acceptance | TBD before acceptance |
| stale data | TBD before acceptance | TBD before acceptance |
| failed request | TBD before acceptance | TBD before acceptance |
| disconnected state | TBD before acceptance | TBD before acceptance |
| degraded state | TBD before acceptance | TBD before acceptance |
| permission-limited state | TBD before acceptance | TBD before acceptance |
| validation error | TBD before acceptance | TBD before acceptance |
| long text | TBD before acceptance | TBD before acceptance |
| long IDs | TBD before acceptance | TBD before acceptance |
| long timestamps | TBD before acceptance | TBD before acceptance |
| many rows | TBD before acceptance | TBD before acceptance |
| one row | TBD before acceptance | TBD before acceptance |
| zero rows | TBD before acceptance | TBD before acceptance |
| narrow viewport | TBD before acceptance | TBD before acceptance |
| reduced vertical height | TBD before acceptance | TBD before acceptance |
| keyboard-only interaction | TBD before acceptance | TBD before acceptance |
| reduced-motion mode | TBD before acceptance | TBD before acceptance |
| light theme under dense data | TBD before acceptance | TBD before acceptance |
| dark theme under subtle contrast | TBD before acceptance | TBD before acceptance |
| repeated open/close interactions | TBD before acceptance | TBD before acceptance |
| Escape/cancel behavior | TBD before acceptance | TBD before acceptance |
| focus restoration | TBD before acceptance | TBD before acceptance |
| interrupted or pending actions | TBD before acceptance | TBD before acceptance |

Allowed statuses: **PASS, FAIL, BLOCKED, DEFERRED, NOT APPLICABLE, INCONCLUSIVE**. No row may be blank
in the final slice evidence. If a case cannot be simulated, document why and classify it.

## 5. Visual Drift Sentinel

Before a screen is accepted, compare it against locked SOUP v2 Blend. Flag any of:

- generic SaaS dashboard feel;
- inconsistent surface elevation;
- light mode feeling like inverted dark mode;
- dark mode relying on too-subtle graphite contrast;
- table density breaking readability;
- toolbar anatomy drifting;
- shape-coded status not paired with text;
- color used without semantic meaning;
- nameplate visually off-center;
- uncontrolled glass or blur effects;
- motion that feels decorative instead of clarifying;
- local button/input/select variants;
- one-off utility styling;
- icon stroke or sizing inconsistencies;
- inconsistent spacing rhythm;
- inconsistent focus rings;
- overuse of accent color;
- "almost matching" tokens instead of approved tokens.

Use `/frontend-design` for this review and record the verdict.

## 6. Coverage Matrix

Maintain one coverage row per slice-surface combination:

| Slice | Surface | Components | Primitives | Themes | Density modes | Viewports | States | A11y | Static checks | Screenshots | Tests | Enforcement | Exceptions | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance | TBD before acceptance |

Allowed verdicts: **PASS, FAIL, BLOCKED, DEFERRED, NOT APPLICABLE, INCONCLUSIVE**. No blank rows.

## 7. No Silent Fallback

If a spec requirement cannot be satisfied, do not silently substitute a weaker pattern. Record:

- original requirement;
- why it could not be implemented;
- fallback chosen;
- user-visible impact;
- design-system impact;
- accessibility impact;
- temporary or permanent;
- cleanup requirement;
- whether user approval is required.

Examples:

- If drawer squeeze-layout is not feasible, do not silently keep overlay behavior.
- If a primitive cannot support a state, do not reimplement that state locally.
- If a token is missing, do not create a one-off utility class.
- If light mode contrast fails, do not defer it as polish.
- If reduced motion is not wired, do not call motion complete.

## 8. Design Debt Register

Maintain design debt in the slice evidence packet or a shared register if the debt spans slices.

| ID | Title | Area | Type | Severity | Reason | Workaround | Owner/next step | Cleanup phase | Expiration condition | Blocks final acceptance? |
|---|---|---|---|---|---|---|---|---|---|---|
| TBD if debt exists | TBD if debt exists | TBD if debt exists | token / primitive / component / accessibility / motion / layout / responsive / test / lint / documentation | TBD if debt exists | TBD if debt exists | TBD if debt exists | TBD if debt exists | TBD if debt exists | TBD if debt exists | TBD if debt exists |

Design debt must not live only in comments, commit messages, or reviewer memory.

## 9. Exception Aging

Every exception must include:

- exact rule being bypassed;
- exact file(s);
- reason;
- safer alternative considered;
- expiration phase;
- cleanup trigger;
- user approval requirement, if any.

At the end of each cutover phase:

- close resolved exceptions;
- escalate expired exceptions;
- block final acceptance if unresolved exceptions affect core design-system integrity.

This extends the T7 waiver policy; it does not replace it.

## 10. Spec Ambiguity Resolution

When implementation exposes ambiguity, classify it:

- wording ambiguity;
- token ambiguity;
- component anatomy ambiguity;
- responsive behavior ambiguity;
- accessibility ambiguity;
- motion ambiguity;
- brand/copy ambiguity;
- enforcement ambiguity.

Resolve by exactly one durable action:

- update the spec;
- update the decision log;
- ask for user decision;
- document an implementation interpretation;
- create a temporary exception;
- block the slice.

Every ambiguity resolution must become durable documentation.

## 11. Cross-Surface Consistency Audit

After each major primitive or screen migration, scan adjacent surfaces for the same pattern:

- Button in Fleet -> Inbox, Wizard, UpdateModal, settings-equivalent surfaces.
- Toolbar once -> every toolbar.
- StatusChip/status law -> every status display.
- Modal -> every dialog-like surface.
- Table density -> every table, log, and list surface.
- SOUP branding -> every UI-facing brand occurrence.
- Token rename -> all consumers.

Do not allow "fixed here, broken elsewhere" without recording remaining surfaces and their phase.

## 12. Design-System Regression Traps

Each enforcement rule should include a negative fixture or documented negative example. Planned traps:

| Trap | Expected failure |
|---|---|
| sample component with raw color | fails raw-color rule |
| component-tier CSS `box-shadow` with raw `rgba()` | fails design-regression check 17 and the `raw-color-css` burndown zero ceiling |
| component/composite CSS with raw `font-size: 14px` | fails the `raw-font-size-css` burndown zero ceiling |
| raw button outside primitive | fails after scoped rule is enabled |
| UI-facing WhatSoup copy where SOUP is required | fails brand-regression rule |
| generic UI-facing WhatsApp copy where channel-agnostic positioning is required | fails channel-specific-copy rule |
| protected internal WhatSoup identifier renamed | fails protected-identifier rule |
| protected channel/runtime identifier renamed (`@s.whatsapp.net`, Baileys, JID, `conversation_key`, generated prompts) | fails protected-identifier or channel-specific-copy false-positive fixture |
| lint suppression without `waiver:<id>` tag | fails design-regression check 15 |
| modal without focus restoration | fails modal-restore rule/test |
| missing focus-visible treatment | fails focus-visible rule/test |
| status chip without text label | fails status law rule/test |
| color-only status rendering | fails status law rule/test |
| semantic token missing light value | fails theme-parity check — negative fixtures live in `tests/scripts/theme-parity.test.ts` via the `check-theme-parity.mjs --file` seam (default no-flag run is byte-for-byte unchanged) |
| deprecated token usage in migrated directory | fails legacy-token rule |
| utility/spec-smell class | fails or warns per lifecycle |
| new shadow-lint warning over the ratchet ceiling | fails shadow-baseline check — negative fixtures live in `tests/scripts/shadow-baseline.test.ts` via the `check-shadow-baseline.mjs --results-json`/`--baseline` seam (default no-flag run is byte-for-byte unchanged; fixtures can never write a baseline) |

If a negative fixture is impractical at a lifecycle stage, document a negative example in the rule entry
and add the fixture when the rule reaches scoped-error.

## 13. Reviewer Challenge Prompts

Before accepting a slice, the reviewer must challenge the work:

- Prove this uses the approved token path.
- Prove this does not introduce a duplicate primitive.
- Prove this works in light mode.
- Prove this works in dark mode.
- Prove this works with real-ish dense data.
- Prove this handles empty/error/loading/degraded states.
- Prove this is keyboard accessible.
- Prove focus is visible and restored.
- Prove motion is reduced-motion safe.
- Prove no protected identifiers were renamed.
- Prove no unrelated refactor slipped in.
- Prove screenshots or review evidence exist.
- Prove this can be reverted cleanly.

Missing proof means **INCONCLUSIVE**.

## 14. Real Data Stress Validation

Use realistic and adversarial data whenever possible:

- very long names;
- short names;
- missing names;
- many statuses;
- all critical statuses;
- mixed degraded/offline states;
- long log lines;
- rapid log updates;
- many table rows;
- narrow columns;
- long filter labels;
- empty filter results;
- timestamps in different formats;
- repeated IDs;
- unusual but valid characters.

Judge implementation under stress, not only curated mockup data.

## 15. Manual QA Scripts

Each critical flow needs a short script with starting route, theme, viewport, data state, steps, expected
visual result, expected keyboard/focus/status/error behavior, and pass/fail notes.

### Fleet Scan And Filter

- Route: Fleet/SoupKitchen equivalent.
- Themes: dark and light.
- Viewports: wide desktop, narrow desktop, reduced vertical height.
- Data: many rows, one row, zero rows, all critical, mixed degraded/offline.
- Steps: scan KPIs, apply mode filter, search, sort if available, clear filter.
- Expected: toolbar anatomy holds; 36/28 density rules hold; status shape + text always visible.

### Open Drawer From Table Row

- Route: Fleet.
- Steps: open drawer from degraded row with pointer and keyboard.
- Expected: drawer uses squeeze-layout rule; focus enters drawer; table priority columns remain readable.

### Re-Target Drawer From Another Row

- Route: Fleet with drawer open.
- Steps: select another row.
- Expected: drawer content updates without stale status; focus behavior remains predictable.

### Close Drawer With Escape

- Route: Fleet with drawer open.
- Steps: press Escape repeatedly.
- Expected: drawer closes once; focus returns to invoking row or next logical target.

### Inspect Log Stream And Filter Levels

- Route: Fleet/Ops/log surface.
- Steps: filter E/W/I/D, expand long log, search empty result.
- Expected: long messages truncate/expand correctly; level tags and text remain semantic.

### Open Modal And Close/Cancel

- Route: any modal-bearing surface.
- Steps: open modal, tab through, Escape, cancel, reopen.
- Expected: trap, close, and restoration work; no double-close behavior.

### Add/Config Wizard Section

- Route: Add Line wizard.
- Steps: move through configuration, trigger validation error, cancel.
- Expected: form primitive states, copy, focus, and validation are consistent.

### Inbox Three-Pane Flow

- Route: Inbox.
- Steps: select conversation, inspect empty/degraded data, use keyboard navigation.
- Expected: expressive surface still follows SOUP elevation, typography, and focus rules.

### Toggle Theme

- Route: every migrated critical screen.
- Steps: toggle dark/light repeatedly.
- Expected: no inverted-mode artifacts; semantic status remains legible.

### Reduced Motion

- Route: every animated critical screen.
- Steps: enable reduced motion, repeat drawer/modal/log interactions.
- Expected: off-and-instant behavior; no information depends on motion.

### Empty/Error/Degraded States

- Route: critical screens.
- Steps: simulate no data, request failure, disconnected/degraded line.
- Expected: calm copy, clear action, no alert fatigue, no color-only status.

## 16. Final Design Acceptance Rubric

Score 1-5:

| Category | Score | Remediation if below 4 |
|---|---|---|
| visual fidelity to SOUP v2 Blend | TBD before final sign-off | TBD before final sign-off |
| typography discipline | TBD before final sign-off | TBD before final sign-off |
| dark theme quality | TBD before final sign-off | TBD before final sign-off |
| light theme quality | TBD before final sign-off | TBD before final sign-off |
| density/readability | TBD before final sign-off | TBD before final sign-off |
| table/log quality | TBD before final sign-off | TBD before final sign-off |
| drawer/inspector quality | TBD before final sign-off | TBD before final sign-off |
| toolbar consistency | TBD before final sign-off | TBD before final sign-off |
| status clarity | TBD before final sign-off | TBD before final sign-off |
| token discipline | TBD before final sign-off | TBD before final sign-off |
| primitive consistency | TBD before final sign-off | TBD before final sign-off |
| accessibility | TBD before final sign-off | TBD before final sign-off |
| responsive resilience | TBD before final sign-off | TBD before final sign-off |
| motion restraint | TBD before final sign-off | TBD before final sign-off |
| brand boundary correctness | TBD before final sign-off | TBD before final sign-off |
| enforcement coverage | TBD before final sign-off | TBD before final sign-off |
| test coverage | TBD before final sign-off | TBD before final sign-off |
| maintainability | TBD before final sign-off | TBD before final sign-off |
| absence of design debt | TBD before final sign-off | TBD before final sign-off |
| future contributor clarity | TBD before final sign-off | TBD before final sign-off |

## 17. Visual Proof Automation Harness

The deterministic capture harness lives at `console/scripts/capture-visual-matrix.mjs` and is exposed
as:

```bash
npm --prefix console run design:capture
npm --prefix console run design:capture:validate -- artifacts/soup-v3-follow-up/visual-matrix/<run-id>/manifest.json
npm --prefix console run design:contrast
```

Default scope:

- routes: Fleet (`/`), Inbox (`/inbox`), Ops (`/ops`), Line detail (`/lines/support`);
- themes: dark and light;
- viewports: 390x844, 768x1024, 1440x900, 1440x500;
- browser context: Chromium, `prefers-reduced-motion: reduce`;
- app state: Vite dev server with mock fallback enabled;
- determinism: fixed clock, seeded `Math.random`, `document.fonts.ready`, forced theme storage, and
  animation/transition freeze before screenshots.

Artifacts are written under `artifacts/soup-v3-follow-up/visual-matrix/<run-id>/`:

- one PNG per route x theme x viewport;
- `manifest.json` with route, theme, viewport, screenshot path, byte size, DOM text length,
  overflow flags, console warnings/errors, page errors, request failures, HTTP errors, and PASS/FAIL
  verdict.

An artifact is `PASS` when its screenshot is non-empty, the route rendered non-empty body text, and no
browser `pageerror` fired. Console warnings/errors and HTTP/request failures remain in the manifest
as review evidence; they do not by themselves replace visual, contrast, or behavior review.

The harness is a proof collector, not a design reviewer. A PASS manifest proves only that screenshots
were captured from populated DOM states under the declared matrix; it does not prove contrast,
semantic color correctness, keyboard parity, or taste. Missing screenshots, launch failures, masked
browser failures, or absent manifest rows are **INCONCLUSIVE** and block token/CSS/visual commits
that require screenshot proof.

The manifest validator lives at `console/scripts/validate-visual-manifest.mjs`. It fails when the
manifest is missing, the declared route x theme x viewport matrix has missing or duplicate rows,
screenshot files are missing or empty, manifest byte counts do not match screenshot files, rendered
DOM text is empty, browser `pageerror` entries exist, artifact verdicts are not `PASS`, or the
top-level manifest verdict is not `PASS`. Console warnings/errors, HTTP errors, and request failures
are summarized as non-blocking review signals because the mock dev-server path can emit expected
backend-proxy noise; reviewers must still inspect them when accepting visual evidence.

The contrast collector lives at `console/scripts/check-contrast-matrix.mjs` and writes
`artifacts/soup-v3-follow-up/contrast-matrix.json`. It recomputes the binding token-pair rows from
`tokens.semantic.css`: ink on surfaces, accent foreground/background, focus ring, status/mode channel
foregrounds on surfaces and own washes, plus any future `--provider-*-fg` and `--data-*-fg` /
`--data-*-solid` tokens. Missing provider/data tokens are recorded as skipped discovery rows until the
palette lands; below-threshold designated pairs fail the gate.

Any score below 4 requires a remediation note. Any score below 3 blocks final acceptance unless the user
explicitly waives it.

### 17.1 Browser A11y Contract Lane

The browser a11y contract lane lives in `tests/browser/a11y-contracts.test.tsx` and runs through:

```bash
npm run test:browser -- tests/browser/a11y-contracts.test.tsx
npm run test:browser
```

It proves browser-only behavior that jsdom cannot establish:

- one app-owned `main` landmark per route shell and one labeled primary navigation region, using
  mocked route sentinels to prove shell ownership without asserting real-page heading copy;
- trusted keyboard `:focus-visible` activation through Chromium-driven Tab events;
- focused controls and their outline boxes remain inside reduced-height viewports;
- Escape closes only the topmost overlay layer when a Popover is open inside a Modal.

This is not an axe gate. Do not claim axe coverage unless a separate dependency packet adds
`axe-core`, updates the lockfile, documents the new command, and records focused proof. Missing
browser a11y rows, unavailable Chromium, or masked browser output are **INCONCLUSIVE** and block
interaction/accessibility packets.

### 17.2 Semantic Token Spec Drift Guard

Semantic token value drift is checked by `console/scripts/check-token-spec-drift.mjs` and is exposed
as:

```bash
npm --prefix console run design:token-drift
```

The guard derives expected per-theme values from `docs/design-system/03-spec/tokens-v3.md` §2.7 and
§3, then compares them to `console/src/styles/tokens.semantic.css`. It covers explicit semantic
assignments and derived status/mode wash, border, and foreground formulas. A missing token or value
mismatch is a FAIL.

The guard does not make the CSS file authoritative, does not cover primitive or component-layer token
drift, and does not replace contrast or browser visual proof. Primitive/component drift remains under
the report-only design-regression lanes until those token families are migrated and promoted.

Masked output, unavailable files, or fixture-only proof without the live repository run is
**INCONCLUSIVE** for token/CSS packets.

### 17.3 Design-System Hygiene Guard

Design-system documentation maintenance is checked by `scripts/design-system-hygiene-guard.ts` and
is exposed as:

```bash
npm run guard:design-system-hygiene
```

The guard reads staged file paths and fails when implementation or gate changes omit their tracked
SSOT maintenance:

- token implementation files (`console/src/styles/tokens.*.css`) require
  `docs/design-system/03-spec/tokens-v3.md`;
- soup/design lint wiring, selectors, and fixtures require
  `docs/design-system/04-enforcement/lint-plan.md`;
- visual capture, manifest validation, contrast, browser-a11y, color-semantics, font, resilience,
  brand-asset, and token-drift harness changes require this QA hardening document;
- font implementation/asset changes require both the typography spec and font provenance README;
- brand asset changes require both the brand spec and iconography spec;
- new root or console `design:*` / `guard:design-system-hygiene` package scripts require this QA
  hardening document.

This guard is wired into the root pre-commit hook in staged mode and into quality.yml CI with
`--changed-since <ref>` so PR/web-merge paths check the committed diff against the base branch. A
PASS means only that the changed packet included the required tracked documentation owner; it does
not prove the documentation is substantively correct. Reviewers still inspect the diff and the
packet evidence.

The hook and CI wiring are protected by `scripts/safeguard-diagnostics.ts`: the safeguard diagnostics
must fail if `.husky/pre-commit` drops repo hygiene, publication, design-system documentation
hygiene, node-pin, settings, or console lint coverage, or if quality.yml drops the changed-range
design-system hygiene step.

### 17.4 Shared Console Design Verification Chain

The root verification scripts call one shared design-system audit tail:

```bash
npm run verify:console-design
```

This chain is the DRY owner for non-browser console design checks in `verify:push:branch`,
`verify:release`, quality.yml CI, and tag-release CI. It currently runs, in order:

1. `npm --prefix console run design:theme-parity`
2. `npm --prefix console run design:token-drift`
3. `npm --prefix console run design:contrast`
4. `npm --prefix console run lint:shadow:baseline`
5. `npm --prefix console run design:regression`
6. `npm --prefix console run design:metrics`
7. `npm --prefix console run design:burndown`
8. `npm --prefix console run design:color-semantics`
9. `npm --prefix console run design:resilience`
10. `npm --prefix console run design:font-assets`
11. `npm --prefix console run design:brand-assets`
12. `npm --prefix console run design:lint-fixtures`

`scripts/safeguard-diagnostics.ts` enforces the shared chain and the fact that push/release
verification plus CI workflows call it. Removing, reordering, or bypassing this chain is a
guard-chain failure.

Report-only audits inside this chain remain report-only. Their presence in the shared chain proves
that a structured inventory was generated during the verification run; it does not prove the inventory is
empty. Any final acceptance claim must cite the finding counts and promotion mode, not merely the
script exit code.

### 17.5 Design Resilience Audit

Layout, text, scroll, layer, and interaction resilience risks are inventoried by
`console/scripts/check-design-resilience.mjs` and exposed as:

```bash
npm --prefix console run design:resilience
```

The audit scans `console/src` for report-only findings:

- `soup/no-unsafe-truncation` candidates: `truncate`, `whitespace-nowrap`, or ellipsis patterns
  without a same-line/adjacent full-value path (`title`, `aria-label`, `aria-describedby`,
  `data-full-value`) or documented exception;
- `soup/scroll-owner-required` candidates: scrollable regions without axis min-size proof
  (`min-h-0` / `min-w-0`) or a declared scroll-owner exception;
- `soup/no-layout-shift-interaction` candidates: hover/focus state classes or CSS that change
  width, height, padding, gap, basis, or min/max dimensions;
- `soup/no-hover-only-content` candidates: hover/group-hover reveal without focus parity or an
  explicit exception;
- `soup/no-vw-font-size` candidates: viewport-width typography;
- `soup/layer-owner-required` candidates: raw z-index utilities that do not consume `--z-*` tokens.

Reviewers apply these rule-of-thumb checks before accepting any migrated surface:

| Area | Required principle | Blocking evidence gap |
|---|---|---|
| Text wrapping | User data must either wrap within its column or expose a full-value path through `title`, `aria-label`, `aria-describedby`, `data-full-value`, or an approved disclosure primitive. | Long names, IDs, timestamps, model names, or log lines are clipped with no full-value path. |
| Numeric sizing | Metric values use stable tabular sizing and reserve room for the longest realistic value plus suffix. | KPI/card/table cells resize the layout when values change or suffixes appear. |
| Control sizing | Buttons, tabs, chips, and icon controls have stable min/max dimensions across default, hover, focus, active, selected, disabled, loading, and error states. | Interaction states change padding, gap, width, height, border width, or grid tracks. |
| Scroll ownership | Every scrollable region declares one content owner and has axis min-size proof (`min-h-0` for vertical, `min-w-0` for horizontal). | Nested scroll areas compete, the owner is ambiguous, or a reduced-height viewport traps content. |
| Sticky/fixed layers | Sticky bars, popovers, modals, drawers, and toasts consume `--z-*` tokens through primitives or named owner annotations. | Raw z-index literals or utility layers appear without ownership proof. |
| Hover/focus parity | Anything revealed on hover is also available through focus, focus-within, touch, or a persistent control. | Row/card actions are hover-only or keyboard users cannot discover them. |
| Reduced-height behavior | Critical routes are checked at reduced vertical height, not only desktop height. | Toolbars, modal footers, composer bars, or primary actions fall below inaccessible scroll boundaries. |
| Small viewport behavior | Fixed-format UI uses responsive constraints (`minmax`, aspect ratio, stable tracks), not viewport-scaled type. | Text or controls overlap, shrink below legibility, or depend on `vw` font sizing. |
| Empty/loading/error states | Empty, loading, error, and degraded states preserve the same space ownership and focus model as loaded states. | State changes remove landmarks, focus targets, or scroll owners. |
| Motion and reveal | Motion clarifies state changes but does not carry required information; reduced motion has an equivalent static state. | Information appears only during animation or reveal timing. |

The package script currently promotes `soup/layer-owner-required` with
`--fail-on-rule soup/layer-owner-required`; raw `z-*`/`z-[N]` layering is blocking once the inventory
is zero. The remaining resilience lanes stay report-only: findings are emitted as structured JSON
with per-rule counts and sample file/line evidence. `--fail-on-findings` exists only for future
promotion packets after the remaining inventory is burned down or documented with sanctioned
exceptions.

A PASS with report-only lanes still present means the audit ran and no promoted rule failed. It does
not prove the UI is resilient, does not replace long-string screenshots, reduced-height screenshots,
keyboard/touch tests, focus-ring checks, or reviewer inspection, and must never be cited as "zero
findings" unless `finding_count` is actually `0`.

### 17.6 Font Asset Integrity Guard

Font delivery integrity is checked by `console/scripts/check-font-assets.mjs` and exposed as:

```bash
npm --prefix console run design:font-assets
```

The guard verifies:

- every `@font-face` in `console/src/styles/fonts.css` uses a local `/fonts/*.woff2` URL;
- every face declares `font-display: swap` and `format("woff2")`;
- every referenced font file exists in `console/public/fonts`;
- every font file is listed in `console/public/fonts/README.md`;
- the README sha256 values match the checked-in bytes;
- no unused `.woff2` files are left in the font directory;
- no external font URLs (`fonts.googleapis.com`, `fonts.gstatic.com`, Typekit, or remote font file
  URLs) appear in `console/index.html` or `console/src`.

This is a substrate gate, not a typeface decision. It proves the active font set is locally shipped
and documented. It does not authorize a Bricolage/Hanken/Plex or other typeface switch unless the
typography spec, token stacks, font files, provenance README, and visual proof all change in the same
packet.

### 17.7 Brand Asset Readiness Audit

SOUP identity asset readiness is inventoried by `console/scripts/check-brand-assets.mjs` and exposed
as:

```bash
npm --prefix console run design:brand-assets
```

The audit is report-only until the approved asset set lands. It checks:

- favicon canvas/viewBox square-ness for small-size and maskable rendering;
- legacy purple/blue bolt palette re-entry (`#863bff`, `#7e14ff`, `#47bfff`, `#aa3bff`, or
  embedded display-p3 variants);
- gradients, filter/glow/blur effects, and mask-heavy illustration structure forbidden by
  `brand.md` §1.3;
- canonical `/favicon.svg` link in `console/index.html`;
- `/manifest.webmanifest` link plus checked-in manifest coverage for at least one maskable icon.

Default mode emits `verdict: PASS`, `mode: report-only`, and finding counts even when the current
asset is known bad. `--fail-on-findings` exists for the later promotion packet after favicon,
badge, PWA, and maskable assets are replaced and visually proven. A report-only PASS must never be
cited as visual approval or 16px legibility proof.

### 17.8 Color Semantics Audit

Provider identity, chart data palettes, traffic quantity ink, and component-local palettes are
inventoried by `console/scripts/check-color-semantics.mjs` and exposed as:

```bash
npm --prefix console run design:color-semantics
```

The audit scans `console/src` for color-system findings. The package script fail-closes
`soup/no-component-local-palette`, `soup/provider-palette-only`, `soup/data-series-token-only`, and
`soup/traffic-neutrality` because provider tokens, data tokens, traffic neutralization, and the
canonical transitional helper at `console/src/lib/color-semantics.ts` have landed.

- `soup/provider-palette-only` candidates: provider identity colour maps or provider display
  contexts borrowing status/mode tokens or literal colours instead of `--provider-*`;
- `soup/data-series-token-only` candidates: chart and heatmap series borrowing status/mode/literal
  colours instead of `--data-*`, unless the series is explicitly provider identity. The tracked
  data-token law now names message volume, active-hours intensity, token input/output, and session
  active/started series. The scanner also treats chart-adjacent `MetricsTab` fallback marks as
  data-series inventory, including arbitrary `bg-[var(...)]` classes, so token fallback bars cannot
  bypass the report-only queue.
- `soup/traffic-neutrality` candidates: non-status traffic quantities such as sent, received,
  sessions, and media rendered with chromatic status/mode ink;
- `soup/traffic-neutrality` neutral paths: `KpiCard color="neutral"` and direct semantic `--text-2`
  styling for raw values. Status/severity KPIs such as connected, attention, unread, failed,
  warning, and health remain outside this rule;
- `soup/no-component-local-palette` candidates: component-local colour maps that duplicate design
  truth outside documented provider/data/status token maps.

The underlying CLI remains report-only when invoked without fail flags, but `npm --prefix console run
design:color-semantics` runs with one `--fail-on-rule` for each promoted lane. A `PASS` from that
package script proves the scanner found zero provider, data-series, traffic-neutrality, and
component-local palette findings. It does not replace contrast checks, screenshots, or semantic
review for new color roles outside the scanner's current categories.

### 17.9 Raw Form-Control Inventory Gate

The raw form-control migration inventory is generated by
`console/scripts/check-raw-form-control-inventory.mjs` and exposed as:

```bash
npm --prefix console run design:raw-form-control-inventory
```

The audit consumes the shadow ESLint JSON for `soup/no-raw-form-control`, not hand-written grep
counts. It emits deterministic JSON with no timestamps and records:

- total raw `input` / `select` / `textarea` findings;
- element split;
- file and line inventory;
- consumer group;
- whether each finding is a consumer migration or a primitive self-hit that can only clear by
  moving the canonical primitive under `components/primitives/**`.

The current enforced inventory is 2 total findings: 2 consumer migrations and 0 primitive
self-hits, with an element split of 2 inputs, 0 selects, and 0 textareas. The former 5
transitional form-kit self-hits cleared only through the D4.2 primitive promotion to
`console/src/components/primitives/FormControl.tsx`; D4.3a cleared the shared `SearchInput`
producer, D4.3b cleared `UnlockScreen`, and D4.3c cleared `TagInput` by routing each through
`TextInput`; D4.3j cleared `ModelAuthStep` by routing API-key input through `TextInput` and
auth-method radios through `RadioField`; D4.3k cleared `GroupDetailModal` by routing its
subject/description/ephemeral controls through the promoted primitives; D4.3l cleared the
ConfigStep enabled-plugin checkbox through `CheckboxField`; D4.3m cleared ScheduleComposerModal's
text, media, datetime, and cron fields through the promoted primitives; D4.3n cleared `HistoryTab`
by routing its reply composer through `TextArea`; D4.3o cleared `Inbox` by routing its message
composer through `TextArea`; D4.3p cleared `ConfigEditDialog` by routing boolean, number, enum,
text, long-text, and JSON inspection fields through the promoted primitives. The two remaining
findings are `ConfigStep` file inputs, held until a FileInput primitive is specced.

The current inventory baseline is the generated file
`console/design-raw-form-control-inventory.json`. The package script does not carry manual expected
counts; it compares the live mechanical scan to that generated manifest. When a packet legitimately
changes the inventory, the update command is:

```bash
npm --prefix console run design:raw-form-control-inventory -- --update
```

The generated inventory update belongs in the same packet as the source/rule change that caused the
movement, with the same exemption-vs-migration classification used for the shadow and burndown
ratchets. `verify:console-design` includes the compare-mode inventory gate after
`lint:shadow:baseline`.

Root `guard:doc-drift` also checks the current inventory claims in this section and
`lint-plan.md` against the generated manifest, so prose counts move with the same packet as the
inventory baseline.

This gate prevents biased or stale raw-form counts. It does not prove a migration is correct, does
not authorize a baseline ratchet, and does not replace behavior tests, accessibility checks, or
browser QA. When the count changes, the packet evidence must explain the exact movement as
consumer-migration, exemption-movement, selector/rule-change, or baseline-only. Unknown movement
blocks the ratchet.

## 18. Done Means Durable

A slice is not done when it only:

- looks correct in one screenshot;
- works in one theme;
- works with curated data;
- passes the happy path;
- relies on local utility hacks;
- has no enforcement path;
- has no accessibility evidence;
- has no rollback path;
- leaves undocumented exceptions;
- requires future agents to infer intent.

A slice is done only when:

- spec traceability exists;
- design conformance is verified;
- states are covered;
- both themes are reviewed;
- accessibility is checked;
- static checks/tests are run;
- screenshots or manual review evidence exists;
- exceptions are documented;
- related surfaces are checked;
- future drift is prevented by docs, primitives, tokens, tests, or lint.
