# reliability: persist minimal working-set receipts across reset and handoff

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
| DPR ID | DPR-02 |
| OPP mapping | OPP-02 |
| Tier | A |
| Adjudication verdict | admit_to_specification |
| Evidence class | One direct message-level episode plus cross-source empty-handoff context |
| Provenance | Missed-affordance mining admission, with marked QPI-derived amendments |
| Pinned live-main SHA | c9759467d297787f2e0eb2739bd6cd38ea09145c |
| Status | draft PR — specification only; owner review required before implementation |

## Problem and evidence boundary

A reset can preserve the conversation while losing the bot’s working set: the selected source locator, version, unresolved clauses, proof state, and exact next step. The admitted episode required reconstruction of a previously discovered locator; the finding supports durable working-set continuity but does not prove a particular storage mechanism. [mining run (operator-local): evidence/cross-source-opportunity-frontier.json::/admitted_user_facing_opportunities/1] [mining run (operator-local): private/source-12-lead-adjudication.json::/admitted_opportunities/0/private_evidence/0]

The mining review found one `continuity_context_repayment` candidate across 16,745 conversational messages; that is detector recall and a review-queue count, not prevalence. Empty structured memory or handoff tables are supporting context only and never prove that continuity was absent. [mining run (operator-local): state/coverage-ledger.json::/candidate_counts/continuity_context_repayment] [mining run (operator-local): state/coverage-ledger.json::/message_count] [mining run (operator-local): evidence/detector-controls.json::/detectors/1/known_failure_modes]

Each of the ten conversational-source summary artifacts records `agent_handoff_artifacts: 0`; the frontier correctly narrows this to “one direct episode plus cross-source empty-handoff context.” The zero counts must not be promoted into ten failures. [mining run (operator-local): evidence/source-01-missed-affordance-summary.json::/available_surface_counts/agent_handoff_artifacts] [mining run (operator-local): evidence/source-02-missed-affordance-summary.json::/available_surface_counts/agent_handoff_artifacts] [mining run (operator-local): evidence/source-03-missed-affordance-summary.json::/available_surface_counts/agent_handoff_artifacts] [mining run (operator-local): evidence/source-04-missed-affordance-summary.json::/available_surface_counts/agent_handoff_artifacts] [mining run (operator-local): evidence/source-07-missed-affordance-summary.json::/available_surface_counts/agent_handoff_artifacts] [mining run (operator-local): evidence/source-08-missed-affordance-summary.json::/available_surface_counts/agent_handoff_artifacts] [mining run (operator-local): evidence/source-09-missed-affordance-summary.json::/available_surface_counts/agent_handoff_artifacts] [mining run (operator-local): evidence/source-10-missed-affordance-summary.json::/available_surface_counts/agent_handoff_artifacts] [mining run (operator-local): evidence/source-11-missed-affordance-summary.json::/available_surface_counts/agent_handoff_artifacts] [mining run (operator-local): evidence/source-12-missed-affordance-summary.json::/available_surface_counts/agent_handoff_artifacts]

The mining manifest records `new_pr_candidates: 0`; this is a derived local draft, not a mining-recommended PR, and it has not been posted. [mining run (operator-local): manifest.json::/result/new_pr_candidates]

## Systems, schemas, APIs, runtime paths, and docs touched

`src/runtimes/agent/handoff-artifact.ts` owns the verified `agent_handoff_artifacts` surface and `upsertHandoffArtifact`; its present conversation-keyed artifact is the nearest persistence owner. The handoff path also includes `src/runtimes/agent/handoff-prelude.ts`, `handoff-distiller.ts`, `handoff-distill-coordinator.ts`, and the PII redactor. [verified at pinned main c9759467d]

The proposal adds an obligation-scoped working-set receipt rather than overloading a conversation summary. Required fields are DPR-04’s canonical `obligation_id`, conversation key, source kind and locator, source version or content hash, constraints, unresolved clauses, proof state, checkpoint state, sensitivity class, freshness result, expiry, supersession, and timestamps.

The durable receipt must link to DPR-04’s message-to-tool-to-artifact-to-delivery graph. That design supplies one canonical `obligation_id` and its run/event identities, needed to distinguish a working-set checkpoint from a generic handoff summary, a tool log, or a delivered artifact.

Documentation must define receipt lifecycle, freshness validation, conflict handling, review and revoke controls, retention, resume behavior, orphan state, and the boundary between working-set metadata and document content.

## Proposed data and control flow

1. When work selects a material source or reaches a checkpoint, create or update a minimal receipt keyed by DPR-04’s canonical `obligation_id`; the receipt has no independent objective identifier and cannot change the obligation lifecycle.
2. Record the source locator and immutable version when available; otherwise record a content hash plus the exact scope used to compute it. Do not store the source body by default.
3. Record outstanding clauses, proof state, next safe action, and a monotonic checkpoint sequence. Each transition is append-only or versioned so a later handoff cannot erase earlier debt.
4. Before reuse, re-authorize the source, validate freshness, compare the version or hash, and surface conflicts. `fresh`, `changed`, `missing`, `unauthorized`, and `unknown` are distinct states.
5. At reset or handoff, construct a concise resume hint from validated fields only. The hint names the objective, last confirmed checkpoint, unresolved clauses, and required next verification; it does not reproduce source content.
6. Link completion, cancellation, expiry, and supersession back to the original objective so a stale receipt cannot reopen finished work.

Add content-hash step receipts for deterministic substeps: hash canonicalized step inputs, source version, relevant constraints, and tool configuration; bind the resulting terminal state and artifact reference to that hash. On retry, an exact hash match may resume from a verified checkpoint, while a mismatch requires recomputation or explicit supersession. [design relay 2026-07-28 (operator-local): cc-re-workflow.md#Borrowable Patterns]

Detect orphaned checkpoints where a started step has no terminal result after its lease or session ends. On resume, produce an explicit, editable hint that distinguishes safe retry, manual inspection, and terminal non-replayable work; never infer success from a start record. [design relay 2026-07-28 (operator-local): cc-re-workflow.md#7. Orphan recovery on session resume]

## Prerequisites and dependencies

DPR-02 hard-depends on DPR-04’s linkage design for canonical `obligation_id`, operation-to-artifact edges, delivery state, and supersession semantics. Its row has a foreign key to `work_obligations.obligation_id`; implementation may prototype the receipt payload, but the final schema and migration must not invent a competing identity or close an obligation from a receipt alone.

Owner decisions are required for locator allowlists, content-hash canonicalization, sensitivity classes, default expiry, source-specific authorization refresh, checkpoint lease duration, and which operations are safe to replay.

The mining detector remains a review aid, not an enforcement authority. All seven mining detector families are `enforcement_ready: false`, and the inherited advancement rule is: “No detector advances to enforcement until precision, recall, blind-review agreement, policy coverage, and known failure modes are documented on representative positive, negative, borderline, and false-positive samples.” [mining run (operator-local): evidence/detector-controls.json::/advancement_rule]

## Implementation slices and sequencing

1. Finalize DPR-04 objective, operation, artifact, and delivery identities.
2. Add the working-set receipt schema, typed lifecycle, and repository methods.
3. Emit receipts at source selection, material proof, unresolved-clause, and pre-handoff checkpoints.
4. Add freshness and authorization validation before rehydration.
5. Add content-hash step receipts, resumable checkpoint decisions, and explicit resume hints. [design relay 2026-07-28 (operator-local): cc-re-workflow.md#Borrowable Patterns]
6. Add orphan detection and idempotent safe-replay selection. [design relay 2026-07-28 (operator-local): cc-re-workflow.md#7. Orphan recovery on session resume]
7. Integrate handoff prelude and distillation as projections of the durable receipt rather than alternate stores.
8. Add review, revoke, expiry, observability, and operator documentation.

The first mergeable slice should write receipts without consuming them. Read-path activation follows only after freshness, authorization, and conflict tests pass.

## Security, privacy, authorization, and retention

Receipts store minimal locators and state, not document bodies, message excerpts, credentials, or unrestricted tool output. Every field has a sensitivity classification; high-risk locators are tokenized or replaced with an approved stable reference before persistence.

Read authorization is reevaluated at resume time. Possession of an old receipt does not grant access to a moved file, revoked account, changed workspace, or expired source. A receipt can say that prior proof existed without revealing the proof to a caller who no longer has access.

Content hashes are scoped evidence, not global identifiers. Canonicalization includes source version and objective scope, uses a versioned algorithm, and avoids hashing low-entropy secrets or sensitive raw content solely for deduplication. Hashes and locators expire with the receipt unless a stricter source policy applies.

Review, revoke, delete, expire, cancel, and supersede are first-class terminal actions. Audit projections contain objective and state identifiers but no source content.

## Migration and backward compatibility

Create a new additive receipt table or versioned record family; do not reinterpret existing conversation-keyed handoff artifacts as objective-scoped receipts. Existing artifacts may seed a `legacy_unverified` projection, but they cannot satisfy freshness, ownership, or completion requirements without new evidence.

During mixed-version rollout, old agents continue using the existing handoff prelude. New agents write receipts and may consume only schema versions they understand. Unknown fields are preserved, and unknown lifecycle states fail closed to `pending_review`.

No historical backfill runs by default. A future owner-authorized migration may construct receipts only from records that contain an unambiguous objective, locator, and source version; ambiguous records remain unconverted.

## Failure, recovery, and observability

Failure states include missing source, changed version, authorization loss, expired receipt, invalid hash, conflicting checkpoints, orphaned start, non-replayable operation, missing DPR-04 linkage, and persistence failure. None is silently downgraded to a blank resume.

Recovery first validates objective status. Completed, cancelled, expired, or superseded objectives do not resume. Pending objectives choose exactly one of: consume a fresh checkpoint, recompute a stale step, request bounded user input, mark owned terminal non-recovery, or remain visible debt.

An orphan sweep uses checkpoint lease, session termination, and terminal-operation evidence. It preserves the original started state, emits a recovery decision, and cannot recode the initial attempt as successful. [design relay 2026-07-28 (operator-local): cc-re-workflow.md#7. Orphan recovery on session resume]

Metrics report receipt writes, freshness outcomes, authorization failures, conflict counts, orphan ages, replay selections, expiry, revocation, and resume completion. They exclude source bodies and sensitive locators.

## Test matrix and acceptance criteria

- Restart after source discovery and after each checkpoint; the resumed objective retains the same approved locator, version or hash, unresolved clauses, and proof state.
- Change, move, delete, or revoke the source before resume; reuse is blocked and the conflict is explicit.
- Replay an exact content-hash step and verify idempotent reuse; change one canonical input and verify recomputation or supersession. [design relay 2026-07-28 (operator-local): cc-re-workflow.md#Borrowable Patterns]
- Terminate after `started` but before terminal persistence; orphan detection produces one bounded resume decision and never invents success. [design relay 2026-07-28 (operator-local): cc-re-workflow.md#7. Orphan recovery on session resume]
- Cancel, expire, revoke, and supersede receipts; none reopens the objective.
- Run privacy tests against receipts, logs, metrics, handoff prompts, and operator views.
- Include the false-positive control where a user says “already” or “again” without reconstructing lost context; no continuity failure is promoted. [mining run (operator-local): evidence/detector-controls.json::/detectors/1/false_positive_example]

Acceptance requires restart continuity for the approved minimal fields, freshness and authorization checks before reuse, explicit conflicts, no default content-body persistence, exactly-once objective closure through DPR-04, and no detector enforcement claim.

## Conflicts and overlap with existing issues and PRs (2026-07-28 survey)

#2121 is the closest owner for post-handoff conversation rehydration; DPR-02 extends that concern with objective-scoped working-set receipts rather than replacing its transport and model-pin work. [issue survey 2026-07-28: #2121]

#2401 addresses a mismatch between per-conversation handoff-distill recovery and asset-wide incident identity. DPR-02 must preserve that distinction and must not claim a conversation receipt closes an asset-wide incident. [issue survey 2026-07-28: #2401]

#2540 owns unprovable resume identities and rejection lifecycle. DPR-02 is separate: it persists and validates a task working set after a valid objective identity exists; it does not define the fleet-wide resume-identity lifecycle. [issue survey 2026-07-28: #2540]

#2279 is adjacent through durable background-work registration and delivery, while DPR-04 is the packet dependency that owns the general linkage graph. DPR-02 consumes those identities and does not duplicate their write path or delivery daemon. [issue survey 2026-07-28: #2279]

## Unresolved decisions, alternatives, and non-goals

Owner decisions are required for table ownership, locator tokenization, hash algorithm and canonicalization, checkpoint granularity, default expiry, cross-conversation scope, safe replay classes, operator review UX, and whether a receipt may reference an encrypted content cache.

Alternatives are conversation-summary-only persistence, which cannot prove source version or per-step state; full content snapshots, which create unnecessary privacy and staleness risk; and tool-log reconstruction, which lacks objective semantics and reliable artifact incorporation. The recommended design is a minimal typed receipt joined to DPR-04.

Non-goals are general long-term memory, copying document bodies, granting access from stale receipts, asset-wide incident identity, changing model selection, declaring every empty handoff table a defect, and treating checkpoint presence as objective completion.

## Rollout, feature flags, and rollback

Roll out in four phases: schema only, shadow receipt writes, read-only comparison against current handoff behavior, then opt-in resume consumption. Per-instance controls select write, validate, and consume independently.

Promotion requires zero unowned conflicts in canaries, freshness and authorization proof, idempotent hash behavior, orphan-recovery tests, privacy review, and DPR-04 identity compatibility.

Rollback disables new consumption first, then new writes. Existing receipts remain governed by expiry, revoke, delete, and supersession rules; rollback does not silently discard pending debt or reinterpret receipts as completed work.
