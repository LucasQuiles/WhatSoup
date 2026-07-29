# feat(agent): experiment with guarded proactive assistance

**Status:** DRAFT feature-request specification for owner review — documentation
only; no build authorization is claimed, and this pull request must not be
treated as queue-ready.
**Grounding:** operator-local sealed evidence run (2026-07-28); repository
claims re-verified at pinned `origin/main` `c9759467d`. Citation legend:
`[mining run (operator-local): …]` points into the sealed mining addendum
retained outside the repository (per-source filenames neutralized to
`source-NN`); `[verified at pinned main c9759467d]` marks path/symbol claims
re-verified at that commit; `[issue survey …: #N]` marks GET-only issue/PR
survey attribution; `[design relay 2026-07-28 (operator-local): …]` marks
attributed design-relay leads, advisory unless independently verified.


| Field | Value |
|---|---|
| DPR ID | DPR-06 |
| OPP mapping | OPP-06 |
| Tier | C |
| Adjudication verdict | `exploratory_not_enforcement_ready` |
| Evidence class | frontier-only; advisory-only worker evidence |
| Provenance | missed-affordance mining admission + attributed QPI amendment |
| Pinned live-main SHA | `c9759467d297787f2e0eb2739bd6cd38ea09145c` |
| Status | draft PR — specification only; owner review required before implementation |

## Problem and evidence boundary

There is no per-source admission or chat citation for this request. The evidence is an exploratory cross-source frontier plus advisory-only worker analysis, with medium evidence for possible value and low evidence for population rate; it does not authorize proactive mutation or enforcement. The mining run recorded `new_pr_candidates: 0`; this local draft does not alter that result. [mining run (operator-local): evidence/cross-source-opportunity-frontier.json::cross_cutting_design_opportunities[id=OPP-06]] [mining run (operator-local): workers/proactive-leverage-sanitized.md::Candidate opportunity classes] [mining run (operator-local): manifest.json::result.new_pr_candidates]

This draft proposes an opt-in experiment that may offer a reminder, resumable requirements summary, recurring-work template, or decision-ready synthesis. It does not perform the proposed action. No silent scheduling, memory persistence, or recurring automation is recommended.

## Systems, schemas, APIs, runtime paths, and docs touched

WhatSoup already ships scheduling and watch mechanisms: `registerSchedulingTools`, `schedule_message`, `MessageScheduler`, `enqueueScheduledMessage`, `registerSubstrateTools`, `create_watch`, and substrate trigger code. Those primitives establish possible execution paths, not user intent or authority for proactive use. [verified at pinned main c9759467d]

The top-level `advanced` configuration exists, but the verified `InstanceConfig` shape omits that block and `validateInstanceConfig` does not validate it. A new experiment flag therefore requires a typed instance-config field and validator update; a loose config read is not acceptable. [verified at pinned main c9759467d]

The existing fleet approval route is specialized for `AskUserQuestion`. Learning suggestions need a distinct typed proposal and decision record and must not silently reuse that queue as execution authority. [verified at pinned main c9759467d]

Implementation should add:

- `src/core/proactive-assistance.ts` for pure eligibility and suppression decisions.
- typed `ProactiveCue`, `Corroborator`, `OfferProposal`, `OfferDecision`, and `LearningSuggestion` contracts.
- a response-planning adapter that can render an offer but cannot execute it.
- configuration under a validated `InstanceConfig.advanced.proactiveAssistance`.
- bounded offer and decision events using DPR-04.
- DPR-05 capability resolution before any offer names an executable route.
- a design document defining signal freshness, suppression, consent, retention, and experiment metrics.

## Proposed data and control flow

An offer is eligible only under a two-signal trigger:

1. A current-turn cue explicitly indicates reminder intent, recurrence, resumability, correction of a repeatable step, or recommendation intent.
2. An independent durable/context corroborator supports the same scoped interpretation and is fresh under its source policy.

Both signals are typed, scoped to the current task, and independently attributable. One signal never triggers. Contradiction, staleness, low confidence, opt-out, sensitive context, quiet hours, or inability to establish the user-controlled target suppresses the offer.

The flow is:

1. Classify the current-turn cue and record its bounded reason code.
2. Retrieve only policy-allowed corroborators; do not persist new memory to manufacture a second signal.
3. Apply suppressions and cooldowns.
4. Resolve the proposed route through DPR-05; unavailable or unauthorized routes are omitted.
5. Produce one suggestion with scope, expected result, required approval, edit affordance, and expiry.
6. Record offered, accepted, declined, dismissed, expired, or contradicted using DPR-04.
7. After explicit acceptance, hand the user to the existing authorized action flow; acceptance is not execution.

Correction-to-skill learning is suggestion-only and approval-gated. The system may draft a terse generalized change with rationale and source pointers, but it may not edit memory, instructions, or a skill. An accepted suggestion enters a separately authorized review path; it does not mutate files or establish a recurring rule. This adapts the relay’s feedback-to-skill idea by adding an explicit proposal boundary. [design relay 2026-07-28 (operator-local): cc-re-memory.md#Feedback-to-skill-folding]

## Prerequisites and dependencies

DPR-04 is a hard dependency for durable offer, consent, handoff, and terminal-outcome receipts. DPR-05 is a hard dependency so offers name only routes currently proven available and authorized. DPR-02 is a soft dependency for resumable working-set summaries.

The experiment must define the user-visible consent language, opt-out persistence, sensitive-context taxonomy, corroborator freshness, quiet-hours source, and maximum offer frequency before runtime integration.

DPR-06 suggestion approval and DPR-08 diagnostic-execution approval are separate authority planes. Accepting a suggestion never grants permission to run a diagnostic, tool, schedule, watch, memory write, or recurring automation.

## Implementation slices and sequencing

1. Define types, two-signal eligibility, suppressions, and deterministic reason codes.
2. Add validated per-instance flags, allowlists, cooldowns, quiet hours, and kill switch.
3. Build offline fixtures for positive, negative, borderline, contradiction, and false-positive cases.
4. Run record-only evaluation with no user-visible offers.
5. Add DPR-05 route checks and DPR-04 event emission.
6. Enable suggestion-only rendering for an owner allowlist, one offer class at a time.
7. Add explicit accept/decline/dismiss handling; acceptance routes to existing authorized workflows.
8. Trial correction-to-skill proposals last, with a distinct review record and no direct mutation.

The first experiment should use one low-risk offer class, such as an optional decision-ready synthesis, rather than scheduling or durable learning. Recurring-work and resumable-interview offers require separate owner promotion decisions.

## Security, privacy, authorization, and retention

Signals and receipts store bounded classifications and opaque source pointers, not message bodies, transcripts, credentials, identities, provider-specific chat identifiers, or generated skill contents. Corroborator retrieval obeys the source’s access, consent, and retention policy.

The feature cannot create schedules, watches, tasks, memories, skill edits, or recurring rules. It cannot broaden identity, target, mutation class, or authorization when handing off an accepted suggestion. Existing tool and platform approvals remain mandatory.

Opt-out and decline state must take precedence over positive signals and be easy to inspect and revoke. Sensitive contexts are deny-by-default. Learning suggestions expire, are scoped to one project/process, and require human review for generalization, stale assumptions, secrets, and instruction conflicts.

## Migration and backward compatibility

Add a typed optional `advanced.proactiveAssistance` block to `InstanceConfig` and `validateInstanceConfig`, defaulting to disabled. Required fields are `enabled`, `mode`, offer-class allowlist, per-class cooldown, daily cap, quiet-hours policy, corroborator maximum age, and kill switch.

If durable proposal storage is approved, use additive versioned tables for `proactive_offer_evaluations` and `learning_suggestions`; otherwise use DPR-04 event records only. Older instances and configs remain disabled. Unknown modes or offer classes fail validation rather than silently enabling defaults.

No backfill creates prior consent, recurrence, or learning proposals. Historical records may be used only in offline evaluation under their existing policy.

## Failure, recovery, and observability

Missing DPR-04 or DPR-05 dependencies, config ambiguity, stale corroboration, timeout, contradictory signals, or uncertain consent suppresses the offer. The user’s requested response must continue without waiting for proactive evaluation.

Recovery may expire an offered suggestion but may not replay it automatically. Accepted suggestions without an authorized downstream action remain `accepted_pending_user_action`; they are not silently executed after restart.

Metrics should cover eligible/suppressed reason codes, offer/accept/decline/dismiss/expiry rates, route-check failures, contradiction and opt-out suppression, cooldown enforcement, and downstream user-initiated completion. Metrics are experiment observations, not service-quality or satisfaction labels.

## Test matrix and acceptance criteria

All seven mined detector families remain `enforcement_ready: false`. No detector advances to enforcement until precision, recall, blind-review agreement, policy coverage, and known failure modes are documented on representative positive, negative, borderline, and false-positive samples. [mining run (operator-local): evidence/detector-controls.json::detectors[*].enforcement_ready + advancement_rule]

| Case | Required proof |
|---|---|
| Two matching signals | exactly one suggestion is eligible within policy |
| Current-turn cue only | no offer |
| Durable/context signal only | no offer |
| Contradiction or stale corroborator | no offer and bounded suppression reason |
| Opt-out, quiet, or sensitive context | deny wins and no offer |
| Unavailable route | DPR-05 suppresses or narrows the suggestion; no capability promise |
| Accepted suggestion | handoff to an existing authorization flow; no direct action |
| Declined or dismissed suggestion | cooldown and opt-out semantics prevent repeated pressure |
| Restart after offer | no automatic replay or execution |
| Learning proposal | reviewable proposed diff and rationale exist; no file or memory mutation |
| False-positive recurrence | repeated words, timestamps, or administrative messages alone never trigger |
| Privacy | signal/event records contain no raw content or direct identity |

Acceptance for an experiment is deterministic two-signal behavior, zero silent mutations in fault-injection tests, validated default-off configuration, correct cooldown/opt-out precedence, and owner-readable experiment receipts. It is not detector enforcement or general availability.

## Conflicts and overlap with existing issues and PRs (2026-07-28 survey)

Issue #2554 owns a scheduler path that accepts unsupported transport work and retries it. DPR-06 must rely on DPR-05 to avoid offering that unavailable path, but it does not change scheduler transport behavior. [issue survey 2026-07-28: #2554]

Collision/disambiguation note: the source-11 mining packet used the token `OPP-04` for the different deferred label “Resumable requirements interviews.” That label is semantically folded into DPR-06 as one experimental offer class; it is not a second admission and does not change the frontier receipt-graph binding. [mining run (operator-local): private/source-11-lead-adjudication.json::deferred[id=OPP-04]]

This draft claims no external issue or PR as owner of the guarded decision layer. Scheduling, watch, memory, and approval mechanisms remain separate implementation surfaces, and conflict review must be refreshed before publication.

## Unresolved decisions, alternatives, and non-goals

Unresolved decisions are the first offer class, signal taxonomy, confidence representation, corroborator sources and freshness, opt-out scope, cooldowns, quiet hours, experiment cohort, and the review owner for learning suggestions.

An alternative is explicit-command-only assistance with no proactive offer. It remains the control condition. Another alternative is a one-signal classifier; it is rejected for this experiment because it cannot provide independent corroboration. Rule-based and model-assisted classifiers may both be tested offline, but neither receives mutation authority.

Non-goals are silent scheduling, watch creation, memory persistence, recurring automation, automatic skill edits, autonomous requirement resumption, execution approval, satisfaction inference, or enforcement from recurrence detectors.

## Rollout, feature flags, and rollback

Ship behind validated `advanced.proactiveAssistance.enabled=false`, `mode=record_only`, an instance allowlist, per-class flags, cooldowns, daily caps, quiet hours, and a fleet kill switch. No default-on behavior is permitted.

Rollout stages are offline fixtures, record-only evaluation, owner-internal suggestion-only trial, and narrowly allowlisted user trial. Each offer class advances separately after privacy review, detector controls, opt-out proof, and an explicit owner decision.

Rollback flips the kill switch, stops new evaluations, expires pending suggestions, and leaves accepted-but-unexecuted records inert. It must not delete user opt-outs or reinterpret prior acceptance as authorization for future automation.

## Current-main reconciliation — 2026-07-29

This amendment supersedes current-system instructions pinned to `c9759467d`.
Current main is `5398982e610bb948d671181a04856590c9f3f9e5`.

**Readiness:** `BLOCKED PRE-CODE`; experimental and hard-blocked on DPR-04 and
DPR-05 contracts.

### Not greenfield

Current owners already exist for:

- schedules and schedule admission;
- substrate triggers;
- durable background work, results, and delivery;
- question-approval rendering/routes;
- configuration validation;
- realtime/operator presentation.

The missing feature is only candidate → eligible offer → explicit consent
policy and experiment measurement.

### Consent is not execution authority

Use separate states:

`observed_candidate` → `offer_pending` → `accepted_pending_authorization` →
`action_admitted` → `acted`/`failed`, with independent
`declined`/`expired`/`revoked`.

Acceptance supplies user consent for one exact action/scope/version. DPR-05 and
the canonical scheduler/trigger/background owner separately verify authority
and admit execution. Acceptance alone must never call a tool, schedule, watch,
memory operation, host action, or platform mutation.

### Forbidden ownership

No proactive scheduler, trigger engine, work queue, silent learning,
cross-domain approval Boolean, raw transcript/profile store, or automatic rule
derived from a prior acceptance.

### Owner decisions

- first reversible, low-risk action;
- detector card, threshold, successful twins, and falsifiers;
- consent state machine/domain;
- offer/action identity, actor, scope, normalized digest, and single-use rule;
- TTL, cooldown, frequency cap, retention, opt-out, and revocation;
- experiment cohort, success/harm/stop metrics;
- existing owner that executes the selected action.

### First implementation-plan gate

First RED binding:

- File: `tests/core/proactive-assistance-policy.test.ts`
- Test: `never admits an accepted offer without an independent authorization decision`
- Command: `npm test -- tests/core/proactive-assistance-policy.test.ts -t "never admits an accepted offer without an independent authorization decision" --pool=forks`
- Expected RED reason: no approved offer/consent state machine or DPR-05
  authorization adapter exists.

Start with offline fixtures, then shadow candidate metrics, then offer-only
canary. Bind RED tests to approval, scheduler, substrate, and background-work
suites. Prove no action without consent plus independent authorization/admission,
no repeated offer after decline, no stale acceptance, no raw content, safe
restart, canonical work failure, delivery uncertainty, and feature-off rollback.

The PR must remain draft and use non-closing references.
