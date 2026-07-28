# BOT ERRORS Durability Stack Design

**Date:** 2026-07-28
**Status:** approved concept; independent written-spec review passed; owner review pending
**Audit base revision:** `ec1cd2ae5ed766ea78850936b6b7a7360f02bba1`
**Claimed issues:** #2427, #2463, #2464, #2482, #2485

## Purpose

Replace false-success and best-effort persistence across the BOT ERRORS Python
control plane with explicit durable outcomes, stable lifecycle identity,
crash-durable namespace transitions, and validated state-generation recovery.

The work is split into four stacked draft pull requests so each failure
boundary can be reviewed and fault-injected independently. The stack preserves
historical ownership decisions and does not absorb path-disjoint TypeScript
turn-recovery work.

## Observed Failure Boundaries

Audit revision `ec1cd2ae5ed766ea78850936b6b7a7360f02bba1` contains four
related but distinct problems:

1. Nine principal atomic JSON writers can publish a renamed target and then
   silently report ordinary success when opening the parent directory for
   `fsync` fails.
2. Collector and dispatcher lifecycle identity depends on mutable queue names
   and incomplete terminal inventories, so acknowledgement retry convergence
   is not stable across moves and restarts.
3. Local and embedded remote lifecycle moves do not consistently prove
   source- and destination-parent namespace durability.
4. Multiple controller-state loaders replace unreadable truth with empty
   defaults and later overwrite the evidence, allowing corruption to appear
   healed.

Decisive source anchors are the inline atomic writers and parent-sync helpers
in the nine principal `deploy/scripts/bot-errors-*.py` components, the
collector embedded acknowledgement scripts, and the maintenance, GUI-session,
tree-provenance, and cutover utility surfaces. The implementation plan turns
these observations into executable call-site inventory and fault-injection
evidence; until that checked inventory exists, these are audit findings rather
than closure proof.

These failures share a persistence boundary, but they do not share one safe
implementation commit.

## Goals

1. Define one descriptor-confined, fail-closed durable-publication contract.
2. Model durability proof, confinement proof, cleanup debt, and concurrent
   authority independently.
3. Prevent callers from converting `durability_unproven` into queued, saved,
   healthy, recovered, acknowledged, or terminal success.
4. Give lifecycle records stable identity across every raw and nested terminal
   state.
5. Commit every cross-directory move through the exact changed parent set.
6. Recover corrupt controller state only from a validated previous generation;
   otherwise enter an explicit `state_recovery_required` condition.
7. Keep diagnostics metadata-only and bounded.
8. Preserve runtime packaging, source-manifest, and cross-script version
   coherence.

## Non-goals

- Do not change TypeScript `turn_recovery_jobs`, replay admission, session
  provisioning, lease renewal, or supervisor deadman behavior. Issues #2148,
  #2150, #2151, and #2169 form a separate implementation system.
- Do not close #2464 from the first durability slice. It is a broad shared
  primitive and consolidation umbrella with JSONL, configuration, time, and
  observability scope beyond this stack.
- Do not close #2429 while configuration and roster-retirement disposition
  remains.
- Do not adopt copy-and-delete as an atomic fallback for `EXDEV`.
- Do not accept source-string presence of `fsync_parent()` as durability proof.
- Do not expose paths, filenames, payloads, identities, destinations,
  processes, hostnames, usernames, accounts, topology, or credentials in
  receipts, logs, tests, issue comments, or PR text.
- Do not mutate live deployments or fleet state in these repository PRs.

## Delivery Order

### Draft 1: Durable writer outcomes

**Issues:** advances #2485 after all nine writers prove stable operation
identity, event/state-specific concurrency fencing, and fail-closed caller
handling; advances the bounded durable-publication slice of #2464. It does not
close #2485 while embedded cross-directory false-success paths remain for
Draft 3.

Draft 1 introduces a shared module under `deploy/scripts/lib/` and migrates the
nine principal writer components:

- emitter;
- runner;
- collector;
- dispatcher;
- daily health;
- heartbeat watchdog;
- q-loop;
- selfcheck; and
- sentinel.

Draft 1 will produce a checked inventory covering every cooperating local
publisher into the same protected roots. It migrates the maintenance CLI, GUI session
monitor, tree-provenance outbox publisher, emitter/runner replayable
write-failure publishers, emitter evidence-sidecar publisher, and the cutover
repair consumer of the watchdog writer. Embedded
remote acknowledgement journals are inventoried explicitly: their JSON
publication adopts the shared fence in Draft 1, while their cross-directory
lifecycle movement remains Draft 3.

It establishes the shared result and reconciliation contract used by the later
drafts. If any writer cannot meet the operation-identity or concurrency-fence
contract in this slice, the draft is incomplete. Even after Draft 1 is
complete, #2485 remains `IN PROGRESS` until Draft 3 removes the embedded
cross-parent false-success residual and proves the complete acceptance
boundary. The PR must not use closing keywords for #2485 or #2464.

### Draft 2: Stable lifecycle identity

**Issue:** #2427.

Draft 2 defines one canonical lifecycle identity and authoritative inventory
across raw queue entries, nested terminal records, acknowledgement retries,
dead-letter state, and test-leak state. It depends on the shared package and
manifest scaffold from Draft 1 but does not require cross-directory transition
implementation.

### Draft 3: Durable lifecycle transitions

**Issues:** closes #2482 and, only after the Draft 1 writer contract plus every
embedded parent-barrier residual is proven, closes #2485.

Draft 3 introduces a lifecycle-transition API distinct from atomic JSON
publication. It migrates collector, dispatcher, and embedded remote scripts,
preserves save-before-terminal-move ordering established by merged history,
syncs every changed parent exactly once, and reconciles ambiguous outcomes by
stable identity.

### Draft 4: State-generation recovery

**Issue:** #2463; references and may partially advance #2429.

Draft 4 wraps each owned controller-state class in a versioned generation
envelope, retains a bounded validated previous generation, and moves
unrecoverable state into `state_recovery_required` without authorizing
lifecycle progress or overwriting the only evidence.

#2463 owns corrupt or unreadable state-generation recovery. #2429 retains
configuration and roster-retirement disposition. Draft 4 must not close #2429
unless that residual is separately implemented and tested.

## Open Pull-Request Collisions

At the 2026-07-28 planning observation, open draft PR #2603 was at reviewed head
`615dd194f01f3440b27dd556a0e0a21e5d43e9bf` owns controller-log envelope and
diagnostic sink policy for #2508 and #2509. Its body explicitly leaves the
low-level durability primitive to #2464, so it is not an issue-ownership
collision. It is a material path collision: manifest, deployer, collector,
dispatcher, health-check, watchdog, q-loop, and related tests overlap Draft 1.

At the same planning observation, open draft PR #2604 was at reviewed head
`8b5dec468f2e1ce7bb134b05454443535475e0d3` owns runtime-health signal
dispositions for #2541 and #2544. It is not an issue-ownership collision, but
it materially overlaps the health-check adapter, runtime manifest and checker,
deployer, documentation, and focused tests. #2603 and #2604 are sibling
branches, so neither reviewed head contains the other's behavior.

Implementation must not proceed from the stale pre-#2603 base as though those
changes do not exist. Immediately before planning and again before opening
Draft 1:

- re-read #2603 and #2604 state, exact heads, files, checks, and semantic
  boundaries;
- if both are merged, base Draft 1 on the exact main commit containing both;
- if either remains open, do not choose one sibling and mechanically discard
  the other; first establish one explicit combined dependency head by a
  reviewed stack or integration branch, record both exact parents, and run the
  combined semantic tests;
- treat a private synthetic integration branch as local implementation evidence
  only; Draft 1 publication waits for exact main containing both or a public
  dependency-owner stack containing both;
- if superseded or changed, use `git range-diff` and `git cherry -v` to prove
  which behavior survives before selecting a new base; and
- rerun the controller-log, runtime-health, manifest, deployer, durability, and
  full BOT ERRORS suites on the combined exact head.

No issue lifecycle label changes merely because of this path collision.

## Draft 1 Architecture

### Shared module

The shared module owns:

- trusted-root acquisition and descriptor-relative traversal;
- exclusive sibling temporary creation;
- bounded JSON serialization;
- file-content flush and `fsync`;
- permission and ownership finalization before publication;
- create-once event publication and fenced state-generation replacement as
  distinct operations;
- exact changed-parent sync, deduplicated by descriptor/inode and ordered
  destination before source when parents differ;
- cleanup;
- bounded multi-axis outcome classification; and
- operation-ID, generation, and content-digest reconciliation after ambiguous
  publication.

Callers provide logical component class, publication kind, stable operation
ID, expected predecessor or generation where applicable, and payload. They do
not provide or receive publishable path text in diagnostics.

The module and every generated/embedded consumer are included in the BOT
ERRORS runtime manifest with exact content hashes and one helper-generation
identifier. Installers and deployers publish only a coherent manifest-verified
bundle. An isolated installed-bundle test proves imports without the source
tree. Missing or mixed helper/script generations fail closed, and rollout can
atomically retain or restore the previous coherent bundle. Embedded remote
scripts are produced from a canonical checked-in generator or serializer;
byte and behavior parity tests prove they implement the same state machine
rather than importing an unavailable local helper.

### Outcome model

The result records independent axes rather than collapsing them into one error:

| Axis | Required states |
|---|---|
| Durability | `not_mutated`, `committed`, `unproven`, `reconciled_committed` |
| Confinement/identity | `proven`, `unproven`, `violated` |
| Cleanup | `not_required`, `complete`, `debt_private_temp`, `debt_recovery_record` |
| Authority | `expected_predecessor`, `intended_authoritative`, `superseded`, `conflict`, `unknown` |

`pre_publication_failure` is a composite result allowed only when
`durability=not_mutated`, confinement is proven, cleanup is complete or limited
to a confined non-authoritative temporary object, and the expected predecessor
remains positively proven authoritative. `committed` requires proven confinement,
intended authority, and all required file and namespace barriers. Cleanup
failure after a proven commit records cleanup debt without revoking durability.
Permission, ownership, type, or path-confinement failure is never repaired by
digest or directory-sync reconciliation.

The result exposes one derived `advance_allowed` predicate. It is true only
when durability is `committed` or `reconciled_committed`, confinement/identity
is `proven`, authority is `intended_authoritative`, no conflict is present, and
cleanup is `complete`, `not_required`, or `debt_private_temp`.
`debt_private_temp` permits advancement because the object is confined,
unpublished, and not authoritative. `debt_recovery_record` blocks advancement
until reconciliation and durable retirement because replaying that record
could change lifecycle authority. Cleanup debt does not make committed content
uncommitted, but its class can still block dependent lifecycle progress.

A result that observes the target no longer matching the intended operation is
`superseded`, `conflict`, or `unknown`; it is never called
`reconciled_not_committed`. Callers may not blindly retry over newer authority.

The typed stage identifies:

- serialization;
- lock acquisition;
- temporary creation;
- write;
- file flush;
- file sync;
- publication;
- parent open;
- parent sync;
- permission finalization;
- cleanup; and
- reconciliation.

The public diagnostic projection is limited to component class, outcome,
stage, bounded error class, generation or count, and a domain-separated keyed
projection token. Raw content digests, operation IDs, identities, destinations,
or low-entropy state values remain inside private state and are never emitted
on a public or aggregate diagnostic surface.

### Descriptor and path trust

The operation starts by opening an explicitly configured trusted root with
`O_DIRECTORY | O_NOFOLLOW` and validating its type, owner, and mode with
`fstat`. Every intermediate directory is opened relative to the preceding
descriptor with the equivalent no-follow and directory constraints. The
target parent is never reacquired by pathname after validation.

Temporary creation, target inspection, permission finalization, publication,
and cleanup are descriptor-relative. The new regular file is created
exclusively, rejects an unacceptable pre-publication link count, receives
`fchmod` and required ownership before file flush and `fsync`, and is then
published through a descriptor-relative operation. The only permitted
two-link state is the verified temporary/target pair during create-once
publication. Root, intermediate, leaf, parent, and target swaps fail closed.
There is no pathname fallback.

`EXDEV` is not repaired through copy-and-delete. Atomic JSON publication must
either:

- remain within one verified parent/filesystem; or
- return a typed pre-publication failure before the authoritative target is
  changed.

Cross-directory movement belongs to Draft 3's explicit transition protocol.
Draft 1 nevertheless supplies and fault-tests the exact-parent barrier
primitive for same-parent and cross-parent sets; Draft 3 owns migration of the
lifecycle movers that call it.

### Publication kinds and concurrency

The module exposes no generic replace operation:

- create-once event publication uses descriptor-relative hard-link publication
  from the exclusively created temporary as the atomic no-clobber operation,
  followed by temporary unlink and the required parent barrier; an existing
  different event is a conflict;
- mutable state publication names an expected predecessor/generation and uses
  the shared exclusive lock before descriptor-relative replacement;
- reconciliation of the same operation proves operation ID, generation, raw
  private digest, and expected predecessor; and
- a later generation or different operation is superseding authority, not a
  retry opportunity.

The selected Darwin/Linux fence is `fcntl.flock(LOCK_EX)` on a reserved,
descriptor-relative lock entry inside each trusted parent. The lock entry is
opened with no-follow constraints, verified as a regular file with the
required owner and mode, and its first creation is parent-synced. Operations
touching two parents acquire their locks in `(st_dev, st_ino)` order,
deduplicate identical parents, and hold them from predecessor/vacancy
validation through the final namespace barrier and recovery-record update.
Kernel crash/exit releases the advisory lock; durable operation identity and
reconciliation handle the unfinished transaction.

All cooperating writers capable of mutating these private roots are included
in the structural inventory and must use the fence. The nine principal
components are the #2485 acceptance boundary, but that boundary does not exempt
utility publishers into the same roots. Each embedded remote publisher has an
explicit inventory row separating Draft 1 JSON publication from Draft 3
lifecycle movement. Trusted-directory ownership and mode exclude
non-cooperating untrusted writers. If `fcntl`, descriptor-relative hard-link
publication, no-follow traversal, or directory sync is unavailable, capability
detection returns a typed pre-mutation inconclusive/failure result; there is no
pathname or unfenced fallback. Platform tests run the same concurrency
contract on Darwin and Linux.

Exclusive sibling temporary creation is necessary but is not treated as a
destination collision fence. Draft 1 inventories and classifies every one of
the nine writers as event or state publication, then proves the corresponding
fence before Draft 3 may attempt #2485 closure.

### Post-publication ambiguity

Once namespace publication may have succeeded, any interruption or required
parent-sync failure makes durability `unproven`. Permission and ownership
finalization already occurred on the private temporary and therefore cannot be
a post-publication repair step. Cleanup is recorded separately.

Reconciliation:

1. starts again from the trusted root descriptor, re-walks descriptor-
   relatively, and verifies the expected parent device/inode identity;
2. reads the target through the safe bounded reader;
3. verifies the stable operation ID, expected predecessor, private raw content
   digest, and generation as applicable;
4. retries the required directory barrier when the platform contract permits;
5. classifies intended authority, supersession, conflict, or unknown;
6. returns the multi-axis reconciled outcome; and
7. never blindly republishes an event or generation with externally visible
   side effects.

### Caller migration

Every principal writer must consume the typed result explicitly.

- Emitter and runner do not report an event queued until the namespace commit
  is proven.
- Collector and dispatcher do not acknowledge, close, suppress, retry, or
  clear from an unproven state generation.
- Health, daily health, watchdog, q-loop, selfcheck, and sentinel do not publish
  a healthy or recovered observation from an unproven write.
- None of the nine claimed event/state publications may call a weaker
  best-effort API. Any allowed diagnostic-only path is exhaustively listed in
  a checked-in caller inventory, uses a separately named API, emits an
  independent metadata-only diagnostic, and cannot silently opt out by
  ignoring the result. A guard rejects new callers until that inventory and
  review evidence are updated.

## Draft 2 Identity Contract

The stable identity is created once at event admission and survives every
queue, processing, terminal, dead-letter, test-leak, and remote acknowledgement
representation.

The canonical inventory:

- enumerates all terminal and retryable lifecycle locations;
- normalizes raw and nested record shapes;
- rejects missing, malformed, or conflicting identity;
- retains acknowledgement obligations until content-bound remote proof is
  durable;
- makes restart and retention-boundary behavior explicit; and
- never derives identity solely from a mutable filename.

Acknowledgement retry converges on the same stable identity rather than
creating a second lifecycle event.

## Draft 3 Transition Contract

A lifecycle transition is a state machine with three explicit protocols.

For an unchanged representation on the same filesystem:

1. acquire the source and destination parent locks in canonical order, then
   validate source identity, expected state, and destination vacancy through
   the trusted parent descriptors while those locks remain held;
2. perform one descriptor-relative `rename`/`replace` that preserves the
   current lifecycle semantics without a vacancy-check race;
3. `fsync` the destination parent before the source parent, deduplicating when
   they are the same descriptor/inode, so an interruption can at worst retain
   a duplicate source rather than durably remove the only proven copy; and
4. reconcile any interrupted barrier by stable identity before advancing
   lifecycle truth.

For a transformed terminal representation such as dead-letter:

1. validate and persist an operation recovery record;
2. create, finalize, file-sync, and no-clobber publish the destination
   representation;
3. sync the destination parent;
4. remove the source only after destination durability is proven;
5. sync the source parent; and
6. retire and durably sync the recovery record only after both sides are
   reconciled.

For `EXDEV`, the chosen behavior is the same explicitly non-atomic staged
copy/publish/source-removal handshake used for transformed terminal
representations. It is never labeled atomic. Interruption can leave both
representations; stable operation identity and the recovery record determine
which phase is authoritative and prevent duplicate acknowledgement. An
ambiguous identity, destination collision, or unproven recovery record fails
closed for operator reconciliation.

Embedded remote scripts use the same logical state machine and outcome
vocabulary. Platform capability differences are explicit and fail closed.

A structural inventory must cover every local and embedded mover for claim,
reclaim, retry, acknowledgement, sent, suppressed, quarantine, test-leak,
collapsed, write-failure, and dead-letter transitions. The guard rejects an
unclassified move or a transition that bypasses the protocol.

## Draft 4 Generation-Recovery Contract

The eight destructive-reset state owners are collector, heartbeat watchdog,
dispatcher incident state, q-loop, sentinel, GUI-session monitor, health-check
deadman state, and maintenance CLI/dispatcher windows. Selfcheck memory
semantic poison is an additional negative-control state owner: it must not be
silently healed, but it is not miscounted as one of the eight resetters.

Every migrated state owner records:

- schema version;
- monotonic generation;
- content digest;
- creation timestamp where already contractually available;
- previous-generation binding; and
- bounded state payload.

Generations and authority records are immutable objects. Each authority record
has a monotonic sequence, primary and previous generation bindings, its
predecessor authority sequence and digest, and its own digest. Rotation occurs
under the state-owner lock:

1. create and fully file-sync a new immutable generation;
2. publish it under a no-clobber generation name and sync that namespace;
3. create and file-sync a new immutable authority record conditional on the
   expected predecessor;
4. no-clobber publish and parent-sync that authority record, which advances
   authority without rewriting a pointer file;
5. retain at least the current and previous authority records plus every
   generation they reference; and
6. only after the new authority is durable, prune older closed records and
   generations, syncing the parent after each bounded prune batch.

Load scans the bounded authority journal rather than trusting one mutable
pointer. It validates record digests, predecessor chains, monotonic sequences,
and referenced immutable generations. Two valid records at the same sequence,
an unlinked fork, a missing predecessor inside the retention window, or
ambiguous highest authority enters `state_recovery_required`. A corrupt newest
record can recover from the last uniquely valid chain only after the corrupt
bytes are durably preserved and a new immutable authority record supersedes
the observed highest sequence.

Recovery after interruption examines the old and new immutable authority
records, generations, expected predecessor binding, and barrier receipts. An
interruption before authority publication leaves the prior record
authoritative; an interruption after publication reconciles the new record's
namespace barrier before use. At every boundary recovery either proves one
monotonic authority or enters `state_recovery_required`; it never guesses from
modification time. Corrupt evidence is first published and synced into the
private retention boundary before any superseding authority or pruning. If
that evidence publication or its barrier is unproven, recovery itself remains
unproven and no authority is advanced.

On load:

1. validate the primary generation structurally and cryptographically;
2. if invalid, validate the retained previous generation;
3. if the previous generation is valid, recover through the rotation protocol
   into a new committed generation and emit a metadata-only recovery receipt;
4. otherwise enter `state_recovery_required`;
5. preserve corrupt evidence under the existing private retention boundary;
   and
6. forbid lifecycle transitions, false-green health, or destructive reset
   until recovery is proven.

The loader never converts malformed, unreadable, truncated, or incompatible
state into an empty authoritative default. A restored last-known-good
generation preserves lifecycle ownership only; it is not fresh health or
recovery proof. The owning component must freshly re-observe the underlying
condition before any clear, healthy result, cooldown reset, remediation, or
lifecycle progress.

Health reports `bootstrap`, `recovered`, `unrecoverable`, and `reconciled` as
distinct states. `recovered` remains unverified and fail-visible until a fresh
observation; only `reconciled` follows that observation and may contribute
healthy evidence.

Component-specific failure policy is explicit:

| State owner | Blocked mutations while recovery is unproven | Delivery/diagnostics allowed | Fresh proof required |
|---|---|---|---|
| Collector | acknowledgement, terminal move, retry reset, stale clear | metadata-only recovery alert; retain current obligation | queue and remote acknowledgement inventory |
| Heartbeat watchdog | healthy clear, cooldown reset, remediation success | fail-visible watchdog alert | new heartbeat observation |
| Dispatcher incident | suppress, resolve, terminalize, or reset attempts | ordinary unsuppressed alert delivery and recovery diagnostic | queue plus terminal/ack inventory |
| Q-loop | resolve, healthy clear, or retry reset | independent fail-visible alert | new loop and queue observation |
| Sentinel | healthy clear, cooldown reset, or remediation success | metadata-only sentinel alert | new sentinel probe |
| GUI-session monitor | healthy/session clear or recovery success | fail-visible session alert | new GUI-session observation |
| Health-check deadman | green result, deadman clear, or age reset | stale/unrecoverable health alert | new complete health observation |
| Maintenance CLI/dispatcher | maintenance suppression, resolve, or window reset | ordinary alert delivery remains unsuppressed | new validated maintenance window/state observation |

Selfcheck semantic poison follows the same fail-visible principle and must pass
fresh semantic validation, but it remains a negative control outside the eight
destructive-reset owners.

## Test Strategy

Implementation is test-driven. Existing tests that accept silent parent-open
failure become RED-first fault tests before production changes.

### Draft 1 fault matrix

The shared helper runs the complete matrix below. Each of the nine principal
writers and every cooperating adapter runs the serialization, ambiguity, and
caller-specific no-advance vectors for its inventory classification:

- stable operation-ID replay and expected-generation serialization;
- exclusive temporary-create collision and destination collision;
- short write and `ENOSPC`;
- file flush and file `fsync` failure;
- same-parent publication failure and unexpected `EXDEV`;
- parent open fails with `EACCES`, `EMFILE`, and `ENFILE`;
- parent sync fails with an I/O error;
- same-parent barriers sync once and cross-parent barriers sync destination
  before source exactly once each;
- directory sync is unsupported;
- interruption occurs after publication and before parent sync;
- temporary cleanup fails;
- permission finalization fails;
- denied stat/chmod and ownership mismatch;
- ambient umask cannot weaken the final mode;
- root, intermediate, parent, and leaf symlink or non-directory substitution;
- hard-link rejection or documented safe policy;
- parent and target swaps after validation;
- concurrent create-once and state-generation writers;
- lock creation, lock-acquisition failure, canonical two-parent acquisition,
  contention, and crash release;
- reconciliation sees intended, predecessor, superseding, conflicting,
  malformed, and absent targets;
- real process crash and restart at every mutation boundary; and
- no unproven outcome becomes ordinary success.

Positive controls prove committed success and idempotent same-operation
reconciliation. Serialization/fault cases run for every caller classification,
not only the helper.

### Draft 2 tests

- identity survives every raw and nested lifecycle state;
- restart reuses the same identity;
- acknowledgement failure retains the obligation;
- retention boundaries do not orphan active acknowledgement;
- malformed or conflicting identity fails closed; and
- dead-letter and test-leak entries remain in the canonical inventory.

It directly proves a delayed remote claim that matches terminal state creates
no outbox copy, leaves the terminal record byte-stable, and does not reset
delivery attempts. Repeated lease expiry and acknowledgement failure must
converge, and no tombstone may expire before its remote obligation.

### Draft 3 tests

- same-parent and cross-parent transitions sync the exact parent set;
- destination-sync and source-sync failures remain distinguishable;
- interruption is injected at every state-machine boundary;
- embedded remote behavior matches local behavior;
- `EXDEV` follows the proven, explicitly non-atomic staged protocol;
- save-before-terminal-move ordering is preserved; and
- stable-identity reconciliation prevents duplicate acknowledgement or
  lifecycle advancement.

The test and structural inventory covers claim, reclaim, retry,
acknowledgement, sent, suppressed, quarantine, test-leak, collapsed,
write-failure, and dead-letter movers in local and embedded scripts.

### Draft 4 tests

- valid primary generation loads;
- corrupt primary recovers only from a valid previous generation;
- corrupt primary and previous generations enter
  `state_recovery_required`;
- truncated, malformed, wrong-version, and digest-mismatched state never
  resets to empty truth;
- restart preserves generation ordering;
- interruption at every immutable-generation, namespace, authority-advance,
  authority-journal fork/corruption, evidence-preservation, and prune boundary
  converges or fails closed;
- recovery does not authorize a queue or incident transition prematurely; and
- #2429's retained configuration/roster boundary remains explicit.

Concrete #2429 regressions cover remove/re-add, rename/rekey, open-incident
retirement, and no-false-clear behavior. Draft 4 must preserve those existing
semantics and cannot treat generation recovery as configuration or roster
retirement.

The full corruption and rotation matrix runs against collector, watchdog,
dispatcher, q-loop, sentinel, GUI monitor, health-check deadman, and
maintenance state. Selfcheck semantic poison is a negative control proving
that syntactically valid but semantically invalid memory cannot become healthy.

## Validation Gates

Every draft must run:

- its focused Python and TypeScript wrapper tests;
- the BOT ERRORS behavioral and manifest gates;
- the durability-writer invariant guard;
- typechecking for scripts and all registered surfaces;
- test-integrity scanning;
- publication, public-surface, source-runtime, and repository branch-diff
  guards;
- `git diff --check`;
- the enforced pre-push gate; and
- hosted Node 24, Node 25, macOS health, performance, and security analysis
  checks at the exact pushed head.

Masked, skipped, missing, stale, or environment-blocked checks are
inconclusive.

## Review and Lifecycle Rules

Each draft PR body includes:

- exact base and head revisions;
- owned issues and non-closing tracker references;
- history and open-PR collision analysis;
- affected callers and blast radius;
- RED/GREEN fault-injection receipts;
- exact reproduction commands;
- validation results and explicit limitations;
- rollback or safe-stop behavior; and
- public-surface scan results.

When a draft is complete and reproducibly validated:

1. add or verify the direct issue comment linking the draft;
2. confirm GitHub's automatic timeline backlink separately;
3. remove `IN PROGRESS`;
4. add `PATCH READY`; and
5. verify the issue never carries both labels.

| Draft | Only issue eligible for `PATCH READY` | Non-closing references |
|---|---|---|
| 1 | none; #2485 remains `IN PROGRESS` pending Draft 3 | #2485 and #2464 remain non-closing |
| 2 | #2427 | none |
| 3 | #2482 and #2485, only if the full embedded parent-barrier residual is proven | none |
| 4 | #2463 | #2429 remains open and non-closing |

No primitive-only draft may transition #2485. Each eligible issue remains
`IN PROGRESS` if its draft is incomplete, has inconclusive checks, or lacks
reproducible caller evidence.

The design spec and later plan are deliberately force-tracked despite the
ignored `docs/superpowers/` default. Each receives its required
`PRIVATE-ARCHIVE` row in `docs/publication-audit.md` and regenerated
work-index artifacts in the same commit.

## Completion Criteria

The four-draft stack is complete only when:

- every owned leaf acceptance criterion has direct fault-injection evidence;
- no caller converts an unproven outcome into success;
- stable identity survives restart and every lifecycle representation;
- lifecycle transitions prove the exact namespace commit;
- corrupt state recovers from a validated generation or fails closed;
- #2464 and #2429 retain truthful residual scope;
- all exact-head local and hosted gates are terminal-green;
- independent reviewers inspect decisive diffs and falsifiers; and
- issue comments, automatic backlinks, and lifecycle labels match the verified
  draft state.
