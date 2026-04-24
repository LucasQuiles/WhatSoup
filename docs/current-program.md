# Current Program — WhatSoup

> Reader-facing synthesis of what is active, completed-and-still-relevant,
> legacy/historical, and what supersedes what. Derived mechanically from
> `docs/work-index.json` under the rules in `docs/canonical-status-policy.md`.
>
> Where the index does not carry enough authored data to answer a question,
> this doc says **unknown** rather than inferring.

**Generated from:** `docs/work-index.json` (schema v5, 171 rows, 0 inconsistencies)
**Policy:** [`docs/canonical-status-policy.md`](canonical-status-policy.md)
**Status distribution:** completed=113, pending=37, unknown=12, deferred=7, active=2

> **Refresh history:** first cut used the pre-step-4 index (27 unknowns, 1 deferred,
> 103 completed). This refresh reflects the post-step-4 state: 12 unknowns,
> 7 deferred rows (1 epic + 6 inherited children), 113 completed.

---

## 1. What is active now

Exactly one SDLC epic is genuinely active. State declared explicitly in its `state.md`.

| Epic | Status source | Notes |
|---|---|---|
| [`docs/sdlc/active/agent-layer-hardening-20260405/`](sdlc/active/agent-layer-hardening-20260405/) | `state-md-status` | Phase 6 hardening. 20 beads tracked in its Bead Manifest: SP1–SP8, SP10, SP12, SP13 (note gaps at SP9 and SP11); SEC1–SEC5; CFG1–CFG4. Remaining Synthesize-phase verification is the only open work. |

Its state.md and `evidence-reconnect.md` are the two index rows classified `active`. All 20 bead rows under it resolve individually via `bead-manifest` (most `completed`, some still-open tracked in that table).

---

## 2. Deferred (shelved, not finished, not superseded)

One SDLC epic is explicitly declared `deferred` via its `state.md` Status field. Six child artifacts inherit that status through authored `**Status:** deferred` markers that point back to the parent epic (added in step 4).

| Path | Kind | Status source |
|---|---|---|
| [`docs/sdlc/closed/fleet-charts-20260407/state.md`](sdlc/closed/fleet-charts-20260407/state.md) | state | `state-md-status` |
| [`docs/superpowers/plans/2026-04-07-fleet-charts.md`](superpowers/plans/2026-04-07-fleet-charts.md) | plan | `body-marker` |
| [`docs/superpowers/specs/2026-04-07-soup-kitchen-fleet-charts.md`](superpowers/specs/2026-04-07-soup-kitchen-fleet-charts.md) | spec | `body-marker` |
| [`docs/superpowers/handoffs/2026-04-07-fleet-charts-guidelines.md`](superpowers/handoffs/2026-04-07-fleet-charts-guidelines.md) | handoff | `body-marker` |
| [`docs/superpowers/handoffs/2026-04-07-fleet-charts-kickoff.md`](superpowers/handoffs/2026-04-07-fleet-charts-kickoff.md) | handoff | `body-marker` |
| [`docs/superpowers/handoffs/2026-04-07-fleet-charts-project-statement.md`](superpowers/handoffs/2026-04-07-fleet-charts-project-statement.md) | handoff | `body-marker` |
| [`docs/superpowers/handoffs/2026-04-07-fleet-charts-sop.md`](superpowers/handoffs/2026-04-07-fleet-charts-sop.md) | handoff | `body-marker` |

All six child rows cite the same reason: Phase 4-Execute was incomplete when the epic folder was moved to `closed/`; beads B01–B11 remain unimplemented. Work is shelved by authored decision, not superseded.

---

## 3. Completed epics and their current relevance

17 SDLC epics are marked `completed` (up from 16 pre-step-4; `dedup-consolidation-20260404` was resolved from unknown after its state.md Status was rewritten from a phase name to policy vocabulary). "Still relevant" is a runtime judgment the index cannot make, so the tables below give:

- the authoritative status source
- any **pending beads** left behind in the epic (policy's mark-read-api-style mixed state — honest scanner output, not bugs)
- the canonical path

Reader can decide relevance against live system behavior.

### Completed — no pending beads (12 epics)

| Epic | Path |
|---|---|
| add-line-wizard-20260401 | [`docs/sdlc/closed/add-line-wizard-20260401/`](sdlc/closed/add-line-wizard-20260401/) |
| control-plane-20260401 | [`docs/sdlc/closed/control-plane-20260401/`](sdlc/closed/control-plane-20260401/) |
| dedup-consolidation-20260404 | [`docs/sdlc/closed/dedup-consolidation-20260404/`](sdlc/closed/dedup-consolidation-20260404/) |
| design-fidelity-fixes-20260401 | [`docs/sdlc/closed/design-fidelity-fixes-20260401/`](sdlc/closed/design-fidelity-fixes-20260401/) |
| design-system-compliance-2026-04-06 | [`docs/sdlc/closed/design-system-compliance-2026-04-06/`](sdlc/closed/design-system-compliance-2026-04-06/) |
| phase3-console-features-20260401 | [`docs/sdlc/closed/phase3-console-features-20260401/`](sdlc/closed/phase3-console-features-20260401/) |
| session-leak-audit-20260406 | [`docs/sdlc/closed/session-leak-audit-20260406/`](sdlc/closed/session-leak-audit-20260406/) |
| whatsapp-mcp-features | [`docs/sdlc/closed/whatsapp-mcp-features/`](sdlc/closed/whatsapp-mcp-features/) |
| audit-remediation-20260330 | [`docs/sdlc/completed/audit-remediation-20260330/`](sdlc/completed/audit-remediation-20260330/) |
| heal-reliability-fixes-20260401 | [`docs/sdlc/completed/heal-reliability-fixes-20260401/`](sdlc/completed/heal-reliability-fixes-20260401/) |
| p0-production-blockers-20260330 | [`docs/sdlc/completed/p0-production-blockers-20260330/`](sdlc/completed/p0-production-blockers-20260330/) |
| remaining-hardening-20260330 | [`docs/sdlc/completed/remaining-hardening-20260330/`](sdlc/completed/remaining-hardening-20260330/) |

### Completed — with pending beads left behind (5 epics, 37 beads total)

These epics declare `completed` at the state.md level but carry pending bead rows. Per policy this is mixed state, not a scanner bug. Each pending bead is a candidate for either closure (mark completed if the work actually shipped), reclassification (mark deferred if abandoned), or re-opening (move to an active epic if the work is resuming).

| Epic | Pending bead count | Path |
|---|---|---|
| mark-read-api-20260408 | 3 | [`docs/sdlc/closed/mark-read-api-20260408/`](sdlc/closed/mark-read-api-20260408/) |
| multi-provider-runtime-2026-0404 | 7 | [`docs/sdlc/closed/multi-provider-runtime-2026-0404/`](sdlc/closed/multi-provider-runtime-2026-0404/) |
| codex-transport-gaps-20260404 | 14 | [`docs/sdlc/completed/codex-transport-gaps-20260404/`](sdlc/completed/codex-transport-gaps-20260404/) |
| transport-hardening-20260404 | 6 | [`docs/sdlc/completed/transport-hardening-20260404/`](sdlc/completed/transport-hardening-20260404/) |
| whatsoup-full-hardening-20260331 | 7 | [`docs/sdlc/completed/whatsoup-full-hardening-20260331/`](sdlc/completed/whatsoup-full-hardening-20260331/) |

These 37 pending beads remain the primary candidate set for a future triage pass.

---

## 4. What supersedes what

Explicit supersession relationships captured in the index: **one** (via the policy-conformant `## Follow-on` pattern).

| Predecessor | Successor | Evidence |
|---|---|---|
| `whatsapp-mcp-features` | [`agent-layer-hardening-20260405`](sdlc/active/agent-layer-hardening-20260405/) | `## Follow-on` section in the predecessor's state.md |

For every other epic and every `docs/superpowers/*` artifact, **the supersession relation is unknown** — no structured `Supersedes:` or `Superseded by:` marker exists in the index. The `supersedes_hint` column in `docs/work-index.json` has zero populated rows.

Cross-tree topic clusters exist (`fleet-charts` = 6 entries across 3 trees; `anti-echo-session-controls` = 2 entries, plan + spec; `scheduled-groups-tabs` = 2 entries, plan + spec) but the index does not state which entry within each cluster supersedes another. Per policy these remain unknown until explicit markers are authored. Note: an anti-echo review-handoff exists at `docs/superpowers/reviews/2026-04-07-anti-echo-review-handoff.md` but is not part of the cross-tree cluster (it's a single-tree row), and is listed separately in the normalization backlog.

---

## 5. Legacy / historical only

Step 4 drained the `docs/plans/` legacy bucket: the two entries moved to `docs/superpowers/plans/` with explicit `**Status:** unknown — stalled at SPEC DRAFT stage; never became an SDLC epic` markers that preserve the original authored status text inline. The `docs/plans/` directory no longer exists in the repo.

| Path | Status | Notes |
|---|---|---|
| [`docs/superpowers/plans/2026-04-05-phase4-realtime-performance.md`](superpowers/plans/2026-04-05-phase4-realtime-performance.md) | unknown | Drained from `docs/plans/`. Never implemented as an SDLC epic. |
| [`docs/superpowers/plans/2026-04-05-phase5-analytics-observability.md`](superpowers/plans/2026-04-05-phase5-analytics-observability.md) | unknown | Same. |

Both remain in the normalization backlog below but are flagged as historical.

The `docs/superpowers/*` trees are planning/design surfaces per policy — not authoritative execution truth by themselves. Status for each entry resolves one of three ways: authored `body-marker`, inherited from a linked epic, or `unknown`. Step 4 added authored `body-marker` status to 13 files across this tree; the distribution among `docs/superpowers/*` is now:

- **7 completed** via `body-marker` (SP1–SP4 plans and history-sync plan in `superpowers/plans/`; mcp-feature-gaps and phase2-mcp-features in `superpowers/specs/`) — enumerated in the Completed-plans-and-specs subsection below
- **6 deferred** via `body-marker` (fleet-charts plan + spec + 4 handoffs) — already enumerated in §2
- **12 unknown** — see **Normalization backlog** below

### Completed plans and specs in docs/superpowers/*

Seven non-SDLC artifacts now carry an authored `**Status:** completed` pointer to their implementing epic:

| Path | Implementing epic |
|---|---|
| [`docs/superpowers/plans/2026-04-05-sp1-media-access.md`](superpowers/plans/2026-04-05-sp1-media-access.md) | `whatsapp-mcp-features` Phase 1 (SP1 bead, merged 2026-04-05) |
| [`docs/superpowers/plans/2026-04-05-sp2-content-completeness.md`](superpowers/plans/2026-04-05-sp2-content-completeness.md) | `whatsapp-mcp-features` Phase 1 (SP2 bead) |
| [`docs/superpowers/plans/2026-04-05-sp3-search-enhancement.md`](superpowers/plans/2026-04-05-sp3-search-enhancement.md) | `whatsapp-mcp-features` Phase 1 (SP3 bead) |
| [`docs/superpowers/plans/2026-04-05-sp4-two-way-voice.md`](superpowers/plans/2026-04-05-sp4-two-way-voice.md) | `whatsapp-mcp-features` Phase 1 (SP4 bead) |
| [`docs/superpowers/plans/2026-04-23-history-sync-fitness-cleanup.md`](superpowers/plans/2026-04-23-history-sync-fitness-cleanup.md) | PR #11 (f6a25d8) — history-sync refactor |
| [`docs/superpowers/specs/2026-04-04-mcp-feature-gaps-design.md`](superpowers/specs/2026-04-04-mcp-feature-gaps-design.md) | `whatsapp-mcp-features` Phase 1 (full phase) |
| [`docs/superpowers/specs/2026-04-05-phase2-mcp-features-design.md`](superpowers/specs/2026-04-05-phase2-mcp-features-design.md) | `whatsapp-mcp-features` Phase 2 (full phase) |

These 7 rows account for part of the 113 completed total. The remainder is 106 rows under SDLC epics: 17 epic state.md rows + 76 beads + 12 supporting docs + 1 handoff, all resolved via `bead-manifest`, `body-marker`, or inherited `state-md-status`.

---

## 6. Unknown-status epics

**None.** Step 4 closed the sole remaining SDLC unknown (`dedup-consolidation-20260404`), whose state.md previously declared `**Status:** Execute` (a phase name, not a policy-vocabulary status). The Status field was rewritten to `completed` with a `Closed: 2026-04-11 via cf0dbf3` reference to the authored closure commit.

All 19 SDLC epic state.md rows now classify to a policy-vocabulary status. Resolution sources: `state-md-status` (16), `phase-log` (2), and `directory` (1 — `docs/sdlc/completed/p0-production-blockers-20260330/state.md` has no explicit Status field and inherits its `completed` classification from the `sdlc/completed/` bucket per policy fallback). No epic resolves to `unknown`.

---

## 7. Normalization backlog — 12 unknown rows for future triage

Step 4 reduced the backlog from 27 to 12. The remaining entries have no authored status AND no clear parent-epic evidence. Per policy they stay unknown until explicit markers are authored. All are in `docs/superpowers/` — the legacy `docs/plans/` bucket was drained.

### docs/superpowers/plans — 7 rows

**Inherited legacy (drained):**
- `docs/superpowers/plans/2026-04-05-phase4-realtime-performance.md` — authored `unknown` with stalled-at-draft note
- `docs/superpowers/plans/2026-04-05-phase5-analytics-observability.md` — same

**No authored status yet:**
- `docs/superpowers/plans/2026-04-04-colony-orchestration-phase1.md`
- `docs/superpowers/plans/2026-04-05-phase4-m2-websocket-console.md`
- `docs/superpowers/plans/2026-04-06-scheduled-groups-tabs.md`
- `docs/superpowers/plans/2026-04-07-anti-echo-session-controls.md`
- `docs/superpowers/plans/2026-04-22-mw-bot-group-protection.md`

### docs/superpowers/specs — 4 rows

- `docs/superpowers/specs/2026-04-04-colony-orchestration-design.md`
- `docs/superpowers/specs/2026-04-06-scheduled-groups-tabs-design.md`
- `docs/superpowers/specs/2026-04-07-anti-echo-session-controls-design.md`
- `docs/superpowers/specs/2026-04-07-provider-attribution.md`

### docs/superpowers/reviews — 1 row

- `docs/superpowers/reviews/2026-04-07-anti-echo-review-handoff.md`

### Triage heuristics for the next pass (non-prescriptive)

- **phase4-realtime-performance / phase5-analytics-observability** (drained legacy plans): review whether any portion of this work became part of a later SDLC epic. If yes, mark superseded-by that epic. If not, leave as explicit `unknown`.
- **colony-orchestration plan + spec**: cluster decision — was this implemented or abandoned? No matching SDLC epic exists.
- **phase4-m2-websocket-console**: predates fleet-charts; likely superseded by later console work. Needs an author to confirm.
- **mw-bot-group-protection** (dated 2026-04-22): recent; check whether it became an SDLC epic or remains in flight.
- **scheduled-groups-tabs** (plan + spec): cluster decision — was this implemented? If yes, which epic?
- **anti-echo-session-controls** (plan + spec in the cross-tree cluster; plus a separate review-handoff row): was this implemented? If yes, which epic? The review-handoff row, though not in the cluster, belongs to the same topic and should be triaged together.
- **provider-attribution spec**: single spec, no plan, no cluster. Needs author confirmation of implementation or abandonment.

---

## Generation metadata

- Derived from `docs/work-index.json` (`schema_version: 5`, `git_head` = current HEAD at regen time; see the `git_head_note` field for timing caveats)
- No scanner changes were made to produce this refresh (the underlying index content comes from the post-step-4 regen)
- All counts in this doc are mechanical reads of the index
- Where the index lacks data (supersession, runtime relevance), this doc says `unknown`
