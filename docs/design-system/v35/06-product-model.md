# 06 — Product Model + Vocabulary Lock (WS2.1/2.4/2.5 — T1 deliverable)

Derived from 41 locked owner decisions + WS2.6 investigation. This is the candidate vocabulary
lock; owner approval = T1 exit.

## 1. Entities

| Entity | Definition | Key fields | Notes |
|---|---|---|---|
| **Channel** | A messaging platform class | id, name, class (messaging/socials/channels), glyph, linkMethod, capabilities, health semantics | 14 designed product-model entries: wa·signal·imessage·sms·discord·telegram · x·linkedin·reddit·instagram·facebook · email·slack·teams. Exactly four implemented transport IDs—Baileys/WhatsApp, Twilio/SMS, Signal, and iMessage—are runtime-backed; ten remain mocked/future (D2) |
| **Deployment** | One WhatSoup runtime (host/container) | id, name, address, version, status, lines, agents | Admin lane (R3-16); this deployment = "Local" |
| **Line** | A channel account under management | id, deploymentId, channelId, identity (phone/handle/email), linkage state, activation state, assignedAgentId, grants[], tags | "deactivated" when activation off (R2-11) |
| **Agent** | An assignable worker created from an archetype | id, name, avatar (initials/picture), archetype, persona, brain, skills[], toolPermissions, memoryConfig, status | dynamic creation (R2-4); random-name at hatch (R3-11) |
| **Profile** | A saved, reusable agent configuration | id, name, archetype, persona, brain, skills, permissions, limits | create/edit/duplicate/assign/**swap** w/ diff preview (B1) |
| **Assignment** | Live binding Agent↔Line | agentId, lineId, mode, createdAt, history | Agent 1:N Lines, Line 0:1 Agent (A4) |
| **Instance** | A runtime agent session in one chat | id, agentId, conversationId, state (active/paused/killed), startedAt | per-chat (R2-12); inspect + pause/kill |
| **Grant** | Permission for an agent to access a line | agentId, lineId, level (hidden/see/participate), grantedAt, grantedBy | + audit forensics (R3-14); personal lines hidden-by-default w/ warning (R3-13) |
| **Person** | Unified human identity across channels | id, displayName, identities[] (per-channel ids), notes | single admin identity across surfaces (R3-1) |
| **Room** | A group context on a line | id, lineId, channelRoomId, name, participants, policy | split from DMs (R3-2) |
| **Conversation** | A thread (DM or Room) | id, lineId, personId/roomId, channelId, unread, takeover state | unified inbox (B4) |
| **Skill** | An installable capability unit | id, name, source (hub/upload), version, status, compatibility[] | hub covers skills+plugins+MCPs+tools (R3-3) |
| **Memory** | Agent's durable knowledge | agentId, store (Pinecone index), vectorCount, episodicStatus, obsidianStatus | R3-5 surface projects it |
| **Dream** | A self-suggested persona edit | id, agentId, diff, rationale, status (queued/approved/rejected), createdAt | Dream Lab (R3-7) |
| **Hatch** | The creation+link+activate journey | kind, channel, agent, linkage, ceremony state | journey vocabulary; ops copy stays dry |
| **Workspace** | The named root container | id, name, theme, defaults, notificationRules | single-user now (R2-2) |

## 2. Core relationships

```
Deployment 1──N Line
Deployment 1──N Agent
Channel    1──N Line
Agent      1──N Assignment ──N? no: Line 0..1 Assignment (active)
Agent      1──N Instance 1──1 Conversation
Agent      1──N Grant ──N? Line (Grant = agent×line)
Agent      1──N Dream
Agent      1──1 MemoryStore
Agent      N──M Skill (via Hub install)
Line       1──N Conversation (DM w/ Person | Room)
Person     1──N Identity (per channel)
Profile    ──materializes──▶ Agent (or swaps an Agent's config w/ diff preview)
```

## 3. State machines

**Line linkage × activation (two axes, R2-11 — each state has own style/representation):**
```
Linkage:   unlinked → linking → linked ⇄ degraded → relinking → linked
           (linked → unlinked = "unlink", destructive w/ confirmation, R3-10)
Activation: deactivated → activating → live → deactivating → deactivated
Error legs: link_failed (retryable), config_error
```

**Agent:** draft → hatching → live ⇄ paused → retired (recoverable archive, 30d → purge, R3-10)

**Instance:** spawned → active ⇄ paused → killed (terminal) · takeover states: agent-driven ⇄
human-takeover (explicit toggle only, R3-6)

**Dream:** suggested → queued → approved (applies to persona) / rejected → archived

**Grant:** requested → granted ⇄ revoked (all transitions forensically logged)

**Brain swap:** swapping → handoff (context transfer, R3-8) → live-on-new ⇄ rollback

## 4. Vocabulary lock (amends v3 brand.md §2)

| Concept | Locked term | Banned in UI copy | Notes |
|---|---|---|---|
| Product | SOUP | WhatSoup (protected substrate only) | unchanged |
| Dashboard | Fleet | Soup Kitchen | unchanged |
| Managed channel account | **Line** | instance (process copy only), connection | unchanged, extended |
| Messaging platform class | **Channel** | transport (config copy), integration | new |
| Runtime host | **Deployment** | server, node, host (in copy) | new (admin lane) |
| Assignable worker | **Agent** | bot, instance | new |
| Saved agent config | **Profile** | template (reserved for hatch starter personas) | new |
| Agent↔Line binding | **Assignment** | — | new |
| Per-chat session | **Instance** | session (process copy OK) | new — reclaims word for product |
| Agent×Line permission | **Grant** | permission (verb), share | new |
| Unified human | **Person** | contact (channel-specific copy only) | new |
| Group context | **Room** | group (WA-specific copy only) | new |
| Self-suggested persona edit | **Dream** | — | Dream Lab (R3-7) |
| Creation journey | **Hatch** (journey-side only) | — | ops copy: "Add line", "Line is live" |
| Inactive line | **deactivated** | sealed, egg, offline (state copy) | R2-11/D3 |
| Human control of a thread | **Takeover** | override | toggle-gated (R3-6) |
| Alerts | attention (metric) | — | unchanged |
| Modes | passive / chat / agent | — | unchanged, load-bearing |
| Capability unit | **Skill** | plugin (hub copy groups skills/plugins/MCPs/tools honestly) | new |

## 5. Open model questions resolved by decision register

- Assignment cardinality → A4 (1:N, per-chat instances) ✅
- Agent kinds → R2-4 + R3-12 (archetypes behind plain-language kinds + Quick Learner) ✅
- Brain swap → R3-8 (handoff-first, no lossy exchanges) ✅
- Memory integrations → R3-5 (Pinecone + episodic + Obsidian status) ✅
- Skills scope → R3-3 (hub: skills + plugins + MCPs + tools, compatibility matrix) ✅

## 6. Explicitly NOT in the model (guards against drift)

- No multi-user/roles (single user, two lanes — R2-2). Workspace is single-tenant.
- No new runtime transports beyond the existing wa/sms/signal/imessage set in this program (D2).
- No mascot/character entity — identity via avatar ladder (pic → initials → channel glyph).
- No public marketing entity set (R2-3: splash only).
