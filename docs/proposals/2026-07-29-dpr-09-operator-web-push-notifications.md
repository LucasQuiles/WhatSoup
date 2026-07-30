# console: notify operators of pending actions through privacy-safe web push

**Status:** DRAFT feature-request specification for owner review — documentation
only; no build authorization is claimed, and this pull request must not be
treated as queue-ready.
**Grounding:** operator-local sealed evidence run (2026-07-28); repository
claims re-verified at pinned `origin/main` `c9759467d`. Citation legend:
`[mining run (operator-local): …]` points into the sealed mining addendum
retained outside the repository (per-source filenames neutralized to
`source-NN`); `[verified at pinned main c9759467d]` marks path/symbol claims
re-verified at that commit; `[issue survey …: #N]` marks GET-only issue/PR
survey attribution; `[design relay 2026-07-28 (operator-local): …]` marks
attributed design-relay leads, advisory unless independently verified.


| Field | Value |
|---|---|
| DPR ID | DPR-09 |
| OPP mapping | none — QPI expansion (owner directive 2026-07-28, option 1) |
| Tier | n/a — not mining-adjudicated |
| Adjudication verdict | n/a — no mining adjudication; owner directive option 1 |
| Evidence class | QPI relay 2026-07-28 + this-session verification |
| Provenance | QPI parity relay + this-session verification |
| Pinned live-main SHA | c9759467d297787f2e0eb2739bd6cd38ea09145c |
| Status | draft PR — specification only; owner review required before implementation |

## Problem and evidence boundary

The QPI relay identifies web push and a service-worker delivery layer as a peer-derived WhatSoup gap. That relay is dated advisory evidence, so this draft does not rely on its older repository assertions as current fact. [design relay 2026-07-28 (operator-local): oc-re-whatsoup-parity-debt-register.md#pdr-4-web-push-notifications-service-worker-pwa]

Pinned main verifies an installable web manifest, manifest linkage in the console entry point, a notifications settings section, silencing support, realtime publishing, a WebSocket server, configuration loading, and configuration validation. The approved packet therefore treats only push delivery and subscription lifecycle as greenfield; it reuses rather than replaces those existing UI and event surfaces. [verified at pinned main c9759467d]

The user need is an opt-in, off-console notice that a durable pending action or degraded-state record exists. The push is never the authoritative record, never contains message or diagnostic content, and never authorizes an action.

Opening a notification navigates to an authenticated console record. The console must fetch and revalidate that record’s current state, authority, expiry, and evidence before showing any action. A stale, recovered, revoked, or unauthorized record renders as such instead of replaying the notification’s historical claim.

## Systems, schemas, APIs, runtime paths, and docs touched

- `console/public/manifest.webmanifest` and `console/index.html` are verified PWA-shell surfaces. Add a narrowly scoped service worker and explicit registration rather than an unrelated offline application rewrite. [verified at pinned main c9759467d]
- `console/src/components/settings/SettingsSections.tsx` contains the verified `NotificationsSection`; it should own browser capability status, opt-in, quiet hours, test notice, revocation, and key-rotation recovery. [verified at pinned main c9759467d]
- `src/fleet/realtime-publisher.ts`, `src/fleet/realtime-event-poller.ts`, and `src/fleet/websocket-server.ts` are verified event-delivery surfaces. Push should consume the same durable event owner but remain a separate transport with its own outcomes. [verified at pinned main c9759467d]
- `src/fleet/silence-manager.ts` supplies an existing silence surface that push eligibility must consult without changing incident or alert semantics. [verified at pinned main c9759467d]
- `src/fleet/auth-ticket.ts` and authorized fleet routes supply the authentication pattern for subscription create, rotate, test, and revoke operations. [verified at pinned main c9759467d]
- `src/core/database.ts` and `src/core/durability.ts` own subscription, event-attempt, deduplication, terminal-outcome, retention, and restart behavior. [verified at pinned main c9759467d]
- `src/config.ts`, `src/instance-loader.ts`, and `src/core/agent-config-validator.ts` own provider configuration and must reject unknown or incomplete push settings. [verified at pinned main c9759467d]

Add versioned `operator_push_subscriptions` and `operator_push_attempts`, or equivalent stores. A subscription record contains an opaque operator subject, browser subscription endpoint and key material under private encrypted storage, creation/rotation/revocation state, quiet-hours policy, and last-success/failure class. An attempt contains event ID, subscription ID, dedupe key, eligibility decision, expiry, provider outcome, and bounded evidence coverage.

## Proposed data and control flow

1. An authenticated operator explicitly opts in from Notifications settings. The browser obtains permission and creates a standards-based subscription only after the server confirms the operator’s push scope.
2. The server stores the subscription as private credential-like material, associates it with an opaque operator subject, and returns only bounded status. Endpoint and key bytes never enter logs, analytics, alerts, or ordinary console queries.
3. A durable source record transitions into an allowlisted event class such as `pending_action` or `degraded_state`. The push dispatcher reads that event after commit; it never derives notices from raw logs or transient UI cache events.
4. Eligibility applies deny-wins authorization, operator opt-in, subscription state, silences, quiet hours, severity policy, expiry, per-event deduplication, rate limits, and per-operator caps.
5. The payload uses a closed metadata schema: schema version, one-time opaque notification ID, bounded event class, bounded urgency, observed-time bucket, and expiry. It contains no canonical record locator, message preview, identity, host or service label, path, command, diagnostic output, URL parameter, provider prose, or arbitrary text. The server alone maps the one-time notification ID to the canonical opaque record locator.
6. Provider submission records `attempted`, `accepted_by_provider`, `rejected`, `expired_subscription`, `rate_limited`, `failed`, or `outcome_unknown`. Provider acceptance does not prove device display, operator view, console fetch, or action completion.
7. On click, the service worker focuses an existing authenticated client or opens a fixed `/notifications` route with no query or fragment. After a controlled `postMessage` handshake, it passes the one-time notification ID in memory to that client; it writes neither the ID nor a locator to Cache Storage, IndexedDB, local storage, history, or the URL. The authenticated client exchanges the ID once with the server, receives the canonical locator only if still authorized, and fetches/revalidates current state, freshness, expiry, and available actions. The service worker never receives record content and never performs an action.
8. Revocation, endpoint expiry, logout policy, operator removal, and key rotation disable or replace the subscription atomically. Restart recovery retries only eligible, unexpired, undelivered attempts under the same dedupe key.

The service worker may cache only the minimal static shell needed to open the console. It must not cache fleet records, diagnostic output, messages, approval details, credentials, or a notification history.

## Prerequisites and dependencies

The existing manifest, settings, auth, silence, and realtime surfaces are prerequisites, but none is evidence that web push is currently delivered. [verified at pinned main c9759467d]

DPR-08 is a soft dependency only for pending diagnostic approval framing. DPR-09 may notify that a diagnostic request awaits review, but a notification click cannot approve or execute it. If DPR-08 is absent, DPR-09 still supports independently durable degraded-state records.

Issue #2470’s central-telemetry privacy contract is a hard policy prerequisite for payload design: future notification relays must use a closed metadata schema and exclude raw identity, paths, command output, and arbitrary problem text. [issue survey 2026-07-28: #2470]

Issues #2519 and #2521 remain separate prerequisites for honest realtime and delivery language. Push cannot claim the console cache is current, and provider submission cannot be described as end-to-end receipt. [issue survey 2026-07-28: #2519] [issue survey 2026-07-28: #2521]

## Implementation slices and sequencing

1. Define the closed payload registry, privacy tests, notification/event states, eligibility order, dedupe key, provider-outcome taxonomy, subscription retention, and click revalidation contract.
2. Add private subscription storage and authenticated create, inspect-status, rotate, test, and revoke endpoints. Return no endpoint or key material after creation.
3. Add the service worker, explicit registration, capability detection, permission UX, and Notifications settings controls.
4. Add a dispatcher over one synthetic durable event class with quiet hours, silences, expiry, rate limits, deduplication, bounded retry, and terminal attempts.
5. Add the fixed console route, service-worker/client in-memory handshake, single-use server exchange, and canonical-record revalidation before rendering details or actions.
6. Add `pending_action` and `degraded_state` adapters one at a time, each with an owner, recovery/expiry predicate, urgency mapping, and privacy projection.
7. Add aggregate health, key rotation, expired-endpoint cleanup, unsupported-browser fallback, documentation, and exact-byte payload capture tests.

The first implementation PR should prove subscription privacy, one synthetic event, click revalidation, revocation, and rollback before integrating real fleet conditions.

## Security, privacy, authorization, and retention

Issue #2470 establishes the governing privacy failure: rich local telemetry can leak identities, paths, and command output when copied into a central transport. DPR-09 applies its required closed-field registry to every push payload, retry artifact, provider log, and notification-derived event. [issue survey 2026-07-28: #2470]

Push subscription endpoints and cryptographic keys are credential-like. Store them encrypted under private permissions, never return them through list APIs, never include them in diagnostics, and revoke them on operator or subscription invalidation according to owner policy.

Payloads are metadata-only and allowlist-built. Unknown fields or free-form strings fail closed without suppressing the local canonical event. Domain-separated opaque locators may support correlation but must not encode reversible identity.

Authorization is checked at subscription creation, event eligibility, and console-record fetch. A previously authorized push does not bypass current role, line, record, or action authorization.

Quiet hours, silences, and rate limits reduce notification delivery but do not alter the canonical event state. Critical policy exceptions, if any, require explicit owner approval and remain subject to the same payload privacy contract.

Subscription records, attempts, and dedupe keys have finite retention. Device endpoints are removed promptly after revocation or terminal provider expiry. The service worker stores no sensitive application data and clears its minimal cache on incompatible schema or logout policy transitions.

## Migration and backward compatibility

Allocate new schema migrations at implementation time. No existing browser, operator, or realtime connection is silently enrolled; all subscriptions begin with explicit opt-in.

The manifest remains installable for browsers without service-worker or push support. Unsupported or denied browsers receive an in-console fallback and visible capability state, not repeated permission prompts.

Payload and service-worker protocols are versioned. An unknown payload version opens the console shell without rendering embedded data and requires a canonical fetch.

Existing alert, WebSocket, and console-notification behavior remains unchanged until an event class is explicitly registered for push. Rollback does not change the source event’s lifecycle.

## Failure, recovery, and observability

- Browser permission denial or unsupported APIs produce a stable local capability state and no server subscription.
- Subscription persistence failure leaves no active client claim; partial browser subscriptions are revoked or retried explicitly.
- Provider endpoint expiry or terminal rejection revokes the subscription and prompts re-enrollment only inside the authenticated console.
- Transient provider failure retries with bounded backoff, event expiry, and one dedupe key; expired events are never delivered as current.
- Duplicate source events, restart, and dispatcher overlap produce at most one active attempt per event/subscription generation.
- Quiet hours and silences record bounded suppression decisions without one log per poll.
- A click on a recovered, expired, revoked, unauthorized, or missing record shows the current canonical state and offers no stale action.
- Key rotation supports overlap only for a bounded transition and never emits keys or endpoints in status.
- Provider acceptance, service-worker receipt, notification display, click, canonical fetch, and action completion are separate outcomes. Missing later outcomes remain unknown.

Issue #2519 shows that transport reconnection does not prove current console data. Push-click handling must fetch and reconcile the canonical record before claiming it is actionable. [issue survey 2026-07-28: #2519]

Issue #2521 shows that an open socket or local write acceptance is not end-to-end delivery. Push health likewise reports provider outcomes honestly and never equates acceptance with device or operator receipt. [issue survey 2026-07-28: #2521]

## Test matrix and acceptance criteria

- Subscription create, rotate, revoke, logout-policy, operator-removal, endpoint-expiry, and duplicate-enrollment flows are idempotent and restart-safe.
- Unsupported, permission-denied, permission-revoked, and provider-unavailable browsers receive deterministic fallback behavior without prompt loops.
- Exact posted-byte tests prove payloads contain only the closed registry and exclude reserved markers placed in messages, identities, host/service labels, paths, commands, diagnostics, errors, URLs, provider responses, and configuration.
- Unknown payload fields and versions fail closed while preserving the local canonical event.
- Quiet-hour boundaries, time-zone changes, silences, severity policy, event expiry, per-operator caps, and rate-limit boundaries have deterministic clock tests.
- Duplicate events, dispatcher overlap, retry after restart, and key rotation produce one deduped notification attempt per subscription generation.
- Provider acceptance, rejection, timeout, rate limit, terminal endpoint expiry, and ambiguous network outcome map to distinct bounded outcomes.
- Notification click always performs an authenticated canonical fetch. Recovered, expired, unauthorized, deleted, and superseded records expose no stale action.
- A DPR-08 pending diagnostic notice can navigate to review but cannot approve or execute from the service worker or payload.
- Service-worker cache inspection proves no fleet records, messages, approvals, diagnostics, credentials, or notification history are stored.
- Retention removes revoked subscriptions and expired attempts without leaving reusable endpoint material.
- Feature-off and subscription-purge rollback leave the manifest, console, WebSocket, alerts, and source-event state operational.

Acceptance requires real browser/service-worker integration tests, a fake push provider, exact-byte capture, deterministic clocks, restart and dedupe tests, authz revocation tests, and an explicit proof that notification display is not reported as operator action.

## Conflicts and overlap with existing issues and PRs (2026-07-28 survey)

Issue #2470 owns the metadata-only central telemetry boundary and explicitly covers future notification relays. DPR-09 consumes that contract for push; it does not replace local-forensic versus central-telemetry schema work. [issue survey 2026-07-28: #2470]

Issue #2519 owns WebSocket stream generation, gap detection, cache reconciliation, and visible freshness. DPR-09’s click revalidation coordinates with it but does not implement realtime replay or cache correctness. [issue survey 2026-07-28: #2519]

Issue #2521 owns WebSocket client heartbeat, backpressure, async send outcomes, and honest transport health. DPR-09 has a separate provider transport and subscription lifecycle but adopts the same rule that transport acceptance is not application receipt. [issue survey 2026-07-28: #2521]

The QPI relay treated web push and service-worker delivery as an untracked peer-parity item. The pinned packet verifies adjacent PWA, settings, silence, and realtime surfaces, so this draft is greenfield only for subscription and push delivery rather than for the entire console-notification stack. [design relay 2026-07-28 (operator-local): oc-re-whatsoup-parity-debt-register.md#pdr-4-web-push-notifications-service-worker-pwa] [verified at pinned main c9759467d]

DPR-08 owns diagnostic execution approval. DPR-09 may notify and navigate to its canonical request, but it owns no approval state, execution authority, or diagnostic result.

Coordination update (2026-07-29, citation refresh): PR #2644 (central telemetry boundary for selfcheck heartbeat, #2470) is MERGED; the payload-privacy contract this draft inherits from #2470 binds to #2644's landed boundary. [issue survey 2026-07-29: #2644]

## Unresolved decisions, alternatives, and non-goals

Owner review must select the push provider and key-custody model, subscription and attempt retention, initial event classes, urgency mapping, quiet-hours defaults, silence precedence, rate limits, endpoint-expiry policy, and supported browsers.

The recommended first event is a synthetic or low-risk pending-action record because its expiry and click destination are explicit. Degraded-state integration should follow only after each source has a durable identity, observed time, recovery predicate, and metadata-safe projection.

An alternative is email or an existing messaging transport. Those may reduce browser complexity but introduce different address, content, consent, delivery, and credential surfaces. This draft stays transport-specific and does not claim web push is the only valid operator channel.

Non-goals are message previews, diagnostic output, raw error text, identity or topology in payloads, direct approve/deny controls, background service-worker actions, silent enrollment, offline authoritative fleet state, guaranteed device display, guaranteed operator view, or using push delivery as incident recovery proof.

## Rollout, feature flags, and rollback

Use a global provider-configuration gate plus per-operator opt-in and per-event-class enablement. All default to disabled; malformed provider or event configuration fails closed without affecting canonical event processing.

Roll out through a fake provider, owner-only test subscriptions, one synthetic event class, then one real pending-action class. Add degraded-state sources only after privacy, expiry, dedupe, and recovery predicates pass review.

Monitor aggregate subscription state, provider outcomes, retry age, expiry, suppression, dedupe, click-to-fetch success, stale-record navigation, key rotation, and privacy-canary results. Do not collect endpoint, payload, record, operator, or provider-response detail.

Rollback disables dispatch, revokes or purges subscriptions according to owner policy, removes service-worker registration on the next console load, and clears the minimal cache. Source events, silences, WebSocket delivery, console access, and DPR-08 approvals continue independently.

## Current-main reconciliation — 2026-07-29

This amendment supersedes current-system instructions pinned to `c9759467d`.
Current main is `5398982e610bb948d671181a04856590c9f3f9e5`.

**Readiness:** `BLOCKED PRE-CODE`.

### Existing owners and landed precedent

Reuse the current realtime invalidation, authenticated console routes,
silences/quiet hours, startup-notification aggregation/stability debounce, and
durable failure vocabulary. Merged PR #2644 is a privacy and test precedent,
not a browser-push implementation:

- `deploy/scripts/bot-errors-selfcheck.py::central_telemetry_payload`
- `deploy/scripts/bot-errors-selfcheck.py::publish_heartbeat`
- `deploy/scripts/bot-errors-selfcheck.py::publish_central_down_alert`
- `deploy/scripts/tests/test_bot_errors_selfcheck.py`

The new ownership is limited to encrypted subscription lifecycle and push
transport projection.

### Receipt separation

Do not collapse:

`event admitted` → `push accepted by provider` → `displayed by browser` →
`clicked` → `fresh state fetched` → `action separately authorized`.

Provider acceptance is not delivery, display is not state freshness, a click
is not authorization, and an old notification is never action authority.

### Privacy boundary

Payloads are closed-schema, versioned, metadata-only, and independently
redacted. Exclude message content, transcript excerpts, credentials, tokens,
raw errors, filesystem paths, private topology, command text, and sensitive
identifiers. Encrypt subscription endpoints and keys at rest under a named key
owner, with revocation and rotation.

### Owner decisions

- provider, VAPID/key lifecycle, and secret-storage owner;
- eligible event classes and closed payload schema;
- stable event/dedup identity, TTL, retry, and dead-letter behavior;
- silence/quiet-hours/rate-limit precedence;
- unsupported-browser and permission-revoked fallback;
- delivery/display/click evidence and retention;
- authenticated navigation and mandatory fresh fetch.

### First implementation-plan gate

First RED binding:

- File: `tests/fleet/operator-web-push.test.ts`
- Test: `requires a fresh authorized fetch before a notification click can expose an action`
- Command: `npm test -- tests/fleet/operator-web-push.test.ts -t "requires a fresh authorized fetch before a notification click can expose an action" --pool=forks`
- Expected RED reason: push subscription, transport projection, and the
  click-through authorization contract do not exist.

Start with a fake-provider contract and a synthetic metadata-only event. Prove
secret encryption, no raw content, dedup, expiry, retry, revoked subscription,
quiet hours, stale click, unauthorized click, fresh-fetch-before-action,
provider-accepted-but-not-displayed, unsupported browser fallback, and
feature-off rollback.

The PR must remain draft and use non-closing references.
