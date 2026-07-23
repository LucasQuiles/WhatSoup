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
