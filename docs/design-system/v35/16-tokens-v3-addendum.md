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
and `11-channel-glyphography.md` §1: `--fleet-pagerow-gap`, `--fleet-pagerow-pad`,
`--fleet-pad-x`, `--fleet-kpi-pad`,
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

Shared primitives consumed by design (cross-review ruling, b-03): the fleet
stylesheet reads four tokens housed under the b-02 `--chrome-*` prefix that are
cross-surface *laws*, not chrome layout — `--chrome-micro-radius` 1px +
`--chrome-pill-radius` 99px (badge.md shape family), `--chrome-icon` 16px
(11-channel-glyphography §1 glyph floor), `--tracking-chrome-title` −0.02em (the
product h1 voice, Bricolage, identical in every mockup). Fleet *layout* never
reads chrome tokens: the surface h1 row takes its own `--fleet-pagerow-*`
(mockup `header` literals — same values by SSOT, independently owned) so a chrome
header change cannot shift the fleet surface.
## 5. Agents surface geometry (`--agents-*`, T5 b-04)

Component-register geometry for the Agents surface, all traced to
`mockups/agents.html` and `12-agent-identity.md` §§1–4: roster column and card
geometry, avatar size slots (md/xl + radii — fills consume `--agent-hue-0..7`
per §2, never inline palettes), presence shape size (§4 aliases), detail pane +
panel grid, swapbar, tool toggle, grant chip, instance/memory/search geometry,
and caps tracking tokens. The stacking breakpoint is the mockup's own 1000px —
NOT the chrome/fleet 1100px (SSOT difference, browser-pinned). Spec SSOT:
`tokens-v3.md` §13. Same pattern as b-02/b-03: raw mockup dimensions land in
the token block once; `agents.css` consumes `var()` only. Shared *laws*
(`--chrome-micro-radius`, `--chrome-pill-radius`, `--tracking-chrome-title`)
are consumed by design; agents layout never reads chrome tokens. Half-step
tokens (`--sp-*h`, DD-9 retirement queue) are not consumed.
## 5. Skills Hub surface geometry (`--skills-*`, T5 b-05)

Component-register geometry for the Skills Hub surface, all traced to
`mockups/skills-hub.html`: page-row rhythm, hub mode toggle, filters rail
(196px — hides at the mockup's own 900px breakpoint, the third distinct SSOT
breakpoint after chrome/fleet 1100px and agents 1000px), results column +
toolbar, result cards (icon box, source badge, actions), compat strip + cells
(partial = rotated diamond per the shape law), and the third-party warn-note.
Spec SSOT: `tokens-v3.md` §14. Same pattern as b-02…b-04: raw mockup
dimensions land in the token block once; `skills.css` consumes `var()` only.
Half-step tokens (`--sp-*h`, DD-9 retirement queue) are not consumed.
## 5. Dream Lab surface geometry (`--dream-*`, T5 b-06)

Component-register geometry for the Dream Lab surface, all traced to
`mockups/dream-lab.html` and `12-agent-identity.md` §2: page-row rhythm +
queued pill, queue rail (340px) with dream cards, filters strip, history rows,
avatar slots (sm 26px / lg 44px — fills consume `--agent-hue-*` per §2, the ✦
rationale accent is `--agent-dream`), review pane (rhead, rationale capped
68ch, **diff capped 72ch — the bead acceptance item**, impact columns,
decision actions). The stacking breakpoint is the mockup's own 980px — the
fourth distinct SSOT breakpoint (chrome/fleet 1100px, agents 1000px, dream
980px, skills 900px). Spec SSOT: `tokens-v3.md` §15. Same pattern as
b-02…b-05: raw mockup dimensions land in the token block once; `dream.css`
consumes `var()` only. Half-step tokens (`--sp-*h`, DD-9 retirement queue) are
not consumed.
## 5. Inbox surface geometry (`--inbox-*`, T5 b-07)

Component-register geometry for the Inbox surface, all traced to `mockups/inbox.html`:
channel chips row, seg control, conversation list (300px, avatar anatomy with the
12px channel-glyph badge, unread + takeover badges), thread (bottom-anchored message
lane, 78% row cap, takeover toggle 32×18px with 14px knob/travel), **composer with
the uniform 36px control height — the bead acceptance item** (caps, input, and Send
all consume `--inbox-composer-h`), and the context pane (person/agent/line cards,
identity rows). Breakpoints are the mockup's own: context pane hides ≤1100px,
list hides ≤760px — the fifth distinct SSOT stacking breakpoint (chrome/fleet
1100px, agents 1000px, dream 980px, skills 900px, inbox 760px). Spec SSOT:
`tokens-v3.md` §12. Same pattern as b-02…b-06: raw mockup dimensions land in the
token block once; `inbox.css` consumes `var()` only. The v3 pane widths
(`--inbox-pane-chats`/`--inbox-pane-contact`) are retired with the v3 page.

## 6. Acceptance gate

- [ ] No `channel-*` token carries a hue (computed check).
- [ ] `agent-hue-*` used only on avatar fills + nowhere else (consumer audit).
- [ ] Every presence render resolves through §3 aliases (no raw status hex on presence).
- [ ] Register namespaces consumed per-surface with zero cross-register hits (lint).
