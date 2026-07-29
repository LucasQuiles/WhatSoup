# reliability: attribute agent-generation terminations with durable exit and pressure receipts

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
| DPR ID | DPR-07 |
| OPP mapping | none — QPI expansion (owner directive 2026-07-28, option 1) |
| Tier | n/a — not mining-adjudicated |
| Adjudication verdict | n/a — no mining adjudication; owner directive option 1 |
| Evidence class | QPI relay 2026-07-28 + this-session verification + supporting mining pointer: oom_assessment |
| Provenance | QPI parity relay + this-session verification |
| Pinned live-main SHA | c9759467d297787f2e0eb2739bd6cd38ea09145c |
| Status | draft PR — specification only; owner review required before implementation |

## Problem and evidence boundary

The retained mining evidence does not confirm OOM. Its exact status is `not_confirmed_and_not_supported_by_retained_evidence`; supported alternatives are application-watchdog termination, provider timeout or stall, and managed-provider termination. The exact interrupted local session PID and exit reason were not retained, so the local cause remains unknown. This draft treats that uncertainty as the motivating evidence gap, never as evidence that an OOM occurred. [mining run (operator-local): evidence/final-lead-gate.json::.oom_assessment]

Pinned main contains process-tree cleanup outcomes, tree-liveness assessment, a bounded session-termination reason type, and an in-process memory sample. These are useful transient inputs, but the packet verification found no single durable, generation-scoped receipt that survives restart and binds terminal cause, resource evidence, cleanup outcome, and evidence quality. [verified at pinned main c9759467d]

The QPI material contributes process-tree termination and bounded telemetry patterns as advisory design leads. Its worker outputs did not satisfy their exact result contracts, so this request promotes only requirements independently grounded in pinned-main paths, symbols, the dated survey, or the mining boundary above. [design relay 2026-07-28 (operator-local): cc-re-borrow-adapt-reject-matrix.md#9-process-tree-kill-with-grace-period-adapt]

The requested capability is a durable terminal-evidence contract. It must distinguish transient sampling or log telemetry from a committed generation receipt, and it must distinguish an observed signal from a proven cause. `SIGKILL`, exit code 137, a high memory sample, or a missing child is never sufficient by itself to classify OOM.

## Systems, schemas, APIs, runtime paths, and docs touched

- `src/runtimes/agent/session.ts` owns generation lifecycle and the verified `SessionTerminationReason`; it should emit terminal observations without deciding unsupported causes. [verified at pinned main c9759467d]
- `src/runtimes/agent/process-tree.ts` and `src/runtimes/agent/tree-liveness.ts` supply cleanup and liveness evidence through verified `KillSessionOutcome`, `killSessionTree`, and `assessTreeLiveness` symbols. [verified at pinned main c9759467d]
- `src/runtimes/agent/runtime.ts` already samples `process.memoryUsage`; the new design must bound and normalize such samples before any durable projection. [verified at pinned main c9759467d]
- `src/core/database.ts`, `src/core/durability.ts`, and `docs/durability.md` are the schema, store, retention, and recovery documentation surfaces for a new generation-receipt owner. [verified at pinned main c9759467d]
- `src/core/health.ts`, `src/fleet/health-poller.ts`, and the console agent panels are projection surfaces for aggregate evidence coverage and terminal classification, not raw process telemetry. [verified at pinned main c9759467d]
- Platform adapters belong behind `src/fleet/platform.ts`: Linux may collect cgroup or systemd evidence, while unsupported platforms must emit `evidence_unavailable` rather than silently weakening the classifier. [verified at pinned main c9759467d]

Add a versioned `generation_exit_receipts` record, or an equivalent durability-plane owner, keyed by an opaque generation identifier and immutable terminal-attempt identifier. Required fields are lifecycle state, observed exit code and signal, intentional-kill reason, cleanup disposition, bounded resource summary, platform-evidence class, cause classification, evidence coverage, observation times, and receipt version.

Public and fleet APIs expose only bounded classes, age buckets, counts, and opaque correlation. Detailed platform evidence remains local, access-controlled, size-bounded, and separately retained.

## Proposed data and control flow

1. On generation start, allocate an opaque generation key and terminal-attempt key. Record no command line, working directory, account, conversation content, or environment.
2. Collect bounded in-memory samples under an explicit cadence and sample budget. Samples are provisional telemetry, not durable cause claims.
3. When the provider exits or termination begins, capture independent observations: exit code, signal, requested stop reason, watchdog state, last bounded resource sample, platform evidence availability, tree-liveness result, and cleanup outcome.
4. Normalize those observations into DPR-04’s registered dotted extension vocabulary: `generation.exit.observed`, `generation.cleanup.attempted`, `generation.cleanup.completed`, and `generation.terminal.classified`. DPR-07 owns and versions the evidence payload; it does not change obligation lifecycle or add message, tool, artifact, or delivery edges to DPR-04’s linkage graph.
5. Classify cause as `confirmed`, `supported`, or `unknown`, with a separate bounded reason such as `intentional_stop`, `provider_exit`, `watchdog_timeout`, `resource_pressure`, `oom`, or `unclassified`. `oom/confirmed` requires authoritative platform evidence tied to the same generation and observation window. `oom/supported` requires declared corroborating signals but remains weaker than confirmation. Otherwise the result is `unknown`.
6. Commit one idempotent terminal receipt before emitting health or console projections. Duplicate exit handlers merge observations under the same terminal-attempt key; contradictory terminal facts fail closed to `unknown` with `partial` evidence coverage.
7. Reconcile interrupted terminal attempts at startup. A missing final receipt becomes `terminal_outcome_unknown`; reconciliation must not invent an exit signal or promote the last sample into a cause.

Transient telemetry may be dropped according to its sampling budget. The terminal receipt is durable, restart-surviving evidence and must record whether its inputs were `complete`, `partial`, `platform_unavailable`, `telemetry_write_failed`, or `legacy_unclassified`.

## Prerequisites and dependencies

DPR-04 is a soft dependency for the event names and receipt envelope. DPR-07 may land independently if it locally versions the same vocabulary and later adopts DPR-04 without changing its generation-evidence ownership.

Issue #1869 owns cgroup-aware reclamation of detached processes; DPR-07 records ownership divergence and cleanup results but does not replace that reaper fix. Issue #2223 owns the shared process-census implementation; if it lands first, DPR-07 should consume that leaf utility rather than add a third census parser. [issue survey 2026-07-28: #1869] [issue survey 2026-07-28: #2223]

Issues #2279 and #2561 provide adjacent durable-work and bounded-failure contracts. DPR-07 may reuse their receipt and taxonomy conventions, but generation termination is neither a background-work delivery state nor a tool-call outcome. [issue survey 2026-07-28: #2279] [issue survey 2026-07-28: #2561]

Schema work must reserve the then-current migration and document retention, reconciliation, and API compatibility before runtime writers are enabled.

## Implementation slices and sequencing

1. Define the versioned receipt schema, cause/evidence taxonomy, transition validator, retention policy, and opaque projection.
2. Add a pure classifier that consumes synthetic observations and returns `confirmed`, `supported`, or `unknown` without reading logs or free-form error text.
3. Add platform adapters behind one interface. Linux adapters may read bounded cgroup/systemd evidence; other adapters explicitly return `evidence_unavailable`.
4. Wire generation start, natural exit, requested termination, watchdog termination, cleanup, and startup reconciliation into the store with one idempotency key per terminal attempt.
5. Add aggregate health/API fields: recent terminal counts by bounded class, unknown-cause count, partial-evidence count, oldest unreconciled attempt age bucket, and receipt-writer health.
6. Add an authorized console projection that can navigate from an opaque generation to the bounded receipt without exposing raw process or platform data.
7. Add documentation, retention jobs, migration tests, crash tests, and drift guards requiring every cause class to declare evidence requirements and projection behavior.

Each slice must preserve the invariant that existing runtime behavior continues if receipt persistence fails; the failure becomes an explicit evidence-loss signal rather than changing the provider exit result.

## Security, privacy, authorization, and retention

Durable fields are allowlisted and metadata-only. Do not persist command lines, arguments, environment values, absolute paths, process-owner names, service or host labels, raw cgroup contents, journal text, stack traces, message content, or provider output.

Use opaque, domain-separated correlation identifiers where cross-surface navigation is required. Public health is aggregate-only; generation-level detail requires the existing operator authorization boundary. Export and alert paths must reject unknown fields and free-form strings.

Resource samples are bounded by cadence, duration, and cardinality. Persist the terminal summary rather than the raw time series unless a separately approved private forensic policy defines encryption, access, size, and expiry.

Receipt retention must be finite and coupled to the generation/session retention owner. Expiry deletes local detailed evidence before or with its opaque receipt; aggregate counters must not become an unbounded historical identity ledger.

## Migration and backward compatibility

Allocate a new migration at implementation time. Existing sessions and historical logs are not backfilled into strong cause classes; legacy terminal records become `legacy_unclassified` or remain absent.

Writers initially dual-run in observation mode while existing exit handling remains authoritative. Readers tolerate no receipt, an older receipt version, partial evidence, and unsupported-platform evidence without rendering those states as healthy or confirmed.

The new API fields are additive and versioned. Old clients continue to receive their existing health/session shape. New clients must treat missing receipt support as `not_observed`, not as a clean exit.

Rollback disables new sampling and writers while preserving already-written receipts for their declared retention window. A down migration must not rewrite historical unknown causes into stronger classifications.

## Failure, recovery, and observability

- Receipt-store failure does not block cleanup or alter the process outcome; it increments a bounded `terminal_receipt_write_failed` signal and leaves the terminal attempt reconcilable.
- Crash after exit observation but before classification leaves a durable incomplete attempt; startup reconciliation finalizes it as observed facts plus `unknown`, never by parsing logs.
- Duplicate natural-exit and kill-path callbacks converge under one idempotency key. Conflicting signal, exit-code, or generation facts produce `partial/unknown` and a bounded contradiction counter.
- Missing or stale resource samples are ordinary evidence gaps. They cannot be represented as zero pressure.
- Unsupported platform adapters emit `platform_unavailable`; adapter exceptions emit `platform_probe_failed`. Neither is OOM evidence.
- Cleanup outcome is independent from cause. A successfully reaped tree does not prove why the generation ended, and a cleanup failure does not prove resource exhaustion.

Issue #2475 demonstrates the adjacent false-success shape: command exit zero is not equivalent to verified recovery. DPR-07 applies the same separation to process exit, cleanup, and terminal cause. [issue survey 2026-07-28: #2475]

Issue #2355 owns bounded lifecycle-related alert-suppression episodes. DPR-07 supplies stable terminal evidence that consumers may reference; it does not create per-sample or per-poll logs. [issue survey 2026-07-28: #2355]

## Test matrix and acceptance criteria

- Natural exit, requested stop, watchdog stop, provider timeout, signal-only exit, cleanup failure, and missing-child cases each produce one durable receipt with the expected independent observation fields.
- `SIGKILL` alone, exit code 137 alone, a high memory sample alone, and a process missing from a census all classify OOM as `unknown`.
- Authoritative same-generation platform evidence can produce `oom/confirmed`; declared corroborating but non-authoritative evidence can produce only `oom/supported`.
- Linux cgroup/systemd evidence is bounded and generation-correlated. Non-Linux fixtures return `platform_unavailable` without failing the runtime.
- Fault injection before and after every persistence transition survives restart and converges to one receipt or an explicit evidence-loss state.
- Duplicate and reordered callbacks are idempotent. Contradictory observations fail closed.
- Resource-sample cadence, retained byte count, and receipt cardinality remain within configured bounds under a long-running synthetic generation.
- Projection tests place reserved opaque markers in commands, paths, environment, journal text, provider output, and identifiers and prove those bytes do not enter the database, health API, console payload, logs, or alerts.
- Retention removes expired detailed receipts and leaves no orphaned generation correlations.
- Existing cleanup, session, and health behavior remains unchanged when the feature flag is off or the receipt store is unavailable.

Acceptance requires deterministic classification fixtures, restart-survival tests, platform-negative tests, exact-byte privacy tests, and a cross-contract guard that rejects an undeclared cause, evidence, or cleanup class.

## Conflicts and overlap with existing issues and PRs (2026-07-28 survey)

Issue #1869 is the strongest functional neighbor: it owns PPID-versus-cgroup reclamation and the detached-process leak. DPR-07 owns durable attribution and must not claim that recording the divergence repairs it. [issue survey 2026-07-28: #1869]

Issue #2223 owns deduplication of the two `ps` census implementations. DPR-07 should consume its shared parser if available and must not add another process-table parser. [issue survey 2026-07-28: #2223]

Issue #2279 owns durable background-work registration, leases, orphan delivery, and restart survival. DPR-07 may correlate a generation receipt to background work through DPR-04 vocabulary but does not change work delivery or adoption policy. [issue survey 2026-07-28: #2279]

Issue #2561 owns metadata-only tool-call outcomes and the bounded tool failure taxonomy. DPR-07 needs compatible names for `resource_exhausted` and evidence coverage without turning generation exits into tool results. [issue survey 2026-07-28: #2561]

Issue #2475 separates command success from verified recovery; issue #2355 bounds lifecycle-related alert diagnostics. Both are coordination precedents, not owners of generation exit evidence. [issue survey 2026-07-28: #2475] [issue survey 2026-07-28: #2355]

Coordination update (2026-07-29): draft PR #2639 (prove durable writer and lifecycle outcomes, #2485) is in flight in the adjacent BOT ERRORS durability plane; exit and pressure receipts must reuse its outcome vocabulary where the planes meet rather than minting a parallel one. [issue survey 2026-07-29: #2639]

## Unresolved decisions, alternatives, and non-goals

Owner review must choose the default sample cadence and byte budget, terminal-receipt retention, the authoritative Linux evidence set, whether supported OOM is operator-visible or diagnostic-only, and the minimum platform adapter required for first rollout.

Alternatives include persisting only one terminal snapshot, retaining a short bounded ring plus terminal summary, or keeping all resource sampling transient and persisting only platform proof. The recommended minimum is transient bounded sampling plus one durable terminal summary because it limits privacy and retention cost while preserving causal evidence.

Non-goals are cgroup reaper repair, a general process inventory, raw journal capture, arbitrary operator process inspection, background-work delivery, tool-result taxonomy ownership, automatic restart policy, or historical cause reconstruction from logs.

The classifier must never promise that every exit has a knowable cause. `unknown` is a successful evidence outcome when the required proof was not retained.

## Rollout, feature flags, and rollback

Add a validated per-instance advanced flag with separate controls for `observe`, `persist`, and authorized projection. Unknown or malformed values fail closed to disabled.

Stage 1 records only bounded classifier comparisons in private test telemetry. Stage 2 persists receipts without alerting. Stage 3 enables aggregate health and console projection after unknown-rate, write-loss, duplicate, retention, and privacy canaries pass.

Roll back by disabling sampling and new receipt writes. Existing cleanup and session behavior remain active; retained receipts age out normally. Do not delete receipts merely to hide an elevated unknown or failure rate.

Promotion requires stable write success, bounded storage, deterministic crash recovery, zero reserved-marker leakage, and owner acceptance of the cause/evidence vocabulary. The feature remains local and advisory until separately approved for implementation and publication.
