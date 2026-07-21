# 04 — Decision Register (owner choices)

Round 1 ✅ · Round 2 ✅ · Round 3 ✅ · **Round 4 (design language) ✅ 2026-07-21** — L1–L11
answers + computed token candidates: `09-design-language-decisions.md`. Headline: gentle warm
ramp (26%→17% chroma), accent hue family kept, harmonized 38/34 agent hue set, two shape
registers w/ broad enforcement, "dreamy lift" motion class, glyph state system, ceremonious
glow exception (hatch only), type triad kept.

## Round 3 — final lock (entities, agent behavior, ops)

| # | Question | Answer |
|---|---|---|
| R3-1 | Unified Person entity | ✅ YES — single admin identity consistent across each surface; Person unifies cross-channel contacts. |
| R3-2 | Rooms | ✅ YES — group contexts vs DMs separated, mirroring WhatsApp's group/DM split, per channel. |
| R3-3 | Skills registry | ✅ **HUB STYLE** — view, search, upload, install, remove, manage installed skills, **plugins, MCPs, and other tools**; see status + **compatibility across models/harnesses**. |
| R3-4 | Skills sharing | ✅ via the hub — adaptive: single-user hub **or org deployment with a shared hub**. |
| R3-5 | Agent memory UI | ✅ YES + **Pinecone integration, memory search bar, recent memories, vector count, episodic memory status, Obsidian integration + status**. |
| R3-6 | Human takeover | ✅ **Explicit toggle on/off** — NO auto-pause (prevents accidental takeovers). |
| R3-7 | Persona authority | ✅ **"Dream Lab" section** — the agent's live queue of self-suggested persona edits + approval queue, tagged per agent/instance. |
| R3-8 | Brain hot-swap | ✅ YES — with **extensive behind-the-scenes handoff** to avoid lossy exchanges degrading UX. |
| R3-9 | Tool permissions | ✅ toggles/checkboxes/dropdowns in profile editor; granular scoping; easily configured + verified. |
| R3-10 | Cascade rules | ✅ YES — loud warnings + user confirmations against accidental deletes. |
| R3-11 | Naming | ✅ wizard proposes + **randomize name selection for fun**. |
| R3-12 | Archetype kinds | ✅ YES + **"Quick Learner" option** — scans user's email, messages, documents + other shared sources (once connected) to generate an auto-profile. |
| R3-13 | Personal-line grants | ✅ hidden-by-default + warning: "assign an agent permissions or no one can see this". |
| R3-14 | Grant audit trail | ✅ YES — proper forensics to debug + ensure security. |
| R3-15 | Notifications | ✅ YES — configurable settings per channel (browser push / webhook / etc.). |
| R3-16 | T3 scope | ✅ **NO EXCLUSIONS — "wall-to-wall marathon"**: Deployments/admin lane fully mocked in T3 too. |

### Round-3 scope deltas (new surfaces/features)
- **Dream Lab** — agent self-improvement queue + approval (per agent/instance tags).
- **Memory surface** — search, recent, vector count, episodic status; Pinecone + Obsidian integration status.
- **Skills Hub** — skills/plugins/MCPs/tools lifecycle + model/harness compatibility matrix; personal → org shared hub.
- **Quick Learner** — persona auto-generation from connected sources at hatch (needs one explicit consent boundary).
- **Deployments (admin lane)** — promoted INTO T3 mockup scope (R3-16).
- **Takeover toggle**, **lossless brain-swap handoff**, **random name generator** at hatch.

## Round 2 — user model, agent model, ceremony, access

| # | Question | Answer |
|---|---|---|
| R2-1 | Who hatches? | **Non-technical user** — pairing their first line must let them hatch their first agent and start building. Console stays operator-grade; the journey is non-technical. |
| R2-2 | Single/multi-user | **Single user, two lanes**: (a) the single-user UI/UX (build now); (b) an **admin tier** managing additional WhatSoup deployments — other containers, other hosts, remote — **IA accommodates, not built yet**. ("Teams" in A3 = MS Teams channel, confirmed.) |
| R2-3 | Splash | **In-app first-run** — simple CTA → dashboard for now. |
| R2-4 | Agent creation | **Dynamic entity, created from one of the 4 instance archetypes** (primary-line, operator-agent, sandbox-agent, chat-bot) with per-archetype configs/options. |
| R2-5 | Instance mapping | **Map/compare/investigate/analyze existing model FIRST** — new task WS2.6 (instance-model investigation) precedes vocabulary lock. |
| R2-6 | Skills | **Skills = its own area** — skill management surface + **team/org-wide skill sharing across managed instances** (admin-lane flavored). |
| R2-7 | Channel mocks | **Full end-to-end mocked, ready to plug in** — complete per-channel flow state machines; transports drop in later without UI changes. |
| R2-8 | Ceremony medium | **Animated wizard** — low friction, clean clear concise explanations, **demonstrative over explanative**. (Not conversational.) |
| R2-9 | Mobile | **Full responsiveness and compatibility required** — all v3.5 surfaces. |
| R2-10 | Grant levels | ✅ hidden / see / participate — **with distinct iconography + indicators per level**. |
| R2-11 | Deactivate vs unlink | ✅ two axes (activation × linkage), **each state with its own style/representation**. |
| R2-12 | Per-chat instances | ✅ **both** — inspect + pause/kill where applicable. |

### Round-2 scope deltas
- **Nav grows**: Fleet · Agents · Inbox · Ops · **Skills** · Settings (R2-6). Admin lane adds a
  future **Deployments** area (R2-2) — IA reserves, no T3 mockups.
- **Agent archetypes**: the 4 instance models become creation archetypes w/ per-type options (R2-4).
- **WS2.6 instance-model investigation** (R2-5) — precedes vocabulary lock in T1.
- **Responsiveness bar raised**: full mobile support, not desktop-first-tolerant (R2-9) —
  absorbs DD-18r outright.
- **Ceremony = animated wizard** (R2-8) — OpenClaw conversational model rejected; keep the
  3-beat cap + prefilled-first-message ideas, re-express as wizard beats with demo-forward
  visuals.

## Block A

| # | Decision | Answer |
|---|---|---|
| A1 | Program home | ✅ YES — branch `design/soup-v35` + worktree `.worktrees/soup-v35-design` created from origin/main `6fb5ee72`. File migration blocked by this session's external-dir write sandbox; docs SSOT currently `~/agents/q/docs/design-v35/` (git-tracked), migration pending a write-capable session. |
| A2 | v3 bench mechanics | ✅ YES — banner + frozen records (to execute on first repo-write session) |
| A3 | Channel registry | ✅ **14 channels, 3 classes.** Messaging: whatsapp (real), signal, imessage, sms, discord, telegram · Socials: x, linkedin, reddit, instagram, facebook · Channels: email, slack, teams |
| A4 | Agent:Line cardinality | ✅ Agent profile 1:N Lines; **runtime per-chat agent instances** (inherits current per-chat session structure) |
| A5 | "Hatch" vocabulary | ✅ RESEARCH FIRST (A5 deep-dive done → research-hatching.md §1.5); adopt journey-side, ops stays dry |

## Block B

| # | Decision | Answer |
|---|---|---|
| B1 | Persona portability | ✅ YES — one agent profile assignable to multiple lines; **profiles are saved objects with create/manage/assign/swap UX** (new scope G-03a) |
| B2 | Identity carrier | ✅ **Initials avatar + assignable profile picture + name** (glyph fallback demoted to ladder tail) |
| B3 | Unassigned/passive lines | ✅ passive-only + **permission grants**: passive/personal lines grant which agents can see/use them (new scope G-03b — Line Access Control) |
| B4 | Unified inbox | ✅ YES — clean, consistent, user-friendly |
| B5 | Workspace IA | ✅ YES |

## Block C

| # | Decision | Answer |
|---|---|---|
| C1 | Nav set | ✅ YES (Fleet · Agents · Inbox · Ops · Settings) unless better structure emerges in review |
| C2 | Settings scope | ✅ YES + any additional surfaces required |
| C3 | Marketing | ✅ **Basic splash/explainer page only — no pricing, no feature pages yet** |
| C4 | Entry journey | ✅ YES — careful user-journey design required |
| C5 | Ceremony surfaces | ✅ both (full-screen first-run + inline N+1) — careful UX consideration |
| C6 | Templates at hatch | ✅ basic templates provided |

## Block D

| # | Decision | Answer |
|---|---|---|
| D1 | Channel glyphs | ✅ **Monotone/silhouette iconography**, good design practices; no hue coding |
| D2 | Ceremony motion | ✅ YES as **feature animation** (one-shot), not an animated control; less motion-sensitive here |
| D3 | Inactive state language | ✅ **"deactivated"** (not sealed/egg) |
| D4 | Display face on marketing | ✅ YES + **standing approval to design as I see fit** |
| D5 | Nameplate | ✅ untouched |

## Block E — all pulled INTO active scope ("address now")

| # | Decision | Answer |
|---|---|---|
| E1 | Fleet design target | ✅ 200 lines |
| E2 | Perf instrumentation | ✅ NOW (WS6.2 promoted to T1-adjacent) |
| E3 | LogStream live-tail | ✅ decide NOW (WS6.4 promoted) |
| E4 | Ops/Metrics merge | ✅ NOW (folded into T3 IA work) |

## New scope items created by answers

- **G-03a Agent Profiles UX** — create/manage/assign/swap saved profiles (roster + editor +
  swap-in-place flow with per-line diff preview).
- **G-03b Line Access Control** — permission grants on passive/personal lines controlling which
  agents can see/use them (grant model + management UI + Fleet visibility).
- **A4-session model** — per-chat agent instances (design the session/instance relationship
  into the Agent detail surface: active instances, per-chat presence).
- **Channel registry at 14 entries** — capability matrix (WS2.3) grows; glyphography (WS4.1)
  covers 14 monochrome glyphs + class shapes.
