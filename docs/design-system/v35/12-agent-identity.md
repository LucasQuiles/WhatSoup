# 12 — Agent Identity Layer (WS4.2)

Locked per L3: harmonized 8-hue avatar set + initials — **never mascots**. One identity
vocabulary everywhere an agent appears.

## 1. Avatar anatomy

| Property | Rule |
|---|---|
| Content | 1–2 initials, white, 700 weight, Hanken |
| Fill | `hsl(H, 38%, 34%)`, H ∈ {0°, 30°, 60°, 100°, 140°, 250°, 285°, 325°} — sat/light locked (L3) |
| Ink | `#FFF` fixed — every hue ≥ 4.5:1 vs ink both themes (34% depth is the gate; 60/100/140° require it) |
| Hue assignment | at hatch, from the set in order; hue follows the agent forever (identity, not state) |
| Radius | console register 6–9px by slot; journey register 11–16px (see §2) |
| State marker | separate element (`.stat` 8px shape), never baked into the avatar fill |

## 2. Size slots (contextual scale law)

| Slot | Size | Radius | Where |
|---|---|---|---|
| xs | 18–22px | 5–6px | table cells, chip-adjacent, instance rows |
| sm | 24–26px | 7px | message bubbles, queue cards, inbox rows |
| md | 32–34px | 8–9px | roster cards, conversation list, thread header |
| lg | 44px | 11px | dream-lab review header |
| xl | 56px | 14px | agent detail header |
| ceremony | 72px | 16px | hatch lockup (inside eggshell frame) |

Radii follow the surface register: console surfaces use the console ramp, journey surfaces
the journey ramp (L4). Same agent, same hue+initials, scale varies with context — this is
the identity-consistency rule (wave-4 G6 precedent).

## 3. Persona card (agent identity block)

Anatomy, in order: avatar (xl) → name (display 800) + live/status pill → soul line
(one italic sentence, t2) → meta line (mono t3: hatched date · archetype · sandbox scope)
→ action cluster (Edit profile sm · swap profile ghost · Retire danger).

- Status is a pill (ok wash + disc), never bare text (wave-3/4 law).
- Archetypes (WS2.6, locked): community agent · chat responder · personal assistant · custom.
- Identity metadata is always mono/t3, one line, demoted below the soul line.

## 4. Presence states

| State | Shape | Color | Rule |
|---|---|---|---|
| live | disc | ok | may breathe (one ambient loop budget) |
| paused | diamond | warn | static |
| draft | outline square | t2 border, transparent fill | hollow by design, ≥1.5px stroke |
| deactivated | outline + slash | t3 | recessed (dim glyph class) |

Presence color comes from the status channel only — never from the avatar hue.

## 5. Acceptance gate

- [ ] Every agent render uses hue+initials from §1 — no mascots, no photos, no per-instance hue drift.
- [ ] Size slot matches §2 per context; radius matches surface register.
- [ ] Presence renders via §4 shape+status-channel, never color-only, never avatar-fill.
- [ ] All 8 hues pass ≥4.5:1 vs white ink in both themes (spec-time re-verification, AA gate).
