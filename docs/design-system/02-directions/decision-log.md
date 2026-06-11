# Direction Decision Log — SOUP Design System v3

Records per-round critique, user feedback, and gate decisions for the T4/T5 direction mockups.
Gate approval format: `Approved G<N> on YYYY-MM-DD: <decisions>`.

## Round 0 — Direction candidates (T4)

Three candidates built from T2 inventory truth + T3 research signals. All three: dual dark/light
themes (designed, not inverted), mode trio preserved (passive/chat/agent), status-first color,
4px grid, control sheet + fleet dashboard + inbox 3-pane + wizard/modal surfaces, two naming
vocabularies shown, reduced-motion notes inline.

| Direction | Bet | File |
|---|---|---|
| A — Instrument | Hardware-panel precision: hairline rules, lamp indicators, mono-forward numerics, gauge KPIs | `direction-a-instrument.html` |
| B — Editorial precision | Linear/Geist restraint: negative space, refined grotesk, soft elevation, exact focus rings | `direction-b-editorial.html` |
| C — Ops console, refined | Grafana/Datadog density distilled: tabular rhythm, structured toolbars, status-only color | `direction-c-ops.html` |

### Build notes

- B built clean in one pass (2,337 lines). A and C were truncated mid-build by an environment token
  limit and completed on agent resume (A: 1,744 lines; C: 2,265 lines). All three verified: balanced
  HTML, closing tags, zero local paths, zero guard-tripping banner runs, render-checked in headless
  Chrome (dark + light at top-of-page; deep-scroll viewport captures unreliable in this headless
  setup — content verified via DOM extraction instead; full manual `file://` review at G1).
- All three independently converged on the same vocabulary: **Soup Kitchen → Fleet**, single
  user-facing noun **Line** ("instance" demoted to process/infra copy), Inbox/Ops kept, one unified
  "attention" alert definition. That convergence is itself a G1 signal.

### Critique & maturity scorecards

Self-critiques are the building agents' own; comparative notes are the integrator's.

**A — Instrument** (IBM Plex Mono + Sans; instrument orange `#ff6b2b`/`#bc3d08`; mono spaced-caps
faceplate labels; lamp indicators with disc/diamond/square shape coding; SOUP nameplate engraving).
- Self-critique: strongest in dashboard + control sheet (hairline structure, gauge-rail KPIs,
  quiet-annunciator discipline make unhealthy lines unmissable); weakest in inbox (bubble idiom
  resists the instrument language, reads austere for human chat); light-theme hairlines run near the
  visibility floor; single orange accent does triple duty (primary/focus/selection) leaving little
  interactive-hierarchy headroom.
- Integrator notes: the most *distinctive* identity of the three — instantly un-generic; the strongest
  brand story (nameplate). Risk: spaced-caps mono labels cost horizontal density and may fatigue at
  8-hour operator sessions. Scale risk to 9 LineDetail tabs untested.

**B — Editorial Precision** (Geist + Geist Mono; electric blue `#6BA6FF`/`#2563EB`; "soup." lowercase
wordmark with passive-teal period).
- Self-critique: honest Vercel-adjacency risk — only the mode-trio chroma and operator density keep it
  from reading as a Geist clone; inline-style density in the mockup undercuts the tokens-only story
  (implementation must not inherit that); drill-in and wizard are single-state vignettes, so density
  proof lives in control sheet + inbox.
- Integrator notes: the most *finished* execution and the best inbox of the three (bubble idiom is
  native here); cleanest light theme; the safest path to "Apple-level consistency." Risk: least
  differentiated — the wordmark and mode trio carry all brand distinctiveness.

**C — Ops Console, Refined** (Plex Sans Condensed/Sans/Mono; NO accent — achromatic chrome, color =
semantics only; SOUP rack-label lozenge; two table densities; toolbar + log-stream specimens; working
drill-in drawer).
- Self-critique: total-achromatic-chrome is the sharpest and riskiest bet — hierarchy rests entirely on
  type weight and alpha, and the four dark surfaces may compress to mud on low-quality displays; inbox
  inherits table rhythm and reads austere; light theme genuinely designed but less iterated — the
  warn-orange wash on white needs CVD/AA verification first.
- Integrator notes: the most *operationally literate* — only direction with both densities, the
  toolbar/log-stream patterns, and a working drawer (signal 6); best answer to the dense-data mandate.
  Risk: lowest brand warmth; "primary action is achromatic" needs user validation — it defies habit.

**Comparative maturity scorecard** (1–5, integrator assessment; G1 may override)

| Criterion | A | B | C |
|---|---|---|---|
| Clear point of view | 5 | 4 | 5 |
| Premium/polish execution | 4 | 5 | 4 |
| Operator fit (scan, status clarity) | 4 | 4 | 5 |
| Dense-data fit (tables/logs) | 4 | 3 | 5 |
| Inbox/conversation fit | 2 | 5 | 3 |
| Light theme quality | 3 | 5 | 4 |
| Brand distinctiveness | 5 | 3 | 4 |
| Gimmick risk (5 = lowest risk) | 3 | 5 | 4 |
| Scale risk to all screens (5 = lowest) | 3 | 4 | 4 |
| Enforceability via tokens/primitives | 4 | 4 | 5 |

**Blend candidates** (pre-G1 hypotheses, not recommendations): B's inbox + light theme with A's
nameplate/wordmark discipline; C's table/toolbar/log patterns + density variants grafted into either
A or B as the data layer; A's lamp/shape status coding adoptable by any winner.

## G1 — Direction selection

**Approved G1 on 2026-06-11:** direction/blend = **B-Editorial chassis + A grafts + C grafts** —
B supplies the chassis (Geist typography, elevation law, electric-blue accent, inbox idiom, light theme);
A grafts the nameplate/wordmark discipline and lamp/shape status coding; C grafts the two table densities
(default/compressed), the toolbar pattern, and the log-stream treatment.
Naming vocabulary = **converged set locked**: Soup Kitchen → Fleet; single user-facing noun "Line"
("instance" demoted to process-level copy); Inbox/Ops kept; one unified "attention" metric;
the SOUP wordmark carries the brand playfulness.
Required changes = none beyond blend integration. Decision captured via gate question
(blend option selected as recommended).

## Round 1 — Blend refinement (T5)

Target: `iterations/v2.html`. Brief: B chassis integrating A + C grafts; resolve B's self-critique
(Vercel-adjacency → counter with nameplate distinctiveness + mode-trio chroma; replace single-state
drill-in vignette with fuller treatment; keep tokens-only discipline). Motion per T3b token set;
reduced-motion off-and-instant; glass/translucency accent-only per synthesis-seed-2.

**Delivered:** `iterations/v2.html`, 2,799 lines, both themes render-verified.

Grafts executed:
- **A → nameplate:** mono spaced-caps `SOUP` (Geist Mono 600, +0.38em) + one teal square tick,
  codified as ramp style `--type-nameplate`, reserved for the mark.
- **A → shape law:** `.shape--ok/warn/crit/off` (disc/diamond/square/outline) everywhere status renders,
  always with text label. A's crit-blink **rejected** — single ambient-motion budget spent on ok-breathing.
- **C → densities:** `--row-default: 36px` / `--row-compressed: 28px` as tier-1 tokens; control sheet
  shows both; Fleet runs compressed, forms stay default.
- **C → toolbar:** `[filters | time-range · search · primary]` anatomy, used identically ×3.
- **C → log stream:** first-class block (E/W/I/D letter tags, expandable, live level-filter), ×3 incl.
  drawer-scoped log.
- **Seed-2 constraints honored:** enter/exit easing pair, exits faster (modal 180/120, drawer 280/180),
  reduced-motion off-and-instant, glass confined to header chrome + scrim, 24px target floor, 80ch measure.

Self-critique resolutions: Vercel-adjacency countered (nameplate + mode-trio presence); drill-in vignette
replaced by functional drawer/inspector over Fleet (row-retarget, Escape, remedies, scoped log);
inline-style shortcut resolved (utility/ramp classes; lintable rule: inline style may carry only `var()`
refs or data-driven custom properties).

Fresh self-critique (carried to G2 review): (1) drawer overlays the compressed table's right columns —
production needs squeeze-layout (table reflows) rather than pure overlay; (2) nameplate +0.38em tracking
leaves trailing letter-space after "P", optical centering untuned; (3) `.w-160`/`.mt-3`-style utilities are
spec-smell — T6 must replace with composition-level primitives, not carry them into the codebase.

## G2 — Visual and spec lock — APPROVED

**Approved G2 on 2026-06-11: Option A — conditional lock of v2 Blend.**
Decision source: operator's "Operationalization Prompt — SOUP Frontend Implementation Driver"
(2026-06-11), which explicitly authorizes implementation work and declares "SOUP — v2 (Blend) is the
leading/locked implementation direction unless explicitly superseded" — recorded as Option A from the
G2 review package, with the three open items carried as **mandatory resolution criteria**:
1. Drawer squeeze-layout rule (T6 spec requirement — `components/drawer.md` + table reflow rule).
2. Nameplate tracking/optical centering (T6 spec requirement — `brand.md` tuning rules).
3. Utility/spec-smell conversion to composition primitives (T6 spec requirement + T7 lint tripwire).

Locked: visual language (B chassis + A/C grafts), Geist typography, both palettes, electric-blue accent
strategy, motion strategy (instant/120/180/280, paired easings, exits-faster, reduced-motion
off-and-instant, single ambient budget on ok-breathing, crit-blink rejected), SOUP nameplate direction,
state taxonomy + shape-coded status law, density model (36/28), one-table strategy, log-stream strategy,
drawer/inspector strategy, toolbar anatomy, locked naming vocabulary.

**T8: DECLINED (superseded).** The G2 package recommended declining absent a need for live palette
evidence; the operator's implementation authorization makes the throwaway spike moot — the token
foundation stage of implementation provides real-screen validation under full review instead.
No T8 spike will run.

**Scope transition note:** the operator-supplied implementation driver constitutes the "separate
implementation plan" the design-phase plan required post-G3. Sequence honored: T6/T7 now execute
(post-G2 per plan), the G3 package follows, and production edits begin only with the token
foundation stage after the implementation-readiness packet is approved. All implementation stages
run under the driver's hard-stop conditions (no push/PR/deploy/main-checkout edits/protocol renames
without approval).

## (superseded heading) Visual and spec lock

Review package: `g2-review-package.md`.

Recommendation: **Option A — lock v2 Blend with conditions.** The three open items are conditional
approval items, not reasons to reopen the full direction space unless user review finds them unacceptable:
drawer squeeze-layout rule, nameplate optical centering/tracking, and utility/spec-smell conversion into
primitives/composites or anti-patterns.

Awaiting user review of `iterations/v2.html` (both themes) and `g2-review-package.md`.
Decisions required:
- Option A / B / C for G2 lock.
- Whether optional T8 is approved or declined.
- Any specific visual/spec refinements to carry into T6/T7 or a targeted Round 2.

T6, T7, and T8 remain blocked until explicit G2 approval and, for T8, separate explicit approval.
