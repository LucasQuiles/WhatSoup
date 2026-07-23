# 15 — Marketing Spec (WS4.5)

Scope: **basic splash/explainer page only — no pricing, no feature pages yet** (C3, locked).
The splash is the product's public face and the first-run entry.

## 1. Page map (complete)

| Section | Content | Register |
|---|---|---|
| Chrome | theme toggle, fixed top-right (operator spec) | journey |
| Hero | nameplate (tick + SOUP, accent U) → 44px display headline with one accent word → 16px sub at 46ch → CTA row | journey |
| Proof | 3 feature cards (01 Hatch · 02 Command · 03 Trust) | journey |
| Imagery | 2 abstract glyph-geometry watermarks, 4–5% opacity, oversized, rotated, diagonal-balanced | L7 |

That's the whole page. No nav, no footer links, no pricing, no screenshots of the console.

## 2. Display type scale (marketing only)

| Slot | Spec |
|---|---|
| Hero headline | Bricolage 800, 44/50, −0.035em; one accent word (Landing precedent + D4) |
| Hero sub | Hanken 400, 16/1.6, t2, max 46ch |
| Card title | Bricolage 700, 15/20 |
| Card body | Hanken 400, 12.5/1.6, t2 |
| Card index | Plex Mono 600, 11/14, t3, uppercase |

Console type law (≤20px page titles, dense ramps) does not apply here; the marketing scale
stays out of the console (register separation, L4).

## 3. Warmth budget vs console restraint

| Element | Console | Marketing |
|---|---|---|
| Hero display size | 20px max | 44px allowed |
| Vertical rhythm | dense, 4px grid | spacious, 16/34/56px steps |
| Accent usage | actions/focus/selection only | + one headline accent word + primary CTA |
| Imagery | none (no-illustration law) | abstract glyph-geometry only (L7) |
| Radii | 4/6/8 | 8/12/16 |
| CTAs | btn spec | enlarged primary (15px, 14/28), hairline ghost secondary |

Everything not listed inherits console law (single accent, no gradients/glow, status
shapes, mask law, dual first-class themes).

## 4. CTA law

Primary: "Hatch your first agent →" (accent fill, enlarged). Secondary: "Open the Fleet"
(hairline ghost, t2, one step below the primary in every dimension). Exactly two CTAs —
a third CTA is a defect.

## 5. Composition

Hero + proof as one centered stack (flex-center both axes at 1440×900, measured gutters
symmetric). Watermarks fixed top-left (340px) + bottom-right (260px) as diagonal balance —
asymmetric by design; they are flat geometry, not gradients, not scenes, not mascots.

## 6. Acceptance gate

- [ ] Page contents limited to §1 sections — anything more is a defect.
- [ ] Display scale per §2; console scale absent from the page.
- [ ] Exactly two CTAs, hierarchy per §4.
- [ ] Watermarks: flat, ≤5% opacity, glyph-geometry only.
- [ ] Stack optically centered at 1440×900 (measured), both themes.
