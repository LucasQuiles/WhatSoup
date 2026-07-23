# 20 — T5 Cutover Plan (build tracks, G2-gated)

The v3.5 redesign as shipped on main (docs 00–19) becomes the running console.
Tracks branch off `main`, one PR per bead, cross-model review on every bead
(wave-4 rule: a different family reviews than wrote).

## Gate state

- **G1** (lock A): ✅ — program on main.
- **G2** (spec lock): pending owner sign-offs — `18-debt-disposition.md` (14 DD rows),
  `19-performance-budget.md` §1 numbers, DD-22 choice. **T5 code lands after G2**;
  foundation beads (token/runtime plumbing, zero visual change) may prep parallel.

## Decomposition

| Bead | Track | Deliverable | Acceptance |
|---|---|---|---|
| b-01 | Foundation: token layer | v3.5 tokens in `console/styles` — gentle ramp both themes, L2 accent, status/mode channels, register namespaces (`--r-console-*`, `--r-journey-*`), `data-theme` plumbing | tokens compile; both themes render; zero visual diff vs current console at baseline |
| b-02 | Global chrome | `NavRail` component (Operate/Create/System + Hosts block), nameplate, theme toggle (sun SVG + label, rightmost), route shell for all operator pages | all pages on rail; active states; collapse ≤1100px |
| b-03 | Fleet | KPI strip, lines table (single-line anatomy, grants, sparkbars, state pills), activity feed, heartbeat rail | mockup-conformant screenshot both themes; virtualization per `19` §3 at >50 rows |
| b-04 | Agents | roster + hatch card, detail: brain swapbar, tool toggles, assigned lines, instances, skills, memory | mockup-conformant; internal detail scroll preserved |
| b-05 | Skills Hub | filters+legend, result cards, compat/harness matrix, source badges, warn-note | mockup-conformant |
| b-06 | Dream Lab | queue + filters strip + recently-decided, review pane (rationale, diff, impact, actions) | mockup-conformant; diff caps 72ch |
| b-07 | Inbox | 3-pane: channel chips, seg control, conversation list, thread (bottom-anchored), composer (uniform 36px), ctx cards | mockup-conformant; takeover state end-to-end |
| b-08 | Deployments | summary strip, deployment cards, hub sync rows, pair card | mockup-conformant; fits 1440×900 |
| b-09 | Settings | section nav + 5 sections per `17-settings-ia-spec.md`, swatch sync, danger zone | nav==sections 1:1; fits 1440×900 |
| b-10 | Journey | splash (hero+proof+watermarks) + hatch 5-step flow + ceremony (one-shot glow) | journey register; ceremony ≤800ms, fades to 0 |
| b-11 | Motion system | lift class, ambient loop (live disc only), reduced-motion=instant, lint bans | `13-ceremony-motion.md` gates pass |
| b-12 | Perf instrumentation | per `19-performance-budget.md` §2: profiler points, WS meters, long-task observer, CI perf lane | lane runs with approved numbers |
| b-13 | G3 conformance gate | screenshot-conformance vs mockups (both themes, 1440×900), AA re-verification per owner gate, full lint | G3 sign-off |

## Rules per bead

1. One bead per agent; bead ID in every message; branch `feat/console-v35-b<NN>-<slug>` off main.
2. Mockups in `docs/design-system/v35/mockups/` are the visual SSOT — conformance is
   screenshot-verified against them, not from memory.
3. Review by a different model family than the implementer; findings fixed before merge.
4. Component vocabulary per spec docs 11–17 (glyph set, avatar anatomy, presence states,
   register radii, motion classes). Vocabulary drift = defect.
5. Perf budget `19` §1 applies from b-03 onward (virtualization rulings §3).

## Sequencing

b-01 → b-02 → (b-03 … b-09 parallel by surface) → b-10/b-11 parallel → b-12 → b-13 (gate).
b-01/b-02 may start pre-G2 (no visual change); surface beads open on G2 sign-off.
