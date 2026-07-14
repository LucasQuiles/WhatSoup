# Transactional `/kill-session` Cancellation Requirements

> **Status:** active
> **Baseline:** `origin/main@56e232223132d33c347cd2d2521620f911d4f4b6`
> **Scope:** targeted session/turn cancellation only

## Purpose

Define the platform contract for an operator-requested `/kill-session` while the
selected session owns active, queued, published, or delivery-uncertain work. The
command must preempt the selected child without restarting the WhatSoup service,
must give every admitted turn one durable disposition, and must retain ownership
evidence whenever terminal proof is unavailable.

This is deliberately a cancellation protocol, not a provider-event lifecycle or
whole-service shutdown change. An `operator_cancelled` terminal is durable turn
accounting; it is not a provider-event tombstone.

## Evidence Basis

- The 2026-07-13 DGX SPARK incident left admitted inbound sequence `47975`
  blocked behind a per-chat `TurnQueue` after its selected session was killed.
  The canonical incident, targeted-recovery packet, and independent lifecycle
  audit remain in the owner-only operations archive; this public contract retains
  only the content-free inbound identifier and reproduced code-level invariants.
- PR #1747 (`0992e9a7`, merged as `77cd0718`) proved that deleting an idle queue
  is insufficient: it skipped published turns, passed an active FIFO scope to
  never-published turns, deleted state after finalization failure, and did not
  preempt shared or singleton work.
- The sanitized provider-event lifecycle contract in PR #1771
  (`3d747a68309ca5f1367362cd03f78c6796503595`) defines this work as a separate
  PR in `CON-006` and `DES-009`; provider parsing, suppression, quarantine, and
  tombstoning remain outside this contract. This dependency is descriptive: the
  cancellation contract remains independently reviewable if that PR is amended.

## Terms

- **Cancellation target:** the exact session object, manager ID, generation,
  scope, queue object, mutable scope reference, and selected turn identities
  captured when the command arrives.
- **Published turn:** an active turn whose immutable context has entered the
  runtime FIFO/context/completion structures.
- **Unpublished turn:** an admitted turn with an immutable context that has not
  entered those structures, including pending queue entries.
- **Release proof:** proof that every target turn is terminal or has an existing
  durable recovery owner, the exact child process has stopped, and the captured
  queue is idle before ownership maps are removed or admissions reopen.
- **Retained degraded state:** a closed target lane whose session, turn context,
  queue identity, evidence, and ownership references remain available to the
  existing retry owner because release proof is incomplete.

## Requirements

#### REQ-001: Preempt on a fenced operator-control lane
- **Status:** active
- **Statement:** WHEN an authorized text message is classified as
  `/kill-session <N>` THE SYSTEM SHALL capture and serialize an immutable target
  before the ordinary message `turnChain`, provider dispatch, or target-index
  mutation can delay or redirect the cancellation.
- **Acceptance criteria:**
  - **REQ-001.AC-01:** A singleton turn blocked inside provider execution is
    preempted by the command before that provider turn returns, and only the
    captured singleton child is stopped.
  - **REQ-001.AC-02:** Concurrent duplicate commands are serialized by a dedicated
    cancellation-control chain, retain the same captured target identity, and
    cannot shift the numeric index onto a replacement or neighboring session.
  - **REQ-001.AC-03:** The command inbound row reaches
    `completed/local_command_handled` exactly once independently of every target
    turn's terminal, recovery, or retained-degraded outcome.
  - **REQ-001.AC-04:** Event, result, crash, resume, and completion callbacks from
    the cancelled singleton, shared, or per-chat generation are rejected by exact
    captured-session and generation fences and cannot mutate replacement state or
    emit output.
  - **REQ-001.AC-05:** Non-admin, malformed-index, out-of-range, and no-active-
    session behavior remains fail closed; recognizing `/kill-session` on the
    control lane does not create a provider session or runtime queue for the
    command's source chat.
- **Verified-by:** {acceptance, contract, concurrency}
- **Traces-to:** DES-001, DES-002, DES-007

#### REQ-002: Terminalize every target turn by publication state
- **Status:** active
- **Statement:** WHEN a cancellation target is fenced THE SYSTEM SHALL close its
  admissions and give every captured active, pending, or late-arriving admitted
  turn exactly one disposition appropriate to its publication state before
  destructive cleanup.
- **Acceptance criteria:**
  - **REQ-002.AC-01:** A published active per-chat turn records exactly one
    `failed/operator_cancelled` terminal, preserves frozen outbound evidence,
    settles its completion, releases its exact owners only after release proof,
    and allows a later fresh turn for that chat to dispatch normally.
  - **REQ-002.AC-02:** An active unpublished turn records
    `failed/operator_cancelled`; pending and admission-racing turns record
    `admission_rejected`; none of those never-published turns consumes a published
    FIFO scope or dispatches to a provider.
  - **REQ-002.AC-03:** Cancelling a shared session accounts for its published
    active turn and every cross-chat pending turn, then reuses the original global
    `TurnQueue` only after it is empty, idle, non-halted, and explicitly reopened.
  - **REQ-002.AC-04:** A journaled target turn that lacks its immutable
    `RuntimeTurnContext` fails closed: the child is stopped, the queue stays
    closed, journaled owners are retained, and neither silent skipping nor a clean
    success acknowledgement is permitted.
- **Verified-by:** {acceptance, contract, concurrency}
- **Traces-to:** DES-003, DES-004, DES-005

#### REQ-003: Preserve evidence and release only on proof
- **Status:** active
- **Statement:** WHEN cancellation encounters output evidence, alias movement, or
  finalization failure THE SYSTEM SHALL preserve the exact evidence and retain one
  recovery owner until release proof exists.
- **Acceptance criteria:**
  - **REQ-003.AC-01:** If a DM's LID key rekeys while evidence flush or terminal
    persistence is blocked, every fence and cleanup step follows the mutable scope
    reference and releases only the final canonical key exactly once.
  - **REQ-003.AC-02:** Pending, submitted, or maybe-sent answer evidence transfers
    to the existing durable recovery owner with replay safety irreversibly false;
    the recovery job is blocked unsafe and the original prompt is never replayed.
  - **REQ-003.AC-03:** If delivery-proof or terminal persistence fails, the exact
    child is still stopped but the queue, session owner, context, completion,
    scope reference, and preserved evidence remain in retained degraded state;
    a later successful supervisor retry releases them exactly once.
  - **REQ-003.AC-04:** The operator path never waits indefinitely on an exhausted
    `RuntimeTurnSupervisor.waitForRecovery()` promise. It returns a truthful
    degraded result within its bounded coordination deadline and emits clean
    `Session killed` only after terminal/recovery, process-stop, and queue-idle
    proofs all succeed.
- **Verified-by:** {acceptance, contract, failure-injection}
- **Traces-to:** DES-004, DES-005, DES-006

#### REQ-004: Preserve unaffected runtime availability
- **Status:** active
- **Statement:** WHILE one targeted session is cancelling THE SYSTEM SHALL keep
  unrelated session owners, queues, providers, and turn completions operational.
- **Acceptance criteria:**
  - **REQ-004.AC-01:** A second per-chat conversation dispatches and completes
    normally while the target chat is actively cancelling or retained degraded;
    no target cleanup mutates the second chat's maps, queue, session, or durability
    rows.
  - **REQ-004.AC-02:** The protocol stops only the captured child process tree and
    never restarts the WhatSoup service, the Q fleet, or any unrelated session as
    part of success or recovery.
- **Verified-by:** {acceptance, isolation, review}
- **Traces-to:** DES-002, DES-005, DES-008

## Constraints

#### CON-001: Code-bounded cancellation taxonomy; no schema migration
- **Status:** active
- **Statement:** `operator_cancelled` must extend the existing code-bounded turn
  and inbound failure taxonomies without changing the persisted schema.
- **Acceptance criteria:**
  - **CON-001.AC-01:** `AttemptOutcome`, `InboundFailureClass`, their bounded sets,
    normalizers, and terminal-contract validators accept only the exact
    `operator_cancelled` value and coerce or reject arbitrary raw strings under
    existing rules.
  - **CON-001.AC-02:** No migration file, schema version, table, column, trigger, or
    index changes; fresh and current databases continue to expose CHECK-free TEXT
    columns for `inbound_events.failure_class` and
    `turn_terminal_records.attempt_failure_class`.
  - **CON-001.AC-03:** A cancelled admitted turn persists the existing
    `inbound_events.terminal_reason='error'` compatibility value, bounded
    `failure_class='operator_cancelled'`, and
    `attempt_kind='failed'`/`attempt_failure_class='operator_cancelled'`.
- **Verified-by:** {contract, schema, acceptance}
- **Traces-to:** DES-006

#### CON-002: Reuse canonical lifecycle owners and maintain PR boundaries
- **Status:** active
- **Statement:** Cancellation must extend the canonical turn finalizer,
  `DurabilityEngine`, `RuntimeTurnSupervisor`, `SessionOwnershipRegistry`,
  `TurnQueue`, outbound evidence, and recovery-job contracts; it must not create a
  parallel terminal or replay subsystem.
- **Acceptance criteria:**
  - **CON-002.AC-01:** `turn_terminal_records` remains the only terminal
    compare-and-swap owner and `turn_recovery_jobs` remains the only delivery-
    uncertainty recovery owner.
  - **CON-002.AC-02:** Provider-event parsing, post-result gating, suppression,
    quarantine, tombstoning, and provider-content replay are absent from this
    change set.
  - **CON-002.AC-03:** Whole-service shutdown/fleet restart behavior, raw
    installation, deployment manifests, and unrelated recovery migrations are
    absent from this change set.
- **Verified-by:** {architecture, review}
- **Traces-to:** DES-003, DES-006, DES-008

#### CON-003: Bounded, content-free operation
- **Status:** active
- **Statement:** The control path and its recovery diagnostics must remain bounded,
  content-free, and independently testable.
- **Acceptance criteria:**
  - **CON-003.AC-01:** Cancellation coordination uses explicit deadlines and
    non-blocking deferred cleanup; it does not block the control chain on queue
    idleness from inside an after-terminal callback or on an unresolved recovery
    waiter.
  - **CON-003.AC-02:** Structured diagnostics contain bounded outcome/state codes
    and exact or hashed owner correlation only; they exclude user text, provider
    output, tool payloads, and preserved evidence content.
  - **CON-003.AC-03:** The focused cancellation suite uses a real in-memory SQLite
    `Database` and `DurabilityEngine`, the real `TurnQueue`, and controllable
    session/outbound fakes only at external-effect seams.
- **Verified-by:** {contract, privacy, test-integrity}
- **Traces-to:** DES-005, DES-007

#### CON-004: Test-first and independently reviewable delivery
- **Status:** active
- **Statement:** Implementation must proceed as focused red-green-refactor slices
  with exact traceability and independent review before merge or deployment.
- **Acceptance criteria:**
  - **CON-004.AC-01:** All twelve named conformance cases are observed failing for
    the intended behavioral reason before production changes, then pass without
    weakening assertions or replacing real lifecycle owners with mocks.
  - **CON-004.AC-02:** Focused runtime, terminal, durability, schema, type, lint,
    publication, work-index, full-suite, test-integrity, and independent-review
    gates pass before the branch is eligible for PR merge.
- **Verified-by:** {test-integrity, verification, review}
- **Traces-to:** DES-009

## RED Case Count Reconciliation

The earlier investigation called this an **11-case** matrix because unaffected-
chat continuity was folded into the retained-degraded/terminal-sink-failure case.
This specification uses **12 cases**. Isolation has a distinct second-chat setup,
different assertions, and an independent regression mode, so it receives its own
conformance case (`CHK-012`) instead of sharing `CHK-007`.

## Amendment Log

| AMD ID | Status | Type | Affected IDs | Summary | Rationale | Task Context | Approved By | Timestamp |
|--------|--------|------|--------------|---------|-----------|--------------|-------------|-----------|
