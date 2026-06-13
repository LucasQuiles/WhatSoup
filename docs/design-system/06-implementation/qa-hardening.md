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
| raw button outside primitive | fails after scoped rule is enabled |
| UI-facing WhatSoup copy where SOUP is required | fails brand-regression rule |
| generic UI-facing WhatsApp copy where channel-agnostic positioning is required | fails channel-specific-copy rule |
| protected internal WhatSoup identifier renamed | fails protected-identifier rule |
| protected channel/runtime identifier renamed (`@s.whatsapp.net`, Baileys, JID, `conversation_key`, generated prompts) | fails protected-identifier or channel-specific-copy false-positive fixture |
| modal without focus restoration | fails modal-restore rule/test |
| missing focus-visible treatment | fails focus-visible rule/test |
| status chip without text label | fails status law rule/test |
| color-only status rendering | fails status law rule/test |
| semantic token missing light value | fails theme-parity check |
| deprecated token usage in migrated directory | fails legacy-token rule |
| utility/spec-smell class | fails or warns per lifecycle |

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
