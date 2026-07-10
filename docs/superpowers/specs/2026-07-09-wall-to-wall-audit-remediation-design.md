# WhatSoup Wall-to-Wall Audit Remediation Design

**Date:** 2026-07-09

**Status:** Active — approved in-session for local design and planning

**Audited code base:** `7330bafbe77d7a15febce32eb09b304e8778862f` (`origin/main` at audit time)

**Current-main refresh:** `46f64eb7b8a21274a16dfd657515afc995c33e66` (`origin/main`); the intervening merged delta is documentation-only, so the code findings and line-level evidence remain applicable.

**Publication boundary:** Local branch and commits only. Publishing branches or Draft PRs still requires explicit approval.

## 1. Outcome

Turn the 2026-07-09 whole-repository audit into a sequence of reviewable pull requests that:

1. restores user-visible and durable messaging invariants;
2. distinguishes failure and uncertainty from successful state;
3. prevents private message content, identifiers, and secret-bearing URLs from entering routine logs or secondary telemetry stores;
4. makes queueing, delivery, recovery, and collection behavior measurable;
5. repairs misleading console states and unwired public features;
6. consolidates duplicated state machines and security-sensitive filesystem policy only after behavioral correctness is protected by tests.

This is a remediation program, not a license for a broad rewrite. Each implementation PR must preserve one coherent behavioral idea, carry its own regression proof, and remain independently revertible.

## 2. Audit Baseline

The audit covered the tracked production, test, console, deploy, and script surfaces:

| Surface | Tracked files |
|---|---:|
| `src/` | 363 |
| `tests/` | 943 |
| `console/src/` | 160 |
| `deploy/` | 172 |
| `scripts/` | 61 |

The isolated audit worktree was initially verified at `7330bafb`. Before final handoff it was rebuilt on `46f64eb7`; GitHub PR #1721 is the only intervening merge and changes only `docs/publication-audit.md` plus a new design document. No audited production or test source changed between those SHAs.

Fresh pinned verification after installing the declared Playwright browser dependency:

- `npm run verify:release`: exit 0.
- Root suite: 909 passed and 1 skipped files; 17,179 passed and 1 skipped tests.
- Coverage: 97.31% statements, 93.18% branches, 97.29% functions, 98.09% lines.
- Browser suites: 116 functional browser tests and 3 motion tests passed.
- Typechecks, repository guards, test-integrity, boundary checks, console build/design checks, and `tools/whatsoup_guard` passed.
- Root dependency audit found one moderate development-only advisory through `@typescript-eslint`/`minimatch`/`brace-expansion@5.0.5`; production-only, console, and guard audits were clean.

The initial release attempt was inconclusive because the exact Playwright Chromium executable was missing. It ran zero browser tests and exited 139 after Vitest reported the missing executable. After installing the declared browser runtime, the complete release command passed. The failed attempt is retained as a setup/readiness finding, not counted as a product test failure.

## 3. Systemic Diagnosis

The repository is highly tested by aggregate coverage, but several tests intentionally pin unsafe semantics. The dominant failure mode is conversion of a failed or unknown observation into a success-shaped value.

| Pattern | Confirmed examples |
|---|---|
| Failure becomes success | `/health` substitutes zero after DB read failure; realtime polling substitutes null markers; update timeout advances to completion; reply guarantee treats typing as terminal; quarantine verification failure clears the alert. |
| Persistence is split across crash windows | Message insert precedes inbound journal; transport delivery and audit finalization share one catch; queue admission outcomes are not threaded into the inbound journal. |
| Retry identity is inconsistent | Agent outbound queue reuses a stable WhatsApp message ID; chat and scheduler retry paths do not. |
| Observability becomes a privacy store | Routine logs contain private text previews, raw JIDs/phones, full URLs, and malformed MCP request lines; tool-call durability stores most inputs and full results for 30 days. |
| Tests prove shape, not behavior | Guard meta-tests accept no-op companions and source substrings; orphan detection counts tests/comments and excludes TSX; high line coverage coexists with wrong semantic assertions. |
| Parallel implementations drift | Two approximately 600-line agent event handlers implement the same event state machine; Python private-file helpers are copied across deployment scripts; related redactors and response paths diverge. |

The practical conclusion is to protect invariants first, then simplify. A refactor-first program would make behavioral deltas difficult to distinguish from movement.

## 4. Remediation Approaches Considered

### Approach A — Risk-first stacked PR train (recommended)

Merge small behavioral PRs in dependency order: durability and privacy first, then transport/recovery/UX, then telemetry, then architecture and cleanup.

Advantages:

- one behavioral claim per review;
- deterministic regression tests remain attributable;
- reduced conflict with the four PRs open at audit time;
- each change can be reverted without unwinding unrelated fixes;
- correctness work creates a safe characterization boundary for later refactors.

Cost: more PRs and explicit sequencing.

### Approach B — Subsystem bundles

Produce larger durability, transport, privacy, console, and architecture PRs.

Advantages: fewer branches and less coordination overhead.

Rejected as the default because the highest-risk areas already have large state machines and active overlapping branches. A bundle would make review, bisecting, and rollback materially harder.

### Approach C — Guard-first or backlog-only

Strengthen guards and documentation before changing runtime behavior.

Advantages: improves future detection.

Rejected as the default because it knowingly leaves current user-facing loss, false-success, privacy, and recovery defects in place. Guard improvements belong after or alongside the behavioral fix they protect.

## 5. Required Behavioral Invariants

Every implementation plan must trace to at least one invariant below.

### I1 — Inbound admission is durable and replayable

- A message accepted into normal processing has a durable inbound row in the same atomic boundary as its deduplicated message record.
- Duplicate transport delivery cannot permanently suppress work when the message row exists but the inbound journal row is absent or reclaimable.
- Queue shedding produces a durable lifecycle outcome and a visible or recoverable result; it cannot leave `processing` stranded.
- Recovery has a bounded consumer for replayable inbound work.

### I2 — A turn is terminal only after a durable user-visible outcome

- Typing/presence is soft liveness, never terminal delivery.
- Recommended two-stage Reply Guarantee Protocol:
  1. soft deadline: send typing/presence only and keep the inbound open;
  2. hard deadline: send a tracked, explicit interruption notice through the normal outbound journal and finalize only after the configured terminal criterion.
- A deliberately suppressed assistant reply may satisfy the turn only through an explicit, documented terminal state with audit evidence.

### I3 — Delivery truth and audit truth are separate

- Once transport returns a receipt, an audit-finalization failure cannot make the caller believe the send failed or trigger an automatic duplicate.
- The system records or surfaces `delivered_audit_pending`/equivalent uncertainty and degrades health until reconciled.
- Ambiguous network timeouts reuse one stable logical message ID on every eligible retry.

### I4 — Unknown state remains unknown

- Critical DB probe failure cannot become a healthy zero count.
- Realtime poll failure preserves last-known-good state and emits no business event.
- Metrics expose freshness/completeness watermarks; missing collection is not rendered as measured zero.
- Update completion requires a confirmed restart event and changed-or-explicitly-unchanged version proof.
- Recovery verification failure cannot clear a safety alert.

### I5 — Routine telemetry is metadata-only

- No private message or model-output preview in routine logs.
- JIDs and phones use a stable short hash where correlation is needed.
- URLs are logged without userinfo, query, or fragment.
- Malformed MCP input logs record size/hash/error class, not raw bytes.
- Tool durability has an explicit data lifecycle and erasure policy; content-returning tools do not silently create a second message archive.
- Metrics labels remain low-cardinality and never use raw conversation identities.

### I6 — Deletion is enforced at every downstream boundary

- Soft-deleted messages are excluded from enrichment selection and counts.
- A deletion racing an in-flight enrichment batch is revalidated before extraction, validation, or export.
- Queued facts and tool telemetry have explicit purge, tombstone, or irreversible-redaction behavior.

### I7 — User interfaces do not claim success or discard recovery material

- Expired sessions return the console to the unlock screen and close authenticated realtime/query activity.
- Failed message sends preserve the draft or a failed bubble.
- Retrying a possibly delivered message is gated by defined idempotency semantics and honest copy.
- Load failures render retryable error states rather than empty data.
- Placeholder actions and deliberately inert feature kinds are not presented as completed capabilities.

## 6. Proposed PR Train

The titles below are stable draft titles. Detailed implementation packets live in the paired plan/PR-brief artifact.

Implementation packets:

- `docs/superpowers/plans/2026-07-09-durable-inbound-and-reply-guarantee.md` — WS-A01 through WS-A03.
- `docs/superpowers/plans/2026-07-09-delivery-audit-and-idempotency.md` — WS-A04 and WS-A05.
- `docs/superpowers/plans/2026-07-09-privacy-erasure-and-media-confinement.md` — WS-A06 through WS-A08.
- `docs/superpowers/plans/2026-07-09-health-recovery-and-self-update.md` — WS-B01 and WS-B02.
- `docs/superpowers/plans/2026-07-09-console-truthful-session-update-and-send-ux.md` — WS-B03 through WS-B06.
- `docs/superpowers/plans/2026-07-09-outbound-governor-and-flood-observability.md` — WS-C01 through WS-C03.
- `docs/superpowers/plans/2026-07-09-metrics-realtime-and-watch-completeness.md` — WS-C04 through WS-C06.
- `docs/superpowers/plans/2026-07-09-architecture-and-verification-quality.md` — WS-D01 through WS-D07.
- `docs/superpowers/reviews/2026-07-09-wall-to-wall-audit-pr-briefs.md` — W0-01 and all 27 copy-ready PR briefs.

The WS identifiers group findings; they are not a strict landing order. The durable implementation dependency is WS-A02 → WS-A03 → WS-A01, followed by the remaining Wave-1 train. The PR-brief artifact carries the full recommended sequence.

### Wave 0 — Existing-branch safety

**W0-01 — Recover or reconstruct the intended PR #1717 delta**

GitHub reported 2,439 changed files, 713,747 deletions, and 4 additions for an instance-MCP feature, with merge state `DIRTY`. PR #1717 was closed unmerged on 2026-07-10, removing the immediate merge hazard but not recovering its intended feature delta. Treat reconstruction as a prerequisite for overlapping runtime work: inventory both original commits, reconstruct only intended changes on fresh current main, and compare with `git range-diff`/`git cherry -v` before describing the old branch as superseded.

### Wave 1 — Durability, delivery, and privacy

**WS-A01 — `fix(durability): make reply guarantee terminal only after tracked visible output`**

Evidence: `src/core/reply-guarantee.ts:189-197` returns `rgp_liveness_nudged` after best-effort typing; `ReplyGuaranteeManager` then completes the inbound at `:158-165`. `docs/reply-guarantee.md:7-14` promises a visible reply or interruption notice. Current tests explicitly assert no message or audit row.

Acceptance: typing does not finalize; hard-deadline notice is journaled; completion follows the configured terminal proof; fake-clock and durability-failure tests cover both stages.

**WS-A02 — `fix(ingest): atomically admit messages into a replayable inbound journal`**

Evidence: `src/core/ingest.ts:206-233` stores/deduplicates first; `:343-349` journals later. A deterministic probe produced `first=true`, `inboundAfterStore=0`, `redeliveryAccepted=false`.

Acceptance: one transaction protects message + inbound admission; redelivery repairs/reclaims missing or open admission; crash-point tests cover every write boundary; migration/backfill behavior is explicit.

**WS-A03 — `fix(runtime): make queue shedding and shutdown durable lifecycle outcomes`**

Evidence: chat and agent queues return rejection (`src/runtimes/chat/queue.ts:41-49`, `src/runtimes/agent/turn-queue.ts:42-47`), while callers ignore the result (`chat/runtime.ts:157-163`, `agent/runtime.ts:3363`). Reply guarantee is armed only after dequeue (`agent/runtime.ts:3454`). Shutdown does not await `turnQueue.idle()`, ChatRuntime does not drain its queue, and the runtime connection contract types shutdown as `void` although Twilio returns a promise.

Acceptance: admission result is awaited and journaled; queue reject has a defined user/replay outcome; shutdown stops admission, drains or durably defers work, awaits async transport close, and has timeout-path tests.

**WS-A04 — `fix(send): separate transport delivery from audit finalization`**

Evidence: `src/core/send-pipeline.ts:123-133` catches `markSuccess` failure as transport failure and calls `markFailure`. Probe result: one transport send, one failed audit mark, rejected promise.

Acceptance: receipt truth is preserved; audit failure cannot trigger resend; health/alerting exposes incomplete audit state; reconciliation test repairs it.

**WS-A05 — `fix(send): reuse stable delivery identity across chat and scheduler retries`**

Evidence: Agent OutboundQueue correctly reuses a stable ID (`src/runtimes/agent/outbound-queue.ts:1044-1059`). Chat runtime retries without one (`src/runtimes/chat/runtime.ts:469-499`), and scheduled text uses `sendRaw` while retrying rows (`src/core/scheduler.ts:280-356,362-367`).

Acceptance: eligible attempts for one logical send use one stable identity; ambiguous outcomes become `maybe_sent`/quarantined rather than blind resend; transport-specific exceptions are documented.

**WS-A06 — `security(logging): enforce metadata-only logs at the central sink and content call sites`**

Evidence: `src/logger.ts:17-43` configures stdout/journald plus ten rolling files with no Pino redaction. Routine retry logs contain text previews; link extraction logs full URLs; MCP parse errors log the raw line; multiple paths log raw JIDs/phones.

Acceptance: synthetic canaries for message text, JID, phone, access token, URL query/fragment, and malformed JSON are absent from every captured sink; metadata and low-cardinality error class remain. Central key redaction is paired with removal of free-text previews.

**WS-A07 — `security(erasure): keep deleted content out of enrichment and secondary telemetry`**

Evidence: `src/core/messages.ts:206-215,244-248` omits `deleted_at IS NULL`; a deterministic post-`clearChat` probe returned the deleted message to enrichment. `src/mcp/registry.ts:453-478` stores most tool inputs and full results for 30 days.

Acceptance: deleted rows cannot enter or remain in the enrichment/export pipeline; in-flight deletion is rechecked; tool telemetry has an explicit content/erasure matrix and tests proving a unique synthetic marker disappears or is irreversibly redacted.

**WS-A08 — `security(media): realpath-confine every cached media read`**

Evidence: cached download checks are lexical (`src/mcp/tools/media.ts:238-258`); transcription reads `row.media_path` directly (`:410-421`) and can pass bytes to a remote provider. Normal writers are confined, so exploitability is conditional on a poisoned row or escaping symlink.

Acceptance: open/read uses canonical realpath beneath the managed root with symlink refusal and regular-file checks; outside and escaping-symlink fixtures fail before provider invocation.

### Wave 2 — Recovery, updater, and console truthfulness

**WS-B01 — `fix(health): fail closed on critical DB and recovery-verification failures`**

Evidence: `safeDbQuery` substitutes fallbacks (`src/core/health.ts:75-85`); a test drops `messages` and expects HTTP 200 plus zero. `src/core/durability.ts:974-1011` clears quarantine when the verification gate throws.

Acceptance: typed probe results carry `ok`, value, and low-cardinality error; unreadable core tables degrade/503 readiness; liveness remains separately available; verification failure preserves quarantine while recovery continues.

Sequence after PRs #1715 and #1716 because the former changes health/deploy verification and the latter touches health/provider recovery.

**WS-B02 — `fix(update): make self-update a fail-closed verified transaction`**

Evidence: git inspection failures proceed (`src/fleet/routes/update.ts:199-250`), dependency changes use `npm install` (`:253-286`), and restart occurs without a release validation command (`:308-320`).

Acceptance: dirty/status/SHA/diff uncertainty stops; installs use the pinned runtime and frozen lockfile (`npm ci`); a bounded validation profile passes before restart; failure preserves diagnostic state and reports rollback instructions.

**WS-B03 — `fix(console): require restart/version proof before reporting update completion`**

Evidence: network/read/SSE parse errors call restart polling (`console/src/components/UpdateModal.tsx:278-331`); the polling timeout advances to restart controls (`:226-232`) without proof.

Acceptance: only a confirmed restart event plus down/up or version proof advances; malformed/empty/pre-restart disconnect and unchanged-version timeout render actionable failure; no false “Update Complete.”

**WS-B04 — `fix(console): relock the application when the authenticated session expires`**

Evidence: `ConsoleLockedError` is thrown by ticket minting but has no runtime consumer. Realtime is mounted outside the session gate and converts ticket failure into retries.

Acceptance: one session owner handles HTTP and WebSocket unauthorized state, closes realtime, clears protected cached queries, and returns to unlock once; initial, manual, and mid-session expiry tests pass.

**WS-B05 — `fix(console): preserve failed drafts and wire honest retry state`**

Evidence: both composers clear before send and remove optimistic bubbles on failure; `MessageBubble` contains a `pk === -1` retry UI that production callers never wire.

Acceptance: failed content remains recoverable; ambiguous delivery is labeled; retry is enabled only with stable-id semantics; Inbox and HistoryTab share the same behavior contract.

**WS-B06 — `fix(console): distinguish loading, error, empty, and unavailable conversation states`**

Acceptance: chats/messages errors render Retry rather than empty copy in Inbox and LineDetail; polling-only development mode is healthy rather than “Reconnecting”; the HistoryTab save-contact action is either wired to the real dialog/API or removed.

### Wave 3 — Governor, metrics, and product completeness

**WS-C01 — `fix(config): validate and document outbound-governor configuration`**

Evidence: `src/config.ts:899-908` casts nested values, while `InstanceConfig` and the shared validator do not own the block. Invalid type, range, and cross-field probes all returned no validation error.

Acceptance: typed load/create/patch schema; integer/range/relation checks; public docs; defaults and invalid fixtures.

**WS-C02 — `fix(transport): enforce an end-to-end governor deadline and bounded waiter count`**

Evidence: `acquireBounded` explicitly bounds only each reservation's own wait (`src/transport/outbound-rate-limiter.ts:65-75`). Probe with `maxWaitMs=150` settled the fourth request after 304 ms without capping.

Acceptance: wall-clock deadline starts at enqueue; pending waiters are bounded and observable; no admitted send can reach downstream timeout solely because it waited behind the limiter.

**WS-C03 — `fix(observability): record every outbound send at the actual socket wrapper seam`**

Evidence: flood-detector documentation claims all tiers, but counting occurs only in four ConnectionManager methods. Tier-C tools call the wrapped raw socket directly. `wrapWithOutboundGovernor` is the true common seam but does not invoke the detector.

Acceptance: wrapper records all content tiers once; per-method counts are removed; Tier A/B/C, media, poll, raw, failure, and reconnect tests prove no misses or doubles.

**WS-C04 — `fix(metrics): finalize completed hours and expose collection completeness`**

Evidence: periodic collection recomputes only the current hour. Probe stored two messages but left the completed prior bucket at one. Sparse rows are zero-filled without a freshness watermark.

Acceptance: crossed hour is finalized; response includes `last_collected_at` and `complete_through`; unknown gaps render unknown rather than zero; fake-clock tests cover boundary and restart backfill.

**WS-C05 — `fix(realtime): preserve last-known-good state on observation failure`**

Evidence: a failed DB read becomes null markers and publishes false message/access events; typing 503 becomes `composing:false`.

Acceptance: failed probes never update snapshots or publish business changes; failure streak, last success, and degraded dwell are observable; recovery emits only genuine deltas.

**WS-C06 — `fix(substrate): reject public watch kinds with no executor`**

Evidence: `create_watch` accepts `poll.email` and `event.message`, returns successful IDs, and deliberately persists inert behavior.

Acceptance: creation schema exposes only wired kinds; legacy rows continue fail-closed/TTL behavior; docs and public-surface tests match.

### Wave 4 — Architecture and verification quality

**WS-D01 — `refactor(agent): converge duplicate event handlers on one reducer`**

Evidence: `handleEventWithContext` (`src/runtimes/agent/runtime.ts:4561`) and `handleEvent` (`:8984`) duplicate the same event state machine across roughly 1,200 lines. The declarative response registry remains opt-in and legacy ladders remain default.

Acceptance: first characterize both contexts; introduce a context adapter and one reducer; run shadow parity counters; default only after zero unexplained divergence. Sequence after PR #1716 and repaired #1717 because both overlap runtime code.

**WS-D02 — `refactor(bot-errors): centralize Python private filesystem operations`**

Evidence: `ensure_private_dir` and `atomic_write_json` are copied across at least nine deployment scripts. The current guard requires each script to contain local function text, reinforcing drift.

Acceptance: one importable deployment library owns no-follow, mode, fsync, replace, and append behavior; the guard tests behavior/parity instead of local-copy substrings. Sequence after PRs #1715/#1716.

**WS-D03 — `fix(quality): make orphan and guard-coverage checks semantic`**

Evidence: orphan scanning counts tests/comments/strings and only `.ts`; guard coverage accepts a no-op companion; decision-poll checks use raw substrings.

Acceptance: TS/TSX AST-aware production reachability or explicitly named wiring-only semantics; negative-control fixtures prove a comment/no-op cannot satisfy the load-bearing gate; `emitDelegationReceipt` is either wired to production or removed in a separate small commit.

**WS-D04 — `refactor(console): break the ConfirmDialog/primitives/Menu ESM cycle`**

Acceptance: ConfirmDialog imports Modal modules directly; cycle detector and focused UI tests pass.

**WS-D05 — `refactor(substrate): consolidate last string value lookup`**

Evidence: `lastHashFor` and `lastUrlHashFor` duplicate the same SQL/parse flow.

Acceptance: one `lastStringFor(triggerId, key)` helper with unchanged result ordering and malformed-JSON behavior.

**WS-D06 — `chore(verification): reduce test-log noise and repair maintenance warnings`**

Scope: aggregate per-migration info logs, silence expected in-memory WAL warnings, resolve Oxc/esbuild conflict, replace deprecated recursive `fs.rmdir`, make browser dependency readiness explicit, and update the development-only `brace-expansion` lockfile path to a patched version.

Acceptance: release gate remains clean, test stdout drops materially, browser readiness fails with an actionable preflight instead of a zero-test/segfault tail, and dependency audit no longer reports GHSA-jxxr-4gwj-5jf2.

**WS-D07 — `chore(repo): align commit identity enforcement with public-repo policy`**

Evidence: current main contains a squash-generated prohibited attribution trailer while local/CI and workstation policies reject such trailers. Existing automation identity exceptions and server-side squash behavior are not aligned.

Acceptance: document and mechanically validate a merge procedure that produces only approved author identity and no co-author/model/internal attribution. Do not claim server-side prevention without an enforceable mechanism.

## 7. Current PR Coordination

| PR | Current scope | Remediation sequencing |
|---|---|---|
| #1714 | Outbound message-safety redaction | Keep its behavior review separate. Its current draft title carries an agent-attribution tag prohibited by public-repo policy; rename it before ready-for-review. Rebase logging/privacy PR after its final form if shared redaction contracts move. |
| #1715 | Bot-errors health/deploy scripts | Land or close before Python private-FS consolidation. |
| #1716 | Provider reauth across health/runtime/deploy/hygiene | Land or close before health recovery, event-handler convergence, Python helper, and hygiene work. |
| #1717 (closed unmerged) | Instance MCP; the closed diff deleted most of the repository | Merge hazard removed; reconstruct and compare the intended delta on fresh main before overlapping runtime work. |

Every new branch starts from a freshly fetched `origin/main`. Before superseding a branch, use `git range-diff` and `git cherry -v`. No branch deletion is part of this design.

## 8. Observability Contract

The runtime should expose a small, low-cardinality pipeline rather than ad hoc counters:

```text
inbound_received
  -> inbound_persisted
  -> inbound_admitted | inbound_deferred | inbound_rejected
  -> turn_started
  -> turn_terminal_visible | turn_terminal_suppressed | turn_failed

outbound_intent
  -> outbound_attempted
  -> outbound_submitted
  -> outbound_echoed | outbound_maybe_sent | outbound_failed
  -> audit_complete | audit_pending
```

Required measurements:

- counters by stage and low-cardinality reason/error class;
- queue depth, oldest age, admitted/rejected/deferred totals;
- send latency, retries, deadline sheds, hard-ceiling sheds;
- recovery candidates, replayed, quarantined, failed, reconciled;
- collector/realtime last success, failure streak, and completeness watermark;
- health probe success/failure per subsystem;
- Reply Guarantee soft and hard deadline outcomes.

Conversation identity must never be a raw metric label. Use a short hash only in local diagnostic logs when per-conversation correlation is essential.

OpenTelemetry's messaging conventions currently remain Development status, so WhatSoup should borrow the useful low-cardinality concepts—operation duration, attempted sends, processed messages, and predictable `error.type`—without coupling its storage schema to an unstable external naming version.

## 9. Verification Strategy

Aggregate coverage remains useful but is not the delivery gate for this program. Each PR must add semantic proof at the failure seam.

### Required per-PR proof

1. A red test or deterministic probe reproduces the observed defect.
2. The smallest targeted suite passes after the change.
3. Typecheck/lint or equivalent language validation passes.
4. Relevant negative and positive security/guard cases pass.
5. The full pinned release gate passes before the PR is marked ready.

### High-value techniques

- SQLite crash-point and transaction tests for ingest/durability.
- Fake clocks for deadlines, recovery, hourly metrics, and backoff.
- Synthetic canaries for logs, telemetry, URLs, and deletion.
- Stable-id transport fakes for ambiguous timeout behavior.
- State-machine tables/property tests for event reducer convergence.
- Mutation tests for health, authorization, recovery, and fail-closed gates.
- Real browser tests for session expiry, update SSE failure, and failed-draft behavior.

Do not weaken or delete an existing assertion merely because it pins the defect. Replace the unsafe semantic expectation with the new invariant and retain a negative test showing the old outcome is impossible.

## 10. Primary-Source Cross-Checks

- Pino supports configured path redaction, censoring, and removal; central redaction is an available mechanism, but free-form content still requires call-site control: <https://github.com/pinojs/pino/blob/main/docs/api.md#redact-array--object>.
- OWASP recommends removing, masking, sanitizing, hashing, or encrypting access tokens and sensitive PII rather than recording them directly: <https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude>.
- npm documents `npm ci` as the frozen, clean install intended for CI and deployment; it exits on package/lock mismatch and does not rewrite lockfiles: <https://docs.npmjs.com/cli/commands/npm-ci/>.
- The `brace-expansion` advisory affects `>=5.0.0 <5.0.6` and is patched in `5.0.6`: <https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-jxxr-4gwj-5jf2>.
- Node documents recursive `fs.rmdir` as deprecated and removed in newer runtimes in favor of `fs.rm`: <https://nodejs.org/api/fs.html#fsrmdirpath-options-callback>.
- OpenTelemetry messaging metrics recommend operation duration, attempted sent messages, processed messages, and low-cardinality error types, while marking the current conventions Development: <https://opentelemetry.io/docs/specs/semconv/messaging/messaging-metrics/>.

## 11. Non-Goals and Proof Gaps

This audit did not exercise live WhatsApp, Twilio, real transcription/LLM providers, Docker, systemd/launchd, fleet production, or real crash/restart behavior. Those remain required staging or canary checks before deployment claims.

One transcription integration test remained skipped because its external binary/fixture prerequisites were absent. ARC's vendored SHA check passed, but full sibling-protocol content verification was unavailable. The bulk duplicate detector produced a false-positive-heavy 713,932-pair corpus and excessive memory/output; only manually inspected clone candidates were promoted.

## 12. Program Completion Criteria

The remediation program is complete only when:

- all Wave 1 and Wave 2 invariants are implemented and their semantic tests pass;
- live or staging crash/reconnect, queue-drain, and transport-idempotency drills have evidence;
- health and console distinguish failure, unknown, empty, and success;
- routine logs and secondary telemetry pass synthetic privacy canaries;
- closed PR #1717 has either been intentionally abandoned with recorded rationale or reconstructed without losing intended commits;
- architecture convergence occurs only after parity evidence;
- every landed PR has a clean pinned release receipt and explicit residual-risk note.
