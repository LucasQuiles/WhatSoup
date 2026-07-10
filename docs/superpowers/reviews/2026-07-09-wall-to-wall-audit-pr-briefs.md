# Wall-to-Wall Audit: Copy-Ready PR Briefs

**Status:** Completed locally and published only as part of the documentation PR; no WS implementation branch or implementation PR has been opened from these briefs.

**Audited code base:** `origin/main` at `7330bafbe77d7a15febce32eb09b304e8778862f` on 2026-07-09. The documentation branch was rebased on `d04ab3e9a2ea3b1f04f458528600af9ce758c2fd` on 2026-07-10; the intervening redaction, health/deploy, and test-harness changes are dispositioned below, and each implementation branch must refresh evidence from its then-current main.

**Purpose:** These briefs turn the audit findings into small, sequenced pull requests. Each implementation branch must start from a freshly fetched current main; line numbers below describe the audited base and may move.

## Publication and Review Rules

- W0-01 is a closed-PR recovery prerequisite, not a new remediation PR.
- Keep each WS identifier as its own PR. Do not bundle the 27 briefs into one branch.
- Before superseding any existing branch, compare it with `git range-diff` and `git cherry -v`; preserve unique commits.
- Treat the original PR overlap list as an audit-time snapshot: #1714 and #1715 are merged, while #1716 and #1717 are closed unmerged. Recheck current PRs and preserved replacement histories immediately before branching.
- Every PR starts with a deterministic red test or probe at the failure seam.
- Before marking ready, run the focused tests, type/lint checks, relevant security guards, and the full pinned `verify:release` gate.
- A missing dependency, killed process, skipped load-bearing check, or zero-test browser tail is inconclusive, not green.
- External publication, merge, release, or repository-setting changes require explicit operator authorization.

## Closed PR Recovery Prerequisite — W0-01

### Recover or reconstruct the intended PR #1717 delta

**Disposition:** Closed unmerged on 2026-07-10. GitHub reported 2,439 changed files, 713,747 deletions, four additions, and merge state `DIRTY` for a narrowly described instance-MCP change. Closure removed the merge hazard; intended feature recovery remains unresolved.

**Required procedure:**

1. Fetch current main and the PR head without modifying either branch.
2. Inventory the intended commits and files.
3. Reconstruct only the intended delta on a fresh branch from current main.
4. Run `git range-diff` and `git cherry -v` between the original and reconstruction.
5. Verify the reconstructed branch normally.
6. Only after evidence shows no unique work was lost may the closed PR be described as superseded; otherwise record an explicit abandonment decision.

**Do not:** merge the current diff, delete the branch, or use a destructive reset as a shortcut.

---

## Wave 1 — Durability, Delivery, and Privacy

### WS-A01 — `fix(durability): make reply guarantee terminal only after tracked visible output`

**Priority:** P0 reliability
**Depends on:** WS-A02 and WS-A03 admission/shutdown foundations
**Implementation plan:** `docs/superpowers/plans/2026-07-09-durable-inbound-and-reply-guarantee.md`

#### Problem

The soft liveness path sends typing best-effort, returns `rgp_liveness_nudged`, and completes the inbound. This conflicts with the documented guarantee of a visible reply or interruption notice. Current tests pin the unsafe outcome by asserting no message and no audit row.

#### Proposed change

- Treat typing as non-terminal activity only.
- Journal a hard-deadline visible fallback notice through the normal tracked send path.
- Complete the inbound only after the configured terminal proof is recorded.
- Expose soft/hard deadline outcomes and audit-pending state with low-cardinality metrics.

#### Acceptance checklist

- [ ] Fake-clock test proves typing cannot finalize an inbound.
- [ ] Hard-deadline notice is journaled before delivery attempt.
- [ ] Send failure leaves replay/recovery material rather than a completed inbound.
- [ ] Duplicate timer firings cannot produce duplicate terminal notices.
- [ ] `verify:release` passes with non-zero browser counts.

#### Risk and rollback

Risk is duplicate or delayed fallback messages. Ship behind the existing reply-guarantee configuration, retain journal evidence, and rollback by disabling the hard-deadline sender rather than marking work complete early.

#### Non-goals

No copy redesign and no queue-admission rewrite; WS-A03 owns admission/shutdown.

### WS-A02 — `fix(ingest): atomically admit messages into a replayable inbound journal`

**Priority:** P0 durability
**Depends on:** Schema/migration review from current main
**Implementation plan:** `docs/superpowers/plans/2026-07-09-durable-inbound-and-reply-guarantee.md`

#### Problem

Ingest stores and deduplicates a message before creating its inbound journal row. A crash between those writes leaves a stored message with no replayable admission; redelivery is then rejected as a duplicate. The deterministic audit probe observed `first=true`, no inbound row, and rejected redelivery.

#### Proposed change

- Put message persistence and inbound admission in one SQLite transaction.
- Make redelivery reclaim or repair a missing/open admission deterministically.
- Define migration/backfill behavior for existing stored messages without admission rows.
- Add stage counters for persisted, admitted, repaired, rejected, and deferred messages.

#### Acceptance checklist

- [ ] Crash-point tests cover every write boundary.
- [ ] No committed message can lack its required admission record.
- [ ] Redelivery repairs an eligible historical gap exactly once.
- [ ] Concurrent duplicate delivery yields one canonical message/admission pair.
- [ ] Migration rollback and restart tests pass.
- [ ] Full pinned release gate passes.

#### Risk and rollback

Schema and transaction changes can increase lock duration. Keep the transaction small, measure busy time, and retain a reversible migration; do not fall back to pre-journal deduplication.

### WS-A03 — `fix(runtime): make queue shedding and shutdown durable lifecycle outcomes`

**Priority:** P0 durability
**Depends on:** WS-A02 journal contract
**Implementation plan:** `docs/superpowers/plans/2026-07-09-durable-inbound-and-reply-guarantee.md`

#### Problem

Chat and agent queues return rejection while their callers ignore it. Reply Guarantee is armed only after dequeue, so shed work can disappear without a visible or replayable outcome. Shutdown stops transports without consistently stopping admission, draining queues, or awaiting asynchronous close.

#### Proposed change

- Await and inspect enqueue outcomes in both runtimes.
- Journal admitted, rejected, and deferred queue outcomes.
- Arm reply tracking at accepted inbound admission, not after dequeue.
- Implement stop-admission → drain-or-defer → await transport-close shutdown ordering with a bounded timeout.
- Surface queue depth, oldest age, rejection totals, deferred totals, and shutdown result.

#### Acceptance checklist

- [ ] Saturation test proves every message is admitted, durably deferred, or visibly rejected.
- [ ] Shutdown rejects new work after the stop boundary.
- [ ] Drained work finishes; timed-out work remains replayable.
- [ ] Twilio and socket shutdown promises are awaited through a truthful interface.
- [ ] Forced-timeout/restart test recovers deferred work.
- [ ] Full pinned release gate passes.

#### Risk and rollback

The main risk is shutdown hang. Use one bounded coordinator and preserve durable deferral on timeout; do not silently drop the queue to make shutdown fast.

### WS-A04 — `fix(send): separate transport delivery from audit finalization`

**Priority:** P0 delivery correctness
**Depends on:** None; start from main containing merged #1714 and preserve its final redaction contracts
**Implementation plan:** `docs/superpowers/plans/2026-07-09-delivery-audit-and-idempotency.md`

#### Problem

`markSuccess` audit failure is caught as if the transport failed, followed by `markFailure` and a rejected promise. The audit probe sent once but classified the delivery as failed, creating a resend hazard.

#### Proposed change

- Model transport submission and audit finalization as separate state transitions.
- Preserve the transport receipt when audit storage fails.
- Record `audit_pending` without invoking transport failure or resend logic.
- Add a reconciler and health signal for incomplete audits.

#### Acceptance checklist

- [ ] Transport success plus audit failure never calls the transport twice.
- [ ] Caller receives a truthful submitted/audit-pending result.
- [ ] Reconciler finalizes the audit without changing delivery identity.
- [ ] Health exposes stale audit-pending count and age.
- [ ] Transport failure still follows the existing failure path.
- [ ] Full pinned release gate passes.

#### Risk and rollback

Consumers may assume a rejected promise means no send. Introduce the typed result before changing retry behavior and quarantine ambiguous legacy callers.

### WS-A05 — `fix(send): reuse stable delivery identity across chat and scheduler retries`

**Priority:** P0 duplicate-send prevention
**Depends on:** WS-A04
**Implementation plan:** `docs/superpowers/plans/2026-07-09-delivery-audit-and-idempotency.md`

#### Problem

Agent outbound retries reuse a stable ID, but chat and scheduled sends create fresh transport attempts for the same logical message. An ambiguous timeout can therefore become a duplicate user-visible send.

#### Proposed change

- Allocate one stable delivery identity per logical chat or scheduled send.
- Reuse it across eligible retries and audit reconciliation.
- Classify ambiguous outcomes as `maybe_sent` and quarantine until echo/reconciliation evidence arrives.
- Document transport-specific exceptions where stable identity is unavailable.

#### Acceptance checklist

- [ ] Retry fakes observe the same stable ID for one logical send.
- [ ] Separate logical sends never share an ID.
- [ ] Timeout-after-submit does not blindly resend.
- [ ] Echo/reconciliation resolves `maybe_sent` without duplicate delivery.
- [ ] Scheduler restart preserves the identity.
- [ ] Full pinned release gate passes.

#### Risk and rollback

Stable IDs affect transport metadata and stored rows. Migrate additively and keep legacy rows readable; failed migration must pause retry rather than generate a new ID.

### WS-A06 — `security(logging): enforce metadata-only logs at the central sink and content call sites`

**Priority:** P0 privacy/security
**Depends on:** Satisfied by merged #1714; branch from current main
**Implementation plan:** `docs/superpowers/plans/2026-07-09-privacy-erasure-and-media-confinement.md`

#### Problem

The central Pino sinks have no redaction configuration, while call sites log text previews, full URLs, malformed MCP lines, raw JIDs, phones, and errors that may contain secrets. The synthetic canary reached captured output.

#### Proposed change

- Configure central key/path redaction for every sink.
- Remove free-form message, URL query/fragment, tool input/result, and raw-line previews at call sites.
- Replace raw identities with no identifier or a short local correlation hash when essential.
- Normalize errors to low-cardinality class/code and bounded safe detail.
- Add a multi-sink canary test.

#### Acceptance checklist

- [ ] Unique message, phone, JID, token, URL query/fragment, and malformed-JSON canaries appear in no sink.
- [ ] Useful event type, stage, error class, and correlation remain.
- [ ] Third-party and rolling-file sinks use the same policy.
- [ ] Log tests cover nested objects and serialized errors.
- [ ] No raw conversation identifier becomes a metric label.
- [ ] Full pinned release gate passes.

#### Risk and rollback

Over-redaction can damage diagnostics. Retain structured event/stage/error fields and validate operational queries before rollout; never restore content previews as the rollback.

### WS-A07 — `security(erasure): keep deleted content out of enrichment and secondary telemetry`

**Priority:** P0 privacy/data lifecycle
**Depends on:** WS-A06 for safe diagnostics
**Implementation plan:** `docs/superpowers/plans/2026-07-09-privacy-erasure-and-media-confinement.md`

#### Problem

Soft-deleted messages remain eligible for enrichment, and the audit probe returned deleted synthetic content. Tool execution storage retains most inputs and full results for 30 days without an explicit erasure contract.

#### Proposed change

- Exclude `deleted_at` rows in selection and count queries.
- Revalidate deletion immediately before extraction, remote processing, fact write, and export.
- Purge/tombstone derived facts and define irreversible redaction for required audit metadata.
- Publish a field-level retention/erasure matrix for tool telemetry.
- Add deletion races and unique-marker disappearance tests.

#### Acceptance checklist

- [ ] Deleted content never reaches the enrichment provider.
- [ ] In-flight deletion prevents later derived writes/exports.
- [ ] Existing derived content is purged or irreversibly redacted.
- [ ] Required audit metadata contains no recoverable user content.
- [ ] Unique synthetic marker is absent from all covered secondary stores after erasure.
- [ ] Full pinned release gate passes.

#### Risk and rollback

Deletion must not erase security-critical event existence. Preserve content-free tombstones where legally/operationally required and test that they cannot reconstruct the original content.

### WS-A08 — `security(media): realpath-confine every cached media read`

**Priority:** P0 conditional file-read security
**Depends on:** None
**Implementation plan:** `docs/superpowers/plans/2026-07-09-privacy-erasure-and-media-confinement.md`

#### Problem

Cached media checks are lexical and transcription reads the database path directly. A poisoned row or escaping symlink can therefore pass bytes outside the managed root to a remote provider.

#### Proposed change

- Resolve the managed root and target canonically at open/read time.
- Refuse symlinks, non-regular files, and realpaths outside the root.
- Apply the same helper to download, transcription, and every cached-media consumer.
- Ensure refusal happens before any provider call or response stream.

#### Acceptance checklist

- [ ] Normal managed file succeeds.
- [ ] `..`, prefix-collision, outside absolute path, leaf symlink, and parent symlink fail closed.
- [ ] FIFO/device/non-regular fixtures fail.
- [ ] Provider fake receives zero calls on refusal.
- [ ] Race-aware open/read approach is documented and tested to the platform capability.
- [ ] Full pinned release gate passes.

#### Risk and rollback

Canonicalization can reject legacy cache paths. Detect and report them without reading; migration must copy into the managed root rather than weakening confinement.

---

## Wave 2 — Recovery, Updater, and Console Truthfulness

### WS-B01 — `fix(health): fail closed on critical DB and recovery-verification failures`

**Priority:** P0 readiness/recovery
**Depends on:** #1715 is merged; #1716 closed unmerged, so resolve any preserved provider-recovery replacement before assuming its fields
**Implementation plan:** `docs/superpowers/plans/2026-07-09-health-recovery-and-self-update.md`

#### Problem

Critical health queries substitute zeros after database errors, so a missing core table can still report HTTP 200. Recovery verification exceptions clear quarantine, treating uncertainty as success.

#### Proposed change

- Return typed probe results with `ok`, value, and low-cardinality error.
- Split liveness from readiness; unreadable critical tables degrade or return 503 readiness.
- Preserve last-known safe values only when explicitly labeled stale.
- Keep candidates quarantined when verification fails while continuing other recovery work.

#### Acceptance checklist

- [ ] Dropped/corrupt critical table cannot produce ready/healthy 200 semantics.
- [ ] Liveness remains available without claiming readiness.
- [ ] Verification throw preserves quarantine.
- [ ] One failed candidate does not abort recovery of independent candidates.
- [ ] Health output contains no raw JID or private path.
- [ ] Full pinned release gate passes.

#### Risk and rollback

Fail-closed readiness may restart unhealthy instances more often. Coordinate deploy probes and debounce; never restore zero substitution for critical state.

### WS-B02 — `fix(update): make self-update a fail-closed verified transaction`

**Priority:** P0 update safety
**Depends on:** WS-B01 health/readiness contract
**Implementation plan:** `docs/superpowers/plans/2026-07-09-health-recovery-and-self-update.md`

#### Problem

Git inspection failures proceed, dependencies use mutable `npm install`, and restart occurs without running a release validation profile. An uncertain or unverified tree can replace a running instance.

#### Proposed change

- Stop on status/SHA/diff uncertainty or dirty worktree.
- Capture before/target SHAs and an update journal.
- Install with the pinned runtime and frozen lockfile (`npm ci`).
- Run a bounded pre-restart validation profile.
- Preserve diagnostics and explicit rollback instructions on any failure.

#### Acceptance checklist

- [ ] Every git inspection failure stops before mutation.
- [ ] Lock mismatch fails before restart.
- [ ] Failed validation leaves current process running and records the failed target SHA.
- [ ] Successful restart proves the expected version/SHA.
- [ ] Interrupted update is recoverable from its journal.
- [ ] Full pinned release gate passes.

#### Risk and rollback

Update transactions touch source, dependencies, and process lifecycle. Use explicit phases and never delete the last known good install until post-restart proof succeeds.

### WS-B03 — `fix(console): require restart/version proof before reporting update completion`

**Priority:** P1 user-trust
**Depends on:** WS-B02 response/event contract
**Implementation plan:** `docs/superpowers/plans/2026-07-09-console-truthful-session-update-and-send-ux.md`

#### Problem

Network, body-read, and SSE parse errors transition into restart polling; polling timeout advances to restart controls without proof. The UI can display success when no verified update occurred.

#### Proposed change

- Model update phases as explicit pending/succeeded/failed states.
- Require a confirmed restart event plus down/up or changed version/SHA proof.
- Treat malformed/empty/pre-restart disconnect and unchanged-version timeout as failures.
- Surface preserved diagnostics and safe retry/rollback instructions.

#### Acceptance checklist

- [ ] Malformed SSE never produces “Update Complete.”
- [ ] Pre-restart disconnect never produces success.
- [ ] Unchanged version after timeout renders failure.
- [ ] Confirmed event plus version transition renders success once.
- [ ] Browser tests exercise network and reconnect behavior, not only rendering.
- [ ] Full pinned release gate passes.

### WS-B04 — `fix(console): relock the application when the authenticated session expires`

**Priority:** P0 session security
**Depends on:** None
**Implementation plan:** `docs/superpowers/plans/2026-07-09-console-truthful-session-update-and-send-ux.md`

#### Problem

Session-ticket code throws `ConsoleLockedError`, but no runtime owner consumes it. Realtime sits outside the session gate and converts unauthorized ticket failures into reconnect attempts, leaving protected UI/query state active.

#### Proposed change

- Introduce one session owner for HTTP and WebSocket unauthorized events.
- Close realtime, cancel protected requests, clear protected query cache, and return to unlock exactly once.
- Prevent reconnect until a new unlock succeeds.
- Preserve only non-sensitive UI preferences.

#### Acceptance checklist

- [ ] Initial locked, manual relock, HTTP expiry, and WebSocket expiry converge on one state.
- [ ] Protected cached data disappears after relock.
- [ ] Realtime closes and does not retry while locked.
- [ ] Concurrent unauthorized responses trigger one transition.
- [ ] Unlock establishes a fresh session and reconnects once.
- [ ] Real browser action tests pass.

### WS-B05 — `fix(console): preserve failed drafts and wire honest retry state`

**Priority:** P1 user recovery
**Depends on:** WS-A05 stable delivery identity
**Implementation plan:** `docs/superpowers/plans/2026-07-09-console-truthful-session-update-and-send-ux.md`

#### Problem

Both composers clear before send and delete optimistic bubbles on failure. A retry UI exists for `pk === -1`, but production callers do not wire it. Users lose text and cannot distinguish failed from possibly delivered messages.

#### Proposed change

- Preserve draft text until a definitive submitted result.
- Keep a failed/ambiguous bubble with copy-to-draft and retry controls.
- Enable automatic retry only when stable delivery identity is available.
- Share the same state contract between Inbox and HistoryTab.

#### Acceptance checklist

- [ ] Definite failure retains the exact draft.
- [ ] Ambiguous outcome is labeled and does not silently retry.
- [ ] Retry reuses the delivery identity from WS-A05.
- [ ] Success clears the draft once and reconciles the optimistic bubble.
- [ ] Navigation/reload behavior is explicit and tested.
- [ ] Browser action tests pass.

#### Non-goal

This PR consumes the stable-ID API; it does not invent a second client-only idempotency scheme.

### WS-B06 — `fix(console): distinguish loading, error, empty, and unavailable conversation states`

**Priority:** P1 usability
**Depends on:** None
**Implementation plan:** `docs/superpowers/plans/2026-07-09-console-truthful-session-update-and-send-ux.md`

#### Problem

Conversation load errors render like empty data, polling-only development mode appears perpetually reconnecting, and Save Contact is a presented placeholder rather than a completed capability.

#### Proposed change

- Give chats/messages loading, error, empty, unavailable, and success distinct states.
- Add retry actions that rerun the failed request.
- Represent intentional polling-only mode as healthy without claiming a socket connection.
- Wire Save Contact to the real dialog/API or remove the action.

#### Acceptance checklist

- [ ] Failed chat and message requests show an error and working Retry.
- [ ] Valid empty responses show empty copy only.
- [ ] Development polling mode does not show “Reconnecting.”
- [ ] Save Contact performs a tested action or is absent.
- [ ] Error recovery does not duplicate messages or requests.
- [ ] Browser action tests pass.

---

## Wave 3 — Governor, Metrics, and Product Completeness

### WS-C01 — `fix(config): validate and document outbound-governor configuration`

**Priority:** P1 configuration safety
**Depends on:** None
**Implementation plan:** `docs/superpowers/plans/2026-07-09-outbound-governor-and-flood-observability.md`

#### Problem

Runtime code casts nested governor values that are absent from the shared instance schema and validator. Invalid types, ranges, and cross-field relations pass load validation.

#### Proposed change

- Add the governor block to the typed instance contract.
- Validate create, patch, and load paths with exact nested field errors.
- Enforce integer/range and cross-field constraints.
- Document defaults, limits, and operational behavior.

#### Acceptance checklist

- [ ] Valid blocks round-trip through create/patch/load.
- [ ] Invalid type, zero/negative, fractional, excessive, and inconsistent values fail before persistence.
- [ ] Runtime consumes validated values without unchecked casts.
- [ ] Public docs and surface inventory match.
- [ ] Focused config tests and full release gate pass.

### WS-C02 — `fix(transport): enforce an end-to-end governor deadline and bounded waiter count`

**Priority:** P0 overload resilience
**Depends on:** WS-C01 config contract
**Implementation plan:** `docs/superpowers/plans/2026-07-09-outbound-governor-and-flood-observability.md`

#### Problem

The limiter bounds each reservation’s local wait but not time already spent behind earlier reservations. The audit’s 150 ms deadline probe settled the fourth request after 304 ms. Waiter count is unbounded.

#### Proposed change

- Capture a monotonic deadline at enqueue.
- Check remaining budget before and after every queued wait.
- Bound pending waiters per key and shed with stable reasons.
- Expose pending depth, oldest age, deadline sheds, and capacity sheds.

#### Acceptance checklist

- [ ] Fake-clock queue chain never settles past the configured deadline as admitted work.
- [ ] Waiter cap rejects immediately and decrements correctly on every outcome.
- [ ] FIFO ordering remains for admitted work.
- [ ] Abort/shutdown clears waiters without leaks.
- [ ] Metrics use no conversation identity labels.
- [ ] Full pinned release gate passes.

### WS-C03 — `fix(observability): record every outbound send at the actual socket wrapper seam`

**Priority:** P1 security observability
**Depends on:** WS-C02 wrapper shape
**Implementation plan:** `docs/superpowers/plans/2026-07-09-outbound-governor-and-flood-observability.md`

#### Problem

Flood-detector documentation claims all send tiers, but counters live in four ConnectionManager methods. Tier-C tools call the wrapped raw socket directly, bypassing those methods. Counting at both levels would double-count other sends.

#### Proposed change

- Invoke one failure-isolated observer at the in-place `sendMessage` wrapper seam.
- Remove per-method counting.
- Preserve socket object identity and reconnect wrapping semantics.
- Classify content without recording payload or raw target identity.

#### Acceptance checklist

- [ ] Tier A, B, and C text each count once.
- [ ] Media, poll, raw, failed, and reconnect paths each count once.
- [ ] Observer failure cannot perturb the actual send.
- [ ] Rewrapping does not stack observers.
- [ ] Documentation matches the true seam.
- [ ] Full pinned release gate passes.

### WS-C04 — `fix(metrics): finalize completed hours and expose collection completeness`

**Priority:** P1 metric integrity
**Depends on:** None
**Implementation plan:** `docs/superpowers/plans/2026-07-09-metrics-realtime-and-watch-completeness.md`

#### Problem

Periodic collection recomputes only the current hour. When the clock crosses an hour, late data in the completed bucket remains stale. Sparse rows are zero-filled with no freshness watermark, so unknown looks like zero.

#### Proposed change

- Finalize every crossed hour before collecting the current bucket.
- Backfill bounded missed buckets on restart.
- Return `last_collected_at` and `complete_through`.
- Represent incomplete gaps as unknown, not zero.

#### Acceptance checklist

- [ ] Fake-clock boundary test updates the completed prior hour.
- [ ] Restart backfill covers a bounded gap and records truncation if the bound is exceeded.
- [ ] API and console distinguish zero from unknown.
- [ ] Collection failure preserves the prior watermark.
- [ ] Timezone/DST behavior remains UTC and tested.
- [ ] Full pinned release gate passes.

### WS-C05 — `fix(realtime): preserve last-known-good state on observation failure`

**Priority:** P0 state integrity
**Depends on:** None
**Implementation plan:** `docs/superpowers/plans/2026-07-09-metrics-realtime-and-watch-completeness.md`

#### Problem

A failed DB read becomes null markers and emits false message/access changes. Typing HTTP 503 becomes `composing:false`. Infrastructure failure is being published as business state.

#### Proposed change

- Model probe success separately from observed value.
- Update snapshots and emit business events only after successful observations.
- Preserve last-known-good state across failure.
- Expose failure streak, last success, and degraded dwell.
- On recovery, emit only genuine deltas.

#### Acceptance checklist

- [ ] DB failure emits no message/access change.
- [ ] Typing 503 emits no false stop-composing event.
- [ ] Repeated failure increments health state without event storms.
- [ ] Recovery with unchanged value emits nothing.
- [ ] Recovery with changed value emits one genuine delta.
- [ ] Full pinned release gate passes.

### WS-C06 — `fix(substrate): reject public watch kinds with no executor`

**Priority:** P1 product truthfulness
**Depends on:** None
**Implementation plan:** `docs/superpowers/plans/2026-07-09-metrics-realtime-and-watch-completeness.md`

#### Problem

`create_watch` publicly accepts `poll.email` and `event.message`, returns successful IDs, and persists rows that are deliberately inert. The API presents unavailable behavior as completed work.

#### Proposed change

- Restrict creation schemas and docs to executable watch kinds.
- Reject inert kinds with a stable validation error.
- Keep legacy rows fail-closed with explicit unsupported status and TTL behavior.
- Align registry, MCP schema, docs, and public-surface inventory.

#### Acceptance checklist

- [ ] New inert kind creation fails before persistence.
- [ ] Wired kinds still execute.
- [ ] Legacy inert rows never fire and age out predictably.
- [ ] Tool schema and docs expose the same enum.
- [ ] Migration does not silently convert intent to another watch kind.
- [ ] Full pinned release gate passes.

---

## Wave 4 — Architecture and Verification Quality

### WS-D01 — `refactor(agent): converge duplicate event handlers on one reducer`

**Priority:** P1 architectural risk reduction
**Depends on:** Resolve the preserved replacement histories for closed-unmerged #1716 and #1717
**Implementation plan:** `docs/superpowers/plans/2026-07-09-architecture-and-verification-quality.md`

#### Problem

`handleEventWithContext` and `handleEvent` duplicate the event state machine across roughly 1,200 lines. Fixes can land in one mode but not the other, and the declarative response registry remains optional.

#### Proposed change

- Characterize every event type in shared and per-chat modes.
- Add explicit context adapters and one reducer.
- Move case families mechanically with parity traces.
- Use temporary low-cardinality divergence counters during canary rollout.

#### Acceptance checklist

- [ ] Event union has exhaustive shared/per-chat fixtures.
- [ ] Exactly one event switch remains.
- [ ] Characterization traces stay stable through extraction.
- [ ] Canary covers normal, tool, interruption, provider failure, and reconnect paths with zero unexplained divergence.
- [ ] Shadow-only code is removed only after evidence.
- [ ] Full pinned release gate passes.

#### Risk and rollback

This is intentionally last-wave work. Roll back to legacy dispatch while retaining characterization; do not combine behavior changes with the extraction.

### WS-D02 — `refactor(bot-errors): centralize Python private filesystem operations`

**Priority:** P1 security maintainability
**Depends on:** Start from main containing merged #1715 and compare any preserved #1716 replacement before touching overlapping helpers
**Implementation plan:** `docs/superpowers/plans/2026-07-09-architecture-and-verification-quality.md`

#### Problem

Private-directory, atomic-write, append, and parent-fsync helpers are copied across deployment scripts. A guard requires the copied strings, institutionalizing drift rather than testing security behavior.

#### Proposed change

- Create one importable private-filesystem library.
- Preserve no-follow, mode, complete-write, fsync, replace, append, and cleanup semantics.
- Import it from every managed script while preserving monkeypatch surfaces.
- Replace substring checks with direct adversarial Python tests and import-parity checks.

#### Acceptance checklist

- [ ] Symlink/non-regular targets fail without modifying referents.
- [ ] Files/directories end at 0600/0700.
- [ ] File and parent are fsynced on atomic write.
- [ ] Append is complete, newline-terminated, and fsynced.
- [ ] Every managed runtime script imports the SSOT and manifest deployment includes it.
- [ ] Full pinned release/deployer gates pass.

### WS-D03 — `fix(quality): make orphan and guard-coverage checks semantic`

**Priority:** P1 verification integrity
**Depends on:** None
**Implementation plan:** `docs/superpowers/plans/2026-07-09-architecture-and-verification-quality.md`

#### Problem

Orphan scanning counts tests, comments, and strings and ignores TSX. Guard coverage accepts a wired no-op test. Decision-poll wiring relies on raw substrings. `emitDelegationReceipt` has no production reference.

#### Proposed change

- Use TypeScript/TSX AST production reachability for exported values.
- Require guard tests to import, invoke, and prove a negative path.
- Replace decision-poll text anchors with structured wiring plus executable hook fixtures.
- Remove the orphaned receipt API unless a separate approved feature wires it.

#### Acceptance checklist

- [ ] Comment/string/test-only references do not keep an export alive.
- [ ] TSX production imports do.
- [ ] No-op/import-only/success-only guard companions fail the meta-guard.
- [ ] Disabled poll hook fails a negative fixture.
- [ ] Current tree has no unexplained orphan or temporary exception without expiry.
- [ ] Full pinned release gate passes.

### WS-D04 — `refactor(console): break the ConfirmDialog/primitives/Menu ESM cycle`

**Priority:** P2 simplification
**Depends on:** None
**Implementation plan:** `docs/superpowers/plans/2026-07-09-architecture-and-verification-quality.md`

#### Problem

ConfirmDialog imports the primitives barrel, the barrel exports Menu, and Menu imports ConfirmDialog, forming an ESM cycle.

#### Proposed change

- Import Modal and Button leaf modules directly in ConfirmDialog.
- Add a TypeScript-AST relative-import cycle test for all console source.
- Preserve the public dialog and barrel contracts.

#### Acceptance checklist

- [ ] Pre-change detector identifies the exact cycle.
- [ ] Post-change console graph has no relative-import cycle.
- [ ] ConfirmDialog and Menu interaction tests pass.
- [ ] Console production build passes.
- [ ] Full pinned release gate passes.

### WS-D05 — `refactor(substrate): consolidate last string value lookup`

**Priority:** P2 deduplication
**Depends on:** None
**Implementation plan:** `docs/superpowers/plans/2026-07-09-architecture-and-verification-quality.md`

#### Problem

`lastHashFor` and `lastUrlHashFor` duplicate the same SQL, ordering, JSON parsing, and type checking, differing only by key.

#### Proposed change

- Replace both with `lastStringFor(triggerId, key)`.
- Preserve successful/noop filtering and `started_at DESC, id DESC` ordering.
- Preserve null behavior for missing/non-string/malformed output.

#### Acceptance checklist

- [ ] Both keys select the newest deterministic row.
- [ ] Failed runs remain excluded.
- [ ] Missing, non-string, and malformed JSON return null.
- [ ] File and URL poll behavior is unchanged.
- [ ] Focused poller and full release tests pass.

### WS-D06 — `chore(verification): reduce test-log noise and repair maintenance warnings`

**Priority:** P1 verification reliability
**Depends on:** None; keep dependency diff isolated
**Implementation plan:** `docs/superpowers/plans/2026-07-09-architecture-and-verification-quality.md`

#### Problem

The release suite emits excessive per-migration and expected in-memory WAL output, uses deprecated recursive `fs.rmdir`, carries an obsolete Vite/esbuild override, can end browser verification with a missing-executable/zero-test crash tail, and resolves a dev-only vulnerable `brace-expansion@5.0.5` path.

#### Proposed change

- Aggregate migration logs and suppress only the expected in-memory WAL warning.
- Add an actionable browser executable preflight before both browser lanes.
- Replace deprecated removals with `fs.rm`/`rmSync`.
- Remove the obsolete override and refresh only affected lock paths.
- Move the 5.x `brace-expansion` path to at least 5.0.6.

#### Acceptance checklist

- [ ] Captured test stdout bytes/lines drop materially without masking unexpected failures.
- [ ] Missing browser fails before test launch with an install command.
- [ ] Browser success reports non-zero files/tests in both lanes.
- [ ] No deprecated recursive-rmdir warning remains.
- [ ] Development and production audit results are recorded; the named advisory is gone.
- [ ] Full pinned release gate passes.

### WS-D07 — `chore(repo): align commit identity enforcement with public-repo policy`

**Priority:** P1 publication hygiene
**Depends on:** Repository-owner review of merge workflow
**Implementation plan:** `docs/superpowers/plans/2026-07-09-architecture-and-verification-quality.md`

#### Problem

Current main contains a squash-generated co-author trailer even though local/CI policy rejects all such trailers and disallowed attribution. Branch scanning intentionally excludes commits already on main, so it does not prevent or reliably detect the generated landed message.

#### Proposed change

- Add a read-only preflight for explicit squash subject/body and approved public author identity.
- Document the guarded operator merge path with head-SHA matching and post-merge verification.
- On main pushes, scan the pushed commit range rather than applying branch-base exclusions.
- State clearly that local preflight cannot prevent an unguarded web merge.

#### Acceptance checklist

- [ ] Co-author, disallowed attribution, unapproved identity, empty subject, and implicit body fixtures fail.
- [ ] Clean explicit identity/message fixture passes.
- [ ] PR branch scans exclude already-landed main commits as intended.
- [ ] Main-push scan detects a bad newly landed commit.
- [ ] Documentation distinguishes prevention from post-merge detection.
- [ ] Full pinned release gate passes.

#### Risk and rollback

Incorrect range selection can block unrelated work or miss a landed commit. Test PR and main-push contexts separately; do not claim server-side prevention without an enforceable repository mechanism.

---

## Recommended Sequence

1. Reconstruct or explicitly abandon the intended #1717 delta; do not reuse its destructive branch state.
2. Run WS-A02 → WS-A03 → WS-A01 for the inbound/reply foundation, then WS-A04 → WS-A05 → WS-A06 → WS-A07 → WS-A08; WS-A05 must precede B05.
3. Run WS-B01 before B02/B03; B04 and B06 can proceed independently.
4. Run WS-C01 before C02 before C03; C04 through C06 can proceed independently.
5. Run WS-D04 and WS-D05 at any low-conflict point; defer D01/D02 until the overlapping closed-PR replacement histories are explicitly resolved.
6. Run WS-D03, D06, and D07 as isolated quality/hygiene changes with their own negative controls.

## Shared Ready-for-Review Evidence

Every PR body should end with actual outputs, not planned commands:

- deterministic red test/probe and observed pre-fix failure;
- focused post-fix suite counts;
- `typecheck:all` and relevant lint/guard result;
- security negative controls when applicable;
- full pinned `verify:release` exit, test counts, coverage, and both browser lane counts;
- skipped/inconclusive external prerequisites;
- `git diff --check`, diffstat, commit-author scan, and confirmation that only intended scope changed.
