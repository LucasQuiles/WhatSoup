# Incident Control Plane — Design Specification

**Date:** 2026-07-28
**Status:** Sections 1–6 locked interactively with the owner; section 7 assembled from locked migration material.
**Baseline:** `origin/main` @ `6e1672766027c16ecb06f5e122b491c0e5a0a83f`
**Supersedes:** BOT ERRORS WhatsApp-transport-centric delivery (dispatcher/collector file+SSH architecture) as the canonical incident path.
**Related issues:** #1876 (rollout), #2386 (metadata-only), #2387 (irreversible outcomes as events), #2424 (send-before-commit), #2427 (stable event identity), #2463 (mutable JSON incident state), #2468 (heartbeat receiver/receipt), #2469 (fatal terminal observations), #2470 (HTTP sender hardening), #2472 (scheduler config), #2506 (contradictory envelope states).

## Decision summary

The WhatSoup fleet API becomes the durable incident system of record ("Option C": a native incident control plane embedded in the fleet controller). WhatsApp is demoted to one downstream notification adapter. The existing Python dispatcher/collector remain only as a compatibility lane during migration and never share canonical incident ownership.

Operator authority model (ratified): operators may **acknowledge** and **silence**; only verified producer/evaluator signals resolve incidents through the normal path; manual closure exists solely as a separately audited override.

---

## Section 1 — System boundary and ownership (LOCKED)

```
Producer host
  └─ private local spool
       └─ authenticated retry client
            ↓
WhatSoup fleet API (single active controller)
  ├─ signal ingestion
  ├─ incident evaluator
  ├─ dedicated incident SQLite database
  ├─ query and operator-action API
  ├─ realtime invalidations
  └─ notification scheduler
       ├─ WhatsApp adapter
       └─ email adapter
```

- **One active controller writer per fleet**, embedded in the existing fleet API process. No active-active controllers, no distributed consensus in the first release.
- **Storage** is a dedicated private SQLite database owned by the fleet controller — not an instance message database and not the standalone server's in-memory database. SQLite WAL, private filesystem permissions, backups, integrity checks, fail-closed recovery.
- **The critical transaction**: insert immutable event → derive/update incident episode → append lifecycle transition → enqueue notification intents → COMMIT → return durable receipt. Delivery failure never rolls back or reinterprets incident truth.
- **Producers** observe facts and durably spool them; they do not decide whether notifications are sent. Producers continue spooling safely while the controller is unavailable.
- **Degraded operation**: read-only continuation is permitted during incident-store trouble; no lifecycle mutation may proceed from untrusted or reset state.
- `/api/feed` remains a convenience activity view. It may project incident transitions but is never authoritative and no longer reconstructs incident truth from logs or health-poller deltas.
- Existing BOT ERRORS components become migration inputs: file outboxes → temporary producer spools; SSH collector → replaced by authenticated API delivery; dispatcher policy → characterized and migrated into evaluator modules; WhatsApp formatting/sending → adapter; legacy JSON incident state → migration evidence only, never a continuing peer source of truth after cutover.

## Section 2 — Event and incident model (LOCKED, amended)

### Producer identity

Each authorized producer has: stable `producerId`; producer class and allowed signal classes; allowed subject scope; rotatable credential identity; enabled/revoked status. Authorization is checked against the signal's class and subject — not merely possession of the fleet root token.

`producerDomainId` is server-assigned and survives credential rotation or producer replacement. The stable **condition key** is `producerDomainId + subject + conditionClass`; episode identity adds `occurrenceId`.

### Immutable signals

| Signal kind | Meaning | Lifecycle effect |
|---|---|---|
| `condition_observed` | A fault or degraded condition exists | Opens or updates an incident |
| `condition_recovered` | That specific condition occurrence has verified recovery | Resolves the matching incident |
| `heartbeat_observed` | A monitor ran and reported liveness | Refreshes a liveness stream |
| `notice_recorded` | An irreversible or informational event happened | Retained without opening or resolving an incident (#2387) |

Each signal contains: `schemaVersion`; producer-generated stable `signalId`; stable `occurrenceId` for one condition episode; monotonic sequence within that occurrence; bounded condition class; typed subject reference; producer observation time; typed metadata-only attributes; recovery-proof class when applicable. The server adds its own event ID, receipt time, producer identity, and payload digest.

**Byte-stable idempotency (amended):** the spool retains the exact UTF-8 request bytes; the server hashes those bytes. Same `(producerId, signalId)` + same digest returns the original receipt without rerunning incident or notification effects. Same identity + different digest returns a conflict without mutating lifecycle state.

A recovery must reference the same `occurrenceId` and come from an identity authorized to resolve that condition. An ambiguous, stale, or unauthorized recovery remains in the immutable ledger but cannot alter current incident state.

### Incident episodes

Condition state machine and terminal dispositions (amended):

```
open → resolved             verified recovery
open → superseded           newer authoritative occurrence of the same condition key
open → orphaned             producer authority/liveness permanently lost
open → closed_by_override   audited manual closure (Section 5)
```

- Repeated observations update the open episode's last-observed time and may change effective severity. A new occurrence after resolution creates a new episode; episodes never reopen.
- Severity is valid only for an observed condition; recovery signals carry no contradictory severity; informational notices use their own bounded importance field and cannot enter recovery logic (#2506 removed by construction).
- Permanent producer silence transitions an episode to `orphaned`, never `resolved`; the evaluator simultaneously opens/updates a `producer_signal_stale` incident so unknown condition truth never appears healthy.

### Operator state and transition history

- Acknowledging does not resolve the condition. Silencing suppresses selected delivery adapters until expiration. Verified recovery resolves regardless of acknowledgement. Manual closure is a separate audited override transition with actor, reason class, and timestamp.
- All lifecycle changes produce append-only transition records. The current incident row is a transactional projection for efficient queries, not the only historical record (#2463).

### Notification intents and attempts

An incident transition may create one or more durable notification intents, committed in the same transaction as the transition. Delivery happens afterward and cannot determine whether the incident exists (#2424). Ambiguous post-send outcomes become `outcome_unknown` review items (amended): durable review entries; any retry is a **new** intent referencing the immutable ambiguous attempt. Full attempt lifecycle: Section 6.

### Ordering, offline replay, clock policy

- Producer spools retain `signalId`, `occurrenceId`, and sequence values across retries. The controller stores late signals but only lets causally newer signals advance current state.
- Heartbeat freshness derives from the producer's observation time subject to clock-skew policy — never API receipt time.
- **Future-skew bound (amended):** well-formed observations dated beyond the permitted skew are quarantined (`stored_quarantined_observation`), cannot affect asserted condition or heartbeat freshness, and may open a controller-derived clock-skew incident.

### Privacy boundary

Ingestion accepts bounded enums, counts, durations, safe labels, and content-free correlation digests — never free-form summary, evidence, exception text, command output, paths, arguments, message identifiers, or logs (#2386; allowlist, never blocklist). Detailed forensic evidence remains in a private local artifact with explicit retention; the central event may contain only a typed opaque reference to it.

## Section 3 — Ingestion transport contract (LOCKED, amended)

### Endpoint

`POST /api/signals` — `application/json`, `Authorization: Bearer <producer credential>`. One signal per request (batching deferred). Compressed bodies rejected so the digest has one unambiguous byte representation. Body limit 32 KiB. Dedicated producer-authentication gate: fleet root tokens, console sessions, API tickets, and WhatsApp identity do not authorize signal production.

### Producer enrollment and credentials

An administrator registers a producer with: stable `producerId`, stable `producerDomainId`, allowed signal kinds, allowed condition classes, allowed subject scope, credential lifetime and rotation policy. Registration creates a **single-use, hashed, short-lived, security-audited** enrollment secret (default expiry 10 minutes, hard maximum 30). The host exchanges it over an approved transport for a producer credential shown once in plaintext; the controller stores only its hash.

Credentials are: scoped to one producer; rotatable with a bounded overlap window; individually revocable; stored in a private host file; never inherited from a global shell environment; accepted only over loopback, an authenticated tailnet path, or TLS. Credential replacement does not change the producer domain.

### Durable receipt

`201` on new acceptance:

```json
{
  "schemaVersion": 1,
  "receiptId": "…", "eventId": "…",
  "producerId": "…", "signalId": "…",
  "payloadDigest": "sha256:…", "receivedAt": "…",
  "disposition": "incident_opened",
  "incidentId": "…", "transitionId": "…"
}
```

Dispositions: `incident_opened`, `incident_updated`, `incident_resolved`, `heartbeat_recorded`, `notice_recorded`, `stored_no_state_change`, `stored_stale_observation`, `stored_quarantined_observation`, `stored_evaluation_faulted`.

Exact replay returns `200` with the originally stored receipt body and `Idempotent-Replay: true`; the evaluator and scheduler are not rerun. A response lost after commit is safe: resend identical bytes, obtain the original receipt.

### Error contract

Bounded machine-readable shape: `{ "error": { "code", "retryable", "message" } }`. Server errors never include raw payload content, credentials, paths, or internal exception prose.

| HTTP | Class | Producer action |
|---|---|---|
| 400 | malformed request | Quarantine locally |
| 401 | credential invalid/expired | Retain spool; stop ordinary retries pending credentials |
| 403 | producer scope denied | Quarantine; surface configuration failure |
| 409 | same identity, different digest | Quarantine as identity conflict |
| 413 | body too large | Quarantine locally |
| 415 | unsupported media type/encoding | Quarantine locally |
| 422 | invalid signal/lifecycle/**malformed** timestamp | Quarantine locally |
| 429 | rate limited | Retry after supplied delay |
| 503 | controller/store unavailable or recovery required | Retry with backoff |
| 507 | durable storage unavailable | Retry with backoff; raise local critical health |

Amendments locked into the taxonomy:

- Malformed timestamps → 422; **well-formed out-of-skew timestamps → 201 `stored_quarantined_observation`** (state-inert; may open clock-skew incident).
- **Unknown 4xx** → permanent contract failure (quarantine, surface locally). **Unknown 5xx / transport failure** → retryable with bounded backoff, counts toward local degradation.
- **3xx is never followed**: it blocks transport and surfaces a local configuration fault without retiring the spool entry.
- Unknown condition classes → distinct `condition_class_unknown` code surfaced as a configuration fault (Section 4).

### Client transport policy (amended)

Non-loopback clients require TLS, pinned expected-controller hostname verification, no redirects, bounded response reads, and bounded parsed receipt persistence (#2470).

### Spool retirement

The host stores fully serialized request bytes before attempting delivery. It retires an entry only after a 201 receipt, or a 200 exact-replay receipt whose digest matches the spooled bytes. Retirement atomically moves entry + receipt into a bounded relayed archive or tombstone set; it never simply deletes the only identity record. Retryable/ambiguous outcomes resend the same bytes with the same identity — timestamps, IDs, and serialization are never regenerated. Permanent contract failures move to a private quarantine with a bounded metadata-only reason.

### Host-side controller-down detection

Each producer client persists: time of last durable receipt; oldest unreceipted spool age; consecutive transport failures; current authentication status; queue depth and quarantine count. Controller-path health derives from **durable receipts, not TCP reachability**. Periodic `heartbeat_observed` signals exercise authentication, validation, storage, and receipt return end to end. Local degraded/down thresholds are exposed through local health files/endpoints and service logs even while the controller is unreachable.

The controller's own availability has an **external deadman check**; the break-glass alert path is separate from ordinary incident delivery and cannot become a second source of incident truth. On reconnection, queued signals replay in causal order using original observation times.

## Section 4 — Central evaluator (LOCKED, amended)

### Deterministic evaluation model

Single-writer state machine inside the incident database transaction:

```
validate signal → append immutable event → load current projection
→ evaluate typed policy → append transitions → update projections
→ create notification intents → commit receipt
```

Every evaluator decision records: causal event/timer ID; previous and resulting state; bounded reason code; policy version + content digest; evaluator version; evaluation time supplied as explicit input; safe counters/deadlines; created intent IDs. Rules never call the wall clock; scheduled runs receive one persisted `evaluationTime`, process inputs in stable order, and emit an evaluation receipt (cursor bounds, counts, policy digest, outcome). Replaying the same event, timer, policy version, and prior state produces no additional transitions.

### Poison-signal isolation (amended)

A durable retry guard — persisted **outside** the rolled-back lifecycle transaction — is keyed by `producerId + signalId + payloadDigest + policyVersion + evaluatorVersion`. After **three** identical deterministic failures, a built-in controller policy: accepts the event as `stored_evaluation_faulted`; parks it without changing the affected condition; opens/updates an evaluator-fault incident scoped to the policy and condition class; disables that condition class fail-closed; continues accepting unaffected classes; replays parked events in causal order after a corrected policy activates. **Only storage, database-integrity, or core-controller failures degrade global ingestion.**

### Policy registry

One typed policy per condition class: owning producer domain; permitted subjects and signal variants; severity mapping; correlation and occurrence rules; recovery authority and proof requirements; expected observation cadence; grace/stale/supersession/orphaning thresholds; parent/root-cause relationships; notification policy and renotification schedule; maintenance behavior; retention class.

Unknown condition classes fail closed at ingestion with `condition_class_unknown`; **policy registration must precede producer rollout**. Policy changes are versioned and never rewrite historical decisions; reconciliation under a new policy produces explicit `policy_reconciled` transitions.

### Absence-derived incidents

Absence is evaluated from the most recent accepted, in-skew observation — not file mtimes, process uptime, or latest received payload. Per registered heartbeat stream the controller stores: expected cadence; grace period; last qualifying observation; next evaluation deadline; current stream generation; responsible producer/domain; required corroboration policy. A missed deadline creates a controller-derived occurrence with deterministic identity (stream generation + missed deadline). **Covered stale timers are audited no-ops with zero transitions and intents** (amended — no phantom flaps after controller restarts).

Derived condition classes: `heartbeat_missing`; `producer_signal_stale`; `producer_clock_skew`; `controller_ingest_unavailable` (detected externally only). A returning fresh heartbeat may resolve `heartbeat_missing` only. Orphaning: unresolved episodes → `orphaned` (never resolved); `producer_signal_stale` remains open; replacement authority explicitly adopts the condition key and begins a new occurrence; history stays immutable.

### Self-attestation and independent SSH probing

| Heartbeat | Independent probe | Evaluator conclusion |
|---|---|---|
| Fresh | Reachable | Reporting path and external reachability currently proven |
| Missing | Reachable | Host exists; reporting scheduler/credential/spool client/ingestion path faulty |
| Missing | Unreachable | Host/reachability incident primary; missing-heartbeat linked symptom |
| Fresh | Unreachable | Do NOT declare host down; open independent-probe visibility incident |
| Missing | Probe unavailable | Monitoring inconclusive; never classify healthy |
| Future-skewed | Any | Quarantine the lifecycle claim; evaluate clock skew independently |

The SSH probe emits typed metadata-only observations through a controller-owned producer identity — never raw command output, paths, usernames, or topology. A failed probe cannot resolve or supersede self-reported conditions; a successful probe resolves only conditions whose policy explicitly names external reachability as sufficient proof.

### Correlation, inhibition, storms, timers

Root-cause correlation changes notification behavior, not historical truth: symptoms remain recorded and open; they may link to a parent; their intents may be inhibited while the parent is open; clearing the parent does not clear symptoms without their required proof; storm aggregation creates an aggregate episode retaining every member. Maintenance windows and silences suppress/defer delivery intents only.

Renotification, stale evaluation, silence expiry, and orphaning use durable scheduled jobs with stable identity and deadline; claim and apply are transactional, so restart cannot reset intervals or duplicate transitions. A timer may create a new intent; it never resends or mutates an earlier attempt.

### Failure behavior

Rule failure rolls back the transaction (bounded by the retry guard above). Scheduled-cycle failure emits a failed evaluation receipt, cursor unchanged. State corruption enters `state_recovery_required`; the controller **never initializes an empty incident state** over a corrupt one. No closure, supersession, orphaning, or suppression reset occurs during unresolved recovery mode.

### Migration of dispatcher rules (amended)

1. Preserve rules expressing required lifecycle/recovery semantics.
2. Convert delivery-only suppression into notification policy.
3. Replace content heuristics with typed signal fields.
4. Reject rules inferring recovery from silence or notification success.
5. Run the new evaluator in shadow mode against synthetic and replay-safe fixtures.
6. Compare transitions, incidents, and notification intents — not formatted WhatsApp text.
7. Cut over one condition class at a time.

Shadow comparison supports **narrowly classified, issue-linked divergence waivers** where legacy behavior is a known defect; **unclassified divergence blocks cutover**.

## Section 5 — Operator and read surfaces (LOCKED, amended)

### Read API

```
GET /api/incidents                                   (filters below)
GET /api/incidents/:incidentId
GET /api/incidents/:incidentId/transitions
GET /api/incidents/:incidentId/notification-intents
GET /api/signals/:eventId
GET /api/delivery-reviews
```

`GET /api/incidents` filters: **exact `subjectId` (amended)**; episode state; severity; condition class; producer domain; subject class; acknowledgement state; silence state; updated-after cursor. Pagination uses opaque stable cursors and bounded page size; every response includes the authoritative projection version and event/transition cursor. Incident detail keeps separate fields for condition state/terminal disposition, severity, acknowledgement, active silences, parent/symptom relations, last qualifying observation, policy version, and delivery summary. Delivery responses expose adapter class, intent state, attempt count, safe timestamps — never destination identifiers or rendered bodies.

### Identity and authorization

- Producer credentials cannot read incidents or perform operator actions.
- Named principals with stable actor IDs for **both human and automated operators** (amended) — individually scoped, rotated, revoked; agents never borrow a human credential.
- Principal provisioning mirrors producer enrollment: admin registers principal; credential shown once, stored hashed; individual rotation/revocation.
- Roles: `incident_viewer` (read); `incident_operator` (acknowledge, silence, end silence, disposition delivery reviews); `incident_admin` (operator + audited manual closure + policy administration).
- **The root token may provision or recover principals but cannot mutate incidents** (amended); break-glass = mint an audited emergency principal, then act as it.
- Console sessions carry actor ID, roles, expiry, authentication method; same-origin + CSRF for browser mutations; API clients get separately scoped short-lived tickets.
- All mutations require an idempotency key, `If-Match` expected projection version, and a registered bounded reason code where applicable. Stale version → 409 `incident_version_conflict`; refetch before deciding again.
- Step-up = fresh reauthentication or a short-lived confirmation bound to incident ID + version + action + actor (amended).

### Actions

- **Acknowledge** (`POST /api/incidents/:id/acknowledgements`): "seen and responsibility accepted"; append-only; no condition/deadline/recovery effect; withdrawal/transfer are new transitions.
- **Silence** (`POST /api/incidents/:id/silences`, `DELETE /api/silences/:silenceId`): adapter classes or all ordinary adapters; expiry within policy bounds; bounded reason; early end appends `silence_ended`; expiry via durable timer; affects future intents only. First release: incident-scoped silences only; broader maintenance rules are explicit policy objects. **Controller-deadman delivery is outside silenceable scope.**
- **Audited manual closure** (`POST /api/incidents/:id/manual-closures`): console label "Close without recovery proof"; requires `incident_admin`, step-up, current version, bounded reason class, optional opaque external reference, explicit no-recovery-proof acknowledgement. Terminal disposition `closed_by_override`, distinct from resolved/superseded/orphaned. Later genuine recovery is recorded but does not rewrite the override.
- **Delivery review queue** (`GET /api/delivery-reviews`, `POST /api/delivery-reviews/:id/dispositions`): every `outcome_unknown` attempt opens a review item. Dispositions: `confirmed_delivered`, `confirmed_not_delivered`, `retry_authorized_despite_unknown`, `notification_abandoned`. **Dispositions record facts and never send** (amended); later delivery comes only from `retry_authorized_despite_unknown` (new intent with `supersedesIntentId` + `causedByAttemptId`) or ordinary renotification policy. Review counts appear in controller health and console.

### Audit

Every accepted operator action records: actor + role; authentication method; action + reason class; target ID; before/after projection versions; idempotency identity; timestamp + request correlation ID. Rejected privileged actions produce bounded security-audit records. Audit records cannot be edited or deleted through the API. No free-form comments, raw evidence, destination identifiers, or private topology; external references are bounded opaque identifiers.

### Realtime and console

WebSocket invalidation events: `incident_changed`, `delivery_review_changed`, `incident_policy_changed` — containing only object IDs, projection versions, and global transition cursors. Clients refetch authoritative data through the read API; every event carries a monotonic cursor; gaps/reconnects → fetch transitions after last cursor. WebSocket delivery is an optimization, never the source of truth. Console reads the same projections and presents condition, acknowledgement, silence, and delivery status separately.

## Section 6 — Delivery execution (LOCKED, amended)

### Worker model

Delivery workers are modules inside the controller process (single-writer boundary preserved). Each adapter: bounded concurrency; independent rate limits; durable retry policy; health projection; destination profiles stored outside incident content; typed failure classifier. Workers claim due intents transactionally in stable deadline+ID order; delivery I/O occurs outside the database transaction.

### Attempt lifecycle

```
prepared → dispatching → transport_accepted → delivery_confirmed
dispatching → proven_retryable_failure | proven_permanent_failure | outcome_unknown
transport_accepted → delivery_disproven        (amended: independent negative receipt,
                                                e.g. async bounce/NDR → review item)
```

`transport_accepted` proves transport acceptance, not human delivery; only an independent receipt advances to `delivery_confirmed`. The worker transactionally moves `prepared → dispatching` immediately before external I/O, so an expired `prepared` lease is safely reclaimed and an expired `dispatching` lease becomes `outcome_unknown` — never blindly retried. WhatsApp provides no sufficient transport idempotency contract, so its ambiguous outcomes enter review.

### Relevance fencing

Every intent is bound to incident ID + occurrence, causing transition, incident projection version, and purpose (`onset`, `escalation`, `reminder`, `recovery`, `controller_diagnostic`). Workers recheck authoritative state before dispatch: onset cancelled if the occurrence resolved/superseded/orphaned; reminder cancelled if not open; silenced ordinary intents deferred/suppressed per policy; recovery suppressed when its onset never surfaced unless policy requires an audit notification. Per incident and adapter, intents execute in transition order; recovery cannot overtake onset.

### Retry, dead-letter, adapter health

Proven retryable failures: exponential backoff, full jitter, capped interval; each retry is a new immutable attempt; bounded by attempt count **and** elapsed age. Exhaustion → terminal `dead_letter` intent state + delivery-review item + controller-derived delivery-failure incident + no condition change. Proven permanent failures dead-letter immediately. Replacement intents only via audited review disposition.

Adapter health conditions: `delivery_adapter_degraded`, `delivery_adapter_misconfigured`, `delivery_outcome_review_required`. Probes/deliveries resolve only what their policies authorize. **The non-self-destination rule — an adapter cannot be the only destination for its own failure incident — is validated fail-closed at policy activation** (amended). The external controller-deadman remains a separate break-glass path outside this worker system.

### WhatsApp adapter

Receives a typed notification snapshot, template version, adapter-local destination profile ID, stable attempt ID, timeout and size limits. The destination profile holds the configured BOT ERRORS group identity — validated at startup, never copied into signals, incidents, transitions, logs, or receipts. Uses the existing WhatSoup socket/send path during migration. Stores only: safe attempt outcome; acceptance timestamp; bounded provider outcome class; content-free provider-receipt digest. The Python dispatcher remains a compatibility lane until each condition policy/adapter path cuts over.

### Email adapter

Independent first-class adapter (not an exception handler inside WhatsApp retries). Policy may create an email intent: immediately for selected critical conditions; after WhatsApp adapter degradation; after an escalation deadline; through an audited operator retry. Own destination profile, attempts, retry budget, receipts. Provider acceptance = `transport_accepted`, never labeled delivered without stronger confirmation.

### Silence behavior

Silences apply at intent creation and again at claim. A silenced onset records `suppressed_by_silence`. Silence expiry evaluates current state and may create one fresh reminder intent — it never releases a backlog of stale onsets. Already-dispatching attempts are not retroactively cancelled.

### Rendering privacy boundary

Adapters receive a purpose-built `NotificationView` of allowlisted values only: incident reference; static condition title from registered policy; condition state; severity; registered bounded subject display label; producer-domain display class; opened/transition time; occurrence or suppression count where policy permits; static requested action from policy; opaque console deep link; notification purpose.

Forbidden: free-form evidence/summaries; exception text or provider output; commands, arguments, paths, log excerpts; message/chat/phone/account/destination identities; credentials or environment values; arbitrary signal attributes; operator authentication details; private topology; free-form manual-closure text.

Templates are static, versioned, condition-specific; only named typed fields interpolate. The controller stores the typed snapshot + template version, not rendered bodies; retries deterministically re-render the same bytes. After rendering: defensive content scanner; length/line limits; digest stored for retry/audit comparison; rendered text exists only for the bounded adapter call; logs reference attempt ID, adapter class, outcome class, digest only. Renderer rejection = permanent delivery failure + controller rendering-policy incident; never partially sanitized fallback.

**Amended:** subject display labels and the console deep-link base URL — the only two configuration-derived fields that can carry topology-shaped content — are validated against the forbidden content classes at registration time by the same policy-activation gate, keeping the post-render scanner a canary whose every rejection indicates a real upstream defect.

### Verification requirements

Adapter tests must cover: crash before dispatch; crash after possible acceptance; lost response; proven rejection; retry exhaustion; resolution before dispatch; silence before and during claim; onset/recovery ordering; adapter outage and alternate-adapter escalation; reserved synthetic privacy canaries in every forbidden field; mutation tests that fail if raw signal or destination data reaches a renderer.

## Section 7 — Migration and rollout (assembled from locked material)

Implementation lands as a plan series, each producing working, tested software:

1. **Incident store core** — dedicated SQLite database, events/incidents/transitions planes, byte-stable idempotent acceptance, core lifecycle. (Plan: `2026-07-28-incident-store-core.md`)
2. **Ingestion surface** — producer registry/enrollment, credential gate, `POST /api/signals`, error taxonomy, receipts.
3. **Evaluator** — policy registry, retry guard/parking, absence timers, derived conditions, SSH-probe corroboration.
4. **Operator and read surface** — principals/roles, read API, ack/silence/manual closure, delivery reviews, audit, realtime invalidations.
5. **Delivery execution** — intents/attempts/workers, WhatsApp + email adapters, rendering boundary.
6. **Producer client + spool** — host-side sender, spool retirement, controller-down detection, deployment via existing self-check tooling (#2472 scheduler fix).
7. **Shadow mode and cutover** — dispatcher-rule classification, divergence-waiver register, per-condition-class cutover, collector/outbox decommission.

Constraints carried from locked sections: the Python dispatcher remains a compatibility lane without canonical ownership until each class cuts over; the SSH collector is replaced by authenticated API delivery; acceptance at each cutover is a **real-data check against live fleet signals**, not a green synthetic suite; live rollout tracks #1876 and coordinates #2468/#2469/#2470/#2472.

Open items (owner decisions, not blockers for plans 1–5): per-host producer rollout order; incident-database backup cadence and off-box location.
