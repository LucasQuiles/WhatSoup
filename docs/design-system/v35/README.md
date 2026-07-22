# SOUP Design System v3.5 — Program Skeleton

**Status:** T0 complete; **G0 approved**; all three interview rounds locked (41 decisions,
`04-decision-register.md`). **T1 in progress**: WS2.6 instance-model investigation → product
model + vocabulary lock, WS1 research digest. T3 is wall-to-wall (R3-16): 10 mockup tracks.
**Mandate date:** 2026-07-21 (owner: Lucas).
**Home:** branch `design/soup-v35` on `LucasQuiles/WhatSoup`, path
`docs/design-system/v35/` (A1).
**Relationship to v3:** v3 implementation program is **benched** (not cancelled). Landed v3 work
(tokens, primitives, themes, conformance PASS rows) is the v3.5 starting inventory. v3's locked
direction is reopened by owner decision; v3 spec docs remain reference, not authority.

## Owner decisions (locked 2026-07-21)

| # | Decision |
|---|---|
| D1 | Bench v3 implementation; design v3.5 fresh now. Reusable v3 assets absorbed per gap-audit disposition. |
| D2 | UI/UX focus only. No new runtime channel backends (Signal/iMessage/social transports are future platform work). |
| D3 | Scope = operator console **and** public landing/marketing surface. |
| D4 | "Socials" = managed social channels (X, IG DMs, etc.) as first-class **Lines** with **assigned agents**. |
| D5 | First-run onboarding is a designed journey incl. a **hatching ceremony** (research: OpenClaw hatch ritual + Hermes Pets animation model — see `research-hatching.md`). |
| D6 | This package (inventory, gap audit, skeleton, mapping, subtasks) is the program seed. |

## v3.5 scope statement

Elevate SOUP from a WhatsApp console with a strong design system into a **multi-channel fleet
product**: channel-agnostic Lines (WhatsApp today; Signal, iMessage, X, IG as designed futures),
first-class **Agents** assigned to Lines, a guided first-run **Hatch** journey, a marketing-grade
landing surface, and a measured real-time performance budget — all on the v3 industrial-polish
creative bar: clean, calm, soothing-subtle, dense-operator when needed.

## Program skeleton (phases + gates)

| Phase | Name | Content | Exit |
|---|---|---|---|
| T0 | Seed | This package: landscape inventory, gap audit, mapping, subtasks | ✅ done |
| **G0** | Kickoff | Owner approves skeleton, picks first direction batch | pending |
| T1 | Product model | Channel / Line / Agent / Assignment entities + vocabulary lock | model spec |
| T2 | Research digest | Hatching (done → fold in), onboarding journey references, multi-channel console references | digest |
| T3 | Directions | 2–3 visual directions for: Fleet (multi-channel), Hatch flow, Agents surface, Landing | mockups |
| **G1** | Direction lock | Owner picks direction/blend | locked mockup |
| T4 | Spec v3.5 | Token deltas, channel glyphography, agent identity layer, ceremony motion budget, onboarding spec, marketing spec | spec set |
| **G2** | Spec lock | Owner locks spec | authority doc |
| T5 | Enforcement + cutover | Lint plan delta, v3 debt carryover plan, cutover sequencing | plans |
| **G3** | Implementation readiness | Sign-off; slices begin | readiness packet |

## Workstreams (subtasks in `03-subtasks.md`)

- **WS0** Program ops (branch/worktree, plan SSOT, gate discipline)
- **WS1** Research (hatching ceremony — done; onboarding + console references)
- **WS2** Product model + vocabulary
- **WS3** Direction mockups (Fleet, Hatch, Agents, Landing)
- **WS4** Spec authoring (glyphography, identity, motion budget, flows)
- **WS5** v3 debt disposition (carry / close / supersede per item)
- **WS6** Performance budget (real-time dashboarding targets + instrumentation plan)

## Artifacts

| File | Content |
|---|---|
| `00-landscape-inventory.md` | Current console + design-system state, as-audited 2026-07-21 |
| `01-gap-audit.md` | v3.5 scope items → current state → gap → severity |
| `02-mapping.md` | Surface-by-surface and concept-by-concept current → v3.5 map |
| `03-subtasks.md` | Per-workstream task lists with deliverables and acceptance |
| `research-hatching.md` | OpenClaw hatch ritual + Hermes Pets animation model digest |

## Key design tensions (flagged for G1, not blocking T1–T3)

1. **Ceremony vs motion law.** v3 allows exactly one ambient loop and rejects decorative motion; a
   hatching ceremony needs a sanctioned, bounded exception (one-shot, not ambient). Options in WS4.
2. **No-mascot law vs agent companions.** v3 forbids mascots/illustration in the console; D5's
   companion-like hatch moment needs a defined identity carrier (glyph/persona card, not mascot).
3. **Instrument restraint vs marketing surface.** Landing wants warmth/celebration; console stays
   calm. The brand spec must draw the line explicitly (brand.md §1.4 already cracks this door).
