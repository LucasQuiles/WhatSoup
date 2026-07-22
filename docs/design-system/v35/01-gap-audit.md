# 01 — Gap Audit: v3.5 scope vs current landscape

Severity: **S0** blocks all v3.5 design · **S1** blocks a workstream · **S2** quality gap ·
**S3** carry-over polish.

## G-01 Channel model (S0)

**Current:** runtime config and the Add Line wizard support four transports: Baileys/WhatsApp,
Twilio/SMS, Signal, and iMessage. Baileys alone uses in-console QR authentication; Twilio uses
validated polling configuration and advances automatically; Signal and iMessage use validated
configuration plus out-of-band operator attestation. Admin identity is transport-specific. The
four-way transport picker exists, but there is no 14-channel product registry or full glyph set.
**Gap:** v3.5 needs a channel abstraction the UI can render without knowing the transport:
channel id, display name, glyph, capabilities (link method, features), status semantics.
**Design work:** channel registry model + channel glyphography + per-channel link-flow adapter
pattern (QR / configured polling / external attestation / OAuth). UI/UX only (D2) — reuse the
four real transport seams and mock only channels without a runtime backend.

## G-02 Managed social channels (S1, depends G-01)

**Current:** WhatsApp, SMS, Signal, and iMessage have runtime/config seams; the social and
general-channel registry entries do not.
**Gap:** X, LinkedIn, Reddit, IG, Facebook (+ messaging: Discord and Telegram; channels: email,
Slack, and Teams — ten designed entries, fourteen total) as Lines with channel-specific
affordances (handle identity, OAuth-style link copy, rate-limit/health states). No transport in
scope — but the model must not assume phone-number identity or QR pairing.
**Design work:** 14-row channel capability matrix, social channel cards in Fleet, link-flow copy
per channel, social health states, 14 monochrome glyphs.

## G-03 Agent entity + assignment (S0)

**Current:** agent behavior = per-line config (mode passive/chat/agent, model, plugins). No Agent
object, no name/persona/avatar, no roster, no reassignment.
**Gap:** D4+B1 require Agents as first-class managed objects with identity (name, initials
avatar, assignable profile picture, persona, skills) and a Line↔Agent assignment relation
(profile 1:N lines; Line 0:1 agent; runtime per-chat instances per A4).
**Design work:** Agents surface (roster), Agent detail (persona/config/instances), assignment UX
(from Line and from Agent), agent presence in Fleet rows.

## G-03a Agent Profiles management (S1, new from B1)

**Current:** nothing — config is per-line, no saved profiles.
**Gap:** saved, swappable agent profiles: create from scratch/template, edit, duplicate, assign
to lines, **swap in place** (with per-line diff preview of what changes), retire.
**Design work:** profile editor, template gallery (C6), swap flow with diff confirmation,
profile→lines usage list.

## G-03b Line Access Control (S1, new from B3)

**Current:** no grant model; any configured agent effectively sees its line only, but no UI
concept of shared/permissioned lines.
**Gap:** passive/personal lines support **permission grants** controlling which agents can
see/use them; personal lines need explicit grant UX; grants visible in Fleet.
**Design work:** grant model (agent × line × capability: read/reply/act), grant management UI on
Line detail, Fleet indicator for restricted lines.

## G-04 First-run onboarding + hatching ceremony (S1, depends G-01/G-03)

**Current:** AddLineWizard = 5 utilitarian steps (Identity→Link→ModelAuth→Config→Review) for
adding one line inside an already-set-up console. No first-run journey.
**Gap:** v3.5 needs a designed first-run arc: welcome → workspace/identity → first channel →
agent persona → link device/account → **hatch ceremony** → land in Fleet with the new Line alive.
Plus the ceremony itself (research-hatching.md): staged ritual (identity → brain → channel) with
a one-shot celebratory motion beat, inside the motion law (tension #1).
**Design work:** journey map, Hatch flow spec, ceremony motion budget, empty-console states.

## G-05 Marketing / landing surface (S1 — narrowed by C3)

**Current:** single Landing page (hero + 3 value props + CTA), faithful to v3 brand but thin.
**Gap (per C3):** basic splash/explainer only — multi-channel story, what SOUP is, entry into
"Get started". **No pricing, no feature pages yet.** Warmth budget lives here (tension #3);
Bricolage display headlines sanctioned (D4).
**Design work:** single-page design, section rhythm, display-type usage, footer.

## G-06 Real-time performance budget (S2 — promoted: E1/E2/E3/E4 "address now")

**Current:** WS push + polling fallback works; no budgets, no measurements. recharts re-renders
unthrottled; feed/table unvirtualized except messages; LogStream bounded (DD-22).
**Gap:** "performant real-time dashboarding" needs measurable targets at the owner-set scale
(**200 lines**): Fleet first paint, update frame cost, chart update throttle, list
virtualization coverage, WS message rate caps, memory over 24h soak. Instrumentation lands
**now** (E2), LogStream live-tail decision **now** (E3), Ops/Metrics merge **now** (E4).
**Design work:** budget doc + instrumentation plan + per-surface conformance, starting T1.

## G-07 Settings / configuration IA (S2)

**Current:** per-line config is deep (9 tabs); no fleet-level or account-level settings surface;
theme toggle in nav; no notification/integration/API-token settings.
**Gap:** multi-channel product needs Settings IA: Workspace (name, theme, defaults), Channels &
linkage, Agents defaults, Notifications, API/tokens, Danger zone.
**Design work:** Settings surface spec + nav placement.

## G-08 v3 open-debt dispositions (S3)

| ID | Title | Blocks v3 acceptance | v3.5 disposition |
|---|---|---|---|
| DD-8 | ghost-tier text audit | YES | **Carry** — fold into v3.5 per-screen passes |
| DD-18r | nav width + non-Fleet side-panel law | YES | **Carry** — v3.5 nav/settings redesign absorbs |
| DD-35 | accent residue in legacy wordmark | YES | **Superseded** — v3.5 brand refresh owns the wordmark |
| DD-5 | theme toggle ghost button | no | Carry (nav redesign) |
| DD-9 | half-step spacing aliases | no | Carry (mechanical) |
| DD-22 | LogStream live-tail | no | **Decision** — fold into WS6 (real-time budget) |
| DD-23 | Popover collision flip | no | Carry |
| DD-24 | contact-pane actions at narrow | no | Carry (Inbox redesign) |
| DD-26/37 | type ramp closeout + 12px floor | no | **Carry** — v3.5 type work (G-05 marketing scale) absorbs |
| DD-28 | stale-data state spec | no | **Carry** — required by G-06 (staleness affordances) |
| DD-34 | UpdateModal QA frame | no | Close cheaply (one frame) |
| DD-36 | icon size ramp enforcement | no | Carry — extends to channel glyphography |
| DD-38 | 11 raw Card consumers | no | Carry (mechanical migration) |
| DD-39 | color-mix fallbacks | no | Decision — min-engine ruling during spec phase |

## G-09 Brand vocabulary evolution (S2)

**Current:** locked terms (Line, Fleet, Inbox, Ops, attention); channel-agnostic copy law.
**Gap:** v3.5 adds Channel, Agent, Hatch, Assignment, Workspace. "Hatch" as a user-facing verb
needs a voice ruling (playful budget: nameplate only, or does onboarding get celebratory copy?).
**Design work:** WS2 vocabulary table amendment + microcopy rules for ceremony vs operations.

## Summary

- **2 S0 blockers:** channel model (G-01), agent entity (G-03) → WS2 product model is the
  critical path; everything visual depends on it.
- **3 S1:** social channels (G-02), onboarding+hatch (G-04), marketing (G-05) → T3 directions.
- **2 S2:** performance budget (G-06), settings IA (G-07).
- **1 S3 bundle:** v3 debt dispositions (G-08) — nothing here blocks v3.5 design.
