# BOT ERRORS Proof Lifecycle Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BOT ERRORS incident state replay-safe and proof-driven so weak or mismatched clears cannot close incidents, repeated open observations cannot masquerade as flapping, and real accepted close-to-reopen transitions remain visible.

**Architecture:** Extend the existing durable event builder to schema version 2 and normalize both versions into one internal observation model. The existing dispatcher incident key/state file, source-specific recovery oracles, inhibition map, queue ownership, and notification path remain authoritative. Extract pure protocol evaluation from the dispatcher for deterministic model tests, but do not add a second state file, incident key, clear parser, or delivery envelope.

**Tech Stack:** TypeScript ESM event producers, Python 3 dispatcher/runtime scripts, JSON durable queues, Vitest, Python `unittest`, deterministic fake clocks, and isolated temporary state roots.

## Global Constraints

- Preserve existing durable temp-write/rename/fsync behavior and fail-closed queue acknowledgement.
- A remediation action succeeding does not close an incident; only accepted proof does.
- Unknown, stale, malformed, unauthorized, or missing proof leaves the incident open.
- Reuse `incident_source`, `incident_key`, `event_already_known`, existing concrete health/outbound/auth recovery oracles, stronger-root inhibition, `mark_incident_sent`, and the current bounded flap window/escalation settings.
- Replace the advisory `clearRequirement` behavior; do not maintain a second advisory close path.
- Legacy schema version 1 is adapted to a safe minimum and cannot weaken a stored version-2 policy.
- Python and TypeScript representations must be covered by cross-language fixtures because the runtime scripts cannot import TypeScript.
- Local tests and commits only. Deploying scripts, restarting services, replaying live queues, or sending WhatsApp updates remains separately gated.
- Every fault-injection test must assert that the intended fault occurred; masked or setup failures are inconclusive.

## File Structure

- Modify `src/lib/bot-errors-outbox.ts`, `src/lib/emit-alert.ts`, and tests for schema-v2 production and validation.
- Create `deploy/scripts/bot_errors_protocol.py` as a pure normalization/evaluation module.
- Modify `deploy/scripts/bot-errors-dispatcher.py` to call the pure evaluator while retaining I/O/state/notification ownership.
- Add Python protocol/model tests and update existing clear/flap tests.
- Update runtime packaging manifests, parity checks, and BOT ERRORS operating documentation.

---

### Task 1: Define and validate the schema-v2 producer contract

**Files:**
- Modify: `src/lib/bot-errors-outbox.ts`
- Modify: `src/lib/emit-alert.ts`
- Modify: `tests/lib/bot-errors-outbox.test.ts`
- Modify: `tests/lib/emit-alert.test.ts`
- Create: `tests/fixtures/bot-errors-observation-v2.json`

**Interfaces:**
- Adds typed `observation`, `clearPolicy`, and `remediation` fields to `BotErrorsOutboxInput`.
- `buildBotErrorsEvent` produces schema version 2 when the typed protocol is supplied and preserves explicit legacy fixture support only for compatibility tests.

- [ ] **Step 1: Write failing contract tests**

Cover every enum, bounded length, timestamp relationship, fault/alert and healthy/clear pairing, stable fingerprint shape, optional producer sequence, proof reference redaction, and invalid combinations. Assert no unredacted evidence reaches the written event.

- [ ] **Step 2: Add a versioned compatibility fixture**

Provide one privacy-safe alert/clear pair for version 1 and one for version 2. The fixture is the cross-language shape oracle and contains no live identity.

- [ ] **Step 3: Prove the red state**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/lib/bot-errors-outbox.test.ts tests/lib/emit-alert.test.ts --pool=forks`

Expected: FAIL because the builder emits schema version 1 and has no typed proof fields.

- [ ] **Step 4: Implement validation and durable writing**

Add named union types and explicit runtime validators. Derive a bounded evidence fingerprint after redaction. Preserve the current atomic write and error receipt. Require a clear policy on critical fault events and a proof reference on proof-bearing clears.

- [ ] **Step 5: Verify and commit**

Run focused producer tests, redaction parity, critical-surface audit tests, and typecheck.

Expected: PASS with existing schema-v1 fixtures still readable.

Commit: `feat(alerts): add typed recovery proof envelope`

### Task 2: Normalize legacy and version-2 events once

**Files:**
- Create: `deploy/scripts/bot_errors_protocol.py`
- Create: `deploy/scripts/tests/test_bot_errors_protocol_adapter.py`
- Modify: `deploy/scripts/bot-errors-dispatcher.py`

**Interfaces:**
- Produces `normalize_observation(event) -> NormalizedObservation` or a typed quarantine reason.
- Reuses dispatcher `incident_key` output as the normalized identity input.

- [ ] **Step 1: Write failing adapter tests**

Assert version-1 alerts normalize to `fault` with `same_source_newer`; version-1 clears can target only the identical incident key and must be newer; recognized critical-asset requirements map to stronger policies; free-form text never weakens the minimum; malformed/unsupported events produce bounded quarantine reasons. Add the observed weak-auth case: `connected=false`, `disconnect_class=none`, `reconnect_phase=backoff`, zero reconnect attempts, and three weak polls must remain an inferred transient diagnostic and must not normalize to server-revoked/manual-relink semantics.

- [ ] **Step 2: Prove the red state**

Run: `python3 -m unittest deploy.scripts.tests.test_bot_errors_protocol_adapter`

Expected: FAIL because the pure protocol adapter is absent.

- [ ] **Step 3: Extract the pure adapter**

Move normalization and policy comparison logic out of dispatcher branches into the new module. Pass already-derived incident identity and source-specific oracle results into the evaluator; do not copy identity derivation or health probing into the module.

- [ ] **Step 4: Integrate quarantine behavior**

The dispatcher must normalize before mutating incident state. Unsupported or malformed events move to quarantine, append a bounded dispatch receipt, and never update open incidents, flap history, or notification state.

- [ ] **Step 5: Verify and commit**

Run adapter tests plus existing policy, orphan-clear, clock-skew, redaction, and quarantine-related suites.

Expected: PASS.

Commit: `refactor(alerts): centralize observation normalization`

### Task 3: Enforce clear proof before state closure

**Files:**
- Modify: `deploy/scripts/bot_errors_protocol.py`
- Modify: `deploy/scripts/bot-errors-dispatcher.py`
- Modify: `deploy/scripts/tests/test_bot_errors_f8_clock_skew_and_clear_requirement.py`
- Modify: `deploy/scripts/tests/test_bot_errors_sustained_stability_clear.py`
- Modify: source-specific health/outbound recovery tests as required by the shared evaluator.

**Interfaces:**
- Produces `evaluate_clear(open_record, observation, oracle_receipts) -> ClearDecision`.
- Returns `accepted`, `rejected`, or `candidate`, with bounded reason and proof receipt.

- [ ] **Step 1: Reverse the current advisory test**

Change the existing mismatch test to assert the clear is suppressed and the open incident remains. Add wrong source, stale proof, missing referenced receipt, weak schema, future timestamp, unknown observation, accepted same-source clear, accepted health snapshot, accepted outbound-after-incident, and accepted auth-bond-plus-outbound cases. Reproduce the observed weak-auth sequence: a weak `connecting/backoff` observation must never enter `awaiting_physical`; later connected/present-bond evidence closes or supersedes the transient incident without requiring relink proof, while a genuinely terminal-auth incident still requires the stronger policy. Reproduce both observed oneshot sequences: a successful service invocation closes only the unit-execution incident and must not clear application-health findings from an `attention-required`, `ok=false` heartbeat; an activating/running oneshot previously in the failed set remains unknown and cannot close until a newer terminal `Result=success`/exit-0 receipt exists.

- [ ] **Step 2: Prove the red state**

Run: `python3 -m unittest deploy.scripts.tests.test_bot_errors_f8_clock_skew_and_clear_requirement deploy.scripts.tests.test_bot_errors_sustained_stability_clear`

Expected: FAIL specifically because mismatch currently annotates `advisory_only_incident_still_closed` and `mark_incident_sent` removes the incident.

- [ ] **Step 3: Evaluate proof before acknowledgement**

Call the pure evaluator from suppression/processing before `append_clear_context` and before `mark_incident_sent`. Rejected proof moves to the existing suppressed evidence path, appends a rejected-proof receipt to the open record, and retains notification/state identity. Candidate proof updates bounded candidate evidence but does not close.

- [ ] **Step 4: Make closure atomic with the receipt**

On accepted proof, persist the close transition, replay receipt, and bounded closed-history entry before acknowledging the queue item. If state persistence fails, the event remains retry-owned and no success notification is claimed.

- [ ] **Step 5: Verify and commit**

Run all clear/recovery/orphan/clock-skew/daily-health/outbound-proof tests.

Expected: PASS; the old advisory marker is absent from implementation and tests.

Commit: `fix(alerts): require authoritative clear proof`

### Task 4: Persist replay receipts and identity-collision quarantine

**Files:**
- Modify: `deploy/scripts/bot_errors_protocol.py`
- Modify: `deploy/scripts/bot-errors-dispatcher.py`
- Create: `deploy/scripts/tests/test_bot_errors_replay_receipts.py`

**Interfaces:**
- Extends the existing incident-state document with bounded `processedEvents` and `closedHistory` collections.
- Reuses `event_already_known` as the queue-level discovery primitive.

- [ ] **Step 1: Write failing replay tests**

Cover duplicate ID/same fingerprint, duplicate ID/different fingerprint, dispatcher restart, duplicate clear after close, out-of-order alert after close, capacity pruning, age pruning, and protection of IDs referenced by open/candidate/flap state.

- [ ] **Step 2: Prove the red state**

Run: `python3 -m unittest deploy.scripts.tests.test_bot_errors_replay_receipts`

Expected: FAIL because known-event detection does not persist the required evidence fingerprint/transition receipt contract.

- [ ] **Step 3: Implement bounded receipts**

Remember accepted and rejected processed identities with fingerprint, incident key, observation time, receipt time, and decision. Exact replay is idempotent. Reused identity with a different fingerprint is quarantined. Prune by age and capacity only when no open incident, candidate, or flap history references the receipt.

- [ ] **Step 4: Verify and commit**

Run replay tests plus write-failure recovery, queue-age, dead-letter, and dispatcher policy suites.

Expected: PASS across process restart.

Commit: `feat(alerts): persist replay-safe event receipts`

### Task 5: Count verified reopen transitions instead of raw alerts

**Files:**
- Modify: `deploy/scripts/bot_errors_protocol.py`
- Modify: `deploy/scripts/bot-errors-dispatcher.py`
- Modify: `deploy/scripts/tests/test_bot_errors_f12_flap_storm.py`
- Create: `deploy/scripts/tests/test_bot_errors_transition_model.py`

**Interfaces:**
- Replaces raw `record_flap_trip` admission with `record_verified_reopen` after an accepted prior close.
- Retains existing sliding window, thresholds, escalation cadence, and storm formatting, relabeled as verified reopens.

- [ ] **Step 1: Write failing transition tests**

Assert 1,500 repeated faults while one incident is open create zero verified reopens; rejected clears create zero; a valid close followed by a fresh accepted fault creates one; replay creates none; a held transient creates none; a failed oneshot that temporarily enters activating/running creates neither a close nor reopen; enough real close/reopen cycles open and escalate one storm.

- [ ] **Step 2: Add a seeded pure-model test**

Generate deterministic mixed sequences and compare dispatcher decisions to a small reference state machine. Assert no close without proof, no repeat-fault flap count, no time reversal, replay idempotency, and unknown never becoming healthy. Record the seed on failure.

- [ ] **Step 3: Prove the red state**

Run: `python3 -m unittest deploy.scripts.tests.test_bot_errors_f12_flap_storm deploy.scripts.tests.test_bot_errors_transition_model`

Expected: FAIL because `flap_scan_outbox` currently records every raw incident alert before collapse.

- [ ] **Step 4: Move flap admission to accepted transitions**

Remove raw outbox scanning as a trip source. When an accepted fault reopens a recently and validly closed incident, append one transition timestamp and evaluate the existing window. Preserve legacy raw cumulative fields as diagnostics only. Resolve storms only after accepted close plus liveness and stability; silence is insufficient.

- [ ] **Step 5: Verify and commit**

Run flap, clear, replay, transient, inhibition, and open-renotify suites.

Expected: PASS; user-facing fields say `verified_reopens`, not `trips`.

Commit: `fix(alerts): detect flaps from verified reopens`

### Task 6: Preserve termination cause and control-delivery truth

**Files:**
- Modify: `src/runtimes/agent/session.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `src/core/heal.ts`
- Modify: `tests/runtimes/agent/session.test.ts`
- Modify: `tests/runtimes/agent/runtime.test.ts`
- Modify: `tests/core/heal.test.ts`
- Modify: `tests/core/health.test.ts`

**Interfaces:**
- Extends crash information with a bounded `terminationCause` and optional operation kind/identifier.
- Adds a truthful heal delivery state for `blocked_no_control_peer` rather than claiming `attempt_1`.

- [ ] **Step 1: Write failing causal-evidence tests**

Simulate a stalled tool watchdog kill while stderr contains an unrelated warning. Assert the crash/heal evidence identifies `stalled_operation` as the cause, retains stderr only as collateral diagnostics, excludes command text, and classifies missing final-turn usage as an inhibited consequence of the crash rather than a second root page.

- [ ] **Step 2: Write failing delivery-state tests**

Assert a missing `q` peer creates the report in `blocked_no_control_peer`, performs no direct send, records the durable fallback receipt separately, exposes the blocked state through health, and does not increment direct-attempt counters. A configured peer uses the existing attempt state. Later provider respawn alone must not resolve the control-path fault.

- [ ] **Step 3: Prove the red state**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/agent/session.test.ts tests/runtimes/agent/runtime.test.ts tests/core/heal.test.ts tests/core/health.test.ts --pool=forks`

Expected: FAIL because the stalled-operation reason is logged but not threaded through crash information, and missing-peer reports are currently stored as `attempt_1`.

- [ ] **Step 4: Thread typed termination cause**

Set a bounded pending forced-termination record before killing the provider, consume it once in the exit path, and pass it through every runtime crash callback into `HealReportData`. Keep cause codes and collateral stderr in separate fields. Clear stale pending cause state on provider progress, normal exit, and session replacement.

- [ ] **Step 5: Make delivery state truthful and clearable**

Choose report state only after evaluating control-peer availability. Persist `blocked_no_control_peer` with an owner-required remediation code and fallback event receipt. On verified configuration restoration, transition blocked reports through the existing send path or close the delivery-unavailable incident with a same-source wiring proof; failed sends remain attempted failures, not blocked configuration.

- [ ] **Step 6: Verify and commit**

Run focused crash, watchdog, heal, health, fallback, clear-proof, and redaction tests.

Expected: PASS with causal and delivery state distinctions visible in receipts and no raw command content.

Commit: `fix(heal): preserve causal delivery truth`

### Task 7: Add the bounded remediation ledger

**Files:**
- Modify: `deploy/scripts/bot_errors_protocol.py`
- Modify: `deploy/scripts/bot-errors-dispatcher.py`
- Create: `deploy/scripts/tests/test_bot_errors_remediation_ledger.py`

**Interfaces:**
- Adds append-only bounded remediation attempts inside existing incident state.
- Produces action-specific idempotency keys and lease receipts.

- [ ] **Step 1: Write failing ledger tests**

Cover succeeded action without recovery, failed action followed by spontaneous recovery, inconclusive proof, owner/physical blocked actions, duplicate request, bounded backoff, lease expiry/reclaim receipt, state growth limits, and rollback references.

- [ ] **Step 2: Prove the red state**

Run: `python3 -m unittest deploy.scripts.tests.test_bot_errors_remediation_ledger`

Expected: FAIL because the typed attempt ledger is absent.

- [ ] **Step 3: Implement the minimal file-ledger form**

Store only bounded action codes, authorization class, timestamps, actor class, evidence references, result, and rollback reference. Never store command output or secrets. Do not attach automatic executors to owner-required, physical, destructive, credential, link, or deployment actions.

- [ ] **Step 4: Verify bounded atomic behavior**

Inject state-write failure and concurrent invocation. If the existing file document cannot remain atomic/bounded under these tests, stop and amend the design before introducing a database.

- [ ] **Step 5: Verify and commit**

Run ledger plus dispatcher concurrency/state-write suites.

Expected: PASS or a documented design-blocking falsifier; do not silently switch storage.

Commit: `feat(alerts): record bounded remediation attempts`

### Task 8: Package, document, and verify the protocol

**Files:**
- Modify: `deploy/bot-errors-runtime-manifest.json`
- Modify: installer/deployer allowlists that package dispatcher dependencies.
- Modify: `deploy/scripts/README-bot-errors.md`
- Modify: `docs/runbooks/error-response-workflows.md`
- Modify: focused packaging/parity tests.

- [ ] **Step 1: Update packaging and drift checks**

Include the pure protocol module in every dispatcher bundle, hash manifest, installer verification, and runtime parity check. Add a test proving a missing or stale module fails closed before dispatcher replacement.

- [ ] **Step 2: Document lifecycle and rollback**

Document version adaptation, proof kinds, rejected-clear behavior, verified-reopen semantics, state backup, compatibility canary, queue replay, and rollback without live host identities.

- [ ] **Step 3: Run focused and structural verification**

Run all BOT ERRORS dispatcher tests, producer tests, redaction parity, deployer/static/runtime-manifest/simulation/critical-surface guards, Python syntax checks, typecheck, fitness, SSOT, boundary, publication, and test-integrity gates.

- [ ] **Step 4: Run isolated fault and load tests**

Process 100,000 seeded observations across at least 1,000 keys with duplicates/reordering; inject permission, truncated state, rename, full-disk substitute, state-write, notification, and restart faults. Assert bounded state/receipts, exact transitions, no lost retry ownership, and a recorded peak RSS/state size. Absolute timing is benchmark evidence, not a flaky CI gate.

- [ ] **Step 5: Produce the handoff**

Record exact commits, exits, seeds, resource measurements, skipped/inconclusive checks, compatibility status, and separately gated deployment/canary/rollback steps. Do not claim live incidents repaired until their stored proof policies accept independent recovery evidence.
