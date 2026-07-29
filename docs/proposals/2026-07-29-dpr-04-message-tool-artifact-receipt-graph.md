# feat(durability): specify message-to-tool-to-artifact receipt graph

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
| DPR ID | DPR-04 |
| OPP mapping | OPP-04 (frontier binding) |
| Tier | B |
| Adjudication verdict | `admit_as_enabling_specification` |
| Evidence class | frontier-only; advisory-only worker evidence |
| Provenance | missed-affordance mining admission + attributed QPI amendment |
| Pinned live-main SHA | `c9759467d297787f2e0eb2739bd6cd38ea09145c` |
| Status | draft PR — specification only; owner review required before implementation |

## Problem and evidence boundary

There is no per-source admission or chat citation for this request. The evidence is an admitted cross-source frontier plus advisory-only worker analysis, so it supports an enabling specification, not a claim that any named conversation failed or that the gap has a measured prevalence. The mining run recorded `new_pr_candidates: 0`; this local draft does not alter that result. [mining run (operator-local): evidence/cross-source-opportunity-frontier.json::cross_cutting_design_opportunities[id=OPP-04]] [mining run (operator-local): workers/action-artifact-sanitized.md::Episodes] [mining run (operator-local): manifest.json::result.new_pr_candidates]

WhatSoup already has durable action and delivery records. The verified gap is narrower: there is no generic, authoritative edge from an arbitrary tool call to the artifact it produced, the result incorporation that followed, the obligation it satisfied, and its terminal delivery proof. Existing `background_work`/`work_results` artifact and delivery linkage must be adapted, not described as absent. [verified at pinned main c9759467d]

“Receipt” is a homonym in this packet and must resolve to exactly one of five domains:

| Receipt domain | Meaning | Ownership |
|---|---|---|
| WhatsApp transport receipt | Provider-level message acknowledgement or delivery state | Existing transport code |
| Outbound-send receipt | Intent/outcome audit in `outbound_sends` | Existing outbound-send audit |
| Durability-plane receipt | `inbound_events`, `outbound_ops`, `tool_calls`, checkpoints, and recovery runs | Existing durability engine |
| Fleet runtime-proof receipt | Bounded evidence that a runtime operation was observed | Existing fleet/runtime diagnostics |
| Generation-exit receipt | Generation-scoped exit, pressure, cleanup, and attribution evidence | DPR-07 |

The graph in this draft reconciles those domains without merging their semantics or declaring one receipt sufficient for another.

## Systems, schemas, APIs, runtime paths, and docs touched

At pinned main, `MIGRATION_2` owns `inbound_events`, `outbound_ops`, `tool_calls`, `session_checkpoints`, and `recovery_runs`; `tool_calls.outbound_op_id` supplies one durability-plane link, but no generic artifact reference. Migration 22 and `createOutboundSendsWriter` own the separate `outbound_sends` ledger, including sends that do not traverse `outbound_ops`. [verified at pinned main c9759467d]

Migration 46 and `background-work-store.ts` already model `background_work`, `work_results.artifact_path`, `delivery_state`, and `delivery_dedupe_key`, including worker recovery and delivery. `agent_handoff_artifacts` is conversation-keyed continuity state, not generic tool-output lineage. [verified at pinned main c9759467d]

Implementation should touch:

- `src/core/database.ts` and a new additive migration for graph-owned tables and indexes.
- `src/core/background-work-store.ts` through an adapter that emits graph events from existing work/result transitions.
- `src/core/outbound-sends.ts` and durability write paths through explicit adapters; neither ledger becomes an alias for the other.
- the tool-call recording boundary and artifact-producing tool adapters, using stable references rather than raw payload copies.
- a new `src/core/receipt-graph.ts` service and typed contract module.
- `docs/durability.md` plus a new receipt-graph contract document defining joins, lifecycle states, retention, and recovery.

## Proposed data and control flow

Add four additive records:

| Record | Required fields | Purpose |
|---|---|---|
| `work_obligations` | `obligation_id`, origin event reference, scope reference, state, created/updated timestamps, schema version | Canonical identity and lifecycle owner for the user-visible work to be satisfied |
| `run_events` | canonical event envelope below | Append-only lifecycle evidence |
| `artifact_refs` | `artifact_id`, kind, opaque locator reference, optional digest, validation state, retention class, timestamps | Metadata-only identity for produced or reused artifacts |
| `causal_links` | source kind/id, relation, target kind/id, evidence class, timestamps, schema version | Typed graph edges without inferred joins |

The canonical event envelope is transport-neutral: `obligation_id`, `run_id`, `event_id`, `event_type`, `occurred_at`, `source`, `subject_ref`, `causation_id`, `correlation_id`, `proof_type`, `status`, `schema_version`, and bounded metadata. `obligation_id` is the only canonical objective/work identity: every run has a non-null foreign key to one obligation, and an obligation may own multiple runs until its lifecycle reaches satisfied, failed, superseded, or cancelled. Adapters may expose an `objective_id` compatibility alias only as an exact projection of `obligation_id`; they may not mint or persist a second identity. The obligation owner alone changes obligation lifecycle, while event writers append evidence and cannot close it independently.

The base vocabulary is `request.accepted`, `run.started`, `tool.invocation.started`, `tool.invocation.finished`, `artifact.produced`, `artifact.verified`, `delivery.intent`, `delivery.submitted`, `delivery.echoed`, `delivery.failed`, `objective.completed`, `objective.failed`, `objective.superseded`, and `repair.debt_recorded`. Registered extensions use the same dotted `domain.subject.transition` convention, declare an owning draft/schema and payload version, and cannot add graph edges implicitly. DPR-07 registers `generation.exit.observed`, `generation.cleanup.attempted`, `generation.cleanup.completed`, and `generation.terminal.classified`; those events carry generation evidence but do not change obligation lifecycle or the generic linkage schema. A typed, transport-neutral event stream separates lifecycle evidence from the adapter that renders or delivers it. [design relay 2026-07-28 (operator-local): oc-re-data-and-communication-layer.md#WhatSoup-native-requirements-derivation]

Allowed causal relations are initially `originated_from`, `attempted_by`, `produced_artifact`, `incorporated_result`, `satisfied_obligation`, `superseded_by`, `delivery_attempted_by`, and `delivered_by`. Writers may assert only edges they directly observe. Temporal proximity, matching text, or shared conversation identity never creates an authoritative edge.

The control flow is:

1. Accept a request and create or reuse an idempotent `work_obligation`.
2. Record run and tool lifecycle events with causation and correlation identifiers.
3. When a tool explicitly returns or persists an artifact, register an `artifact_ref` and `produced_artifact` edge.
4. Record `incorporated_result` only at the response/artifact assembly boundary that consumes the result.
5. Bridge delivery to `outbound_ops` or `outbound_sends` according to the actual send path, preserving the split.
6. Close the obligation only after its configured terminal proof is present; a successful tool call alone is not completion.

## Prerequisites and dependencies

DPR-04 is the shared contract provider. DPR-02 and DPR-06 are hard consumers: continuity receipts and proactive-offer outcomes must use the canonical `obligation_id` plus run/event identifiers defined here. DPR-05 and DPR-07 are soft consumers: capability-route decisions can emit route evidence, and DPR-07 can express generation-exit evidence through registered dotted extension events without extending the generic graph.

Before implementation, owners must decide the SSOT for ID generation, which existing writer owns transaction boundaries, and whether graph records share the primary database or a separately retained audit database. No consumer should independently mint a competing event vocabulary.

## Implementation slices and sequencing

1. Land contract types, lifecycle vocabulary, schema versioning, and migration tests with no runtime writers.
2. Add the `ReceiptGraphWriter` with idempotent inserts, typed edges, and bounded metadata validation.
3. Adapt `background_work`/`work_results` first as the successful existing artifact/delivery twin.
4. Instrument generic tool-call start/finish and explicit artifact-producing adapters.
5. Bridge both delivery lanes: durability `outbound_ops` and the separate `outbound_sends` ledger.
6. Add incorporation and obligation-terminal writers at response assembly and delivery reconciliation boundaries.
7. Expose read-only lookup by obligation, run, tool call, artifact, and delivery reference.
8. Enable shadow comparison, repair tooling, and retention enforcement before any completion gate consumes the graph.

Each slice must be independently reversible. Schema landing does not authorize completion enforcement; writer coverage must be measured before readers treat missing edges as evidence.

## Security, privacy, authorization, and retention

Graph rows are metadata receipts, not a second transcript or tool log. They must not persist raw message bodies, raw tool arguments/results, artifact bodies, credentials, identities, phone-like identifiers, or provider-specific chat identifiers. Opaque scoped references, bounded classifications, and keyed digests are preferred; even hashes require a documented threat model because low-entropy inputs can be recoverable.

Read APIs must enforce the same instance, conversation, and operator authorization as the referenced records. Cross-instance joins are denied by default. Artifact access is checked at dereference time; possession of an `artifact_id` is not authorization to read the artifact.

Every record carries a retention class. Deletion must support tombstoning an edge while preserving a non-sensitive statement that proof was removed, and retention jobs must remove orphaned locators and digests consistently. Security logging should report record type, state, and error taxonomy only.

## Migration and backward compatibility

Use additive tables, nullable foreign references, and versioned enums. Existing durability, background-work, and outbound-send writers remain authoritative during shadow mode; adapters dual-write graph evidence after their existing transaction succeeds.

Backfill only mechanically provable links: explicit `tool_calls.outbound_op_id`, existing `work_results` ownership, and exact delivery identifiers. Do not infer links from timestamps, text similarity, or conversation adjacency. Backfilled records must carry `proof_type=backfill_explicit_join` and the source schema version.

Older binaries may ignore the new tables. New readers must tolerate unknown event types and absent optional links. Rollback disables readers and dual writers before any table removal; additive tables remain for the retention window unless the owner authorizes a separate destructive migration.

## Failure, recovery, and observability

All writes are idempotent on stable identifiers. Duplicate events become no-ops only when their immutable fields match; conflicting reuse is a typed integrity error. Partial graph writes leave the obligation `open` or `proof_incomplete`, never `completed`.

Recovery reconciles graph state from authoritative source records, marks unprovable gaps as `unknown`, and emits bounded `repair.debt_recorded` events. It must distinguish “not observed,” “not applicable,” “retained source unavailable,” and “contradictory proof.” A missing immediate receipt cannot establish abandonment because later delivery may close the obligation. [mining run (operator-local): evidence/detector-controls.json::detectors[family=action_artifact_frontier]]

Metrics should cover writer success/failure by event type, obligations by terminal state, unlinked successful tool calls, artifacts lacking validation, delivery bridges by lane, reconciliation debt, duplicate/conflict counts, and retention deletions. Alerts must use bounded identifiers and the shared failure taxonomy.

## Test matrix and acceptance criteria

| Case | Required proof |
|---|---|
| Generic artifact success | origin → obligation → tool attempt → produced artifact → incorporation → delivery → terminal state is queryable |
| Tool success without incorporation | tool is successful, obligation remains visibly incomplete |
| Existing background work | `work_results` artifact and delivery transitions adapt without duplicate ownership |
| Split outbound lanes | equivalent sends through `outbound_ops` and `outbound_sends` preserve distinct ledgers and bridge correctly |
| Late delivery | later delivery closes the same obligation without a duplicate failure or duplicate send |
| Crash boundaries | restart after every write boundary yields idempotent reconciliation and no false completion |
| False join controls | nearby calls, similar filenames, and same-conversation events never create an edge |
| Privacy and authorization | raw payload attempts are rejected; cross-instance and unauthorized dereference fail closed |
| Migration | clean install, upgrade, downgrade-compatible reader behavior, explicit-only backfill, and retention cleanup pass |
| Vocabulary compatibility | unknown future event types are retained or ignored safely according to reader role |

Acceptance requires stable query results across restart, zero inferred causal edges in the false-join corpus, and proof that a successful tool result which is never incorporated cannot close an obligation.

## Conflicts and overlap with existing issues and PRs (2026-07-28 survey)

Issue #2279 owns wiring and delivery for durable background work. DPR-04 must reuse its result/delivery graph as an adapter target and must not reimplement its worker lease, orphan recovery, or delivery daemon. [issue survey 2026-07-28: #2279]

Issue #2462 owns durable separation of health-probe execution from health verdict. Its receipt distinction is compatible with the generic vocabulary, but health semantics remain in that issue. [issue survey 2026-07-28: #2462]

Issue #2561 owns bounded tool failure taxonomy and raw input/result persistence risk. DPR-04 consumes that taxonomy and reduces new graph rows to metadata; it does not supersede the issue’s storage hardening. [issue survey 2026-07-28: #2561]

Issue #2189 concerns provider read-receipt subscriptions. That transport receipt is the first homonym domain, not the message-to-action-to-artifact graph proposed here. [issue survey 2026-07-28: #2189]

Conflict review is bounded to the dated entries cited above and must be refreshed before publication.

Coordination update (2026-07-29): draft PR #2615 (persist metadata-only tool and send evidence) is now in flight against #2561/#2562; this specification's tool-call taxonomy and artifact-lineage additions must stack on its landed schema rather than re-defining it. [issue survey 2026-07-29: #2615]

## Unresolved decisions, alternatives, and non-goals

Unresolved decisions are whether graph tables share source transactions, whether artifact digests are safe enough for the intended retention class, how an obligation is split or merged, and which terminal proof each request class requires.

Alternatives are an append-only event log with materialized views, normalized graph tables, or a hybrid. The implementation should choose after measuring query and recovery needs; the envelope and edge semantics remain stable across storage choices.

Non-goals are storing content, inferring causal linkage, replacing provider receipts, replacing durability or background-work ledgers, redefining delivery success, evaluating generation pressure, or declaring user-visible failure prevalence.

## Rollout, feature flags, and rollback

Ship behind `advanced.receiptGraph.enabled`, default `false`, with separately controlled `dualWrite`, `readApi`, and `completionGate` flags. Add the typed configuration to `InstanceConfig` and its validator; reject unknown or malformed values.

Roll out in schema-only, shadow-write, shadow-read, and opt-in completion-gate stages. Promotion requires writer coverage and reconciliation-debt thresholds agreed by owners, privacy review, retention proof, and restart fault-injection results.

Rollback order is completion consumers, read APIs, adapters, then writers. Existing ledgers remain authoritative throughout; rollback must never delete their records or reinterpret a missing graph edge as a failed action.
