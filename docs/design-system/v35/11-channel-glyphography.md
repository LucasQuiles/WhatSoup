# 11 — Channel Glyphography (WS4.1)

Locked per L6: **filled monochrome silhouettes with a state system** — no hue coding (D1),
16px legibility floor, zero collision with the status shape law (disc/diamond/square/outline).

## 1. Anatomy

| Property | Rule |
|---|---|
| Canvas | 16×16 viewBox; optical size normalized per glyph (see §4) |
| Fill | `currentColor` — inherits context ink; never a brand hue |
| Form | single filled silhouette, no strokes, no interior detail at 16px beyond one counter-shape |
| Container | `.chan` 22px box, glyph 16px, flex-centered; state tag absolute at −3,−3 |
| States | connected (full ink) · available (full ink + ok tag) · linking (motion pulse, law-bounded) · disconnected (outline, 40% ink) · deactivated (outline + slash) · error (crit tag) |

State tags reuse the status shapes: ok=disc, warn=diamond, crit=square, off=outline. Tags are
8px with a 2px surface-colored keyline so they read over any glyph.

## 2. The 14-channel set (A3, locked)

| # | Channel | Glyph (silhouette) | Optical note |
|---|---|---|---|
| 1 | WhatsApp | handset inside chat bubble | rounded, full |
| 2 | Signal | bell | full dome |
| 3 | iMessage | rounded chat bubble | full |
| 4 | SMS | three text lines | stroke-free bars, full |
| 5 | Discord | controller + two eye counters | full |
| 6 | Telegram | paper plane | **scaled +12%** — plane is inherently smaller in-box |
| 7 | X | X mark | **scaled −12%** — full-bleed mark reads larger |
| 8 | LinkedIn | "in" letterform | full |
| 9 | Reddit | snoo head + antenna | full, two eye counters |
| 10 | Instagram | rounded-square camera | full, two counters |
| 11 | Facebook | f letterform | full |
| 12 | Email | envelope + flap | full, flap as counter |
| 13 | Slack | four-quadrant knot | full |
| 14 | Teams | pane grid | full |

Glyphs with built-in internal gaps (Telegram plane, X mark, Teams grid) carry the optical
correction listed; all others render at the native 16px. Corrections are implemented as
`transform` wrappers so the path data stays canonical.

## 3. Collision audit (vs status shapes)

| Shape family | Verdict |
|---|---|
| Status disc/diamond/square/outline | no channel glyph is a plain geometric primitive — all are compound silhouettes. PASS |
| Mode markers (teal/cyan/violet squares/diamonds) | glyphs are hue-free; mode colors appear only on mode chips, never on glyphs. PASS |
| Agent identity hues (8-set) | avatars carry hue, glyphs never do. PASS |

## 4. Usage law

1. Channel glyphs appear wherever a line/channel is referenced: fleet table, roster cards,
   assigned lines, inbox filter chips + avatars, hatch channel grid, deployments mini chips,
   settings notification channels.
2. Avatar channel badges (inbox) use the 12px corner-badge form (absolute, −3,−3, keyed with
   surface fill) — same glyph, smaller render, no state tag.
3. `dim` variant (deactivated lines): 45% ink dark / 60% ink light — recessed, never invisible.
4. New channels enter the set only through this spec: silhouette proposed at 16px, optical
   check against the full set, collision audit vs §3, then locked.

## 5. Acceptance gate

- [ ] All 14 glyphs render correctly filled (no stroke-only paths — wave-4 regression class).
- [ ] State tags present and shape-coded on every live glyph instance.
- [ ] No hue on any glyph in any theme (computed `fill` ∈ {currentColor, ink tokens}).
- [ ] Optical normalization verified by side-by-side 16px render review (wave-4b class).
