# media: preserve consent-aware voice-note continuity across restart and search

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
| DPR ID | DPR-03 |
| OPP mapping | OPP-03 |
| Tier | B |
| Adjudication verdict | conditional_specification_after_policy_check |
| Evidence class | One outlier-source aggregate with two cross-source controls; conditional owner and policy attribution |
| Provenance | Missed-affordance mining admission |
| Pinned live-main SHA | c9759467d297787f2e0eb2739bd6cd38ea09145c |
| Status | draft PR — specification only; owner review required before implementation |

## Problem and evidence boundary

Immediate voice-note service and durable continuity are different outcomes. The admitted evidence records 0/66 audio rows with durable text in one source group, compared with 70/70 and 332/335 in two controls, while successful in-session use shows that null durable text does not mean the audio was ignored. [mining run (operator-local): private/source-11-lead-adjudication.json::/admitted_opportunities/0/private_evidence] [mining run (operator-local): evidence/worker-adjudication.json::/adjudications/4/rejected_or_narrowed]

This is a conditional specification, not a universal-defect claim. The observed asymmetry may result from native-model audio, an alternate durable store outside the reviewed surface, or an intentional consent and retention policy. The policy and ownership decision must be resolved before durable-text acceptance can pass. [mining run (operator-local): evidence/cross-source-opportunity-frontier.json::/admitted_user_facing_opportunities/2] [mining run (operator-local): private/source-11-lead-adjudication.json::/admitted_opportunities/0/falsifiers]

The desired outcome is policy-aware continuity: when approved, derived text or a privacy-preserving summary survives restart, participates in the approved search representation, carries provenance and retention state, and is deleted consistently with the source media. When policy prohibits persistence, the system records that decision without storing derived content.

The mining manifest records `new_pr_candidates: 0`; this is a derived local draft, not a mining-recommended PR, and it has not been posted. [mining run (operator-local): manifest.json::/result/new_pr_candidates]

## Systems, schemas, APIs, runtime paths, and docs touched

The verified execution surfaces are `transcribe_audio` in `src/mcp/tools/media.ts`, `CONVERSATION_SAFE_GLOBAL_TOOLS` in `src/mcp/registry.ts`, `src/runtimes/agent/media-prep.ts`, and the provider chain owned by `transcribeAudioWithProviders` with OpenAI Whisper, faster-whisper, whisper.cpp, and local-audio adapters. [verified at pinned main c9759467d]

Durable state is owned by `src/core/messages.ts` through `updateTranscription` and by the `content_text` and full-text-search schema in `src/core/database.ts`. The implementation must verify transaction and trigger behavior at the pinned revision rather than relying on stale line references. [verified at pinned main c9759467d]

The proposal may require an additive transcription-receipt record for provider, model or engine, creation time, confidence or uncertainty, language when available, policy decision, retention class, deletion state, and the originating media identifier. The derived text remains in the approved searchable representation only when policy permits.

Documentation must cover source-policy configuration, consent basis, immediate-versus-durable semantics, provider selection, uncertainty, search behavior, deletion, retention expiry, and operator diagnosis.

## Proposed data and control flow

1. On inbound audio, resolve the source policy before creating durable derived content. The decision is `persist_transcript`, `persist_redacted_summary`, `ephemeral_only`, or `reject_processing`, with a versioned reason.
2. Prepare the media and select either native-model audio or the local transcription-provider chain according to the owner-approved routing contract.
3. Produce an immediate-use result with provider and uncertainty state. Immediate success is recorded separately from durable persistence.
4. If policy permits persistence, write derived text through `updateTranscription`, attach the transcription receipt, and update the approved FTS representation in one recoverable operation. [verified at pinned main c9759467d]
5. If policy permits only a redacted summary, store that representation with explicit provenance; do not retain the full transcript as an intermediate artifact.
6. If policy is ephemeral, keep `content_text` and FTS empty and persist only the categorical policy decision and processing terminal state.
7. On restart, search, or handoff, expose only policy-approved derived state and its freshness. On deletion or retention expiry, remove the derived text, FTS entry, cached intermediate, and receipt content while retaining only the minimum deletion proof.

Delivery states are typed independently: media accepted, runtime transcription attempted, immediate result used, derived state persisted, FTS indexed, restart retrieval verified, and deletion completed.

## Prerequisites and dependencies

The blocking prerequisite is an owner ruling for each source class: whether native-model audio, the local provider chain, or both are authoritative; whether transcript, redacted summary, or no derived content may persist; the consent basis; retention period; search eligibility; deletion behavior; and acceptable uncertainty.

DPR-01’s redaction-before-persistence contract is a soft dependency because spoken secrets must not become durable text merely because transcription is enabled. DPR-05 is a soft dependency for choosing between native audio and registered transcription routes.

The mining detector remains a review aid, not an enforcement authority. All seven mining detector families are `enforcement_ready: false`, and the inherited advancement rule is: “No detector advances to enforcement until precision, recall, blind-review agreement, policy coverage, and known failure modes are documented on representative positive, negative, borderline, and false-positive samples.” [mining run (operator-local): evidence/detector-controls.json::/advancement_rule]

## Implementation slices and sequencing

1. Define and approve the source-policy matrix and authoritative processing owner.
2. Add typed policy decisions and transcription receipt schema without changing persistence.
3. Normalize native-model and provider-chain outcomes into one immediate-use result contract.
4. Implement atomic approved persistence through `updateTranscription` plus FTS verification.
5. Add redacted-summary and ephemeral-only branches with no full-transcript residue.
6. Implement retention expiry, deletion cascade, and cache cleanup.
7. Add restart, search, handoff, uncertainty, parity, and privacy tests.
8. Add per-source canary controls, observability, and operator documentation.

No persistence slice advances until the policy gate is approved. The schema and tests may land first, but `persist_transcript` remains disabled by default for unresolved source classes.

## Security, privacy, authorization, and retention

Audio-derived text may be more searchable and more revealing than the original media. Persistence requires explicit source-policy authorization, least-retention defaults, encryption and access controls equivalent to the message store, and strict separation between immediate processing permission and durable indexing permission.

The receipt records categorical provenance and uncertainty without copying audio or transcript text into logs, metrics, errors, or audit projections. Temporary files are bounded, access-restricted, and deleted after terminal processing. Provider requests must follow the approved data-residency and retention policy.

Deletion is end-to-end: message-derived text, FTS representation, temporary media, provider cache where controllable, handoff projection, and any redacted summary are removed or tombstoned consistently. A deletion request cannot report success from the message row alone.

If DPR-01 detects secret material in derived text, the transcript follows the same containment decision before ordinary persistence; a transcription receipt may record `contained` without retaining the matched material.

## Migration and backward compatibility

The migration is additive and policy-default-deny. Existing rows with durable `content_text` remain readable under their current policy, but the new receipt fields begin as `legacy_provenance_unknown` until independently established.

Historical audio is not transcribed or indexed by default. Any backfill requires separate owner authorization, an explicit source and date scope, consent and retention checks, bounded rate and cost, resumable receipts, deletion support, and a dry-run count.

Mixed-version instances treat unknown policy states as non-persistable. Existing immediate transcription continues when authorized; inability to write a receipt must not be misreported as durable continuity.

FTS migration must rebuild or repair only policy-approved derived rows and verify that denied or deleted rows have no searchable residue.

## Failure, recovery, and observability

Failure states include unsupported media, preparation failure, provider unavailability, low-confidence output, native/local route disagreement, persistence failure after immediate success, FTS update failure, policy lookup failure, retention cleanup failure, and deletion disagreement.

Provider fallback is allowed only within the approved policy and data boundary. A fallback with different data residency, retention, or authorization is not equivalent and requires a new policy decision.

If immediate use succeeds but persistence or indexing fails, the turn may complete while durable continuity remains `failed_pending_repair`. Recovery retries the exact derived-state operation idempotently or records owned terminal non-persistence; it never recodes immediate success as durable success.

Metrics report counts and latency by policy decision, provider class, immediate outcome, persistence outcome, FTS verification, restart retrieval, expiry, and deletion. They contain no audio, transcript, summary, message content, or stable user identifier.

## Test matrix and acceptance criteria

- For `persist_transcript`, process a voice note, restart the agent, retrieve the approved search representation, and verify provenance, uncertainty, retention, and deletion behavior.
- For `persist_redacted_summary`, verify the summary is searchable while the full transcript never appears in persistence, FTS, logs, caches, or handoff state.
- For `ephemeral_only`, verify immediate task completion with null durable text and no FTS row; this is policy compliance, not failure.
- Exercise every provider and native-audio route, including unavailable, timeout, low-confidence, and materially non-equivalent fallback.
- Fail persistence after immediate success and fail FTS after persistence; each state remains distinct and recoverable without duplicate text.
- Delete and expire derived state, then verify message, FTS, cache, handoff, and receipt projections.
- Include the false-positive control: immediate transcription success must not be mislabeled as durable transcription persistence. [mining run (operator-local): evidence/detector-controls.json::/detectors/6/false_positive_example]

Acceptance is gated by the policy decision. Only an approved `persist_transcript` or `persist_redacted_summary` source can pass durable restart-and-search criteria. Unresolved sources remain disabled; opt-out sources pass by proving absence of durable content and visible policy compliance. No detector enforcement or universal platform-defect claim is authorized.

## Conflicts and overlap with existing issues and PRs (2026-07-28 survey)

#2257, #2300, #2304, #2321, and #2325 concern transcription-tool portability, path assumptions, test fragility, or temporary-file handling. They are implementation adjacencies, not owners of consent-aware durable continuity; this draft should reuse their fixes and avoid widening them into a persistence feature. [issue survey 2026-07-28: #2257] [issue survey 2026-07-28: #2300] [issue survey 2026-07-28: #2304] [issue survey 2026-07-28: #2321] [issue survey 2026-07-28: #2325]

#2561 is adjacent where transcription tool inputs, outputs, and failures enter the durable tool-call plane. DPR-03 must use metadata-only receipts and the bounded failure taxonomy rather than persisting raw media or transcript payloads in tool records. [issue survey 2026-07-28: #2561]

No overlap claim in this section comes from the mining artifacts. Issue state and final scope require re-verification before any future posting or implementation request.

## Unresolved decisions, alternatives, and non-goals

The policy gate must decide: authoritative native or local owner; transcript versus redacted summary; consent acquisition and revocation; retention by source; searchable fields; confidence threshold; language support; provider residency; deletion guarantees; backfill policy; and whether FTS may expose derived text to broader readers than the media.

Alternatives are native-model audio with ephemeral context only, local transcription with durable text, a privacy-preserving derived summary, or explicit no-persistence. The correct choice may differ by source; this draft does not assume cross-source parity is always desirable.

Non-goals are retaining all audio transcripts, treating null `content_text` as ignored media, forcing one transcription provider, historical backfill without authorization, quality scoring from persistence alone, relaxing media-access controls, and claiming that the 0/66 observation proves a universal defect.

## Rollout, feature flags, and rollback

Roll out by source-policy class: receipt-only dark launch, persistence canary for explicitly approved sources, restart-and-search verification, then bounded expansion. Native and provider-chain routes have separate controls so ownership can be changed without enabling persistence broadly.

Canary promotion requires policy approval, privacy review, zero denied-source persistence, restart/search success, deletion proof, FTS consistency, provider-fallback compliance, and reviewed false-positive controls.

Rollback disables new durable writes and indexing for the affected source class while preserving immediate processing if separately authorized. Existing derived content remains governed by its recorded retention and deletion policy; rollback does not silently retain, delete, or relabel it.

## Current-main reconciliation — 2026-07-29

This amendment supersedes current-system instructions pinned to `c9759467d`.
Current main is `5398982e610bb948d671181a04856590c9f3f9e5`.

**Readiness:** `BLOCKED PRE-CODE`; conditional on policy and storage-owner
decisions.

### Retained current owners

- `src/mcp/tools/media.ts::transcribe_audio` exposes the current tool.
- `src/runtimes/chat/providers/transcription/chain.ts::transcribeAudioWithProviders`
  owns provider selection/execution.
- `src/core/messages.ts::updateTranscription` and `messages.content_text` own
  persisted searchable transcription text.
- MCP search and current message authorization remain the search boundary.

### Exact gap

No current-main hit was found for a transcription attempt or transcription
consent state. The gap is policy/lifecycle around the existing chain:
consent, admission, retry/recovery, honest terminal status, retention, and
deletion.

### Superseded and narrowed instructions

- Do not add another transcription chain, provider router, or searchable field.
- A new attempt table is conditional. First prove generic tool evidence plus
  message state cannot represent required recovery and consent transitions.
- FTS work is not greenfield; only authorization/status/deletion projections
  may be missing.
- No historical transcription/backfill is authorized by this proposal.

### Owner decisions

- source classes and consent basis;
- native model-audio versus transcription policy;
- provider/fallback equivalence;
- persistence and search modes/authorization;
- confidence, language, and provenance contract;
- retention and deletion across message text, indexes, caches, exports, and
  backups;
- generic evidence adapter versus new attempt SSOT;
- derived-secret integration with DPR-01.

### First implementation-plan gate

First RED binding:

- File: `tests/runtimes/chat/transcription-continuity.test.ts`
- Test: `does not persist or index a denied voice-note transcription`
- Command: `npm test -- tests/runtimes/chat/transcription-continuity.test.ts -t "does not persist or index a denied voice-note transcription" --pool=forks`
- Expected RED reason: no approved consent/admission state currently guards
  the existing transcription chain and persistence seam.

Name RED tests in transcription chain/integration suites,
`tests/core/messages.test.ts`, `tests/mcp/tools/media.test.ts`, and
`tests/mcp/tools/search.test.ts`. Cover consent deny/revoke, restart at every
attempt boundary, fallback mismatch, duplicate completion, deletion, search
authorization, privacy canaries, feature-off, and no-backfill behavior.

The PR must remain draft and use non-closing references to the portability
issues.
