# Recovery-Blocked Follower Lifecycle Design

**Issue:** #3295

**Status:** active — architecture approved; implementation remains gated on written-spec review

**Canonical design baseline:** `575a690a7f9bcf2c86e598e6bd288476deb1bdfc`

**Related merged PR:** #3259 (`93cd46be1`), reply-recovery debt observer — MERGED 2026-08-16; it is the established owner of fleet-side recovery-debt observation, no longer a pending dependency.

## Goal

Prevent a transient same-scope recovery owner from turning already-journaled
AgentRuntime followers into terminally failed, user-resend-only work. A blocked
follower must retain a durable, ordered owner, resume automatically when it is
provably safe, and never advance resumable session identity before a real
provider-dispatched turn completes.

This design preserves the existing fail-closed replay rule: WhatSoup may
automatically invoke a provider only when durable state proves the original
turn never received provider, tool, or outbound execution authority. Ambiguous
work remains held for operator review.

## Incident Evidence

A managed per-chat AgentRuntime remained responsive for new traffic after a
short recovery interval, but multiple journaled followers arriving while the
prior turn's recovery owner was `claimed` were terminalized before provider
dispatch. Recovery then cleared, leaving no active owner for the missed
followers. Operational health returned healthy while unresolved reply debt
remained. The session checkpoint's completed inbound identity named one of the
undispatched rejected followers.

The repository record is deliberately metadata-only. It contains no message
content, participant or conversation identity, host name, durable row ID,
database path, provider output, or raw exception.

## Current Behavior and Proven Gaps

At the canonical design baseline:

1. `RuntimeTurnCoordinator.beginRuntimeTurnEvidence()` asks
   `hasOutstandingTurnRecoveryForScope()` whether the scope has pending,
   claimed, or orphaned recovery ownership. A positive result throws before
   `queue.beginTurnEvidence()`.
2. `TurnQueue.drain()` treats a processor throw as a failure requiring
   finalization, then advances the FIFO after the failure finalizer returns.
3. The recovery-supervisor tests explicitly require a different same-scope
   follower to be rejected while recovery is outstanding. The exact recovery
   job's own replay may bypass only itself through `excludeJobId`; any other
   blocker still rejects.
4. Undispatched admission rejection becomes `failed_terminal`, creates no
   `turn_recovery_jobs` row, and emits `automatic_replay=false`.
5. `normalizeFinalizeTurnTerminalParams()` derives a `completed_*` checkpoint
   bundle from every terminal inbound mutation. Admission rejection produces a
   failed inbound mutation and is therefore currently eligible for that
   derivation.
6. Merged PR #3259 provides a read-only observer that distinguishes active
   breach from historical recovery debt. It does not retain, replay, or mutate
   failed work.
7. The inactive provider-event lifecycle design already specifies durable FIFO
   `deferred_by_recovery_scope` work for new inbound during valid recovery and
   rejects generalizing `turn_recovery_jobs` into a provider-input replay queue.

These facts produce three separate defects:

- **ownership loss:** a transient blocker is converted into a terminal
  admission failure;
- **resume-proof pollution:** a provider-undispatched failure can become the
  latest completed checkpoint identity;
- **status ambiguity:** service availability and unresolved historical reply
  debt can be presented as one condition or allow debt to disappear from the
  current operator view.

## Scope

This change owns the AgentRuntime admission boundary for a journaled user turn
that is blocked by one of these transient, scope-owned conditions:

- active durable turn recovery for the same scope;
- terminal-finalization recovery for the same scope; or
- an earlier nonterminal deferred follower in the same scope.

The first production activation is per-chat. The persisted schema and typed
interfaces retain the existing `per_chat | shared | singleton` scope
discriminant so a later scope-native extension does not require a second data
model. Shared and singleton turns remain on their current behavior until their
separate dispatch, ordering, and restart matrix is approved and tested.

The change also owns:

- failed-admission checkpoint ineligibility;
- startup quarantine of historically polluted completed identities;
- health and recovery-debt projections for the new lifecycle;
- retention, privacy, feature-flag, kill-switch, and rollout contracts.

## Non-Goals

- Implementing or activating the full provider-event lifecycle ledger.
- Replaying an unknown or ordinarily rejected turn.
- Replaying after provider, tool, or outbound execution may have started.
- Reusing `turn_recovery_jobs` as a general provider-input replay queue.
- Redesigning provider fallback, outbound delivery recovery, ChatRuntime queue
  admission, or WhatsApp transport.
- Injecting an operator correction into an already-running provider session.
- Treating a later successful turn as proof that an earlier loss was recovered.
- Canonicalizing distinct conversation aliases or guessing that a LID and phone
  JID are the same conversation.

## Considered Approaches

### 1. Separate durable deferred-admission lifecycle

Persist blocked followers in a dedicated store, keep their source inbound open,
and drain them with fenced ownership after every earlier blocker clears.

This is the selected approach. It separates pre-provider input ownership from
answer-delivery reconciliation, preserves terminal-record meaning, and can
survive restart without asking the user to resend.

### 2. Generalize `turn_recovery_jobs`

Represent each blocked follower as another recovery job and reuse the existing
supervisor.

This is rejected. `turn_recovery_jobs` begins after an admitted turn has
terminal delivery ambiguity. Its immutable envelope, selected outbound proof,
echo settlement, terminal-record foreign key, and recovery-owner tuple encode a
different lifecycle. Making it also own turns that have never started would
weaken both proof contracts and contradict the provider-event design.

### 3. Terminalize then auto-replay the failed inbound

Keep `admission_rejected`, add a replay flag, and reconstruct a new turn from
the failed row.

This is rejected. A terminal failure is immutable historical truth, the failed
row does not itself retain a complete replay envelope, and generic replay would
make unknown or effectful rejection classes dangerous. It would also preserve
the checkpoint-pollution path unless terminal and resume semantics were
special-cased throughout the stack.

### 4. Alert and require resend

Keep current runtime behavior and rely on #2197, #2387, and merged PR #3259 to
make loss visible.

This remains the fallback when replay proof is absent, but it is insufficient
for a provably undispatched follower whose complete immutable turn is already
owned by WhatSoup.

## Architecture

The implementation adds four focused components and one terminal-contract
correction:

1. **Typed admission decision.** Replace stringly transient-block throws with a
   decision of `accepted` or `deferred`, carrying only a bounded blocker kind.
   Exceptional failures continue to throw.
2. **Deferred-turn store.** Persist the exact journal/source identity, normalized
   provider input envelope, scope, FIFO position, replay-safety latch, claim
   lease, and terminal disposition in a dedicated table.
3. **Deferred-turn supervisor.** Claim only the oldest eligible row per scope,
   resolve an exact current dispatch target, durably commit one provider
   invocation authorization, and dispatch through the normal scope-native turn
   path.
4. **Health and debt projection.** Report timely owned work, broken active
   machinery, and historical unresolved debt as separate typed facts.
5. **Checkpoint eligibility.** Forbid `admission_rejected` from deriving or
   overwriting `completed_*` identity, and quarantine historical checkpoints
   whose completed sequence resolves to such a terminal record.

`TurnQueue` remains an in-memory bounded serializer. It does not become a
durable queue. Once a blocked follower is durably deferred, its processor
returns successfully and the memory queue may examine the next follower, which
will join the same durable FIFO rather than dispatch out of order.

`TurnQueue` does gain one narrow processor disposition for a failed deferred
write: `retained_unfinalized`. That disposition keeps the exact turn owned at
the head of the halted scope and bypasses the ordinary processor-error terminal
finalizer. A bounded local retry may persist the same row and resume the queue.
Until then, health is degraded and shutdown quiescence cannot report success.
If the process crashes before persistence, the inbound remains open and
inconclusive; restart recovery may observe it but cannot reconstruct or replay
its missing content.

## Durable Model

The implementation adds a table named `turn_deferred_admissions`.

**Migration numbering is CONTIGUOUS, and paper reservations do not hold slots.**
Canonical main now ends at `CURRENT_SCHEMA_MIGRATION = 61`
(`src/core/database-migration-61.ts`, frozen-debt terminalization). The
inactive provider-event design *documents* forward allocations, but those are
unpublished — they occupy no registry slot. `ALL_MIGRATION_VERSIONS` in
`tests/core/migration-safety.test.ts` is a hand-maintained `1..N` fixture and
the suite asserts the applied versions **equal** it, so skipping ahead to leave
a gap for an unbuilt reservation fails CI: applied `[1..61, 64]` never equals
`[1..64]`.

Therefore this feature takes **the next real migration, 62**, and the inactive
provider-event allocations shift forward in the same documentation change. If
this feature needs more than one migration, it consumes 62..N contiguously and
the reservations shift by that count.

Immediately before implementation, re-read `CURRENT_SCHEMA_MIGRATION` and
inspect every open migration-bearing PR — another lane may have taken 62 first,
in which case this shifts again. Never overwrite, renumber, or silently collide
with an applied migration.

Each row contains these logical groups:

| Group | Required fields and invariant |
|---|---|
| Source identity | Unique `source_inbound_seq`, immutable source message ID, original receipt time, exact conversation key, exact delivery JID, and scope. The source inbound remains nonterminal while the row is active. |
| Replay envelope | Bounded sender identity, sender display name when present, normalized provider-input text, content type, group flag/name, and immutable replay-safe latch. This matches the existing runtime replay envelope; it never reconstructs from chat history. |
| Ordering | Original inbound sequence is the per-scope FIFO key. Only the lowest nonterminal sequence for a scope may be claimed. |
| Block reason | `active_turn_recovery`, `terminal_finalization_recovery`, or `deferred_predecessor`. The reason is diagnostic and never grants replay by itself. |
| State | `deferred`, `claimed`, `dispatch_committed`, `completed`, `held_unsafe`, or `exhausted`. Database checks enforce the legal state/field combinations. |
| Claim fence | Assigned manager/generation, assignment epoch, claim epoch/token, claimed/expiry timestamps, attempt count, and next-attempt time. A stale owner cannot complete or requeue a newer claim. |
| Dispatch proof | One immutable dispatch-authorization ID and timestamp. Transition to `dispatch_committed` occurs before the provider call and permanently closes automatic input replay. |
| Terminal proof | Child logical-turn identity, terminal-record reference where available, bounded disposition, completion timestamp, and operator-closure reference where applicable. |
| Audit | Created/updated timestamps and bounded duplicate-observation count. No raw exception or provider output is stored. |

The replay-safe latch is monotonic: `safe` may become `unsafe`; `unsafe` can
never become `safe` automatically. Unlike blocked-unsafe delivery recovery,
there is no generic operator promotion that authorizes a second provider call
after `dispatch_committed`.

The schema retains source inbound and replay-envelope evidence until the
deferred row is terminal and past the documented retention window. Foreign-key
and trigger guards prevent deletion or identity replacement while an obligation
is active.

## Admission and Ordering Flow

For each journaled per-chat turn at the head of `TurnQueue`:

1. Build the existing immutable `RuntimeTurnContext` and normalized provider
   input before admission.
2. Inspect the in-memory terminal-finalization owner and, in one
   durability-owned transaction, inspect active same-scope recovery and earlier
   deferred rows. The accepted path rechecks the terminal-finalization owner at
   the existing turn-evidence gate; a race may conservatively defer but can
   never authorize dispatch through a live blocker.
3. If no blocker exists, return `accepted` and begin normal turn evidence.
4. If a supported transient blocker exists, insert-or-return the exact deferred
   row. Conflicting duplicate identity or envelope evidence fails closed.
5. Return `deferred` only after the durable row is verified. Do not create a
   terminal record, fail the inbound, disarm its reply obligation, or advance a
   session checkpoint.
6. Let `TurnQueue` advance. Later same-scope followers observe the earlier
   deferred row and are persisted behind it. Other chat scopes retain normal
   per-chat concurrency.

Queue close, queue halt, queue depth cap, ordinary pre-dispatch errors, and
unknown rejection retain their current terminal behavior. They cannot enter
the deferred lane merely because their provider boundary was not crossed.

If the deferred insert fails, the coordinator does not fall back to terminal
admission rejection. It returns the typed `retained_unfinalized` disposition;
the exact queue stops advancing with the immutable turn still owned at its
head, the inbound stays open, and health records an active ownership failure.
Retry remains local to that retained turn while the process is alive. Restart
reconciliation treats a still-open inbound without a deferred envelope as
inconclusive; it does not reconstruct missing content or automatically invoke a
provider.

## Supervisor and Self-Healing Flow

The `DeferredTurnSupervisor` is separate from `TurnRecoverySupervisor`, but it
reuses its proven patterns for enumeration, owner assignment, lease fencing,
deadman health, exact dispatch-target resolution, and bounded backoff.

One scan performs these steps:

1. Enumerate a bounded page of oldest deferred rows with explicit truncation.
2. Skip a row while any earlier nonterminal deferred row exists in its scope.
3. Skip a row while any active durable recovery or terminal-finalization owner
   still blocks its scope.
4. Resolve exactly one generation-bound scope-native dispatch target. Missing or
   ambiguous targets leave the row unclaimed.
5. Claim the row with an expiring token and assignment epoch.
6. Revalidate source inbound status, immutable envelope, FIFO eligibility,
   replay-safe state, and absence of every other blocker.
7. Commit `dispatch_committed` before crossing the provider invocation boundary.
   This is the deferred supervisor's single automatic child-turn dispatch
   authorization.
8. Dispatch through the ordinary runtime pipeline using the original inbound
   sequence and a fresh logical turn identity. Exclude only this exact deferred
   row from the deferred-predecessor gate; never exclude another deferred row or
   recovery job.
9. Allow ordinary terminal finalization and delivery recovery to own provider
   results and outbound proof. Link the deferred row to that child terminal
   result.
10. Mark `completed` only for an echoed reply or explicit policy-authorized
    no-reply completion. A terminal no-reply failure becomes `held_unsafe` and
    recovery debt, not another automatic provider invocation.

Recovery-job completion and terminal-supervisor release signal the deferred
supervisor immediately. Its bounded periodic scan remains the restart and
lost-signal backstop. No busy sleep loop is introduced.

## Replay Safety and Crash Matrix

Exactly-once provider execution cannot be proved across a process crash at an
external invocation boundary. This design therefore promises one durable
automatic deferred child-turn authorization, not exactly-once external
execution. Provider fallback inside that already-authorized child turn remains
owned by the existing provider-handoff contract; it is not a second deferred
dispatch and must not reopen this row's replay latch.

| Crash or failure point | Result |
|---|---|
| Before deferred row commit | Queue does not advance; inbound stays open; no provider retry can be inferred after restart. |
| Deferred or claimed, before `dispatch_committed` | Stale lease may be reassigned and the same row may retry. Provider invocation is still durably uncommitted. |
| After `dispatch_committed`, before or during provider invocation | Automatic input replay is vetoed. Restart treats execution as ambiguous and holds for operator review. |
| Provider returned, before turn terminalization | Existing runtime terminal supervisor and recovery contracts own finalization. Deferred input replay remains vetoed. |
| Answer enqueued/flushed but not echoed | Existing `turn_recovery_jobs` owns delivery reconciliation. Deferred input replay remains vetoed. |
| Terminal echoed/policy-suppressed, before deferred completion | Idempotent linkage closes the deferred row from exact terminal proof without invoking the provider again. |

Normalized input text is the same bounded text the runtime would have supplied
to the provider, including already-completed media extraction or transcription.
The deferred lane never stores or later reopens temporary media paths. Missing,
oversized, unsupported, or contradictory envelope state becomes `held_unsafe`.

## Checkpoint Integrity

The terminal contract gains one explicit invariant:

> `attempt_kind = 'admission_rejected'` is never a resumable completed turn and
> cannot derive, validate, overwrite, or clear a `completed_*` checkpoint bundle.

`last_inbound_seq` remains independent progress evidence and may record that a
failed admission was examined. It must not be used as a substitute for a valid
completed identity.

The forward migration extends
`completed_delivery_identity_admissions.reason` with a bounded reason for
terminal-attempt ineligibility. It scans non-ended checkpoints whose
`completed_inbound_seq` resolves to an admission-rejected terminal record,
records one content-free quarantine admission, and makes the checkpoint
ineligible for resume. It never guesses an earlier completed turn because the
checkpoint row does not retain a full history.

A fresh provider lifecycle or a later terminal turn with valid completion proof
may supersede the quarantined checkpoint through existing exact lifecycle
transitions and resolve the admission. Tests must prove that a valid later
completion actually replaces the bad bundle; a merely newer failed or deferred
inbound does not.

## Health and Recovery-Debt Contract

Runtime health exposes a content-free `deferredTurns` projection:

- pending and live-claimed counts;
- expired-claim count;
- dispatch-committed unresolved count;
- held-unsafe and exhausted counts;
- supervisor scan freshness and consecutive failures;
- oldest-age bucket; and
- enumeration truncation or unreadable state.

The status rules are orthogonal:

| Condition | Operational status | Recovery debt |
|---|---|---|
| Timely `deferred`/live `claimed`, supervisor current | unchanged | closed unless separate debt exists |
| Expired claim, overdue eligible row, stale/failed supervisor, unreadable store, or unowned open inbound | degraded | may also be open |
| Timely `dispatch_committed` while the exact turn remains actively owned | unchanged | closed unless separate debt exists |
| Overdue/ownerless `dispatch_committed` ambiguity, `held_unsafe`, exhausted obligation, or historical terminal admission loss | unchanged if runtime is otherwise usable | open |
| Operational blocker plus historical debt | degraded | open |
| Exact completion/operator closure and no other contributor | unchanged | closed |

Merged PR #3259 is the owner for fleet-side read-only recovery-debt observation.
This feature adds the new durable facts to its input contract; it does not create
a competing observer. Its landing no longer gates this work. Issue #2197 remains the aggregate
unanswered-inbound detector and may inhibit duplicate symptom paging. Issue
#2387 remains the owner of immutable occurrence language for historical loss.

No historical counter alone may degrade current service health, and no fresh
successful turn may clear an unrelated unresolved obligation.

## Identity, Privacy, and Portability

- Conversation key and delivery JID remain separate exact fields. Code never
  guesses an alias, changes JID namespace, or merges LID and phone identities.
- Group actor and destination identity are preserved exactly from the original
  runtime envelope; replay never substitutes the bot or another participant.
- The durable envelope uses the existing bounded replay limits. Runtime logs,
  health, alerts, and GitHub evidence contain only counts, state classes, age
  buckets, scope class, and opaque proof fingerprints.
- SQLite paths, service users, GUI sessions, launchd/systemd details, and host
  names are not part of the data model. The same code runs under supported
  Linux and macOS deployment wrappers.
- Secrets, provider-native session IDs, raw provider output, tool inputs/results,
  temporary media paths, and raw errors are never added to the deferred table.
- Database read failures are inconclusive and cannot produce a false green,
  recovery clear, or replay authorization.

## Capacity, Fairness, and Retention

- One source inbound may own at most one deferred row.
- Only one row per scope may be claimed or dispatch-committed at a time.
- Enumeration and claims are indexed by state, next-attempt time, scope, and
  inbound sequence; scans use bounded pages and report truncation.
- A chat with many deferred rows cannot consume another chat's per-chat runtime
  lane. Supervisor scheduling rotates eligible scopes before taking a second row
  from one scope.
- The existing in-memory queue depth remains unchanged. Queue-full work retains
  current terminal behavior and is not relabeled as recovery deferral.
- Deferred rows and linked source evidence are retained while nonterminal.
  Terminal safe completions follow the normal terminal retention window;
  held-unsafe or operator-owned rows remain until reviewed closure and the
  extended audit window both permit deletion.

## Configuration, Activation, and Rollback

Register one automatic-dispatch kill switch in the canonical configuration and
deployment manifests. Durable deferral has no runtime off-switch after the
migration: disabling persistence would recreate terminal follower loss. The
positive behavior is enabled by default in source after migration/startup
guards pass; setting the kill switch stops the deferred supervisor from issuing
new provider invocation authorizations without deleting, terminalizing, or
rewriting existing rows.

Rollout order:

1. Back up and integrity-check one canary database, then apply the migration
   with the agent quiesced.
2. Start with dispatch disabled and prove schema, health projection, and
   synthetic deferral persistence.
3. Enable dispatch on one per-chat fleet instance and run synthetic burst,
   restart-before-commit, restart-after-commit, and multiple-blocker canaries.
4. Observe at least one full configured recovery/lease window with current
   supervisor health and no duplicate provider or outbound evidence.
5. Expand by fleet cohort only after repository/live artifact provenance and
   rollback readiness are verified.

Disabling automatic dispatch stops new provider authorizations while new
blocked followers continue to persist in FIFO order. Existing `deferred` rows
remain visible and owned; `dispatch_committed` and held rows remain
replay-vetoed. Rollback never deletes evidence, rewrites terminal state, or
marks unresolved work complete. An old binary that does not understand the new
schema is not a supported live rollback target; rollback is configuration-first
and otherwise roll-forward.

## Integration and Blast Radius

Expected implementation touchpoints are:

- schema registry, a forward migration, migration provenance, and drift tests;
- a new core deferred-turn store exposed through `DurabilityEngine`;
- `RuntimeTurnCoordinator` admission, per-chat processing, reset, shutdown, and
  terminal-linkage paths;
- a new deferred-turn supervisor plus runtime startup/shutdown/deadman wiring;
- session checkpoint normalization, resume selection, and completed-identity
  admission handling;
- health aggregation, fault taxonomy, BOT ERRORS/reply-debt observer inputs,
  and console/API types if the projection is public;
- database retention and backup/restore compatibility;
- configuration, public-surface, runbook, source-runtime manifest, and release
  provenance docs;
- TurnQueue, recovery-supervisor, terminal-finalization, checkpoint, health,
  retention, privacy, migration, shutdown, and restart test suites.

The implementation must use current APIs rather than copying supervisor,
claim, JID, health, or migration helpers. Any shared helper extraction requires
behavior-preserving baseline tests and remains limited to code used by both
supervisors.

## Test Strategy and Acceptance Proof

Implementation is RED-first. Required executable cases include:

1. Pending-recovery and claimed-recovery follower bursts persist without
   terminal records and later dispatch FIFO without user resend.
2. An earlier deferred row causes later same-scope live input to defer; another
   chat remains dispatchable.
3. Multiple recovery blockers prevent drain; exact self-exclusion cannot bypass
   a sibling blocker or earlier deferred row.
4. Deferred insert failure retains the exact turn at the halted queue head,
   preserves an open inbound, blocks successful quiescence, and reports degraded
   ownership rather than terminal success or failure.
5. Restart and stale-claim tests prove reassignment before dispatch commit.
6. Crash on both sides of `dispatch_committed` proves retry-before and permanent
   replay-veto-after behavior.
7. Concurrent supervisors obtain one winning claim and one dispatch
   authorization.
8. Echoed, policy-suppressed, delivery-ambiguous, provider-failed, and terminal-
   linkage-race cases reach their exact dispositions without duplicate provider
   calls.
9. Queue closed, halted, full, unknown rejection, and ordinary processor errors
   preserve current terminal semantics.
10. Admission-rejected and deferred turns cannot change `completed_*`; a later
    valid completion supersedes a quarantined historical checkpoint.
11. Fresh, upgraded, partially corrupted, unknown-schema, and migration-collision
    fixtures fail or migrate exactly as documented.
12. Health distinguishes timely active ownership, broken machinery, historical
    debt, mixed state, and recovery clear without status/debt conflation.
13. Retention cannot delete active evidence and can delete only eligible exact
    terminal chains.
14. Logs, alerts, health JSON, database audit columns, and test fixtures contain
    no forbidden private values.
15. Kill-switch tests prove no new dispatch after disable, continued durable
    FIFO admission while disabled, and no evidence loss across re-enable or
    restart.

Verification includes focused suites, TypeScript checks, migration lineage and
performance guards, Test Integrity review of every changed test, privacy and
public-surface guards, repository branch gate, exact-head independent review,
and a reproducible canary evidence packet. A masked, skipped, timed-out, or
environment-incompatible run is inconclusive, never green.

## Documentation and GitHub Relationships

- #3295 is the implementation owner for this focused lifecycle.
- #2197 consumes aggregate unanswered/open-finalization evidence but does not
  own replay.
- #2387 owns historical terminal-occurrence language and bounded notification.
- PR #3259 owns recovery-debt observation and should be rebased/reviewed before
  this feature adds new debt inputs.
- PRs #1760, #1827, #2123, #2455, #2604, #2611, #2739, #3210, and #3211 are
  dependencies or pattern sources, not code to duplicate.
- The provider-event lifecycle spec keeps authority over its eventual full
  provider-event ledger. Its `deferred_by_recovery_scope` requirement is
  satisfied incrementally by this focused prerequisite without activating the
  remaining provider lifecycle.
