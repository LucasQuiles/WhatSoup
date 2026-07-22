# 13 — Ceremony Motion Budget (WS4.3) — motion.md amendment

Locked per L5 + L10. Motion is a **budget**, not a palette: one ambient loop, one ceremony
one-shot, interaction-driven lift. Everything else is still.

## 1. The three motion classes (complete set)

| Class | Where | Definition | Budget |
|---|---|---|---|
| **Ambient** | live status disc only | opacity 1→.35→1, 2400ms ease-in-out, infinite | exactly one loop product-wide |
| **Lift** (interaction) | cards, overlays, buttons | hover: `translateY(-2px)` + shadow rest→lift, 160–200ms ease-out; overlay entrance: 8px rise + fade, 220ms | shadow grows, never appears instantly |
| **Ceremony** (one-shot) | hatch moment only | radial accent glow (35% → 0, ≤800ms, single play) + avatar pop (scale .4→1, 500ms spring, 250ms delay) | ≤800ms, once, then still |

Standard ease everywhere: `[0.22, 1, 0.36, 1]`.

## 2. Ceremony rules (L10 verbatim, enforced)

1. The glow is **radial**, accent-hued, and **one-time** — it plays at the identity-lockup
   beat and **fades to 0**. It never persists, never loops, never appears elsewhere.
2. Scope: the hatch ceremony surface only. Banned on every other surface (lint-enforced).
3. No other glow, gradient, or bloom anywhere in the system (the no-gradients law stands
   with this single exception).

## 3. Reduced-motion law (unchanged)

`prefers-reduced-motion: reduce` → all three classes become **instant**: the loop is
removed (not shortened), lift/glide become static, the ceremony cuts directly to the final
state (no glow play, no pop). This is removal, not speed-up.

## 4. Explicitly banned

- crit-blink / alarm loops of any kind
- skeleton shimmer, progress-bar loops, spinner loops
- parallax, scroll-linked motion
- hue transitions on state change (state changes cut or fade ≤160ms)
- any fourth motion class without a motion.md amendment + owner sign-off

## 5. Acceptance gate

- [ ] One ambient loop in the product, on the live disc only.
- [ ] Ceremony glow: radial, ≤800ms, single play, ends at 0, hatch-only.
- [ ] Reduced-motion: all motion removed to instant/static.
- [ ] No gradients/glow outside §2 (lint).
