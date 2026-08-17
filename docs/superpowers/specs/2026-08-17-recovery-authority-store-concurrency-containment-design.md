# Recovery-Authority Store Concurrency Containment Design

**Status:** architecture and implementation plan approved; implementation in progress

**Canonical design baseline:** `8c66317823f213f49fd6fd254d79bf77790bbca1`

**Implementation branch:** `fix/recovery-authority-store-concurrency` (unpublished at design time)

## Goal

Make `setRecoveryMarker()` and `clearRecoveryMarker()` safe when multiple
WhatSoup processes mutate the same recovery-authority file concurrently.

The containment must preserve every successfully accepted marker mutation,
eliminate shared-temporary-file collisions, remain restart-safe, and fail with
bounded, attributable evidence instead of hanging or silently reporting a
false success.

This increment deliberately preserves the selected store path, the public
function signatures, and the persisted JSON object schema. It is not the
typed-ownership or per-instance migration increment.

## Incident Evidence and Acceptance Baseline

The current store performs an unlocked read-modify-write and publishes through
one fixed sibling path, `recovery-authority.json.tmp`. Concurrent processes can
therefore:

1. read the same old marker set and overwrite one another's additions or
   removals; and
2. rename another process's shared temporary file, causing the losing process
   to fail with `ENOENT`.

The original sequential suite passes despite both defects. Its set/clear/set
cycle never overlaps operations, and its assertion that writing `{}` closes a
concurrent race tests only sequential persistence.

An unpublished real-process falsifier established the RED baseline:

- 16 child processes attempted distinct `setRecoveryMarker()` calls against
  one store;
- four independent runs failed on the unchanged implementation;
- the recorded reference run produced 12 failed writers out of 16, all with
  `ENOENT` at the fixed temporary-file rename; and
- an independent review reran the test once in full and three more times with
  only the set/set case selected; all four executions failed.

The exact 12-of-16 count is diagnostic, not the contract. The acceptance
contract is zero failed writers and all 16 distinct markers present after every
GREEN run.

The first set/clear falsifier was invalid. It inserted a decoy read before
calling `clearRecoveryMarker()`, but the vulnerable snapshot is the read inside
`clearRecoveryMarker()` itself. That test passed current broken code and is not
evidence.

## Proven Root Cause

`setRecoveryMarker()` and `clearRecoveryMarker()` each independently execute:

1. read the complete JSON object;
2. derive a new in-memory marker map; and
3. replace the complete JSON object.

Atomic rename protects readers from partial bytes. It does not make the whole
read-modify-write transaction atomic. Unique temporary names alone remove the
`ENOENT` collision but still allow last-writer-wins data loss. Conversely, a
lock around only the write leaves the stale-read overwrite intact. One lock
must cover the read, mutation, and publication as a single transaction.

## Scope

This increment owns:

- serialization of every `setRecoveryMarker()` and `clearRecoveryMarker()`
  read-modify-write transaction across processes;
- collision-resistant, private, atomic JSON publication;
- secure creation of the currently selected marker directory;
- bounded contention and dead-holder recovery;
- explicit internal evidence for lock timeout or store-write failure;
- removal of false concurrency claims and duplicate test setup from the
  existing sequential suite; and
- deterministic, watchdog-bounded real-process acceptance tests.

## Non-Goals

- Changing `state_root()` or the selected marker path.
- Moving markers from `XDG_DATA_HOME` to `XDG_STATE_HOME`.
- Introducing per-instance, fleet-owned, or typed store ownership.
- Exporting or changing `WHATSOUP_INSTANCE`.
- Migrating, partitioning, copying, deleting, or quarantining existing markers.
- Changing marker keys or converting the JSON object to a journal or directory
  of per-marker files.
- Changing `loadRecoveryMarkers()` failure semantics. Its catch-all
  missing/corrupt/unreadable behavior is a separate typed-ownership concern.
- Changing producer or consumer signatures.
- Redesigning alert-source ownership, clear eligibility, or recovery status.

The implementation must not make any of these deferred changes incidentally.

## Considered Approaches

### 1. Serialize the existing store and reuse private-file primitives

Wrap the complete mutation in a recovery-authority-specific process-lock
transaction. Publish through `writePrivateJsonMarkerSync()` and create the
directory through `forceEnsurePrivateDirectorySync()`.

This is selected. It fixes both proven races without changing callers, path
selection, marker keys, or the JSON object data model. It reuses the repository's
established lock, private-directory, unique-temporary-file, fsync, symlink
refusal, and cleanup behavior.

### 2. Append-only marker journal

Append set/clear events and fold them during reads. Appends would avoid replacing
one shared object, but this changes the persisted format, introduces compaction
and corruption-boundary questions, and requires migration and retention design.

This is deferred to the later ownership increment.

### 3. One file per marker

Represent each active marker as an independently created file. Set and clear
would no longer contend on one logical object, but key-to-path encoding, directory
enumeration, privacy, crash cleanup, and migration all become new contracts.

This is also deferred.

### 4. Unique temporary filenames without serialization

Replace the fixed `.tmp` path and leave the current read-modify-write flow
otherwise unchanged.

This is rejected. It removes the visible `ENOENT` symptom while preserving the
more dangerous silent lost-update race.

## Architecture

### Transaction boundary

Add one internal mutation path used by both public mutators. Its order is:

1. Resolve the marker path with the existing `state_root()` behavior.
2. Securely create or normalize the parent directory with
   `forceEnsurePrivateDirectorySync()`.
3. Acquire a process lock at `<marker-path>.lock`.
4. Read and parse the existing marker object while holding the lock.
5. Apply exactly one set or clear mutation.
6. Publish the resulting object through `writePrivateJsonMarkerSync()` while
   still holding the lock.
7. Release the exact acquired lock in `finally`.

No mutator may read the marker object before acquiring the lock. No mutator may
release the lock before publication completes or throws.

`loadRecoveryMarkers()` remains lock-free. Atomic replacement guarantees it
sees either the prior complete object or the next complete object. It never
observes the private sibling temporary file.

### Existing infrastructure

The implementation reuses:

- `acquireProcessLock()` and `releaseProcessLock()` from
  `src/lib/process-lock.ts`;
- `forceEnsurePrivateDirectorySync()` from `src/lib/private-fs.ts`; and
- `writePrivateJsonMarkerSync()` from `src/lib/private-fs.ts`.

`writePrivateJsonMarkerSync()` supplies a process- and UUID-qualified exclusive
temporary file, mode `0600`, file fsync, atomic same-directory rename,
best-effort parent-directory fsync, target-path revalidation, and failed-temp
cleanup. The semantic persisted format remains an object whose truthy keys are
active markers. Its canonical serialization may gain the helper's trailing
newline; no reader-visible schema changes.

The recovery-authority lock policy stays local to this store. The qregistry
dispatch wrapper has different stale/corrupt disposition and scheduled-retry
semantics, so importing or generalizing that script helper would widen this
containment unnecessarily.

### Contention and stale-lock policy

The transaction uses `acquireProcessLock()` with
`reclaimDeadSameBoot: true`. A dead same-boot or previous-boot holder may be
reclaimed only through the primitive's identity-checked logic. A live holder is
never evicted.

A corrupt lock or a stale lock whose boot identity is insufficient for the
primitive's approved reclaim path fails closed immediately with bounded
classification. The store never unlinks an unreadable, ambiguous, or live lock
on its own.

Live-holder contention uses a cooperative synchronous wait budget of 500
milliseconds, polling every 10 milliseconds. The deadline uses a monotonic
clock. The budget bounds time spent waiting on a live holder; total call latency
can exceed 500 milliseconds because temporary-lock preparation happens before
the wait and one terminal atomic acquisition attempt follows deadline expiry.
If that attempt still observes a live holder, acquisition fails `active`. No
deterministic wall clock ceiling is claimed across filesystem or `fsync` stalls.

The 500-millisecond budget is evidence-based rather than an assumed round
number. A local 1,000-transaction measurement of the exact private JSON writer
reported p50 15.230 ms, p95 49.092 ms, p99 68.973 ms, and max 87.914 ms. That
leaves several high-percentile transaction windows for an ordinary holder to
finish while reducing the former proposal's worst-case event-loop stall by
75%. The observed local envelope is therefore roughly 588 milliseconds (the
500-millisecond cooperative budget plus the measured maximum transaction), not
a portability guarantee.

The constants are not operator configuration in this increment. The protected
transaction consists only of one bounded local read, mutation, fsync, and
rename; normal local contention should settle far below the deadline. Any
future increase requires fresh transaction-cost evidence and an explicit
responsiveness review.

The prerequisite process-lock change uses one discriminated read result for an
observed lock: `missing`, `corrupt`, or `valid`. The previous nullable reader
collapsed a normal release between atomic-link conflict and lock read into
`corrupt`. A follow-up `existsSync()` check would introduce another race and is
not an acceptable classifier. Missing retries acquisition, corrupt remains
fail-closed, and valid follows the existing holder policy. The bounded wait is
strictly opt-in; callers that omit it retain the existing immediate active,
stale, and corrupt behavior. Tests create the release/replacement interleavings
at the real `node:fs` read boundary and add no production-only timing seam.

If the deadline expires:

- do not read or write the marker object without the lock;
- emit one bounded structured warning naming the operation and `lock_timeout`,
  without marker keys, absolute paths, chat identity, or message content; and
- throw a typed or named store error so the existing caller boundary retains
  its current best-effort posture without a false success return.

Existing marker-read recovery behavior remains unchanged in this containment:
set treats a missing, unreadable, or unparsable marker file as an empty set;
clear returns without publication when its read or parse throws; and a
successfully parsed non-object value is normalized through the current empty-map
path. Directory, permission, fsync, and rename failures continue to throw. The
store records bounded failure classification before rethrow when the existing
caller would otherwise swallow the exception.

### Set semantics

Under the transaction lock, load the current truthy-key set, add the requested
key, and publish the resulting object. Re-setting an existing marker is
idempotent but still follows the same transaction path.

### Clear semantics

Under the same transaction lock, load the current truthy-key set. If reading or
parsing the target throws, retain the current no-publication return. Otherwise
remove only the requested key and publish the resulting object, including `{}`
when the last marker is removed. A readable object which did not contain the
requested key is republished unchanged, matching current behavior.

The existing identical `if/else` branches that both write the marker map are
removed. Writing `{}` is a persistence choice, not the concurrency mechanism;
the lock is what prevents a concurrent set from being erased.

## Deterministic Test Design

### Harness requirements

Every spawned child must:

- resolve the store module relative to `import.meta.url`, not `process.cwd()`;
- announce readiness before the parent releases the operation barrier;
- avoid CPU spin while waiting;
- have a per-child watchdog and process-group cleanup;
- return exit code, signal, timeout status, and bounded stderr separately; and
- make timeout an explicit inconclusive failure, never a GREEN result.

The parent must assert every child receipt before inspecting final marker state.
A crashed, signaled, or timed-out child cannot be hidden by a coincidentally
plausible file.

### Set/set falsifier

Keep 16 children and the same simultaneous-release semantics used by the RED
baseline, but replace the two-second wall-clock busy-spin with a readiness
barrier. Run the rewritten harness against unchanged production code first and
record RED before implementing the lock. This re-baselines the harness without
claiming that a changed synchronization mechanism inherited prior evidence.

GREEN requires:

- 16 successful child receipts;
- no `ENOENT`, timeout, signal, or unclassified stderr;
- exactly the 16 expected distinct marker keys on disk; and
- no orphan temporary or lock file after all children exit.

### Set/clear falsifier

Seed marker A. The clear child must pause after the actual filesystem read
inside `clearRecoveryMarker()`, not after a decoy read in the child script.
While that stale snapshot is held, a separate child attempts to set marker B.
The harness then releases the clear operation through a bounded coordination
protocol.

Against the old unlocked code, marker B must be erased by the stale clear and
the test must be RED. Against the contained code, the setter cannot enter its
read-modify-write transaction until the clearer releases the lock; final state
must contain B and omit A.

The interleave may instrument the isolated child process's `node:fs` read
boundary before importing the store. It must not add a production-only timing
delay, sleep hook, or test environment branch to the store implementation.

A primitive-level assertion that `acquireProcessLock()` works is supplementary
only. It cannot replace this behavioral proof.

### Mutation obligations

The finished tests must be shown to discriminate these regressions:

- replace the private writer with the former fixed `.tmp` writer: the POSIX
  `0600` publication contract fails. Set/set is expected to remain GREEN while
  the transaction lock remains intact, so it is not evidence for this writer
  substitution;
- keep unique temporary files but remove transaction serialization: final
  marker-set conservation fails;
- bypass the transaction in `clearRecoveryMarker()`: set/clear fails; and
- remove child watchdog cleanup: the test-integrity review rejects the harness.

No retry flag may turn a failing attempt into a passing acceptance run.

## Compatibility and Blast Radius

The production diff should remain limited to:

- `src/lib/process-lock.ts`, for the opt-in bounded wait and single-read lock
  classification prerequisite;
- `src/lib/recovery-authority-store.ts`;
- the process-lock tests;
- the existing sequential store tests; and
- the real-process concurrency test.

The store gains imports from existing `src/lib` primitives. The process-lock
primitive changes only through an optional wait argument and preserves the
existing public reader's nullable result. No-wait consumers retain their former
behavior. There is no database migration, config schema change, launcher
change, producer change, consumer change, or deployment-path change.

All current callers retain the same synchronous `void` mutator API and
`Set<string>` loader API. Existing marker files remain readable. New files are
more restrictive (`0600`) and their containing directory is normalized to
`0700` by the established private-file boundary.

State roots must be local filesystems with the hard-link and atomic-rename
semantics already required by `process-lock.ts` and the private-file helpers.
A network-mounted or otherwise incompatible state root is unsupported and must
fail visibly rather than be reported as verified portable behavior.

## Verification and Acceptance

Before publication, all of the following must pass on one exact rebased head:

1. Rebase the implementation branch onto current `origin/main`; record the
   resulting head and verify no overlapping recovery-store PR appeared.
2. Run the rewritten set/set and set/clear tests against unchanged store code
   and capture RED for the intended reason.
3. Apply the production change and run both tests GREEN with `--retry=0`.
4. Repeat the complete real-process suite 10 consecutive times on local Node 24
   with 16 children per set/set run: 10/10 clean, every run conserving all keys.
5. Run the original sequential recovery-authority suite and all direct consumer
   suites affected by store mocks or test isolation.
6. Run Test Integrity in CI mode on every changed test file; block findings,
   masked exits, skipped assertions, timeouts, or discarded child failures are
   merge blockers.
7. Run typecheck, source lint, test-integrity baseline/ratchet checks, and the
   repository's full branch/release gate.
8. Require Node 24 and Node 25 GitHub quality jobs, CodeQL, and every protected
   context to succeed on the exact published head.
9. Review the final diff for path, key, format, migration, config, and caller
   drift; each must remain absent except for the documented trailing newline and
   private permissions.

Masked failures are inconclusive, not clean. A single GREEN rerun after a
failure is not acceptance evidence.

## Operational Observation

No live state mutation or fleet deployment is part of this design increment.
After a separately approved deployment, observation must cover at least two
normal marker reconciliation cycles and one controlled concurrent-marker
exercise on a non-production fixture path.

Acceptance evidence includes:

- no fixed-temp `ENOENT`;
- no stale lock remaining after clean process exit;
- no lock-timeout warning during ordinary operation;
- exact marker conservation in the controlled exercise; and
- unchanged alert/clear behavior at current consumers.

Logs must never include raw marker keys, absolute state paths, message content,
chat identifiers, phone numbers, or credentials.

## Rollback

The code rollback restores the former store implementation and requires no data
migration because the marker path and JSON object schema are unchanged. The new
writer leaves no committed auxiliary data besides the existing marker object.

A process crash during private-file publication may leave a uniquely named
non-authoritative temporary file. It cannot be read as marker state, collide
with a later writer, or prevent stale-lock recovery. Crash-orphan scavenging is
an existing private-file lifecycle concern and is not added to this containment.

Before rollback, verify no live process holds `<marker-path>.lock`. A clean
shutdown removes the lock. A proven dead-holder lock may be reclaimed through
the existing process-lock rules; it must never be blindly deleted while its
owner is live.

Rollback knowingly restores the concurrency defect and is therefore an
emergency compatibility measure, not a healthy steady state.

## Deferred Follow-Up

The next design increment owns the issues intentionally excluded here:

- canonical typed state-root ownership through the existing ring-zero instance
  context;
- separation of fleet-owned and instance-owned recovery authority;
- deterministic classification and partitioning of existing marker keys;
- quarantine of unknown or ambiguous historical markers;
- removal of the `sandbox-agent` fallback for loaded instances;
- explicit `loadRecoveryMarkers()` unavailable/corrupt status instead of the
  current empty-set collapse; and
- central marker-key construction and parsing.

Until that typed status exists, a corrupt or unreadable marker file still makes
`clearRecoveryMarker()` return without publication. This containment preserves
that behavior intentionally; it must not be mistaken for successful clear
authority or rediscovered as a new concurrency defect.

That increment must begin with a read-only fleet inventory and migration design.
It must not reinterpret this containment's unchanged path as the canonical
future ownership model.
