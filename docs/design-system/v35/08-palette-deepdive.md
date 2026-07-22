# 08 — Palette & Styling Deep-Dive (measured, origin/main 2026-07-21)

All contrast values computed via WCAG relative-luminance math. Hue/lightness via HSL conversion.

## 1. Contrast matrix (computed)

**Dark theme** (base `#1B1610`):
| Pair | Ratio | Grade |
|---|---|---|
| t1 `#F2EBDC` on base | 15.14 | AAA |
| t2 `#BEB29C` on base | 8.59 | AAA |
| t3 `#897E6B` on base | 4.50 | AA (floor — at the edge) |
| accent `#6BA6FF` on base | 7.29 | AAA |
| accent-fg `#0A0E14` on accent | 7.85 | AAA |
| ok `#5BD97B` / warn `#F5B54A` / crit `#F4736F` on base | 9.97 / 9.92 / 6.44 | AAA / AAA / AA |
| passive `#3BD6B0` / chat `#45C9E8` / agent `#A78BFA` on base | 9.78 / 9.22 / 6.60 | AAA / AAA / AA |

**Light theme** (base `#FBF6EC`, per-theme darker chromatics):
| Pair | Ratio | Grade |
|---|---|---|
| t1 `#221C12` / t2 `#524833` on base | 15.69 / 8.35 | AAA |
| accent `#2563EB` on base | 4.80 | AA |
| accent-fg `#FFFFFF` on accent | 5.17 | AA |
| ok `#15722F` / warn `#855900` / crit `#B42318` on base | 5.60 / 5.69 / 6.10 | AA |
| t3 `#645849` on base | 6.43 | AA |

**Verdict: zero contrast failures anywhere. AA+ across both themes.**

## 2. Harmony analysis

**Neutral family** — hue ≈ 33–43° warm (walnut→cream), saturation ≤ 26%, both themes. The
"warmth from neutrals" law is implemented consistently.

**Accent relationship** — accent hue 217–221° sits near-perfectly complementary to the 40°
neutral family (40+180=220). This is why the blue pops without vibrating: classic
blue-on-warm complementary. **Strongest asset in the palette — do not move it.**

**Dark chromatic register** — all dark-theme chromatics sit in a 60–76% lightness pastel band
(ok 60, warn 63, passive 66, chat 65, crit 70, accent 71, agent 76). Tight, cohesive, soft —
this band IS the "soothing" quality.

**Light chromatic register** — per-theme darker solids (royal blue, forest, burnt amber,
brick) for AA. Different personality from the dark pastels (accepted per-theme literal law).

## 3. Findings

- **F1 — Cool-cluster confusability (real issue).** passive `#3BD6B0` (165°), chat `#45C9E8`
  (190°), accent `#6BA6FF` (217°) span only 52° — three cool neighbors. At small sizes (status
  dots, ticks, badges) they read as one family. The shape law carries separation today, but
  hue separation is weak. Knobs: darken chat to ~60% lightness or shift cyan→200°; deepen
  passive teal toward 150°; add a lightness step (66/60/71 already implicit — make it law).
- **F2 — Per-theme accent personality drift.** Brand mark (favicon `#6BA6FF`) matches the
  DARK accent; light theme runs royal `#2563EB`. On light surfaces the identity accent is
  effectively a different blue. Options: accept (AA law), or lift light accent to a
  mid-point (`#3B76F6`-ish, needs ≥4.5 on `#FBF6EC` — `#3B76F6` = 4.53 ✓) to narrow the gap.
- **F3 — Dark t3 at the AA floor (4.50).** Any darkening of the surface ramp or ink drift
  drops it below AA. If F4 darkens/cools the ramp, t3 must lift to `#8E8371` (≈4.8).
- **F4 — Dark ramp saturation knob.** `#1B1610` is 26% sat — distinctively walnut. A
  "calmer" register pulls 2–3 points of chroma (`#1B1712` ≈ 21%) without losing warmth.
  Taste decision — mock both (T3).
- **F5 — Light-theme surface monotony.** base=raised=overlay (`#FBF6EC` ×3) — only the inset
  (`#ECE3D2`) gives depth. Elevation relies on shadows + hairlines; fine per spec, but the
  soothing register would benefit from a half-step raised tint (`#FDFAF3`) for cards.

## 4. Fine-tuning proposal (knobs, not overhaul)

| # | Knob | Current | Candidate | Rationale |
|---|---|---|---|---|
| T1 | chat cyan | `#45C9E8` (190°/65%) | `#3FB8DC` (196°/60%) | F1 cluster separation (opens teal/cyan gap to 46°, adds lightness step) |
| T2 | light accent | `#2563EB` | `#3B76F6` | F2 narrows dark/light accent gap, holds AA 4.53 |
| T3 | dark t3 | `#897E6B` | `#8E8371` | F3 floor headroom (4.50→4.8) |
| T4 | dark ramp chroma | `#1B1610` (26%) | `#1B1712` (21%) | F4 calmer walnut — mock A/B |
| T5 | light raised tint | `#FBF6EC` | `#FDFAF3` | F5 card depth without new shadow law |
| T6 | overlay shadow (dark) | none | `0 1px 2px rgb(0 0 0/.30), 0 6px 20px rgb(0 0 0/.25)` | L5 — soft elevation, overlays only |
| T7 | per-agent hues | 8-hue avatar palette (34%/45%) | reuse as agent identity hue | L3 — zero new color law |

Keep untouched: warm neutral family, accent hue relationship, status hues, pastel band,
shape law, no-gradient/no-glow law.

## 5. Owner questions (sharp)

- **Q1** Cool-cluster fix T1 (chat cyan → `#3FB8DC`)? [rec: yes]
- **Q2** Light accent lift T2 (`#3B76F6`)? [rec: yes]
- **Q3** Dark ramp chroma: keep distinctive 26% walnut vs calm 21% (T4)? [rec: mock both at T3, decide on screens]
- **Q4** Elevation: adopt T5+T6 (light raised tint + dark overlay shadows)? [rec: yes]
