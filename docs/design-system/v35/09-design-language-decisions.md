# 09 — Design Language Decisions (Round 4, locked 2026-07-21)

Owner answers to L1–L11 (interview in `07-design-language-audit.md`) with computed token
candidates. Contrast values verified via WCAG luminance math.

## L1 — Warm ramp: KEEP, gentler (Gentle Warm ramp v1)

Dark "walnut" softens: hue 35°, chroma 26%→17%, lightness +1.5 steps — gentler viewing, warmth
kept. Light "bone" keeps its register with a slightly calmer tint.

| Token | Was (26% walnut) | Gentle ramp (17%) | Contrast (t-ink on base) |
|---|---|---|---|
| surface-base | `#1B1610` | **`#1E1A15`** | — |
| surface-raised | `#231D15` | **`#27221C`** | — |
| surface-overlay | `#2E261B` | **`#322D24`** | — |
| surface-inset | `#14110C` | **`#171410`** | — |
| text-1 | `#F2EBDC` | **`#F1ECDF`** | 14.67 AAA |
| text-2 | `#BEB29C` | **`#CAC1AF`** | 9.69 AAA |
| text-3 | `#897E6B` (AA floor 4.50) | **`#9A907E`** | 5.49 AA — F3 fixed, headroom gained |
| light base | `#FBF6EC` | **`#FAF6EE`** | — |
| light inset | `#ECE3D2` | **`#EDE5D5`** | — |

## L2 — Accent: KEEP, thematically aligned (refined 2026-07-21)

Accent hue family stays 217–221° (complementary to the 35–42° neutral family — the working
relationship). Dark accent unchanged **`#6BA6FF`** (7.02 AAA on the gentle base; brand mark
unchanged). Light accent **lifts `#2563EB` → `#2E66E4`** (4.71 AA on `#FAF6EE`) to narrow the
dark/light drift per owner approval — with a correction: the earlier `#3B76F6` candidate
fails AA (3.81), so the accessible substitute carrying the same intent is `#2E66E4`.

## Accessibility gate (owner directive, all palette changes)

Every chromatic token ships with per-theme measured WCAG values in the spec; AA (4.5:1)
minimum for information-carrying color, both themes, no exceptions. Values below are
pre-verified; spec-time re-verification is a blocking check.

## F1 resolution — chat cyan shift (owner-approved, verified)

- Dark: **`#3FB8DC`** — 7.50 AAA on `#1E1A15` (was `#45C9E8`; opens teal/cyan/accent
  separation and adds a lightness step 66/60/71).
- Light: **`#1F6E85`** — 5.37 AA on `#FAF6EE` (per-theme darker literal, same hue family).

## L3 — Agent identity hues: YES, harmonized set

Harmonized 8-hue set, thematically aligned with the gentler ramp: **sat 38%, light 34%**,
hues spaced ≥30° outside the mode/status cool band (150–230° reserved):

`0° · 30° · 60° · 100° · 140° · 250° · 285° · 325°` at `hsl(H, 38%, 34%)`, white ink —
spec-time gate: every hue ≥ 4.5:1 vs ink, both themes (34% passes per DD-44 precedent;
60/100/140° need the 34% depth, not 38%).

## L4 — Two shape registers: YES + broad enforcement

Console register: radii 4/6/8, dense spacing (unchanged). Journey register (hatch/splash/
Dream Lab ceremony surfaces): radii 8/12/16, spacious spacing. **Enforcement:** per-register
token namespaces (`--r-console-*`, `--r-journey-*`), lint banning cross-register consumption,
container-query layout rules to prevent layout shift, design-regression checks extended.

## L5 — Dreamy lift (motion/shadow system): YES

New sanctioned interaction class **"lift"**: hover raises cards/overlays with shadow growth +
translate, plus overlay entrance glide. Subtle 3D through layered shadow law.

- Lift: `translateY(-2px)` + shadow `0 1px 2px rgb(0 0 0/.30) → 0 8px 24px rgb(0 0 0/.28)`,
  160–200ms ease-out; shadow grows, never appears instantly.
- Overlay entrance: 8px rise + fade, 220ms, standard ease `[0.22,1,0.36,1]`.
- Reduced-motion: all lift/glide removed (instant, static) — law unchanged.
- One ambient loop budget unchanged; lift is interaction-driven, not ambient.

## L6 — Channel glyphs: filled silhouettes + state variants

14 filled monochrome silhouettes, each with a **state system**: connected (full ink) ·
available (full ink + ok shape-tag) · linking (motion pulse, within law) · disconnected
(outline, 40% ink) · unavailable/deactivated (outline + slash) · error (crit shape-tag).
Shape-tags reuse the status shape law (disc/diamond/square/outline) — no hue coding (D1).

## L7 — Abstract glyph-geometry imagery: EVALUATE

Fit-check in T3 directions before adopting; console stays no-illustration regardless.

## L8 — Type triad: KEEP

Bricolage Grotesque display / Hanken Grotesk body / IBM Plex Mono data — unchanged.

## L9 — Splash hero: dark-warm, system-aligned

Gentle-warm dark hero; light alternate aligned.

## L10 — Hatch moment: CEREMONIOUS GLOW (sanctioned exception)

Owner-sanctioned exception to the no-glow law: a **one-time radial accent glow** behind the
identity lockup at the hatch moment — ≤800ms, single play, reduced-motion → instant cut to
final state. Scoped: ceremony surface only; banned everywhere else (lint-enforced).

## L11 — Reference anchors: none given

Design freedom under the standing creative bar + owner approval at gates.
