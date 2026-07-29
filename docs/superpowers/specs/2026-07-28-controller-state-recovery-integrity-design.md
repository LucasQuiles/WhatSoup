# Controller State Recovery Integrity Design

**Status:** Active — approved direction, written design awaiting owner review

**Issue owner:** #2463

**Design base:** `77df0ba5ac103c4ec41141d2cacc7e7fcc6dcace`

## Context

The BOT ERRORS collector, heartbeat watchdog, and dispatcher currently treat an
unreadable state document as an empty bootstrap state. A later ordinary save
replaces the damaged state with parseable JSON. That makes filesystem freshness
look healthy while lifecycle truth such as open incidents, send clocks, cooldowns,
backoff, pending recovery, and suppression state may have disappeared.

This design makes absence, valid state, recovered state, and unresolved corruption
different typed conditions. It retains one integrity-bound previous generation and
prohibits controller mutation when neither generation is trustworthy.

The design follows these repository decisions:

- Existing controller payload fields stay at the JSON root so mixed readers do not
  mistake a nested envelope for an empty state.
- Runtime helpers are manifest-tracked and deployed explicitly.
- Controller diagnostics are metadata-only. Damaged state bytes, identifiers,
  paths, messages, destinations, accounts, and topology never enter logs or public
  health output.
- File trust is established without following symlinks and before JSON parsing.
- A visible rename is not a durable commit unless both the file and containing
  directory are synchronized.

## Scope

The first #2463 implementation owns:

1. `bot-errors-collector.py` state;
2. `bot-errors-heartbeat-watchdog.py` state;
3. `bot-errors-dispatcher.py` incident state;
4. every direct reader of those state documents; and
5. one manifest-tracked shared controller-state helper with focused tests.

The patch coordinates with #2464 for the reusable private-state primitive, but
#2464 is not a second behavior owner. #2482 and #2485 remain separate issue owners:
this patch must correctly classify incomplete namespace durability and interrupted
publication for its own files, but it does not replace every controller atomic
writer or solve cross-filesystem moves generally.

The current broader state-loader census also includes q-loop, sentinel, GUI session
monitor, deadman health state, maintenance windows, and selfcheck memory. Those
owners have different safety policies and are not silently added to this first
patch. The shared contract and file format must support their later migration
without another format break. They remain explicit follow-on cohorts unless the
owner approves a scope amendment after reviewing this design. The owner approved
this bounded three-component first patch on 2026-07-28. #2463 must not be closed or
marked `PATCH READY` for the expanded census until each remaining cohort is either
migrated or assigned to an explicit follow-on issue with acceptance criteria.

Related queue-age normalization, archive retention, ordinary stale-incident
closure, and event-ledger reconciliation policy are non-goals. This patch may call
an authoritative reconciliation adapter, but does not invent a new event ledger.

## Goals

- Preserve lifecycle membership and counters across a damaged primary when one
  validated previous generation exists.
- Fail closed before domain mutation when no trustworthy generation exists.
- Keep first-run bootstrap distinct from loss or corruption of an initialized
  state store.
- Give callers a typed state mode and an unforgeable-in-process write capability.
- Keep the payload shape compatible with existing top-level readers.
- Produce bounded, content-free health and recovery evidence.
- Prove the contract with fault injection before changing production behavior.

## Non-goals

- Cryptographic authenticity against an actor who can write as the controller
  account. The digest detects corruption and inconsistent generations; filesystem
  ownership and permissions remain the local trust boundary.
- Unbounded state history or a general-purpose generation database.
- Automatic semantic reconstruction when both retained generations are invalid.
- Treating a successful rename, parse, or mtime update as durable commit proof.
- Logging, uploading, or otherwise publishing damaged bytes or their source path.
- Weakening component-specific policy. For example, an untrusted maintenance
  ledger must not authorize suppression when that later cohort migrates.
- Detecting rollback of an entire coherent state directory snapshot that includes
  the marker, both generations, journal, and receipts. The local high-water witness
  detects generation-pair rollback while the marker survives; whole-store rollback
  requires a separately durable monotonic authority and remains explicit follow-up
  work rather than a claim of this patch.

## Selected Architecture

Add a narrow `deploy/scripts/lib/controller_state.py` helper. The helper owns:

- descriptor-confined private-file inspection;
- a stable per-state lock;
- canonical integrity calculation;
- typed load outcomes;
- one validated previous generation;
- durable publication and recovery ordering;
- an active-lock-bound write capability; and
- bounded recovery metadata.

Each controller retains its payload validator, bootstrap factory, and
component-specific decisions. Callers do not receive a default payload for an
unresolved state.

This is preferred over two alternatives:

- A typed fail-stop wrapper without a previous generation would prevent further
  loss but would not satisfy automatic recovery from last-known-good state.
- Immutable generation directories plus a current pointer provide more history but
  introduce extra namespace operations, cleanup states, and rollout complexity not
  required by #2463.

## State Document Contract

### Top-level-compatible projection

The controller payload remains at the document root. A single reserved member,
`_controllerState`, carries integrity metadata:

```json
{
  "version": 1,
  "openIncidents": {},
  "lastSentAt": {},
  "_controllerState": {
    "format": "whatsoup.controller-state",
    "formatVersion": 1,
    "component": "dispatcher-incident",
    "storeId": "<32 lowercase hexadecimal characters>",
    "generation": 7,
    "writtenAt": "2026-07-28T21:00:00.000Z",
    "integritySha256": "<64 lowercase hexadecimal characters>"
  }
}
```

The reserved key is rejected if it is not an object or contains unknown members.
Component payload validators operate on the root object after removing that key.
No payload may define `_controllerState` for domain use.

The initial component identifiers are fixed:

- `collector`
- `heartbeat-watchdog`
- `dispatcher-incident`

Changing a component identifier or reusing one for a different schema is a format
migration, not a refactor.

### Canonical integrity preimage

`integritySha256` is SHA-256 over UTF-8 canonical JSON for this object:

```json
{
  "format": "whatsoup.controller-state",
  "formatVersion": 1,
  "component": "<component identifier>",
  "storeId": "<32 lowercase hexadecimal characters>",
  "generation": 7,
  "writtenAt": "2026-07-28T21:00:00.000Z",
  "payload": {}
}
```

`payload` is the complete top-level state after removing `_controllerState`.
Canonical JSON uses sorted object keys, `,` and `:` separators without optional
whitespace, UTF-8 without ASCII escaping, and rejects NaN and infinities. Arrays
retain order. Integers retain their JSON numeric value. `storeId` is a
cryptographically random 128-bit value created with the initialized marker and
encoded as 32 lowercase hexadecimal characters. `writtenAt` is a strict UTC RFC
3339 timestamp generated by an injectable clock; it records envelope publication
time but does not override generation ordering. The digest therefore binds format,
writer class (`component`), store, generation, publication time, and payload
together; copying an envelope between stores, components, or generations cannot
validate.

The digest is stored only in the private document and optional private recovery
receipt. Public and ordinary health projections do not expose it.

Every authority-bearing sidecar uses the same canonical-JSON rules and carries its
own `integritySha256` over all fields except that digest. The initialized marker,
transaction journal, and recovery receipt bind the same format, component, and
`storeId` as the primary. Journal digests include operation, phase, generations,
integrity values, and embedded envelopes. Recovery-receipt digests include phase,
reason, occurrence count, generations, and reconciliation target. An unknown,
missing, malformed, or integrity-mismatched sidecar field is
`recovery_required`; phase and operation are closed enums.

### Generation rules

- Generations are nonnegative integers. Generation 0 is reserved for an
  integrity-bound bootstrap or legacy-migration seed and is never produced by an
  ordinary update.
- A bootstrap save creates generation 1.
- A normal save writes exactly `current + 1` and advances the marker high-water
  witness to that generation.
- Reconciliation after recovery writes `marker high-water + 1`; this may skip the
  lost primary generation and never decreases the high-water witness.
- The retained previous generation must be less than the primary generation during
  normal operation. Equality is allowed only while an exact matching recovery
  receipt proves that the previous bytes were restored as the primary; the next
  save restores the strict ordering.
- A recovered previous generation keeps its original generation until the caller
  commits a reconciled generation above the high-water witness.
- A generation outside the exactly representable and configured range is invalid.
- A future format version or unexpected future generation posture is
  `recovery_required`, not authority to roll back to an older previous document.

## Typed Outcomes

The helper returns a discriminated result:

| Mode | Payload | Write capability | Meaning |
| --- | --- | --- | --- |
| `bootstrap` | Bootstrap payload | Yes | No initialized-store marker or managed artifact has ever established the store |
| `valid` | Validated primary | Yes | Current integrity and component schema are valid |
| `recovered` | Validated previous | Reconciliation only | Damaged primary was preserved and the previous generation was durably restored, but ordinary mutation remains blocked |
| `reconciled` | Validated payload | Yes | Legacy or ambiguous state was explicitly reconciled and durably recorded |
| `recovery_required` | None | No | No safe automatic action exists |

The result also contains only bounded enums and generation counters needed by the
caller. Raw exceptions are mapped to a closed reason set such as `read_failed`,
`unsafe_file`, `decode_failed`, `invalid_root`, `schema_incompatible`,
`integrity_mismatch`, `generation_invalid`, `publication_ambiguous`, or
`evidence_preservation_failed`.

Only the helper can construct a capability. It is tied to the component, path
identity, expected generation, allowed operation, and active lock context. Ordinary
`save` rejects a missing, stale, cross-component, reconciliation-only, or released
capability. `complete_reconciliation` is the only operation accepted by a
reconciliation-only capability. A caller cannot bypass `recovery_required` or
`recovered` by constructing an empty dictionary and calling the helper.

Read-only cross-component access has a separate exhaustive result union and never
returns a write capability:

| Read mode | Payload | Meaning |
| --- | --- | --- |
| `valid` | Validated current payload | Marker, store binding, envelope, and generation are valid |
| `legacy_valid` | Schema-validated legacy payload | Pristine legacy store; owning writer has not migrated it yet |
| `recovery_pending` | None | Owner has restored state but not completed reconciliation |
| `unavailable` | None | Lock, trust, schema, integrity, journal, or recovery validation failed |

Callers must handle all four modes. `legacy_valid` is not converted to unavailable
and does not trigger a write or lock upgrade.

## File and Lock Layout

For a primary named `state.json`, the store uses sibling private files with fixed,
non-user-controlled names:

- `state.json` — current generation;
- `state.json.previous` — one validated prior generation; and
- `state.json.initialized` — permanent proof that the store is no longer new;
- `state.json.transaction` — the closed publication transaction journal;
- `state.json.recovery` — the canonical closed recovery receipt; and
- `state.json.lock` — stable lock file, never unlinked during normal operation.

Damaged primary evidence is copied byte-for-byte from its already verified
descriptor to a private, collision-resistant name under the same state directory
only after the directory and leaf have passed trust checks. The evidence file is
synced and its namespace is synced before the primary is replaced; a failed
evidence publication leaves the original primary untouched and enters
`recovery_required`.
The generated name is never written to ordinary logs or health output. Evidence is
immutable to the controller after preservation and is not automatically deleted by
this patch.

`state.json.recovery` is the single canonical receipt for the latest recovery
transition. It contains a random opaque receipt ID, component class, recovered and
new generation counters, bounded reason, phase, and occurrence count. Its phases
are `planned`, `evidence_preserved`, `restored`,
`reconciliation_prepared`, and `reconciled`. The opaque ID deterministically
selects the private evidence leaf without placing its name in the receipt. A
`reconciliation_prepared` receipt also binds the intended target generation and
integrity value so a restart can finish or reject that exact reconciliation. It
contains no payload bytes, evidence filename, or path. Its private integrity value
is never projected into logs or health.
Creating and advancing the receipt is part of the recovery transaction; an
interrupted recovery resumes the same receipt. Controller logs and health project
that receipt rather than creating independent recovery identities.

`state.json.initialized` contains format, component class, random store ID,
`highWaterGeneration`, `highWaterIntegritySha256`, and its sidecar integrity
digest. It is created and namespace-synced at high-water generation 0 before the
first generation is published, advances only through the active journal after a
new primary is namespace-synced, and is never removed by normal operation. The
primary and previous must bind its store ID, and the primary generation/integrity
must match its high-water witness unless an active journal proves the exact
in-flight target. A missing, malformed, or mismatched marker in an established
store is `recovery_required`, never silently repaired or treated as `valid`.

`state.json.transaction` is written and namespace-synced before any publication
changes a generation. It contains a random transaction ID, component,
operation (`bootstrap`, `migration`, `normal`, or `reconciliation`), expected and
target generations, expected and target marker high-water values, expected
integrity values, the exact private previous and target envelopes needed to resume,
and one of `prepared`, `previous_committed`, `primary_committed`, or
`marker_committed`. Each phase update is durable. The journal is a transient private
state copy with the same trust and permission rules as the primary. Its payload is
never logged or projected, and the journal contains no path or raw error.

The helper rejects:

- a symlink at any traversed directory or managed leaf;
- a non-regular managed leaf;
- owner mismatch;
- group- or world-writable trusted directories;
- group- or world-readable/writable state or evidence files;
- path replacement detected between inspection and use; and
- a lock opened outside the verified state directory.

New directories and files are created private. Existing untrusted objects are not
silently repaired with `chmod`, followed, moved, or overwritten.

## Load and Recovery Algorithm

All steps occur under the stable exclusive state lock.

1. Verify the state directory, lock, initialized marker, transaction journal,
   recovery receipt, primary, and previous leaf identities without following
   symlinks.
2. Classify an uninitialized store before trusting any sidecar. If the marker and
   every managed artifact are absent, validate the bootstrap factory and return
   `bootstrap`. If the marker is absent and the sole managed artifact is one
   supported legacy primary, validate and migrate it through the locked migration
   transaction. Any other missing or malformed marker is `recovery_required`.
3. Validate the marker's schema, integrity, component, store ID, and high-water
   witness. Then validate every present envelope and sidecar against that same
   store ID before using its control fields.
4. If a transaction journal exists, reconcile it first. A valid current primary
   with a matching prepared journal resumes publication of the journal's exact
   previous and target envelopes; it never clears the journal and grants authority
   at the old generation. A valid target primary plus matching previous is made
   durable by syncing the namespace again. An incomplete phase resumes only the
   journal's exact integrity-validated envelopes, then advances and syncs the marker
   to the journal's target high-water generation. Only after primary, previous, and
   marker match the target journal state may the helper remove the journal and sync
   that removal. A `reconciliation` transaction must then durably advance its
   matching recovery receipt to `reconciled` before it can return a normal
   `reconciled` result; other operations continue through the remaining load
   checks. Any mismatch is `recovery_required`.
5. If a recovery receipt is `planned` or `evidence_preserved`, resume only its
   recorded next step after revalidating all observed identities. If it is
   `restored`, require byte-equivalent primary and previous generations below the
   unchanged marker high-water witness and return `recovered` with a
   reconciliation-only capability. If it is `reconciliation_prepared`, accept only
   the recorded recovered generation or the exact recorded target primary plus
   recovered previous; finish or retry that transaction, advance the marker, and
   durably mark the receipt `reconciled`. The ordinary `valid` path is unavailable
   until the receipt is durably `reconciled`.
6. Parse and validate the primary's root, metadata, canonical digest, generation,
   store ID, and component payload schema.
7. If the primary generation and integrity match the marker high-water witness,
   return `valid`. An invalid previous file is recorded as degraded metadata and
   must be preserved as private evidence before it is replaced by the validated
   primary on the next save; it does not invalidate the sole trustworthy current
   generation.
8. A valid envelope that does not match the marker high-water witness is generation
   rollback or incomplete publication and returns `recovery_required` unless the
   already-validated journal or recovery receipt explicitly owns that exact state.
9. If a legacy primary appears beside the established marker or any other
   established-store witness, classify it as old-writer rollback and return
   `recovery_required`.
10. If the primary is damaged in a recoverable way, validate the previous document
   independently against the same store ID.
11. If the previous document is valid for the same component, store, and supported
    format, durably create a `planned` canonical recovery receipt, durably preserve
    the damaged primary, advance the receipt to `evidence_preserved`, durably restore
    the previous bytes as the primary without decreasing marker high-water, advance
    the receipt to `restored`, and return `recovered`. A crash resumes the recorded
    phase with the same receipt and evidence identity.
12. Otherwise return `recovery_required` with no payload or write capability.

Unsafe filesystem objects, future formats, component mismatch, generation rollback,
and ambiguous publication do not authorize automatic fallback. They require
operator reconciliation because an older process or substituted file may otherwise
silently roll back newer truth.

Missing primary is bootstrap only when the initialized marker and every managed
state/recovery artifact are absent. A missing primary beside the initialized
marker, journal, receipt, evidence, or retained generation is a recovery case, not
first run.

## Save Algorithm and Crash Ordering

The helper holds the stable lock from load through save. The active capability
supplies the expected current generation and marker high-water witness. For an
ordinary save, target `T = N + 1`. For recovery reconciliation, target
`T = high-water + 1`.

For a normal generation `N` save:

1. Revalidate the primary identity and generation against the capability.
2. Revalidate the marker store ID, high-water generation, and integrity.
3. Validate the caller's complete new payload before touching retained authority.
4. Inspect the existing previous leaf. If it is invalid, copy it from its verified
   descriptor into immutable private evidence and sync both file and namespace
   before continuing. Evidence preservation failure aborts without replacing the
   previous or primary.
5. Write and namespace-sync a `prepared` transaction journal binding expected
   generation `N`, expected marker high-water, target generation `T`, both integrity
   values, target marker, and the exact private envelopes required to resume.
6. Serialize the validated current generation `N` as the new previous document.
7. Write the previous temporary file privately, sync the file, atomically replace
   `state.json.previous`, and sync the containing directory.
8. Advance and sync the journal to `previous_committed`.
9. Serialize the new payload as generation `T`.
10. Write the primary temporary file privately, sync the file, atomically replace
   `state.json`, and sync the containing directory.
11. Advance and sync the journal to `primary_committed`.
12. Atomically replace and namespace-sync the marker at high-water generation `T`
    and target integrity.
13. Advance and sync the journal to `marker_committed`.
14. Remove the journal and sync its removal.
15. Return a committed receipt and invalidate the capability.

The trusted current generation is therefore preserved before primary replacement.
Bootstrap and migration use the same journal but have explicit preconditions rather
than pretending a generation 0 primary exists. For the first bootstrap save, the
helper revalidates that no established-store artifact appeared, creates the
initialized marker, writes a `bootstrap` journal, then writes an integrity-bound
generation 0 copy of the validated bootstrap payload as previous before publishing
the caller's generation 1 payload and advancing the marker to generation 1. Legacy
migration revalidates the sole legacy primary and absence of every
established-store witness, creates the initialized marker at generation 0, writes a
`migration` journal bound to the legacy bytes, then writes the validated legacy
payload as generation 0 previous before generation 1 primary and marker. Both
finish with the same journal removal and namespace sync. A recovered or reconciled
store follows the applicable target-generation rule after its recovery transaction
completes.

Failure before primary replacement leaves the existing primary authoritative but
retains the journal so the next load proves that state before continuing. Failure
after a visible primary replacement but before directory sync is
`publication_ambiguous`: the helper returns no success, advances no in-memory
trusted generation, and the journal forces reconciliation on the next load.
Masking or retrying that result as success is prohibited. Absence of the journal
after a successful namespace-synced removal, together with a marker matching the
primary target, is the commit witness.

Temporary files are removed only when their exact identity belongs to the active
operation and removal is safe. Retained primary, previous, or evidence files are
never cleaned speculatively.

## Concurrency Contract

The state transaction lock is held across the controller's load, lifecycle
decision, external effect admission, and final state save. This is intentional:
releasing it after load would allow two processes to act on the same lifecycle
authority before a generation compare detects the stale writer.

Read-only cross-component readers acquire the same lock in shared mode, validate a
complete generation, copy the payload, and release it. A reader that cannot obtain
a validated snapshot returns `unavailable`, or `recovery_pending` when the owning
store is durably restored but unreconciled; it does not consume top-level fields
from an unvalidated new-format file.

A pristine legacy primary with no established-store witness may be returned to a
read-only caller as `legacy_valid` after component-schema validation. The reader
does not upgrade its lock or migrate the file; the owning writer performs that
transaction. A legacy primary beside an initialized marker, previous generation,
journal, receipt, or evidence is rollback and is unavailable to read-only callers.
Likewise, a `restored` recovery receipt blocks read-only lifecycle consumption until
the owner completes reconciliation.

The service remains operationally single-writer, but the lock and generation check
make accidental overlap fail closed. Lock acquisition has a bounded timeout and
maps to a typed non-success result.

## Controller Integration

### Collector

Collector preflight happens before configuration-derived state mutation, remote
claims, probes, outbox emission, acknowledgement mutation, or save. `bootstrap`,
`valid`, and `reconciled` continue with their validated payload. `recovered` may run
only the reconciliation adapter and commit its result before the controller
reloads. `recovery_required` exits nonzero without remote work, outbox artifacts,
or state replacement.

Recovery preserves remote failure and backoff history, open-alert/cooldown state,
recovery progress, and acknowledgement-failure contributors.

### Heartbeat watchdog

Watchdog preflight happens at the beginning of reconciliation before incident
transitions, escalation, alert/clear emission, suppression updates, or save.
`recovered` may run only the reconciliation adapter and commit its result before
the watchdog reloads. `recovery_required` exits nonzero and emits no lifecycle
event.

Recovery preserves open problems, pending stale confirmations, recently recovered
and flap-rearm holds, suppression counts, escalation state, and pending recovery
behavior.

The watchdog's direct reads of collector state use the shared read-only validation
path. Existing top-level keys remain compatible, but metadata validation is
mandatory once `_controllerState` is present.

The watchdog's daily-health freshness read of dispatcher incident state uses the
same read-only validation path. File-age probes may inspect metadata, but no
lifecycle decision may consume collector or incident payload fields without a
validated snapshot.

### Dispatcher

Dispatcher incident-state preflight happens immediately after acquiring its
existing process lock and before queue recovery, rename/claim, suppression,
collapse, send, archive, sweep, or prune. This ordering is mandatory because loading
incident state after claiming a queue item has already mutated domain state.

The validated state transaction is threaded through every dispatcher operation
that currently loads or saves incident state. Secondary helpers do not reopen the
file independently, manufacture a compatibility dictionary, or acquire a second
write capability. Read-only inspection outside the write cycle uses the shared
validated snapshot API.

`recovery_required` leaves queued events and incident artifacts untouched and exits
nonzero. `recovered` also leaves the queue untouched: only incident reconciliation
and its state commit are authorized before a reload. Recovery preserves open
incidents, last-send clocks, flap/transient promotion state, pending closure,
stale-autoclose history, and daily-health freshness.

The current behavior that archives corrupt incident state and continues empty is
removed. Evidence preservation becomes part of the shared recovery transaction and
never grants an empty incident payload.

## Reconciliation

Automatic restoration from a valid previous generation records `recovered` but
does not fabricate obligations absent from both generations. A recovered result
has a reconciliation-only capability. Before normal mutation, each adapter runs
its authoritative reconciliation where such a ledger exists and commits through
`complete_reconciliation`. Reconciliation may add obligations proven by the event,
archive, or member ledger; it may not infer closure or reset counters from absence
alone. Completion first advances the recovery receipt to
`reconciliation_prepared` with the exact target generation and integrity value,
then executes a journaled `reconciliation` save. After that save is durably
committed, it advances the receipt to `reconciled`, invalidates the restricted
capability, and returns a normal `reconciled` result. Only that result may authorize
the controller to reload and resume its ordinary cycle.

If no authoritative reconciliation source exists, the validated recovered
generation remains the input authority, but the adapter must explicitly commit an
unchanged-payload reconciliation with the bounded outcome
`validated_previous_only` before ordinary service resumes. An operator-approved
repair likewise produces a new integrity-bound generation and `reconciled` receipt.
The interface for broader manual repair is outside the first patch; until it
exists, unresolved corruption stays fail-closed.

No outbox diagnostic is emitted while state is untrusted if generating that event
would itself depend on lost lifecycle authority. The process instead returns
nonzero and invokes the independent diagnostic fallback described below.

## Health and Diagnostic Contract

Health distinguishes:

- `bootstrap`
- `valid`
- `recovered`
- `recovery_required`
- `reconciled`

The diagnostic schema is closed and contains only component class, state mode,
current and recovered generation counters when known, bounded error class, random
opaque recovery receipt ID when available, and a bounded occurrence count. It
contains no damaged values, raw exception text, file path, evidence filename,
environment value, domain identifier, destination, account, message, credential,
topology, or digest derived from payload content.

This is an owner-approved privacy refinement to #2463's proposed diagnostic digest:
the integrity digest remains private in the state envelope, while diagnostics use
a random receipt ID that cannot confirm guesses about state content. The draft PR
must call out that refinement when mapping the issue acceptance criteria.

The independent fallback is the controller-log emergency sink, narrowed to one
constant-schema JSON line written directly to the process's pre-opened standard
error descriptor. It does not format the exception or inspect environment values.
It is attempted at most once per process invocation, then the process exits with a
dedicated nonzero state-recovery code. Service definitions must retain bounded
restart throttling, and health checks treat that exit code as
`state_recovery_required`.

When the private state directory is trusted and writable, the canonical recovery
receipt is the durable health source and controller-log projects it. When the
directory is unsafe, permission-denied, or full, no false durable-receipt claim is
made: the constant stderr record plus nonzero exit is the fail-safe evidence. If
stderr itself fails, the nonzero exit remains the minimum signal. Tests inject
state-directory trust failure, permission failure, disk full, stderr failure, and
restart repetition and prove the projection remains content-free and bounded.

Exactly one canonical recovery transition receipt exists per completed recovery.
Retries reuse its opaque receipt ID and bounded occurrence count; they do not append
new recovery identities. Retry authority for an unresolved diagnostic is
independent of the damaged component payload and bounded so corruption cannot
create an alert storm.

## Legacy and Mixed-version Rollout

A valid legacy top-level object in a pristine, never-initialized store is not
corruption. Its first owning-writer load validates the existing component schema,
then publishes the same payload as an integrity-bound generation without changing
lifecycle values. Invalid legacy state does not migrate. A legacy primary beside
any initialized-store witness is an old-writer rollback and remains
`recovery_required` until explicitly reconciled.

Rollout is coherent:

1. Add the helper to `deploy/bot-errors-runtime-manifest.json`,
   `deploy/source-runtime-manifest.json`, and the deployer's managed `FILES`.
2. Update writers and every direct reader of the three migrated state classes in
   the same deployed bundle.
3. Prove isolated-bundle imports with no ambient repository path.
4. Verify the deployed manifest before starting migrated services.
5. Reject a bundle that combines new writers with an old reader that has not been
   proven to ignore and preserve the reserved metadata.

Because payload fields remain top-level, rollback to the immediately preceding
reader can parse domain state, but an old writer would drop integrity metadata.
Operational rollback therefore stops migrated writers first and restores the
previous complete bundle; it does not run mixed writers. Any state written by an
old version after migration requires explicit reconciliation before the new writer
resumes.

## Collision and Integration Review

At design time, open PR #2615 changes two dispatcher comparisons related to
outbound-delivery evidence. It does not touch incident-state loading, locking,
recovery, or persistence. The implementation must recheck its head and changed
files before editing the dispatcher, then rebase or restack if the comparison hunk
has landed.

Runtime-manifest and generated documentation files are common collision surfaces.
Their hashes and generated indexes must be regenerated from the final composed
tree, never resolved by choosing one side's generated output.

## RED-first Validation Matrix

Implementation starts with failing tests that exercise the behavior through the
shared helper and each production adapter.

| Case | Expected result | Forbidden effects |
| --- | --- | --- |
| No initialized marker or artifacts | `bootstrap` | False corruption health |
| Initialized marker but no generations | `recovery_required` | Bootstrap |
| Valid generations + missing/malformed marker | `recovery_required` | Ordinary `valid` or marker reconstruction |
| Envelope/sidecar store ID mismatch | `recovery_required` | Cross-store adoption |
| Sidecar phase/operation/generation/digest tamper | `recovery_required` | Authority from unvalidated control fields |
| Valid legacy object | `reconciled`, identical payload | Counter or membership change |
| Read-only pristine legacy object | `legacy_valid`, no write | Lock upgrade or false health problem |
| Legacy primary beside established-store witness | `recovery_required` | Automatic migration or rollback |
| Valid current | `valid` | Rewrite on read |
| Valid current + invalid previous on save | Preserve previous evidence, then save | Destructive previous overwrite |
| Truncated primary + valid previous | `recovered` | Empty fallback |
| Wrong-root primary + valid previous | `recovered` | Empty fallback |
| Integrity mismatch + valid previous | `recovered` | Trust mismatched payload |
| Corrupt primary + no previous | `recovery_required` | Save, clear, onset, send, probe, claim |
| Corrupt primary + corrupt previous | `recovery_required` | Evidence overwrite |
| Future format + old previous | `recovery_required` | Automatic rollback |
| Component mismatch + valid previous | `recovery_required` | Cross-component adoption |
| Symlinked directory or leaf | `recovery_required` | Follow, move, chmod, overwrite |
| Unsafe owner or permissions | `recovery_required` | Automatic repair |
| Interrupted previous write | Old primary remains valid | Primary advancement |
| Previous rename without directory sync | Ambiguous/non-success | Success receipt |
| Interrupted primary write before rename | Old primary remains valid | Generation advancement |
| Primary rename without directory sync | `publication_ambiguous` | Success or normal resume |
| Primary committed + marker update interrupted | Resume exact journal marker target | Old high-water or journal removal |
| Prepared journal + valid old primary | Resume exact journal target | Clearing journal or granting authority at old generation |
| Journal + matching new primary/previous/marker | `reconciled` after namespace sync | Resume before journal removal is durable |
| Journal/file mismatch | `recovery_required` | Guessing transaction outcome |
| Disk full or permission failure | Typed non-success | Partial success |
| Concurrent/stale capability | Rejected | Second lifecycle effect or save |
| Generation pair below marker high-water | `recovery_required` | Older-state activation |
| Recovered state before reconciliation | Reconciliation-only | Queue, remote, outbox, alert, clear, or ordinary save |
| Restart with `restored` recovery receipt | `recovered`, reconciliation-only | Ordinary `valid` path |
| Restart with `reconciliation_prepared` receipt | Finish/retry exact target or fail closed | Different payload or ordinary `valid` path |
| Unsafe/full state directory | Closed stderr fallback + nonzero exit | Raw exception, success, or durable-receipt claim |
| NaN, infinity, or semantic schema failure | Typed invalid | Digest or save |

Adapter tests additionally prove:

- collector corruption produces no remote operation or outbox artifact;
- watchdog corruption produces no alert, clear, or state replacement;
- dispatcher corruption leaves queued events byte-for-byte and name-for-name
  untouched before returning nonzero;
- recovered membership, clocks, cooldowns, backoff, promotion, pending closure,
  escalation, and freshness remain equivalent to the retained generation;
- no stale clear, duplicate onset, retry-budget reset, or suppression reset is
  authorized by recovery;
- one canonical recovery receipt is created and projected through only the closed
  diagnostic schema;
- deleting every generation after initialization cannot recreate bootstrap;
- every journal crash phase either reconciles exact generations or fails closed;
- recovered state cannot authorize ordinary mutation until reconciliation is
  durably committed; and
- cross-readers reject invalid metadata rather than parsing domain fields directly.

The fault harness must inject file sync, directory open/sync, rename, permissions,
disk-full, interrupted publication, and lock overlap. A mocked or skipped durability
failure is inconclusive unless the test proves the expected syscall boundary was
actually reached.

## Verification Gates

Before a draft PR is described as patch-ready:

1. Preserve the initial RED evidence for helper and all three adapter paths.
2. Pass the focused Python helper, collector, watchdog, and dispatcher suites.
3. Pass the TypeScript integration suites for those controllers.
4. Pass runtime-manifest, source-runtime, deployed-bundle, deployer mutation,
   atomic-writer, repository-hygiene, publication, and test-integrity guards.
5. Pass type checking and the full BOT ERRORS suite.
6. Run the repository's full required verification lanes on the exact proposed
   head.
7. Obtain independent review of state-machine safety, filesystem durability,
   privacy projection, and test integrity.
8. Re-run the open-PR path collision and issue-ownership checks immediately before
   publication.

Every verification report identifies the exact commit, exact commands, pass/fail
counts, skipped checks, and fault-injection coverage. Masked, unavailable, or
partially exercised checks are reported as gaps, not passes.

## Rollback

Rollback is bundle-level:

1. Stop all writers for the migrated state class.
2. Preserve the current primary, previous, and recovery evidence privately.
3. Verify the rollback bundle and its manifest.
4. Restore the prior complete bundle.
5. Reconcile any generation written after migration before allowing the old writer
   to run.

Rollback never deletes the initialized-store marker or recovery evidence, copies a
previous generation over a current one without validation, or treats a parseable
file as sufficient authority.

## Acceptance Mapping

| #2463 acceptance concern | Design owner |
| --- | --- |
| Valid previous restores lifecycle membership | Typed load and recovery algorithm |
| No valid generation fails closed | `recovery_required` without payload/capability |
| Collector history survives | Collector adapter plus equivalence tests |
| Watchdog lifecycle survives | Watchdog adapter plus equivalence tests |
| Dispatcher lifecycle survives | Dispatcher preflight plus equivalence tests |
| No stale clear/onset/reset | Lock-held capability and adapter forbidden-effect tests |
| Health distinguishes lifecycle modes | Closed health projection |
| Concurrent/interrupted/disk/schema faults | RED-first fault matrix |
| Diagnostics remain private | Closed metadata-only diagnostic contract |

## Review Decision

Implementation planning begins only after the owner reviews this written design.
Any change to the component cohort, on-disk format, recovery eligibility, lock
lifetime, or diagnostic fields requires a design amendment before production code.
