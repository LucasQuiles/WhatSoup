# Operator-Provided Research Synthesis 3 (Seed Material)

> **Provenance & authority:** distilled from a third operator-supplied report ("Deep Research Report on
> Contemporary Product Design Systems and UI Direction", 2026-06-11), integrated per plan Seed addendum 3
> as **non-authoritative seed** for T5/T6/T7. The G1-approved direction stays locked — this report does not
> reopen direction selection. All tooling references (DTCG, Style Dictionary, Tokens Studio, Storybook,
> Chromatic, Playwright, Figma) are **research/governance references only — not adoption or implementation
> approval**. Citation markers stripped; claims inherit the source report's verification.

## Convergent validation (third independent confirmation)

Core thesis — "disciplined expressiveness": calm structural layer + selectively expressive presentation
layer, held together by semantic tokens, layout discipline, accessibility, and measurable performance.
Matches the locked direction and seeds 1–2. New framing worth quoting: premium design now means
**"high trust and high throughput," not just "high gloss."**

## New material adopted into task criteria

### T6 (spec) inputs
- **OkLCh ramp engineering:** generate neutral/semantic ramps in a perceptual color space (`oklch()`)
  rather than hand-tweaked HSL — predictable lightness separation makes dual-theme reversals and
  contrast targets tractable. Strong candidate method for tokens-v3 palette derivation.
- **Token transport architecture (reference only):** DTCG-style layering — reference palette → semantic
  aliases → component tokens → platform exports; "author once, translate many, document continuously."
  v3's primitive→semantic→component layering is the same shape; note DTCG `$type`/`$value` format as a
  future implementation-program candidate, NOT adopted now.
- **Typography:** sentence case by default, no all-caps for emphasis (Fluent); reserve display styles;
  tabular numerals in tables/dashboards/logs (already v3 law).
- **Iconography discipline (Fluent):** regular weight = wayfinding, filled = selected/small states,
  12px icons informational-only (too small for interaction), icon size scales with input method,
  mostly monochrome.
- **Layout/density (Carbon):** 8px geometry with explicit breakpoint table (320/4col, 672/8col,
  1056+/16col) as comparison baseline; aspect-ratio set (1:1, 2:1, 2:3, 3:2, 4:3, 16:9); the
  **"more items vs more detail per item"** rule for responsive decisions; data tables get widest
  practical width, never nested; cramped detail views move to side panel or page.
- **Touch targets:** 44×44 iOS/web, 48×48 Android platform minimums (alongside WCAG 24px floor from
  seed 2) — density never undercuts tap targets.
- **Motion budget reconciliation:** report's bands (hover 60–120, popover 120–180, dialog/drawer
  180–240, large panel 220–320, ambient 1200–2400ms low-amplitude optional/interruptible) are
  consistent with the locked v2 token set (instant/120/180/280, ambient ≥1500); no change required.
- **WAI composite-widget law:** a static table is not an interactive grid — editable/sortable/navigable
  cells require managed focus + directional navigation semantics. Encode in `components/table.md`.

### T7 (enforcement/cutover) inputs
- **Enforcement ladder refinement** (merge with existing lifecycle): report-only (repo-wide baseline
  collection) → warn on changed files → guarded merge (block core token/focus/modal rules on changed
  files) → component-maturity blocks (stories/snapshots/semantic-token use on shared primitives) →
  repo hardening on critical paths → steady state with waiver expiry.
- **Lint rule intents** (pseudo-rule precedents): `no-raw-color-in-components`, `no-arbitrary-spacing`,
  `interactive-needs-focus-visible`, `motion-needs-reduced-variant`, `modal-must-restore-focus`.
  The focus-visible and modal-focus-restoration rules are NEW additions to the T7 rule list.
- **Visual-regression governance (reference only):** stories-as-test-units (Storybook), cloud visual/
  a11y baselines (Chromatic), deterministic screenshot gates with volatile-content masking (Playwright).
  Implementation-program candidates; the docs-only program encodes intent in cutover-plan's visual QA
  matrix.
- **Cutover rehearsal rule:** validate the system on **one dense + one expressive + one transactional
  flow** before broad migration — maps to Fleet table/logs (dense), Inbox (expressive/conversational),
  AddLineWizard (transactional). Add to cutover-plan stop/go criteria.
- **Migration guardrail:** codemods and token adapters only in migration PRs; no unrelated refactors
  (reinforces existing one-concern-per-PR rule).

### Reference-library additions (stimulus/study buckets)
- **Studios/watchlist** (study for craft governance, stimulus for visuals): COLLINS, PORTO ROCHA
  (motion as structural brand layer), Ramotion (iconography/micro-interactions), Wolff Olins
  (identity-ambition vs interface-obligation separation), R/GA, Huge (scale + inclusivity), Pentagram,
  ustwo, DIA, BASIC/DEPT, frog, Mother Design, DesignStudio/Further, Tobias van Schneider, Pablo
  Stanley (AI-native tooling culture), Frank Chimero (design judgment).
- **Case-study lessons:** Fluent = semantic maturity (restraint is what makes it durable); Carbon =
  density infrastructure ("systems that handle density well still look premium after six quarters of
  feature growth"); Work & Co = prototype-led validation; Wolff Olins = let identity be bold while
  product surfaces stay semantically governed.

## Reconciliation notes
- Command-palette/command-surface patterns (WAI dialog+combobox composition): remains **v3+ backlog,
  out of scope** (consistent with digest signal 5); the WAI anatomy is recorded for that future work.
- The report's ambient-loop band (1200–2400ms) brackets v2's ok-breathing (2400ms) — compliant.
- Report self-declares weaker coverage of Linear/Vercel/Datadog/Grafana internals — our T3 digest
  covers those directly; no conflict.
- Figma/MCP/Stitch workflow-convergence observations: recorded as context; no tooling decisions in
  this program.
