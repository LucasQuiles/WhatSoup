# 03 — Sub-task lists per workstream

Each task: deliverable → acceptance. Gates G0–G3 per README skeleton.

## WS0 — Program ops

| # | Task | Deliverable → acceptance |
|---|---|---|
| 0.1 | Pick program home | ✅ Historical decision complete and superseded: original work used `design/soup-v35`; current SSOT is `main`, with T5 continuing on `design/soup-v35-t5-cutover` |
| 0.2 | Plan SSOT | ✅ #2009 merged the package to `main`; current repository docs are canonical |
| 0.3 | Gate rules | Adopt v3 gate discipline (G0/G1/G2/G3, investigation packets, integrator-verifies-claims) → one-page protocol adopted verbatim or amended |
| 0.4 | v3 bench note | Mark v3 program "benched at 16/24 PASS" in its README with pointer to v3.5 → committed doc |

## WS1 — Research (T2)

| # | Task | Deliverable → acceptance |
|---|---|---|
| 1.1 | Hatching digest | `research-hatching.md` ✅ done — fold into program home |
| 1.2 | Onboarding references | 5–8 best-in-class first-run flows (Linear, Vercel, Raycast, Slack, OpenClaw) with screenshots + pattern notes → digest w/ keep/reject list |
| 1.3 | Multi-channel console references | Fleet/channel-management UIs (Twilio, MessageBird, Beeper, Stripe channels) → digest w/ keep/reject list |
| 1.4 | Ceremony motion references | 3–5 one-shot celebration patterns that pass "soothing, not noisy" (no confetti-cannon kitsch) → motion notes for WS4 |

## WS2 — Product model + vocabulary (T1) · **critical path**

| # | Task | Deliverable → acceptance |
|---|---|---|
| 2.1 | Entity model | Channel/Line/Agent/Profile/Assignment/Grant/Instance/Workspace/Hatch definitions + cardinality → one-page model spec, owner-approved |
| 2.2 | ~~Assignment cardinality~~ | ✅ answered R1: Agent 1:N Lines, Line 0:1 Agent, per-chat instances |
| 2.3 | Channel capability matrix | All **14 channels** (A3): link method, identity form, health states, feature flags → matrix table; bind the four runtime-backed transports and provide **full end-to-end mocked state machines** for the other ten (R2-7) |
| 2.4 | Vocabulary amendment | Add Channel, Agent, Profile, Grant, Instance, Assignment, Workspace, Hatch, Deactivated to locked table → spec-ready table (after 2.6) |
| 2.5 | Linkage state machine | two axes: activation (live/deactivated) × linkage (unlinked→linking→linked→degraded→relink), each state w/ distinct style/representation (R2-11) → state diagram + copy map |
| 2.6 | **Instance-model investigation** (R2-5, precedes vocabulary lock) | map/compare the current 4-instance runtime model (primary-line, operator-agent, sandbox-agent, chat-bot) → v3.5 archetypes + product model: capabilities, configs, session scopes per archetype → investigation doc w/ mapping table + gaps |

## WS3 — Direction mockups (T3) — wall-to-wall scope (R3-16)

| # | Task | Deliverable → acceptance |
|---|---|---|
| 3.1 | Fleet (multi-channel) | channel glyphs, agent presence, grant indicators, density → HTML mockups, both themes, mobile included (R2-9) |
| 3.2 | Hatch flow | animated wizard: kind pick (incl. Quick Learner + consent beat) → channel → link → 3-beat ceremony w/ random-name proposal → clickable HTML, light+dark |
| 3.3 | Agents roster + detail | roster + profile editor (tool-permission toggles, R3-9) + brain hot-swap UX + instances panel + assignment UI → HTML mockup |
| 3.4 | Skills Hub | lifecycle (view/search/upload/install/remove) + compatibility matrix + personal/org hub modes → HTML mockup |
| 3.5 | Dream Lab | approval queue, diff view of suggested persona edits, per-agent/instance tags → HTML mockup |
| 3.6 | Memory surface | search bar, recent memories, vector count, episodic status, Pinecone + Obsidian integration status → HTML mockup (may fold into 3.3) |
| 3.7 | Deployments (admin lane) | multi-deployment roster, remote fleet health, shared hub, single admin identity → HTML mockup |
| 3.8 | Inbox (DM/Rooms split) + Line detail (Rooms, grants, audit) | HTML mockups |
| 3.9 | First-run splash + Settings (notifications per channel) | HTML mockups |
| 3.10 | Comparison launcher | index page linking all directions (v3 pattern) → G1 review package |

## WS4 — Spec v3.5 (T4)

| # | Task | Deliverable → acceptance |
|---|---|---|
| 4.1 | Channel glyphography | shape-glyph per channel, 16px legibility, no collision w/ status shapes, no hue coding → spec + SVG set |
| 4.2 | Agent identity layer | avatar-glyph anatomy (initials/shape, not mascot), persona card, presence states → spec |
| 4.3 | Ceremony motion budget | one-shot class definition: duration cap, easing, reduced-motion=instant, where allowed (Hatch only) → motion.md amendment |
| 4.4 | Onboarding spec | journey map, per-step anatomy, empty states, error/relink paths → flow spec |
| 4.5 | Marketing spec | page map, display-type scale, warmth budget vs console restraint → spec |
| 4.6 | Token deltas | new semantic slots (channel-*, agent-*) → tokens-v3 addendum |
| 4.7 | Settings IA | settings surface spec (workspace/channels/defaults/notifications/tokens) → spec |

## WS5 — v3 debt disposition

| # | Task | Deliverable → acceptance |
|---|---|---|
| 5.1 | Execute G-08 table | each open DD moved to carry/superseded/decision with owner sign-off → register updated |
| 5.2 | Close cheap items | DD-34 (one QA frame), DD-39 min-engine ruling → closed |
| 5.3 | Fold carried items | carried DDs assigned into WS4/WS6 task lists → no orphan debt |

## WS6 — Performance budget

| # | Task | Deliverable → acceptance |
|---|---|---|
| 6.1 | Budget doc | targets: Fleet first paint <Xs, update frame <16ms at N=200 lines, chart throttle policy, WS rate caps, 24h memory flat → owner-approved numbers |
| 6.2 | Instrumentation plan | measure points (render profiler, WS throughput, long-task observer) + CI perf lane proposal → plan doc |
| 6.3 | Virtualization audit | which lists/feeds/tables virtualize (feed, lines table, log stream) → audit table w/ per-surface ruling |
| 6.4 | DD-22 decision | LogStream live-tail: ship/stream/defer → recorded |

## Suggested sequencing

```
G0 → WS2 (model) ─┬─► WS1 (research) ─► WS3 (directions) ─► G1 ─► WS4 (spec) ─► G2
                  └─► WS5 + WS6 run parallel, land before G2
                              WS0 continuous
```

Historical first-dispatch recommendation (completed/superseded): **WS2 tasks 2.1–2.5** plus
**WS1 1.2–1.4**. The program-home choice no longer awaits a decision: `main` is the current SSOT,
#2009 is merged, and the active T5 successor branch is `design/soup-v35-t5-cutover`.
