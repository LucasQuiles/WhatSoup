# 14 — Onboarding Spec (WS4.4)

The hatch journey, end to end. Register: **journey** (radii 8/12/16, spacious) throughout;
no console chrome until the fleet handoff.

This file specifies the target Hatch journey. The shipped Add Line flow remains
Identity → Link → Model → Config → Review; it has no Splash, Kind, Agent, or Hatch step.

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
| 4 | Link | channel-specific link flow (§3) | carrier-specific completion: Baileys connected event, valid Twilio config, Signal/iMessage operator attestation, or a future channel contract |
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

The first three rows bind shipped Add Line behavior. The remaining rows are safe target
contracts for channels without runtime backends.

| Class | Flow | Error/relink path |
|---|---|---|
| QR (WhatsApp) | code panel + "scan from WhatsApp" + live auth events | QR refreshes automatically; shipped relink actions live in Line Detail and Operator, not in a Fleet banner |
| Configured polling (Twilio/SMS) | account SID + canonical keyring service reference + exactly one phone number or Messaging Service SID; auto-advance after validation | invalid config stays on the form with field-level correction; provider secret is configured out of band |
| External attestation (Signal, iMessage) | Signal runbook + registered-daemon checkbox; iMessage runbook + backend-reachable checkbox | manual operator attestation only: Add Line does not probe either provider or detect a failed setup, and neither transport opens the QR event stream |
| OAuth (X, Reddit, Instagram, Facebook, Slack, Teams) | "Open <channel>" external flow + return screen | denied → plain-text reason + retry; token expired → same entry |
| Credential-backed futures (Email, Discord, Telegram) | collect only non-secret identifiers and keyring service references; never render an app-password/bot-token input | auth fail → retain the non-secret config, show the reason, and link to out-of-band keyring setup |

The target shared adapter exposes status, a masked identifier once linked (prefix+suffix law),
and a "use a different account" escape. The shipped behavior is narrower: only Baileys reports
connected via the auth event stream; Twilio advances after validated configuration; Signal and
iMessage acknowledge operator self-attestation. Those common masked-id and account-switching
controls have not shipped.

Only Baileys has an observable in-console authentication/relink lifecycle. The current
non-Baileys Relink modal reruns the acknowledgement UI and refreshes line data; it does not
reconfigure or probe Twilio, Signal, or iMessage and must not be described as verified relinking.

Raw **transport** provider secrets are never collected, serialized, or echoed by Add Line; it
stores only canonical keyring service references. The separate Model step may accept supported
model-provider API keys transiently for the credential API, but those values are not serialized
into line config.

## 4. Empty & degenerate states

These are target Hatch states, not claims about the current Add Line implementation. Today,
Baileys creates the line before Link and retains it unlinked if the journey is abandoned;
Twilio, Signal, and iMessage create exactly once from Review. There is no persisted seven-day
journey/resume card, draft Agent entity, or universal Fleet `linking` state yet.

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
