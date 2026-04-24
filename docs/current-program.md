# Current Program — WhatSoup

> Reader-facing synthesis of what is active, completed-and-still-relevant,
> legacy/historical, and what supersedes what. Derived mechanically from
> `docs/work-index.json` under the rules in `docs/canonical-status-policy.md`.
>
> Where the index does not carry enough authored data to answer a question,
> this doc says **unknown** rather than inferring.

**Generated from:** `docs/work-index.json` (schema v5, 171 rows, 0 inconsistencies)
**Policy:** [`docs/canonical-status-policy.md`](canonical-status-policy.md)
**Status distribution:** completed=104, pending=37, unknown=27, active=2, deferred=1

---

## 1. What is active now

Exactly one SDLC epic is genuinely active. State declared explicitly in its `state.md`.

| Epic | Status source | Notes |
|---|---|---|
| [`docs/sdlc/active/agent-layer-hardening-20260405/`](sdlc/active/agent-layer-hardening-20260405/) | `state-md-status` | Phase 6 hardening. 20 beads tracked in its Bead Manifest (SP1–SP12, SEC1–SEC5, CFG1–CFG3); remaining Synthesize-phase verification is the only open work. |

Its state.md and `evidence-reconnect.md` are the two index rows classified `active`. All 20 bead rows under it resolve individually via `bead-manifest` (most `completed`, some still-open tracked in that table).

---

## 2. Deferred (shelved, not finished, not superseded)

| Epic | Status source | Reason |
|---|---|---|
| [`docs/sdlc/closed/fleet-charts-20260407/`](sdlc/closed/fleet-charts-20260407/) | `state-md-status` | Phase 4-Execute was incomplete when the folder was moved to `closed/`. Beads B01–B11 remain unimplemented. Shelved by decision. |

Per the policy, this epic lives in `closed/` by directory placement but its state.md explicitly declares `**Status:** deferred`. Authored intent, not a mismatch.

---

## 3. Completed epics and their current relevance

16 SDLC epics are marked `completed`. "Still relevant" is a runtime judgment the index cannot make, so the table below gives:

- the authoritative status source
- any **pending beads** left behind in the epic (policy's mark-read-api-style mixed state — the scanner reports these honestly; they are source-tree truth, not bugs)
- the canonical path

Reader can decide relevance against live system behavior.

### Completed — no pending beads (11 epics)

| Epic | Path |
|---|---|
| add-line-wizard-20260401 | [`docs/sdlc/closed/add-line-wizard-20260401/`](sdlc/closed/add-line-wizard-20260401/) |
| control-plane-20260401 | [`docs/sdlc/closed/control-plane-20260401/`](sdlc/closed/control-plane-20260401/) |
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

These 37 pending beads are the primary candidate set for a future triage pass.

---

## 4. What supersedes what

Explicit supersession relationships captured in the index: **one** (via the policy-conformant `## Follow-on` pattern).

| Predecessor | Successor | Evidence |
|---|---|---|
| `whatsapp-mcp-features` | [`agent-layer-hardening-20260405`](sdlc/active/agent-layer-hardening-20260405/) | `## Follow-on` section in the predecessor's state.md |

For every other epic and every `docs/superpowers/*` artifact, **the supersession relation is unknown** — no structured `Supersedes:` or `Superseded by:` marker exists in the index. The `supersedes_hint` column in `docs/work-index.json` has zero populated rows.

Cross-tree topic clusters exist (`fleet-charts`, `anti-echo-session-controls`, `scheduled-groups-tabs`) but the index does not state which entry within each cluster supersedes another. Per policy these remain unknown until explicit markers are authored.

---

## 5. Legacy / historical only

Per the policy (§Directory Bucket Semantics), `docs/plans/` is the legacy plan bucket — entries there do not get an implied status.

| Path | Status | Notes |
|---|---|---|
| [`docs/plans/2026-04-05-phase4-realtime-performance.md`](plans/2026-04-05-phase4-realtime-performance.md) | unknown | No authored Status marker. Never became an SDLC epic. |
| [`docs/plans/2026-04-05-phase5-analytics-observability.md`](plans/2026-04-05-phase5-analytics-observability.md) | unknown | Same. |

Both are candidates for the step-4 "drain docs/plans/" pass.

The `docs/superpowers/*` trees are planning/design surfaces per policy — not authoritative execution truth by themselves. Status for every entry under `docs/superpowers/plans|specs|handoffs|reviews` is either inherited from a linked epic or remains `unknown`. See **Normalization backlog** below.

---

## 6. Unknown-status epics

One SDLC epic has an authoritative `state.md` but no authored Status value the scanner recognizes:

| Epic | Status source | Disposition |
|---|---|---|
| [`docs/sdlc/closed/dedup-consolidation-20260404/`](sdlc/closed/dedup-consolidation-20260404/) | `fallback` (no state.md Status field) | Classify needed. Per commit `cf0dbf3` this epic was closed alongside `multi-provider-runtime`, so the correct authored status is likely `completed`, but until a human confirms and updates the state.md the row stays unknown. |

---

## 7. Normalization backlog — 27 unknown rows for step 4

These rows are classified `unknown` by the scanner. Per the policy they stay unknown until explicitly normalized. Listed here as the clean input to step 4 (the "drain / author / triage" pass).

### docs/plans — 2 rows (drain target)

- `docs/plans/2026-04-05-phase4-realtime-performance.md`
- `docs/plans/2026-04-05-phase5-analytics-observability.md`

### docs/sdlc — 2 rows

- `docs/sdlc/closed/dedup-consolidation-20260404/state.md` — epic-level; see §6
- `docs/sdlc/completed/codex-transport-gaps-20260404/beads/B01-codex-token-tracking.md` — bead absent from parent's Bead Manifest; policy §orphan-bead rule says resolve via body-marker then directory then unknown, currently unknown

### docs/superpowers/plans — 11 rows

- `docs/superpowers/plans/2026-04-04-colony-orchestration-phase1.md`
- `docs/superpowers/plans/2026-04-05-phase4-m2-websocket-console.md`
- `docs/superpowers/plans/2026-04-05-sp1-media-access.md`
- `docs/superpowers/plans/2026-04-05-sp2-content-completeness.md`
- `docs/superpowers/plans/2026-04-05-sp3-search-enhancement.md`
- `docs/superpowers/plans/2026-04-05-sp4-two-way-voice.md`
- `docs/superpowers/plans/2026-04-06-scheduled-groups-tabs.md`
- `docs/superpowers/plans/2026-04-07-anti-echo-session-controls.md`
- `docs/superpowers/plans/2026-04-07-fleet-charts.md`
- `docs/superpowers/plans/2026-04-22-mw-bot-group-protection.md`
- `docs/superpowers/plans/2026-04-23-history-sync-fitness-cleanup.md`

### docs/superpowers/specs — 7 rows

- `docs/superpowers/specs/2026-04-04-colony-orchestration-design.md`
- `docs/superpowers/specs/2026-04-04-mcp-feature-gaps-design.md`
- `docs/superpowers/specs/2026-04-05-phase2-mcp-features-design.md`
- `docs/superpowers/specs/2026-04-06-scheduled-groups-tabs-design.md`
- `docs/superpowers/specs/2026-04-07-anti-echo-session-controls-design.md`
- `docs/superpowers/specs/2026-04-07-provider-attribution.md`
- `docs/superpowers/specs/2026-04-07-soup-kitchen-fleet-charts.md`

### docs/superpowers/handoffs — 4 rows

- `docs/superpowers/handoffs/2026-04-07-fleet-charts-guidelines.md`
- `docs/superpowers/handoffs/2026-04-07-fleet-charts-kickoff.md`
- `docs/superpowers/handoffs/2026-04-07-fleet-charts-project-statement.md`
- `docs/superpowers/handoffs/2026-04-07-fleet-charts-sop.md`

### docs/superpowers/reviews — 1 row

- `docs/superpowers/reviews/2026-04-07-anti-echo-review-handoff.md`

### Triage heuristics for step 4 (non-prescriptive)

- **docs/plans** entries: check whether their content was superseded by a subsequent SDLC epic or superpowers plan. If yes, mark superseded; if not, normalize to unknown with an explicit Status marker or remove.
- **docs/superpowers/plans**: each should either point at its implementing SDLC epic (in which case inherit status) or declare its own lifecycle marker.
- **docs/superpowers/specs**: same. Specs tied to a completed epic can be marked completed; specs never implemented should be marked deferred or superseded.
- **fleet-charts handoffs** (4 of the 11 handoffs/plans): all tied to the deferred `fleet-charts-20260407` epic. Cluster decision is whether to inherit the epic's `deferred` status or mark these as historical references.
- **anti-echo-session-controls** (plan + spec + review): cluster decision — was this implemented? If yes, which epic?
- **scheduled-groups-tabs** (plan + spec): same cluster question.

---

## Generation metadata

- Derived from `docs/work-index.json` (`schema_version: 5`, `git_head` matches current HEAD at generation time)
- No scanner changes, no path moves, no status rewrites performed to produce this document
- All counts in this doc are mechanical reads of the index
- Where the index lacks data (supersession, runtime relevance), this doc says `unknown`
