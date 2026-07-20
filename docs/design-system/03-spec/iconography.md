# Iconography — Lucide-only, sized ramp, weight semantics, label law

v3.0.0-draft · G2-locked direction · pending G3

Sources: research-digest (iconography section: Lucide retained, stroke 1.75 continuity), seed-3
(Fluent weight semantics, 12px informational-only), seed-4 (icon+label beats icon-only, one icon
family), v2.html (inline 16-grid sprite as the mockup stand-in).

## 1. Family

**Lucide only** (lucide-react, already shipped). Phosphor and Heroicons rejected; any non-Lucide
icon import is a lint error. Gaps are filled by redrawing to the Lucide grid, not by importing a
second family. The v2 mockup's inline SVG sprite is a file-portability stand-in, not a precedent —
production uses the Lucide set.

## 2. Size ramp and stroke

| Size | Use |
|---|---|
| 16px | inline with label/caption text; toolbar pills; input adornments |
| **18px (default)** | buttons, row actions, nav, general UI |
| 20px | empty states, panel-level emphasis |
| 24px | page-level/hero slots (rare) |

- Stroke **1.75** is the system default (v2-doctrine continuity), tokenized as a single value on
  the icon wrapper; per-icon stroke overrides are banned.
- **12px icons are informational-only** — too small for interaction (seed-3): delivery checkmarks,
  inline status glyphs. Never a click target; anything interactive uses ≥16px inside a ≥24px hit
  area. Sizes below 12px do not exist (the v2 specimen's 10px helper is rejected — tokens-v3 §8).
- Icon boxes are flex-none squares; icons inherit `currentColor`.

## 3. Weight semantics

- **Regular (stroke) = wayfinding**: navigation, actions, structure — the default everywhere.
- **Filled = selected or small states**: an icon may fill only to mark selection/active state, or
  when rendering at small sizes where strokes close up.
- No mixed-weight decorative use; weight is a state signal, not a style choice.

## 4. Icon + label law

Destructive, status-bearing, or irreversible actions always pair icon with a text label (or are
text-only); icon-only is permitted solely for high-frequency, convention-backed actions (close X,
search, expand chevron) and then requires an `aria-label`. Status is never an icon alone — shape +
color + text label travel together (color.md §6).

## 5. Color

Icons are monochrome by default, inheriting the ink of their context (`--text-2` resting,
`--text-1` hover/active). Chromatic icons are restricted to the channel slots: status shapes,
crit empty-state glyph, accent send/selected states — same six-channel discipline as all color.

## 6. Migration notes

The console already uses lucide-react; migration is normative cleanup: enforce the 16/18/20/24
ramp (replace ad-hoc sizes), set the single stroke default, sweep filled/stroke misuse, and add
`aria-label`s to icon-only buttons (control-catalogue findings).

## 7. Enforcement hooks

`lucide-only-imports`, `icon-size-ramp` (no arbitrary width/height on icon components),
`icon-only-needs-aria-label`, `no-interactive-12px-icon`.

Brand assets are exempt from the Lucide-only product-icon rule, but not from visual identity law.
The identity-mark asset set is now shipped (G8): `console/public/favicon.svg` (round "S" monogram,
32×32 `rx=7` accent square, flat), `console/public/icon-maskable.svg` (full-bleed maskable variant),
and the `console/public/manifest.webmanifest` icon entries — the canonical non-Lucide brand glyph.
Favicon, badge, PWA, and maskable assets are governed by `brand.md` §1.3–§1.4 and inventoried by
`design:brand-assets`; changing those files requires both the brand and iconography SSOTs to move
with the asset packet.

Document-shell chrome state (2026-07-19): the C4 straggler packet landed the document
`<title>` as `SOUP Console` (spec: `brand.md` document-shell section; pinned by the
peripheral-brand-regression suite + `design-regression.sh` check 8). The favicon itself
remains the canonical `/favicon.svg`; the approved identity asset set for PWA icons is
tracked as register DD-46 (report-only until it lands).

Document-shell iconography/chrome includes the favicon link and browser `theme-color`. The
`theme-color` value is not a Lucide icon or a separate icon color token; it follows `brand.md` §5 and
the semantic `--surface-base` surface so browser chrome tracks the active theme. With the warm
neutral surface ramp (decision-log #4, `tokens-v3.md` §2.8/§3.1), the pre-paint `theme-color` in
`index.html` tracks the warm `--surface-base`: `#1B1610` (dark) and `#FBF6EC` (light).
