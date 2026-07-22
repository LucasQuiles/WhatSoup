# 02 — Mapping: current → v3.5

## 1. Concept map (product model — WS2 output)

| Concept | v3 (today) | v3.5 (target) | Notes |
|---|---|---|---|
| **Channel** | four transport choices: WhatsApp, SMS, Signal, iMessage | first-class registry entry: id, name, glyph, link method, capabilities, health semantics | **14 in 3 classes** (A3): messaging wa·signal·imessage·sms·discord·telegram, socials x·linkedin·reddit·instagram·facebook, channels email·slack·teams; four runtime-backed, ten mocked per D2 |
| **Line** | one selected WhatsApp/SMS/Signal/iMessage connection with config | a **channel account** under management: channel + identity (phone/handle/email) + linkage state + assigned agent + access grants | single user-facing noun kept; inactive = "deactivated" (D3) |
| **Agent** | per-line config blob (mode/model/plugins) | first-class object: name, initials avatar, assignable profile picture, persona/soul, model/brain, skills, status; assignable to Lines | B1/B2; roster + detail + assignment UX |
| **Agent Profile** | n/a | saved, swappable agent configuration: persona + brain + skills + defaults; create/edit/duplicate/assign/**swap** | B1 — swap flow w/ per-line diff preview |
| **Agent Instance** | sessionScope per_chat (runtime only) | designed surface: per-chat agent instances visible under Agent detail (active chats, presence) | A4 — inherits current per-chat session structure |
| **Assignment** | n/a (config lives on line) | relation Line↔Agent with history; unassigned = passive-only | 1 Agent : N Lines; Line 0:1 Agent |
| **Grant** | n/a | permission relation: agent × line × capability (see/reply/act); controls agent access to passive/personal lines | B3 — Line Access Control |
| **Fleet** | lines table + charts + feed | multi-channel fleet: channel glyphs, agent presence, restricted-line indicators, attention metric kept | scan-path preserved; 200-line design target (E1) |
| **Hatch** | n/a | the creation+link+activate journey; ceremony beat at activation (3 beats: name → soul line → channel) | journey-side vocabulary; ops stays dry (A5) |
| **Workspace** | implicit single tenant | named workspace (settings root) | B5; enables settings IA |
| **Linkage** | WhatsApp QR; Twilio configured auto-advance; Signal/iMessage out-of-band attestation | per-channel linkage flows (QR, configured polling, external attestation, OAuth) with shared state machine (deactivated→linking→linked→degraded→relink) | one taxonomy, many carriers; QR remains WhatsApp-only |
| **Inbox** | per-line threads with transport-aware selection, badges, and message formatting | unified cross-channel inbox w/ channel filter | channel chip per thread (B4) |
| **Attention** | lines-not-online metric | kept; per-channel degradation semantics | spec already unified |

## 2. Surface map

| Current surface | v3.5 surface | Change class |
|---|---|---|
| `/` Fleet (SoupKitchen) | `/` **Fleet** — multi-channel grid/table w/ channel glyphs, agent presence, grant indicators | evolve |
| `/lines/:name` LineDetail (9 tabs) | `/lines/:id` **Line** — channel-agnostic summary; linkage panel per channel type; **Agent card** w/ assign/reassign; **Grants panel** + audit forensics; **Rooms** (group contexts) split from DMs (R3-2); config tabs kept | evolve |
| AddLineWizard | **Hatch flow** — animated wizard (R2-8): kind pick (Personal assistant / Community agent / Custom / **Quick Learner** (R3-12)) → channel → link → 3-beat ceremony w/ random-name proposal (R3-11) | redesign |
| (none) | `/agents` **Agents roster** + `/agents/:id` detail — profile, brain (lossless hot-swap, R3-8), skills, assigned lines, per-chat instances w/ pause/kill, **Memory** (search bar, recent, vector count, episodic status, Pinecone + Obsidian status — R3-5), takeover toggle (R3-6) | new |
| (none) | `/dream-lab` **Dream Lab** — agent self-suggested persona edits + approval queue, tagged per agent/instance (R3-7) | new |
| (none) | `/skills` **Skills Hub** — skills/plugins/MCPs/tools: view, search, upload, install, remove; status + **model/harness compatibility matrix**; personal hub → org shared hub (R3-3/4) | new |
| (none) | `/settings` **Settings** — workspace, channels, defaults, **notifications per channel (R3-15)**, API tokens | new |
| (none, admin lane) | **Deployments** — multi-deployment management (containers/hosts/remote), shared skills hub, single admin identity across surfaces (R3-1) — **IN T3 SCOPE (R3-16)** | new |
| `/inbox` Inbox | `/inbox` — unified cross-channel; **DM / Rooms split (R3-2)**; channel filter chips; agent indicator; capability-driven composer (default) | evolve |
| `/metrics`, `/operator` | Ops — consolidated; metrics absorbed (E4: merge now) | consolidate |
| `/welcome` Landing | **in-app first-run splash** — simple CTA → dashboard (R2-3); public marketing deferred | narrow |
| Nav rail | Fleet · Agents · Inbox · Ops · **Skills** · **Dream Lab** · Settings (+ **Deployments** in admin lane); full responsiveness (R2-9) | evolve |

## 3. Journey map (first-run Hatch)

```
Landing → Get started
  → 1 Identity      workspace name + admin (was: wizard Identity step)
  → 2 Channel       pick channel (glyph grid) → channel-specific link instructions
  → 3 Agent         name + persona (soul.md analog) + brain (model) — templates offered
  → 4 Link          WhatsApp QR, Twilio configured advance, Signal/iMessage attestation,
                    or a designed future channel flow
  → 5 Hatch         ceremony beat (one-shot): identity → brain → channel checks seal,
                    agent "hatches" → Line live in Fleet
  → Fleet (seeded, alive)
```

Short path (N+1 line): Fleet → Add line → 2→4→5 (identity/workspace skipped).

## 4. Design-asset reuse map (v3 → v3.5)

| v3 asset | v3.5 fate |
|---|---|
| Token architecture (3-tier) | keep; add channel glyph + agent identity semantic slots |
| Dual themes + warm ramps | keep unchanged |
| Accent law (single blue) | keep; channel identity via **shape/glyph, not hue** (extends status shape law) |
| Nameplate + tick + favicon | keep; marketing may extend display-face usage (spec decision) |
| 25 primitives | keep all; add ChannelGlyph, AgentAvatar (glyph, not mascot), maybe Timeline (hatch steps reuse Stepper) |
| Motion law | keep + one sanctioned exception class: **ceremony one-shots** (bounded, non-looping, reduced-motion → instant) |
| Shape-coded status law | keep; channel glyphs must not collide with status shapes |
| Microcopy voice | keep; add ceremony register (celebratory but restrained, no exclamation in ops) |
| Lint/enforcement chain | keep; extend rules for glyphography + vocabulary |

## 5. Explicit non-goals (this program)

- New runtime channel transports beyond the existing WhatsApp/SMS/Signal/iMessage backends — D2.
- Platform rename of WhatSoup internals — v3 boundary stands.
- Multi-tenant/auth-accounts backend — Workspace is a UI concept until platform work lands.
