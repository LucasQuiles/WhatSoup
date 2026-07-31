# Controller State Recovery Integrity Design

**Status:** Approved — implementation planning complete

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
`integrity_mismatch`, `generation_invalid`, `publication_ambiguous`,
`evidence_preservation_failed`, or `retention_exhausted` (a bounded
reconciliation-record resource — staging attempts or the retained-record
manifest — is full and requires operator-invoked offline archival).

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

Reconciliation additionally uses one exact, receipt-derived private name that
new builds produce — the append-only reconciliation record:

- `.state.json.<recoveryReceiptId>.<attempt>.reconciliation-record` — a
  write-once staging record, where `<attempt>` is the zero-padded closed range
  `01` through `08`.

The attempt range itself is grammar: `09` or any other numeric suffix is not a
record name and is unmanaged authority. Wherever an attempt appears in receipt
or marker fields it is a JSON integer 1..8 — never a boolean, string, or float.
Three legacy grammars remain recognized but are never produced by this design:

- `.state.json.<recoveryReceiptId>.reconciliation-journal.tmp` — the legacy
  incomplete publication temporary;
- `.state.json.<recoveryReceiptId>.reconciliation-journal` — the legacy durable
  staged journal; and
- `.state.json.<recoveryReceiptId>.reconciliation-journal.claim.<hex32>` — the
  legacy deletion quarantine.

A legacy artifact is always unresolved fail-closed authority: it is preserved,
never read as content, and never cleaned, renamed, migrated, or reinterpreted
by the online service.

The ID is exactly 32 lowercase hexadecimal characters already bound by the
receipt. No other state-prefixed sibling is authority. Atomic publication
temporaries are accepted only by the closed grammar
`.state.json[.previous|.initialized|.transaction|.recovery].<hex32>.tmp`;
the record grammar and the three legacy grammars above are the only accepted
reconciliation name grammars.
Unrelated siblings such as `.state.json.notes` neither establish a pristine store
nor invalidate a sole legacy primary. Every exact temporary, record, or legacy
reconciliation name establishes authority that must be accounted by the
classification below; unaccounted names fail closed.

Reconciliation-adjacent siblings classify three ways. First, an exact random
atomic temporary beside an established store is `publication_ambiguous` for both
owner and shared-reader loads; random temporary IDs are not journal-bound restart
authority. Second, a reconciliation record is legal only when accounted: either a
current-receipt record permitted by the active phase posture, or a record
permitted by a `retainedReconciliationRecords` manifest entry (attempts one
through that entry's `finalAttempt`). Records are never moved, renamed,
overwritten, or deleted by the online service. Record content is read only to
verify a present manifest-final record's digest (in every phase) and to promote
the receipt-bound attempt from `reconciliation_prepared` onward; every other
accounted record is inert — identity- and permission-checked as a private
regular non-symlink file, its content never read or parsed. Third, legacy
stage, temporary, and claim artifacts always fail closed, preserved. Immutable
recovery evidence is classified separately and remains legal after
reconciliation.

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
integrity value so a restart can finish or reject that exact reconciliation, and
binds the staging record exactly: `stagingAttempt` (a non-boolean JSON integer
1..8) and `stagedRecordSha256` (lowercase hex64, the SHA-256 of the exact
canonical record bytes). Both fields are null in `planned`,
`evidence_preserved`, and `restored`; both are non-null from
`reconciliation_prepared` onward and are immutable once set. A missing,
asymmetrically null, boolean, non-integer, out-of-range, or non-hex64 value
fails closed before any mutation, and a receipt missing these fields — an old
format — fails closed before any record is read. It
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
in-flight target. The marker may also contain the optional
`retainedReconciliationRecords` manifest: a nonempty array of at most four
(`MAX_RETAINED_RECONCILIATION_RECORDS = 4`)
closed entries `{recoveryReceiptId, finalAttempt, recordSha256}`, sorted
lexicographically by receipt ID and unique by receipt ID, with `finalAttempt` a
non-boolean integer 1..8 and digest/ID lowercase hex64/hex32, covered by the
sidecar integrity digest. An absent key means no retained records; a
present-but-empty array is malformed. An offline archive that removes the last
entry omits the key entirely. Unknown marker or entry keys are rejected. The
online service appends to the manifest idempotently only between canonical
reconciliation publication and the `reconciled` receipt advance, never changing
the high-water fields; entries are pruned only by the separately specified,
operator-invoked offline archival procedure. A fresh recovery receipt never
reuses the store ID or a receipt ID already present in the manifest, so
manifest entries and record names stay unambiguous across receipt turnover. A missing, malformed, or mismatched
marker in an established
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
A migration journal also binds `legacySourceSha256`, the SHA-256 digest of the
exact sole legacy primary bytes inspected before preparation. A restart at
`prepared` must re-read that trusted leaf and match the digest before publishing
the embedded migration envelopes; changed legacy bytes fail closed.

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

Substitution resistance is digest-bound: authority transfers only by comparing
the SHA-256 of exact canonical bytes against a previously validated receipt or
marker field after no-follow identity verification, and no verified-then-moved
object exists in the design. A record's self-contained `integritySha256` is
never authority. This claim is deliberately bounded: it detects substitution
against trusted receipt/marker state and stale private-directory artifacts. It
is not a MAC or signature and does not authenticate an actor able to rewrite
the marker, receipt, record, and their sidecars together.

## Load and Recovery Algorithm

All steps occur under the stable exclusive state lock.

1. Verify the state directory, lock, initialized marker, transaction journal,
   recovery receipt, primary, and previous leaf identities without following
   symlinks.
2. Classify an uninitialized store before trusting any authority-bearing sidecar.
   The stable lock is coordination-only and does not establish the store. If the
   marker and every authority-bearing artifact are absent, validate the bootstrap
   factory and return `bootstrap`. If the marker is absent and the sole
   authority-bearing artifact is one
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
5. Enforce the closed reconciliation-artifact posture for the active phase (the
   accounted set defined under Save Algorithm and Crash Ordering) before using
   any receipt authority; unaccounted, digest-mismatched, or legacy artifacts
   fail closed with everything preserved. If a recovery receipt is `planned` or
   `evidence_preserved`, resume only its
   recorded next step after revalidating all observed identities. If it is
   `restored`, require byte-equivalent primary and previous generations below the
   unchanged marker high-water witness and return `recovered` with a
   reconciliation-only capability; any current-receipt records present are inert
   and their content is not read. If it is `reconciliation_prepared`, accept only
   the recorded recovered generation or the exact recorded target primary plus
   recovered previous, with the bound record required to match
   `stagedRecordSha256` exactly; finish or retry that transaction, advance the
   marker, append the manifest entry exactly once, and
   durably mark the receipt `reconciled`. The ordinary `valid` path is unavailable
   until the receipt is durably `reconciled`.
   Before incrementing the receipt occurrence count or promoting a digest-bound
   record,
   cross-bind the receipt's marker high-water and recovered generation/integrity
   to the validated marker, previous envelope, retained bytes, and journal
   expected values. Cross-bind a prepared receipt's target fields to the journal
   target. Any mismatch returns without mutating the receipt, any record, or the
   canonical journal.
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

Missing primary is bootstrap only when the initialized marker and every
authority-bearing state/recovery artifact are absent. A trusted stable lock may
already exist and does not change that classification. A missing primary beside
the initialized marker, journal, receipt, evidence, or retained generation is a
recovery case, not first run.

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
primary target, is the commit witness. Before returning from normal save, legacy
migration, direct reconciliation, or reconciliation restart, the helper reopens
the primary and requires byte equality with the exact committed target. Missing
or substituted bytes are typed `publication_ambiguous`, never an assertion or a
successful capability.

Temporary files are removed only when their exact identity belongs to the active
operation and removal is safe. Retained primary, previous, or evidence files are
never cleaned speculatively.

Reconciliation staging uses an append-only, restart-safe publication sequence.
With the receipt still at `restored`, the helper takes the verified authority
namespace snapshot once, rejects any `09` or otherwise unrecognized
state-prefixed sibling as unmanaged authority, and selects the next attempt as
one greater than the highest recognized current-receipt record; if all eight
attempts exist it fails closed `retention_exhausted` before creating anything.
It then writes the exact receipt-owned record name once with
create-exclusive/no-follow semantics: private open with explicit mode, full
canonical journal bytes, file sync, close, directory sync, then a no-replace
reread that requires byte and device/inode identity equality. Existing records
are never opened, parsed, compared, reused, moved, renamed, overwritten, or
removed: a crash at open, write, file sync, close, or directory sync leaves the
incomplete record as preserved inert evidence, and the retried preparation
simply selects the next attempt.

Only after that durable record proof and all receipt/journal/marker/recovered
cross-bindings succeed may the helper advance the receipt to
`reconciliation_prepared`, binding the target generation, target integrity,
`stagingAttempt`, and `stagedRecordSha256` in the same durable receipt write.
From the bind onward the record is exact-digest authority: the helper reopens
the bound record without following links, requires SHA-256 equality with
`stagedRecordSha256`, retains the verified bytes in memory, and only then
publishes them to `state.json.transaction` through the ordinary separately
owned atomic writer and completes the canonical transaction. The record
pathname is never renamed into canonical authority and never deleted. After
canonical publication and before the durable receipt advance to `reconciled`,
the helper appends the record's manifest entry `{recoveryReceiptId,
finalAttempt, recordSha256}` to the initialized marker idempotently; a crash
between append and advance resumes the same prepared receipt and appends
exactly once. The completed record remains on disk as inert, manifest-accounted
evidence.

The allowed phase postures are closed over the accounted set: every on-disk
reconciliation artifact must be either a current-receipt record permitted by
the phase rules below or a record permitted by a manifest entry (attempts one
through that entry's `finalAttempt`). All recognized artifacts must be private
regular non-symlink files. A present manifest-final record must be read and its
digest must equal its entry in every phase; manifest-permitted lower attempts
are inert and their content is never read or parsed; a manifest entry whose
final record is absent on disk is legal (archived offline). With no receipt, or
a receipt at `planned` or `evidence_preserved`, only manifest-accounted records
are legal. `restored` additionally permits current-receipt attempts one through
eight, all inert with no content read. `reconciliation_prepared` additionally
permits current-receipt attempts one through `stagingAttempt` and requires the
exact `stagingAttempt` record to exist and match `stagedRecordSha256`, with or
without the canonical transaction while canonical publication has not
completed. `reconciled` permits manifest-accounted records only and requires
the completed record's manifest entry to be present. Any artifact outside the
accounted set, any digest mismatch, and any legacy stage, temporary, or claim
artifact is unresolved authority and fails closed, preserved. A crash before
the `reconciliation_prepared` bind self-corrects on the next attempt; a crash
after the bind resumes the exact digest-bound record or fails closed — never a
new attempt.

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
opaque recovery receipt ID when available, a bounded occurrence count, and a
bounded `stagingAttempt` integer when the receipt binds one. It
contains no damaged values, raw exception text, file path, evidence filename,
environment value, domain identifier, destination, account, message, credential,
topology, or digest derived from payload content.

Controller-log metadata projection has key-aware closed allowlists for all five
state modes and the full closed state reason set, including
`retention_exhausted`. Current and recovered generation counters, the
occurrence count, and `stagingAttempt` project under bounded numeric
allowlists. Unknown strings are dropped. The canonical
component remains only in the outer controller-log envelope; the projected
details do not duplicate that reserved field or relax arbitrary string handling.

Receipt-derived record, stage, and temporary names, the retained-record
manifest contents, and every record digest are private implementation details.
Their names, paths, journal bytes, identities, digests, and integrity values
are never projected into controller logs, health, stderr fallback, or public
diagnostics.

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

Older helpers that do not implement append-only records fail closed by format,
not by rollout choreography: a record name, a manifest-bearing initialized
marker, or a receipt carrying `stagingAttempt`/`stagedRecordSha256` each fails
their closed-key validation before any artifact is interpreted, and they must
not classify that store as pristine or legacy. New helpers likewise fail closed
on legacy stage, temporary, or claim artifacts, on old-format receipts missing
the two record fields, and on phase postures they do not own. No helper version
ever cleans, renames, migrates, or reinterprets another version's
reconciliation artifacts — the on-disk format guarantees it.

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
| Completed cycle, then a full second recovery cycle | Both cycles complete; both records manifest-accounted; reopen `valid` | Prior-cycle record rejected after receipt turnover |
| Crash at record open/write/file-sync/close/dir-sync before bind | Restart self-corrects on next attempt; torn record preserved byte-for-byte | Read, reuse, rename, unlink, or overwrite of any record |
| Crash after bind, canonical transaction, manifest append, or receipt advance | Exact digest-bound resume; manifest entry exactly once | New attempt or duplicate manifest entry |
| Well-formed record substituted, differing only in receipt-unbound fields | Fail closed before primary/marker mutation | Semantic re-derivation accepting the substitute |
| Manifest-final present with digest mismatch; absent final; lower attempts | Mismatch fails closed; absent final benign; lower attempts inert | Content read of inert records |
| Attempt `09`, boolean/string attempt field, legacy stage/temp/claim | Fail closed, preserved | Grammar widening or migration |
| Eight staging attempts or four manifest entries reached | `retention_exhausted` before any write | Partial record, receipt, or marker write |
| Full recovery cycle under mutation interceptors | Zero rename/unlink against any record; sole unlink targets `.transaction` | Claim or cleanup path firing |
| Record lifecycle diagnostics | Only bounded reasons and numeric fields project | Record name, digest, or manifest projection |
| Old-format receipt or old helper meets new artifacts | Fail closed before mutation | Silent migration or cleanup |
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

The owner approved this written design on 2026-07-28, and implementation planning
is complete. Any change to the component cohort, on-disk format, recovery
eligibility, lock lifetime, or diagnostic fields requires a design amendment
before production code.

Amendment (2026-07-29): the append-only reconciliation-record sequence, name
grammar, receipt fields (`stagingAttempt`, `stagedRecordSha256`),
initialized-marker manifest (`retainedReconciliationRecords`), and the
`retention_exhausted` reason above supersede the previous
temp-rename-claim-delete cleanup design, which could not satisfy this
document's own substitution-safety contract with portable rename semantics.
This amendment discharges the change-control obligation above for the
retained-record hardening pass and those format additions. The owner approved
the amended design after an independent structured review on 2026-07-29.
