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

_Awaiting user review._
