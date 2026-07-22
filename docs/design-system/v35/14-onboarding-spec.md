# 14 — Onboarding Spec (WS4.4)

The hatch journey, end to end. Register: **journey** (radii 8/12/16, spacious) throughout;
no console chrome until the fleet handoff.

## 1. Journey map

```
splash (first-run) → kind → channel → agent → link → hatch (ceremony) → fleet
```

| Step | Name | Anatomy | Exit criteria |
|---|---|---|---|
| 0 | Splash | hero + primary CTA ("Hatch your first agent") | click |
| 1 | Kind | 4 archetype cards (community · chat responder · personal assistant · custom), one pre-selected hint | one selected |
| 2 | Channel | 14-tile grid, one account per line note | one selected |
| 3 | Agent | name (dice reroll) + soul preview + brain pick (claude/opencode/codex, fallback chain shown) | name non-empty, brain selected |
| 4 | Link | channel-specific link flow (§3) | channel reports linked |
| 5 | Hatch | ceremony: lockup + beats (name · soul · channel) + first-message composer → "Send & go live" | sent or skipped |

Step rail on every step: bars + labels, done=hairline+✓, current=accent, upcoming=recessed.
Completed steps' content is **never re-shown below the current step** (wave-4 law — a
completed step's surface may not compete with the current one).

## 2. Step anatomy (shared)

Crumb nameplate (tick + SOUP + step ctx) top-left, theme toggle fixed top-right, shell
`min(860px, 100%)` optically centered. Card: journey radius 16, lift shadow, 32px padding.
Primary action is always the single accent-filled button on the step; secondaries are
ghost/outline (never filled, never accent).

## 3. Link flows per channel class

| Class | Flow | Error/relink path |
|---|---|---|
| QR (WhatsApp, Signal, LinkedIn) | code panel + "scan from the app" + 30s polling | expired → "new code" same panel; link lost → relink banner in fleet + this panel |
| OAuth (X, Reddit, Instagram, Facebook, Slack, Teams) | "Open <channel>" external flow + return screen | denied → plain-text reason + retry; token expired → same entry |
| Credentials (Email, SMS, Discord, iMessage) | app-password / bot-token field + test button | auth fail → field stays, reason under field, "test again" |
| Pair (Telegram) | bot-father token paste | same as credentials |

Every link step exposes: status (linking pulse), the masked identifier once linked
(prefix+suffix law), and "use a different account" escape.

## 4. Empty & degenerate states

| State | Rule |
|---|---|
| No channels linked yet | step 4 shows the link panel; fleet lines table shows the line as `linking` |
| Link interrupted mid-journey | resume card on fleet ("finish hatching <name>") — journey state persists 7 days |
| Hatch with no agents | roster shows the dashed hatch card only; fleet KPI "0 agents" |
| Journey abandoned post-hatch | agent exists as draft (hollow square), line stays unlinked |

## 5. Ceremony (final beat) anatomy

Eggshell frame (dashed rounded square) + avatar pop + radial glow (one-shot, §13) + beats
row (name · soul · channel dots) + name + dice + soul quote + meta line + first-message
composer (input + accent "Send & go live") + ghost "Skip ceremony" + default "Adjust
persona". Composition is centered at 1440×900 with no dangling section below the fold.

## 6. Acceptance gate

- [ ] Every step: single accent primary, ghost secondaries, step rail current.
- [ ] No completed-step content rendered under the current step.
- [ ] Every link class has an error + relink path with masked-id display once linked.
- [ ] Empty/degenerate states per §4 all renderable from mock data.
- [ ] Ceremony fits and centers at 1440×900, both themes.
