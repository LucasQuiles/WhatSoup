# Controller State Recovery Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace corrupt-to-empty lifecycle state handling in the BOT ERRORS collector, heartbeat watchdog, and dispatcher with an integrity-bound, last-known-good recovery contract that fails closed before domain effects.

**Architecture:** Add one manifest-tracked `controller_state.py` helper that owns descriptor-confined I/O, canonical envelopes and sidecars, a stable lock, journaled publication, recovery, and opaque lock-bound capabilities. Keep component payload validation and reconciliation policy in the three controllers. Thread one exclusive state session through each complete owner cycle; use a separate shared-lock read-only API for watchdog reads of collector and dispatcher state.

**Tech Stack:** Python 3 standard library (`dataclasses`, `fcntl`, `hashlib`, `json`, `os`, `pathlib`, `secrets`), pytest fault injection, Vitest subprocess integration tests, shell deployer tests, JSON runtime manifests.

**Status:** Active

**Issue:** #2463

**Design:** `docs/superpowers/specs/2026-07-28-controller-state-recovery-integrity-design.md`

## Global Constraints

- Preserve the existing top-level payload shape. `_controllerState` is the only reserved root member.
- The first cohort is collector state, watchdog state, dispatcher incident state, and every direct reader of those three documents.
- Do not broaden this patch to q-loop, sentinel, GUI session monitor, deadman health, maintenance windows, or selfcheck memory.
- Do not treat a parseable file, successful rename, or fresh mtime as proof of a durable commit.
- Do not log raw state, exceptions, paths, evidence filenames, identifiers, destinations, topology, environment values, or private integrity digests.
- Use exit code `78` (`STATE_RECOVERY_REQUIRED_EXIT`) for a controller cycle that cannot establish or reconcile state authority. Dispatcher daemon mode must exit on this condition rather than catch and continue.
- A Python write capability is opaque, helper-created, object-identity checked, component/store/path bound, generation bound, lock bound, and single-use. It is not described as cryptographically unforgeable inside a compromised interpreter.
- Each successful save consumes its capability and returns a fresh capability bound to the newly committed generation. This permits the dispatcher's existing save-before-terminal-move barriers without releasing the cycle lock.
- Lock order is dispatcher process lock, then dispatcher incident-state lock. No new code may acquire those locks in reverse order.
- Collector and watchdog deliberately hold their owner-state lock across remote/probe or lifecycle work. Cross-read timeout is a typed `unavailable`, never permission to parse an unvalidated file.
- Preserve initial RED output and the syscall-boundary counter for every injected durability failure. A mocked failure that did not reach its asserted boundary is inconclusive.
- Preserve raw legacy fixtures where they prove migration or `legacy_valid`; do not mechanically convert all fixtures to envelopes.
- Keep #2463 labeled `IN PROGRESS` until the implementation, exact-head verification, draft PR, issue backlink confirmation, and remaining-cohort disposition are complete. Do not use `PATCH READY` earlier.
- Recheck PR #2615 immediately before editing and immediately before publication. Regenerate manifests and work-index artifacts from the composed tree.

Before the first TypeScript test in a fresh worktree, establish the pinned runtime
and exact lockfile dependencies:

```bash
bash scripts/run-with-pinned-npm.sh --version
if [ ! -x node_modules/.bin/vitest ]; then
  bash scripts/run-with-pinned-npm.sh ci
fi
```

Expected: npm runs under the repository-pinned Node version and
`node_modules/.bin/vitest` exists. A missing pinned runtime, failed install, or
offline dependency resolution is inconclusive, not a passing test.

## Shared Interface Contract

Implement these public names in `deploy/scripts/lib/controller_state.py`. Internal sidecar records and filesystem helpers remain private.

```python
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

JsonObject = dict[str, Any]
StateComponent = Literal["collector", "heartbeat-watchdog", "dispatcher-incident"]
StateMode = Literal["bootstrap", "valid", "recovered", "reconciled", "recovery_required"]
ReadMode = Literal["valid", "legacy_valid", "recovery_pending", "unavailable"]
RecoveryOutcome = Literal["validated_previous_only", "authoritative_reconciliation"]
StateReason = Literal[
    "read_failed",
    "unsafe_file",
    "decode_failed",
    "invalid_root",
    "schema_incompatible",
    "integrity_mismatch",
    "generation_invalid",
    "publication_ambiguous",
    "evidence_preservation_failed",
    "lock_unavailable",
]

@dataclass(frozen=True)
class StateDiagnostic:
    component: StateComponent
    mode: StateMode
    current_generation: int | None
    recovered_generation: int | None
    reason: StateReason | None
    recovery_receipt_id: str | None
    occurrence_count: int

@dataclass(frozen=True)
class StateLoadResult:
    mode: StateMode
    payload: JsonObject | None
    capability: "StateWriteCapability | None"
    diagnostic: StateDiagnostic

@dataclass(frozen=True)
class StateReadResult:
    mode: ReadMode
    payload: JsonObject | None
    generation: int | None
    reason: StateReason | None

@dataclass(frozen=True)
class StateCommitResult:
    mode: Literal["valid", "reconciled"]
    generation: int
    capability: "StateWriteCapability"
    diagnostic: StateDiagnostic

class ControllerStateSession:
    """Verified directory, stable lock, current authority, and publication state."""

class ControllerStateRequired(RuntimeError):
    """Content-free process-boundary signal carrying a private diagnostic attribute."""
```

`StateWriteCapability` has no public constructor. `ControllerStateSession.save()` invalidates the supplied capability and returns a replacement only after the new generation, marker, and journal removal are durable. `complete_reconciliation()` accepts only a reconciliation-only capability and returns a normal capability after the receipt reaches `reconciled`.

`ControllerStateSession` is an explicit context manager. `__enter__()` returns the
session; `__exit__()` calls idempotent `close()` on success or exception; and
`close()` invalidates every issued capability, releases the lock, and closes all
verified descriptors. No operation is accepted after close. The exact session methods are `load() -> StateLoadResult`,
`reload() -> StateLoadResult`, `save(payload, capability) -> StateCommitResult`,
and `complete_reconciliation(payload, capability, *, outcome) ->
StateCommitResult`. The constructors are `open_controller_state(path, *,
component, bootstrap, validate_payload, lock_timeout_seconds, clock=None,
random_bytes=None, file_ops=None) -> ControllerStateSession` and
`read_controller_state(path, *, component, validate_payload,
lock_timeout_seconds, file_ops=None) -> StateReadResult`. `file_ops` defaults to
the real standard-library syscalls and permits boundary-level fault injection in
tests; it is never selected from configuration or environment. The emergency projection is
`emit_state_recovery_fallback(diagnostic) -> None`; the safe ordinary-log mapping
is `state_diagnostic_details(diagnostic) -> dict[str, Any]`.
`ControllerStateRequired(diagnostic)` retains the typed diagnostic for local
handling, while `str(error)` is always the constant
`"controller state recovery required"`.
`complete_reconciliation()` returns a `StateCommitResult` whose mode and diagnostic
are `reconciled`; the adapter projects that exact result before reload. The next
`reload()` returns `valid` for the reconciled generation and replaces the
previously issued capability, so the observable transition is exactly
`recovered` → `reconciled` → `valid`.

The three component adapters use these exact component identifiers and bootstrap payloads:

```python
COLLECTOR_STATE_COMPONENT = "collector"
WATCHDOG_STATE_COMPONENT = "heartbeat-watchdog"
DISPATCHER_STATE_COMPONENT = "dispatcher-incident"

def collector_bootstrap_state() -> dict[str, Any]:
    return {"remotes": {}}

def watchdog_bootstrap_state() -> dict[str, Any]:
    return {"version": 1, "open": {}, "pendingStale": {}, "recentlyRecovered": {}}

def dispatcher_bootstrap_state() -> dict[str, Any]:
    return {"version": 1, "openIncidents": {}, "lastSentAt": {}}
```

## Reconciliation Source Decision

The first patch records an explicit source decision before calling
`complete_reconciliation()`:

| Component | Candidate evidence | Decision |
| --- | --- | --- |
| Collector | Remote queues, claims, acknowledgements, and probe results | Not a complete local lifecycle ledger. Recovery mode forbids remote work, and absence cannot prove acknowledgement, closure, cooldown reset, or backoff reset. Commit the validated previous payload unchanged with `validated_previous_only`. |
| Heartbeat watchdog | Current probes plus watchdog outbox/archive events | Not a complete retained lifecycle ledger. Probes have not run before recovery reconciliation, and event archives are effect records rather than complete incident authority. Commit the validated previous payload unchanged with `validated_previous_only`. |
| Dispatcher | Outbox, processing, sent, suppressed, storm-collapsed, manifests, and dead letters | Not a complete monotonic incident ledger: artifacts are moved, coalesced, pruned, retried, and may contain both stale alerts and later clears. They cannot safely recreate membership, clocks, counters, or closure. Commit the validated previous payload unchanged with `validated_previous_only`. |

Each component implements a named `reconcile_recovered_*_state()` adapter returning
the payload and bounded outcome. Tests seed apparently useful but incomplete
candidate evidence and prove it cannot authorize a new onset, stale clear, clock
rewind, retry-budget reset, cooldown reset, suppression reset, or counter reset.
If execution discovers a complete authoritative ledger, stop and amend the design
and this table before using `authoritative_reconciliation`.

## Task 1: Establish the RED Shared Contract and Fault Harness

**Files:**

- Create: `deploy/scripts/tests/test_controller_state.py`
- Inspect for reuse: `deploy/scripts/lib/sentinel_pin.py`
- Inspect for diagnostic conventions: `deploy/scripts/lib/controller_log.py`
- Reference: `docs/superpowers/specs/2026-07-28-controller-state-recovery-integrity-design.md`

**Interfaces consumed:** The shared interface contract above.

**Interfaces produced:** A deterministic fault harness and executable state-machine acceptance suite.

- [ ] Add a local `load_controller_state_module()` import helper, deterministic UTC clock, deterministic random-byte source, component validator, and a `FaultOps` syscall adapter that records `open`, `fstat`, `read`, `write`, `fsync_file`, `fsync_directory`, `replace`, `unlink`, and `flock` boundaries before optionally raising.

```python
def validate_probe_payload(raw: Mapping[str, Any]) -> dict[str, Any]:
    payload = dict(raw)
    if "_controllerState" in payload:
        raise ValueError("reserved controller state member")
    counters = payload.get("counters", {})
    if not isinstance(counters, dict):
        raise ValueError("counters must be an object")
    return payload
```

- [ ] Add parametrized RED tests for canonical JSON: sorted keys, UTF-8 without ASCII escaping, ordered arrays, stable integers, and rejection of `NaN`, positive infinity, negative infinity, booleans in generation fields, unknown `_controllerState` members, and unsupported future versions.
- [ ] Add RED tests for pristine bootstrap, preexisting trusted-lock-only bootstrap, marker-without-generation failure, pristine legacy writer migration, read-only `legacy_valid` without writes, established-store legacy rollback, valid current without rewrite, store/component mismatch, marker tamper, journal tamper, receipt tamper, high-water rollback, future format, and semantically invalid component payload.
- [ ] Add RED trust tests for a symlinked ancestor, symlinked lock/primary/previous/marker/journal/receipt leaf, non-regular leaf, owner mismatch, group/world-writable directory, non-private managed file, and identity replacement between inspection and use. Assert no `chmod`, move, overwrite, or target read occurs.
- [ ] Add RED capability tests for absent, stale, reused, released, wrong-component, wrong-store, wrong-path, wrong-generation, ordinary-on-recovered, and reconciliation-on-normal capabilities. Assert a committed save returns a distinct fresh capability.
- [ ] Add transition tests proving recovered load, reconciled commit diagnostic, and valid reload occur in that order; the reconciled receipt metadata must not be lost or repeated as reconciled forever.
- [ ] Add exception tests proving `ControllerStateRequired` retains its typed diagnostic without rendering the reason, receipt, path, raw exception, or payload through `str()` or `repr()`.
- [ ] Add RED lock tests for exclusive overlap, bounded timeout, shared reader during exclusive ownership, context-manager exit on success, context-manager exit on exception, explicit double-close, use after close, and lock persistence after session close. Assert capabilities are invalidated, descriptors are closed, and the stable lock leaf is never unlinked.
- [ ] Add RED recovery tests for truncated primary, wrong-root primary, and integrity-mismatched primary with a valid previous. Assert one receipt ID is reused, damaged bytes are preserved before primary replacement, the result is `recovered`, and only `complete_reconciliation(result.payload, result.capability, outcome="validated_previous_only")` can advance above marker high-water.
- [ ] Add a restart-retry test proving the same canonical recovery receipt ID and evidence identity are reused, `occurrenceCount` increments and saturates at `MAX_OCCURRENCE_COUNT = 2**31 - 1`, no second recovery identity/log storm appears, and emergency fallback remains once per process invocation.
- [ ] Add valid-current/invalid-previous save tests. Successful preservation must fsync the immutable evidence file and its directory before replacing previous; injected evidence write, file-fsync, or directory-fsync failure must leave both previous and primary byte-for-byte unchanged.
- [ ] Add RED failure cases for no previous, corrupt previous, cross-store previous, future primary, evidence write failure, evidence file fsync failure, evidence directory fsync failure, state directory full, and permission denial. Assert `payload is None`, `capability is None`, and no retained authority is overwritten.
- [ ] Add the transaction crash matrix at every durable phase: journal prepared, previous temp fsynced, previous renamed, previous directory synced, primary temp fsynced, primary renamed, primary directory synced, marker renamed, marker directory synced, journal phase advanced, journal removed, and journal-removal directory synced. Each test must assert its expected syscall counter is nonzero.
- [ ] Add restart tests for `prepared`, `previous_committed`, `primary_committed`, `marker_committed`, recovery `planned`, `evidence_preserved`, `restored`, and `reconciliation_prepared`. Exact matching state resumes; any envelope/sidecar mismatch returns `recovery_required`.
- [ ] Add reconciliation-stage falsifiers for receipt/marker/recovered/journal
  cross-binding, regular-file and symlink substitution after verified read, and
  crashes after temp open, write, file sync, close, durable-stage rename, and
  directory sync. Require restart to reuse the exact target and leave no stage.
- [ ] Add closed-classifier controls proving `.state.json.notes` does not block
  pristine bootstrap or sole-legacy `legacy_valid`, while every exact atomic
  temporary and receipt-derived reconciliation stage grammar fails closed.
- [ ] Add RED diagnostic tests proving the stderr line is one bounded JSON object with only schema version, component, state mode, bounded reason, known generation counters, opaque receipt ID, and occurrence count. Assert raw exception text, paths, evidence names, payload keys/values, environment values, and integrity digests are absent. Inject stderr failure and assert the typed non-success remains.
- [ ] Run the RED suite and save the failure summary in the implementation task notes:

```bash
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
"${PYTEST_CMD[@]}" deploy/scripts/tests/test_controller_state.py --import-mode=importlib -q
```

Expected: FAIL because `deploy/scripts/lib/controller_state.py` and the contract do not exist. A collection skip or missing pytest is inconclusive.

- [ ] Commit the RED tests:

```bash
git add deploy/scripts/tests/test_controller_state.py
git commit -m "test: specify controller state recovery contract"
```

## Task 2: Implement the Shared State Engine

**Files:**

- Create: `deploy/scripts/lib/controller_state.py`
- Modify: `deploy/scripts/tests/test_controller_state.py`
- Modify: `deploy/scripts/lib/controller_log.py`
- Modify: `deploy/scripts/tests/test_controller_log.py`

**Interfaces consumed:** `validate_payload`, bootstrap factory, deterministic fault adapter.

**Interfaces produced:** `ControllerStateSession`, typed load/read results, durable commits, recovery, and closed diagnostics.

- [ ] Implement closed constants, dataclasses, strict UTC RFC 3339 validation, strict lowercase `hex32` store IDs, strict lowercase `hex64` digests, exact integer generation checks, and payload deep-copy validation.
- [ ] Set `MAX_GENERATION = 2**53 - 1`; accept only non-boolean integers from 0 through that value. Generation 0 is bootstrap/migration-only, normal saves use current plus 1, and reconciliation uses marker high-water plus 1.
- [ ] Set `MAX_OCCURRENCE_COUNT = 2**31 - 1`; recovery retries increment with saturation and never allocate a replacement receipt ID.
- [ ] Implement canonical serialization with:

```python
json.dumps(
    value,
    ensure_ascii=False,
    allow_nan=False,
    separators=(",", ":"),
    sort_keys=True,
).encode("utf-8")
```

- [ ] Implement envelope integrity over `format`, `formatVersion`, `component`, `storeId`, `generation`, `writtenAt`, and the complete payload after removing `_controllerState`.
- [ ] Implement the exact initialized-marker fields: `format`, `formatVersion`, `component`, `storeId`, `highWaterGeneration`, `highWaterIntegritySha256`, and `integritySha256`.
- [ ] Implement the exact transaction fields: `format`, `formatVersion`, `component`, `storeId`, `transactionId`, `operation`, `phase`, `expectedGeneration`, `targetGeneration`, `expectedIntegritySha256`, `targetIntegritySha256`, `expectedHighWaterGeneration`, `targetHighWaterGeneration`, `expectedHighWaterIntegritySha256`, `targetHighWaterIntegritySha256`, `legacySourceSha256`, `previousEnvelope`, `targetEnvelope`, and `integritySha256`. Require `legacySourceSha256` only for migration and require null for every other operation. Permit null expected-generation/integrity fields only for the operation-specific bootstrap or migration preconditions.
- [ ] Implement the exact recovery fields: `format`, `formatVersion`, `component`, `storeId`, `recoveryReceiptId`, `reason`, `phase`, `occurrenceCount`, `markerHighWaterGeneration`, `markerHighWaterIntegritySha256`, `recoveredGeneration`, `recoveredIntegritySha256`, `targetGeneration`, `targetIntegritySha256`, and `integritySha256`. Permit null target fields only before `reconciliation_prepared`.
- [ ] Reject unknown members and any transaction operation outside `bootstrap`, `migration`, `normal`, `reconciliation`; transaction phase outside `prepared`, `previous_committed`, `primary_committed`, `marker_committed`; or recovery phase outside `planned`, `evidence_preserved`, `restored`, `reconciliation_prepared`, `reconciled`.
- [ ] Store those strict records at `<primary>.initialized`, `<primary>.transaction`, and `<primary>.recovery`; retain `<primary>.previous` and the stable `<primary>.lock`. Derive the immutable evidence leaf only from the opaque receipt ID plus a fixed suffix, without writing its name into the receipt or any diagnostic.
- [ ] Implement descriptor-relative directory traversal and leaf access using `os.open(leaf_name, flags | os.O_NOFOLLOW, dir_fd=directory_fd)`, `fstat`, owner/mode/type checks, and identity revalidation. Use the confinement pattern from `sentinel_pin.py`; do not import its private functions or copy its best-effort behavior.
- [ ] Implement a never-unlinked `state.json.lock`, bounded `flock`, exclusive owner sessions, and shared read sessions. Keep verified directory and lock descriptors alive for the session.
- [ ] Implement the pristine-store classifier. The trusted stable lock is coordination-only and is excluded from the authority-bearing artifact set. Bootstrap is available when marker, primary, previous, journal, receipt, and evidence are absent even if the lock already exists. A sole valid legacy primary is eligible for writer migration or read-only `legacy_valid`; every other marker-free authority posture fails closed.
- [ ] Classify authority artifacts with closed full-match grammars, never a broad
  state-name prefix: atomic temporaries are
  `.<primary>[.previous|.initialized|.transaction|.recovery].<hex32>.tmp`;
  reconciliation uses only
  `.<primary>.<recoveryReceiptId>.reconciliation-journal.tmp` and
  `.<primary>.<recoveryReceiptId>.reconciliation-journal`, plus the cleanup-only
  `.<primary>.<recoveryReceiptId>.reconciliation-journal.claim.<hex32>`.
  Established owner and shared-reader paths reject every exact random atomic
  temporary and cleanup claim; unrelated state-prefixed siblings stay benign.
- [ ] Implement journaled bootstrap and legacy migration. Bind migration to the exact trusted legacy bytes in `legacySourceSha256`; a `prepared` restart revalidates those bytes before publication and changed legacy bytes return `recovery_required`. Create the initialized marker at high-water generation 0, retain an integrity-bound generation 0 previous, publish generation 1, advance the marker, remove the journal, and sync every namespace mutation.
- [ ] Implement normal save ordering exactly as the design: validate payload; preserve invalid previous evidence; durable `prepared` journal; durable previous; `previous_committed`; durable primary; `primary_committed`; durable marker; `marker_committed`; durable journal removal.
- [ ] Implement restart reconciliation for all journal phases. Only the journal's exact integrity-validated previous, target, and marker may resume. A visible rename without proven directory sync returns `publication_ambiguous`, never a success receipt.
- [ ] Implement automatic recovery using a canonical receipt and one immutable evidence copy. Keep marker high-water unchanged when restoring previous bytes as primary. Return a reconciliation-only capability.
- [ ] Implement reconciliation preparation and commit. Publish the canonical
  journal through the exact receipt-owned temp and durable stage, syncing file and
  namespace at each boundary. On retry, remove only a verified exact incomplete
  temp or revalidate/resync the durable stage; never accept a substituted path.
  Before occurrence increment, receipt advancement, or promotion, cross-bind the
  receipt, actual marker, retained/recovered envelope, and journal expected/target
  fields. Reopen the stage immediately before promotion, atomically publish the
  cached verified bytes through a separately owned canonical transaction
  temporary, and reopen the canonical transaction afterward, requiring exact
  bytes before resumption. Never rename the stage pathname into canonical
  authority. Claim temp/stage cleanup sources under the closed quarantine grammar
  while holding the verified descriptor, then require cached bytes plus the
  pre-claim identity before unlinking the claim. Commit above marker high-water,
  advance the receipt to `reconciled`, and return a normal fresh capability.
- [ ] Enforce closed phase postures: `restored` may own no stage, its exact
  incomplete temp, or its exact durable stage;
  `reconciliation_prepared` owns either that stage or the promoted transaction;
  it may briefly own both after canonical publication and before verified stage
  cleanup; `reconciled` owns none. A crash after source-to-claim rename is an
  explicit typed fail-closed posture whose claim bytes remain unchanged.
  Mismatched receipt IDs, extra artifacts, and mixed-version postures fail closed
  without cleanup or mutation.
- [ ] Implement `read_controller_state()` with the exhaustive union `valid`, `legacy_valid`, `recovery_pending`, `unavailable`. It must copy a validated payload under a shared lock and release the lock before returning.
- [ ] Require read-only validation to reject a valid retained generation equal to
  or above the primary outside an exact recovery posture. Map restored rereads,
  post-save and post-reconciliation identity reads, and lock-recheck close errors
  to typed results/exceptions while closing every opened descriptor.
- [ ] After durable normal save, legacy migration, direct reconciliation, and
  reconciliation restart, reopen the primary and compare exact bytes with the
  committed target. Missing or substituted primaries are
  `publication_ambiguous`; do not use filesystem-dependent assertions.
- [ ] Implement `emit_state_recovery_fallback()` with a direct bounded `os.write(2, encoded_line)`, one attempt per process invocation, no exception formatting, and no environment inspection.
- [ ] Implement `state_diagnostic_details()` and add RED controller-log projection tests for the exact state modes, bounded reasons, generation counters, occurrence count, and an opaque 32-character recovery receipt ID. Add one narrowly allowlisted `recoveryReceiptId` validator to `metadata_only_controller_details()`; do not relax the general rule that ID-like keys and arbitrary strings are removed.
- [ ] Add narrow key-aware metadata allowlists for every exact `stateMode` and
  state `reason`, with unknown enum strings dropped. Keep the component only in
  the controller-log outer envelope and prove the full projected
  `controller_state_mode` record end to end.
- [ ] Specify and test the adapter projection contract: each component task implements a narrow `project_*_state_mode(diagnostic)` wrapper that calls `write_controller_log()` directly with record kind `controller_state_mode`, closed details, the controller's existing private append and health sinks, and `emit_fallback=lambda _line: emit_state_recovery_fallback(diagnostic)`. This replaces the generic fallback for this record and guarantees at most one state-specific stderr line.
- [ ] Implement `ControllerStateSession.__enter__()`, `__exit__()`, and idempotent `close()` before making any adapter hold a lock across domain work.
- [ ] Implement the shared content-free `ControllerStateRequired` exception and export it for all three process boundaries.
- [ ] Run focused tests until green:

```bash
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
"${PYTEST_CMD[@]}" \
  deploy/scripts/tests/test_controller_state.py \
  deploy/scripts/tests/test_controller_log.py \
  --import-mode=importlib -q
```

Expected: PASS with every fault-boundary assertion exercised and no skips.

- [ ] Run static compilation:

```bash
python3 -m py_compile \
  deploy/scripts/lib/controller_state.py \
  deploy/scripts/lib/controller_log.py \
  deploy/scripts/tests/test_controller_state.py \
  deploy/scripts/tests/test_controller_log.py
```

Expected: exit 0.

- [ ] Commit the engine:

```bash
git add \
  deploy/scripts/lib/controller_state.py \
  deploy/scripts/lib/controller_log.py \
  deploy/scripts/tests/test_controller_state.py \
  deploy/scripts/tests/test_controller_log.py
git commit -m "feat: add durable controller state recovery"
```

## Task 3: Integrate Collector State Before Remote Effects

**Files:**

- Modify: `deploy/scripts/bot-errors-collector.py`
- Create: `deploy/scripts/tests/test_bot_errors_collector_state_recovery.py`
- Extend: `tests/scripts/bot-errors-collector.test.ts`

**Interfaces consumed:** `open_controller_state`, `StateLoadResult`, `StateCommitResult`, closed fallback.

**Interfaces produced:** Collector validator, one lock-held owner cycle, explicit state failure exit.

- [ ] Write RED tests for collector bootstrap, legacy migration without value changes, valid-state generation advancement, corrupt primary recovery retaining remote failures/backoff/open-alert/cooldown/acknowledgement state, invalid-both fail-stop, and restart after reconciliation.
- [ ] Add normal-save transform tests: ordinary saves must persist `redacted_collector_payload(state)`, while `validated_previous_only` reconciliation preserves the validated recovered payload without a timestamp/redaction rewrite.
- [ ] Add candidate-evidence tests proving remote configuration, claimed entries, acknowledgements, and probe fixtures are not a complete local ledger and cannot change recovered membership, clocks, cooldowns, backoff, retry budgets, suppression, or counters. Implement `reconcile_recovered_collector_state()` to return an unchanged validated copy plus `validated_previous_only`.
- [ ] In forbidden-effect tests, monkeypatch every remote/probe/claim/ack/outbox seam and assert zero calls. Snapshot directory entries and bytes before `run_once`; on `recovery_required`, require every domain/outbox/owned-state artifact to remain identical. Exempt only the exact private recovery evidence/receipt, controller log, and controller-log-health artifacts, and assert each exempt diagnostic has the closed schema and no raw content.
- [ ] Add a subprocess integration test that supplies corrupt state and harmless fake remote configuration, then asserts exit `78`, no local outbox artifact, and a content-free stderr object.
- [ ] Run RED:

```bash
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
"${PYTEST_CMD[@]}" deploy/scripts/tests/test_bot_errors_collector_state_recovery.py -q
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/bot-errors-collector.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: new recovery tests FAIL against corrupt-to-empty `load_state()`.

- [ ] Replace `load_state()` and `save_state()` with `collector_bootstrap_state()` and `validate_collector_state()`. The validator must preserve the current root domains (`remotes`, alert/cooldown state, acknowledgement contributors, configured remote lists, and timestamps), reject a non-object `remotes`, and return a sanitized copy without `_controllerState`.
- [ ] Open the collector session at the start of `run_once()` before `reset_tailscale_cache()`, configuration-derived mutation, remote parsing/probing, claims, acknowledgement mutation, or outbox creation.
- [ ] Handle modes exhaustively:

```python
result = session.load()
project_collector_state_mode(result.diagnostic)
if result.mode == "recovery_required":
    raise ControllerStateRequired(result.diagnostic)
if result.mode == "recovered":
    committed = session.complete_reconciliation(
        result.payload,
        result.capability,
        outcome="validated_previous_only",
    )
    project_collector_state_mode(committed.diagnostic)
    result = session.reload()
    project_collector_state_mode(result.diagnostic)
if result.mode not in {"bootstrap", "valid", "reconciled"}:
    raise ControllerStateRequired(result.diagnostic)
```

- [ ] Keep the exclusive state session open through the remote cycle and final save. Use the capability returned by the load/reconciliation result. Do not expose the capability to remote helpers.
- [ ] Before each ordinary save, apply `redacted_collector_payload(state)` in the adapter. Do not apply that transform inside unchanged-payload recovery reconciliation.
- [ ] Project every typed load, recovery, reconciliation, and `recovery_required` result through `project_collector_state_mode()`. The canonical private receipt remains the durable recovery source; the controller log receives only the closed projection. Its injected fallback owns the once-per-process state-specific stderr line. The projection itself creates no outbox/domain effect.
- [ ] Add `STATE_RECOVERY_REQUIRED_EXIT = 78`; catch `ControllerStateRequired` only at the collector process boundary. One-shot mode returns 78. Daemon mode exits 78 so the service manager's existing throttle owns retries.
- [ ] Run focused GREEN tests:

```bash
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
"${PYTEST_CMD[@]}" \
  deploy/scripts/tests/test_bot_errors_collector_state_recovery.py \
  deploy/scripts/tests/test_bot_errors_collector_backoff.py \
  deploy/scripts/tests/test_bot_errors_collector_capture_escalation.py \
  deploy/scripts/tests/test_bot_errors_collector_preflight_liveness.py \
  deploy/scripts/tests/test_bot_errors_collector_reachability.py -q
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/bot-errors-collector.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: PASS with no skips.

- [ ] Commit collector integration:

```bash
git add deploy/scripts/bot-errors-collector.py deploy/scripts/tests/test_bot_errors_collector_state_recovery.py tests/scripts/bot-errors-collector.test.ts
git commit -m "fix: fail closed on collector state loss"
```

## Task 4: Integrate Watchdog Ownership and Cross-Reader Validation

**Files:**

- Modify: `deploy/scripts/bot-errors-heartbeat-watchdog.py`
- Create: `deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_state_recovery.py`
- Modify: `deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_intent.py`
- Modify: `deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_roster.py`
- Modify: `deploy/scripts/tests/test_bot_errors_daily_health_freshness_ledger.py`
- Extend: `tests/scripts/bot-errors-heartbeat-watchdog.test.ts`

**Interfaces consumed:** Exclusive owner session and shared read-only snapshots.

**Interfaces produced:** Watchdog validator, preflighted reconciliation, validated collector/dispatcher reads.

- [ ] Write RED owner tests for bootstrap, legacy migration, valid state, retained `open`, `pendingStale`, `recentlyRecovered`, suppression/escalation counters, recovered state reconciliation, and invalid-both fail-stop.
- [ ] Add normal-save transform tests: ordinary saves must persist `redacted_watchdog_payload(state)` with a fresh `updatedAt`, while `validated_previous_only` reconciliation preserves the recovered payload unchanged.
- [ ] Seed current-probe and archived-event candidate evidence and prove it cannot authorize a new onset, stale clear, escalation/suppression reset, pending-stale reset, recently-recovered reset, or clock rewind. Implement `reconcile_recovered_watchdog_state()` to return an unchanged validated copy plus `validated_previous_only`.
- [ ] Assert `recovery_required` occurs before `collect_problems()`, alert/clear creation, suppression mutation, append-log domain records, and state replacement. Require every domain/outbox/owned-state artifact to remain unchanged. Exempt only the exact private recovery evidence/receipt, controller log, and controller-log-health artifacts, and assert each exempt diagnostic has the closed schema and no raw content.
- [ ] Add parametrized cross-reader tests for `valid`, `legacy_valid`, `recovery_pending`, and `unavailable` collector snapshots in `collector_configured_hosts()`, `collector_best_effort_hosts()`, `collector_reachability_evidence()`, and `collector_roster_drift_problem()`.
- [ ] Add the same four read modes for dispatcher incident state in `daily_health_freshness_ledger_age()`. For `recovery_pending` and `unavailable`, assert no top-level payload member is consumed and the returned reason is bounded.
- [ ] Add RED service-intent tests for systemd `ExecMainStatus=78` and launchd last-exit-status 78. When dispatcher or collector heartbeat is stale after that exit, classify the problem as `state_recovery_required` with component and exit code only; never include service-manager stderr or a path.
- [ ] Keep the collector file-age probe metadata-only; add a regression assertion that it never calls the payload snapshot adapter.
- [ ] Run RED:

```bash
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
"${PYTEST_CMD[@]}" \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_state_recovery.py \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_intent.py \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_roster.py \
  deploy/scripts/tests/test_bot_errors_daily_health_freshness_ledger.py -q
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/bot-errors-heartbeat-watchdog.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: new cases FAIL because current code loads corrupt/missing state as empty and direct readers bypass integrity validation.

- [ ] Replace owned `load_state()`/`save_state()` with `watchdog_bootstrap_state()` and `validate_watchdog_state()`. Normalize `open`, `pendingStale`, and `recentlyRecovered` only after the root is trusted.
- [ ] Open the watchdog state session in `run_once()` before `collect_problems()`. Pass an already-authoritative state cycle to `reconcile()`; remove the internal reopen at its start and the path-based save at its end.
- [ ] For `recovered`, commit unchanged `validated_previous_only`, project the `reconciled` commit diagnostic, reload under the same lock, then collect problems only from `valid`. For `recovery_required`, call `project_watchdog_state_mode(result.diagnostic)` and then raise `ControllerStateRequired`; only the projection wrapper's failed/unsafe log path invokes fallback.
- [ ] Before each ordinary save, apply `redacted_watchdog_payload(state)` and set `updatedAt = now_iso()` in the adapter. Do not apply those transforms inside unchanged-payload recovery reconciliation.
- [ ] Project every typed load, recovery, reconciliation, and `recovery_required` result through `project_watchdog_state_mode()`, using the direct controller-log wrapper and state-specific fallback defined in Task 2. Add assertions for all five owner modes, no outbox/domain effect, and absence of the private digest and raw receipt. Catch `ControllerStateRequired` at `main()` and return 78.
- [ ] Add `read_collector_state_snapshot()` and `read_dispatcher_incident_snapshot()` wrappers using the shared API and component validators. Consume payload only for `valid` and `legacy_valid`.
- [ ] Extend the watchdog's existing service-intent query to return the closed classification `state_recovery_required` for exit 78. Consult it only after a collector/dispatcher heartbeat is missing or stale, so a running healthy service is not reclassified from historical exit data.
- [ ] Ensure roster diagnostics preserve their existing domain policy while state-integrity failures use bounded classes. Do not project the private receipt digest, raw path, or raw exception.
- [ ] Run GREEN:

```bash
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
"${PYTEST_CMD[@]}" \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_state_recovery.py \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_auth.py \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_browser_debug.py \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_intent.py \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_local_health_retry.py \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_roster.py \
  deploy/scripts/tests/test_bot_errors_daily_health_freshness_ledger.py -q
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/bot-errors-heartbeat-watchdog.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: PASS with no skips.

- [ ] Commit watchdog integration:

```bash
git add \
  deploy/scripts/bot-errors-heartbeat-watchdog.py \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_state_recovery.py \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_roster.py \
  deploy/scripts/tests/test_bot_errors_daily_health_freshness_ledger.py \
  tests/scripts/bot-errors-heartbeat-watchdog.test.ts
git commit -m "fix: preserve watchdog lifecycle state"
```

## Task 5: Give Dispatcher One State Cycle and Preserve Commit Barriers

**Files:**

- Modify: `deploy/scripts/bot-errors-dispatcher.py`
- Create: `deploy/scripts/tests/test_bot_errors_dispatcher_state_recovery.py`
- Modify: `deploy/scripts/tests/test_bot_errors_collapse_freshness.py`
- Modify: `deploy/scripts/tests/test_bot_errors_daily_health_freshness_ledger.py`
- Modify: `deploy/scripts/tests/test_bot_errors_dispatcher_test_leak.py`
- Extend: `tests/scripts/bot-errors-dispatcher.test.ts`

**Interfaces consumed:** Exclusive owner session, renewable single-use capability.

**Interfaces produced:** `IncidentStateCycle` and dispatcher-wide preflight.

- [ ] Add this private adapter to the dispatcher:

```python
class IncidentStateCycle:
    def __init__(
        self,
        session: ControllerStateSession,
        result: StateLoadResult,
    ) -> None:
        if result.payload is None or result.capability is None:
            raise ValueError("incident state cycle requires writable authority")
        self._session = session
        self._payload = result.payload
        self._capability = result.capability

    @property
    def payload(self) -> dict[str, Any]:
        return self._payload

    def commit(self) -> None:
        committed = self._session.save(self._payload, self._capability)
        self._capability = committed.capability
```

- [ ] Write RED preflight tests that seed corrupt primary/no previous and corrupt primary/corrupt previous, snapshot every queue directory name and byte sequence, call `run_once()`, and assert exit/failure occurs before writefail recovery, reclaim, provenance suppression, recovery dedupe, flap scan, alert suppression, storm collapse, claim, send, archive, sweep, prune, or `record_state`.
- [ ] Write RED recovery-equivalence tests covering `openIncidents`, `lastSentAt`, `testLeakDaily`, `flapState`, `transientState`, `staleAutocloseDigest`, `staleAutocloseHistory`, `promotionSafety`, and `dailyHealthFreshness`.
- [ ] Add normal-save transform tests: every ordinary `IncidentStateCycle.commit()` sets a fresh `updatedAt`, while `validated_previous_only` reconciliation leaves the recovered payload unchanged.
- [ ] Seed outbox, processing, sent, suppressed, storm-collapsed, manifest, and dead-letter evidence containing stale alerts and later clears. Prove it cannot authorize a new onset, stale clear, send-clock rewind, retry/promotion reset, suppression reset, freshness reset, or counter reset. Implement `reconcile_recovered_dispatcher_state()` to return an unchanged validated copy plus `validated_previous_only`.
- [ ] Add crash/restart tests at the dispatcher's existing save-before-terminal-move barriers. Verify a committed incident generation exists before storm member moves, recovery-duplicate moves, dead-letter moves, suppression moves, and sent archive moves.
- [ ] Add a repeated-save test proving each `IncidentStateCycle.commit()` consumes the old capability, installs a fresh one, increments the generation once, and keeps the same session lock.
- [ ] Run RED:

```bash
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
"${PYTEST_CMD[@]}" \
  deploy/scripts/tests/test_bot_errors_dispatcher_state_recovery.py \
  deploy/scripts/tests/test_bot_errors_collapse_freshness.py \
  deploy/scripts/tests/test_bot_errors_daily_health_freshness_ledger.py \
  deploy/scripts/tests/test_bot_errors_f12_flap_storm.py \
  deploy/scripts/tests/test_bot_errors_dispatcher_test_leak.py -q
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/bot-errors-dispatcher.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: new cases FAIL because current `process_one()` claims and rewrites queue entries before incident-state authority is loaded.

- [ ] Replace `load_incident_state()` and `save_incident_state()` with `dispatcher_bootstrap_state()` and `validate_dispatcher_state()`. Preserve the existing whitelist exactly and remove corrupt-file archive/log/empty fallback.
- [ ] Immediately after acquiring `dispatcher.lock`, open the incident-state session and load/reconcile it before `recover_writefail_breadcrumbs()`. For `recovered`, perform only unchanged `validated_previous_only` reconciliation, project the `reconciled` commit diagnostic, and reload to `valid`. For `recovery_required`, call `project_dispatcher_state_mode(result.diagnostic)` and then raise `ControllerStateRequired`; only the projection wrapper's failed/unsafe log path invokes fallback.
- [ ] Thread `IncidentStateCycle` through these exact signatures:

The exact signatures are:

- `flap_scan_outbox(paths: dict[str, Path], incident: IncidentStateCycle) -> int`
- `sweep_flap_storms(paths: dict[str, Path], incident: IncidentStateCycle) -> tuple[int, int]`
- `sweep_stale_incidents(paths: dict[str, Path], incident: IncidentStateCycle, skip_keys: set[str] | None = None) -> tuple[int, int, str | None]`
- `collapse_storm_group(paths: dict[str, Path], key: tuple[str, int], records: list[tuple[Path, dict[str, Any]]], incident: IncidentStateCycle) -> int`
- `collapse_ready_storms(paths: dict[str, Path], incident: IncidentStateCycle) -> int`
- `suppress_alerts_recovered_before_delivery(paths: dict[str, Path], incident: IncidentStateCycle) -> int`
- `suppress_ready_recovery_duplicates(paths: dict[str, Path], incident: IncidentStateCycle) -> int`
- `process_one(path: Path, paths: dict[str, Path], incident: IncidentStateCycle) -> tuple[bool, str]`

- [ ] Pass the full `IncidentStateCycle` to `collapse_storm_group()`, read `incident.payload` there, and call `incident.commit()` inside the group before its terminal member moves. Remove every secondary load at current lines 3195, 3242, 3323, 4076, 4140, 4274, 4800, and 5008 and every secondary path-based save at current lines 3233, 3269, 3595, 4021, 4281, 4816, 4901, 4927, and 5011.
- [ ] Replace those saves with `incident.commit()` at the same semantic barrier. Do not defer commits until the end of `run_once()`.
- [ ] Make ordinary `IncidentStateCycle.commit()` set `updatedAt = now_iso()` immediately before validation/save. Keep recovery reconciliation outside that method so it remains byte/semantic-unchanged.
- [ ] Remove the fail-open state-read catch from `flap_scan_outbox()`. It may remain fail-open per malformed queue member, but not per missing incident-state authority.
- [ ] Ensure `process_one()` receives preflighted state before `claim()`. Keep test-leak handling, attempt rewrite, send, and archive behavior after preflight.
- [ ] Add `STATE_RECOVERY_REQUIRED_EXIT = 78`. One-shot mode returns 78. Dispatcher daemon catches `ControllerStateRequired` separately and exits 78; it must not write the raw exception through `record_state()` or continue its loop.
- [ ] Project every typed load, recovery, reconciliation, and `recovery_required` result through `project_dispatcher_state_mode()`, using the direct controller-log wrapper and state-specific fallback defined in Task 2. Add assertions for all five owner modes, no queue/domain effect, and absence of the private digest and raw receipt.
- [ ] Run GREEN:

```bash
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
"${PYTEST_CMD[@]}" \
  deploy/scripts/tests/test_bot_errors_dispatcher_state_recovery.py \
  deploy/scripts/tests/test_bot_errors_collapse_freshness.py \
  deploy/scripts/tests/test_bot_errors_daily_health_freshness_ledger.py \
  deploy/scripts/tests/test_bot_errors_f12_flap_storm.py \
  deploy/scripts/tests/test_bot_errors_dispatcher_test_leak.py \
  deploy/scripts/tests/test_bot_errors_open_renotify_suppression.py \
  deploy/scripts/tests/test_bot_errors_transient_tiering.py \
  deploy/scripts/tests/test_bot_errors_autoclose_digest_coalesce.py \
  deploy/scripts/tests/test_bot_errors_orphan_clear_suppression.py -q
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/bot-errors-dispatcher.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: PASS with no skips.

- [ ] Commit dispatcher integration:

```bash
git add \
  deploy/scripts/bot-errors-dispatcher.py \
  deploy/scripts/tests/test_bot_errors_dispatcher_state_recovery.py \
  deploy/scripts/tests/test_bot_errors_collapse_freshness.py \
  deploy/scripts/tests/test_bot_errors_daily_health_freshness_ledger.py \
  deploy/scripts/tests/test_bot_errors_dispatcher_test_leak.py \
  tests/scripts/bot-errors-dispatcher.test.ts
git commit -m "fix: preflight dispatcher incident state"
```

## Task 6: Pin and Deploy the Complete Runtime Bundle

**Files:**

- Modify: `deploy/bot-errors-runtime-manifest.json`
- Modify: `deploy/source-runtime-manifest.json`
- Modify: `deploy/scripts/whatsoup-bot-errors-deploy.sh`
- Modify: `deploy/scripts/install-bot-errors-launchd.sh`
- Verify: `deploy/bot-errors-collector.service`
- Verify: `deploy/bot-errors-dispatcher.service`
- Verify: `deploy/bot-errors-heartbeat-watchdog.timer`
- Modify: `tests/scripts/check-bot-errors-runtime-manifest.test.ts`
- Modify: `tests/scripts/source-runtime-drift-check.test.ts`
- Modify: `tests/scripts/deployer-static-parity.test.ts`
- Modify: `deploy/scripts/tests/test_deployer_static.sh`
- Modify: `deploy/scripts/tests/test_deployer_mutation.sh`
- Modify: `tests/scripts/bot-errors-python-atomic-write-guard.test.ts`
- Modify: `tests/scripts/bot-errors-service-templates.test.ts`

**Interfaces consumed:** Final composed helper and controller files.

**Interfaces produced:** One integrity-pinned, isolated, deployable bundle.

- [ ] Add RED tests proving the helper is required by the runtime manifest, required by the deployer's literal `FILES`, importable from an isolated staged bundle, and represented in the source-runtime manifest with `importGraph: false`.
- [ ] Add RED service-template tests proving collector and dispatcher retain `RestartSec=10`, the heartbeat watchdog timer remains no faster than its existing bounded cadence, and the launchd dispatcher has explicit `ThrottleInterval=10` beside `KeepAlive`.
- [ ] Refactor the atomic-write guard so `controller_state.py` owns `O_EXCL`, `O_NOFOLLOW`, file fsync, directory fsync, `os.replace`, private mode, and descriptor confinement. For the three migrated controllers, assert import/use of the helper and absence of a second state writer. Preserve inline-writer assertions for non-migrated scripts.
- [ ] Run RED:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/check-bot-errors-runtime-manifest.test.ts \
  tests/scripts/source-runtime-drift-check.test.ts \
  tests/scripts/deployer-static-parity.test.ts \
  tests/scripts/bot-errors-python-atomic-write-guard.test.ts \
  tests/scripts/bot-errors-service-templates.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash deploy/scripts/tests/test_deployer_static.sh
bash deploy/scripts/tests/test_deployer_mutation.sh
```

Expected: FAIL until helper pinning/deployment and the shared-writer guard are complete.

- [ ] Add `deploy/scripts/lib/controller_state.py` to the deployer `FILES` array immediately beside the other shared Python helpers.
- [ ] Add `<key>ThrottleInterval</key><integer>10</integer>` to the launchd dispatcher definition. Do not shorten the systemd restart delay or watchdog timer cadence.
- [ ] Add the helper to `deploy/source-runtime-manifest.json` with `importGraph: false` and strict `mustContain` markers for `ControllerStateSession`, `read_controller_state`, `complete_reconciliation`, `O_NOFOLLOW`, and directory fsync.
- [ ] Compute final hashes from the composed working tree, then update the two manifests with `apply_patch`; do not hand-resolve hashes from another branch:

```bash
shasum -a 256 \
  deploy/scripts/lib/controller_state.py \
  deploy/scripts/lib/controller_log.py \
  deploy/scripts/bot-errors-collector.py \
  deploy/scripts/bot-errors-heartbeat-watchdog.py \
  deploy/scripts/bot-errors-dispatcher.py
```

Expected: five lowercase 64-character digests. Copy only those exact outputs into the matching manifest entries and add strict helper markers.
- [ ] Extend the staged-bundle test to copy exactly the deployer `FILES`, set a controlled import path, and import the helper plus all three controllers without ambient repository modules.
- [ ] Run GREEN:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/check-bot-errors-runtime-manifest.test.ts \
  tests/scripts/source-runtime-drift-check.test.ts \
  tests/scripts/deployer-static-parity.test.ts \
  tests/scripts/bot-errors-python-atomic-write-guard.test.ts \
  tests/scripts/bot-errors-service-templates.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash deploy/scripts/tests/test_deployer_static.sh
bash deploy/scripts/tests/test_deployer_mutation.sh
bash scripts/run-with-pinned-npm.sh run guard:bot-errors-runtime-manifest
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
bash scripts/run-with-pinned-npm.sh run guard:deployer-static
```

Expected: PASS and isolated imports exit 0.

- [ ] Commit bundle integration:

```bash
git add \
  deploy/bot-errors-runtime-manifest.json \
  deploy/source-runtime-manifest.json \
  deploy/scripts/whatsoup-bot-errors-deploy.sh \
  deploy/scripts/install-bot-errors-launchd.sh \
  tests/scripts/check-bot-errors-runtime-manifest.test.ts \
  tests/scripts/source-runtime-drift-check.test.ts \
  tests/scripts/deployer-static-parity.test.ts \
  deploy/scripts/tests/test_deployer_static.sh \
  deploy/scripts/tests/test_deployer_mutation.sh \
  tests/scripts/bot-errors-python-atomic-write-guard.test.ts \
  tests/scripts/bot-errors-service-templates.test.ts
git commit -m "build: deploy controller state recovery helper"
```

## Task 7: Document Health, Rollout, Rollback, and Residual Cohorts

**Files:**

- Modify: `deploy/scripts/README-bot-errors.md`
- Modify: `docs/publication-audit.md`
- Regenerate: `docs/work-index.json`
- Regenerate: `docs/work-index.md`
- Verify: `docs/superpowers/specs/2026-07-28-controller-state-recovery-integrity-design.md`

**Interfaces consumed:** Final modes, exit code, managed files, and test commands.

**Interfaces produced:** Operator-safe rollout/rollback and explicit scope disposition.

- [ ] Document the six managed sibling files, top-level compatibility, five owner modes, four read modes, exit 78, content-free diagnostic schema, and the rule that private integrity digests never enter ordinary health output.
- [ ] Document coherent bundle rollout: stop writers, verify complete bundle, deploy helper/writers/readers together, start services, confirm migrated state, and reject mixed old-writer/new-reader operation.
- [ ] Document bundle rollback: stop writers, preserve current store/evidence privately, verify prior bundle, restore it completely, and reconcile any post-migration generation before old writers run. Never delete the initialized marker or evidence.
- [ ] Add an explicit remaining-cohort table for q-loop, sentinel, GUI session monitor, deadman health, maintenance windows, and selfcheck memory. Each row must state “not migrated in #2463 first patch” and require an issue or owner-approved scope amendment before #2463 becomes `PATCH READY`.
- [ ] Verify this plan is tracked despite the repository's ignored planning root. If execution began from an uncommitted copy, force-add it before any generated audit/index write:

```bash
git ls-files --error-unmatch docs/superpowers/plans/2026-07-28-controller-state-recovery-integrity.md ||
  git add -f docs/superpowers/plans/2026-07-28-controller-state-recovery-integrity.md
```

- [ ] Verify the plan and updated design are present in `docs/publication-audit.md` as `PRIVATE-ARCHIVE` with sanitized rationales.
- [ ] Regenerate the work index:

```bash
bash scripts/run-with-pinned-node.sh scripts/work-index.ts
```

Expected: `docs/work-index.json` and `docs/work-index.md` include the plan and remain internally consistent.

- [ ] Run documentation/privacy gates:

```bash
bash scripts/run-with-pinned-npm.sh run guard:publication:all
bash scripts/run-with-pinned-npm.sh run guard:work-index
bash scripts/run-with-pinned-npm.sh run guard:doc-tally
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
```

Expected: PASS with zero privacy findings and zero stale generated artifacts.

- [ ] Commit documentation:

```bash
git add \
  deploy/scripts/README-bot-errors.md \
  docs/superpowers/plans/2026-07-28-controller-state-recovery-integrity.md \
  docs/superpowers/specs/2026-07-28-controller-state-recovery-integrity-design.md \
  docs/publication-audit.md \
  docs/work-index.json \
  docs/work-index.md
git commit -m "docs: explain controller state recovery rollout"
```

## Task 8: Run Exact-Head Verification and Independent Review

**Files:**

- Verify all changed files.
- Do not add generated evidence logs to git.

**Interfaces consumed:** Exact proposed commit and repository gates.

**Interfaces produced:** Reproducible verification record for the draft PR.

- [ ] Recheck the collision owner and changed paths:

```bash
gh pr view 2615 --json number,state,isDraft,headRefOid,files
git fetch origin main
git diff --name-only "$(git merge-base origin/main HEAD)" HEAD
```

Expected: record the current #2615 head and identify any overlapping dispatcher/manifest hunks before continuing.

- [ ] Run focused Python suites:

```bash
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
"${PYTEST_CMD[@]}" \
  deploy/scripts/tests/test_controller_state.py \
  deploy/scripts/tests/test_bot_errors_collector_state_recovery.py \
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_state_recovery.py \
  deploy/scripts/tests/test_bot_errors_dispatcher_state_recovery.py \
  --import-mode=importlib -q
```

Expected: PASS, no skips.

- [ ] Run all BOT ERRORS Python behavior and curated coverage/deployer gates:

```bash
bash deploy/scripts/run-sentinel-tests.sh
bash deploy/scripts/run-bot-errors-full-suite.sh
```

Expected: both print their success sentinel. A missing test runner or masked failure is inconclusive.

- [ ] Run controller and bundle TypeScript suites:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/bot-errors-collector.test.ts \
  tests/scripts/bot-errors-heartbeat-watchdog.test.ts \
  tests/scripts/bot-errors-dispatcher.test.ts \
  tests/scripts/bot-errors-python-atomic-write-guard.test.ts \
  tests/scripts/check-bot-errors-runtime-manifest.test.ts \
  tests/scripts/source-runtime-drift-check.test.ts \
  tests/scripts/deployer-static-parity.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: PASS, no retries, no skips.

- [ ] Run focused guards:

```bash
bash scripts/run-with-pinned-npm.sh run guard:bot-errors-runtime-manifest
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
bash scripts/run-with-pinned-npm.sh run guard:bot-errors-critical-surface
bash scripts/run-with-pinned-npm.sh run guard:bot-errors-simulation-matrix
bash scripts/run-with-pinned-npm.sh run guard:deployer-static
bash scripts/run-with-pinned-npm.sh run guard:durability-writer
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:publication:all
bash scripts/run-with-pinned-npm.sh run guard:work-index
bash scripts/run-with-pinned-npm.sh run guard:doc-tally
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
```

Expected: PASS.

- [ ] Run the complete branch gate on the exact head:

```bash
bash scripts/run-with-pinned-npm.sh run verify:push:branch
```

Expected: PASS. Record exact commit, command, duration, test counts, skipped checks, and fault boundaries. Report any unavailable or partially exercised lane as a gap.

- [ ] Obtain independent reviews for state-machine safety, filesystem durability, privacy projection, adapter effect ordering, and test integrity. Require each reviewer to report files inspected, evidence, validation, confidence, and claims the lead must verify.
- [ ] Lead-verify every Critical or Important review finding against the diff and tests. Fix confirmed findings with a new RED test, rerun affected gates, and request a fresh review.
- [ ] Run final hygiene:

```bash
git diff --check "$(git merge-base origin/main HEAD)" HEAD
git status --short
git log --format='%h %s%n%b' origin/main..HEAD
git diff --no-ext-diff --unified=0 "$(git merge-base origin/main HEAD)" HEAD -- \
  ':(exclude)package-lock.json' |
  rg -n -i -e 'Co-Authored-By|Generated with|localhost|/Users/|/home/|fleet|token|secret'
```

Expected: clean diff, intentional worktree contents only, no prohibited attribution, and every privacy match manually classified before publication.

## Task 9: Create the Draft PR and Update Issue Coordination

**Files:**

- No new source files unless publication review finds a defect.

**Interfaces consumed:** Exact-head verification record and remaining-cohort disposition.

**Interfaces produced:** Draft PR with reproducible proof and safe issue backlinks.

- [ ] Search for the repository PR template and structure the draft body from it. Include: issue `#2463`, systemic root cause, selected contract, component/readers covered, historical decisions, blast radius, privacy refinement from diagnostic digest to opaque receipt ID, exact tests, exact commit, rollback, known whole-store rollback limitation, and remaining cohorts.
- [ ] Write the draft body to `/tmp/whatsoup-pr-2463.md`, then invoke the guard's exported arbitrary-text scanner under the pinned runtime:

```bash
bash scripts/run-with-pinned-npm.sh exec -- tsx -e '
import { readFileSync } from "node:fs";
import { scanTextForPrivateLiterals } from "./scripts/publication-guard.ts";
const fileName = "/tmp/whatsoup-pr-2463.md";
const issues = scanTextForPrivateLiterals(fileName, readFileSync(fileName, "utf8"));
for (const issue of issues) console.error(`${issue.code}:${issue.line ?? 0}`);
process.exit(issues.length === 0 ? 0 : 1);
'
```

Expected: exit 0 and no output. Also manually confirm the title/body contain no local paths, host/user details, fleet details, raw logs, model/tool names, secrets, personal email, or private state values; those policy-only classes are not all covered by the literal scanner.
- [ ] Immediately before push/create, revalidate multi-agent ownership and deduplication:

```bash
gh issue view 2463 --json number,state,labels,comments
gh pr list --state open --search '"#2463" in:body' \
  --json number,title,isDraft,headRefName,url
gh pr list --state open --head "$(git branch --show-current)" \
  --json number,title,isDraft,headRefName,url
```

Expected: issue #2463 remains open with `IN PROGRESS` and the current owner's claim; no other open/draft PR owns #2463; and no PR already exists for this head. Abort publication and reconcile ownership if any check differs.
- [ ] Push with the SSH remote and create a draft PR:

```bash
git remote get-url origin
git push -u origin HEAD
gh pr create --draft --title "fix: recover controller state without lifecycle resets" --body-file /tmp/whatsoup-pr-2463.md
```

Expected: SSH remote and one draft PR referencing #2463.

- [ ] Confirm the automatic issue backlink by reading #2463 timeline/comments and the draft PR links. If the PR reference is present, do not add a redundant comment.
- [ ] If no automatic backlink exists, add one sanitized issue comment containing only the draft PR URL and a concise scope statement.
- [ ] Keep `IN PROGRESS` unless every remaining cohort is migrated or linked to an explicit approved follow-on issue with acceptance criteria. Only then replace `IN PROGRESS` with `PATCH READY`.
- [ ] Read back the issue labels, issue comment/timeline, PR draft status, PR body, head SHA, and checks. Report only confirmed public state.

## Historical Constraints to Recheck During Execution

- `b26e5b1c0` introduced the three corrupt/missing-to-empty loaders.
- `e324d5af3` added watchdog pending/recent recovery state that must survive.
- `025c61634` made dispatcher freshness state authoritative to the watchdog.
- `a78fe83e6` established incident-state-save-before-terminal-queue-move ordering.
- `65890e79c` and `6e1672766` established descriptor-confined no-follow inspection patterns.
- `51e78876e` established the manifest-tracked shared helper/controller adapter pattern.
- `c21ad6202` made the runtime manifest the deploy hash source of truth.

Do not copy private helper internals or best-effort fsync semantics blindly. Verify the decisive source and current tests at execution time.
