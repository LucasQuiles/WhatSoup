# Durable Incident Remediation Protocol Design

**Date:** 2026-07-20

**Status:** Pending review — local design only; implementation, live cleanup, deployment, service changes, and outbound messaging remain separately gated

**Audited WhatSoup base:** `6d38d9f0fa3698e8ae1c14bfde69b2ac503eb0e0`

**Private operational evidence:** Exact host, line, chat, and message identities are retained in the owner-local investigation record and intentionally omitted from this public repository.

## 1. Outcome

Make BOT ERRORS an evidence-driven remediation channel rather than a stream of repeated symptoms, while repairing the inline proposal classifier that created a large false backlog.

The completed protocol must provide four outcomes:

1. inline proposals are created only from an explicit admin-authored imperative at the start of a real text message;
2. repeated delivery or crash recovery cannot create duplicate proposals for one source message;
3. an incident closes only from fresh, authoritative recovery evidence that satisfies a machine-checkable policy;
4. repeated observations, actual state transitions, remediation attempts, and operator-required work remain distinguishable under replay, concurrency, restart, and partial failure.

This design extends existing WhatSoup primitives: the message store, inbound durability journal, bead transaction/event ledger, BOT ERRORS outbox, dispatcher incident ledger, stronger-root inhibition, and health proof paths. It does not introduce a second incident bus.

## 2. Safety and Authorization Boundary

The protocol observes and classifies automatically, but it does not broaden mutation authority.

- Read-only health, queue, thread, database-copy, release, and log inspection may run automatically.
- Safe local retries may occur only where an existing replay policy already authorizes them.
- Relinking WhatsApp, changing credentials, deploying releases, restarting services, modifying remote databases, retiring durable evidence, or sending operator messages requires the applicable owner-approved operation.
- Unknown evidence, failed probes, masked commands, missing receipts, and partial writes are `inconclusive`; none is converted into healthy state.
- Cleanup never deletes false proposals. It creates a backup and manifest, then soft-cancels rows and appends events in one transaction.
- Private identifiers and raw chat bodies never enter public fixtures, documentation, logs, or commits.

## 3. Evidence and Working Hypotheses

### 3.1 Inline proposal evidence

A read-only fleet audit found 736 open proposed beads across three agent instances. Reclassification with a start-anchored imperative grammar retained four intended commands and rejected 732 report-like messages. One instance contained 699 proposals, of which 684 were overdue. All audited inline rows lacked `source_message_pk` linkage.

The dominant rejected categories contained imperative words in status prose, especially `schedule`, `follow up`, and `watch for`. The current extractor uses unanchored regular expressions and the runtime applies them to the complete admin-authored message body.

**H1:** Unanchored matching is the primary false-proposal cause.

**Falsifier:** A representative report corpus still creates proposals after the grammar is anchored and message-shape gates are applied.

### 3.2 Incident lifecycle evidence

The dispatcher already has durable incident state, duplicate suppression, transient holding, stronger-root inhibition, stale handling, and critical-asset recovery metadata. Two lifecycle defects remain:

- `clearRequirement` is advisory; a mismatched clear is annotated but still closes the incident.
- flap accounting records every raw alert file as a trip before duplicate collapse. Repeated evidence for one continuously open incident can therefore create and continually escalate a flap storm without an observed recovery transition.

The live channel continues to show this pattern: a release-drift source accumulates raw-trip counts while remaining unresolved, and a separate stale heartbeat remains open. A short provider fallback incident did emit a matching clear and recovery notice, demonstrating that real transition data is available when producers supply it.

**H2:** Repeated unresolved evidence is being interpreted as instability because flap detection counts observations rather than accepted open/close transitions.

**Falsifier:** The raw events contain verified accepted clears between the counted alerts.

**H3:** Free-form recovery requirements permit false closure and make cross-source recovery ambiguous.

**Falsifier:** Every accepted clear in the captured lifecycle corpus already has a newer authoritative proof that satisfies the stored requirement.

### 3.3 Cleanup evidence

The 732 false candidates are deterministically separable by the approved grammar, while four audited candidates remain valid. Existing bead status changes already append events transactionally.

**H4:** The false backlog can be retired reversibly without deleting data or changing valid proposals.

**Falsifier:** Any cleanup candidate satisfies the new grammar, lacks an exact manifest entry, or cannot be restored from its prior row and event state.

## 4. Approaches Considered

### Approach A — Anchored admission plus typed incident lifecycle (selected)

Tighten inline admission at the existing runtime hook, add source-message idempotency, and evolve the existing BOT ERRORS envelope and dispatcher state machine with typed observation and clear-proof fields.

Advantages:

- fixes both observed root causes at their current chokepoints;
- reuses existing durable storage and delivery paths;
- preserves legacy producer compatibility through an explicit adapter;
- supports reversible cleanup and staged rollout;
- distinguishes continuous failure from true flapping.

Cost: a database migration, envelope versioning, dispatcher state migration, and broader state-machine tests.

### Approach B — Explicit slash commands only

Require an admin to use a command such as `/task` and disable natural-language capture.

This has the lowest ambiguity but removes the intended lightweight workflow and would invalidate currently intended imperatives. It remains a future strict-mode option, not the default repair.

### Approach C — Suppression and automatic proposal expiry

Keep the current classifier, suppress repeated backlog alerts, and auto-cancel old proposals.

This reduces visible noise but leaves false writes, destroys review signal, and can retire legitimate work based only on age. It is rejected as symptom treatment.

### Approach D — A replacement incident service

Create a new service and database for normalized incident events.

This could provide a clean schema but would duplicate the durable outbox, dispatcher, incident state, and operating path. It adds migration and split-brain risk without being necessary for the observed defects.

## 5. Inline Proposal Admission Contract

### 5.1 Eligible message

An inline proposal is eligible only when all conditions are true:

- the transport-authenticated sender resolves to a configured admin phone;
- `isSyntheticJob` is false;
- `contentType` is `text`;
- the message is a newly stored inbound message with a non-null message primary key;
- the classification view is at most 8 KiB after UTF-8 encoding;
- the classification view does not begin with a quote marker, forwarded-content marker, or fenced code block;
- the normalized text matches the grammar below at offset zero.

The group mention-removal step may run first, as it does today. Quoted-message metadata does not by itself reject a reply: only the newly authored body is classified. Media captions, transcriptions, synthetic jobs, history sync, control messages, echoes, and replayed duplicate deliveries are not implicit proposal sources.

### 5.2 Normalization

Classification uses a copy of the body; the stored bead body remains the sanitized original.

1. strip a UTF-8 byte-order mark;
2. normalize to Unicode NFKC;
3. convert line separators to `\n`;
4. trim leading horizontal whitespace only;
5. preserve all remaining content for target extraction.

NFKC does not authorize visually similar characters from another script. Empty, whitespace-only, over-limit, malformed, or non-text input fails closed with no proposal.

### 5.3 Anchored grammar

The optional politeness prefix is `please` followed by whitespace or a comma and whitespace. One of these phrases must follow immediately:

```text
remind me
schedule
watch for
follow up
make a task
track this
add a bead
```

Matching is case-insensitive and anchored to the normalized message start. A word boundary or required separator follows the phrase. The target may begin after `to`, `for`, `that`, `about`, or `:`. A non-empty target is required.

Examples admitted:

```text
Schedule a restart for 21:00
please, follow up with the release owner tomorrow
  Remind me to review the recovery ledger
```

Examples rejected:

```text
The schedule monitor is stale
Status: follow up remains required
We should watch for another reconnect
> schedule a restart
[a fenced code block beginning with "schedule a restart"]
```

Only the leading imperative controls capture. Imperative words later in a valid target do not create additional beads.

### 5.4 Source linkage and idempotency

The ingest path threads the stored message primary key into `IncomingMessage` beside `inboundSeq`. Inline capture writes that primary key to both `beads.source_message_pk` and the initial `bead_events.source_message_pk`.

A partial unique index prevents more than one inline-imperative bead for the same non-null source message. The idempotent create path follows the existing trigger and turn-finalization pattern:

- first writer creates the bead and initial event in one transaction;
- an exact duplicate returns the existing bead without appending another event;
- a conflict with different owner, chat, source, verb, or normalized target fails closed as an idempotency collision and emits bounded operator evidence;
- a crash before commit leaves neither bead nor event;
- a retry after commit resolves to the existing bead.

Content-level deduplication is deliberately excluded. Two distinct source messages can intentionally create two proposals.

### 5.5 Classification result

The extractor returns a typed result rather than only a regex match:

```text
admitted { verb, normalizedTarget, matchedText }
rejected { reason }
```

Rejection reasons use a bounded, content-free vocabulary such as `not_anchored`, `unsupported_message_type`, `quoted_or_fenced`, `empty_target`, `oversize`, and `invalid_unicode`. Routine rejections are debug metrics, not BOT ERRORS incidents. Extractor exceptions, storage collisions, and database failures remain operator-visible.

## 6. BOT ERRORS Observation Protocol

### 6.1 Versioned envelope

Schema version 2 adds typed fields while retaining the current redacted summary, evidence, diagnostics, delivery, and critical-asset data:

```text
schemaVersion: 2
id: globally unique event identity
eventType: alert | clear
createdAt: durable queue creation time
observedAt: producer observation time
machine, instance, source: stable incident identity dimensions
observation:
  state: fault | healthy | unknown
  fingerprint: stable hash of bounded normalized evidence
  producerSequence: optional monotonic producer counter
  confidence: suspected | probable | confirmed
clearPolicy:
  kind: same_source_newer | health_snapshot | outbound_after_incident |
        auth_bond_and_outbound | source_quiet_and_health | manual_ack
  proofRef: bounded reference to durable evidence
  proofObservedAt: optional proof time
  minimumSchemaVersion: integer
remediation:
  recoverability: typed existing vocabulary
  requestedAction: bounded action code
  authorization: automatic_read_only | automatic_safe_retry | owner_required | physical_required
```

The event builder validates enums, timestamps, bounded lengths, and the relationship between `eventType` and `observation.state`. It redacts before writing and uses the existing durable temporary-write, rename, mode, and directory-fsync sequence.

### 6.2 Legacy adapter

Schema version 1 remains accepted during migration. The dispatcher converts it to an internal observation:

- an alert becomes `fault` with `same_source_newer` as the minimum clear policy;
- a clear becomes `healthy` but can close only the identical derived incident key and only when its event time is not older than the opening observation beyond the clock-skew allowance;
- existing free-form `clearRequirement` remains display metadata and cannot weaken the typed minimum;
- critical-asset events with a recognized existing requirement map to the corresponding stronger policy;
- malformed or unsupported versions move to quarantine with a typed reason and never mutate incident state.

Compatibility is time-bounded by rollout criteria, not silently permanent.

### 6.3 Persistent replay receipt

The incident ledger stores a bounded set of processed event IDs and their evidence fingerprints. Recollection or dispatcher restart therefore cannot count or resend the same event twice. An event ID reused with a different fingerprint is quarantined as an identity collision.

Receipt pruning is based on both age and capacity and never removes IDs still referenced by an open incident, pending clear, or flap history.

## 7. Incident State Machine

### 7.1 States

The durable states are:

```text
absent -> suspected -> open -> recovery_candidate -> closed
                        |
                        +-> awaiting_physical
```

`awaiting_physical` remains an open incident with a different reminder cadence and authorization class. `stale` is an evidence-freshness annotation, not a recovered state. `remediating` is recorded in the remediation ledger rather than replacing the truth state of the incident.

### 7.2 Transition rules

- `absent + fault`: open immediately for hard faults, or enter `suspected` for configured transient classes.
- `suspected + repeated fault`: promote only after the existing dwell threshold; a healthy observation before promotion retires the suspicion silently.
- `open + repeated fault`: update last-seen time, evidence fingerprint, and repeat counters. Do not create a new opening or flap trip.
- `open + unknown`: keep the incident open and record degraded observability.
- `open + healthy`: evaluate freshness, identity, and `clearPolicy`. Insufficient proof creates or updates `recovery_candidate` evidence but leaves the incident open.
- `open/recovery_candidate + accepted healthy`: close once, append a transition receipt, and retain bounded history for reopen/flap evaluation.
- `awaiting_physical + repeated fault`: remain open; do not age out or convert silence to recovery.
- any stale or out-of-order event: retain as replay evidence where safe, but do not move state backward or close a newer incident.

Every accepted transition is written atomically with incident state, replay receipt, and notification decision. Failed state persistence prevents the queue item from being acknowledged.

### 7.3 Clear proof

A clear is accepted only when all applicable conditions hold:

1. its derived incident identity matches the open incident;
2. its event and proof timestamps are newer than the opening evidence within the explicit skew tolerance;
3. its schema version satisfies the stored minimum;
4. its proof kind equals or exceeds the stored clear policy;
5. any referenced health snapshot, outbound receipt, auth-bond check, or manual acknowledgement is present and valid;
6. the producer is authorized for that proof kind.

A mismatched clear is suppressed, recorded as rejected proof, and leaves the incident open. This replaces the current advisory-only behavior.

### 7.4 Root-cause inhibition

The existing stronger-open-incident map remains the source of symptom inhibition. A symptom observation under an open stronger incident:

- is retained as a suppressed observation on the root record;
- does not open a second operator page;
- cannot clear the stronger incident;
- becomes independently eligible again when the stronger incident closes and fresh symptom evidence persists.

The inhibition map must use typed source/action codes, with legacy string aliases only in the adapter.

## 8. Flap Detection

A flap is a verified state transition, not an event arrival.

- Record a flap transition only when an incident that reached `closed` later accepts a new `fault` opening.
- Repeated alerts while `open`, duplicate event IDs, stale replays, held transient observations, and rejected clears do not increment flap counts.
- The sliding window uses dispatcher receipt time for ordering and stores the producer observation time for diagnostics.
- A storm opens when accepted reopen transitions cross the configured threshold.
- A storm resolves only after the underlying incident is closed with valid proof and no accepted reopen occurs for the stability interval.
- Collector or producer silence alone cannot resolve a storm; liveness must also be verified.

Migration preserves cumulative raw-trip counts as legacy diagnostics but starts typed transition counts separately. The user-facing alert labels the metric as `verified_reopens`, never `trips`, after promotion.

## 9. Remediation Ledger

Each incident may have append-only remediation attempts:

```text
attemptId
incidentKey
actionCode
authorizationClass
requestedAt / startedAt / finishedAt
actor
preconditionEvidenceRefs
result: succeeded | failed | inconclusive | blocked
resultEvidenceRefs
rollbackRef
```

Rules:

- an attempt does not imply recovery;
- `succeeded` means the action completed, not that the incident cleared;
- closure still requires the incident's proof policy;
- retries use an action-specific idempotency key and bounded backoff;
- an expired lease may be reclaimed only with an explicit receipt;
- physical and owner-required actions remain visible without repeated execution;
- destructive or identity-changing operations have no automatic executor.

The first implementation may store this data in the existing incident-state document if atomicity and bounded growth tests pass. A separate SQLite table is warranted only if those tests falsify the file-ledger approach.

## 10. Reversible Backlog Cleanup

Cleanup is a dedicated operator command with `plan`, `apply`, and `verify` phases.

### 10.1 Plan

- Open a consistent read-only copy of the database, including WAL and SHM companions.
- Select only `status='proposed'`, `actor='inline'` rows whose original body fails the new classifier.
- Produce a private manifest containing database fingerprint, schema version, bead IDs, prior status/timestamps, source linkage, body hash, reason, and the four retained-valid counts.
- Refuse to plan when source events are ambiguous or the classifier version is unknown.

### 10.2 Apply

- Require an exact manifest/database fingerprint match.
- Create a recoverable database backup before mutation.
- Begin one immediate transaction.
- Re-read every candidate and abort on drift.
- Set status to `cancelled`, stamp `cancelled_at`/`updated_at`, and append a `status_change` bead event with actor `inline-proposal-cleanup`, reason code, classifier version, and manifest ID.
- Commit only when affected-row and event counts exactly match the manifest.

No row is deleted and no valid proposal is modified. A busy, full, read-only, or changed database fails closed.

### 10.3 Verify and rollback

Verification checks the database integrity result, candidate count, retained-valid count, event count, open-overdue count, and backup readability. The command emits a private receipt.

Rollback consumes the same manifest and restores only rows still carrying the exact cleanup event/status expected from that manifest. Any subsequent human or agent edit blocks automatic rollback for that row and requires review.

## 11. Monitoring and Supervision Loop

The ongoing operator loop remains bounded and read-first:

1. read the incident chat from an authoritative instance socket using a timestamp/message cursor;
2. inspect dispatcher queues and incident ledger counts;
3. correlate each new alert with producer health, release proof, durability state, and prior incident history;
4. classify it as a repeat observation, real transition, new root incident, inhibited symptom, resolved incident, or physical/owner-required work;
5. perform only authorized remediation, then collect independent proof;
6. write a compact private handoff containing cursor, open incidents, attempts, blockers, and next proof due.

Thread reads are capped, socket retries use fresh bounded connections, and database fallback is labeled as potentially incomplete. Monitoring does not reply to the group merely to acknowledge an alert. An outbound update is reserved for a new actionable incident, a verified transition, a requested decision, or a remediation receipt.

The loop itself has health evidence: last successful authoritative read, last queue inspection, last incident-ledger write, and current cursor. A stale supervisor opens a separate monitoring incident rather than declaring the underlying fleet healthy.

## 12. Edge-Case Matrix

### 12.1 Classifier

- leading spaces, BOM, `please`, comma, capitalization, punctuation, and multiline targets;
- empty targets and separator-only targets;
- imperative words mid-sentence, in status reports, quoted blocks, code fences, URLs, stack traces, JSON, and release notes;
- Unicode normalization, emoji, combining marks, non-Latin homoglyphs, lone surrogates, and maximum byte length;
- group mention stripping, LID/JID resolution, spoofable transports, non-admin senders, and admin configuration drift;
- text versus captions, transcripts, history messages, synthetic jobs, control messages, and outbound echoes;
- repeated delivery, message edit, concurrent capture, restart before commit, and restart after commit.

### 12.2 Incident lifecycle

- duplicate ID/same fingerprint and duplicate ID/different fingerprint;
- fault replay while open, clear replay after close, clear before open, and out-of-order collector delivery;
- producer clock skew, missing time, future time, and dispatcher restart;
- legacy alert/clear conversion and unsupported schema quarantine;
- stronger root opening before or after a symptom;
- transient recovery before promotion and fault persistence after promotion;
- insufficient clear proof, wrong source, stale proof, missing referenced receipt, and valid stronger proof;
- waiting for physical action, monitoring silence, and liveness restoration;
- state write failure, queue rename failure, disk full, corrupt JSON, permission failure, and concurrent dispatcher invocation.

### 12.3 Remediation and cleanup

- stale plans, changed rows, partial backups, missing WAL/SHM, database busy, constraint failure, disk exhaustion, and process crash;
- repeated apply, repeated rollback, rollback after later human edits, and mixed valid/invalid candidate sets;
- successful action without recovery, failed action with later spontaneous recovery, and lease expiry during an attempt.

## 13. Test and Stress Strategy

### 13.1 Red-first unit tests

Classifier tests first encode all admitted and rejected grammar cases. Dispatcher tests first demonstrate the two current defects: a mismatched clear closes an incident, and repeated alerts increment flap trips. Implementation proceeds only after those tests fail for the expected reasons.

Tests assert state and receipts, not merely function calls or output text. Timing uses fake clocks or condition polling; no fixed sleeps are added.

### 13.2 Captured-structure corpus

Build a privacy-safe fixture corpus from synthetic messages that preserve the structure and reason distribution of the read-only audit without copying private bodies or identifiers.

Acceptance:

- all 732 audited false-candidate structures reject;
- all four audited intended-command structures admit;
- each rejection reports the expected bounded reason;
- normalization does not change the stored body.

The private audit tool may additionally run the classifier against database snapshots and report only aggregate counts and content hashes.

### 13.3 Idempotency and crash injection

- 100 concurrent attempts for one source key produce one bead and one initial event.
- Distinct message primary keys with identical content produce distinct beads.
- Fault injection before insert, after insert, after event write, and before commit leaves either zero complete capture or one complete capture, never a half-pair.
- Restart/retry after a committed write returns the existing bead.
- An idempotency-key collision with different content fails closed.

### 13.4 State-machine model tests

Generate deterministic seeded event sequences and compare the dispatcher with a small pure reference model. Cover every state/event pair plus reordering, duplication, invalid proof, root inhibition, and legacy adaptation.

Required invariants:

- an incident never closes without accepted proof;
- repeated faults while open never increment verified reopen count;
- a verified reopen requires a prior accepted close;
- replaying an event sequence is idempotent;
- state time never moves backward;
- unknown evidence never becomes healthy;
- notification failure never commits an acknowledged transition unless durable retry ownership exists.

### 13.5 Load, soak, and resource tests

The non-CI stress command uses a fixed seed and records environment, commit, duration, peak RSS, database size, and state size.

- classify 10,000 mixed normal-size messages and 1,000 maximum-size messages;
- process 100,000 observations across at least 1,000 incident keys with duplicates and reordering;
- run concurrent producer and dispatcher loops against temporary outbox/state directories;
- inject SQLite busy, filesystem permission, disk-full, truncated-write, and process-termination faults;
- restart the dispatcher repeatedly during queue drain;
- soak a read-only production snapshot with outbound network disabled.

Correctness and bounded-growth assertions are hard gates. Wall-clock numbers are recorded as benchmarks and compared to an established baseline; they are not flaky absolute CI pass criteria.

### 13.6 Test integrity

- every randomized test records its seed;
- every fault injection proves the intended fault actually occurred;
- negative controls demonstrate that the harness detects one intentionally broken invariant;
- subprocess pipelines preserve the decisive exit code;
- skipped, timed-out, masked, or truncated checks are reported as inconclusive;
- tests use isolated temporary directories and close every owned process and database handle.

## 14. Rollout and Compatibility

### Local proof

- Land red-first classifier, idempotency, dispatcher, migration, and cleanup tests.
- Run focused tests, typecheck, lint, repository guards, test-integrity scan, and deterministic stress suites.
- Update `docs/runbooks/substrate-slice-1.md`, BOT ERRORS operating documentation, and the event schema reference in the same change.

### Shadow classification

- Run old and new classifiers side by side on copied databases without writes.
- Record aggregate disagreement by reason and retain body hashes only.
- Require all known false structures to reject and all reviewed valid structures to admit.

### Protocol compatibility canary

- Enable schema-v2 production for one low-risk producer while the dispatcher accepts both versions.
- Exercise one alert, repeated-fault suppression, one rejected clear, and one accepted clear in an isolated test target.
- Verify queues, incident ledger, replay receipt, and notification count return to the expected state.

### Staged runtime rollout

- Re-cut releases through the repository's release workflow; do not backfill manifests into old releases.
- Deploy to one low-volume agent instance, observe through a full monitoring interval, then expand by role.
- Runtime restarts, remote writes, and live cleanup remain explicit execution steps with backups and rollback receipts.

### Backlog cleanup

- Generate and review the private plan.
- Apply only after the new classifier is deployed and the database fingerprint still matches.
- Verify retained-valid and cancelled counts before clearing the overdue-proposal incident.

### Legacy retirement

- Measure remaining schema-v1 producers.
- Upgrade each producer and prove alert/clear behavior.
- Disable permissive compatibility only when no required producer remains and rollback has been rehearsed.

## 15. Acceptance Criteria

The implementation is ready for a live execution plan only when all are true:

- start-anchored grammar and message-shape gates pass the complete edge-case matrix;
- source primary keys are non-null for new inline proposals;
- one source message cannot create more than one inline proposal under retry or concurrency;
- the known false-candidate structures produce zero proposals and reviewed valid structures remain admitted;
- mismatched, stale, weak, malformed, or unauthorized clears cannot close an incident;
- repeated open evidence does not increment verified reopen counts or create a flap storm;
- real accepted close→reopen transitions still trigger flap detection and escalation;
- legacy events are either safely adapted or quarantined with an explicit reason;
- state, queue, receipt, and remediation ledgers remain bounded and crash-consistent under stress;
- cleanup plan/apply/verify/rollback is deterministic, soft-delete only, and proven on copies;
- documentation, migration rollback, operational rollback, and private execution receipts are complete;
- no skipped, masked, or inconclusive check is represented as passing.

## 16. Explicit Non-Goals

- autonomous relinking, credential rotation, release deployment, or destructive repair;
- content-level deduplication of distinct user messages;
- automatic cancellation based only on proposal age;
- treating silence as recovery;
- replacing the current outbox/dispatcher transport;
- copying private incident messages into repository fixtures;
- resolving a physically offline host through software-only actions.

## 17. Rollback

- Classifier rollout: revert to the prior release only if the prior false-capture risk is explicitly accepted; otherwise disable inline capture while ordinary agent turns continue.
- Schema migration: additive columns/indexes remain readable by the previous version; rollback disables new writes before any schema contraction.
- Dispatcher protocol: retain the previous incident-state file and queue snapshot, stop the new dispatcher, restore the prior version, and replay only events without a committed receipt.
- Cleanup: restore from the verified backup or apply the manifest-driven row rollback when no later edits conflict.
- Live release: use the repository release pointer rollback procedure and verify health, auth-bond presence, outbound proof where required, queues, and incident state.

Rollback success is not incident recovery. The original incident remains open until its clear policy is independently satisfied.
