# security: contain chat secrets through credential-safe onboarding

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
| DPR ID | DPR-01 |
| OPP mapping | OPP-01 |
| Tier | A |
| Adjudication verdict | admit_to_specification |
| Evidence class | Per-source message-level admission across two conversational sources |
| Provenance | Missed-affordance mining admission |
| Pinned live-main SHA | c9759467d297787f2e0eb2739bd6cd38ea09145c |
| Status | draft PR — specification only; owner review required before implementation |

## Problem and evidence boundary

Authentication clarification can become a secret-exposure path when the chat asks for login material without simultaneously warning against secret submission and directing the user to a safe setup route. The admitted opportunity is credential-safe onboarding and containment, supported by two pointer-only conversational episodes; this draft does not reproduce either episode or any submitted value. [mining run (operator-local): evidence/cross-source-opportunity-frontier.json::/admitted_user_facing_opportunities/0] [mining run (operator-local): private/source-08-lead-adjudication.json::/admitted_opportunities/0/private_evidence/0] [mining run (operator-local): private/source-12-lead-adjudication.json::/admitted_opportunities/1/private_evidence/0]

The target outcome is narrow: warn before secret collection, prevent high-confidence secret material from entering ordinary chat persistence, provide a one-time credential-broker path, and issue a privacy-safe containment receipt when supported. It does not authorize credential rotation, deletion, or account changes, and it must not turn benign discussion of authentication methods into destructive remediation. [mining run (operator-local): evidence/cross-source-opportunity-frontier.json::/admitted_user_facing_opportunities/0/acceptance_tests] [mining run (operator-local): evidence/detector-controls.json::/detectors/0]

The mining manifest records `new_pr_candidates: 0`; this is a derived local draft, not a mining-recommended PR, and it has not been posted. [mining run (operator-local): manifest.json::/result/new_pr_candidates]

## Systems, schemas, APIs, runtime paths, and docs touched

The inbound ownership point is `src/core/ingest.ts`, specifically `createIngestHandler` and `persistIncomingMessage`. The existing verified sanitization surfaces are `sanitizeProviderPreviewText` in `src/lib/provider-preview-sanitizer.ts`, `redactHandoffPii` in `src/runtimes/agent/handoff-pii-redactor.ts`, and `adjudicateOutboundContent` in `src/transport/outbound-content-egress.ts`; they provide reusable policy concepts but do not replace a pre-persistence inbound decision. [verified at pinned main c9759467d]

The secure setup path should reuse the credential boundary represented by `src/lib/keyring.ts`, `src/lib/provider-key-service.ts`, `src/lib/credential-state.ts`, and `src/fleet/routes/credentials.ts`. The route remains status-and-broker oriented: chat receives a short-lived reference and terminal state, never a credential read-back. [verified at pinned main c9759467d]

Schema work is limited to privacy-safe event state: a containment event identifier, detection class, policy version, disposition, timestamps, and an optional tombstone or redaction receipt. It must not store the matched substring, a reversible encoding, or a deterministic fingerprint of the submitted value.

Documentation must define the no-secrets-in-chat contract, supported secure setup routes, false-positive recovery, containment limitations by transport, operator audit fields, and the distinction between naming a credential type and using an actual credential.

## Proposed data and control flow

1. Before ordinary inbound persistence, classify the message into `no_auth_context`, `auth_method_discussion`, `credential_setup_intent`, or `high_confidence_secret_material`. Classification uses allowlisted secret forms and contextual confirmation; a blocklist of suspicious words is insufficient.
2. For `no_auth_context` and benign `auth_method_discussion`, preserve the existing ingest path without alarm text or content mutation.
3. For `credential_setup_intent`, attach a no-secrets warning and create a short-lived, access-controlled broker reference. The user completes credential entry outside chat; the conversation receives only pending, accepted, rejected, expired, or revoked status.
4. For `high_confidence_secret_material`, do not echo or copy the matched material into normal message, preview, handoff, tool, or alert storage. Persist a content-free canonical inbound tombstone containing only the transport’s opaque dedupe reference, ordering/sequence reference, receipt timestamp, random containment event identifier, and typed disposition. The tombstone preserves duplicate suppression, restart recovery, turn ordering, and response correlation without storing the submitted content or a reversible fingerprint. Then provide bounded rotation guidance and the approved setup path.
5. If the transport supports redaction or tombstoning, execute it idempotently and attach its receipt to the containment event. If it does not, record `transport_remediation_unavailable` without claiming deletion.
6. All downstream previews, handoffs, and outbound responses consume the containment disposition so a blocked value cannot be reintroduced from an intermediate buffer.

The response contract distinguishes `warning_presented`, `broker_reference_created`, `ordinary_persistence_blocked`, `transport_redaction_requested`, `transport_redaction_confirmed`, and `rotation_advised`; none implies another.

## Prerequisites and dependencies

The implementation depends on an owner-approved secret-class taxonomy, an inventory of secure broker routes by provider, a transport capability matrix for redaction or tombstoning, and a retention decision for privacy-safe containment events. It also requires a threat-model review covering logs, traces, previews, handoffs, errors, analytics, and dead-letter paths.

The mining detector remains a review aid, not an enforcement authority. All seven mining detector families are `enforcement_ready: false`, and the inherited advancement rule is: “No detector advances to enforcement until precision, recall, blind-review agreement, policy coverage, and known failure modes are documented on representative positive, negative, borderline, and false-positive samples.” [mining run (operator-local): evidence/detector-controls.json::/advancement_rule]

This draft has no hard dependency on another packet draft. DPR-02 and DPR-03 should consume its redaction-before-persistence contract when they persist working-set or derived-audio state.

## Implementation slices and sequencing

1. Add typed, deterministic classification fixtures and the privacy-safe containment-event model.
2. Insert the classification decision immediately before ordinary inbound persistence, with structured dispositions and no raw-match logging.
3. Add broker-reference creation and status projection through the existing credential service boundary.
4. Propagate containment state to preview, handoff, outbound, tool-input, and alert sinks.
5. Add transport-specific redaction or tombstone adapters behind explicit capability declarations.
6. Add operator metrics, audit queries, documentation, and a per-instance rollout control.

Each slice must be independently revertible. Broker rollout must not wait for transport deletion support; unsupported deletion remains explicit and never converts a containment event into a false success.

## Security, privacy, authorization, and retention

Secret material must not be written to normal persistence, logs, traces, errors, metrics, handoffs, model previews, or outbound recovery text after classification. Tests assemble synthetic credential-shaped values at runtime and never commit reusable credential literals. Event records use random identifiers and categorical metadata only; deterministic hashes of low-entropy secrets are prohibited.

Credential entry requires a short-lived, single-purpose broker session bound to the authenticated operator, intended account or provider, instance, and expiry. The broker may write through the keyring or provider-key service, but chat cannot read the value back. Authorization to create a broker session is separate from authorization to store or use a credential. [verified at pinned main c9759467d]

Retention defaults to the shortest period needed for audit and false-positive review. Tombstone receipts retain only transport operation identifiers and terminal state. Existing historical messages are out of scope: this draft does not authorize retrospective scanning, deletion, or rotation.

## Migration and backward compatibility

The schema change is additive. Older instances that do not understand containment events continue to ingest ordinary messages, while enabled instances gate only credential-setup and high-confidence secret paths. A schema-versioned content-free tombstone preserves the existing inbound event’s dedupe, sequence, restart, and response-correlation obligations; mixed readers must treat its containment disposition as non-content and must never synthesize an empty ordinary message.

No historical backfill runs by default. Existing keyring, provider-key, credential-state, preview, handoff, and outbound APIs remain callable without signature changes during the first slice; adapters consume the new disposition only after the schema is present. [verified at pinned main c9759467d]

If a transport lacks redaction support, migration records that capability as unavailable rather than synthesizing a deletion receipt. Rollback stops new classifications and broker references but preserves already-issued expiry and revocation semantics.

## Failure, recovery, and observability

Classifier unavailability must not silently reopen credential collection. For an identified credential-setup turn, the system presents the no-secrets warning and broker route, records `classification_degraded`, and avoids requesting or echoing secret material. Ordinary non-authentication conversation remains available.

Broker creation, credential storage, transport redaction, and response delivery have separate terminal states. Retry uses the containment event identifier as an idempotency key; repeated delivery cannot create multiple broker sessions or claim multiple rotations.

Metrics include classification counts by class and policy version, broker outcomes, redaction support and outcomes, degraded decisions, false-positive overrides, and time-to-expiry. Metrics contain no message text, matched spans, credential type values supplied by users, or stable user identifiers.

Alerts fire on repeated classifier degradation, any downstream sink receiving blocked content in fault-injection tests, broker references surviving expiry, or disagreement between a claimed redaction and its transport receipt.

## Test matrix and acceptance criteria

- Positive fixtures cover credential-setup intent and multiple synthetic secret classes; ordinary persistence, previews, handoffs, tool inputs, and logs contain no submitted value.
- Negative fixtures cover authentication documentation, naming a credential type, redacted examples, and ordinary login troubleshooting; they pass without containment or alarmist recovery. This preserves the mining false-positive control. [mining run (operator-local): evidence/detector-controls.json::/detectors/0/false_positive_example]
- Broker tests prove single-purpose scope, authentication and authorization checks, expiry, revocation, idempotency, no read-back, and safe terminal status.
- Transport tests cover confirmed redaction, explicit unsupported state, timeout, duplicate callback, late callback, and a false success response.
- Fault-injection tests fail the classifier, keyring, provider service, database write, response delivery, and transport adapter independently and assert typed residual debt.
- Privacy tests scan captured logs, traces, metrics, errors, previews, handoffs, and persistence for generated sentinels.

Acceptance requires every credential clarification to include the warning and safe route, high-confidence submitted material to avoid ordinary persistence and echo, unsupported redaction to remain explicit, and benign authentication discussion to remain usable. Detector enforcement is excluded until the documented advancement rule is independently satisfied.

## Conflicts and overlap with existing issues and PRs (2026-07-28 survey)

The closest surveyed work is the metadata-only and bounded-retention security cluster: #2164 addresses logging sinks, #2386 addresses alert evidence, #2561 addresses raw tool payloads and failure taxonomy, and #2562 addresses outbound-ledger metadata and retention. DPR-01 owns pre-persistence inbound secret detection, safe credential brokerage, and containment semantics; it should reuse those metadata-only contracts without expanding their scopes. [issue survey 2026-07-28: #2164] [issue survey 2026-07-28: #2386] [issue survey 2026-07-28: #2561] [issue survey 2026-07-28: #2562]

No overlap claim in this section comes from the mining artifacts. The survey is a separate attribution tier, and issue state must be rechecked before any future posting or implementation request.

Coordination update (2026-07-29): the operator catch-up CLI redaction work (#2641 merged, #2648 open) hardens an adjacent operator-output boundary; it does not cover inbound pre-persistence containment. [issue survey 2026-07-29: #2641 #2648]

## Unresolved decisions, alternatives, and non-goals

Owner decisions are required for the high-confidence taxonomy, provider-specific broker UX, transport remediation matrix, containment-event retention, false-positive override authority, and whether a quarantined original may ever be operator-viewable under break-glass controls.

Alternatives are: warning-only onboarding, which does not contain already-submitted material; post-persistence redaction, which leaves copies in intermediate sinks; and a universal lexical blocklist, which has unacceptable false-positive and evasion behavior. The recommended design combines contextual allowlisting, pre-persistence containment, and a secure broker.

Non-goals are credential rotation, credential deletion, account recovery, retrospective message scanning, broad PII detection, arbitrary content moderation, changing outbound default policy, and claiming transport deletion without a receipt.

## Rollout, feature flags, and rollback

Roll out per instance and provider in three stages: synthetic-only validation, shadow classification with categorical metrics and no raw capture, then enforcement for owner-approved high-confidence classes. Credential-setup warnings and broker links can ship before message blocking; transport redaction adapters activate separately.

Promotion requires a reviewed false-positive set, sink-leak fault tests, broker expiry and revocation proof, and operator documentation. Canary dashboards report categorical decisions and residual debt only.

Rollback disables new blocking and broker issuance by policy version while preserving outstanding broker expiry, revocation, and containment-event audit state. It must not restore or replay contained message bodies, delete evidence silently, or claim that previously exposed values were rotated.
