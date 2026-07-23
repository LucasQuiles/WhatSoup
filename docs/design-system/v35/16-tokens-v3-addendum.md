# 16 — Token Deltas: tokens-v3 addendum (WS4.6)

New semantic slots introduced by v3.5. Base tokens (L1 gentle ramp, L2 accent, status,
mode channels) are unchanged — this addendum **adds**, never redefines.

## 1. Channel slots (`channel-*`)

Channels have **no hues**. Channel tokens are structural only:

| Token | Dark | Light | Use |
|---|---|---|---|
| `channel-glyph-ink` | `var(--t2)` | `var(--t2)` | default glyph fill |
| `channel-glyph-dim` | 45% of glyph-ink | 60% of glyph-ink | deactivated glyph |
| `channel-tag-bg` | `var(--ok)` | `var(--ok)` | available state tag |
| `channel-tag-keyline` | `var(--raised)` | `var(--raised)` | 2px tag keyline |

Rationale: the single-accent law and the 6-channel color budget (3 mode + 3 status) leave
no hues for channel identity — channels identify by **shape** (glyph), not color (D1).

## 2. Agent slots (`agent-*`)

| Token | Value | Use |
|---|---|---|
| `agent-hue-0..7` | `hsl(H, 38%, 34%)`, H ∈ {0,30,60,100,140,250,285,325} | avatar fills (L3 set) |
| `agent-avatar-ink` | `#FFFFFF` | initials |
| `agent-dream` | `var(--m-agent)` | dream indicator chips/labels (agent-mode channel) |
| `agent-ring-sel` | `var(--accent)` | selected agent card ring |

Avatar hues are **identity**, not state: they never change with presence, never appear on
non-avatar elements (except `agent-dream`, which is the agent-mode channel, not identity).

## 3. Presence aliases (semantic, resolve to status tokens)

| Alias | Resolves to | Use |
|---|---|---|
| `presence-live` | `var(--ok)` + disc | live state |
| `presence-paused` | `var(--warn)` + diamond | paused state |
| `presence-draft` | `var(--t2)` border + transparent | draft (hollow) |
| `presence-deactivated` | `var(--t3)` + outline+slash | deactivated (recessed) |

## 4. Register namespaces (L4 enforcement)

| Namespace | Values | Scope |
|---|---|---|
| `--r-console-{sm,md,lg}` | 4 / 6 / 8px | all operator surfaces |
| `--r-journey-{sm,md,lg}` | 8 / 12 / 16px | hatch, splash, ceremony surfaces |

Rule: a surface consumes exactly one namespace; cross-register consumption is a lint
error (L4 broad enforcement).

## 5. Fleet surface geometry (`--fleet-*`, T5 b-03)

Component-register geometry for the Fleet surface, all traced to `mockups/fleet.html`
and `11-channel-glyphography.md` §1: `--fleet-pad-x`, `--fleet-kpi-pad`,
`--fleet-panelhead-pad`, `--fleet-activity-w`, `--fleet-row-pad`, `--fleet-head-pad`,
`--fleet-ev-pad`, `--fleet-chan-box`, `--fleet-avatar-box`, `--fleet-grant-box`,
`--fleet-spark-h`, `--fleet-spark-w`, `--fleet-chan-tag-keyline`, `--tracking-kpi`,
`--tracking-fleet-head`, `--tracking-badge`, plus the micro-geometry the mockup
specifies off the 4px grid: `--fleet-kpi-lift`, `--fleet-kpi-d-mt`,
`--fleet-panelhead-gap`, `--fleet-chan-tag-offset`, `--fleet-mode-gap`,
`--fleet-mode-dot`, `--fleet-badge-gap`, `--fleet-badge-pad`, `--fleet-grant-gap`,
`--fleet-spark-gap`, `--fleet-rowbtn-pad`, `--fleet-hb-gap`, `--fleet-hb-bar-gap`,
`--fleet-lcell-maxw`, and three documented-deviation tokens (no mockup row —
carried features): `--fleet-current-edge`, `--fleet-select-inset`,
`--fleet-filterpop-pad`. Same pattern as the b-02 `--chrome-*` block: raw mockup
dimensions land here once; `fleet.css` consumes `var()` only. Half-step tokens
(`--sp-*h`, DD-9 retirement queue) are not consumed by the Fleet surface.

## 6. Acceptance gate

- [ ] No `channel-*` token carries a hue (computed check).
- [ ] `agent-hue-*` used only on avatar fills + nowhere else (consumer audit).
- [ ] Every presence render resolves through §3 aliases (no raw status hex on presence).
- [ ] Register namespaces consumed per-surface with zero cross-register hits (lint).
