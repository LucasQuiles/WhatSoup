# Durable Inbound and Reply Guarantee Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make accepted inbound messages atomically durable and replayable, ensure queue shedding and shutdown have durable lifecycle outcomes, and make a Reply Guarantee turn terminal only after a tracked visible interruption reaches its configured delivery proof.

**Architecture:** WS-A02 first establishes one SQLite transaction for the message record and inbound admission row, with state-aware claims that distinguish safe redelivery from live or delivery-pending work. WS-A03 moves the remaining runtime-queue capacity gates behind durable admission, represents rejected work as `deferred`, and drains it through one bounded replay worker while shutdown stops admission before draining or deferring. WS-A01 then uses a two-stage watchdog: a soft presence signal keeps the inbound open, while the hard interruption travels through `outbound_ops`; the default WhatsApp terminal criterion is the existing echo correlation.

**Tech Stack:** TypeScript ESM, Node.js 24.15.0, npm 11.12.1, `node:sqlite`, Vitest fake timers and fault triggers, Pino, existing `DurabilityEngine`, `Messenger`, and `Runtime` contracts.

## Global Constraints

- Start every implementation branch from the then-current `origin/main` only after a fresh fetch; recheck the next free migration number immediately before implementation and merge.
- Reserve one contiguous migration train in landing order: WS-A02 migration 37, WS-A01 migration 38, WS-A04 migration 39, WS-A05 migration 40, WS-A07 migration 41, and the metrics collection migration 42. If `main` advances or any predecessor changes, update every downstream plan, filename, function, assertion, and operator reference atomically before implementation.
- Local branch and commits only; publishing a branch or Draft PR requires explicit user approval.
- Keep WS-A02, WS-A03, and WS-A01 as three independently reviewable forward PR slices in that dependency order; lower-layer rollback follows the explicit reverse dependency order and they must not be combined into a runtime rewrite.
- Hold production deployment/activation through both the WS-A02 and WS-A03 merges until the exact WS-A01 head is merged and the integrated train is green. WS-A02 can create due deferred work without its consumer, and WS-A03 intentionally lands claim propagation before the complete terminal-delivery migration. The merge receipts must prove the deploy controller was paused (or that these commits cannot deploy independently); release it only after WS-A01/integrated remote CI, backlog health, and replay/terminal smoke receipts. If a verified deployment hold is impossible, do not merge a lower slice alone—use one coordinated, still separately reviewed merge window.
- Typing/presence is soft liveness and never terminal delivery.
- A hard-deadline interruption must use the existing `outbound_ops` journal and must not create a parallel audit store.
- A duplicate delivery may not suppress work when the message exists but its inbound admission is absent or reclaimable.
- Queue shedding must produce a durable lifecycle state and bounded replay; it may not leave a row stranded in `processing`.
- Metrics and logs use low-cardinality reasons only; raw JIDs and message content are never metric labels.
- Preserve the repository engine floor `>=24.0.0 <26` and run every command through `scripts/run-with-pinned-npm.sh` or `scripts/run-with-pinned-node.sh`.
- Before any PR is ready, run the full pinned release command and record all skipped or unavailable live-provider checks as proof gaps.
- Preserve SSH remotes, public commit identity/hygiene, user-owned worktree changes, Google Workspace read-only boundaries, and explicit approval for live-account or other external mutations. Security/privacy, migration collision, access-control drift, data-loss/duplication, masked validation, and prohibited publication content are blockers; stylistic preferences without correctness impact are warnings.
- Do not add a hook, security, scanner, or publication allow-list exception unless the exact false positive, narrow match, non-bypass behavior, and regression test are captured from first-hand evidence and independently reviewed.

## Preimplementation Safety Corrections

Repository tracing and falsification against current main found several unsafe assumptions in the first draft. These constraints override any stale example below:

- Transport redelivery may repair a missing admission or reclaim a due `deferred` admission. It never reclaims `pending`, `processing`, `turn_done`, terminal, or unknown states solely because wall-clock time elapsed; startup recovery, not an elapsed lease, invalidates prior-process pending ownership.
- `deferred` rows have a null processing lease by design. A null lease must not make future-deferred work immediately reclaimable; `replay_after <= now` is required.
- A fixed processing lease is not an ownership proof. Reclaiming live `processing` work requires an ownership token plus heartbeat; WS-A02 intentionally avoids that complexity and leaves abandoned-processing conversion to explicit startup recovery.
- WS-A02 must be independently safe: startup recovery must distinguish new lease-managed rows from legacy rows and must not terminally fail work that the new contract promises to replay.
- Use a write-serializing SQLite transaction boundary and prove two-connection contention. A sequential duplicate test does not prove single-winner admission.
- Preserve control-message and durability-disabled capacity behavior. Move authenticated `isFromMe` echo storage/correlation ahead of the bounded capacity queue so saturation cannot shed the only WhatsApp delivery proof; characterize identity checks and prove a forged/non-self message cannot enter this priority lane.
- Capacity deferral happens only after access and policy evaluation. Replay must not become an access-control bypass.
- Update `ALL_MIGRATION_VERSIONS`, prove migration rollback/reopen/idempotency, and preserve representative legacy lifecycle rows.
- Admission rollback proof includes message storage, the inbound row, decryption-failure resolution, and post-rollback database usability.
- Stage telemetry must cover admitted, repaired, duplicate-rejected, deferred, and processing-claimed outcomes with bounded reason vocabularies and no raw JID or content labels.
- Atomic admission persists the side-effect-free provisional route: normal work uses `routed_to='ingest'`, while recognized admin commands use `routed_to='admin'` so a crash can never replay command text as a model turn. Every terminal policy branch updates the normal route to its branch-specific value, and runtime dispatch updates it through the processing CAS.

## Execution Evidence Contract

This plan file is the working specification. Implementation decisions, corrections, and blocker dispositions must be written here before code changes rely on them. Run commands from the repository root and store review evidence in a scoped ignored directory; its manifest is the command, tool-version, pass, and provenance ledger. Evidence artifacts are local and reproducible, not release deliverables.

Use only `Pass`, `Fail`, `Inconclusive`, or `Blocked` for validation verdicts. A missing command, unavailable tool, masked failure, stale artifact, or unverified external dependency is `Inconclusive` or `Blocked`, never `Pass`. Every readiness or completion claim must name the exact commit, command, expected result, and artifact or CI check that supports it. Sensitive data, JIDs, message content, credentials, and machine-specific private paths must not enter public plan artifacts.

### Objective, Scope, and Exit

- **Objective:** close the observed message-only crash window, make accepted work durably replayable through capacity and shutdown, and make Reply Guarantee completion depend on tracked delivery proof.
- **In scope:** the files and interfaces named in Tasks 1–8, additive SQLite migrations, lifecycle telemetry, focused operator documentation, local/CI gates, and the three independently reviewable forward PR slices.
- **Non-goals:** a general runtime rewrite, live-account drills without separate approval, processing-owner heartbeats, a second outbound journal, duplicate message-content storage, or unbounded replay.
- **Success:** every task-specific red test fails for the intended semantic reason, its green test and owning regression suites pass, Test Integrity finds no masking, the exact branch tip passes `verify:release`, remote CI is green on that SHA, and independent review has no unresolved high-severity finding.
- **Failure:** any split message/admission state, premature or duplicate dispatch, future-deferred reclaim, access-policy bypass, terminal completion without required proof, unbounded queue/retry behavior, migration drift, masked check, or documentation/runtime contradiction.
- **Exit:** the three PRs merge in dependency order with rollback notes and exact-head receipts; staging-only crash/transport drills remain explicitly `Inconclusive` until actually authorized and run.

### Assumption Register

| ID | Assumption and evidence | Risk if false | Validation / disposition |
|---|---|---|---|
| A1 | Migration 37 remains free; current main ends at 36 in `src/core/database.ts`. | Collision or corrupt upgrade train. | Re-fetch and inspect the migration map immediately before branch creation and merge; `Blocked` on collision. |
| A2 | `node:sqlite` WAL plus the configured 5-second busy timeout can serialize `BEGIN IMMEDIATE` writers. | `SQLITE_BUSY` or duplicate owner. | File-backed worker/two-connection contention test; unresolved result is `Blocked`. |
| A3 | Transport redelivery is available but not guaranteed, especially after Twilio's in-memory seen-set update. | Durable deferred work can wait indefinitely before WS-A03. | WS-A02 preserves rather than loses work; WS-A03's bounded replay consumer is required before the train is complete. |
| A4 | Reconstructed replay inputs contain enough metadata for runtime policy and routing. | Mention/group semantics drift or access bypass. | Trace every `IncomingMessage` consumer before WS-A03; extend metadata schema or mark `Blocked`, never infer. |
| A5 | WhatsApp echo is the configured delivery proof for hard interruption sends. | Premature terminal completion. | Real-DB submitted/open then echo/complete integration test; live timing remains `Inconclusive` until staging. |
| A6 | Control and durability-disabled paths retain current capacity ordering; authenticated outbound echoes require a priority correlation lane. | Control-plane bypass or lost delivery proof under saturation. | Characterization plus saturated-queue echo/forged-echo tests; any other ordering change is `Fail`. |

### Primary Validation Gate

Before implementation, capture the current migration/transaction/durability/ingest baseline and a direct reproduction of the message-only split. Before each PR closes, rerun its owning suites, `typecheck:all`, source lint, Test Integrity, branch hygiene, and the full pinned release command. A command passes only on exit 0 with the expected semantic assertion and unmasked output; runner, module-resolution, timeout, filtered-test, or missing-tool failures are `Inconclusive`. Record commands and findings in the scoped evidence root and identify every affected task in `primary_validation.md`.

### Layered Validation

- **Secondary, mandatory per PR:** independent diff/spec review plus fault injection or mutation that targets a different failure class from the primary tests. Store method, evidence, severity, disposition, residual risk, and verdict in `validation_layer2.md`.
- **Tertiary, mandatory for migration, concurrency, shutdown, and delivery-proof claims:** file-backed contention/reopen tests, forced failure boundaries, exact-head full release, and remote CI on the reviewed SHA. Store results in `validation_layer3.md`.
- A required layer that is unavailable or skipped makes the affected claim `Inconclusive` or `Blocked`; repeating the primary test or restating its result is not independent validation.

### Logging and Observability Contract

Emit structured Pino events at admission decision, claim, deferral, replay claim/result, shutdown drain/defer, Reply Guarantee stage change, tracked send submission, echo proof, and permanent failure. Each event includes timestamp, component, event name, bounded state/reason, inbound sequence or outbound operation ID when present, attempt count, and result; it excludes raw JIDs, content, credentials, and unbounded error payloads. Admission/replay counters use the same bounded vocabulary. A state transition without its expected event/counter delta, a success log before transaction commit, or a warning swallowed as normal success is `Fail`. Tests must capture and assert representative structured events and counter deltas; PR receipts link those outputs from the scoped evidence root.

### Readiness Gate

- `Ready` permits implementation only when the branch starts at current `origin/main`, migration/open-PR overlap is rechecked, critical assumptions have deterministic tests, and no unresolved high-severity review finding remains.
- `Ready with Constraints` permits only the named prerequisite or RED-test work; every constraint, owner, evidence path, and next allowed action must appear in `readiness.json`.
- `Not Ready` blocks product edits, push, and merge when scope, migration identity, transaction semantics, access-policy ordering, recovery compatibility, or required evidence is unresolved.

The current planning verdict is `Ready with Constraints`: correct and merge this documentation branch on current main, then create WS-A02 from that main and establish RED tests before implementation. Exact-head release evidence, remote CI, and independent review control the later merge-ready decision.

| Blocker ID | Severity | Evidence | Owner | Exit criterion / failing check |
|---|---|---|---|---|
| B1 | High, closed for the reviewed documentation head | Documentation branch was rebased onto current `origin/main`; this relationship must be rechecked after every subsequent fetch. | Documentation PR owner | `git merge-base --is-ancestor origin/main HEAD` and ahead/behind check pass immediately before push and merge. |
| B2 | High, publication gate | The corrected plan tree has no release authority until exact-head local and remote verification complete. | Documentation PR owner | Commit/push the final plan, exact-head local release passes, and required GitHub checks are green on that SHA. |
| B3 | High, resolved in plan | First draft allowed unbounded replay failure deferral, including a transport-redelivery path around the worker-only cap. | WS-A02/WS-A03 owners | One exported `MAX_INBOUND_ATTEMPTS` is enforced inside both atomic admission and replay claim CAS, capped exponential backoff and terminal exhaustion state/health are present, transport-redelivery-at-ceiling and worker-exhaustion RED tests are load-bearing, and contradiction recheck passes. |
| B4 | High, resolved in plan | First draft reconstructed replay with incomplete trigger metadata and called `runtime.handleMessage` directly, bypassing current pause/passive/access policy. | WS-A02/WS-A03 owners | Migration 37 preserves content-free trigger metadata, initial and replay dispatch share one admitted-message policy seam, revoked/paused-before-replay tests prove no runtime call, and policy rejection terminalizes the row without repeating approval/admin side effects. |
| B5 | High, resolved in plan | A deferred row with null `replay_after` was visible but stranded forever. | WS-A03 owner | Invalid replay metadata is atomically terminalized with a bounded failure class/event, the active-invalid gauge returns to zero, a cumulative terminal counter remains visible, and an operator repair/requeue command is documented and tested. |
| B6 | High, resolved in plan | Admin/API access-grant replay and synthetic Agent jobs called `runtime.handleMessage` directly; queue rejection was erased by `Promise<void>`, allowing success-shaped loss outside the admitted dispatcher. | WS-A03 owner | Runtime returns bounded queue rejection, the dispatcher alone persists normal/replay deferral, access-grant replay is atomically queued for the worker (including legacy rows), synthetic jobs surface rejection to their scheduler, and caller-inventory plus mutation tests prove no production caller erases the result. |

Medium findings are not silently accepted: the PR receipt lists each one as closed, accepted with owner/rationale/future artifact, or `Blocked`. File/function/line evidence is required for closure and line references are refreshed after rebasing.

### Atomic Task Rule

Treat each numbered step below as one evidence-producing unit. Before execution, record its parent task, preconditions, inputs, owner/write scope, expected output, dependency, and blocking conditions. After execution, record the exact validation, observable signal, pass/fail threshold, artifact, failure mode, retry path, and rollback path. Split any step that produces unrelated outputs or can partially succeed without detection. Implementation and verification remain separate actions even when they are grouped under one commit boundary.

### Verification Matrix Rule

Maintain one row per task or state transition in `verification_matrix.md`: exact check, rationale, operator, expected output, artifact, `Pass`/`Fail`/`Inconclusive` thresholds, and escalation. Prefer state inspection, schema/diff checks, negative controls, checksums, and independent reproduction. “Looks correct,” absence of an exception, filtered tests, or a test with no threshold cannot satisfy a row.

Fast blocking gates are `git diff --check`, focused Vitest with the pinned wrapper, `typecheck:all`, `guard:lint:src`, repo branch/author/message hygiene, source/runtime drift guards, migration safety, and Test Integrity. Warnings are blockers when the owning command defines them as errors; otherwise record and disposition them. `verify:release` and remote Quality/CodeQL are final gates, not substitutes for the fast loop.

Capture characterization tests before moving capacity or recovery seams. Protected behavior includes control and outbound-echo interception, durability-disabled ingest, policy/admin/pause outcomes, history-placeholder upgrades, decryption-failure resolution, terminal outbound reconciliation, queue fairness, and current shutdown error visibility. Run owning suites after every commit; any unexpected baseline drift stops the PR. Roll back the smallest commit/PR when a protected behavior changes without an approved requirement and new proof.

Local commit hooks enforce message/author/publication hygiene; pre-push must run the branch-diff guard and the fixed WS-A02 owning suite list added by Task 3. GitHub Quality runs full coverage on Node 24 and 25, the dedicated macOS health canary, Test Integrity/static guards, console/browser lanes, and CodeQL. No `--no-verify`, retry, `continue-on-error`, or branch-protection override may turn red into green; any authorized exceptional bypass must be explicit in the PR and independently reviewed.

### Test Evidence and Anti-Fabrication

Every test family records whether inputs are synthetic, captured, sampled, or production-derived; how expected results were derived; why fixtures are representative; and how to replay the command. Required categories are unit, file-backed integration, migration/upgrade, negative/fault-injection, regression, observability, adversarial concurrency, stale/deferred timing, partial-data, degraded-mode, and focused runtime wiring. A real RED phase must fail the intended semantic assertion before implementation. Preserve unabridged outputs under `test_evidence/`; record filtered, skipped, unavailable, or live-provider checks explicitly. Test Integrity, independent review, hostile-environment reruns, and mutation/removal of key integration calls guard against false positives. Only the four verdicts in this plan are allowed.

A flake or “not reproduced” claim requires at least 20 focused repetitions under the triggering load class, with runtime, seed, inherited environment, concurrency, and per-run result recorded. One clean rerun or a retry-masked pass is `Inconclusive`.

Implementation code may begin only after the owning RED test has been observed failing for the intended behavior, not from module resolution, syntax, timeout, or fixture failure. Make the smallest GREEN change, rerun the focused test, then the owning regression set. Mutation/counterexample checks must prove the new assertion is load-bearing before full release verification.

### Fresh-Operator Handoff

A fresh operator starts by reading this plan, the audit PR brief, `readiness.json`, `verification_matrix.md`, and the current evidence manifest; then fetches `origin`, verifies a clean worktree/SSH remote/current main, rechecks open-PR and migration overlap, and executes only the next dependency-ready task. The handoff includes objective, non-goals, assumptions, validation findings, task map, observability/test rules, blockers, rollback, residual risks, and exact commands. Reproduce this review with Node 24/25, the pinned npm wrapper, Python 3.12, ripgrep, GitHub CLI, and the recorded review-helper commands. SBOM/signing changes are outside these three runtime PRs; CodeQL, commit/branch hygiene, Test Integrity, and exact-head CI remain mandatory.

Artifact map: the wall-to-wall design under `docs/superpowers/specs/` is the source requirement; the audit PR brief under `docs/superpowers/reviews/` owns sequencing and review receipts; this file is the executable WS-A02/WS-A03/WS-A01 plan and embeds kickoff/orchestration/handoff instructions; the scoped ignored evidence directory is reproducible local proof, not a public deliverable; implementation code/tests/docs and PR receipts are created on their named branches. No separate playbook or kickoff document is required.

Documentation must rewrite, not append past, any now-false durability/recovery/Reply Guarantee wording. Configuration docs record migration and bounded tuning; durability docs record state transitions, recovery, replay, poison/quarantine, and operator inspection; Reply Guarantee docs distinguish presence, submission, echo proof, and failure. PR descriptions include rollback/partial-deploy notes, metrics/log events, CI changes, staging drills, and explicit gaps. No new dashboard is required unless the existing health/status surface cannot expose replay backlog, oldest due age, deferrals, recovery, and proof state; that determination is verified during WS-A03.

### Orchestration Sequence

Complete planning evidence and contradiction review first. Execute Tasks 1–3, then run Task 9 Steps 0–4 at that exact WS-A02 head before merge. Execute Tasks 4–6, then repeat Task 9 Steps 0–4 at that exact WS-A03 head before merge. Execute Tasks 7–8, then repeat Task 9 Steps 0–4 at that exact WS-A01 head before merge. Only after all three reviewed boundaries are merged does the integration owner run Task 9 Steps 5–7 against a fresh exact `origin/main`. Within each PR use RED → minimal GREEN → focused regression → static/Test Integrity gates → full release → independent review → push/remote CI → merge. A failed or inconclusive dependency blocks downstream write work; it does not get averaged with green evidence.

Use isolated git worktrees and one implementation owner per PR. Parallel agents are read-only reviewers unless assigned disjoint files; each dispatch names one bounded question, exact file set, command/time budget, required artifact path, and stop condition. They return file/line evidence and never rely on inherited summaries. Appropriate skills are hypothesis-driven, brainstorming for behavior choices, TDD, database patterns, systematic debugging, Test Integrity, verification-before-completion, WhatSoup PR review, and GitHub CI/PR workflows. Local git/rg/pinned Node/npm/SQLite/Vitest/Pino and GitHub Actions are authoritative; external research or Pinecone is supplemental and cannot override current code. The synthesis owner rechecks every high-risk claim and resolves contradictions rather than averaging them.

Historical context sources are current git history/blame, merged PR diffs/checks, the audit evidence packet, and optional Pinecone code/docs retrieval. Record the query/ref/SHA and verify every reused conclusion against current source. Playwright is relevant only if a dashboard surface changes; Render and live WhatsApp are staging/operations surfaces requiring separate need and authority; Google Workspace remains read-only and irrelevant to implementation.

### Reuse-First Boundary

Reuse `withTransaction` semantics via one immediate-mode variant, `storeMessageIfNew`, existing migration idempotency patterns, prepared statements in `DurabilityEngine`, `IncomingMessage.inboundSeq`, `acquireSlot`'s per-caller result, `drainIngest`, `outbound_ops`, runtime queue contracts, and Pino. New modules are permitted only for the single atomic admission boundary, the bounded replay worker, and Task 8's admitted-turn coordinator. The coordinator is the one rejected-reuse exception because no current module owns process-wide dispatcher-to-queue lease transfer, exact terminal-owner permits, and shutdown waiter handoff without creating a dependency cycle between `DurabilityEngine` and the runtimes. Record that decision and every other rejected reuse candidate in `reuse_audit.md`; do not create parallel journals, transaction wrappers, lifecycle vocabularies, or logging abstractions.

### Blast Radius and Rollback

Direct consumers are WhatsApp and Twilio ingress, access/admin/pause policy branches, `messages`/`inbound_events`/`outbound_ops`, agent/chat queues, shutdown wiring, recovery, Reply Guarantee, health/status telemetry, migration fixtures, docs, local pre-push, and Quality CI. Trust boundaries include untrusted inbound payloads, JID identity resolution, admin/control peers, SQLite files, subprocess/runtime providers, and transport acknowledgements. Partial deployment is unsafe across schema/code rollback if new rows enter states old code cannot consume: use additive columns, keep old readers tolerant, merge in dependency order, and rollback product code only after confirming no `pending`, `deferred`, or leased `processing` rows require the removed lifecycle. Any migration collision, access-policy drift, duplicate dispatch, or unbounded replay blocks rollout; containment is stop admission, retain the DB, disable replay, and revert through the reverse dependency order below. The PRs are independently reviewable forward slices, not independently revertible lower layers.

Before reverting WS-A03 or WS-A02, stop ingress and capture this exact read-only receipt:

```sql
SELECT COUNT(*) AS incompatible_rows
FROM (
  SELECT 'inbound' AS kind, seq AS id
  FROM inbound_events
  WHERE processing_status IN ('pending', 'processing', 'turn_done', 'deferred')
  UNION ALL
  SELECT 'outbound' AS kind, id
  FROM outbound_ops
  WHERE source_inbound_seq IS NOT NULL
    AND status IN ('pending', 'sending', 'submitted', 'maybe_sent', 'quarantined')
);
```

The detailed companion receipt selects each matching outbound op with its
sequence/route/attempt provenance and each inbound status/route/attempt; raw
message/JID/payload fields are excluded. `incompatible_rows = 0` is necessary
but not sufficient: a non-zero result blocks removal until every row is drained,
deliberately terminalized/migrated, or retained with a compatible consumer,
while a zero result does not make newer callers compile against removed APIs.
WS-A01 functionality may be removed by itself, but not by a raw merge revert:
its forward rollback patch must retain migration 38, schema-version recognition,
the six-column/index readers, compatibility health checks, migration fixtures,
and operator documentation while disabling the new runtime owners. The same
rule applies to migration 37 when removing WS-A02: retain migration 37 and the
minimum tolerant readers even after its producer/consumer paths are disabled.
To remove WS-A03, first land and verify the WS-A01 forward rollback, then its
WS-A03 counterpart. To remove WS-A02, land and verify forward rollback patches
for WS-A01, WS-A03, then WS-A02; run the exact combined focused matrices and
`verify:release` after every dependency-removal boundary. Each receipt records
the database identity/checksum, query, UTC time, result, rollback owner, ordered
merge SHAs, the initially generated `git revert <merge-sha>` diff used only as
an inventory, and the reviewed compatibility edits layered on that diff. Create
each rollback on a fresh branch from current `origin/main`, publish through the
normal reviewed PR path, and do not proceed to the next lower-layer rollback
until the current exact head is green and opens a real copied v38 database. Do
not reverse migrations 37 or 38 or delete their columns during an emergency
product-code rollback; both additive schemas and their readers are retained so
recovery and accounting evidence is not destroyed.

### Error Model

Validation/tool failure is `Inconclusive` unless it proves a semantic defect. SQLite busy/constraint/commit failure rolls back atomically, emits a bounded stage/class event without the raw error object, and never dispatches. Admission/capacity rejection becomes a durable `deferred` outcome only after policy passes. Replay claims and transport redelivery share one durable attempt ceiling and capped exponential backoff. Exhausted work becomes terminal `failed/crash_recovery`; malformed payload/trigger metadata or null replay time becomes terminal `failed/stale_reclaim`; neither can loop or remain stranded. Replay revalidates current pause/passive/access policy through the same admitted-message dispatch seam as initial delivery and never repeats admin or approval side effects. Runtime failure records a bounded failure class; ambiguous outbound submission uses existing `maybe_sent`/quarantine semantics. Orderly shutdown stops new admission and claim-guard defers any owner that reaches its bounded drain deadline before database close. If the single process hard deadline is reached, unresolved owners remain durably open; no impossible final write is claimed after forced exit, and only the next startup's guarded recovery may reclaim them. A journal write failure prevents the corresponding transport send. Rollback failure, corrupt/read-only/full DB, invalid migration, access-policy ambiguity, and unbounded retry are operator-visible blockers rather than fallbacks.

### Silent-Failure Rejection

Tests and telemetry must make these false-green states impossible: message committed without admission; deferred row reclaimed early; live pending/processing work duplicated after wall-clock expiry; queue eviction without a lifecycle row; policy/approval side effect before admission evidence; replay claim without dispatch/outcome; transport send without outbound journal; submission treated as echo; shutdown returning before drain/defer/close; caught exception without state/log/counter; filtered/skipped test reported as green. Each has a negative assertion and an operator-visible event or state query in `silent_failure_matrix.md`. Any success path lacking its durable evidence is `Fail`.

### Error Traceability

Operator errors name the failed stage and bounded reason, include `inboundSeq`/`outboundOpId`/recovery-run ID when available, distinguish retryable/deferred/quarantined/terminal outcomes, and suggest a safe next inspection. User-facing text remains generic and content-free. Never log raw JIDs, message bodies, credentials, SQL payloads, stack traces containing private paths, or interpolated untrusted input. Tests assert redaction and stable event/message shapes. The error catalog maps each class to its event, durable state, counter, and remediation; vague catches or IDs that cannot be joined to state are `Fail`.

| Failure stage | Classification | Durable outcome | Bounded event/counter | Operator action |
|---|---|---|---|---|
| Admission busy/locked | transient until bounded same-message retries exhaust | transaction rollback; no dispatch; then unhealthy ingress latch | `inbound_admission_retry` then `inbound_admission_blocked{db_error,retryable}` | inspect DB health; restore, canary, and restart |
| Admission constraint/invariant | rejected defect or stale schema | transaction rollback; no dispatch; unhealthy ingress latch | `inbound_admission_blocked{db_error,rejected}` | inspect migration/input invariant; do not blind retry |
| Admission read-only/full/corrupt | permanent storage blocker | transaction rollback; no partial pair; unhealthy ingress latch | `inbound_admission_blocked{db_error}` | keep ingress stopped, restore writable capacity/integrity, run canary, restart |
| Echo correlation storage/invariant failure | delivery-proof blocker | self echo remains stored; unhealthy ingress latch prevents false green | `inbound_echo_correlation_blocked{stage}` | inspect outbound/message state; restore DB, canary, and restart |
| Queue capacity/shutdown | retryable | `deferred` with due time | `inbound_deferred{reason}` | inspect backlog/oldest due age |
| Replay runtime failure below cap | retryable | `deferred/crash_recovery` with capped backoff | `inbound_replay_retry{class}` | inspect runtime/provider health |
| Replay/transport attempt ceiling | permanent | `failed/crash_recovery` | `inbound_replay_exhausted` and health counter | inspect source class; deliberate repair only |
| Missing/malformed replay metadata | policy/integrity blocker | `failed/stale_reclaim` | `inbound_replay_invalid` and health counter | dry-run repair tool after backup |
| Post-admission pipeline or replay-worker invariant | ownership/integrity blocker | exact claim remains open for restart recovery; no further ingress | `inbound_admitted_pipeline_blocked` or `inbound_replay_worker_blocked` plus persistent health latch | stop ingress, inspect bounded stage/current row, repair storage/code, restart for guarded recovery |
| Current pause/passive/generic trigger denial | policy terminal | `complete` with branch skip reason | `inbound_policy_rejected_after_admission{reason}` | inspect current policy; no automatic replay |
| Access denied, then atomically allowed | policy reactivation | `complete/access_denied -> deferred/access_granted` in the same transaction as ALLOW | `inbound_deferred{access_granted}` and durability deferral counter | replay worker rechecks current policy; inspect bounded queued count |
| Outbound journal failure | retryable to bounded sender cap, then guarded terminal failure transition | inbound remains open; no send until `failed/db_error` wins | `reply_guarantee_journal_retry`, `reply_guarantee_journal_exhausted`, `reply_guarantee_failed` | restore DB; transition-only retries never resend past cap |
| Submitted without echo | ambiguous delivery | `outbound_ops=submitted`; inbound open | `reply_guarantee_hard_submitted` plus existing pending/quarantine health | reconcile echo; never blind resend |

Every row has a state, event-shape, counter-delta, and remediation assertion. Tests inject one transient and one permanent case per changed stage; an event without the matching state, or state without the matching bounded event/counter, is `Fail`.

| Transition owner | Stable `event` field | Monotonic counter owner/key | Durable gauge/state |
|---|---|---|---|
| Ingest admission / echo priority | `inbound_admitted`, `inbound_admission_repaired`, `inbound_duplicate_rejected`, `inbound_transport_exhausted`, `inbound_admission_retry`, `inbound_admission_blocked`, `inbound_echo_correlation_blocked` | `getIngestStats()`: `admitted`, `repaired`, `duplicateRejected`, `transportAttemptExhausted`; blocked latch is a health state, not a success counter | admission row/status/attempt count plus stage-aware ingress health latch |
| Admitted policy seam / ownership fence | `inbound_policy_rejected_after_admission`, `inbound_processing_claimed`, `inbound_runtime_failed`, `inbound_stale_claim` | `getIngestStats()`: `policyRejectedAfterAdmission`, `processingClaimed`, `runtimeFailed`; `DurabilityEngine.getHealthStats().staleClaimConflicts` | route + terminal/open status + immutable `{seq,status,route,attemptCount}` claim |
| Durability deferral / outbound ownership | `inbound_deferred`, `inbound_deferral_already_terminal`, `inbound_deferral_failed`, `inbound_delivery_pending` | `DurabilityEngine.getHealthStats()`: process-lifetime `deferralsByReason` bounded map and `deferralFailures`; delivery-pending is not a deferral counter | deferred backlog/oldest due age or linked terminal outbound state |
| Startup recovery | `inbound_startup_pending_recovered`, `inbound_startup_processing_recovered`, `inbound_startup_admin_interrupted`, `inbound_startup_legacy_terminal`, `inbound_startup_delivery_pending`, `inbound_startup_echo_reconciled`, `inbound_terminal_failure_reconciled`, `inbound_startup_recovery_failed` | returned `RecoveryStats` fields plus explicit failure/delivery-pending events | recovered row or linked outbound state |
| Replay worker | `inbound_replay_claimed`, `inbound_replay_dispatched`, `inbound_replay_retry`, `inbound_replay_exhausted`, `inbound_replay_invalid`, `inbound_replay_admin_interrupted`, `inbound_replay_policy_skipped`, `inbound_replay_overlap_suppressed`, `inbound_replay_worker_blocked` | `InboundReplayWorker.getStats()` with the same success keys; blocker is a persistent health state | deferred/invalid/exhausted/interrupted-admin gauges plus retained worker failure |
| Outbound echo proof | `outbound_echo_matched` | `DurabilityEngine.getHealthStats().echoMatches` | exact `outbound_ops=echoed` plus linked inbound outcome |
| Reply Guarantee | `reply_guarantee_soft_sent`, `reply_guarantee_soft_unsupported`, `reply_guarantee_soft_failed`, `reply_guarantee_hard_inflight`, `reply_guarantee_hard_submitted`, `reply_guarantee_hard_echoed`, `reply_guarantee_inbound_closed`, `reply_guarantee_awaiting_reconciliation`, `reply_guarantee_ownership_present`, `reply_guarantee_journal_retry`, `reply_guarantee_journal_exhausted`, `reply_guarantee_rate_limited`, `reply_guarantee_timer_failed`, `reply_guarantee_failed` | `ReplyGuaranteeManager.getStats()` including `inFlightSuppressed` and live `hardInFlight`, plus outbound/inbound health | `outbound_ops` + inbound open/terminal state |
| Provider usage accounting / cancellation / budget rebuild | `provider_usage_inserted`, `provider_usage_advanced`, `provider_usage_duplicate`, `provider_usage_cancelled`, `provider_usage_stale_claim`, `provider_usage_invariant`, `provider_attempt_cancelled`, `provider_attempt_cancel_failed`, `provider_budget_rebuild_failed`, `provider_budget_rebuild_recovered` | `DurabilityEngine.getHealthStats().providerUsageInvariants` plus `ProviderBudget.getHealthStats()` cancellation/rebuild-failure/recovery counters; duplicates, cancelled callbacks, and stale claims are not usage counters | exact `agent_token_events` claim/result row and cancellation tombstone, persisted session aggregate, provider-attempt barrier, and a readiness-blocking budget-rebuild latch |

Use these existing owners rather than a new telemetry abstraction. Counters increment only after the named state or transport action succeeds; `already_terminal` is not a deferral. Each owning test installs the repository's test log sink, asserts the stable `event`, bounded keys, exact counter delta, matching DB state, and absence of fixture JID/message/error text. Mutating either the state write, event field, or counter increment must fail. Task 9 captures one representative event/state/counter receipt per row.

Provider-accounting logs contain only bounded stage/outcome/count deltas and a
non-secret correlation surrogate where needed; they never emit raw
`providerAttemptId`, JID, provider session ID, message content, or SQL values.
Inserted, advanced, duplicate, cancelled callback, proven/failed cancellation,
stale-claim, invariant, rebuild-failure, and rebuild-recovery tests each assert
the matching ledger/session state, latch or
counter transition, and remediation path. A rebuild failure keeps readiness
false and provider admission closed until a successful DB-authoritative rebuild
emits `provider_budget_rebuild_recovered`; it is never treated as an empty
budget.

Queue mechanics (`chat_queue_*`, `agent_queue_rejected`,
`chat_runtime_shutdown_complete`) and `access_policy_decision` remain their
own existing operational-log surfaces; they are asserted for bounded payload
and ordering but do not claim lifecycle counters in this table.

---

## File Structure

The `**Files:**`, `**Interfaces:**`, focused matrix, and stage/commit list inside
each task are the authoritative change inventory. Do not maintain a second
summary list here: the dependency slices overlap deliberately and a duplicated
inventory can become stale while the task contracts remain current. Task 9
derives each PR blast radius from those owning task lists plus the actual
`origin/main...HEAD` diff and fails if either side omits a changed surface.

---

### Task 1: Add the replayable-inbound schema (WS-A02, commit 1)

**Files:**
- Modify: `src/core/database.ts:556-737, 884-902`
- Create: `tests/core/migration-37-inbound-replay.test.ts`
- Modify: `tests/core/database.test.ts`
- Modify: `tests/core/durability-schema.test.ts`
- Modify: `tests/core/migration-safety.test.ts` (`ALL_MIGRATION_VERSIONS`, named-wiring, rollback, and reopen coverage)
- Modify: `docs/configuration.md:1430-1470`

**Interfaces:**
- Consumes: `Database.open(): void` and the existing `MIGRATIONS: Map<number, MigrationFn>`.
- Produces: migration 37 columns `inbound_events.lease_until: INTEGER | NULL`, `replay_after: INTEGER | NULL`, `attempt_count: INTEGER NOT NULL DEFAULT 0`, `deferred_reason: TEXT | NULL`, `mentioned_jids_json: TEXT | NULL`, and `is_response_worthy: INTEGER | NULL`; `outbound_ops.source_inbound_route: TEXT | NULL` and `source_inbound_attempt: INTEGER | NULL`; plus `idx_inbound_events_replay(processing_status, replay_after, seq)` and the partial unique `idx_outbound_ops_terminal_claim(source_inbound_seq, source_inbound_route, source_inbound_attempt)` for non-null terminal provenance. The nullable trigger and outbound-provenance fields intentionally distinguish legacy rows whose replay policy or exact owning attempt cannot be reconstructed; they fail closed rather than inherit permissive defaults. A column CHECK makes route/attempt null together or a valid positive claim tuple. The existing `idx_outbound_ops_source(source_inbound_seq)` remains the general lookup index; the partial unique index excludes legacy-null rows, so it preserves upgrades while enforcing one modern terminal owner.

- [ ] **Step 1: Write the failing schema and legacy-upgrade tests**

Create `tests/core/migration-37-inbound-replay.test.ts` with this complete content:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

const paths: string[] = [];

function tmpDb(): string {
  const path = join(tmpdir(), `whatsoup-m37-${randomUUID()}.db`);
  paths.push(path);
  return path;
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(path + suffix)) rmSync(path + suffix, { force: true });
    }
  }
});

describe('migration 37 — replayable inbound lifecycle', () => {
  it('creates the lease/defer columns and bounded replay index', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(CURRENT_SCHEMA_MIGRATION).toBe(37);
      const columns = db.raw.prepare("PRAGMA table_info('inbound_events')").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = new Map(columns.map((column) => [column.name, column]));
      expect(byName.get('lease_until')).toMatchObject({ type: 'INTEGER', notnull: 0 });
      expect(byName.get('replay_after')).toMatchObject({ type: 'INTEGER', notnull: 0 });
      expect(byName.get('attempt_count')).toMatchObject({
        type: 'INTEGER',
        notnull: 1,
        dflt_value: '0',
      });
      expect(byName.get('deferred_reason')).toMatchObject({ type: 'TEXT', notnull: 0 });
      expect(byName.get('mentioned_jids_json')).toMatchObject({ type: 'TEXT', notnull: 0 });
      expect(byName.get('is_response_worthy')).toMatchObject({ type: 'INTEGER', notnull: 0 });

      const outboundColumns = db.raw.prepare("PRAGMA table_info('outbound_ops')").all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;
      const outboundByName = new Map(outboundColumns.map((column) => [column.name, column]));
      expect(outboundByName.get('source_inbound_route')).toMatchObject({
        type: 'TEXT', notnull: 0,
      });
      expect(outboundByName.get('source_inbound_attempt')).toMatchObject({
        type: 'INTEGER', notnull: 0,
      });

      const index = db.raw.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_inbound_events_replay'",
      ).get() as { sql: string };
      expect(index.sql).toContain('processing_status, replay_after, seq');
      const terminalIndex = db.raw.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_outbound_ops_terminal_claim'",
      ).get() as { sql: string };
      expect(terminalIndex.sql).toContain(
        'source_inbound_seq, source_inbound_route, source_inbound_attempt',
      );
      expect(terminalIndex.sql).toContain('WHERE is_terminal = 1');
    } finally {
      db.close();
    }
  });

  it('upgrades a version-36 database without changing existing inbound outcomes', () => {
    const path = tmpDb();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE inbound_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        conversation_key TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        routed_to TEXT,
        processing_status TEXT NOT NULL DEFAULT 'pending',
        completed_at TEXT,
        terminal_reason TEXT,
        continuity_candidate_reason TEXT,
        continuity_candidate_source TEXT,
        continuity_candidate_marked_at TEXT,
        failure_class TEXT
      );
      CREATE TABLE outbound_ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        op_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        submitted_at TEXT,
        echoed_at TEXT,
        wa_message_id TEXT,
        error TEXT,
        source_inbound_seq INTEGER,
        retry_count INTEGER DEFAULT 0,
        is_terminal INTEGER DEFAULT 0,
        replay_policy TEXT NOT NULL DEFAULT 'unsafe'
      );
      CREATE INDEX idx_outbound_ops_status ON outbound_ops(status);
      CREATE INDEX idx_outbound_ops_source ON outbound_ops(source_inbound_seq);
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, routed_to,
        processing_status, completed_at, terminal_reason
      ) VALUES
        ('legacy-pending', 'legacy-key', 'legacy@s.whatsapp.net', 'ingest',
         'pending', NULL, NULL),
        ('legacy-processing', 'legacy-key', 'legacy@s.whatsapp.net', 'agent',
         'processing', NULL, NULL),
        ('legacy-turn-done', 'legacy-key', 'legacy@s.whatsapp.net', 'agent',
         'turn_done', NULL, NULL),
        ('legacy-complete', 'legacy-key', 'legacy@s.whatsapp.net', 'agent',
         'complete', datetime('now'), 'response_sent'),
        ('legacy-failed', 'legacy-key', 'legacy@s.whatsapp.net', 'agent',
         'failed', datetime('now'), 'error');
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, payload_hash, status,
        submitted_at, echoed_at, wa_message_id, error,
        source_inbound_seq, retry_count, is_terminal, replay_policy
      ) VALUES
        ('legacy-key', 'legacy@s.whatsapp.net', 'text', 'terminal marker', 'h1',
         'echoed', datetime('now'), datetime('now'), 'wa-1', NULL, 4, 1, 1, 'unsafe'),
        ('legacy-key', 'legacy@s.whatsapp.net', 'progress', 'progress marker', 'h2',
         'submitted', datetime('now'), NULL, 'wa-2', NULL, 2, 2, 0, 'safe'),
        ('proactive-key', 'proactive@s.whatsapp.net', 'text', 'proactive marker', 'h3',
         'pending', NULL, NULL, NULL, NULL, NULL, 0, 0, 'read_only');
      INSERT INTO schema_migrations(version)
      VALUES ${Array.from({ length: 36 }, (_, index) => `(${index + 1})`).join(',')};
    `);
    raw.close();

    const migrated = new Database(path);
    migrated.open();
    try {
      const rows = migrated.raw.prepare(`
        SELECT processing_status, terminal_reason, attempt_count,
               lease_until, replay_after, deferred_reason,
               mentioned_jids_json, is_response_worthy
        FROM inbound_events ORDER BY seq
      `).all() as Array<{
        processing_status: string;
        terminal_reason: string | null;
        attempt_count: number;
        lease_until: number | null;
        replay_after: number | null;
        deferred_reason: string | null;
        mentioned_jids_json: string | null;
        is_response_worthy: number | null;
      }>;
      expect(rows.map((row) => ({
        processing_status: row.processing_status,
        terminal_reason: row.terminal_reason,
      }))).toEqual([
        { processing_status: 'pending', terminal_reason: null },
        { processing_status: 'processing', terminal_reason: null },
        { processing_status: 'turn_done', terminal_reason: null },
        { processing_status: 'complete', terminal_reason: 'response_sent' },
        { processing_status: 'failed', terminal_reason: 'error' },
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          attempt_count: 0,
          lease_until: null,
          replay_after: null,
          deferred_reason: null,
          mentioned_jids_json: null,
          is_response_worthy: null,
        });
      }
      expect(migrated.raw.prepare(`
        SELECT payload_hash, status, wa_message_id, source_inbound_seq,
               retry_count, is_terminal, replay_policy,
               source_inbound_route, source_inbound_attempt
        FROM outbound_ops ORDER BY id
      `).all()).toEqual([
        {
          payload_hash: 'h1', status: 'echoed', wa_message_id: 'wa-1',
          source_inbound_seq: 4, retry_count: 1, is_terminal: 1,
          replay_policy: 'unsafe', source_inbound_route: null,
          source_inbound_attempt: null,
        },
        {
          payload_hash: 'h2', status: 'submitted', wa_message_id: 'wa-2',
          source_inbound_seq: 2, retry_count: 2, is_terminal: 0,
          replay_policy: 'safe', source_inbound_route: null,
          source_inbound_attempt: null,
        },
        {
          payload_hash: 'h3', status: 'pending', wa_message_id: null,
          source_inbound_seq: null, retry_count: 0, is_terminal: 0,
          replay_policy: 'read_only', source_inbound_route: null,
          source_inbound_attempt: null,
        },
      ]);
      expect(
        migrated.raw.prepare('SELECT version FROM schema_migrations WHERE version = 37').get(),
      ).toEqual({ version: 37 });
    } finally {
      migrated.close();
    }
  });
});
```

- [ ] **Step 2: Run the migration test and verify the semantic failure**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/migration-37-inbound-replay.test.ts --pool=forks
```

Expected: FAIL because `CURRENT_SCHEMA_MIGRATION` is `36` and the eight migration-37 columns across the two tables are absent. A module-resolution or test-runner failure is inconclusive and must be fixed before continuing.

- [ ] **Step 3: Implement migration 37**

Add this function after `runMigration36` in `src/core/database.ts`:

```ts
function runMigration37(db: DatabaseSync): void {
  const inboundTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'")
    .get() as { name: string } | undefined;
  const outboundTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outbound_ops'")
    .get() as { name: string } | undefined;
  if (!inboundTable || !outboundTable) {
    throw new Error('migration 37 requires inbound_events and outbound_ops');
  }

  {
    const columns = db
      .prepare("PRAGMA table_info('inbound_events')")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    if (!names.has('lease_until')) {
      db.exec('ALTER TABLE inbound_events ADD COLUMN lease_until INTEGER');
    }
    if (!names.has('replay_after')) {
      db.exec('ALTER TABLE inbound_events ADD COLUMN replay_after INTEGER');
    }
    if (!names.has('attempt_count')) {
      db.exec('ALTER TABLE inbound_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!names.has('deferred_reason')) {
      db.exec('ALTER TABLE inbound_events ADD COLUMN deferred_reason TEXT');
    }
    if (!names.has('mentioned_jids_json')) {
      db.exec('ALTER TABLE inbound_events ADD COLUMN mentioned_jids_json TEXT');
    }
    if (!names.has('is_response_worthy')) {
      db.exec('ALTER TABLE inbound_events ADD COLUMN is_response_worthy INTEGER');
    }
  }

  {
    const columns = db
      .prepare("PRAGMA table_info('outbound_ops')")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('source_inbound_route')) {
      db.exec('ALTER TABLE outbound_ops ADD COLUMN source_inbound_route TEXT');
    }
    if (!names.has('source_inbound_attempt')) {
      db.exec(`
        ALTER TABLE outbound_ops ADD COLUMN source_inbound_attempt INTEGER
        CHECK (
          (source_inbound_route IS NULL AND source_inbound_attempt IS NULL)
          OR (
            typeof(source_inbound_seq) = 'integer' AND source_inbound_seq > 0
            AND typeof(source_inbound_route) = 'text'
            AND length(trim(source_inbound_route)) > 0
            AND typeof(source_inbound_attempt) = 'integer'
            AND source_inbound_attempt BETWEEN 1 AND 9007199254740991
          )
        )
      `);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inbound_events_replay
      ON inbound_events(processing_status, replay_after, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_ops_terminal_claim
      ON outbound_ops(
        source_inbound_seq, source_inbound_route, source_inbound_attempt
      )
      WHERE is_terminal = 1
        AND source_inbound_seq IS NOT NULL
        AND source_inbound_route IS NOT NULL
        AND source_inbound_attempt IS NOT NULL
  `);
}
```

Add this exact map entry after migration 36:

```ts
  [36, runMigration36],
  [37, runMigration37],
```

Advance `ALL_MIGRATION_VERSIONS` and every migration-count/current-tip assertion to 37. Add a migration-37 named-function assertion, a second-open idempotency test, and a fault-injected upgrade test proving the migration transaction rolls back without recording version 37. The preserved-row fixture must include representative `pending`, `processing`, `turn_done`, `complete`, and `failed` outcomes.
Add missing-table fixtures for each core table: migration 37 must throw and must
not record version 37 rather than silently blessing a structurally incomplete
database. Fault after the inbound ALTERs but before/during the outbound ALTERs
and index creation; reopening the raw v36 file must show none of the eight
columns or the index because the outer migration transaction rolled back.
In `tests/core/durability-schema.test.ts`, prove the provenance pair CHECK,
partial uniqueness (duplicate modern terminal rejected; duplicate legacy-null
rows preserved), forced idempotent rerun after deleting only migration 37's
record, claimless/proactive null defaults, and preservation of every existing
outbound column/value. Do not add a foreign key: retention currently permits an
inbound row to age out before its outbound evidence.

Add this exact row to the schema-migration table in `docs/configuration.md`:

```markdown
| 37 | Adds inbound admission leases (`lease_until`, `attempt_count`), durable deferral (`replay_after`, `deferred_reason`), content-free replay trigger metadata (`mentioned_jids_json`, `is_response_worthy`), exact outbound-attempt provenance (`outbound_ops.source_inbound_route`, `source_inbound_attempt`) with a pair CHECK and partial unique terminal-claim index, and `idx_inbound_events_replay`; no message content is duplicated, and legacy null metadata/provenance fails closed. |
```

- [ ] **Step 4: Run the focused schema and migration safety suites**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/migration-37-inbound-replay.test.ts tests/core/durability-schema.test.ts tests/core/migration-safety.test.ts tests/core/database.test.ts --pool=forks
```

Expected: PASS with all four files green and migration 37 applied once on both fresh and version-36 databases. Reopening is idempotent, a mid-migration fault records neither partial schema nor version 37, and legacy inbound outcomes plus outbound rows are unchanged except for the two intentionally null provenance columns.

- [ ] **Step 5: Commit the schema boundary**

```bash
git add src/core/database.ts tests/core/migration-37-inbound-replay.test.ts tests/core/database.test.ts tests/core/durability-schema.test.ts tests/core/migration-safety.test.ts docs/configuration.md
git commit -m "feat(durability): add replayable inbound lifecycle schema"
```

### Task 2: Atomically insert the message and admission row (WS-A02, commit 2)

**Files:**
- Modify: `src/core/types.ts` for readonly pending/processing ownership claims
- Modify: `src/core/inbound-failure-class.ts` and `tests/core/inbound-failure-class.test.ts` for bounded `admission_invariant`
- Modify: `src/core/db-tx.ts`
- Modify: `tests/core/db-tx.test.ts`
- Create: `src/core/inbound-admission.ts`
- Create: `tests/core/inbound-admission.test.ts`
- Modify: `tests/core/messages.test.ts` for atomic history-placeholder upgrade coverage
- Modify: `tests/core/decryption-failures.test.ts` for atomic placeholder/failure-resolution coverage
- Modify: `src/core/messages.ts:105-158` only if test injection requires exporting `toInsertParams`; prefer no change.
- Modify: `docs/public-surface.md`

**Interfaces:**
- Consumes: `storeMessageIfNew(db: Database, msg: StoreMessageInput): boolean` and a new `withImmediateTransaction<T>(db: Database, fn: () => T): T` write-serializing variant of the canonical transaction helper.
- Produces: readonly `PendingInboundClaim` / `InboundProcessingClaim` authority types and `admitInboundMessage(db: Database, msg: InboundAdmissionInput, now?: number): InboundAdmissionResult` where `InboundAdmissionInput` adds `mentionedJids`, `isResponseWorthy`, and the side-effect-free preclassified `admissionRoute: 'ingest' | 'admin'` to `StoreMessageInput`; `accepted` is true only for a new row, a missing-journal repair, or a due normal `deferred` claim below the shared durable attempt ceiling and always returns the exact pending claim. Persisting the admin route in the same transaction prevents a crash after admission from reinterpreting a command as a model turn.

- [ ] **Step 1: Write the atomicity and lease tests**

Create `tests/core/inbound-admission.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  InboundAdmissionInvariantError,
  admitInboundMessage,
  type InboundAdmissionInput,
} from '../../src/core/inbound-admission.ts';
import { storeMessageIfNew } from '../../src/core/messages.ts';

function message(messageId: string): InboundAdmissionInput {
  return {
    chatJid: '15550100001@s.whatsapp.net',
    conversationKey: '15550100001',
    senderJid: '15550100001@s.whatsapp.net',
    senderName: 'Synthetic User',
    messageId,
    content: 'synthetic admission canary',
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    timestamp: 1_800_000_000,
    quotedMessageId: null,
    rawMessage: null,
    mentionedJids: [],
    isResponseWorthy: true,
    admissionRoute: 'ingest',
  };
}

describe('admitInboundMessage', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('commits the message and inbound row in one transaction', () => {
    const result = admitInboundMessage(db, message('atomic-new'), 1_800_000_000);
    expect(result).toMatchObject({
      accepted: true,
      state: 'new',
      triggerMetadata: { mentionedJids: [], isResponseWorthy: true },
    });

    expect(db.raw.prepare(
      "SELECT message_id FROM messages WHERE message_id = 'atomic-new'",
    ).get()).toEqual({ message_id: 'atomic-new' });
    expect(db.raw.prepare(`
      SELECT seq, processing_status, attempt_count, lease_until,
             mentioned_jids_json, is_response_worthy
      FROM inbound_events WHERE message_id = 'atomic-new'
    `).get()).toEqual({
      seq: result.seq,
      processing_status: 'pending',
      attempt_count: 1,
      lease_until: 1_800_000_300,
      mentioned_jids_json: '[]',
      is_response_worthy: 1,
    });
  });

  it('persists an admin classification atomically with admission', () => {
    const input = { ...message('atomic-admin'), admissionRoute: 'admin' as const };
    const result = admitInboundMessage(db, input, 1_800_000_000);
    if (!result.accepted) throw new Error('admin admission unexpectedly rejected');
    expect(result.claim).toEqual({
      seq: result.seq, status: 'pending', route: 'admin', attemptCount: 1,
    });
    expect(db.raw.prepare(`
      SELECT processing_status, routed_to FROM inbound_events WHERE seq = ?
    `).get(result.seq)).toEqual({ processing_status: 'pending', routed_to: 'admin' });
  });

  it('rolls the message back when the inbound insert fails', () => {
    db.raw.exec(`
      CREATE TRIGGER reject_atomic_inbound
      BEFORE INSERT ON inbound_events
      WHEN NEW.message_id = 'atomic-fault'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic inbound journal fault');
      END
    `);

    expect(() => admitInboundMessage(db, message('atomic-fault'), 1_800_000_000))
      .toThrow(/synthetic inbound journal fault/);
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE message_id = 'atomic-fault'",
    ).get()).toEqual({ count: 0 });
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM inbound_events WHERE message_id = 'atomic-fault'",
    ).get()).toEqual({ count: 0 });
  });

  it('repairs a pre-existing message whose inbound row is missing', () => {
    expect(storeMessageIfNew(db, message('missing-journal'))).toBe(true);

    const result = admitInboundMessage(db, message('missing-journal'), 1_800_000_000);

    expect(result).toMatchObject({
      accepted: true,
      state: 'repaired_missing_journal',
      triggerMetadata: { mentionedJids: [], isResponseWorthy: true },
    });
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE message_id = 'missing-journal'",
    ).get()).toEqual({ count: 1 });
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM inbound_events WHERE message_id = 'missing-journal'",
    ).get()).toEqual({ count: 1 });
  });

  it('never transport-reclaims pending work solely because its lease timestamp elapsed', () => {
    const first = admitInboundMessage(db, message('lease-reclaim'), 1_800_000_000);
    const liveDuplicate = admitInboundMessage(db, message('lease-reclaim'), 1_800_000_100);
    const elapsedDuplicate = admitInboundMessage(db, message('lease-reclaim'), 1_800_010_000);

    expect(first.accepted).toBe(true);
    expect(liveDuplicate).toEqual({ accepted: false, seq: first.seq, state: 'duplicate_open' });
    expect(elapsedDuplicate).toEqual({ accepted: false, seq: first.seq, state: 'duplicate_open' });
    expect(db.raw.prepare(`
      SELECT attempt_count, lease_until FROM inbound_events WHERE seq = ?
    `).get(first.seq)).toEqual({ attempt_count: 1, lease_until: 1_800_000_300 });
  });

  it('does not reclaim deferred work before replay_after and claims it once when due', () => {
    const first = admitInboundMessage(db, message('deferred-due'), 1_800_000_000);
    db.raw.prepare(`
      UPDATE inbound_events
      SET processing_status = 'deferred', lease_until = NULL, replay_after = 1800000600
      WHERE seq = ?
    `).run(first.seq);

    expect(admitInboundMessage(db, message('deferred-due'), 1_800_000_599)).toEqual({
      accepted: false,
      seq: first.seq,
      state: 'duplicate_open',
    });
    expect(admitInboundMessage(db, message('deferred-due'), 1_800_000_600)).toEqual({
      accepted: true,
      seq: first.seq,
      state: 'reclaimed_due_deferred',
      claim: {
        seq: first.seq,
        status: 'pending',
        route: 'ingest',
        attemptCount: 2,
      },
      triggerMetadata: { mentionedJids: [], isResponseWorthy: true },
    });
    expect(db.raw.prepare(
      'SELECT attempt_count FROM inbound_events WHERE seq = ?',
    ).get(first.seq)).toEqual({ attempt_count: 2 });
  });

  it('never rewrites a durable admin route into normal replay ownership', () => {
    const first = admitInboundMessage(
      db, { ...message('deferred-admin'), admissionRoute: 'admin' }, 1_800_000_000,
    );
    db.raw.prepare(`
      UPDATE inbound_events SET processing_status='deferred', lease_until=NULL,
        replay_after=1800000600 WHERE seq=?
    `).run(first.seq);
    let thrown: unknown;
    try {
      admitInboundMessage(
        db, { ...message('deferred-admin'), admissionRoute: 'ingest' }, 1_800_000_600,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InboundAdmissionInvariantError);
    expect((thrown as InboundAdmissionInvariantError).reason).toBe('invalid_route');
    expect(db.raw.prepare(`
      SELECT processing_status, routed_to, attempt_count FROM inbound_events WHERE seq=?
    `).get(first.seq)).toEqual({
      processing_status: 'deferred', routed_to: 'admin', attempt_count: 1,
    });
  });

  it('terminalizes due transport redelivery at the shared attempt ceiling', () => {
    const first = admitInboundMessage(db, message('redelivery-exhausted'), 1_800_000_000);
    db.raw.prepare(`
      UPDATE inbound_events
      SET processing_status = 'deferred', lease_until = NULL,
          replay_after = 1800000600, attempt_count = 5
      WHERE seq = ?
    `).run(first.seq);

    expect(admitInboundMessage(db, message('redelivery-exhausted'), 1_800_000_600)).toEqual({
      accepted: false,
      seq: first.seq,
      state: 'duplicate_exhausted',
    });
    expect(db.raw.prepare(`
      SELECT processing_status, terminal_reason, failure_class, attempt_count, routed_to
      FROM inbound_events WHERE seq = ?
    `).get(first.seq)).toEqual({
      processing_status: 'failed',
      terminal_reason: 'error',
      failure_class: 'crash_recovery',
      attempt_count: 5,
      routed_to: 'replay_exhausted',
    });
  });

  it.each(['processing', 'turn_done'])('never transport-reclaims %s work', (status) => {
    const first = admitInboundMessage(db, message(`open-${status}`), 1_800_000_000);
    db.raw.prepare(`
      UPDATE inbound_events SET processing_status = ?, lease_until = 1799999999 WHERE seq = ?
    `).run(status, first.seq);

    expect(admitInboundMessage(db, message(`open-${status}`), 1_800_001_000)).toEqual({
      accepted: false,
      seq: first.seq,
      state: 'duplicate_open',
    });
  });

  it('never reopens a terminal inbound row on transport redelivery', () => {
    const first = admitInboundMessage(db, message('terminal-duplicate'), 1_800_000_000);
    db.raw.prepare(`
      UPDATE inbound_events
      SET processing_status = 'complete', terminal_reason = 'response_sent', completed_at = datetime('now')
      WHERE seq = ?
    `).run(first.seq);

    expect(admitInboundMessage(db, message('terminal-duplicate'), 1_800_001_000)).toEqual({
      accepted: false,
      seq: first.seq,
      state: 'duplicate_terminal',
    });
  });
});
```

Add a table-driven redelivery test for a linked terminal outbound op in every status: `pending`, `sending`, `submitted`, `maybe_sent`, `echoed`, `quarantined`, and `failed_permanent`. Even when the inbound row is due deferred or its lease expired, admission returns `duplicate_delivery_pending`, leaves status/attempt count unchanged, and never dispatches. Removing the any-terminal query/SQL guard must make the test RED.

Add existing-state collision/tombstone tests. An open admission with a physically
missing or soft-deleted message throws the bounded `InboundAdmissionInvariantError`
and changes/inserts nothing; a terminal admission remains a safe terminal
duplicate after normal soft-delete retention, provided the retained immutable
identity still matches. Table-drive both `complete` and `failed` terminal rows
with soft-deleted message rows and require `duplicate_terminal`; a physically
missing message row remains corruption in every lifecycle state. A soft-deleted message with no admission
returns `{accepted:false, seq:null, state:'duplicate_deleted'}` and never
resurrects content or creates an inbound row. For every immutable stored field,
a same-ID forged redelivery mismatch rejects without attempt or replay-metadata
change. Sender/chat identity, original timestamp, and message kind remain strict
forever. Content/text/raw fields are also strict unless the stored message has
`edited_at` or `deleted_at`. Those columns do not by themselves prove an
authenticated revoke—`deleted_at` is shared by retention and clear-chat—so
Task 2 treats either marker only as a fail-closed deferral. Transport redelivery
never reclaims or dispatches that row directly: an ownership-safe open row is atomically put in
`deferred/message_revision_requires_replay` and returns
`duplicate_mutated_deferred` so Task 4 can claim its DB-linearized canonical
snapshot or block an unproven deletion; it never terminalizes generic
`deleted_at`. A redelivery cannot itself create either marker. A byte-for-byte identity match may
win due reclaim, but it preserves the already committed
`mentioned_jids_json` and `is_response_worthy` rather than refreshing either
from transport and returns that canonical trigger metadata to ingest. Ingest
overwrites the duplicate's in-memory fields before current-policy evaluation.
Add persisted false/not-mentioned fixtures whose redelivery claims true/a forged
mention; neither may dispatch. Add original-body-after-edit,
edited-body-after-edit, original-body-after-revoke, and forged-mismatch-without-
revision tests; Task 2 must defer both stored markers without dispatch, and the
unmarked forgery remains a blocker. Task 4 later proves transport-owned revoke
provenance before terminalization. Mutating
`storeMessageIfNew` back ahead of the existing-row decision, accepting transport
content over a revision, or restoring metadata overwrite must make these tests
RED.

The immutable comparison uses the exact canonical values written by
`storeMessageIfNew`: omitted content/name/text/raw/quoted fields become null,
omitted content type becomes `text`, and timestamp comparison uses
`normalizeUnixTimestampSeconds` only after the raw timestamp passes the exact
validator below. Include `sender_name` in the stored-row query
and identity check. Add byte-identical redeliveries using every omitted default
and millisecond timestamp normalization, plus forged sender-name and normalized
timestamp counterexamples. The former must remain safe duplicates/due claims;
the latter must reject without changing attempt, metadata, or lifecycle state.
Table-drive `NaN`, positive/negative infinity, negative, fractional, and unsafe
integer timestamps through a fresh admission and assert `invalid_timestamp`,
zero message/admission rows, and zero current-time fallback. A validator mutation
that lets the time helper substitute `Date.now()` must make the test RED.
Repeat the invalid-timestamp table against (a) a canonical stored message whose
`inbound_events` journal row is missing and (b) a stored `content_type='history'`
placeholder eligible for live upgrade. Both paths must throw `invalid_timestamp`
before `storeMessageIfNew`, leave the stored row byte-for-byte unchanged, and
create no admission or decryption-resolution side effect. This proves the shared
normalization gate dominates fresh, missing-journal repair, and history-upgrade
branches rather than relying on one branch's write helper.
Run the same three-branch matrix for out-of-union content types, malformed JSON,
valid JSON with the wrong raw-envelope shape, over-limit raw bytes, media/raw-
required content with no envelope, non-boolean response-worthiness, and every
mention bound/shape failure. Each must throw `invalid_payload` or
`invalid_trigger_metadata` before `storeMessageIfNew`, preserve a history or
message-only row byte-for-byte, and create/resolve no admission/decryption side
effect. Both admission and replay must call the same decode/bounds SSOT; accepting
data that Task 4 later terminalizes as stale is a failing mutation.
Include cast-around `mentionedJids` values that are a string and a plain object;
neither may be treated as an iterable/character list.
Also pass a safe `now` near `Number.MAX_SAFE_INTEGER` whose lease addition
overflows; admission must throw `invalid_numeric_state` before either row is
written. The exact safe-boundary sum succeeds.

Preserve the one narrow canonical `storeMessageIfNew` conflict update: a live
delivery may atomically replace an envelope-only row only when the **stored**
row has `content_type='history'`; current behavior intentionally lets the live
transport body replace the placeholder's provisional identity/timestamp. The same
immediate transaction then inserts admission; an inbound-insert trigger failure
must roll back the body upgrade and decryption-failure resolution. Add forged
history identity, rollback, and two-connection upgrade contention tests; exactly
one upgraded body/admission pair wins. Every non-history same-ID row retains the
strict immutable collision check.

Add table-driven atomic rejection tests for 65 mention entries, an overlong identifier, an encoded payload over 8 KiB, non-string decoded entries, and corrupt JSON. Add a round-trip case proving repeated mention identifiers collapse to one stable first-occurrence entry. Each case must prove no message/admission split and use `encodeReplayMentionMetadata`/`decodeReplayMentionMetadata`; mutation to raw `JSON.stringify`/`JSON.parse` or removal of deduplication must go RED. The repair tool and worker import the same constants/functions—no copied limits.

Add a table-driven existing-state integrity suite covering an unknown status,
negative/fractional/overflowed sequence or attempt values, malformed lease and
replay timestamps, an attempt greater than zero with a null lease in
`pending`/`processing`, deferred attempt zero, deferred without `replay_after`,
and null/blank routes outside the exact legacy tuple
`{attempt_count:0,lease_until:null,replay_after:null}`. Every case asserts the
bounded invariant reason, unchanged message/admission rows, no ingress dispatch,
and no blocker classification derived from raw exception text. This is the
compatibility fence: only the exact legacy tuple may bypass the new lease/route
shape, and it is never transport-reclaimed.

Add table-driven `classifyInboundAdmissionError` tests for BUSY/LOCKED (`failed/retryable`), CONSTRAINT (`failed/rejected`), READONLY/FULL/CORRUPT (`blocked/blocked`), and an unknown thrown value. Assert only the bounded event/class/disposition shape; serialized error text must never enter the log fixture.

- [ ] **Step 2: Add a compiling scaffold, then capture semantic RED**

Before running RED, create the narrow `inbound-admission.ts` export/type surface
specified below with inert bodies that preserve the message and return a bounded
non-accepted result; metadata helpers may validate types but must not open the
new transaction. This scaffold exists only to make the test suite load and
compile. Do not count a missing module/export, syntax error, or type error as RED.

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-admission.test.ts --pool=forks
```

Expected: FAIL at the atomic pair/rollback/claim assertions because the compiling
scaffold does not implement the transaction or lifecycle. Capture at least one
intended state assertion from each test family; no test may be changed to accept
a message-only commit.

- [ ] **Step 3: Implement the atomic admission module**

First extend `src/core/db-tx.ts` with `withImmediateTransaction`, sharing the existing commit/rollback implementation but issuing `BEGIN IMMEDIATE`. Add a file-backed, two-connection test proving simultaneous admission attempts produce one committed message/admission pair and one deterministic duplicate result rather than `SQLITE_BUSY` or two owners.

Add deterministic storage-degradation cases in the same file-backed suite: enable `PRAGMA query_only=ON` before admission to prove `SQLITE_READONLY` leaves neither message nor admission and cannot dispatch; constrain a disposable database with `PRAGMA max_page_count` and a bounded filler row to force `SQLITE_FULL`, then prove the failed transaction leaves no partial pair and that reopening/raising the limit permits a subsequent canary write. A filesystem-permission staging probe may supplement these cases, but a skipped or privilege-bypassed `chmod` result is `Inconclusive`, not green.

Create `src/core/inbound-admission.ts`:

```ts
import type { Database } from './database.ts';
import { Buffer } from 'node:buffer';
import { withImmediateTransaction } from './db-tx.ts';
import { storeMessageIfNew, type StoreMessageInput } from './messages.ts';
import { classifyErrorForInbound, type InboundFailureClass } from './inbound-failure-class.ts';
import type { ContentType } from './types.ts';
import { normalizeUnixTimestampSeconds } from '../fleet/time-utils.ts';

export const ADMISSION_LEASE_SECONDS = 5 * 60;
const TERMINAL_STATUSES = new Set(['complete', 'failed']);
export const MAX_INBOUND_ATTEMPTS = 5;
export const MAX_REPLAY_MENTION_COUNT = 64;
export const MAX_REPLAY_MENTION_JSON_BYTES = 8 * 1024;
export const MAX_REPLAY_JID_BYTES = 512;
export const MAX_REPLAY_RAW_ENVELOPE_BYTES = 1024 * 1024;
export const REPLAY_CONTENT_TYPES = [
  'text', 'image', 'video', 'audio', 'document', 'sticker', 'location',
  'live_location', 'contact', 'poll', 'group_invite', 'product', 'pin',
  'interactive', 'unknown',
] as const satisfies readonly ContentType[];
const REPLAY_CONTENT_TYPE_SET = new Set<string>(REPLAY_CONTENT_TYPES);
const REPLAY_CONTENT_TYPE_SQL = REPLAY_CONTENT_TYPES.map(() => '?').join(', ');
export const REPLAY_RAW_REQUIRED_CONTENT_TYPES = [
  'image', 'video', 'audio', 'document', 'sticker',
] as const satisfies readonly ContentType[];
const REPLAY_RAW_REQUIRED_SET = new Set<string>(REPLAY_RAW_REQUIRED_CONTENT_TYPES);
const REPLAY_RAW_REQUIRED_SQL = REPLAY_RAW_REQUIRED_CONTENT_TYPES.map(() => '?').join(', ');

// Shared by the worker terminalization CTE and the health gauge. The caller's
// inbound_events alias is deliberately `e`; all dynamic values remain bound.
export const INVALID_DEFERRED_INBOUND_PREDICATE_SQL = `
  typeof(e.seq) <> 'integer' OR e.seq < 1 OR e.seq > 9007199254740991 OR
  e.routed_to IS NULL OR typeof(e.routed_to) <> 'text' OR length(trim(e.routed_to)) = 0 OR
  e.replay_after IS NULL OR typeof(e.replay_after) <> 'integer' OR e.replay_after < 0 OR e.replay_after > 9007199254740991 OR
  typeof(e.attempt_count) <> 'integer' OR e.attempt_count < 1 OR e.attempt_count > 9007199254740991 OR
  e.mentioned_jids_json IS NULL OR typeof(e.mentioned_jids_json) <> 'text' OR
  e.is_response_worthy IS NULL OR typeof(e.is_response_worthy) <> 'integer' OR e.is_response_worthy NOT IN (0, 1) OR
  CASE
    WHEN json_valid(e.mentioned_jids_json) = 0 THEN 1
    WHEN json_type(e.mentioned_jids_json) <> 'array' THEN 1
    WHEN length(CAST(e.mentioned_jids_json AS BLOB)) > ? THEN 1
    WHEN json_array_length(e.mentioned_jids_json) > ? THEN 1
    WHEN EXISTS (
      SELECT 1 FROM json_each(e.mentioned_jids_json)
      WHERE type <> 'text' OR length(CAST(value AS BLOB)) > ?
    ) THEN 1
    ELSE 0
  END = 1 OR
  NOT EXISTS (
    SELECT 1 FROM messages m
    WHERE m.message_id = e.message_id AND m.deleted_at IS NULL
      AND typeof(e.chat_jid) = 'text' AND length(trim(e.chat_jid)) > 0
      AND typeof(e.conversation_key) = 'text' AND length(trim(e.conversation_key)) > 0
      AND typeof(m.chat_jid) = 'text' AND m.chat_jid = e.chat_jid
      AND typeof(m.conversation_key) = 'text'
      AND m.conversation_key = e.conversation_key
      AND typeof(m.sender_jid) = 'text' AND length(trim(m.sender_jid)) > 0
      AND typeof(m.is_from_me) = 'integer' AND m.is_from_me = 0
      AND typeof(m.timestamp) = 'integer'
      AND m.timestamp >= 0 AND m.timestamp <= 9007199254740991
      AND (m.sender_name IS NULL OR typeof(m.sender_name) = 'text')
      AND (m.content IS NULL OR typeof(m.content) = 'text')
      AND (m.content_text IS NULL OR typeof(m.content_text) = 'text')
      AND (m.quoted_message_id IS NULL OR typeof(m.quoted_message_id) = 'text')
  ) OR EXISTS (
    SELECT 1 FROM messages m
    WHERE m.message_id = e.message_id
      AND (
        typeof(m.content_type) <> 'text' OR
        m.content_type NOT IN (${REPLAY_CONTENT_TYPE_SQL}) OR
        (m.content_type IN (${REPLAY_RAW_REQUIRED_SQL}) AND m.raw_message IS NULL) OR
        (m.raw_message IS NOT NULL AND (
          typeof(m.raw_message) <> 'text' OR CASE
          WHEN length(CAST(m.raw_message AS BLOB)) > ? THEN 1
          WHEN json_valid(m.raw_message) = 0 THEN 1
          WHEN json_type(m.raw_message) <> 'object' THEN 1
          WHEN json_type(m.raw_message, '$.key') IS NOT 'object' THEN 1
          WHEN json_type(m.raw_message, '$.message') IS NOT 'object' THEN 1
          ELSE 0
        END = 1))
      )
  )
`;
export const INVALID_DEFERRED_INBOUND_PREDICATE_PARAMS = [
  MAX_REPLAY_MENTION_JSON_BYTES,
  MAX_REPLAY_MENTION_COUNT,
  MAX_REPLAY_JID_BYTES,
  ...REPLAY_CONTENT_TYPES,
  ...REPLAY_RAW_REQUIRED_CONTENT_TYPES,
  MAX_REPLAY_RAW_ENVELOPE_BYTES,
] as const;

export function encodeReplayMentionMetadata(mentionedJids: readonly string[]): string {
  if (mentionedJids.length > MAX_REPLAY_MENTION_COUNT) {
    throw new RangeError('replay mention count exceeds limit');
  }
  for (const jid of mentionedJids) {
    if (Buffer.byteLength(jid, 'utf8') > MAX_REPLAY_JID_BYTES) {
      throw new RangeError('replay mention identifier exceeds limit');
    }
  }
  const encoded = JSON.stringify([...new Set(mentionedJids)]);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REPLAY_MENTION_JSON_BYTES) {
    throw new RangeError('replay mention metadata exceeds limit');
  }
  return encoded;
}

export function decodeReplayMentionMetadata(encoded: string): string[] {
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REPLAY_MENTION_JSON_BYTES) {
    throw new RangeError('replay mention metadata exceeds limit');
  }
  const value = JSON.parse(encoded) as unknown;
  if (!Array.isArray(value) || value.length > MAX_REPLAY_MENTION_COUNT
      || !value.every((jid) => typeof jid === 'string'
        && Buffer.byteLength(jid, 'utf8') <= MAX_REPLAY_JID_BYTES)) {
    throw new TypeError('invalid replay mention metadata');
  }
  return value;
}

export function decodeReplayContentType(value: string): ContentType {
  if (!REPLAY_CONTENT_TYPE_SET.has(value)) {
    throw new TypeError('invalid replay content type');
  }
  return value as ContentType;
}

export function decodeReplayRawEnvelope(encoded: string | null): unknown {
  if (encoded === null) return undefined;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REPLAY_RAW_ENVELOPE_BYTES) {
    throw new RangeError('replay raw envelope exceeds limit');
  }
  const value = JSON.parse(encoded) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid replay raw envelope');
  }
  const record = value as Record<string, unknown>;
  for (const field of ['key', 'message'] as const) {
    const nested = record[field];
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) {
      throw new TypeError('invalid replay raw envelope');
    }
  }
  return value;
}

export function decodeReplayPayload(
  contentTypeValue: string,
  rawEnvelope: string | null,
): { contentType: ContentType; rawMessage: unknown } {
  const contentType = decodeReplayContentType(contentTypeValue);
  const rawMessage = decodeReplayRawEnvelope(rawEnvelope);
  if (REPLAY_RAW_REQUIRED_SET.has(contentType) && rawMessage === undefined) {
    throw new TypeError('replay media payload requires raw envelope');
  }
  return { contentType, rawMessage };
}

export interface InboundAdmissionErrorDisposition {
  event: 'inbound_admission_failed' | 'inbound_admission_blocked';
  failureClass: InboundFailureClass;
  disposition: 'retryable' | 'rejected' | 'blocked' | 'unknown';
}

export function classifyInboundAdmissionError(err: unknown): InboundAdmissionErrorDisposition {
  if (err instanceof InboundAdmissionInvariantError) {
    return { event: 'inbound_admission_failed', failureClass: 'admission_invariant', disposition: 'rejected' };
  }
  const record = err !== null && typeof err === 'object'
    ? err as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown }
    : {};
  const errcode = typeof record.errcode === 'number' ? record.errcode : null;
  const primaryCode = errcode === null ? null : (errcode & 0xff);
  const bounded = `${typeof record.code === 'string' ? record.code : ''} ${
    typeof record.errstr === 'string' ? record.errstr : ''
  } ${
    typeof record.message === 'string' ? record.message : ''
  }`;
  // Stable SQLite primary result codes: BUSY=5, LOCKED=6, READONLY=8,
  // IOERR=10, CORRUPT=11, FULL=13, CANTOPEN=14, CONSTRAINT=19, NOTADB=26.
  // node:sqlite commonly reports code='ERR_SQLITE_ERROR' and carries the
  // actionable primary code in numeric errcode, so code-string matching alone
  // is not sufficient.
  if (
    (primaryCode !== null && [8, 10, 11, 13, 14, 26].includes(primaryCode))
    || /SQLITE_(FULL|READONLY|CORRUPT|IOERR|CANTOPEN|NOTADB)/i.test(bounded)
    || /attempt to write a readonly database|database or disk is full|disk I\/O error|database disk image is malformed|unable to open database file|file is not a database/i.test(bounded)
  ) {
    return { event: 'inbound_admission_blocked', failureClass: 'db_error', disposition: 'blocked' };
  }
  if ((primaryCode !== null && [5, 6].includes(primaryCode)) || /SQLITE_(BUSY|LOCKED)|database is (?:busy|locked)/i.test(bounded)) {
    return { event: 'inbound_admission_failed', failureClass: 'db_error', disposition: 'retryable' };
  }
  if (primaryCode === 19 || /SQLITE_CONSTRAINT|constraint failed/i.test(bounded)) {
    return { event: 'inbound_admission_failed', failureClass: 'db_error', disposition: 'rejected' };
  }
  return {
    event: 'inbound_admission_failed',
    failureClass: classifyErrorForInbound(err),
    disposition: 'unknown',
  };
}

```

Add this single canonical claim definition to `src/core/types.ts`; all other
modules import it and do not redeclare it:

```ts
export interface PendingInboundClaim {
  readonly seq: number;
  readonly status: 'pending';
  readonly route: 'ingest' | 'admin';
  readonly attemptCount: number;
}

export interface InboundProcessingClaim {
  readonly seq: number;
  readonly status: 'processing';
  readonly route: string;
  readonly attemptCount: number;
}

export type InboundOwnershipClaim = PendingInboundClaim | InboundProcessingClaim;
```

Then import those types in `src/core/inbound-admission.ts` and define:

```ts
export interface InboundAdmissionInput extends StoreMessageInput {
  mentionedJids: readonly string[];
  isResponseWorthy: boolean;
  admissionRoute: 'ingest' | 'admin';
}

export type InboundAdmissionState =
  | 'new'
  | 'repaired_missing_journal'
  | 'upgraded_history_placeholder'
  | 'reclaimed_due_deferred'
  | 'duplicate_open'
  | 'duplicate_terminal'
  | 'duplicate_delivery_pending'
  | 'duplicate_mutated_deferred'
  | 'duplicate_deleted'
  | 'duplicate_exhausted';

// Canonical definitions live only in src/core/types.ts and are imported here:
import type {
  InboundOwnershipClaim,
  InboundProcessingClaim,
  PendingInboundClaim,
} from './types.ts';

export type InboundAdmissionResult =
  | {
      accepted: true;
      seq: number;
      state: 'new' | 'repaired_missing_journal' | 'upgraded_history_placeholder' | 'reclaimed_due_deferred';
      claim: PendingInboundClaim;
      triggerMetadata: Readonly<{
        mentionedJids: readonly string[];
        isResponseWorthy: boolean;
      }>;
    }
  | {
      accepted: false;
      seq: number;
      state: Exclude<InboundAdmissionState,
        'new' | 'repaired_missing_journal' | 'upgraded_history_placeholder' | 'reclaimed_due_deferred' | 'duplicate_deleted'>;
    }
  | {
      accepted: false;
      seq: null;
      state: 'duplicate_deleted';
    };

export class InboundAdmissionInvariantError extends Error {
  constructor(readonly reason: 'missing_message' | 'deleted_message' | 'identity_mismatch' | 'invalid_route' | 'invalid_numeric_state' | 'invalid_timestamp' | 'invalid_payload' | 'invalid_trigger_metadata' | 'invalid_status') {
    super('existing inbound admission failed integrity validation');
  }
}

interface ExistingAdmission {
  seq: number;
  conversation_key: string;
  chat_jid: string;
  processing_status: string;
  lease_until: number | null;
  replay_after: number | null;
  attempt_count: number;
  routed_to: string | null;
  mentioned_jids_json: string | null;
  is_response_worthy: number | null;
}

interface StoredAdmissionMessage {
  chat_jid: string;
  conversation_key: string;
  sender_jid: string;
  sender_name: string | null;
  content: string | null;
  content_text: string | null;
  content_type: string;
  is_from_me: number;
  timestamp: number;
  quoted_message_id: string | null;
  raw_message: string | null;
  edited_at: string | null;
  deleted_at: string | null;
}

function normalizeAdmissionTimestampOrThrow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InboundAdmissionInvariantError('invalid_timestamp');
  }
  const normalized = normalizeUnixTimestampSeconds(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new InboundAdmissionInvariantError('invalid_timestamp');
  }
  return normalized;
}

function canonicalAdmissionIdentity(msg: InboundAdmissionInput) {
  return {
    chatJid: msg.chatJid,
    conversationKey: msg.conversationKey,
    senderJid: msg.senderJid,
    senderName: msg.senderName ?? null,
    content: msg.content ?? null,
    contentText: msg.contentText ?? null,
    contentType: msg.contentType ?? 'text',
    isFromMe: msg.isFromMe ? 1 : 0,
    timestamp: msg.timestamp,
    quotedMessageId: msg.quotedMessageId ?? null,
    rawMessage: msg.rawMessage ?? null,
  } as const;
}

function normalizeAdmissionInputOrThrow(
  msg: InboundAdmissionInput,
): InboundAdmissionInput {
  const normalized = {
    ...msg,
    timestamp: normalizeAdmissionTimestampOrThrow(msg.timestamp),
    contentType: msg.contentType ?? 'text',
    rawMessage: msg.rawMessage ?? null,
  };
  try {
    decodeReplayPayload(normalized.contentType, normalized.rawMessage);
  } catch {
    throw new InboundAdmissionInvariantError('invalid_payload');
  }
  if (typeof normalized.isResponseWorthy !== 'boolean') {
    throw new InboundAdmissionInvariantError('invalid_trigger_metadata');
  }
  if (!Array.isArray(normalized.mentionedJids)
      || !normalized.mentionedJids.every((value) => typeof value === 'string')) {
    throw new InboundAdmissionInvariantError('invalid_trigger_metadata');
  }
  let mentionedJids: readonly string[];
  try {
    mentionedJids = Object.freeze(decodeReplayMentionMetadata(
      encodeReplayMentionMetadata(normalized.mentionedJids),
    ));
  } catch {
    throw new InboundAdmissionInvariantError('invalid_trigger_metadata');
  }
  return Object.freeze({ ...normalized, mentionedJids });
}

function storedBaseIdentityMatches(
  stored: StoredAdmissionMessage,
  existing: ExistingAdmission | undefined,
  msg: InboundAdmissionInput,
): boolean {
  const canonical = canonicalAdmissionIdentity(msg);
  return stored.chat_jid === canonical.chatJid
    && stored.conversation_key === canonical.conversationKey
    && stored.sender_jid === canonical.senderJid
    && stored.sender_name === canonical.senderName
    && stored.content_type === canonical.contentType
    && stored.is_from_me === canonical.isFromMe
    && stored.timestamp === canonical.timestamp
    && stored.quoted_message_id === canonical.quotedMessageId
    && (existing === undefined || (
      existing.chat_jid === msg.chatJid
      && existing.conversation_key === msg.conversationKey
    ));
}

function storedMutableIdentityMatches(
  stored: StoredAdmissionMessage,
  msg: InboundAdmissionInput,
): boolean {
  const canonical = canonicalAdmissionIdentity(msg);
  return stored.content === canonical.content
    && stored.content_text === canonical.contentText
    && stored.raw_message === canonical.rawMessage;
}

type LostAdmissionMutationResult = Extract<
  InboundAdmissionResult,
  { accepted: false; seq: number }
>;

function deferRevisionMarkedInboundExact(
  db: Database,
  existing: ExistingAdmission,
  now: number,
): boolean {
  if (existing.routed_to === 'admin') return false;
  return Number(db.raw.prepare(`
    UPDATE inbound_events
    SET processing_status = 'deferred',
        deferred_reason = 'message_revision_requires_replay',
        replay_after = ?, lease_until = NULL
    WHERE seq = ?
      AND processing_status = ?
      AND routed_to = ?
      AND attempt_count = ?
      AND processing_status IN ('pending', 'deferred')
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m.message_id = inbound_events.message_id
          AND (m.edited_at IS NOT NULL OR m.deleted_at IS NOT NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM outbound_ops o
        WHERE o.source_inbound_seq = inbound_events.seq AND o.is_terminal = 1
      )
  `).run(
    now, existing.seq, existing.processing_status,
    existing.routed_to, existing.attempt_count,
  ).changes) === 1;
}

function classifyLostAdmissionMutation(
  db: Database,
  existing: ExistingAdmission,
): LostAdmissionMutationResult {
  const current = db.raw.prepare(`
    SELECT processing_status, routed_to, attempt_count
    FROM inbound_events
    WHERE seq = ?
      AND typeof(attempt_count) = 'integer'
      AND attempt_count BETWEEN 0 AND 9007199254740991
  `).get(existing.seq) as {
    processing_status: string;
    routed_to: string | null;
    attempt_count: number;
  } | undefined;
  if (!current) throw new InboundAdmissionInvariantError('invalid_status');
  if (current.routed_to !== existing.routed_to
      || current.attempt_count !== existing.attempt_count) {
    return { accepted: false, seq: existing.seq, state: 'duplicate_open' };
  }
  if (TERMINAL_STATUSES.has(current.processing_status)) {
    return { accepted: false, seq: existing.seq, state: 'duplicate_terminal' };
  }
  const terminalOwner = db.raw.prepare(`
    SELECT 1 FROM outbound_ops
    WHERE source_inbound_seq = ? AND is_terminal = 1 LIMIT 1
  `).get(existing.seq) !== undefined;
  return terminalOwner
    ? { accepted: false, seq: existing.seq, state: 'duplicate_delivery_pending' }
    : { accepted: false, seq: existing.seq, state: 'duplicate_open' };
}

function validateExistingAdmissionState(row: ExistingAdmission): void {
  const statuses = new Set<string>([
    'pending', 'processing', 'turn_done', 'deferred', 'complete', 'failed',
  ]);
  if (!Number.isSafeInteger(row.seq) || row.seq <= 0
      || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0
      || (row.lease_until !== null
        && (!Number.isSafeInteger(row.lease_until) || row.lease_until < 0))
      || (row.replay_after !== null
        && (!Number.isSafeInteger(row.replay_after) || row.replay_after < 0))) {
    throw new InboundAdmissionInvariantError('invalid_numeric_state');
  }
  if (!statuses.has(row.processing_status)) {
    throw new InboundAdmissionInvariantError('invalid_status');
  }
  const exactLegacy = row.attempt_count === 0
    && row.lease_until === null
    && row.replay_after === null;
  if (!exactLegacy && (row.routed_to === null || row.routed_to.trim() === '')) {
    throw new InboundAdmissionInvariantError('invalid_route');
  }
  if (!exactLegacy && row.attempt_count < 1) {
    throw new InboundAdmissionInvariantError('invalid_numeric_state');
  }
  if ((row.processing_status === 'pending' || row.processing_status === 'processing')
      && !exactLegacy && row.lease_until === null) {
    throw new InboundAdmissionInvariantError('invalid_numeric_state');
  }
  if (row.processing_status === 'deferred' && row.replay_after === null) {
    throw new InboundAdmissionInvariantError('invalid_numeric_state');
  }
  if (row.processing_status === 'deferred' && exactLegacy) {
    throw new InboundAdmissionInvariantError('invalid_numeric_state');
  }
  // Null-lease attempt-0 rows are isolated legacy compatibility state only.
}

export function admitInboundMessage(
  db: Database,
  msg: InboundAdmissionInput,
  now: number = Math.floor(Date.now() / 1000),
): InboundAdmissionResult {
  // Validate/canonicalize before BEGIN IMMEDIATE or any store/placeholder write.
  msg = normalizeAdmissionInputOrThrow(msg);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new InboundAdmissionInvariantError('invalid_numeric_state');
  }
  return withImmediateTransaction(db, () => {
    const existing = db.raw.prepare(`
      SELECT seq, conversation_key, chat_jid, processing_status,
             lease_until, replay_after, attempt_count, routed_to,
             mentioned_jids_json, is_response_worthy
      FROM inbound_events
      WHERE message_id = ?
    `).get(msg.messageId) as ExistingAdmission | undefined;

    const stored = db.raw.prepare(`
      SELECT chat_jid, conversation_key, sender_jid, sender_name, content, content_text,
             content_type, is_from_me, timestamp, quoted_message_id,
             raw_message, edited_at, deleted_at
      FROM messages WHERE message_id = ?
    `).get(msg.messageId) as StoredAdmissionMessage | undefined;
    const leaseUntil = now + ADMISSION_LEASE_SECONDS;
    if (!Number.isSafeInteger(leaseUntil) || leaseUntil < 0) {
      throw new InboundAdmissionInvariantError('invalid_numeric_state');
    }

    if (!existing) {
      if (stored?.deleted_at !== null && stored?.deleted_at !== undefined) {
        return { accepted: false, seq: null, state: 'duplicate_deleted' };
      }
      let admissionState: 'new' | 'repaired_missing_journal' | 'upgraded_history_placeholder';
      if (stored?.content_type === 'history') {
        if (!storeMessageIfNew(db, msg)) {
          throw new InboundAdmissionInvariantError('identity_mismatch');
        }
        admissionState = 'upgraded_history_placeholder';
      } else if (stored) {
        if (stored.edited_at !== null || stored.deleted_at !== null
            || !storedBaseIdentityMatches(stored, undefined, msg)
            || !storedMutableIdentityMatches(stored, msg)) {
          throw new InboundAdmissionInvariantError('identity_mismatch');
        }
        admissionState = 'repaired_missing_journal';
      } else {
        storeMessageIfNew(db, msg);
        admissionState = 'new';
      }
      const mentionedJidsJson = encodeReplayMentionMetadata(msg.mentionedJids);
      const canonicalMentionedJids = Object.freeze(
        decodeReplayMentionMetadata(mentionedJidsJson),
      );
      const inserted = db.raw.prepare(`
        INSERT INTO inbound_events (
          message_id, conversation_key, chat_jid, routed_to,
          processing_status, lease_until, attempt_count,
          mentioned_jids_json, is_response_worthy
        ) VALUES (?, ?, ?, ?, 'pending', ?, 1, ?, ?)
      `).run(
        msg.messageId, msg.conversationKey, msg.chatJid, msg.admissionRoute, leaseUntil,
        mentionedJidsJson, msg.isResponseWorthy ? 1 : 0,
      );
      const seq = Number(inserted.lastInsertRowid);
      if (!Number.isSafeInteger(seq) || seq <= 0) {
        throw new InboundAdmissionInvariantError('invalid_numeric_state');
      }
      return {
        accepted: true,
        seq,
        state: admissionState,
        claim: Object.freeze({
          seq, status: 'pending', route: msg.admissionRoute, attemptCount: 1,
        }),
        triggerMetadata: Object.freeze({
          mentionedJids: canonicalMentionedJids,
          isResponseWorthy: msg.isResponseWorthy,
        }),
      };
    }

    validateExistingAdmissionState(existing);
    if (!stored) throw new InboundAdmissionInvariantError('missing_message');
    if (!storedBaseIdentityMatches(stored, existing, msg)) {
      throw new InboundAdmissionInvariantError('identity_mismatch');
    }
    // A normally retained soft-deleted row still carries enough immutable
    // identity to prove a terminal duplicate. Physical absence and forged
    // identity remain corruption; soft deletion blocks every open lifecycle.
    const hasStoredMutationMarker = stored.edited_at !== null || stored.deleted_at !== null;
    if (TERMINAL_STATUSES.has(existing.processing_status)) {
      if (!hasStoredMutationMarker && !storedMutableIdentityMatches(stored, msg)) {
        throw new InboundAdmissionInvariantError('identity_mismatch');
      }
      return { accepted: false, seq: existing.seq, state: 'duplicate_terminal' };
    }
    const terminalOutboundExists = db.raw.prepare(`
      SELECT 1 AS present FROM outbound_ops
      WHERE source_inbound_seq = ? AND is_terminal = 1 LIMIT 1
    `).get(existing.seq) !== undefined;
    if (terminalOutboundExists) {
      return { accepted: false, seq: existing.seq, state: 'duplicate_delivery_pending' };
    }
    if (stored.edited_at !== null || stored.deleted_at !== null) {
      // A redelivery may never steal processing/turn_done ownership. Only an
      // ownership-safe pending/deferred tuple can be revision-settled here.
      if (!['pending', 'deferred'].includes(existing.processing_status)) {
        return { accepted: false, seq: existing.seq, state: 'duplicate_open' };
      }
      const changed = deferRevisionMarkedInboundExact(db, existing, now);
      if (!changed) return classifyLostAdmissionMutation(db, existing);
      return {
        accepted: false,
        seq: existing.seq,
        state: 'duplicate_mutated_deferred',
      };
    }
    if (stored.deleted_at !== null) {
      throw new InboundAdmissionInvariantError('deleted_message');
    }
    if (!storedMutableIdentityMatches(stored, msg)) {
      throw new InboundAdmissionInvariantError('identity_mismatch');
    }
    const deferredDue = existing.processing_status === 'deferred'
      && existing.replay_after !== null
      && existing.replay_after <= now;
    if (deferredDue) {
      if (existing.routed_to === null || existing.routed_to.trim() === '') {
        throw new InboundAdmissionInvariantError('invalid_route');
      }
      if (existing.routed_to === 'admin') {
        throw new InboundAdmissionInvariantError('invalid_route');
      }
      if (existing.attempt_count >= MAX_INBOUND_ATTEMPTS) {
        const exhausted = db.raw.prepare(`
          UPDATE inbound_events
          SET processing_status = 'failed', terminal_reason = 'error',
              failure_class = 'crash_recovery', completed_at = datetime('now'),
              routed_to = 'replay_exhausted', lease_until = NULL,
              replay_after = NULL, deferred_reason = NULL
          WHERE seq = ?
            AND routed_to = ?
            AND attempt_count >= ?
            AND NOT EXISTS (
              SELECT 1 FROM outbound_ops
              WHERE source_inbound_seq = inbound_events.seq AND is_terminal = 1
            )
            AND processing_status = 'deferred'
            AND replay_after IS NOT NULL AND replay_after <= ?
        `).run(existing.seq, existing.routed_to, MAX_INBOUND_ATTEMPTS, now);
        if (Number(exhausted.changes) === 1) {
          return { accepted: false, seq: existing.seq, state: 'duplicate_exhausted' };
        }
      }
      if (msg.admissionRoute !== 'ingest') {
        return { accepted: false, seq: existing.seq, state: 'duplicate_open' };
      }
      const claimed = db.raw.prepare(`
        UPDATE inbound_events
        SET processing_status = 'pending',
            routed_to = 'ingest',
            completed_at = NULL,
            terminal_reason = NULL,
            failure_class = NULL,
            deferred_reason = NULL,
            replay_after = NULL,
            lease_until = ?,
            attempt_count = attempt_count + 1
        WHERE seq = ?
          AND processing_status = 'deferred'
          AND routed_to = ?
          AND attempt_count < ?
          AND NOT EXISTS (
            SELECT 1 FROM outbound_ops
            WHERE source_inbound_seq = inbound_events.seq AND is_terminal = 1
          )
          AND replay_after IS NOT NULL AND replay_after <= ?
        RETURNING attempt_count
      `).get(
        leaseUntil, existing.seq, existing.routed_to,
        MAX_INBOUND_ATTEMPTS, now,
      ) as { attempt_count: number } | undefined;
      if (claimed) {
        if (typeof existing.mentioned_jids_json !== 'string'
            || !Number.isInteger(existing.is_response_worthy)
            || ![0, 1].includes(existing.is_response_worthy as number)) {
          throw new InboundAdmissionInvariantError('invalid_numeric_state');
        }
        const mentionedJids = Object.freeze(
          decodeReplayMentionMetadata(existing.mentioned_jids_json),
        );
        return {
          accepted: true,
          seq: existing.seq,
          state: 'reclaimed_due_deferred',
          claim: Object.freeze({
            seq: existing.seq,
            status: 'pending',
            route: 'ingest',
            attemptCount: claimed.attempt_count,
          }),
          triggerMetadata: Object.freeze({
            mentionedJids,
            isResponseWorthy: existing.is_response_worthy === 1,
          }),
        };
      }
    }

    return { accepted: false, seq: existing.seq, state: 'duplicate_open' };
  });
}
```

`storedBaseIdentityMatches` compares only never-mutable transport identity;
`storedMutableIdentityMatches` runs only when no stored edit/delete marker
exists. The stored-message SELECT includes `edited_at` and `deleted_at`.
`deferRevisionMarkedInboundExact` matches sequence/status/route/attempt, requires
one of those markers and no linked terminal owner, sets
`deferred/message_revision_requires_replay`, and limits admission-side mutation
to `pending|deferred`; a processing or turn-done owner is never stolen. It does
not claim that `deleted_at` proves revoke. `classifyLostAdmissionMutation`
performs one serialized reread and exhaustively returns current
terminal, delivery-pending, or duplicate-open and throws on an unexplained
tuple. Add held processing/turn-done edit+redelivery races plus concurrent
terminal-owner installation; no case may defer/fail the live owner or dispatch
transport content. Add a no-marker byte-identical duplicate/due-reclaim control
that proves `edited_at === null && deleted_at === null` does not enter the
mutation branch.

The sequence check executes before the immediate transaction can commit. Test
an exact `Number.MAX_SAFE_INTEGER` inserted row ID, `MAX_SAFE+1`, and a lossy
`MAX_SAFE+2` bigint conversion: only the safe boundary returns a claim; both
unsafe cases roll back message/admission/decryption-resolution writes. The
shared invalid-deferred predicate validates `e.seq` in SQL before JavaScript
reads or rebinds it. Seed an unsafe INTEGER primary key through raw SQL and prove
the invalid terminalization CTE and health gauge handle it entirely in SQL,
never construct a rounded JS claim, and cannot mutate an adjacent safe row.

Exercise this classifier with the actual `DatabaseSync` errors thrown by the
`PRAGMA query_only=ON` and `PRAGMA max_page_count` degradation probes. Assert
their real `code='ERR_SQLITE_ERROR'` plus numeric `errcode` shapes map to
`blocked`; add table cases for extended numeric result codes to prove the
low-byte primary-code reduction. Synthetic `SQLITE_*` strings alone are not
sufficient evidence.

- [ ] **Step 4: Run the atomicity suite and typecheck**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/db-tx.test.ts tests/core/inbound-admission.test.ts tests/core/inbound-failure-class.test.ts tests/core/messages.test.ts tests/core/decryption-failures.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
```

Expected: PASS. The fault-trigger case must show both table counts at zero, a pre-existing decryption failure still unresolved, and a subsequent write succeeding. The two-connection test must prove one winner without masking `SQLITE_BUSY`.
The read-only and full-disk simulations must fail for their intended SQLite codes, preserve pairwise atomicity, and capture the recovery canary; a fixture/setup failure does not satisfy the gate.

- [ ] **Step 5: Commit the transaction boundary**

```bash
git add src/core/types.ts src/core/db-tx.ts src/core/inbound-admission.ts src/core/inbound-failure-class.ts src/core/messages.ts tests/core/db-tx.test.ts tests/core/inbound-admission.test.ts tests/core/inbound-failure-class.test.ts tests/core/messages.test.ts tests/core/decryption-failures.test.ts docs/public-surface.md
git commit -m "fix(ingest): atomically admit inbound messages"
```

### Task 3: Route every normal inbound through its admitted row (WS-A02, commit 3)

**Files:**
- Modify: `src/core/types.ts` for the immutable processing-claim contract and to widen canonical `InboundStatus` with `deferred`
- Modify: `src/core/durability.ts:139-260, 430-480`
- Modify: `src/core/admin.ts` so admitted visible notices use the exact claim-derived tracked-send seam
- Modify: `src/core/inbound-failure-class.ts` and `tests/core/inbound-failure-class.test.ts` for bounded `admin_command_failed`
- Modify: `src/core/health.ts` to surface the latched admission blocker as unhealthy
- Modify: `src/core/ingest.ts:115-373`
- Modify: `src/core/access-policy.ts` to make policy-decision logs content-free for both initial and replay calls
- Modify: `src/main.ts` to own the admission-blocked latch and detach ingress
- Modify: `src/runtimes/types.ts`, `src/runtimes/chat/runtime.ts`, `src/runtimes/agent/runtime.ts`, `src/runtimes/agent/outbound-queue.ts`, and `src/runtimes/passive/runtime.ts` to consume the exact processing claim, derive any compatibility sequence from it, and persist exact terminal provenance before transport
- Modify: `tests/core/ingest.test.ts:193-360`
- Modify: `tests/core/ingest-backpressure.test.ts:174-430`
- Modify: `tests/core/ingest-control.test.ts`, `tests/core/ingest-paused-chats.test.ts`, and `tests/core/ingest-fallback-routing.test.ts` for the dispatcher/options signature
- Modify: `tests/core/admin.test.ts` for the durable admin-command ownership boundary
- Modify: `tests/core/access-policy.test.ts` for structured-log redaction and decision parity
- Modify: `tests/core/durability.test.ts` for lease-aware restart recovery
- Modify: `tests/core/health.test.ts` and `tests/main-bootstrap.test.ts` for fail-closed admission health/wiring
- Modify: `tests/integration/heal-flow.test.ts` for the dispatcher/options signature
- Modify: `tests/runtimes/chat/runtime.test.ts`, `tests/runtimes/agent/runtime.test.ts`, and `tests/runtimes/passive/runtime.test.ts` for claim/sequence equality and claimless-lane parity
- Modify: `tests/runtimes/agent/outbound-queue.test.ts` and `tests/runtimes/agent/outbound-queue-idempotency.test.ts` for claim-derived terminal reservation and echo completion
- Modify: `package.json` so the fixed branch pre-push suite executes the new migration/admission and owning ingest tests
- Modify: `deploy/source-runtime-manifest.json` after recomputing every changed hashed entrypoint
- Modify: `docs/durability.md`
- Modify: `docs/public-surface.md`

**Interfaces:**
- Consumes: `admitInboundMessage(db, InboundAdmissionInput, now?)` from Task 2.
- Produces: canonical `InboundStatus` including `deferred`, readonly pending/processing ownership claims, `DurabilityEngine.markInboundProcessing(pendingClaim, routedTo): InboundProcessingClaim | null`, claim-guarded failure/skip/deferral transitions, the shared exact `TerminalOutboundEvidenceForClaim` classifier, the minimum sole `reserveOutboundForClaimOrThrow(...)` / `promoteOutboundTerminalForClaimOrThrow(...)` / `sendTrackedForClaim(...)` writers used by every admitted visible output before transport, the bounded invalid-provenance health gauge, `IngestHandlerOptions.onIngressBlocked`, `IngestHandler.getIngressHealth()`, `IngestHandler.close(): Promise<void>`, `IngestHandler.idle(): Promise<void>`, and `createAdmittedInboundDispatcher(...)`. The dispatcher is the only normal/replay seam that rechecks current paused/passive/access/response-worthiness policy before capacity or runtime, owns the optional initial-capacity lease, attaches the immutable winning claim, and validates sequence equality; admin classification is persisted at admission and approval notification remains an initial-only side effect.

- [ ] **Step 1: Add the red ingest regression tests**

Append these tests to the durability-enabled ingest describe in `tests/core/ingest.test.ts`:

```ts
it('persists one pending inbound row before runtime capacity work begins', async () => {
  const db = makeTempDb();
  const messenger = makeMessenger();
  const runtime = makeRuntime();
  const durability = new DurabilityEngine(db);
  const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
  const msg = makeIncomingMessage({ messageId: 'atomic-ingest-visible' });

  vi.mocked(runtime.handleMessage).mockImplementation(async (received) => {
    const row = db.raw.prepare(`
      SELECT processing_status, routed_to FROM inbound_events WHERE message_id = ?
    `).get(received.messageId);
    expect(row).toEqual({ processing_status: 'processing', routed_to: 'object' });
  });

  await runIngest(handler, msg);

  expect(msg.inboundSeq).toEqual(expect.any(Number));
  expect(db.raw.prepare(
    "SELECT COUNT(*) AS count FROM messages WHERE message_id = 'atomic-ingest-visible'",
  ).get()).toEqual({ count: 1 });
  expect(db.raw.prepare(
    "SELECT COUNT(*) AS count FROM inbound_events WHERE message_id = 'atomic-ingest-visible'",
  ).get()).toEqual({ count: 1 });
});

it('repairs a message-only crash window on redelivery instead of suppressing work', async () => {
  const db = makeTempDb();
  const messenger = makeMessenger();
  const runtime = makeRuntime();
  const durability = new DurabilityEngine(db);
  const msg = makeIncomingMessage({ messageId: 'redelivery-repair' });
  storeMessageIfNew(db, {
    chatJid: msg.chatJid,
    conversationKey: '15551230008',
    senderJid: msg.senderJid,
    senderName: msg.senderName,
    messageId: msg.messageId,
    content: msg.content,
    contentText: msg.contentText,
    contentType: msg.contentType,
    isFromMe: false,
    timestamp: msg.timestamp,
    quotedMessageId: msg.quotedMessageId,
    rawMessage: null,
  });

  await runIngest(
    makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability),
    msg,
  );

  expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
  expect(db.raw.prepare(`
    SELECT COUNT(*) AS count FROM inbound_events WHERE message_id = 'redelivery-repair'
  `).get()).toEqual({ count: 1 });
});
```

Add this import beside the existing message imports:

```ts
import { getMessagesBySender, storeMessageIfNew } from '../../src/core/messages.ts';
```

Also add a real-SQLite lifecycle matrix proving: `pending` never redispatches on transport redelivery even after its timestamp passes, `processing` and `turn_done` never redispatch, a due `deferred` row dispatches once with the original sequence, and terminal rows remain terminal. Hold event B in the live capacity queue beyond the nominal lease timestamp, redeliver it repeatedly, and prove no second pipeline, attempt inflation, or terminal exhaustion before releasing the original waiter. The queue test must inspect event B while it is still waiting for capacity, not only after `runtime.handleMessage()` begins.

Replace the old overflow-drop assertion in `tests/core/ingest-backpressure.test.ts` with this durability assertion (the test setup must construct and pass a real `DurabilityEngine`):

```ts
const dropped = db.raw.prepare(`
  SELECT processing_status, deferred_reason, replay_after
  FROM inbound_events WHERE message_id = 'msg-B'
`).get() as {
  processing_status: string;
  deferred_reason: string | null;
  replay_after: number | null;
};
expect(dropped.processing_status).toBe('deferred');
expect(dropped.deferred_reason).toBe('ingest_queue_full');
expect(dropped.replay_after).toEqual(expect.any(Number));
```

- [ ] **Step 2: Run the focused tests and confirm the old split fails**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/ingest.test.ts tests/core/ingest-backpressure.test.ts --pool=forks
```

Expected: FAIL because the current ingest path returns on an existing message before repairing the journal, and overflow leaves no durable deferred lifecycle.

- [ ] **Step 3: Add durability status-transition methods**

Extend `DurabilityStatements` and the constructor in `src/core/durability.ts` with these statements:

```ts
  markInboundProcessing: PreparedStatement;
  deferInbound: PreparedStatement;
  markAdmittedInboundSkipped: PreparedStatement;
  markAdmittedInboundFailed: PreparedStatement;
  getInboundOwnershipState: PreparedStatement;
  hasAnyTerminalOutbound: PreparedStatement;
  getAnyTerminalOutboundForInbound: PreparedStatement;
  getEchoedTerminalOutboundForInbound: PreparedStatement;
  hasEchoedTerminalOutbound: PreparedStatement;
  reconcileInboundTerminalFailure: PreparedStatement;
```

```ts
      markInboundProcessing: prepare(`
        UPDATE inbound_events
        SET processing_status = 'processing', routed_to = ?,
            lease_until = ?, deferred_reason = NULL, replay_after = NULL
        WHERE seq = ? AND processing_status = ? AND routed_to = ?
          AND attempt_count = ?
        RETURNING seq, routed_to, attempt_count
      `),
      deferInbound: prepare(`
        UPDATE inbound_events
        SET processing_status = 'deferred', deferred_reason = ?, replay_after = ?,
            lease_until = NULL, completed_at = NULL, terminal_reason = NULL,
            failure_class = NULL
        WHERE seq = ? AND processing_status = ? AND routed_to = ?
          AND attempt_count = ?
          AND NOT EXISTS (
            SELECT 1 FROM outbound_ops
            WHERE source_inbound_seq = ? AND is_terminal = 1
          )
      `),
```

Keep the existing legacy skipped transition for callers outside this PR, and add guarded admitted-message terminal transitions:

```ts
      markAdmittedInboundSkipped: prepare(`
        UPDATE inbound_events
        SET processing_status = 'complete', completed_at = datetime('now'),
            terminal_reason = ?, routed_to = ?, lease_until = NULL, replay_after = NULL
        WHERE seq = ? AND processing_status = ? AND routed_to = ?
          AND attempt_count = ?
          AND NOT EXISTS (
            SELECT 1 FROM outbound_ops
            WHERE source_inbound_seq = ? AND is_terminal = 1
          )
      `),
      markAdmittedInboundFailed: prepare(`
        UPDATE inbound_events
        SET processing_status = 'failed', completed_at = datetime('now'),
            terminal_reason = 'error', failure_class = ?, lease_until = NULL
        WHERE seq = ? AND processing_status = 'processing' AND routed_to = ?
          AND attempt_count = ?
          AND NOT EXISTS (
            SELECT 1 FROM outbound_ops
            WHERE source_inbound_seq = ? AND is_terminal = 1
          )
      `),
      hasAnyTerminalOutbound: prepare(`
        SELECT 1 AS present FROM outbound_ops
        WHERE source_inbound_seq = ? AND is_terminal = 1 LIMIT 1
      `),
      getInboundOwnershipState: prepare(`
        SELECT processing_status, routed_to, attempt_count
        FROM inbound_events WHERE seq = ?
      `),
      getAnyTerminalOutboundForInbound: prepare(`
        SELECT id, status, source_inbound_seq, source_inbound_route,
               source_inbound_attempt
        FROM outbound_ops
        WHERE source_inbound_seq = ? AND is_terminal = 1
        ORDER BY id DESC LIMIT 1
      `),
      getEchoedTerminalOutboundForInbound: prepare(`
        SELECT id, status, source_inbound_seq, source_inbound_route,
               source_inbound_attempt
        FROM outbound_ops
        WHERE source_inbound_seq = ? AND is_terminal = 1 AND status = 'echoed'
        ORDER BY id DESC LIMIT 1
      `),
      hasEchoedTerminalOutbound: prepare(`
        SELECT 1 AS present FROM outbound_ops
        WHERE source_inbound_seq = ? AND is_terminal = 1 AND status = 'echoed'
        LIMIT 1
      `),
      reconcileInboundTerminalFailure: prepare(`
        UPDATE inbound_events
        SET processing_status = 'failed', completed_at = datetime('now'),
            terminal_reason = 'error', failure_class = 'transport_send_failed',
            lease_until = NULL, replay_after = NULL
        WHERE seq = ? AND routed_to = ? AND attempt_count = ?
          AND processing_status IN ('pending', 'processing', 'deferred', 'turn_done')
          AND EXISTS (
            SELECT 1 FROM outbound_ops
            WHERE id = ? AND source_inbound_seq = ? AND is_terminal = 1
              AND status IN ('quarantined', 'failed_permanent')
              AND source_inbound_route = ? AND source_inbound_attempt = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM outbound_ops
            WHERE source_inbound_seq = ? AND is_terminal = 1 AND status = 'echoed'
              AND source_inbound_route = ? AND source_inbound_attempt = ?
          )
      `),
```

```ts
  markAdmittedInboundSkipped(
    claim: InboundOwnershipClaim,
    terminalReason: string,
    routedTo: string,
  ): 'changed' | 'already_terminal' | 'delivery_pending' | 'stale_claim' {
    const changed = Number(this.statements.markAdmittedInboundSkipped.run(
      terminalReason, routedTo,
      claim.seq, claim.status, claim.route, claim.attemptCount, claim.seq,
    ).changes) === 1;
    if (changed) return 'changed';
    const ownership = this.readInboundOwnershipState(claim.seq);
    if (!ownership
        || ownership.route !== claim.route
        || ownership.attemptCount !== claim.attemptCount) {
      if (this.recordStaleClaimIfLost(claim, 'skip')) return 'stale_claim';
      throw new Error('admitted skip ownership classification failed');
    }
    const status = ownership.status;
    if (status === 'complete' || status === 'failed') return 'already_terminal';
    if (this.classifyTerminalOutboundEvidenceForClaim(claim).outcome !== 'none') {
      return 'delivery_pending';
    }
    if (status === 'turn_done') return 'already_terminal';
    throw new Error('admitted skip transition invariant failed');
  }

  markAdmittedInboundFailed(
    claim: InboundProcessingClaim,
    failureClass: InboundFailureClass,
  ): 'changed' | 'already_terminal' | 'delivery_pending' | 'stale_claim' {
    const changed = Number(this.statements.markAdmittedInboundFailed.run(
      failureClass, claim.seq, claim.route, claim.attemptCount, claim.seq,
    ).changes) === 1;
    if (changed) return 'changed';
    const ownership = this.readInboundOwnershipState(claim.seq);
    if (!ownership
        || ownership.route !== claim.route
        || ownership.attemptCount !== claim.attemptCount) {
      if (this.recordStaleClaimIfLost(claim, 'failure')) return 'stale_claim';
      throw new Error('admitted failure ownership classification failed');
    }
    const status = ownership.status;
    if (status === 'complete' || status === 'failed') return 'already_terminal';
    if (this.classifyTerminalOutboundEvidenceForClaim(claim).outcome !== 'none') {
      return 'delivery_pending';
    }
    if (status === 'turn_done') return 'already_terminal';
    throw new Error('admitted failure transition invariant failed');
  }

  hasTerminalOutboundEvidence(seq: number): boolean {
    return this.statements.hasAnyTerminalOutbound.get(seq) !== undefined;
  }

  hasEchoedTerminalOutbound(seq: number): boolean {
    return this.statements.hasEchoedTerminalOutbound.get(seq) !== undefined;
  }

  reconcileInboundTerminalFailure(
    claim: InboundOwnershipClaim,
    outboundOpId: number,
  ): 'failed' | 'already_terminal' | 'echo_won' | 'delivery_pending' | 'stale_claim' {
    const before = this.readInboundOwnershipState(claim.seq);
    if (!before
        || before.route !== claim.route
        || before.attemptCount !== claim.attemptCount) {
      if (this.recordStaleClaimIfLost(claim, 'terminal_failure')) return 'stale_claim';
      throw new Error('terminal outbound failure ownership classification failed');
    }
    const currentEvidence = this.classifyTerminalOutboundEvidenceForClaim(claim);
    if (currentEvidence.outcome === 'exact'
        && currentEvidence.status === 'echoed') return 'echo_won';
    if (currentEvidence.outcome === 'non_current_or_invalid') return 'delivery_pending';
    if (currentEvidence.outcome !== 'exact'
        || currentEvidence.opId !== outboundOpId
        || !['quarantined', 'failed_permanent'].includes(currentEvidence.status)) {
      return 'delivery_pending';
    }
    const supplied = this.readTerminalOutboundOpForClaim(claim, outboundOpId);
    if (supplied.outcome !== 'exact'
        || !['quarantined', 'failed_permanent'].includes(supplied.status)) {
      throw new Error('terminal outbound failure reconciliation evidence mismatch');
    }
    const changed = Number(this.statements.reconcileInboundTerminalFailure.run(
      claim.seq, claim.route, claim.attemptCount,
      outboundOpId, claim.seq, claim.route, claim.attemptCount,
      claim.seq, claim.route, claim.attemptCount,
    ).changes) === 1;
    if (changed) return 'failed';
    const ownership = this.readInboundOwnershipState(claim.seq);
    if (!ownership
        || ownership.route !== claim.route
        || ownership.attemptCount !== claim.attemptCount) {
      if (this.recordStaleClaimIfLost(claim, 'terminal_failure')) return 'stale_claim';
      throw new Error('terminal outbound failure ownership classification failed');
    }
    const after = this.classifyTerminalOutboundEvidenceForClaim(claim);
    if (after.outcome === 'exact' && after.status === 'echoed') return 'echo_won';
    if (ownership.status === 'complete' || ownership.status === 'failed') {
      return 'already_terminal';
    }
    if (after.outcome !== 'none') return 'delivery_pending';
    throw new Error('terminal outbound failure reconciliation invariant failed');
  }
```

Before enabling the strict classifier, land the minimum claim-derived outbound
writers in this same Task 3 commit. `reserveOutboundForClaimOrThrow`
accepts the frozen `InboundProcessingClaim`, DB-derived transport target,
bounded op type/payload/replay policy plus an explicit `isTerminal`, and performs one immediate
`INSERT ... SELECT` whose predicate revalidates the current
sequence/route/attempt/status. It always writes all three
`source_inbound_seq/source_inbound_route/source_inbound_attempt` values and
returns only a safe-positive op ID plus the DB target. `sendTrackedForClaim`
is the one-item wrapper: it calls that reservation before transport, then advances only that exact op to
`submitted|maybe_sent`; a journal/reservation failure sends nothing. Every
admitted Chat/Agent/admin/outbound-queue visible output uses these seams.
Streaming/progress chunks reserve as nonterminal. The queue selects the final
exact claim-bound op ID and calls
`promoteOutboundTerminalForClaimOrThrow(claim, opId)`, whose immediate CAS
revalidates op/claim provenance, current ownership, terminal-owner absence, and
allowed op status before setting `is_terminal=1`. If that auxiliary op was
already echoed, the same transaction completes the exact inbound; otherwise a
later exact echo does. It returns an exact promotion receipt and never searches
for a latest op. The raw
`sendTracked`/`createOutboundOp` lanes remain only for explicitly inventoried
system/proactive work with `source_inbound_seq IS NULL`; an admitted claim can
never fall back to them, and `markLastTerminal` is removed. Task 5 refactors these writers into its combined
queue-capacity/target transaction rather than introducing the first provenance
writer, and Task 8 later replaces it with owner-handle batch reservation.

Add a real-DB caller inventory and tests for Chat terminal output, Agent queued
output, admitted admin notice, runtime failure notice, and system/proactive
counterexamples. Every admitted row must have exact route/attempt before the
first transport call; a held send followed by an exact stored echo completes
the same inbound. Add multi-chunk/progress/final-promotion, auxiliary early
echo, no-candidate, two-terminal race, and attempt-N-op/N+1-claim tests; only the
chosen exact op becomes terminal and early echo completes only during guarded
promotion. Null/mixed/mismatched provenance is accepted only for the
strict untouched legacy-attempt-zero case, remains unhealthy, and is never
silently backfilled. Removing any claim thread, swapping to raw `sendTracked`,
or writing the op after transport must make the Task 3 matrix RED.

On every zero-row claim-guarded skip/failure/deferral CAS, compare the persisted
route and attempt to the frozen claim **before** interpreting terminal status or
any sequence-level outbound evidence. Attempt N losing to N+1 is always
`stale_claim`, even if N+1 is terminal or an old/foreign terminal op exists.
Only a still-current exact tuple may return `already_terminal` or
`delivery_pending`. Add N→N+1 races with no op, an old-N terminal op, and a new-
N+1 terminal op; reordering the ownership comparison must make them RED.

Define `TerminalOutboundEvidenceForClaim` once in `src/core/durability.ts` and
use it at every lifecycle seam from this task onward. It loads all terminal rows
for the sequence with route/attempt, validates numeric/string shape **and the op
ID in SQL before JS conversion**, and returns one of `none`,
`exact{opId,status,legacy}`, or
`non_current_or_invalid{opId?,status?,reason}`. An ID whose SQLite integer is
outside `1..Number.MAX_SAFE_INTEGER` is invalid authority and increments the
provenance/authority health gauge without exposing a rounded `opId`. Among exact rows, any echoed proof
wins; otherwise the latest exact row wins. A modern exact match requires all
three persisted provenance fields to equal the frozen claim. Null provenance is
exact only when the persisted inbound itself is still the untouched legacy tuple
`attempt_count=0 AND lease_until IS NULL AND replay_after IS NULL`; implement
that narrow case in a separate guarded legacy statement rather than weakening
the modern SQL above. Mixed/null-modern/mismatched route or attempt is
`non_current_or_invalid`: it conservatively blocks resend/deferral, increments
the bounded provenance health gauge owned by this Task 3 boundary, and mutates no inbound row.
Never infer or backfill provenance from the current row.

Define `DurabilityHealthStats.invalidOutboundProvenance` here as the count of
nonterminal inbound rows having a linked terminal outbound row whose provenance
is mixed, whose route/attempt disagrees with the current exact claim, or whose
provenance is null outside the exact untouched legacy-attempt-zero exception. A
positive gauge emits one bounded `outbound_provenance_invalid` source and forces
health 503; proactive/system rows with `source_inbound_seq IS NULL` are excluded.
Add a durability/health inspection query returning only op ID, sequence, bounded
statuses, route, and attempt. Task 5 later adds the stopped-ingress operator
archive action; until then the WS-A02 runbook response is stop ingress, preserve
the DB, and do not resend or backfill guessed provenance. Test modern-null,
mixed-null corruption, forged route/attempt, proactive-null, exact legacy, event,
counter, health, and redaction behavior in this commit.

The dispatcher treats a false guarded result as benign only after rereading the
exact claim and classified terminal evidence; a still-current open row throws an
invariant error, while noncurrent/invalid evidence remains delivery-pending and
unhealthy. When post-connect recovery moves an exact linked terminal operation
to `quarantined` or `failed_permanent`, call the claim-bearing
`reconcileInboundTerminalFailure` immediately after that outbound transition.
This makes the exact inbound attempt terminally
`failed/transport_send_failed`, never complete, unless exact echo already won.
If the reconciliation write itself fails, the all-status terminal-evidence query
still blocks deferral/replay and the recovery boundary fails visibly. Add
close-vs-policy, echo-vs-late-runtime-error, echo-vs-quarantine,
attempt-N-op-vs-N+1-claim, modern-null, exact-legacy, and
quarantine-reconciliation-fault races proving no method overwrites `deferred`,
`turn_done`, `complete`, `failed`, or an echoed terminal outcome.
Place exact echo both before the general classification and between supplied-op
validation and the guarded failure UPDATE; both races return `echo_won` and
never throw or fail the inbound. The SQL `NOT EXISTS` exact-echo predicate is
the final race fence, not a replacement for the first classification.
For migrated legacy-null duplicates, the supplied failed op must also equal the
classifier's latest non-echo exact winner. Seed an older failed/quarantined row
plus a later pending/submitted legacy row: reconciliation remains
`delivery_pending` and cannot let the older failure override current precedence.
Validate every supplied reconciliation op ID as safe-positive before binding it.
Add raw `MAX_SAFE+1` and lossy `MAX_SAFE+2` op IDs beside an adjacent safe op;
classification/reconciliation must block the unsafe evidence and never read,
echo, fail, or complete the adjacent row.

Add a real-DB ambiguous-submission integration: the runtime uses
`sendTrackedForClaim` to create an exact linked terminal `submitted` (and
separately `maybe_sent`) op, then throws. `markAdmittedInboundFailed` must return
`delivery_pending`; the inbound stays open, admission and replay both refuse it,
and no second runtime/send occurs. A later `matchEcho` completes it. In the
unsafe/no-echo case, post-connect quarantine reconciles it to
`failed/transport_send_failed`, and a second restart never replays it. Mutating
the any-terminal guard or replacing the claim writer with raw `sendTracked`
must produce a duplicate-send, invalid-provenance health failure, or wrong-state
failure.

Add these exported types and methods:

Import `ADMISSION_LEASE_SECONDS` from `inbound-admission.ts` into
`durability.ts`; it is the only processing-lease duration owner.

```ts
export type InboundDeferredReason =
  | 'ingest_queue_full'
  | 'chat_queue_full'
  | 'agent_queue_full'
  | 'shutdown_deadline'
  | 'message_revision_requires_replay'
  | 'crash_recovery';
```

```ts
  markInboundProcessing(
    claim: PendingInboundClaim,
    routedTo: string,
    now = Math.floor(Date.now() / 1000),
  ): InboundProcessingClaim | null {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('invalid inbound processing time');
    }
    const leaseUntil = now + ADMISSION_LEASE_SECONDS;
    if (!Number.isSafeInteger(leaseUntil) || leaseUntil < 0) {
      throw new RangeError('inbound processing lease exceeds safe range');
    }
    const row = this.statements.markInboundProcessing.get(
      routedTo, leaseUntil,
      claim.seq, claim.status, claim.route, claim.attemptCount,
    ) as { seq: number; routed_to: string; attempt_count: number } | undefined;
    return row
      ? Object.freeze({
          seq: row.seq,
          status: 'processing' as const,
          route: row.routed_to,
          attemptCount: row.attempt_count,
        })
      : null;
  }

  private readInboundOwnershipState(seq: number): {
    status: string;
    route: string;
    attemptCount: number;
  } | null {
    const row = this.statements.getInboundOwnershipState.get(seq) as {
      processing_status: string;
      routed_to: string;
      attempt_count: number;
    } | undefined;
    return row ? {
      status: row.processing_status,
      route: row.routed_to,
      attemptCount: row.attempt_count,
    } : null;
  }

  isInboundClaimCurrent(claim: InboundOwnershipClaim): boolean {
    const current = this.readInboundOwnershipState(claim.seq);
    return current !== null
      && current.status === claim.status
      && current.route === claim.route
      && current.attemptCount === claim.attemptCount;
  }

  recordStaleClaimIfLost(
    claim: InboundOwnershipClaim,
    transition: 'skip' | 'failure' | 'deferral' | 'terminal_failure'
      | 'replay_invalid' | 'replay_exhaustion',
  ): boolean {
    const current = this.readInboundOwnershipState(claim.seq);
    if (current === null || (
      current.status === claim.status
      && current.route === claim.route
      && current.attemptCount === claim.attemptCount
    )) return false;
    this.staleClaimConflicts += 1;
    log.warn({
      event: 'inbound_stale_claim', inboundSeq: claim.seq, stage: transition,
      attemptCount: claim.attemptCount,
    });
    return true;
  }

  deferInbound(
    claim: InboundOwnershipClaim,
    reason: InboundDeferredReason,
    delaySeconds = 5,
    now = Math.floor(Date.now() / 1000),
  ): boolean {
    if (!Number.isSafeInteger(now) || now < 0
        || !Number.isSafeInteger(delaySeconds) || delaySeconds < 0) {
      throw new RangeError('invalid inbound deferral time');
    }
    const replayAfter = now + delaySeconds;
    if (!Number.isSafeInteger(replayAfter) || replayAfter < 0) {
      throw new RangeError('inbound deferral time exceeds safe range');
    }
    return Number(this.statements.deferInbound.run(
      reason, replayAfter,
      claim.seq, claim.status, claim.route, claim.attemptCount, claim.seq,
    ).changes) === 1;
  }
```

Add a compile/runtime table that invokes every transition literal, including
`terminal_failure`, and proves one exact stale-conflict increment. Also assert
the five-placeholder `markAdmittedInboundFailed` statement is invoked with
exactly `(failureClass, seq, route, attemptCount, seq)`; an added/duplicated bind
must fail the focused behavior test rather than survive as unexecuted pseudocode.

Table-drive `markInboundProcessing` clock validation through NaN, infinities,
negative/fractional/unsafe values and a safe `now` whose lease sum overflows.
Every invalid case leaves the pending claim unchanged and emits no claimed
counter/event; the exact safe boundary succeeds.

Add `inboundClaim?: InboundProcessingClaim` to `IncomingMessage`. It is optional
only for durability-disabled and explicitly synthetic jobs. For every admitted
message the dispatcher installs a fresh frozen copy and rejects a mismatch
unless `msg.inboundSeq === msg.inboundClaim.seq`; runtime code derives its
internal sequence from the claim rather than accepting two independent
authorities. Add a type-level readonly mutation rejection and a runtime mismatch
test. No caller may manufacture a claim from instance type or reread/remint
current authority after losing ownership. The private state read exists only to
classify a lost CAS; the public predicate answers equality without returning a
new claim. Add an export/reference scan proving no production owner can mint
authority from a bare sequence.

Keep `deferInbound` private or compatibility-scoped and add the required public wrapper:

```ts
  deferInboundOrThrow(
    claim: InboundOwnershipClaim,
    reason: InboundDeferredReason,
    delaySeconds = 5,
    now = Math.floor(Date.now() / 1000),
  ): 'deferred' | 'already_terminal' | 'delivery_pending' | 'stale_claim' {
    try {
      if (this.deferInbound(claim, reason, delaySeconds, now)) {
        this.deferralsByReason[reason] += 1;
        log.info({ event: 'inbound_deferred', inboundSeq: claim.seq, reason });
        return 'deferred';
      }
      const ownership = this.readInboundOwnershipState(claim.seq);
      if (!ownership
          || ownership.route !== claim.route
          || ownership.attemptCount !== claim.attemptCount) {
        if (this.recordStaleClaimIfLost(claim, 'deferral')) return 'stale_claim';
        throw new Error('inbound deferral ownership classification failed');
      }
      const status = ownership.status;
      if (status === 'complete' || status === 'failed') {
        log.debug({ event: 'inbound_deferral_already_terminal', inboundSeq: claim.seq, reason });
        return 'already_terminal';
      }
      if (this.classifyTerminalOutboundEvidenceForClaim(claim).outcome !== 'none') {
        log.info({ event: 'inbound_delivery_pending', inboundSeq: claim.seq, reason });
        return 'delivery_pending';
      }
      if (status === 'turn_done') {
        log.debug({ event: 'inbound_deferral_already_terminal', inboundSeq: claim.seq, reason });
        return 'already_terminal';
      }
      throw new Error('inbound deferral invariant failed');
    } catch (err) {
      this.deferralFailures += 1;
      log.error({
        event: 'inbound_deferral_failed', inboundSeq: claim.seq, reason,
        failureClass: classifyErrorForInbound(err),
      });
      throw err;
    }
  }
```

Every caller that defers already-admitted open work for capacity, shutdown, runtime failure, or recovery must use `deferInboundOrThrow`, inspect all four outcomes, and allow the invariant error or SQLite exception to reach its owning lifecycle/worker boundary. Task 5's combined access-decision transaction is the sole exception: it reactivates `complete/access_denied` rows as one atomic batch with its own post-commit telemetry contract. `delivery_pending` emits `inbound_delivery_pending` and leaves the inbound open for outbound reconciliation; it is never counted/scheduled as replay. `stale_claim` emits `inbound_stale_claim`, increments `staleClaimConflicts`, changes no row, and is an operator-visible ownership conflict rather than success. No caller may ignore a result, emit “retry scheduled” before `deferred`, or catch the error as normal success. Add a mutation test per caller family that forces `deferInbound` false while status remains open and proves the boundary rejects or reports a stale claim, does not increment the deferred/retry counter, and never mutates a newer owner. Add exact fixtures for `complete/failed -> already_terminal`, `turn_done` without terminal outbound evidence `-> already_terminal`, and `turn_done` with any terminal outbound evidence `-> delivery_pending`; the last case must never redispatch, and reversing the evidence/status check must make it RED.

Table-drive `now` and `delaySeconds` through NaN, both infinities, negatives,
fractions, unsafe integers, `MAX_SAFE_INTEGER`, and a safe pair whose sum
overflows. Invalid input throws before SQL/event/counter change and cannot bind
NULL/lossy replay state. On a zero write, compare current route/attempt before
terminal/evidence classification; attempt N losing to N+1 returns only
`stale_claim`, with and without old/new terminal ops.

Widen the existing exported `InboundStatus` union to include `deferred`, then
update every exhaustive switch, fixture factory, and health/status consumer in
the Task 3 file list. Add a compile-time exhaustiveness fixture plus real-DB
`getInboundStatus()` assertions for all six values; no consumer may cast a
deferred row to an older five-state union.

Extend the existing process-lifetime durability health snapshot with
`deferralsByReason: Record<InboundDeferredReason, number>` and
`deferralFailures: number` plus `staleClaimConflicts: number`.
`deferInboundOrThrow` increments the selected reason
only after the guarded write returns `deferred`; it increments
`deferralFailures` and emits bounded `inbound_deferral_failed` only when the
write throws or an open-row invariant reread fails. `already_terminal` has its
own event and `delivery_pending` has its own event; neither increments a deferral field. Return copies so callers cannot mutate
the counters. Tests assert one exact delta and matching row/event for every
reason plus the throw, lost-CAS, and already-terminal negative paths.

Initialize `private readonly deferralsByReason` with every `InboundDeferredReason` key at zero and `private deferralFailures = 0`. Wrap the private write in `try/catch`: increment the reason only after a changed row; on SQLite throw or an open-row/no-terminal invariant failure increment `deferralFailures`, emit `inbound_deferral_failed` with bounded reason/class, and rethrow. This field declaration and wrapper logic are part of the Task 3 exact implementation—not optional telemetry pseudocode.
Initialize `private staleClaimConflicts = 0` beside those fields; only a proven
route/status/attempt mismatch increments it, and success/terminal/delivery
outcomes do not. Return copied counters and add exact-delta tests.

Make startup recovery lease-aware in the same PR. Before ingress attaches, first
terminalize every leased `pending/admin` or `processing/admin` row as
`failed/admin_command_failed` with route `startup_admin_interrupted`; a restart
must never reinterpret an ambiguously executed command as model input. Then
atomically convert every remaining WS-A02 normal `pending` row with non-null
`lease_until` to immediately due `deferred/crash_recovery`; process restart
invalidates the prior process's admission ownership, so waiting for the old
wall-clock lease is unnecessary. Also convert a normal `processing` row with a
non-null WS-A02 lease through the guarded transition; legacy
`pending`/`processing` rows with null leases retain existing compatibility
behavior. Add restart tests for normal and admin kill boundaries before/after
the processing CAS. Normal work produces one due deferred row that Task 4 later
dispatches once; admin work emits `inbound_startup_admin_interrupted`, never
dispatches, and requires deliberate operator reconciliation. This is the
minimum compatibility needed for WS-A02 to be independently safe; the bounded
consumer remains WS-A03.

Implement the admin terminalization and normal pending conversion as bounded
CAS statements constrained by their exact current route/status/attempt snapshot,
non-null lease, and `NOT EXISTS` any linked terminal outbound operation. The
normal conversion additionally requires `routed_to <> 'admin'`, sets
`deferred/crash_recovery`, `replay_after=now`, and clears the lease. Rows with
terminal evidence remain delivery-pending for outbound reconciliation. Record
the exact changed counts as `inbound_startup_admin_interrupted` and
`inbound_startup_pending_recovered`; a second recovery run changes zero rows.
Never convert null-lease legacy rows, `turn_done`, terminal rows, or any row with
terminal outbound evidence.

- [ ] **Step 4: Rewire the normal ingest path around atomic admission**

Add this import in `src/core/ingest.ts`:

```ts
import {
  admitInboundMessage,
  classifyInboundAdmissionError,
  type InboundAdmissionErrorDisposition,
  type InboundAdmissionInput,
  type InboundAdmissionResult,
} from './inbound-admission.ts';
import type { InboundFailureClass } from './inbound-failure-class.ts';
import { config } from '../config.ts';
import { emitAlertChecked } from '../lib/emit-alert.ts';
```

Merge these specifiers into the module's existing `config` and
`inbound-failure-class` imports; do not paste duplicate bindings.

Add these bounded lifecycle types beside the handler contract:

```ts
export interface IngressBlockedSnapshot {
  blocked: true;
  stage: 'admission' | 'echo_correlation' | 'admitted_pipeline';
  disposition: InboundAdmissionErrorDisposition['disposition'];
  failureClass: InboundFailureClass;
  ownership?: Readonly<{
    seq: number;
    status: 'pending' | 'processing';
    route: string;
    attemptCount: number;
  }>;
  operationStage?: 'policy' | 'capacity' | 'dispatch' | 'admin_command';
}

export interface IngestHandlerOptions {
  onIngressBlocked?: (snapshot: IngressBlockedSnapshot) => void;
  admissionRetryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

class InboundAdmissionUnavailable extends Error {
  constructor(
    readonly disposition: InboundAdmissionErrorDisposition,
    options?: ErrorOptions,
  ) {
    super('durable inbound admission unavailable', options);
  }
}

class IngressAlreadyBlocked extends Error {
  constructor(
    readonly snapshot: IngressBlockedSnapshot,
    options?: ErrorOptions,
  ) {
    super('durable inbound ingress is blocked', options);
  }
}
```

Change the handler contract from a bare fire-and-forget function to an augmented production lifecycle:

```ts
export interface IngestHandler {
  (msg: IncomingMessage): void;
  close(): Promise<void>;
  idle(): Promise<void>;
  getIngressHealth(): IngressBlockedSnapshot | null;
}
```

Inside `createIngestHandler`, make `options` backward-compatible with an empty
default for existing direct test factories. Normalize
`(options.admissionRetryDelaysMs ?? [50, 200]).slice(0, 2)` with finite integer
clamping to `0..5_000`; two delays structurally permit at most three attempts,
even when a caller supplies a longer array. Default `sleep` to an awaited
`setTimeout` promise. Keep the private full failure cause separate from the
public bounded `ingressHealthSnapshot`. Define the two
helpers used by the replacement block exactly once in that closure:

```ts
  let lastInboundClockSample: number | null = null;
  const inboundNow = options.now ?? (() => Math.floor(Date.now() / 1_000));

  function requireValidatedInboundClockSample(): number {
    const value = inboundNow();
    if (!Number.isSafeInteger(value) || value < 0
        || (lastInboundClockSample !== null && value < lastInboundClockSample)) {
      throw new InboundAdmissionInvariantError('invalid_timestamp');
    }
    lastInboundClockSample = value;
    return value;
  }

  async function admitInboundMessageWithRetry(
    input: InboundAdmissionInput,
  ): Promise<InboundAdmissionResult> {
    for (let attempt = 0; ; attempt += 1) {
      if (ingressHealthSnapshot) {
        throw new IngressAlreadyBlocked(ingressHealthSnapshot, {
          cause: firstIngressBlockCause,
        });
      }
      try {
        return admitInboundMessage(db, input, requireValidatedInboundClockSample());
      } catch (err) {
        const disposition = classifyInboundAdmissionError(err);
        const delay = admissionRetryDelaysMs[attempt];
        if (disposition.disposition === 'retryable' && delay !== undefined) {
          log.warn(
            { ...disposition, event: 'inbound_admission_retry', stage: 'admission', attemptCount: attempt + 1 },
            'durable inbound admission retry scheduled',
          );
          await sleep(delay);
          continue;
        }
        throw new InboundAdmissionUnavailable(disposition, { cause: err });
      }
    }
  }

  function tripIngressBlocked(
    snapshot: IngressBlockedSnapshot,
    cause: unknown,
  ): void {
    if (ingressHealthSnapshot) return;
    firstIngressBlockCause = cause;
    accepting = false;
    ingressHealthSnapshot = Object.freeze(snapshot);
    const blockerEvent = {
      admission: 'inbound_admission_blocked',
      echo_correlation: 'inbound_echo_correlation_blocked',
      admitted_pipeline: 'inbound_admitted_pipeline_blocked',
    } as const satisfies Record<IngressBlockedSnapshot['stage'], string>;
    const event = blockerEvent[snapshot.stage];
    log.error(
      {
        event,
        stage: snapshot.stage,
        disposition: snapshot.disposition,
        failureClass: snapshot.failureClass,
        operationStage: snapshot.operationStage,
        inboundSeq: snapshot.ownership?.seq,
        attemptCount: snapshot.ownership?.attemptCount,
      },
      'durable inbound ingress blocked',
    );
    try {
      options.onIngressBlocked?.(snapshot);
    } catch (err) {
      log.error(
        { event: 'inbound_ingress_supervisor_failed', stage: snapshot.stage, failureClass: classifyErrorForInbound(err) },
        'durable inbound admission supervisor callback failed after latch',
      );
    }
    try {
      emitAlertChecked(
        config.botName,
        event,
        `whatsoup@${config.botName} durable inbound ingress blocked`,
        `stage=${snapshot.stage} disposition=${snapshot.disposition} failure_class=${snapshot.failureClass}`,
      );
    } catch (err) {
      log.error(
        { event: 'inbound_ingress_alert_failed', stage: snapshot.stage, failureClass: classifyErrorForInbound(err) },
        'durable inbound admission alert failed after latch',
      );
    }
  }

  function tripAdmittedPipelineBlocked(
    claim: InboundOwnershipClaim,
    operationStage: NonNullable<IngressBlockedSnapshot['operationStage']>,
    cause: unknown,
    failureClass: InboundFailureClass = classifyErrorForInbound(cause),
  ): void {
    tripIngressBlocked({
      blocked: true,
      stage: 'admitted_pipeline',
      disposition: 'blocked',
      failureClass,
      ownership: {
        seq: claim.seq, status: claim.status,
        route: claim.route, attemptCount: claim.attemptCount,
      },
      operationStage,
    }, cause);
  }
```

The latch has no in-process reset. An operator restores storage, runs the
documented canary, and restarts the instance; silently reopening ingress after
one successful probe would abandon the message whose pipeline already failed.
`rejected` and `unknown` dispositions therefore also trip the latch as invariant
or schema defects; only BUSY/LOCKED receives the bounded same-message retries.
The pipeline observer latches its rejection before removing the settled promise,
so `idle()`/shutdown and the top-level supervisor still observe it without a
permanent set entry.

Every attempt checks the latch before touching SQLite; waking from `sleep`
re-enters that check. A pipeline that has not committed admission aborts when a
peer trips the latch. A pipeline whose atomic admission already committed is
owned durable work and may continue to policy/capacity handling even if a peer
blocks immediately afterward. Add a two-pipeline test with one held retry and
one permanent blocker: after the blocker trips, releasing the sleeper produces
no additional SQLite attempt or runtime call. A long injected delay array still
produces at most three attempts.

`createIngestHandler` owns an `accepting` latch, the full private blocker cause,
its bounded `ingressHealthSnapshot`, a unique queue-owner token, a set of
observed async pipeline promises, and `firstPipelineError: { error: unknown } |
null`. `getIngressHealth()` returns a copy of that snapshot, so health truth does
not depend on the supervisor callback or alert sink succeeding. Change
`acquireSlot` from boolean to `'acquired' | 'queue_full' | 'shutdown'`; each
`QueuedItem` carries its eventual result. Invocation after `close()` is a bounded
rejected-admission event and starts no task. `close()` latches closed, removes
this handler's capacity waiters, marks each result `shutdown`, and resolves
it—without writing lifecycle state. The resumed owning pipeline performs exactly
one `deferInboundOrThrow`, selecting `shutdown_deadline` for `shutdown` and
`ingest_queue_full` for `queue_full`. This prevents close and the handler from
double-deferring the same row. Control and durability-disabled waiters retain
their characterized behavior; authenticated self-echoes never enter the
capacity queue and are tracked by the same in-flight/idle set. Move the global
semaphore/queue state behind this owner-aware handler or add the owner token to
every `QueuedItem`; shutdown must never drain another test/instance's queue.

Each invocation owns a mutable, non-exported `OwnedPipelineContext` whose claim
starts undefined, becomes the returned pending claim immediately after
admission, and is replaced through a dispatcher `onOwnershipChange` callback at
the processing CAS proof point. Its bounded `operationStage` is updated before
policy, capacity, dispatch, or admin awaits. Track each pipeline with a
catch-before-delete observer that records only the
first error and consumes the promise rejection to prevent an unhandled-rejection
warning. The observed promise is removed after it settles; errors are not kept
in the set forever. `idle()` repeatedly awaits a snapshot until the set is empty,
then reads and clears `firstPipelineError` and throws it once. This preserves a
failure that settled before `idle()` began without leaking promises. A second
`idle()` may resolve after that error was consumed, but the independent
admission-blocked health latch stays unhealthy until restart. Add a persistent
BUSY test that lets the pipeline fully settle before calling `idle()`: the first
call still rejects, the second has no stale promise/error, and readiness remains
blocked.

```ts
  interface OwnedPipelineContext {
    claim?: InboundOwnershipClaim;
    operationStage: NonNullable<IngressBlockedSnapshot['operationStage']>;
  }

  async function runInboundPipeline(
    msg: IncomingMessage,
    context: OwnedPipelineContext,
  ): Promise<void> {
    // Move the existing async handler body here; the replacement blocks below
    // update context synchronously at every ownership proof point.
  }

  const handlerFn = ((msg: IncomingMessage): void => {
    if (!accepting) {
      log.warn({ event: 'inbound_admission_rejected', reason: 'handler_closed' });
      return;
    }
    const context: OwnedPipelineContext = { operationStage: 'policy' };
    trackPipeline(runInboundPipeline(msg, context), context);
  });

  function trackPipeline(
    pipeline: Promise<void>,
    context: OwnedPipelineContext,
  ): void {
    let observed!: Promise<void>;
    observed = pipeline
      .catch((err: unknown) => {
        firstPipelineError ??= { error: err };
        if (context.claim && !ingressHealthSnapshot) {
          tripAdmittedPipelineBlocked(context.claim, context.operationStage, err);
        }
      })
      .finally(() => {
        ownedPipelines.delete(observed);
      });
    ownedPipelines.add(observed);
  }

  async function idle(): Promise<void> {
    while (ownedPipelines.size > 0) {
      await Promise.all([...ownedPipelines]);
    }
    if (firstPipelineError !== null) {
      const { error } = firstPipelineError;
      firstPipelineError = null;
      throw error;
    }
  }

  async function close(): Promise<void> {
    accepting = false;
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      const waiter = waiting[index]!;
      if (waiter.ownerToken !== queueOwnerToken) continue;
      waiting.splice(index, 1);
      ingestQueued = Math.max(0, ingestQueued - 1);
      waiter.result = 'shutdown';
      waiter.resolve('shutdown');
    }
    await Promise.resolve();
  }

  const handler: IngestHandler = Object.assign(handlerFn, {
    close,
    idle,
    getIngressHealth: (): IngressBlockedSnapshot | null => {
      if (!ingressHealthSnapshot) return null;
      return {
        ...ingressHealthSnapshot,
        ownership: ingressHealthSnapshot.ownership
          ? { ...ingressHealthSnapshot.ownership }
          : undefined,
      };
    },
  });
  return handler;
```

Removing an owned waiter decrements the queued counter exactly once and never
changes active-slot count. Add two-handler isolation and repeated-close tests;
both handlers' stats must return to zero without underflow or cross-owner drain.

An error before a claim is committed is already classified by the admission
catch. An error after admission must therefore have `context.claim`; a test-only
fault that removes the claim assignment is an invariant and must fail the
source-structure test. A post-admission policy DB throw is allowed to settle,
then must leave HTTP 503, detached ingress, the exact bounded ownership tuple in
health, a rejecting first `idle()`, and one guarded restart recovery. Consuming
the observed promise cannot clear the health latch.

Normal durable admission uses a three-attempt, timer-injected bounded retry for
`retryable` BUSY/LOCKED results before it trips the ingress blocker. A `blocked`,
`rejected`, exhausted-retry, or `unknown` result atomically stops this handler's
new normal admission, emits one bounded `inbound_admission_blocked` alert, calls
the `onIngressBlocked(snapshot)` supervisor callback, and rejects the owning
pipeline; it must not return as handled. The handler's snapshot makes readiness
unhealthy; the callback detaches new ingress outside the current pipeline so it
cannot deadlock on its own `idle()` promise. Existing already-admitted work still follows normal
drain/defer ownership. This is fail-closed outage behavior, not proof that an
uncommitted transport event can survive a storage outage; if upstream redelivery
is unavailable, that residual event is explicitly `Blocked` and the instance
cannot report ready. Tests use injected zero-delay timers, prove BUSY recovery on
the same message, and prove persistent BUSY plus READONLY/FULL each reject
`idle()`, trip readiness/ingress once, emit no success-shaped admission event,
and allow no runtime dispatch.

Add a held-capacity test that invokes the handler, confirms its normal row is already `pending`, calls `close()`, observes exactly one `deferred/shutdown_deadline` transition and no invariant error, releases the active task, and proves `idle()` settles before DB close. Add a held-admission/database-fault test proving `idle()` rejects and DB close is not reached. Removing promise tracking, queued deferral, the one-writer result, or the shutdown await must make one test RED. Replace test-only polling drains for owning ingest suites with `await handler.idle()`; retain the helper only for legacy suites until migrated, and do not cite it as production proof.

Move the existing control-plane intercept (`src/core/ingest.ts:163-203`) before
normal-message admission. Control messages keep their separate
`control_messages` storage contract. Move the existing side-effect-free
`parsedAdminCommand`/`getAdminCommand` helper declarations above the replacement
admission block as well; do not duplicate them or call a later `const` through
its temporal dead zone. Classification itself runs inside the guarded admission
`try`, so a parser/identity/database fault trips the storage-stage ingress latch
before any row or side effect.

Replace the normal store block at current lines 206-238 with this complete block:

```ts
        let conversationKey: string;
        let seq: number | undefined;
        let pendingClaim: PendingInboundClaim | undefined;
        let admissionState: Extract<InboundAdmissionResult, { accepted: true }>['state'] | undefined;
        let adminCommand: ReturnType<typeof getAdminCommand> = null;
        try {
          adminCommand = !msg.isFromMe ? getAdminCommand() : null;
          conversationKey = !msg.isGroup && isLidJid(msg.chatJid)
            ? resolvePhoneFromJid(msg.chatJid, db)
            : toConversationKey(msg.chatJid);

          const storeInput = {
            chatJid: msg.chatJid,
            conversationKey,
            senderJid: msg.senderJid,
            senderName: msg.senderName,
            messageId: msg.messageId,
            content: msg.content,
            contentText: msg.contentText ?? null,
            contentType: msg.contentType,
            isFromMe: msg.isFromMe,
            timestamp: msg.timestamp,
            quotedMessageId: msg.quotedMessageId,
            rawMessage: msg.rawMessage != null ? JSON.stringify(msg.rawMessage) : null,
            mentionedJids: msg.mentionedJids,
            isResponseWorthy: msg.isResponseWorthy,
            admissionRoute: adminCommand ? 'admin' as const : 'ingest' as const,
          };

          if (msg.isFromMe || !durability) {
            const isNew = storeMessageIfNew(db, storeInput);
            if (!isNew && !msg.isFromMe) {
              log.debug(
                { event: 'inbound_duplicate_rejected', admissionState: 'transport_duplicate' },
                'skipping duplicate message delivery',
              );
              return;
            }
            if (!isNew) {
              log.debug(
                { event: 'inbound_echo_duplicate', admissionState: 'prestored_echo' },
                'rechecking correlation for a previously stored self echo',
              );
            }
          } else {
            const admission = await admitInboundMessageWithRetry(storeInput);
            if (admission.accepted) {
              seq = admission.seq;
              pendingClaim = admission.claim;
              admissionState = admission.state;
              msg.inboundSeq = seq;
              msg.mentionedJids = [...admission.triggerMetadata.mentionedJids];
              msg.isResponseWorthy = admission.triggerMetadata.isResponseWorthy;
              context.claim = pendingClaim;
              context.operationStage = adminCommand ? 'admin_command' : 'policy';
              recordAdmissionResult(admission);
            } else {
              recordAdmissionResult(admission);
              log.debug(
                { event: 'inbound_duplicate_rejected', admissionState: admission.state },
                'skipping duplicate message delivery',
              );
              return;
            }
          }
        } catch (err) {
          if (err instanceof IngressAlreadyBlocked) throw err;
          if (context.claim) {
            tripAdmittedPipelineBlocked(context.claim, context.operationStage, err);
            throw err;
          }
          const disposition = err instanceof InboundAdmissionUnavailable
            ? err.disposition
            : classifyInboundAdmissionError(err);
          log.error(
            { ...disposition, stage: 'admission' },
            'failed to admit inbound message',
          );
          tripIngressBlocked({
            blocked: true, stage: 'admission',
            disposition: disposition.disposition,
            failureClass: disposition.failureClass,
          }, err);
          throw err instanceof InboundAdmissionUnavailable
            ? err
            : new InboundAdmissionUnavailable(disposition, { cause: err });
        }

        if (msg.isFromMe) {
          try {
            durability?.matchEcho(msg.messageId);
          } catch (err) {
            const disposition = classifyInboundAdmissionError(err);
            tripIngressBlocked({
              blocked: true, stage: 'echo_correlation',
              disposition: disposition.disposition,
              failureClass: disposition.failureClass,
            }, err);
            throw new InboundAdmissionUnavailable(disposition, { cause: err });
          }
          return;
        }
```

Immediately after this block, extract the current durability-disabled
paused/passive/admin/policy/capacity/runtime code verbatim into the local
`runLegacyInbound(msg, adminCommand)` helper (only bounded-log redaction changes
are permitted) and invoke it in one explicit branch:

```ts
if (!durability) {
  await runLegacyInbound(msg, adminCommand);
  return;
}
```

The helper executes and returns from allow/block/fallback admin commands before
normal policy/runtime, exactly as current main does. It creates no claim and
performs no new lifecycle mutation. The durable admin and durable dispatcher
blocks below are unreachable from that branch. Add paused, passive,
allow/block/fallback admin, denied, accepted, saturated, and runtime-throw parity
fixtures so the later mandatory `pendingClaim` assertion cannot break legacy
compatibility.

The self-echo branch never returns merely because `storeMessageIfNew` reports a
duplicate: storage may have committed before a crash that prevented correlation,
so every authenticated self-echo delivery re-runs `matchEcho`. Close the inverse
ordering race in `DurabilityEngine.markSubmitted`: after persisting the receipt's
non-null `waMessageId`, query the existing `messages` row for the same ID with
`is_from_me=1`; if it is already present, transition that exact outbound operation
to `echoed`. The submitted update plus pre-stored-echo check and the ingest
store-plus-match path must be ordered so either writer goes first safely: submit
first is completed by the later ingest match, while echo-store first is completed
by the later submitted check. Never infer an echo from submission alone, message
content, payload hash, or an untrusted `isFromMe=false` row.

Both live `matchEcho` and the pre-stored-echo branch in `markSubmitted` run one
exact transaction: resolve a single safe-positive op ID, load its persisted
source sequence/route/attempt, then load the current inbound ownership tuple.
Complete the inbound only when provenance equals the current tuple, with the
sole untouched legacy exception requiring attempt zero and all lease/replay
metadata null. An attempt-N echo arriving after N+1 owns the row may mark only
the exact old op echoed for audit; it returns stale/blocked and cannot complete
N+1. Modern null/mixed provenance is unhealthy and never completion proof. Add
both race directions, delayed N→N+1 echo, legacy-zero, modern-null, unsafe ID,
and adjacent-safe-op tests.

Add real-DB fault/race tests for both directions. One stores a genuine self echo,
simulates a crash before `matchEcho`, redelivers the duplicate, and proves the
linked terminal operation becomes `echoed` and the inbound completes. The other
holds `markSubmitted`, stores/matches the echo while the operation is still
`sending`, observes no premature completion, then releases `markSubmitted` and
proves its pre-stored-echo check completes the exact operation. Include a forged
non-self row with the same message ID and a duplicate non-self delivery; neither
may correlate. Removing the duplicate correlation or the post-submit pre-stored
check must make one focused test RED. Fault-inject `matchEcho` after successful
self-echo storage and prove the same health latch becomes HTTP 503 with
`stage='echo_correlation'`, ingress detaches, `idle()` retains the first failure,
and a later health request cannot return green merely because that rejection was
consumed. No raw message ID or database error enters the log/health body.

Delete the pre-dispatch paused, passive, access, response-worthiness, mention,
group-mode, sibling, and strict-group branches. They must all flow through the
single shared dispatcher below so its current-policy read, ALLOW race handling,
capacity ordering, telemetry, and immutable-claim CAS are identical for initial
and replay work. Admin parsing is side-effect-free and happened before admission
so its `admin` route committed with the row. Before any initial-only admin side
effect, convert that exact pending/admin claim to processing/admin; on success
terminalize that processing claim, and on error fail it with the new bounded
`admin_command_failed` class, trip the admitted-pipeline health latch, and
rethrow. Never swallow the exception:

```ts
if (adminCommand) {
  if (!pendingClaim) throw new Error('durable admin command missing pending claim');
  if (pendingClaim.route !== 'admin') {
    throw new Error('admin command admission route mismatch');
  }
  const adminClaim = durability.markInboundProcessing(pendingClaim, 'admin');
  if (!adminClaim) {
    throw new Error('admin command processing claim lost before side effect');
  }
  context.claim = adminClaim;
  context.operationStage = 'admin_command';
  try {
    if (adminCommand.action === 'fallback') {
      await handleFallbackCommand(runtime, messenger, adminCommand, msg.chatJid, durability);
    } else {
      await handleAdminCommand(
        db, messenger, adminCommand.action, adminCommand.subjectType,
        adminCommand.subjectId, msg.chatJid,
        (m) => runtime.handleMessage(m), durability,
      );
    }
  } catch (err) {
    const failureOutcome = durability.markAdmittedInboundFailed(
      adminClaim, 'admin_command_failed',
    );
    switch (failureOutcome) {
      case 'changed':
      case 'already_terminal':
      case 'delivery_pending':
      case 'stale_claim':
        break;
      default: {
        const neverFailure: never = failureOutcome;
        throw new Error(`unhandled admin failure outcome: ${neverFailure}`);
      }
    }
    tripAdmittedPipelineBlocked(
      adminClaim, 'admin_command', err, 'admin_command_failed',
    );
    throw err;
  }
  const outcome = durability.markAdmittedInboundSkipped(
    adminClaim, 'admin_command', 'admin',
  );
  switch (outcome) {
    case 'changed':
      return;
    case 'delivery_pending':
      log.info({ event: 'inbound_delivery_pending', inboundSeq: seq, stage: 'admin_command' });
      return;
    case 'already_terminal':
    case 'stale_claim':
      {
        const completionError = new Error('admin command completion lost ownership');
        tripAdmittedPipelineBlocked(
          adminClaim, 'admin_command', completionError, 'admin_command_failed',
        );
        throw completionError;
      }
    default: {
      const neverOutcome: never = outcome;
      throw new Error(`unhandled policy transition outcome: ${neverOutcome}`);
    }
  }
}
```

Durability-disabled admin behavior remains the explicit legacy compatibility
path. Startup recovery terminally fails any leased `pending/admin` or
`processing/admin` row with `admin_command_failed`, emits
`inbound_startup_admin_interrupted`, and never converts it to deferred/replay.
This is fail-closed ambiguous-command handling: an operator inspects the access
row/outbound journal before deliberately retrying. Add process-kill fixtures
after admission, after processing claim, during the access mutation, and after
the tracked notice; none may reach model runtime or repeat automatically after
restart. Task 5 later makes the access mutation plus replay queue one transaction.
No paused/passive/access/trigger branch may call a terminal helper before the
shared dispatcher. Add a source-structure test that permits only this
claim-first admin boundary between admission and `dispatchAdmitted`, plus
real-row assertions for `admin_command/admin`, `admin_command_failed`, and lost
claim states.

After initial-only admin handling, export this bounded result and factory. `main.ts` creates exactly one `dispatchAdmitted` function with `createAdmittedInboundDispatcher({ db, runtime, getBotJid, getBotLid, durability, instanceType, pausedChats })`, passes it into `createIngestHandler`, and later gives the same function to the replay worker:

```ts
export type AdmittedGenericPolicySkipReason =
  | 'chat_paused'
  | 'passive_instance'
  | 'not_response_worthy'
  | 'not_mentioned'
  | 'groups_only_no_dms'
  | 'self_only_no_groups'
  | 'self_only_rejected'
  | 'self_only_lid_unresolvable'
  | 'lid_unresolvable'
  | 'sender_blocked'
  | 'sibling_bot'
  | 'strict_group_non_allowlisted';

export type AdmittedInboundDispatchResult =
  | { outcome: 'dispatched' }
  | { outcome: 'deferred'; reason: InboundDeferredReason; replayAfter: number }
  | { outcome: 'policy_skipped'; reason: AdmittedGenericPolicySkipReason }
  | {
      outcome: 'policy_skipped';
      reason: 'access_denied';
      accessCause: 'unknown' | 'pending' | 'blocked';
    }
  | { outcome: 'already_terminal' }
  | { outcome: 'delivery_pending' }
  | { outcome: 'stale_claim'; stage: 'capacity' | 'dispatch' | 'runtime_failure' }
  | {
      outcome: 'runtime_failed';
      failureClass: InboundFailureClass;
      claim: InboundProcessingClaim;
    };

export type InboundCapacityResult =
  | { outcome: 'acquired'; release: () => void }
  | { outcome: 'queue_full' | 'shutdown' };

export type AdmittedInboundDispatchOwnership =
  | {
      claim: 'pending';
      pendingClaim: PendingInboundClaim & { readonly route: 'ingest' };
      origin: 'initial_side_effect_safe';
      acquireCapacity: () => Promise<InboundCapacityResult>;
      onOwnershipChange: (claim: InboundProcessingClaim) => void;
      onUnknownSender?: () => Promise<void>;
    }
  | {
      claim: 'pending';
      pendingClaim: PendingInboundClaim & { readonly route: 'ingest' };
      origin: 'repaired_missing_journal' | 'transport_reclaim';
      acquireCapacity: () => Promise<InboundCapacityResult>;
      onOwnershipChange: (claim: InboundProcessingClaim) => void;
      onUnknownSender?: never;
    }
  | {
      claim: 'processing';
      processingClaim: InboundProcessingClaim;
      source: 'replay';
    };

export interface CreateAdmittedInboundDispatcherOptions {
  db: Database;
  runtime: Runtime;
  getBotJid: () => string;
  getBotLid: () => string | null;
  durability: DurabilityEngine;
  instanceType: string;
  pausedChats: ReadonlySet<string>;
}

export type AdmittedInboundDispatcher = (
  msg: IncomingMessage,
  ownership: AdmittedInboundDispatchOwnership,
) => Promise<AdmittedInboundDispatchResult>;

export function createAdmittedInboundDispatcher(
  options: CreateAdmittedInboundDispatcherOptions,
): AdmittedInboundDispatcher;
```

It must re-run current `isResponseWorthy`, pause, passive-instance, and
`shouldRespond` checks on every call. Add a total
`normalizeAdmittedPolicyRejection(msg, triggerResult)` mapping: only DM
`unknown`, `pending`, and `blocked` access outcomes become
`access_denied{accessCause}` and are eligible for the Task 5 ALLOW transaction;
group sender blocks normalize to `sender_blocked`. Every trigger/mode denial
maps to one exact `AdmittedGenericPolicySkipReason`; an unknown source reason is
an invariant error, never a permissive default or `access_denied`. Policy
rejection calls `markAdmittedInboundSkipped` with the exact supplied pending or
processing claim; it returns `policy_skipped` only when that CAS returns
`changed`, returns `already_terminal` distinctly for a terminal losing CAS,
`delivery_pending` for outbound reconciliation ownership, and `stale_claim` for
a newer attempt. A denied replay atomically becomes `complete` with its exact
bounded reason/route and never calls runtime; replay never runs admin parsing or
approval delivery. Only a proven `new` or live history-placeholder upgrade maps
to `initial_side_effect_safe` and may receive `onUnknownSender` for an
`access_denied` result whose cause is `unknown`. A
`repaired_missing_journal` row is not first-side-effect proof because historical
code sent approval before journaling; a due transport reclaim is also not
initial. Both variants forbid the callback at the type boundary, and replay
omits it. Tests must
table-drive every source reason, assert exact terminal reason and requeue
eligibility, prove `not_response_worthy`, `not_mentioned`, group/mode, sibling,
and strict-group denials can never reopen after ALLOW, and prove a sender admitted
while allowed but revoked before replay avoids runtime. Add a losing-policy-CAS
fixture proving no `policyRejectedAfterAdmission`/`policySkipped` counter or
success event increments on `already_terminal` or `stale_claim`.

For the initial path, the per-call `acquireCapacity` callback runs only after
that policy decision succeeds. It returns either an acquired lease with one
idempotent `release()` or the existing capacity/shutdown outcome. The dispatcher
owns the lease in `try/finally`; on rejection it calls
`deferInboundOrThrow(pendingClaim, reason, 0)` and returns the exact bounded
outcome without marking processing or calling runtime. Replay omits this ingress
capacity callback because it already owns a worker claim. Add saturated
access-denied, paused, passive, and response-unworthy cases proving each
terminalizes through policy with no deferred row, runtime call, or inappropriate
approval side effect. Mutating capacity ahead of policy must make every case RED.
Table-drive all three `InboundCapacityResult` members, call the acquired
`release()` twice, and assert the underlying semaphore is released exactly once.
The factory/options/function signature above is the sole exported dispatcher
surface; compile fixtures must reject a missing ownership variant, a raw runtime
callback, and a non-exhaustive result switch.

After an initial waiter acquires its lease, re-run the same side-effect-free
current-policy decision immediately before `pending -> processing`. This second
check uses the same generic/access-denial transaction and result mapping; it
does not resend an unknown-sender approval. A changed policy terminalizes the
pending claim and the `finally` releases capacity. Add held-waiter cases that
change BLOCK/ALLOW state, pause the chat, and change response-worthiness/trigger
policy while waiting. None may call runtime under its stale pre-wait decision.

Use `IngestHandlerOptions.now` (the existing defaulted options object; do not add
a second trailing object). At handler construction create a closure-local
`requireValidatedInboundClockSample`: sample the injected/default epoch-second
clock, require a nonnegative safe integer, reject a value below the prior sample,
then store/return it. No runtime or caller supplies retry time. Table-drive NaN,
infinities, fractions, negatives, unsafe integers, a backward second sample, and
a fresh later sample through due-redelivery failure; invalid samples perform no
retry/exhaustion write and trip the admitted-pipeline blocker with bounded stage.

Replace current lines 343-359 with this capacity-and-dispatch block:

```ts
        if (!pendingClaim || pendingClaim.route !== 'ingest') {
          throw new Error('durable inbound dispatch missing pending claim');
        }
        if (!admissionState) {
          throw new Error('durable inbound dispatch missing admission state');
        }
        const onOwnershipChange = (claim: InboundProcessingClaim): void => {
            context.claim = claim;
            context.operationStage = 'dispatch';
        };
        const acquireCapacity = async (): Promise<InboundCapacityResult> => {
            context.operationStage = 'capacity';
            const slot = await acquireSlot(msg);
            if (slot !== 'acquired') return { outcome: slot } as const;
            context.operationStage = 'policy';
            let released = false;
            return {
              outcome: 'acquired' as const,
              release: () => {
                if (released) return;
                released = true;
                releaseSlot();
              },
            };
        };
        let ownership: AdmittedInboundDispatchOwnership;
        switch (admissionState) {
          case 'new':
          case 'upgraded_history_placeholder':
            ownership = {
              claim: 'pending', pendingClaim, origin: 'initial_side_effect_safe',
              acquireCapacity, onOwnershipChange,
              onUnknownSender: async () => {
                const approvalPhone = resolvePhoneFromJid(msg.senderJid, db);
                await sendApprovalRequest(
                  db, messenger, approvalPhone, msg.senderName ?? '', msg.content ?? '', durability,
                );
              },
            } satisfies AdmittedInboundDispatchOwnership;
            break;
          case 'repaired_missing_journal':
            ownership = {
              claim: 'pending', pendingClaim, origin: 'repaired_missing_journal',
              acquireCapacity, onOwnershipChange,
            } satisfies AdmittedInboundDispatchOwnership;
            break;
          case 'reclaimed_due_deferred':
            ownership = {
              claim: 'pending', pendingClaim, origin: 'transport_reclaim',
              acquireCapacity, onOwnershipChange,
            } satisfies AdmittedInboundDispatchOwnership;
            break;
          default: {
            const neverAdmissionState: never = admissionState;
            throw new Error(`unhandled accepted admission state: ${neverAdmissionState}`);
          }
        }
        const dispatchResult = await dispatchAdmitted(msg, ownership);
        switch (dispatchResult.outcome) {
          case 'dispatched':
          case 'policy_skipped':
          case 'already_terminal':
            return;
          case 'deferred':
            ingestDeferred += 1;
            return;
          case 'delivery_pending':
            log.info({ event: 'inbound_delivery_pending', inboundSeq: seq, stage: 'dispatch' });
            return;
          case 'stale_claim':
            // Durability owns the single stale-claim event/counter.
            return;
          case 'runtime_failed': {
            if (!durability || seq === undefined) {
              throw new Error('runtime failure returned without durable inbound ownership');
            }
            const failureOutcome = admissionState === 'reclaimed_due_deferred'
              ? durability.settleFailedReplayAttemptOrThrow(
                  dispatchResult.claim,
                  dispatchResult.failureClass,
                  requireValidatedInboundClockSample(),
                )
              : durability.markAdmittedInboundFailed(
                  dispatchResult.claim, dispatchResult.failureClass,
                );
            switch (failureOutcome) {
              case 'changed':
              case 'deferred':
              case 'failed':
                return;
              case 'already_terminal':
                log.debug({
                  event: 'inbound_failure_already_terminal', inboundSeq: seq,
                  stage: 'runtime_failure', failureClass: dispatchResult.failureClass,
                });
                return;
              case 'delivery_pending':
                log.warn({
                  event: 'inbound_delivery_pending', inboundSeq: seq,
                  stage: 'runtime_failure', failureClass: dispatchResult.failureClass,
                });
                return;
              case 'stale_claim':
                // Durability owns the single stale-claim event/counter.
                return;
              default: {
                const neverOutcome: never = failureOutcome;
                throw new Error(`unhandled inbound failure outcome: ${neverOutcome}`);
              }
            }
          }
          default: {
            const neverResult: never = dispatchResult;
            throw new Error(`unhandled admitted dispatch result: ${JSON.stringify(neverResult)}`);
          }
        }
```

`settleFailedReplayAttemptOrThrow` is the one retry/exhaustion SSOT used here
and by Task 4's worker. In one ownership-first transaction it revalidates the
safe clock and exact claim, returns terminal-evidence outcomes without writing,
defers below `MAX_INBOUND_ATTEMPTS` with `replayBackoffSeconds(attemptCount)`,
defined once as
`min(300, 30 * 2 ** min(4, max(0, attemptCount - 2)))`, and writes
`failed/crash_recovery` at the ceiling. The initial and journal-repair modes keep
the one-attempt failure transition; only a due-deferred reclaim enters the retry
budget. Add below-cap, exact-cap, invalid-second-clock, exact/ambiguous terminal
evidence, and N/N+1 races through both transport redelivery and worker callers;
their DB state and due-time outcomes must match. Add historical crash fixtures
after approval/before journal and after approval/before a later CAS: missing-
journal repair and due reclaim must produce zero additional approval calls.

`replayBackoffSeconds` accepts only a safe integer in
`1..MAX_INBOUND_ATTEMPTS-1`, validates multiplication/result safety, and returns
a safe integer in `30..300`. Table-drive every legal attempt plus zero,
negative, fractional, non-finite, unsafe, and at/above-ceiling inputs. Only
`settleFailedReplayAttemptOrThrow` calls this pure helper inside its ownership
transaction; transport reclaim and the worker call the settlement API, never the
formula. Source inventory requires one formula call site plus both settlement
caller families; any copied/out-of-transaction schedule is a blocker.

Do not delete capacity behavior globally. Preserve the original early gate for trusted control messages and durability-disabled operation. Move authenticated `isFromMe` storage plus `matchEcho` ahead of `acquireSlot`, with no runtime dispatch, so an echo cannot be evicted behind ordinary inbound work. Only normal durability-enabled inbound enters atomic admission, completes access/policy evaluation, and then uses the capacity-and-dispatch block above. A message that is evicted while waiting transitions `pending → deferred`; runtime dispatch requires winning the `pending → processing` CAS immediately before the call.

Add a saturation test that fills every ingest slot/waiter, then delivers a genuine self-echo and proves `matchEcho` runs, the linked `outbound_ops` row becomes `echoed`, and its inbound completes without changing queue depth. Add a negative fixture with `isFromMe=false` and a copied message ID/JID shape; it must follow normal admission/policy and never invoke the priority correlation path. Removing the priority branch must make the echo test RED.

In `main.ts`, retain the handler rather than assigning the factory call inline;
the handler owns the process-lifetime health snapshot and main owns ingress
detachment:

```ts
const dispatchAdmitted = createAdmittedInboundDispatcher({
  db,
  runtime,
  getBotJid: () => connectionManager.botJid ?? '',
  getBotLid: () => connectionManager.botLid,
  durability,
  instanceType,
  pausedChats: config.pausedChats ?? new Set<string>(),
});
let ingestHandler!: IngestHandler;
ingestHandler = createIngestHandler(
  db,
  connectionManager,
  runtime,
  () => connectionManager.botJid ?? '',
  () => connectionManager.botLid,
  durability,
  instanceType,
  dispatchAdmitted,
  {
    onIngressBlocked: () => {
      if (connectionManager.onMessage === ingestHandler) {
        connectionManager.onMessage = null;
      }
    },
  },
);
connectionManager.onMessage = ingestHandler;
```

Extend `HealthDeps` with
`getIngressHealth?: () => IngressBlockedSnapshot | null`; pass
`() => ingestHandler.getIngressHealth()` from main. `/health` reads it once per request, forces
`status='unhealthy'` (therefore HTTP 503) when blocked, and exposes only
`ingress: { blocked: true, stage, disposition, failure_class, operation_stage?, ownership? }`, where ownership contains only sequence/status/route/attempt. No raw SQLite
error or message identity enters the body. Add a health test for the 503/body
and a main wiring test that invokes the callback, observes `onMessage=null`,
then proves a subsequent inbound cannot start while the already-owned rejected
promise remains visible to `idle()`. There is no callback path that restores
readiness in the same process. Fault-inject both the supervisor callback and
alert emitter and prove `getIngressHealth()` still returns the latched blocker,
new work is rejected, and the original admission disposition reaches `idle()`.

Give all three blocker stages distinct durable alert sources:
`inbound_admission_blocked`, `inbound_echo_correlation_blocked`, and
`inbound_admitted_pipeline_blocked`. None has
an in-process clear site. Before a restarted process attaches ingress, run a
rollback-only main-database canary that performs a real admission-compatible
insert and the exact stored-self-echo/submitted-operation correlation CAS using
synthetic bounded IDs, then rolls the transaction back without emitting normal
success counters/events. The admitted-pipeline canary additionally runs the
side-effect-free policy mapping, pending-to-processing claim CAS, and one guarded
terminal CAS inside that same rollback-only transaction; a no-op mock is not
proof. Only a successful post-restart stage-specific canary may call
`clearAlertSourceChecked` for the matching source, with stage-specific evidence.
Because the incident may have been opened by the previous process, fresh proof
issues one idempotent clear even when process-local incident knowledge is unknown;
a read-only/full/corrupt error, a missing correlation transition, or a
same-process latch withholds clear. The clear is idempotent and never resets
`accepting`. Add persisted-incident restart tests for each
source, plus fault-injected admission and echo canaries proving no clear is
issued until the corresponding fresh proof passes.

Update every production/test call returned by
`rg -l 'createIngestHandler\(' src tests`; no call may retain the obsolete
signature or bypass the shared dispatcher with a raw runtime callback. Test
factories may omit the optional callback, but admission-failure suites pass a
spy and assert the original disposition.

`createAdmittedInboundDispatcher` receives either `{ claim: 'pending' }` or
`{ claim: 'processing'; processingClaim: InboundProcessingClaim }`. For
`pending`, it must win `markInboundProcessing` immediately before runtime and
invoke `onOwnershipChange` synchronously with the returned immutable claim
before any subsequent await or throwable DB/runtime work. Replay passes the exact claim returned by its
already-completed CAS; the dispatcher verifies sequence, route, attempt, and
current processing state before runtime. It installs that claim on the runtime
message and returns the same claim in `runtime_failed`. A lost claim whose
reread is terminal returns `already_terminal`; a newer route/attempt returns a
bounded stale-claim outcome to the owner; any other open mismatch throws. In
either mode it terminalizes current-policy rejection before returning, but it
does **not** persist runtime failures: it returns the bounded `runtime_failed`
result and the owning caller performs exactly one claim-guarded transition
(a proven fresh/history-upgrade or message-only journal repair marks failed;
transport-reclaimed ingest and worker replay both use the shared bounded
retry/exhaustion settlement).

Keep the `try/catch` around only the provider/runtime execution. Task 5 changes a rejected Chat/Agent queue admission into a bounded `RuntimeQueueRejection` return; after the runtime call leaves that catch, the dispatcher is the sole owner that calls `deferInboundOrThrow` with the exact processing claim. It exhaustively maps `deferred`, `already_terminal`, `delivery_pending`, and `stale_claim` to the same durable dispatch result. A SQLite or invariant error from that deferral is therefore outside the runtime-failure conversion and reaches the initial lifecycle or replay-worker boundary. No runtime or direct caller may mutate inbound deferral state. Before returning `dispatched`, the dispatcher checks for terminal outbound evidence and rereads the terminal inbound state so a late race becomes `delivery_pending` or `already_terminal`, never a false dispatch count. It logs only `{ inboundSeq, stage, failureClass, route, attemptCount }`; it never logs raw errors, message IDs, JIDs, content, or stacks. The replay worker in Task 4 imports this function rather than accepting a raw runtime callback.

Add `DurabilityEngine.getInboundDeferral(seq)` backed by a prepared statement that returns `{ reason, replayAfter }` only for a currently deferred row. The dispatcher reads it only after its own successful `deferInboundOrThrow` transition; tests remove that read and prove a queue rejection cannot be falsely counted as dispatch or return an invented due time.

Because replay deliberately calls `shouldRespond`, mechanically replace every policy log payload in `src/core/access-policy.ts` that currently contains `messageId`, `senderJid`, `chatJid`, or resolved phone with `{ event: 'access_policy_decision', reason, accessStatus, accessMode, isGroup, mentioned? }`; all fields are bounded except booleans. Do not log bot mention identifiers. Capture self-only, unresolved LID, blocked, strict-group, auto-group, and mention paths and assert the fixture identifiers/content are absent from serialized logs while return values remain identical.

In the modified `preConnectRecovery` outer catch, replace `{ err }` with `{ event: 'inbound_startup_recovery_failed', stage: 'inbound_recovery', failureClass: classifyErrorForInbound(err) }` and rethrow or return a failure result that blocks startup; it must not swallow a failed pending/processing deferral and continue attaching ingress.

Before `preConnectRecovery` or any periodic recovery/sweep materializes an open
row, run a SQL-only open-authority probe over `pending`, `processing`,
`turn_done`, `deferred`, and admin routes for `typeof(seq) <> 'integer' OR seq <
1 OR seq > 9007199254740991` plus the status-appropriate safe bounds/null rules
for attempt and lease fields. A hit latches
`inbound_startup_invalid_authority`, keeps ingress/readiness blocked, and
returns only bounded counts; it never converts/rebinds the unsafe ID in JS. The
turn-done recovery query and periodic stuck-inbound sweep repeat the same SQL
predicate before selecting rows and refuse to materialize any unsafe value. Add
raw unsafe IDs beside an adjacent safe row for pending, processing, turn_done,
deferred, and admin routes. Startup and the periodic sweep must leave each
adjacent row byte-for-byte unchanged, perform no terminal reconciliation, and
expose the invalid-authority health gauge for deliberate SQL-only repair.

Extend the ingest stats snapshot with monotonic `admitted`, `repaired`, `duplicateRejected`, `deferred`, `processingClaimed`, `policyRejectedAfterAdmission`, `runtimeFailed`, and `transportAttemptExhausted` counters. Increment each at the state transition that proves it, test deltas rather than global absolute values, and keep message IDs, JIDs, and content out of metric dimensions.

```ts
export interface IngestStats {
  active: number;
  queued: number;
  dropped: number;
  admitted: number;
  repaired: number;
  duplicateRejected: number;
  deferred: number;
  processingClaimed: number;
  policyRejectedAfterAdmission: number;
  runtimeFailed: number;
  transportAttemptExhausted: number;
}
```

Implement one `recordAdmissionResult(result)` switch in `ingest.ts`. For an
accepted result, first install its exact claim in `OwnedPipelineContext`, then
call the switch before any later policy/capacity await; for a non-accepted
result, call it before returning. The switch is exhaustive over
`InboundAdmissionState` (`const neverState: never = result.state` in default) so
a new state cannot silently miss telemetry. It applies the overlap semantics
below and emits exactly one primary event per result; no scattered branch
increments are allowed. Fault-injected telemetry after accepted commit must
latch the admitted pipeline with that exact claim.

Accepted `new` and due-deferred claims increment `admitted` and emit
`inbound_admitted` with only `admissionState`; repaired-missing-journal and
upgraded-history-placeholder increment both `admitted` and `repaired` and emit
`inbound_admission_repaired`. Every `accepted:false` increments
`duplicateRejected`; `duplicate_mutated_deferred` additionally increments
`deferred` and emits `inbound_message_revision_deferred`.
`duplicate_exhausted` additionally increments
`transportAttemptExhausted` and emits `inbound_transport_exhausted` instead of a
success event. The shared dispatcher increments/emits `processingClaimed` only
after its CAS, `policyRejectedAfterAdmission` only after a guarded `changed`
policy outcome, and `runtimeFailed` only after returning the bounded
runtime-failed result. `already_terminal` increments no policy success counter.
`getIngestStats()` returns all fields as a new object. Table-driven tests
snapshot before/after each state, assert exact deltas/events/DB rows, and remove
each increment/event in a mutation run.

- [ ] **Step 5: Run the ingest semantic probes**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-admission.test.ts tests/core/inbound-failure-class.test.ts tests/core/durability.test.ts tests/core/ingest.test.ts tests/core/ingest-backpressure.test.ts tests/core/ingest-control.test.ts tests/core/ingest-paused-chats.test.ts tests/core/ingest-fallback-routing.test.ts tests/core/access-policy.test.ts tests/core/admin.test.ts tests/core/health.test.ts tests/main-bootstrap.test.ts tests/integration/heal-flow.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/outbound-queue.test.ts tests/runtimes/agent/outbound-queue-idempotency.test.ts tests/runtimes/passive/runtime.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
```

Expected: PASS. Inspect the overflow test output to confirm the rejected message has one `messages` row and one `inbound_events` row with `processing_status='deferred'`. Confirm control and durability-disabled behavior is unchanged, saturated authenticated echoes correlate outside the queue, forged/non-self messages cannot use that lane, admission/echo-correlation failure latches survive promise cleanup, the health response is 503, persisted alerts clear only after their stage-specific fresh restart canary, and startup recovery defers lease-managed processing without changing legacy null-lease behavior. Recompute and stage every changed entrypoint SHA in `deploy/source-runtime-manifest.json` before the drift guard; do not hand-copy a stale hash.

- [ ] **Step 6: Document and commit WS-A02**

Rewrite the existing ordering and startup-recovery prose in `docs/durability.md` before adding this state table; do not leave text claiming `journalInbound()` is the first action or that every processing row is terminally failed at startup:

```markdown
| Inbound state | Meaning | Replayable |
|---|---|---|
| `pending` | Message and admission committed atomically; current process pipeline owns claim/wait | only explicit startup recovery after prior-process ownership is gone |
| `processing` | One runtime owns the current work; the timestamp is observability, not transport ownership proof | only explicit startup recovery; never transport lease expiry |
| `deferred` | Capacity or shutdown deliberately postponed work | when `replay_after` is due |
| `turn_done` | Runtime finished; terminal delivery reconciliation is pending | no blind replay |
| `complete` / `failed` | Terminal lifecycle evidence recorded | no |
```

Then commit:

```bash
git add src/core/types.ts src/core/durability.ts src/core/health.ts src/core/ingest.ts src/core/access-policy.ts src/core/admin.ts src/core/inbound-failure-class.ts src/main.ts src/runtimes/types.ts src/runtimes/chat/runtime.ts src/runtimes/agent/runtime.ts src/runtimes/agent/outbound-queue.ts src/runtimes/passive/runtime.ts tests/core/durability.test.ts tests/core/health.test.ts tests/core/ingest.test.ts tests/core/ingest-backpressure.test.ts tests/core/ingest-control.test.ts tests/core/ingest-paused-chats.test.ts tests/core/ingest-fallback-routing.test.ts tests/core/access-policy.test.ts tests/core/inbound-failure-class.test.ts tests/core/admin.test.ts tests/main-bootstrap.test.ts tests/integration/heal-flow.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/outbound-queue.test.ts tests/runtimes/agent/outbound-queue-idempotency.test.ts tests/runtimes/passive/runtime.test.ts deploy/source-runtime-manifest.json package.json docs/durability.md docs/public-surface.md
git commit -m "fix(ingest): preserve admitted work across redelivery"
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
```

Run the source-runtime guard only on the committed Task 3 head. A correction
requires amend plus a full Task 3 matrix rerun.

### Task 4: Add bounded deferred-inbound replay and crash recovery (WS-A03, commit 1)

**Files:**
- Create: `src/core/inbound-replay.ts`
- Create: `tests/core/inbound-replay.test.ts`
- Create: `scripts/requeue-inbound.ts` and `tests/scripts/requeue-inbound.test.ts` for an explicit dry-run-first repair path
- Modify: `src/core/inbound-admission.ts` for shared replay-envelope/content-type validators
- Modify: `src/core/messages.ts` and `src/core/database.ts` for nonterminal hard-retention protection and live edit/revoke linearization
- Modify: `src/transport/connection.ts` for the existing edit/revoke owner handoff
- Modify: `src/main.ts` to run and exhaustively classify pre-ready terminal reconciliation before replay-worker/producer activation
- Modify: `tests/core/messages.test.ts`, `tests/core/database.test.ts`, `tests/transport/connection-branches.test.ts`, and `tests/transport/connection-branch-residuals.test.ts`
- Modify: `tests/main-bootstrap.test.ts` for the real pre-ready drain/abort/blocked bootstrap seam
- Modify: `src/core/durability.ts:303-390, 672-855, 1084-1095`
- Modify: `tests/core/durability.test.ts` and `tests/core/inbound-admission.test.ts` for exact mutation/replay/provenance integration
- Modify: `tests/core/durability-recovery.test.ts:209-238`
- Modify: `tests/core/durability-stuck-inbound-sweep.test.ts`
- Modify: `src/core/health.ts` and `tests/core/health.test.ts` for replay/admin-invalid gauges and the worker blocker dependency
- Modify: `deploy/source-runtime-manifest.json` for every changed hashed entrypoint
- Modify: `docs/durability.md`
- Modify: `docs/public-surface.md` for the bounded replay-health fields

**Interfaces:**
- Consumes: `createAdmittedInboundDispatcher(...)`, `MAX_INBOUND_ATTEMPTS`, and Task 3's `settleFailedReplayAttemptOrThrow(...)` / exact terminal classifier.
- Produces: typed `ReplayCandidate` / `ReplayClaimDisposition`, bounded durability-owned invalid/admin/terminal-evidence batches, claim-time canonical payload validation, replay CASes returning the exact readonly `InboundProcessingClaim`, `InboundReplayWorker.start(): void`, rejecting `stop(): Promise<void>` after a retained worker failure, serialized `tick(): Promise<number>`, `getHealth(): InboundReplayBlockedSnapshot | null`, the exported abortable `drainPreReadyTerminalReconciliationOrThrow(...)` bootstrap owner/result union, shared raw-envelope/content-type validation, and `DurabilityEngine.getHealthStats().deferredInbound` / `.invalidDeferredInbound` / `.replayExhaustedInbound` / `.invalidReplayTerminalInbound` / `.interruptedAdminInbound` / `.terminalEvidenceBlockedInbound`. Every post-claim worker write consumes that same claim and cannot mutate a later attempt; one `replayBackoffSeconds` helper is called only by the shared settlement owner.

- [ ] **Step 1: Write the bounded replay and crash-recovery tests**

Create `tests/core/inbound-replay.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { InboundReplayWorker } from '../../src/core/inbound-replay.ts';
import { admitInboundMessage } from '../../src/core/inbound-admission.ts';
import type { IncomingMessage, PendingInboundClaim } from '../../src/core/types.ts';

describe('InboundReplayWorker', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => db.close());

  function admit(id: string, now: number): PendingInboundClaim {
    const result = admitInboundMessage(db, {
      chatJid: '15550100001@s.whatsapp.net',
      conversationKey: '15550100001',
      senderJid: '15550100001@s.whatsapp.net',
      senderName: 'Replay User',
      messageId: id,
      content: `body-${id}`,
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      timestamp: now,
      quotedMessageId: null,
      rawMessage: null,
      mentionedJids: [],
      isResponseWorthy: true,
      admissionRoute: 'ingest',
    }, now);
    if (!result.accepted) throw new Error('fixture admission was not accepted');
    return result.claim;
  }

  it('claims at most batchSize due rows in FIFO order and dispatches reconstructed messages', async () => {
    const now = 1_800_000_000;
    const claims = ['a', 'b', 'c'].map((id) => admit(id, now));
    const seqs = claims.map((claim) => claim.seq);
    for (const claim of claims) {
      expect(durability.deferInboundOrThrow(claim, 'ingest_queue_full', 0, now)).toBe('deferred');
    }
    const dispatched: IncomingMessage[] = [];
    const worker = new InboundReplayWorker(db, durability, {
      dispatchAdmitted: async (msg) => {
        dispatched.push(msg);
        return { outcome: 'dispatched' as const };
      },
      batchSize: 2,
      intervalMs: 5_000,
      now: () => now,
    });

    expect(await worker.tick()).toBe(2);
    expect(dispatched.map((msg) => msg.messageId)).toEqual(['a', 'b']);
    expect(dispatched.map((msg) => msg.inboundSeq)).toEqual(seqs.slice(0, 2));
    expect(durability.getHealthStats().deferredInbound).toBe(1);
  });

  it('returns a failed dispatch to deferred with bounded backoff', async () => {
    const now = 1_800_000_000;
    const claim = admit('dispatch-fault', now);
    const seq = claim.seq;
    expect(durability.deferInboundOrThrow(claim, 'chat_queue_full', 0, now)).toBe('deferred');
    const worker = new InboundReplayWorker(db, durability, {
      dispatchAdmitted: async (msg, options) => ({
        outcome: 'runtime_failed' as const,
        failureClass: 'provider_failure' as const,
        claim: options.processingClaim,
      }),
      batchSize: 10,
      intervalMs: 5_000,
      now: () => now,
    });

    expect(await worker.tick()).toBe(0);
    expect(db.raw.prepare(`
      SELECT processing_status, deferred_reason, replay_after
      FROM inbound_events WHERE seq = ?
    `).get(seq)).toEqual({
      processing_status: 'deferred',
      deferred_reason: 'crash_recovery',
      replay_after: now + 30,
    });
  });

  it('does not count a runtime queue re-deferral as a replay dispatch', async () => {
    const now = 1_800_000_000;
    const claim = admit('queue-redeferred', now);
    const seq = claim.seq;
    expect(durability.deferInboundOrThrow(claim, 'chat_queue_full', 0, now)).toBe('deferred');
    const worker = new InboundReplayWorker(db, durability, {
      dispatchAdmitted: async (msg, options) => {
        expect(durability.deferInboundOrThrow(
          options.processingClaim, 'agent_queue_full', 45, now,
        )).toBe('deferred');
        return { outcome: 'deferred' as const, reason: 'agent_queue_full' as const, replayAfter: now + 45 };
      },
      now: () => now,
    });

    expect(await worker.tick()).toBe(0);
    expect(db.raw.prepare(`
      SELECT processing_status, deferred_reason, replay_after
      FROM inbound_events WHERE seq = ?
    `).get(seq)).toEqual({
      processing_status: 'deferred',
      deferred_reason: 'agent_queue_full',
      replay_after: now + 45,
    });
    expect(worker.getStats().dispatched).toBe(0);
  });

  it('fails terminally after the bounded replay attempt budget is exhausted', async () => {
    const now = 1_800_000_000;
    const claim = admit('dispatch-exhausted', now);
    const seq = claim.seq;
    expect(durability.deferInboundOrThrow(claim, 'chat_queue_full', 0, now)).toBe('deferred');
    db.raw.prepare('UPDATE inbound_events SET attempt_count = 4 WHERE seq = ?').run(seq);
    const dispatchAdmitted = vi.fn(async (msg, options) => ({
      outcome: 'runtime_failed' as const,
      failureClass: 'provider_failure' as const,
      claim: options.processingClaim,
    }));
    const worker = new InboundReplayWorker(db, durability, {
      dispatchAdmitted,
      now: () => now,
    });

    expect(await worker.tick()).toBe(0);
    expect(db.raw.prepare(`
      SELECT processing_status, terminal_reason, failure_class, attempt_count, routed_to
      FROM inbound_events WHERE seq = ?
    `).get(seq)).toEqual({
      processing_status: 'failed',
      terminal_reason: 'error',
      failure_class: 'crash_recovery',
      attempt_count: 5,
      routed_to: 'replay_exhausted',
    });
    expect(await worker.tick()).toBe(0);
    expect(dispatchAdmitted).toHaveBeenCalledOnce();
    expect(durability.getHealthStats().replayExhaustedInbound).toBe(1);
  });

  it('never claims a terminal row even when replay_after is due', async () => {
    const now = 1_800_000_000;
    const claim = admit('terminal-no-replay', now);
    const seq = claim.seq;
    db.raw.prepare(`
      UPDATE inbound_events
      SET processing_status = 'complete', terminal_reason = 'response_sent', replay_after = ?
      WHERE seq = ?
    `).run(now - 1, seq);
    const dispatchAdmitted = vi.fn(async () => ({ outcome: 'dispatched' as const }));
    const worker = new InboundReplayWorker(db, durability, {
      dispatchAdmitted,
      batchSize: 10,
      intervalMs: 5_000,
      now: () => now,
    });

    expect(await worker.tick()).toBe(0);
    expect(dispatchAdmitted).not.toHaveBeenCalled();
  });

  it('terminalizes a deferred row with null replay_after instead of stranding it', async () => {
    const now = 1_800_000_000;
    const claim = admit('invalid-deferred-time', now);
    const seq = claim.seq;
    db.raw.prepare(`
      UPDATE inbound_events
      SET processing_status = 'deferred', lease_until = NULL, replay_after = NULL
      WHERE seq = ?
    `).run(seq);
    const dispatchAdmitted = vi.fn(async () => ({ outcome: 'dispatched' as const }));
    const worker = new InboundReplayWorker(db, durability, {
      dispatchAdmitted,
      now: () => now,
    });

    expect(durability.getHealthStats().invalidDeferredInbound).toBe(1);
    expect(await worker.tick()).toBe(0);
    expect(dispatchAdmitted).not.toHaveBeenCalled();
    expect(db.raw.prepare(`
      SELECT processing_status, terminal_reason, failure_class, routed_to
      FROM inbound_events WHERE seq = ?
    `).get(seq)).toEqual({
      processing_status: 'failed',
      terminal_reason: 'error',
      failure_class: 'stale_reclaim',
      routed_to: 'replay_invalid',
    });
    expect(durability.getHealthStats()).toMatchObject({
      invalidDeferredInbound: 0,
      invalidReplayTerminalInbound: 1,
    });
  });

  it('fails closed on a malformed raw envelope', async () => {
    const now = 1_800_000_000;
    const claim = admit('malformed-replay', now);
    const seq = claim.seq;
    expect(durability.deferInboundOrThrow(claim, 'chat_queue_full', 0, now)).toBe('deferred');
    db.raw.prepare(`
      UPDATE messages SET raw_message = '{' WHERE message_id = 'malformed-replay'
    `).run();
    const dispatchAdmitted = vi.fn(async () => ({ outcome: 'dispatched' as const }));
    const worker = new InboundReplayWorker(db, durability, { dispatchAdmitted, now: () => now });

    expect(await worker.tick()).toBe(0);
    expect(dispatchAdmitted).not.toHaveBeenCalled();
    expect(db.raw.prepare(`
      SELECT processing_status, failure_class FROM inbound_events WHERE seq = ?
    `).get(seq)).toEqual({ processing_status: 'failed', failure_class: 'stale_reclaim' });
  });

  it.each([
    ['malformed-mentions', 'mentioned_jids_json', '{'],
    ['invalid-response-worthiness', 'is_response_worthy', 2],
  ] as const)('fails closed on invalid trigger metadata: %s', async (id, column, value) => {
    const now = 1_800_000_000;
    const claim = admit(id, now);
    const seq = claim.seq;
    expect(durability.deferInboundOrThrow(claim, 'chat_queue_full', 0, now)).toBe('deferred');
    db.raw.prepare(`UPDATE inbound_events SET ${column} = ? WHERE seq = ?`).run(value, seq);
    const dispatchAdmitted = vi.fn(async () => ({ outcome: 'dispatched' as const }));
    const worker = new InboundReplayWorker(db, durability, { dispatchAdmitted, now: () => now });

    expect(await worker.tick()).toBe(0);
    expect(dispatchAdmitted).not.toHaveBeenCalled();
    expect(db.raw.prepare(`
      SELECT processing_status, failure_class, routed_to FROM inbound_events WHERE seq = ?
    `).get(seq)).toEqual({
      processing_status: 'failed',
      failure_class: 'stale_reclaim',
      routed_to: 'replay_invalid',
    });
  });
});
```

Add integration cases using the real `createAdmittedInboundDispatcher`: (1) admit and defer while the sender is allowed, revoke access, then tick and prove `runtime.handleMessage` is not called and the row ends `complete/access_denied`; (2) pause the chat before tick and prove `complete/chat_paused`; (3) store a group mention and `isResponseWorthy=false` fixture, reconstruct both exactly, and prove the current trigger decision is preserved. Mutate the dispatcher call to direct `runtime.handleMessage` and show at least the revoke case goes RED.

Add injected-clock boundary cases: a backward jump must not claim a row before its absolute epoch-second `replay_after`; a large forward jump may make it due but must still win one CAS, obey `MAX_INBOUND_ATTEMPTS`, and dispatch at most once; an interval value remains milliseconds and never participates in SQL due-time comparison. Hold one dispatch while the clock advances and prove retry uses a fresh failure-time sample (`replay_after = failureNow + delaySeconds`), not the tick-start candidate time. Record the exact `now` sequence in assertions so unit confusion, stale backoff time, or a wall-clock regression is load-bearing.

Add an overlap/shutdown test with a held dispatcher: start one tick, call `tick()` again and assert it returns `0` without a second claim, call `stop()` and prove its promise remains pending, simulate a queued timer/manual late `tick()` and assert it returns `0`, release dispatch, then prove the first tick and `stop()` settle before the database can close. Assert `start()` after stop is rejected. Mutating `inFlight` serialization, the stopped latch, or the `await` from `stop()` must make this test RED.

Replace the existing crash-recovery assertion in `tests/core/durability-recovery.test.ts` with:

```ts
it('inbound processing with no terminal outbound op is deferred for bounded replay', () => {
  const now = 1_800_000_000;
  const admission = admitInboundMessage(db, {
    chatJid: 'j1@s.whatsapp.net',
    conversationKey: 'k1',
    senderJid: 'j1@s.whatsapp.net',
    senderName: 'Recovery User',
    messageId: 'msg-1',
    content: 'recover me',
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    timestamp: now,
    quotedMessageId: null,
    rawMessage: null,
    mentionedJids: [],
    isResponseWorthy: true,
    admissionRoute: 'ingest',
  }, now);
  if (!admission.accepted) throw new Error('recovery fixture admission failed');
  const processingClaim = engine.markInboundProcessing(admission.claim, 'agent', now);
  expect(processingClaim).not.toBeNull();
  engine.preConnectRecovery();

  const row = getInbound(db, admission.seq);
  expect(row['processing_status']).toBe('deferred');
  expect(row['deferred_reason']).toBe('crash_recovery');
  expect(row['failure_class']).toBeNull();
});
```

Import `admitInboundMessage` in the recovery test. Retain a separate legacy fixture created with `journalInbound`/null lease and assert its existing terminal compatibility behavior; that row is not promised replay. This pair makes the migration boundary explicit.

Add a file-backed restart integration: admit a message and close the first database without calling `markInboundProcessing`; reopen, run `preConnectRecovery`, assert `pending -> deferred` with `replay_after` due, start the real worker/dispatcher, and observe one dispatch and no second dispatch on another tick. Removing pending startup conversion must make the test fail.

- [ ] **Step 2: Add a compiling worker scaffold, then capture semantic RED**

Create the `InboundReplayWorker` constructor/start/stop/tick/getStats surface
with no scheduled timer and an inert `tick()` returning zero. This is compile
scaffolding only; do not add claim/dispatch behavior yet. A missing module or
export is `Inconclusive`, not RED.

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-replay.test.ts tests/core/durability-recovery.test.ts --pool=forks
```

Expected: FAIL at the claim/dispatch/backoff/stat assertions because the inert
worker consumes nothing. The Task 3
lease-managed pending/processing recovery characterization must already pass on
the merged WS-A02 baseline; if it still marks such a row failed, WS-A02 is not
independently safe and Task 4 must not begin.

- [ ] **Step 3: Implement the replay worker**

Add only the durability-owned `claimReplayCandidateWithPayloadOrThrow` for
pre-claim validation/reconciliation/exhaustion and reuse Task 3's
`settleFailedReplayAttemptOrThrow` after a claimed runtime failure. Do not retain
parallel `terminalizeReplayInvalidOrThrow` or
`terminalizeReplayExhaustedOrThrow` APIs: their zero-CAS ownership/evidence logic
belongs in those two SSOTs. The worker has no sequence-only terminal/status
precheck or copied transition SQL. Source inventory and focused tests require
the obsolete names to be absent.

Define the transaction result types beside those helpers in
`src/core/durability.ts` so the durability layer does not import its worker:

```ts
export interface ReplayCandidate {
  readonly seq: number;
  readonly attempt_count: number;
  readonly routed_to: string;
}

interface ReplayPayloadRow {
  message_id: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string | null;
  content: string | null;
  content_text: string | null;
  content_type: string;
  timestamp: number;
  quoted_message_id: string | null;
  raw_message: string | null;
  mentioned_jids_json: string | null;
  is_response_worthy: number | null;
}

export type ReplayClaimDisposition =
  | {
      outcome: 'claimed';
      claim: InboundProcessingClaim;
      payload: Readonly<ReplayPayloadRow>;
      contentType: IncomingMessage['contentType'];
      rawMessage: unknown;
      mentionedJids: readonly string[];
    }
  | { outcome: 'not_claimed' }
  | { outcome: 'invalid_terminalized' }
  | { outcome: 'exhausted_terminalized' }
  | { outcome: 'echo_reconciled' }
  | { outcome: 'failure_reconciled' }
  | { outcome: 'delivery_pending' }
  | { outcome: 'already_terminal' }
  | { outcome: 'stale_claim' };

export interface ReplayBatchMutationResult {
  readonly scanned: number;
  readonly changed: number;
  readonly remaining: boolean;
}

export interface DeferredTerminalReconcileBatchResult {
  readonly scanned: number;
  readonly echoReconciled: number;
  readonly failureReconciled: number;
  readonly remainingActionable: boolean;
}
```

`terminalizeInterruptedAdminBatchOrThrow(limit)`,
`terminalizeInvalidDeferredBatchOrThrow(limit)`, and
`reconcileDeferredTerminalEvidenceBatchOrThrow(limit)` live on
DurabilityEngine, validate `limit` in `1..100`, and own their SQL-only bounded
CTEs. The invalid batch can terminalize an unsafe/null sequence entirely inside
SQLite without returning it to JS. The terminal-evidence batch selects only
actionable exact `echoed|quarantined|failed_permanent` rows and applies the
claim-first classifier; ambiguous/submitted/invalid rows are counted by the
health gauge but not repeatedly rescanned as mutation candidates. Each call
touches at most `limit`; the worker emits bounded aggregate events/counters from
the typed result and contains no UPDATE SQL.

Startup owns an explicit abortable
`drainPreReadyTerminalReconciliationOrThrow()` loop before any dormant producer
registry is activated. It invokes one bounded reconciliation batch per turn,
yields to the event loop, rechecks the startup generation/signal, and repeats
until `remainingActionable=false`; it is a recovery operation, not a dormant
`InboundReplayWorker` callback, and is the only pre-ready exception to Task 6's
producer activation latch. Once actionable rows reach zero it rereads
`terminalEvidenceBlockedInbound`. A nonzero blocked gauge returns a bounded
`PreReadyTerminalEvidenceBlocked` startup result and shuts down unready rather
than spinning or activating producers. Ordinary replay-worker ticks start only
after readiness and never own this startup loop. Test `batchSize+2` exact rows
across multiple yielded turns, abort between batches, and a large ambiguous
backlog: transactions stay bounded, actionable rows drain before readiness,
abort performs no later mutation, ambiguous rows are not mutation-rescanned,
and their bounded result blocks startup instead of deadlocking behind the
closed activation latch.

Export the concrete owner from `src/core/inbound-replay.ts`:

```ts
export type PreReadyTerminalReconciliationResult =
  | {
      outcome: 'drained';
      batches: number;
      echoReconciled: number;
      failureReconciled: number;
    }
  | {
      outcome: 'blocked_evidence';
      terminalEvidenceBlockedInbound: number;
    };

export async function drainPreReadyTerminalReconciliationOrThrow(input: {
  durability: DurabilityEngine;
  batchSize: number;
  signal: AbortSignal;
  ownsGeneration: () => boolean;
  yieldTurn: () => Promise<void>;
}): Promise<PreReadyTerminalReconciliationResult>;
```

The implementation validates `batchSize`, checks `signal` and
`ownsGeneration()` before and after every batch/yield, throws the exact abort
reason on loss, and accumulates only safe bounded counters. `src/main.ts` awaits
it after history/echo recovery and before constructing or preparing dormant
producers, then exhaustively switches the result: `drained` continues, while
`blocked_evidence` latches the bounded mutation-health snapshot and throws
`PreReadyTerminalEvidenceBlocked`. Add the new main/bootstrap files to this
task's matrix and stage list. Removing the main call, omitting an outcome, or
allowing a losing generation to run another batch must make a bootstrap test
RED.

Create `src/core/inbound-replay.ts`:

```ts
import type { Database } from './database.ts';
import type {
  DurabilityEngine,
  ReplayCandidate,
  ReplayClaimDisposition,
} from './durability.ts';
import type {
  IncomingMessage,
  InboundProcessingClaim,
} from './types.ts';
import {
  classifyErrorForInbound,
  type InboundFailureClass,
} from './inbound-failure-class.ts';
import {
  ADMISSION_LEASE_SECONDS,
  INVALID_DEFERRED_INBOUND_PREDICATE_PARAMS,
  INVALID_DEFERRED_INBOUND_PREDICATE_SQL,
} from './inbound-admission.ts';
import type { AdmittedInboundDispatchResult } from './ingest.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('inbound-replay');
const MAX_NODE_TIMER_MS = 2_147_483_647;

function requireSafeIntegerInRange(
  value: number,
  label: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`invalid ${label}`);
  }
  return value;
}

export interface InboundReplayOptions {
  dispatchAdmitted: (
    msg: IncomingMessage,
    options: {
      claim: 'processing';
      processingClaim: InboundProcessingClaim;
      source: 'replay';
    },
  ) => Promise<AdmittedInboundDispatchResult>;
  batchSize?: number;
  intervalMs?: number;
  now?: () => number;
  onBlocked?: (snapshot: InboundReplayBlockedSnapshot) => void;
}

export interface InboundReplayBlockedSnapshot {
  readonly blocked: true;
  readonly stage: 'tick';
  readonly failureClass: InboundFailureClass;
  readonly operationStage: 'pre_claim' | 'metadata' | 'dispatch' | 'transition';
  readonly ownership?: Readonly<{
    seq: number;
    status: 'processing';
    route: string;
    attemptCount: number;
  }>;
}

interface ReplayTickContext {
  operationStage: InboundReplayBlockedSnapshot['operationStage'];
  ownership?: InboundProcessingClaim;
}

export interface InboundReplayStats {
  claimed: number;
  dispatched: number;
  retried: number;
  exhausted: number;
  invalid: number;
  policySkipped: number;
  overlapSuppressed: number;
  adminInterrupted: number;
  echoReconciled: number;
  failureReconciled: number;
}

export class InboundReplayWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<number> | null = null;
  private stopped = false;
  private blockedSnapshot: InboundReplayBlockedSnapshot | null = null;
  private firstFailure: { error: unknown } | null = null;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly stats: InboundReplayStats = {
    claimed: 0,
    dispatched: 0,
    retried: 0,
    exhausted: 0,
    invalid: 0,
    policySkipped: 0,
    overlapSuppressed: 0,
    adminInterrupted: 0,
    echoReconciled: 0,
    failureReconciled: 0,
  };

  constructor(
    private readonly db: Database,
    private readonly durability: DurabilityEngine,
    private readonly options: InboundReplayOptions,
  ) {
    this.batchSize = requireSafeIntegerInRange(
      options.batchSize ?? 10, 'inbound replay batch size', 1, 100,
    );
    this.intervalMs = requireSafeIntegerInRange(
      options.intervalMs ?? 5_000,
      'inbound replay interval',
      1_000,
      MAX_NODE_TIMER_MS,
    );
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private sampleNow(): number {
    return requireSafeIntegerInRange(
      this.now(), 'inbound replay time', 0, Number.MAX_SAFE_INTEGER,
    );
  }

  start(): void {
    if (this.stopped) throw new Error('inbound replay worker is stopped');
    if (this.blockedSnapshot) throw new Error('inbound replay worker is blocked');
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => log.error(
        { event: 'inbound_replay_tick_failed', stage: 'tick', failureClass: classifyErrorForInbound(err) },
        'inbound replay tick failed',
      ));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.inFlight;
    } catch {
      // tick() retained the original blocker before this observer runs.
    }
    if (this.firstFailure !== null) throw this.firstFailure.error;
  }

  getHealth(): InboundReplayBlockedSnapshot | null {
    return this.blockedSnapshot ? { ...this.blockedSnapshot } : null;
  }

  private block(err: unknown, context: ReplayTickContext): void {
    if (this.blockedSnapshot) return;
    this.firstFailure = { error: err };
    const ownership = context.ownership
      ? Object.freeze({ ...context.ownership })
      : undefined;
    this.blockedSnapshot = Object.freeze({
      blocked: true,
      stage: 'tick',
      failureClass: classifyErrorForInbound(err),
      operationStage: context.operationStage,
      ownership,
    });
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log.error({
      event: 'inbound_replay_worker_blocked', stage: 'tick',
      failureClass: this.blockedSnapshot.failureClass,
      operationStage: this.blockedSnapshot.operationStage,
      inboundSeq: this.blockedSnapshot.ownership?.seq,
      attemptCount: this.blockedSnapshot.ownership?.attemptCount,
    });
    try {
      this.options.onBlocked?.(this.blockedSnapshot);
    } catch (callbackError) {
      log.error({
        event: 'inbound_replay_supervisor_failed', stage: 'tick',
        failureClass: classifyErrorForInbound(callbackError),
      });
    }
  }

  getStats(): Readonly<InboundReplayStats> {
    return { ...this.stats };
  }

  async tick(): Promise<number> {
    if (this.stopped) return 0;
    if (this.blockedSnapshot && this.firstFailure) throw this.firstFailure.error;
    if (this.inFlight) {
      this.stats.overlapSuppressed += 1;
      log.debug({ event: 'inbound_replay_overlap_suppressed' });
      return 0;
    }
    const context: ReplayTickContext = { operationStage: 'pre_claim' };
    const current = this.tickOnce(context);
    this.inFlight = current;
    try {
      return await current;
    } catch (err) {
      this.block(err, context);
      throw err;
    } finally {
      if (this.inFlight === current) this.inFlight = null;
    }
  }

  private async tickOnce(context: ReplayTickContext): Promise<number> {
    const now = this.sampleNow();
    const leaseUntil = now + ADMISSION_LEASE_SECONDS;
    if (!Number.isSafeInteger(leaseUntil)) {
      throw new RangeError('inbound replay lease exceeds safe range');
    }
    const interruptedAdmin = this.durability
      .terminalizeInterruptedAdminBatchOrThrow(this.batchSize);
    if (interruptedAdmin.changed > 0) {
      this.stats.adminInterrupted += interruptedAdmin.changed;
      log.error({
        event: 'inbound_replay_admin_interrupted', stage: 'route_validation',
        failureClass: 'admin_command_failed',
        count: interruptedAdmin.changed,
      });
    }

    const invalid = this.durability
      .terminalizeInvalidDeferredBatchOrThrow(this.batchSize);
    if (invalid.changed > 0) {
      this.stats.invalid += invalid.changed;
      log.error(
        { event: 'inbound_replay_invalid', stage: 'metadata_validation', failureClass: 'stale_reclaim', count: invalid.changed },
        'invalid deferred inbound rows terminalized',
      );
    }

    const terminalEvidence = this.durability
      .reconcileDeferredTerminalEvidenceBatchOrThrow(this.batchSize);
    this.stats.echoReconciled += terminalEvidence.echoReconciled;
    this.stats.failureReconciled += terminalEvidence.failureReconciled;
    if (terminalEvidence.echoReconciled > 0) {
      log.info({
        event: 'inbound_terminal_echo_reconciled_batch',
        count: terminalEvidence.echoReconciled,
      });
    }
    if (terminalEvidence.failureReconciled > 0) {
      log.info({
        event: 'inbound_terminal_failure_reconciled_batch',
        count: terminalEvidence.failureReconciled,
      });
    }

    const candidates = this.db.raw.prepare(`
      SELECT e.seq, e.attempt_count, e.routed_to
      FROM inbound_events e
      WHERE e.processing_status = 'deferred'
        AND e.routed_to IS NOT NULL AND length(trim(e.routed_to)) > 0
        AND e.routed_to <> 'admin'
        AND e.replay_after IS NOT NULL
        AND e.replay_after <= ?
        AND NOT EXISTS (
          SELECT 1 FROM outbound_ops o
          WHERE o.source_inbound_seq = e.seq AND o.is_terminal = 1
        )
        AND NOT (${INVALID_DEFERRED_INBOUND_PREDICATE_SQL})
      ORDER BY e.seq ASC
      LIMIT ?
    `).all(
      now, ...INVALID_DEFERRED_INBOUND_PREDICATE_PARAMS, this.batchSize,
    ) as unknown as ReplayCandidate[];

    let dispatched = 0;
    for (const row of candidates) {
      // stop() may latch while an earlier claimed candidate is settling. Never
      // acquire a new owner after that point.
      if (this.stopped) break;
      context.ownership = undefined;
      context.operationStage = 'pre_claim';
      const claimed: ReplayClaimDisposition = this.durability
        .claimReplayCandidateWithPayloadOrThrow({
        candidate: Object.freeze({
          seq: row.seq,
          route: row.routed_to,
          attemptCount: row.attempt_count,
        }),
        now,
        leaseUntil,
        });
      if (claimed.outcome !== 'claimed') {
        switch (claimed.outcome) {
          case 'not_claimed':
          case 'already_terminal':
          case 'stale_claim':
            break;
          case 'invalid_terminalized':
            this.stats.invalid += 1;
            log.error({ event: 'inbound_replay_invalid', stage: 'claim' },
              'invalid deferred inbound terminalized');
            break;
          case 'exhausted_terminalized':
            this.stats.exhausted += 1;
            log.error({ event: 'inbound_replay_exhausted', stage: 'claim' },
              'deferred inbound exhausted bounded replay attempts');
            break;
          case 'echo_reconciled':
            this.stats.echoReconciled += 1;
            log.info({ event: 'inbound_startup_echo_reconciled', stage: 'claim' },
              'deferred inbound reconciled from exact echo');
            break;
          case 'failure_reconciled':
            this.stats.failureReconciled += 1;
            log.info({ event: 'inbound_terminal_failure_reconciled', stage: 'claim' },
              'deferred inbound reconciled from exact permanent failure');
            break;
          case 'delivery_pending':
            log.warn({ event: 'inbound_delivery_pending', stage: 'claim' },
              'terminal evidence requires reconciliation');
            break;
          default: {
            const neverDisposition: never = claimed;
            throw new Error(`unhandled replay claim disposition: ${JSON.stringify(neverDisposition)}`);
          }
        }
        continue;
      }
      const processingClaim = claimed.claim;
      const replayRow = claimed.payload;
      context.ownership = processingClaim;
      context.operationStage = 'metadata';
      this.stats.claimed += 1;
      log.debug({ event: 'inbound_replay_claimed', inboundSeq: row.seq, attemptCount: processingClaim.attemptCount });
      const msg: IncomingMessage = {
        messageId: replayRow.message_id,
        chatJid: replayRow.chat_jid,
        senderJid: replayRow.sender_jid,
        senderName: replayRow.sender_name,
        content: replayRow.content,
        contentText: replayRow.content_text,
        contentType: claimed.contentType,
        isFromMe: false,
        isGroup: replayRow.chat_jid.endsWith('@g.us'),
        mentionedJids: [...claimed.mentionedJids],
        timestamp: replayRow.timestamp,
        quotedMessageId: replayRow.quoted_message_id,
        isResponseWorthy: replayRow.is_response_worthy === 1,
        rawMessage: claimed.rawMessage,
        inboundSeq: row.seq,
        inboundClaim: processingClaim,
      };

      context.operationStage = 'dispatch';
      const result = await this.options.dispatchAdmitted(
        msg,
        { claim: 'processing', processingClaim, source: 'replay' },
      );
      if (result.outcome === 'dispatched') {
        dispatched += 1;
        this.stats.dispatched += 1;
        log.info({ event: 'inbound_replay_dispatched', inboundSeq: row.seq });
        continue;
      }
      if (result.outcome === 'deferred') {
        this.stats.retried += 1;
        log.info(
          { event: 'inbound_replay_retry', inboundSeq: row.seq, reason: result.reason, replayAfter: result.replayAfter },
          'replayed inbound was durably re-deferred by runtime admission',
        );
        continue;
      }
      if (result.outcome === 'already_terminal') {
        log.debug({
          event: 'inbound_replay_already_terminal', inboundSeq: row.seq, stage: 'dispatch',
        });
        continue;
      }
      if (result.outcome === 'delivery_pending') {
        log.info(
          { event: 'inbound_delivery_pending', inboundSeq: row.seq, stage: 'replay_policy' },
          'terminal outbound evidence owns inbound reconciliation',
        );
        continue;
      }
      if (result.outcome === 'stale_claim') {
        // Durability already emitted/counted the single stale-claim event.
        continue;
      }
      if (result.outcome === 'policy_skipped') {
        this.stats.policySkipped += 1;
        log.info(
          { event: 'inbound_replay_policy_skipped', inboundSeq: row.seq, reason: result.reason },
          'deferred inbound rejected by current policy',
        );
        continue;
      }
      if (result.outcome === 'runtime_failed') {
        context.operationStage = 'transition';
        if (
          result.claim.seq !== processingClaim.seq
          || result.claim.status !== processingClaim.status
          || result.claim.route !== processingClaim.route
          || result.claim.attemptCount !== processingClaim.attemptCount
        ) {
          throw new Error('replay dispatcher returned a mismatched processing claim');
        }
        const failedClaim = result.claim;
        const attemptCount = failedClaim.attemptCount;
        const outcome = this.durability.settleFailedReplayAttemptOrThrow(
          failedClaim, result.failureClass, this.sampleNow(),
        );
        if (outcome === 'deferred') {
          this.stats.retried += 1;
          log.warn(
            { event: 'inbound_replay_retry', inboundSeq: row.seq, attemptCount, stage: 'dispatch', failureClass: result.failureClass },
            'deferred inbound dispatch failed; retry scheduled',
          );
        } else if (outcome === 'failed') {
          this.stats.exhausted += 1;
          log.error(
            { event: 'inbound_replay_exhausted', inboundSeq: row.seq, attemptCount, stage: 'dispatch', failureClass: result.failureClass },
            'deferred inbound exhausted bounded replay attempts',
          );
        } else if (outcome === 'delivery_pending') {
          log.info(
            { event: 'inbound_delivery_pending', inboundSeq: row.seq, stage: 'replay_retry' },
            'terminal outbound evidence owns inbound reconciliation',
          );
        } else if (outcome === 'already_terminal') {
          log.debug({
            event: 'inbound_deferral_already_terminal', inboundSeq: row.seq, stage: 'replay_retry',
          });
        } else if (outcome === 'stale_claim') {
          // Durability emitted/counted the bounded stale-claim event.
        } else {
          const neverOutcome: never = outcome;
          throw new Error(`unhandled replay failure disposition: ${neverOutcome}`);
        }
        continue;
      }
      const neverResult: never = result;
      throw new Error(`unhandled replay dispatch result: ${JSON.stringify(neverResult)}`);
    }
    return dispatched;
  }
}
```

`claimReplayCandidateWithPayloadOrThrow` is the sole Task 4 claim primitive. In
one `BEGIN IMMEDIATE` it re-reads the exact deferred tuple/due time, classifies
all terminal evidence, loads the current canonical message and trigger metadata,
rejects a missing/soft-deleted/identity-invalid message, decodes and bounds the
payload/mentions synchronously, and only then advances to `processing/replay`
and returns a frozen payload snapshot plus claim. Invalid current data is
terminalized in that same transaction; exact echoed evidence completes, exact
permanent failure fails, and ambiguous/legacy-invalid ownership returns a
visible `delivery_pending` disposition without dispatch. Terminal evidence is
classified before attempt exhaustion at every count. Only when no terminal owner
exists does an at-ceiling row become `exhausted_terminalized`; below the ceiling
it may claim. The worker's inline exhaustive switch owns the exact event/counter
mapping for every union member and has a `never` default; there is no separate
undefined mapper. The helper never exposes a claimed row whose payload was
selected by an earlier autocommit read. Add at-ceiling fixtures for every
terminal status so none can bypass reconciliation or its health blocker.

Hard-retention pruning (including retention-owned soft deletion) must refuse to
remove a message referenced by any nonterminal inbound state. Do not apply that
rule blindly to live WhatsApp edit/revoke owners: inventory them and preserve
their product semantics. Add one immediate `applyInboundMessageMutation`
boundary used by the connection owner. The edit event carries the full updated
envelope needed by the canonical payload/mention/response-worthiness parser,
not only `(messageId,newContent)`. A valid edit atomically updates the canonical
body/raw envelope/`edited_at` and exact
`mentioned_jids_json/is_response_worthy`; when its linked inbound is
ownership-safe `pending|deferred` with no terminal op, it also exact-defers it
as `message_edited`. If updated trigger metadata cannot be proven, the mutation
is retained but the linked row becomes bounded invalid/blocked and can never
replay using the original trigger metadata. An authenticated
revoke updates `deleted_at` and, under the same ownership-safe predicate, records
`deferred_reason='message_revoked'`; this explicit reason—not `deleted_at`
alone—is the durable revoke proof. Processing/turn-done ownership is never
stolen; only the distinct message mutation commits. Extend the bounded deferred
and failure vocabularies with `message_edited`/`message_revoked` and test the
transaction rollback. The claim helper dispatches an edited row only from its
current DB-linearized content **and updated trigger metadata**, terminalizes a proven revoked row as
`failed/message_revoked`, and treats a generic deleted row lacking that proof as
`failed/stale_reclaim` plus the invalid-replay gauge—never as a successful
revoke or stale transport payload.

A live mutation committed before the claim is reread
and validated by the claim transaction; one serialized after the claim cannot
mutate the already-frozen replay snapshot or ownership tuple and follows its
existing distinct edit/revoke event path. Add two-connection tests that hold
candidate A while candidate B is edited, revoked, retention-soft-deleted,
hard-pruned, or has trigger metadata repaired; B is re-read under its own claim
transaction and is either safely dispatched from the linearized snapshot or
terminalized/blocked, never dispatched from the earlier candidate scan. Add
post-claim edit/revoke tests proving the frozen claim-time payload remains
internally consistent while the distinct mutation event is retained, plus
generic retention/clear-chat `deleted_at` versus authenticated revoke
counterexamples, group-edit mention-added/removed and missing-envelope cases,
and a
post-claim hard-retention race proving pruning is refused until terminal. With `batchSize >= 2`, hold claimed A, call `stop()`, release A,
and prove B remains deferred/unclaimed with zero dispatch/provider/transport
side effects; removing the per-candidate stopped check must make this RED.

Add table-driven constructor and clock tests for `NaN`, infinities, fractions,
negatives, unsafe integers, `batchSize` 0/101, `intervalMs` 999/
`2_147_483_648`, lease-sum overflow, and an invalid second clock sample during
retry. Every invalid value rejects before a timer, SQL statement, event, or
counter change. The replay backoff helper accepts only a safe claimed attempt
below `MAX_INBOUND_ATTEMPTS`, returns a safe integer delay, and relies on
`deferInboundOrThrow` for the final safe `now + delay` validation.

Define `InboundStartupRecoveryOwnershipLost` beside the recovery owner with the
fixed message `startup inbound recovery lost exact ownership` and only the
frozen bounded claim tuple as a readonly field. Its catch path emits
`inbound_startup_recovery_failed{stage:'processing_recovery',failureClass:'stale_reclaim'}`,
keeps mutation readiness false, and prevents ingress or replay-worker attachment;
it never serializes the message identity or raw SQLite error. A stale claim is a
benign losing outcome inside a running replay worker, but during single-owner
startup recovery it is split-brain evidence. Add a two-connection competing
recovery test: after the candidate read, let another connection advance the
route/attempt, then release recovery and assert this process stays unready while
the winner's row is unchanged. `already_terminal` and `delivery_pending` retain
their explicit benign reconciliation branches.

`deferInboundWithContinuityOrThrow` is a narrow recovery-only variant whose one
claim-guarded `UPDATE` writes the continuity candidate fields and performs the
`processing -> deferred` transition together. It accepts the exact frozen claim,
the same bounded deferral reason/delay, and bounded continuity reason/source;
its result union and terminal-outbound precedence are identical to
`deferInboundOrThrow`. Do not call bare-sequence `markContinuityCandidate` before
or after this transition. Add a two-connection test that advances route/attempt
after the recovery candidate read but before this statement: the losing process
must write neither continuity fields nor deferral state and must take the
startup-blocker branch.

```ts
deferInboundWithContinuityOrThrow(
  claim: InboundProcessingClaim,
  reason: 'crash_recovery',
  delaySeconds: number,
  continuity: Readonly<{
    reason: 'crash_reclaim_no_terminal_outbound';
    source: 'pre_connect_recovery';
  }>,
  now?: number,
): 'deferred' | 'already_terminal' | 'delivery_pending' | 'stale_claim';
```

This recovery-only method is part of Task 4's internal source inventory and
tests, but not a new public configuration/API surface; `docs/public-surface.md`
records the durability owner without advertising a general continuity writer.

Increment `invalid` by the successfully terminalized invalid-row count,
`claimed` only after the deferred-to-processing CAS wins, `dispatched` only for
the dispatched result, `retried` only after `deferInboundOrThrow` returns
`deferred`, `exhausted` only after its terminal CAS wins, and `policySkipped`
only after the dispatcher returns that result. Emit the matching table event at
the same proof point. Counter snapshots are defensive copies; failed/lost CAS,
`already_terminal`, deferred runtime admission, and thrown invariants do not
increment success counters. Add exact-delta tests for every field and remove one
increment at a time to prove the assertions are load-bearing.

The worker blocker is a persistent, fail-closed owner rather than a log-only
interval catch. Add pre-claim SQL-fault and post-claim dispatcher/CAS-fault
tests: `tick()` rejects the original value (including `null`), `getHealth()` is
latched, a post-claim snapshot contains the exact frozen claim and bounded
operation stage, a pre-claim snapshot contains no ownership, `start()` cannot
rearm, and `stop()` drains then rejects the same original value. A throwing
`onBlocked` callback emits only `inbound_replay_supervisor_failed` and cannot
replace or clear the original failure. The claimed row remains open, health is
not green, and a file-backed next-process `preConnectRecovery()` reclaims it
exactly once. Extend optional `HealthDeps.getReplayHealth` now; Task 6 passes the
live worker getter and uses `onBlocked` to detach ingress/latch mutation
readiness before starting the interval.

```ts
export interface HealthDeps {
  // Preserve existing fields.
  getReplayHealth?: () => InboundReplayBlockedSnapshot | null;
}
```

The health handler reads this getter exactly once per request. A non-null value
forces `status='unhealthy'`/HTTP 503 and exposes only
`replay: { blocked:true, stage, operation_stage, failure_class, ownership? }`;
ownership is the bounded claim tuple and no thrown value or message identity is
serialized. A getter exception also returns bounded unhealthy 503. Add owning
health tests for null, pre-claim, post-claim, throwing supervisor callback, and
throwing getter states.

Every worker UPDATE after `deferred -> processing` accepts the returned
`processingClaim` and matches its route plus exact attempt count: metadata-parse
terminalization, runtime-failure retry/deferral, and exhaustion. On a lost CAS,
the durability-owned transition first rereads the inbound row and compares its
persisted route and attempt with the frozen claim. A missing row is an invariant;
a mismatch records `stale_claim` exactly once and returns without interpreting
status or outbound evidence. Only a still-current tuple may then classify
`complete`/`failed`/`turn_done` or terminal outbound evidence; a same-tuple open
row whose CAS changed zero remains an invariant and rejects the tick. Sequence-
only terminal/status probes are forbidden before this ownership comparison.
Pre-claim exhaustion also matches the
candidate's exact deferred attempt count. Add two-worker stale-attempt races for
invalid metadata, runtime retry, and exhaustion; attempt N must not mutate N+1
or double-count/log the conflict. Run each race with no outbound op, an old-N
terminal op, and a new-N+1 terminal op. The runtime-failure result must return the
same claim passed to the dispatcher: assert status/seq/route/attempt equality
and use `result.claim` for every subsequent mutation; mismatch is an invariant.
A bare sequence in any post-claim write must make a source-inventory test RED.

Do not wrap `dispatchAdmitted` in a broad catch. The shared dispatcher already
converts the runtime call's bounded failure into `runtime_failed`; a thrown
policy CAS, SQLite, metadata, or lifecycle invariant is a worker failure and
must reject `tick()`. Add a test where the dispatcher throws an invariant error:
the direct tick rejects, the interval boundary emits only bounded
`inbound_replay_tick_failed`, and no dispatched/retry counter or durable retry
transition is recorded. Converting that throw into `crash_recovery` must make
the test RED.

- [ ] **Step 4: Harden crash recovery terminal-evidence precedence**

Preserve Task 3's lease-managed pending/processing-to-deferred behavior and its
legacy null-lease compatibility; do not re-own or postpone that conversion in
WS-A03. Use Task 3's `classifyTerminalOutboundEvidenceForClaim`, whose strict
precedence is any **exact** echoed terminal operation first, otherwise the latest
exact all-status operation, otherwise noncurrent/invalid evidence, then none.
Never use the legacy query that excludes quarantined/permanent rows or a
sequence-only echo. Refine the existing Task 3 processing-loop decision
without changing its no-terminal lease semantics:

```ts
        const recoveryClaim: InboundProcessingClaim = Object.freeze({
          seq: ev.seq,
          status: 'processing',
          route: ev.routed_to,
          attemptCount: ev.attempt_count,
        });
        const outcome = this.recoverProcessingInboundOrThrow(recoveryClaim);
        switch (outcome.outcome) {
          case 'deferred':
            log.info({ event: 'inbound_startup_processing_recovered', inboundSeq: ev.seq });
            break;
          case 'legacy_failed':
            log.warn({
              event: 'inbound_startup_legacy_terminal', inboundSeq: ev.seq,
              stage: 'legacy_recovery', failureClass: 'crash_recovery',
            });
            break;
          case 'echo_reconciled':
            log.info({
              event: 'inbound_startup_echo_reconciled', inboundSeq: ev.seq,
              outboundOpId: outcome.outboundOpId,
            });
            break;
          case 'terminal_failure_reconciled':
            log.warn({
              event: 'inbound_terminal_failure_reconciled', inboundSeq: ev.seq,
              outboundOpId: outcome.outboundOpId,
            });
            break;
          case 'delivery_pending':
            log.info({
              event: 'inbound_startup_delivery_pending', inboundSeq: ev.seq,
              outboundOpId: outcome.outboundOpId,
              outboundStatus: outcome.outboundStatus,
              evidenceReason: outcome.evidenceReason,
            });
            break;
          case 'already_terminal':
            log.debug({
              event: 'inbound_deferral_already_terminal', inboundSeq: ev.seq,
              stage: 'pre_connect_recovery',
            });
            break;
          default: {
            const neverOutcome: never = outcome;
            throw new Error(`unhandled startup recovery outcome: ${JSON.stringify(neverOutcome)}`);
          }
        }
```

`recoverProcessingInboundOrThrow` owns one immediate transaction. It rereads the
row and compares route/attempt with `recoveryClaim` before status or outbound
evidence; missing or mismatched ownership throws
`InboundStartupRecoveryOwnershipLost`. Only for the same tuple does it apply the
exact-echo-first classifier and execute the private transaction-scoped
defer/legacy-fail/echo-complete/exact-failure operation or return a nonmutating
delivery-pending outcome. The read, evidence choice, and mutation/result are one
serialized decision, so `non_current_or_invalid` and
`pending|sending|submitted|maybe_sent` cannot mask N→N+1. The `turn_done` loop
uses an analogous `recoverTurnDoneInboundOrThrow` transaction with the same
ownership-first rule.

Use the same any-exact-echo-first, then latest-exact-all-status precedence in the `turn_done`
recovery loop. A truly absent terminal op keeps the existing no-reply completion;
`echoed` completes as delivered; `quarantined/failed_permanent` calls
`reconcileInboundTerminalFailure`; and `pending/sending/submitted/maybe_sent`
remains open for outbound reconciliation. Add processing and `turn_done` fixtures
with an earlier echoed terminal op plus a later submitted, `maybe_sent`, or
quarantined op; echo proof must win and complete the inbound without failure or
delivery-pending. Reverse/remove the precedence and make each fixture RED. The
legacy query that excludes quarantined/permanent rows must not decide any inbound
replay/completion path after this PR.

`completeInboundFromRecoveryTerminalOrThrow` is recovery-owned; it is not the
runtime completion API introduced in Task 8. In one immediate transaction it
verifies the stored current inbound tuple, the supplied terminal op, exact
route/attempt provenance (or the strict untouched attempt-zero legacy-null
exception), `status='echoed'`, and the allowed `processing`/`turn_done` recovery
state before completing. It returns
`complete | already_terminal | delivery_pending | stale_claim`; an unexplained
open result throws. `failLegacyInboundRecoveryOrThrow` similarly matches the
complete legacy tuple and never accepts a bare sequence. Add processing and
turn-done attempt-N-op/N+1-row, modern-null, mixed-null, legacy-null,
quarantined, and concurrent echo/failure races. Noncurrent/invalid evidence
blocks replay, raises the Task 3 provenance health source, and never completes or
fails the newer attempt.

Add a two-restart terminal-owner test. Seed a linked unsafe terminal operation
in `sending`, run pre-connect promotion and post-connect quarantine, and assert
the guarded reconciliation makes the inbound `failed/transport_send_failed`
without completing it. Reopen and run pre-connect plus the replay worker again:
the row stays failed and runtime is never called. Fault-inject the inbound
reconciliation write after quarantine and prove the inbound remains open with
`delivery_pending`, a second restart still does not defer/dispatch it because
the all-status terminal-evidence query includes `quarantined`, and recovery
reports the blocker. Excluding quarantined evidence or replaying either fixture
must make the tests RED.

Extend `getHealthStats` with this exact query and field:

Import `INVALID_DEFERRED_INBOUND_PREDICATE_SQL` and
`INVALID_DEFERRED_INBOUND_PREDICATE_PARAMS` into `durability.ts`; do not copy
the predicate or limits.

```ts
if (!Number.isSafeInteger(now) || now < 0) {
  throw new RangeError('invalid durability health time');
}
const deferred = this.db.raw.prepare(
  "SELECT COUNT(*) AS count FROM inbound_events WHERE processing_status = 'deferred'",
).get() as { count: number };
const invalidDeferred = this.db.raw.prepare(
  `SELECT COUNT(*) AS count FROM inbound_events e
   WHERE e.processing_status = 'deferred'
     AND (e.routed_to IS NULL OR e.routed_to <> 'admin')
     AND NOT EXISTS (
       SELECT 1 FROM outbound_ops o
       WHERE o.source_inbound_seq = e.seq AND o.is_terminal = 1
     ) AND (${INVALID_DEFERRED_INBOUND_PREDICATE_SQL})`,
).get(...INVALID_DEFERRED_INBOUND_PREDICATE_PARAMS) as { count: number };
const replayExhausted = this.db.raw.prepare(
  "SELECT COUNT(*) AS count FROM inbound_events WHERE processing_status = 'failed' AND routed_to = 'replay_exhausted' AND failure_class = 'crash_recovery'",
).get() as { count: number };
const invalidReplayTerminal = this.db.raw.prepare(
  "SELECT COUNT(*) AS count FROM inbound_events WHERE processing_status = 'failed' AND routed_to = 'replay_invalid' AND failure_class = 'stale_reclaim'",
).get() as { count: number };
const interruptedAdmin = this.db.raw.prepare(
  "SELECT COUNT(*) AS count FROM inbound_events WHERE processing_status = 'failed' AND routed_to IN ('startup_admin_interrupted', 'replay_admin_interrupted') AND failure_class = 'admin_command_failed'",
).get() as { count: number };
const terminalEvidenceBlocked = this.db.raw.prepare(
  `SELECT COUNT(*) AS count FROM inbound_events e
   WHERE e.processing_status = 'deferred'
     AND EXISTS (
       SELECT 1 FROM outbound_ops o
       WHERE o.source_inbound_seq = e.seq AND o.is_terminal = 1
     )`,
).get() as { count: number };
const oldestDue = this.db.raw.prepare(
  `SELECT MIN(replay_after) AS oldest
   FROM inbound_events
   WHERE processing_status = 'deferred'
     AND routed_to IS NOT NULL AND length(trim(routed_to)) > 0
     AND routed_to <> 'admin'
     AND replay_after IS NOT NULL AND replay_after <= ?`,
).get(now) as { oldest: number | null };
if (oldestDue.oldest !== null
    && (!Number.isSafeInteger(oldestDue.oldest) || oldestDue.oldest < 0)) {
  throw new RangeError('invalid deferred inbound replay time');
}
const oldestDueInboundAgeSeconds = oldestDue.oldest === null
  ? null
  : now - oldestDue.oldest;
if (oldestDueInboundAgeSeconds !== null
    && (!Number.isSafeInteger(oldestDueInboundAgeSeconds)
      || oldestDueInboundAgeSeconds < 0)) {
  throw new RangeError('invalid deferred inbound age');
}
```

```ts
getHealthStats(now = Math.floor(Date.now() / 1000)): {
  pendingOutbound: number;
  quarantinedOutbound: number;
  deferredInbound: number;
  invalidDeferredInbound: number;
  replayExhaustedInbound: number;
  invalidReplayTerminalInbound: number;
  interruptedAdminInbound: number;
  terminalEvidenceBlockedInbound: number;
  oldestDueInboundAgeSeconds: number | null;
  deferralsByReason: Record<InboundDeferredReason, number>;
  deferralFailures: number;
  staleClaimConflicts: number;
  lastRecoveryAt: string | null;
}
```

```ts
deferredInbound: deferred.count,
invalidDeferredInbound: invalidDeferred.count,
replayExhaustedInbound: replayExhausted.count,
invalidReplayTerminalInbound: invalidReplayTerminal.count,
interruptedAdminInbound: interruptedAdmin.count,
terminalEvidenceBlockedInbound: terminalEvidenceBlocked.count,
oldestDueInboundAgeSeconds,
deferralsByReason: { ...this.deferralsByReason },
deferralFailures: this.deferralFailures,
staleClaimConflicts: this.staleClaimConflicts,
```

Before readiness and before each worker candidate scan,
`reconcileDeferredTerminalEvidenceOrThrow` processes every deferred row linked
to a terminal op through Task 3's exact provenance classifier: exact `echoed`
completes, exact `quarantined|failed_permanent` fails, and ambiguous,
submitted/maybe-sent, modern-null, mixed, or foreign evidence remains open and
increments `terminalEvidenceBlockedInbound`. The reconciliation and claim helper
share the classifier and ownership-first transaction; neither guesses from the
latest op. After this pass, any terminal-linked deferred row left in the DB is a
visible blocker, never excluded from oldest-due health. A nonzero blocked gauge
is immediately unhealthy/503 and prevents readiness. Add all terminal statuses,
attempt N/N+1, legacy-invalid provenance, startup/tick races, and restart tests;
exact echo/failure must close while ambiguous ownership must remain open and red.

Add health tests for no due work (`null`), one overdue row (exact age), multiple rows (oldest wins), a future-only row (still `null`), every non-admin origin route/deferred reason, null/blank routes, and interrupted admin rows before/after bounded terminalization. The malformed raw/mention/response/content-type/numeric fixtures must increment `invalidDeferredInbound` before `tick()`, then decrement it to zero while `invalidReplayTerminalInbound` increments after terminalization. Valid JSON scalars/arrays, object envelopes missing `key` or `message`, over-limit raw JSON, out-of-union content types, and negative/REAL/TEXT `attempt_count` or `replay_after` are invalid. A JSON fixture that parses but contains a non-string mention must also be detected by the SQL gauge. Transport redelivery and the repair tool reject the same numeric/route corruption without consuming an attempt.

Define `INBOUND_REPLAY_DUE_SLO_SECONDS = 60` in the health owner. A non-null
worker blocker, `invalidDeferredInbound > 0`,
`terminalEvidenceBlockedInbound > 0`, or oldest due age greater than the
SLO is `unhealthy`/HTTP 503. Due work within the SLO, or any current
`replayExhaustedInbound`, `invalidReplayTerminalInbound`, or
`interruptedAdminInbound` row is `degraded` and cannot be reported healthy;
future-only deferred work is neutral. These are current DB gauges, not
monotonic-history counters: repair/requeue/retention must actually transition
the owning rows and a fresh zero query is required before status recovers. This
task does not invent separate persisted alert sources for each gauge; existing
fleet health polling consumes the bounded health result. There is no
acknowledgment bit that paints unresolved rows green. Add health tests for every
threshold with `getReplayHealth() === null`, plus exact SLO-1/SLO/SLO+1
boundaries.

Keep the invalid-metadata predicate and ordered bind parameters in the shared
exports reused by the health gauge and worker terminalization CTE. Its byte/cardinality checks must
match `decodeReplayMentionMetadata` and `decodeReplayPayload`: encoded mention JSON at most 8 KiB, at most 64
entries, every entry text, each UTF-8 value at most 512 bytes, content type in the canonical bounded union, and any non-null raw envelope at most 1 MiB with object `key` and `message`. Image/video/audio/document/sticker require that envelope; text may use null. Use
`length(CAST(... AS BLOB))` for bytes. Add pre-tick gauge tests for each bound,
including multibyte text; each row must be visible as invalid before claim and
terminalized without reaching the dispatcher.

Insert `batchSize + 2` invalid rows and prove one tick terminalizes exactly `batchSize`, leaves two active-invalid rows visible, and a second tick drains the remainder. The invalid CTE and due-candidate query each use the configured bound; no tick may perform an unbounded invalid-row write.

Add `scripts/requeue-inbound.ts` as the single fail-closed,
dry-run-by-default operator lifecycle tool. It accepts one database path and one
numeric sequence, prints only bounded lifecycle metadata, and supports exactly
three guarded modes:

1. `--repair-invalid` refuses active/non-`replay_invalid` rows,
   missing/deleted messages, attempts at/above `MAX_INBOUND_ATTEMPTS`, or invalid
   data without an explicit repair input. Optional repairs are
   `--mentioned-jids-file <0600-json-file>`, `--is-response-worthy true|false`,
   and `--discard-invalid-raw-envelope`; the tool never prints their values,
   rejects insecure/symlink files, and calls the shared mention/payload
   validators. Discard is allowed only for a syntax-invalid, scalar/array,
   missing-field, or over-limit optional envelope when normalized
   `content`/`content_text` remains present and the canonical content type does
   not require raw media. Media rows, invalid content types, and missing exact
   policy provenance are refused. `--apply` repairs metadata and performs the
   guarded `failed/replay_invalid -> deferred/crash_recovery` transition in one
   immediate transaction; it never resets attempt count.
2. `--resolve-exhausted archive` accepts only exact
   `failed/replay_exhausted/crash_recovery` rows with no delivery-pending
   outbound owner. After required backup/checksum confirmation, `--apply`
   preserves the terminal status, failure class, attempt count, and content but
   changes the route to `operator_replay_exhausted_resolved`. This is a durable
   resolution transition, not an acknowledgement flag or attempt reset; retry
   requires a separately reviewed repair/new-ingress path.
3. `--resolve-admin applied|not-applied` accepts only exact
   `failed/{startup_admin_interrupted,replay_admin_interrupted}/admin_command_failed`
   rows. It requires `--reconciliation-evidence-file` pointing to a regular,
   non-symlink, mode-0600 JSON object with bounded `reviewed_at`, `reviewer`, and
   `evidence_sha256` fields; it hashes the file but never prints/stores its
   contents. `applied` changes the row to `complete/admin_command` with route
   `operator_admin_reconciled_applied`; `not-applied` remains `failed` but moves
   to `operator_admin_reconciled_not_applied`, after which an operator may issue
   a new authenticated command through normal ingress. Neither mode executes or
   replays the ambiguous side effect.

Every apply mode uses one exact-status/route/failure/attempt CAS in an immediate
transaction and emits a bounded before/after receipt; lost ownership rolls back.
Tests prove dry-run is read-only, every refusal (including valid JSON primitives
and each raw-required media family), secure repair/evidence inputs, no outbound
owner override, rollback on a mid-repair fault, exactly one post-repair dispatch
for repaired invalid data, health-gauge clearance only after the corresponding
durable transition, and no admin side effect. Document stop-ingress,
backup/checksum, reconciliation, dry-run, apply, focused health query, receipt
retention, and rollback steps in `docs/durability.md`; direct ad-hoc SQL editing
is unsupported.

- [ ] **Step 5: Run replay, recovery, and durability suites**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-admission.test.ts tests/core/inbound-replay.test.ts tests/core/durability-recovery.test.ts tests/core/durability-stuck-inbound-sweep.test.ts tests/core/durability.test.ts tests/core/health.test.ts tests/core/messages.test.ts tests/core/database.test.ts tests/main-bootstrap.test.ts tests/transport/connection-branches.test.ts tests/transport/connection-branch-residuals.test.ts tests/scripts/requeue-inbound.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
```

Expected: PASS. No test may preserve the old `processing -> failed/crash_recovery` assertion for an inbound row that still has a message record and no terminal outbound proof.

- [ ] **Step 6: Commit the recovery consumer**

```bash
git add src/core/inbound-admission.ts src/core/inbound-replay.ts src/core/durability.ts src/core/health.ts src/core/messages.ts src/core/database.ts src/transport/connection.ts src/main.ts scripts/requeue-inbound.ts tests/core/inbound-admission.test.ts tests/core/inbound-replay.test.ts tests/core/durability-recovery.test.ts tests/core/durability-stuck-inbound-sweep.test.ts tests/core/durability.test.ts tests/core/health.test.ts tests/core/messages.test.ts tests/core/database.test.ts tests/main-bootstrap.test.ts tests/transport/connection-branches.test.ts tests/transport/connection-branch-residuals.test.ts tests/scripts/requeue-inbound.test.ts deploy/source-runtime-manifest.json docs/durability.md docs/public-surface.md
git commit -m "fix(durability): replay deferred inbound work"
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
```

The source-runtime guard runs on the committed Task 4 head because it
intentionally rejects dirty/staged hashed files. If it fails, correct hashes,
amend, and rerun the entire Task 4 matrix plus the guard; never call its
pre-commit dirty-file failure a semantic RED or a passing release check.

### Task 5: Make chat and agent queue admission durable (WS-A03, commit 2)

**Files:**
- Modify: `src/core/types.ts` for the shared bounded runtime-queue reason
- Modify: `src/runtimes/types.ts:38-49`
- Modify: `src/core/ingest.ts:320-370`
- Modify: `src/core/durability.ts`
- Modify: `src/core/inbound-failure-class.ts` for bounded `policy_unstable` and `queue_unavailable` classifications
- Modify: `src/core/reply-guarantee.ts` to key arm/disarm by immutable claim
- Modify: `src/core/admin.ts:80-170`
- Modify: `src/core/heal.ts` for an explicit system-lane tracked send
- Modify: `src/core/health.ts:71-72,823-910`
- Modify: `src/main.ts:670-715`
- Modify: `src/runtimes/chat/queue.ts:17-135`
- Modify: `src/runtimes/chat/runtime.ts:73-165`
- Modify: `src/runtimes/passive/runtime.ts` for bounded queue-probe parity
- Modify: `src/runtimes/agent/turn-queue.ts:19-103`
- Modify: `src/runtimes/agent/image-coalescer.ts`
- Modify: `src/runtimes/agent/outbound-queue.ts`
- Modify: `src/runtimes/agent/media-bridge.ts`
- Modify: `src/runtimes/agent/session.ts` for the explicit system/session-lifecycle send lane
- Modify: `src/runtimes/agent/control-queue.ts` for the explicit control/system send lane
- Modify: `src/runtimes/agent/runtime.ts:2810-2970, 3351-3371, 3421-3457`
- Modify: `src/core/substrate/poller.ts:163-171, 521-575, 624-662`
- Modify: `tests/runtimes/chat/queue.test.ts`
- Modify: `tests/runtimes/chat/runtime.test.ts`
- Modify: `tests/runtimes/passive/runtime.test.ts`
- Modify: `tests/runtimes/agent/turn-queue.test.ts`
- Modify: `tests/runtimes/agent/image-coalescer.test.ts`
- Modify: `tests/runtimes/agent/outbound-queue.test.ts`
- Modify: `tests/runtimes/agent/outbound-queue-idempotency.test.ts`
- Modify: `tests/runtimes/agent/media-bridge.test.ts`
- Modify: `tests/runtimes/agent/session.test.ts`
- Modify: `tests/runtimes/agent/control-queue.test.ts`
- Modify: `tests/runtimes/agent/codex-turn-lifecycle.test.ts`
- Modify: `tests/runtimes/agent/runtime-edge-coverage.test.ts`
- Modify: `tests/runtimes/agent/runtime-structural-policy.test.ts`
- Modify: `tests/runtimes/agent/runtime.test.ts`
- Modify: `tests/core/substrate/poller.test.ts`
- Modify: `tests/core/reply-guarantee.test.ts`
- Modify: `tests/core/ingest.test.ts`
- Modify: `tests/core/inbound-replay.test.ts`
- Modify: `tests/core/admin.test.ts`
- Modify: `tests/core/heal.test.ts`
- Modify: `tests/core/durability.test.ts`
- Modify: `tests/core/durability-edge.test.ts`
- Modify: `tests/core/inbound-failure-class.test.ts`
- Modify: `tests/core/health.test.ts`
- Modify: `scripts/requeue-inbound.ts` and `tests/scripts/requeue-inbound.test.ts` for invalid outbound-provenance archive
- Modify: `tests/core/heal-endpoint.test.ts`
- Modify: `tests/core/health-mark-read.test.ts`
- Modify: `tests/core/health-schedule.test.ts`
- Modify: `tests/integration/contracts.test.ts`
- Modify: `tests/main-bootstrap.test.ts`
- Modify: `tests/main-bootstrap-helpers.test.ts`
- Modify: `deploy/source-runtime-manifest.json` for changed hashed entrypoints
- Modify: `docs/durability.md`
- Modify: `docs/runbook.md:260-270,799-807`
- Modify: `docs/public-surface.md:129`

**Interfaces:**
- Consumes: `createAdmittedInboundDispatcher(...)`, immutable processing claims, and claim-taking `DurabilityEngine.deferInboundOrThrow(...)` from Task 3/4.
- Produces: `RuntimeQueueRejection`, `Runtime.handleMessage(...): Promise<void | RuntimeQueueRejection>`, side-effect-free `Runtime.probeQueueAdmission()`, canonical `AdmittedTurnAuthority`, `QueuedTurn.inboundAuthority`, claim-preserving Agent/Chat/ImageCoalescer ownership, observed queue-task failure callbacks, claim-guarded runtime completion/skip/failure, processing-claim outbound reservation plus a narrow pending-claim approval reservation, `AgentJobDispatchFn` accepting synchronous or asynchronous admission results, async `AgentRuntime.dispatchAgentJob(...)`, `InboundDeferredReason.access_granted`, `DurabilityEngine.applyAccessDecisionAndQueueReplays(...)`, alias-stable `DurabilityEngine.markAdmittedAccessDeniedIfCurrent(...)`, `HealthDeps.applyAccessDecision`, `ChatQueue.close(): void`, `ChatQueue.idle(): Promise<void>`, and `TurnQueue.close(): void`; both queues reject new work after close without discarding admitted work, every admitted async task has an observable lifecycle owner, and only the shared dispatcher converts bounded admission rejection into durable deferral.

- [ ] **Step 1: Add queue close/idle and durable-rejection tests**

Append this test to `tests/runtimes/chat/queue.test.ts`:

```ts
it('close rejects new work while idle waits for already admitted chains', async () => {
  const queue = new ChatQueue(1, 2);
  const held = deferred();
  expect(await queue.enqueue('chat-A', { run: () => held.promise })).toBe(true);
  queue.close();
  expect(await queue.enqueue('chat-B', { run: async () => undefined })).toBe(false);

  let idle = false;
  void queue.idle().then(() => { idle = true; });
  await Promise.resolve();
  expect(idle).toBe(false);
  held.resolve();
  await queue.idle();
  expect(idle).toBe(true);
});
```

Append this test to `tests/runtimes/agent/turn-queue.test.ts`:

```ts
it('close rejects later turns but drains turns admitted before close', async () => {
  const processed: string[] = [];
  const queue = new TurnQueue({ maxDepth: 2 });
  queue.enqueue(makeTurn({ text: 'admitted' }));
  queue.close();
  expect(queue.enqueue(makeTurn({ text: 'late' }))).toBe(false);
  queue.setProcessor(async (turn) => { processed.push(turn.text); });
  await queue.idle();
  expect(processed).toEqual(['admitted']);
});
```

Add this focused ChatRuntime test using a `ChatQueue(1, 0)` injected through a narrow test-only constructor option or private-field assignment already used by the suite:

```ts
it('returns a bounded rejection when the per-chat queue rejects admission', async () => {
  const { handler, db, durability } = makeHandler();
  (handler as unknown as { chatQueue: ChatQueue }).chatQueue = new ChatQueue(1, 0);
  const admission = admitInboundMessage(db, {
    ...makeStoredAdmissionInput('chat-queue-full'), admissionRoute: 'ingest',
  });
  if (!admission.accepted) throw new Error('fixture admission failed');
  const claim = durability.markInboundProcessing(admission.claim, 'chatruntime');
  if (!claim) throw new Error('fixture processing claim failed');

  await expect(handler.handleMessage(makeIncomingMessage({
    inboundSeq: claim.seq, inboundClaim: claim,
  }))).resolves.toEqual({
    outcome: 'queue_rejected',
    reason: 'chat_queue_full',
  });
});
```

Add the `ChatQueue` import at the top of that test file. Add the equivalent AgentRuntime test: saturate or close its `TurnQueue`, assert Reply Guarantee is disarmed, and expect exactly `{ outcome: 'queue_rejected', reason: 'agent_queue_full' }`. Neither runtime test mocks `DurabilityEngine`; the runtimes report admission, while the dispatcher owns persistence.

In `tests/core/ingest.test.ts`, table-drive both queue reasons through the real dispatcher. For each reason, make `deferInboundOrThrow` return each of `deferred`, `already_terminal`, `delivery_pending`, and `stale_claim`, then assert the corresponding `AdmittedInboundDispatchResult`; for `deferred`, assert the exact stored reason and due time. Separate cases make `deferInboundOrThrow` throw an invariant error and make its SQLite write throw: both dispatcher promises must reject, with no `runtime_failed` result or failure transition. Add replay-worker counterparts for `already_terminal`, `delivery_pending`, `stale_claim`, and `policy_skipped`, asserting zero dispatched/retried counts. Each branch must have a mutation proof that removing it makes the focused test RED.

- [ ] **Step 2: Run the queue tests and verify the close APIs are absent**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/chat/queue.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/runtime.test.ts tests/core/substrate/poller.test.ts tests/core/ingest.test.ts tests/core/inbound-replay.test.ts tests/core/admin.test.ts tests/core/durability.test.ts tests/core/health.test.ts tests/main-bootstrap.test.ts tests/main-bootstrap-helpers.test.ts --pool=forks
```

Expected: FAIL because neither queue has `close`, ChatQueue has no `idle`, both
runtimes erase rejection, direct callers bypass the dispatcher, and access
grant plus replay is not one atomic durable mutation. Record at least one
intended semantic failure from each new family; a compile-only or fixture failure
does not satisfy RED.

- [ ] **Step 3: Add close and idle to ChatQueue**

Add these fields and methods to `ChatQueue`:

```ts
  private accepting = true;
  private idleWaiters: Array<() => void> = [];
  private firstTaskFailure: { error: unknown } | null = null;
  private firstOwnerCallbackFailure: { error: unknown } | null = null;

  close(): void {
    this.accepting = false;
    this.resolveIdleIfNeeded();
  }

  async idle(): Promise<void> {
    if (this.pendingByChat.size !== 0 || this.activeChats !== 0 || this.waiting.length !== 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
    this.throwRetainedFailure();
  }

  private throwRetainedFailure(): void {
    if (this.firstTaskFailure) throw this.firstTaskFailure.error;
    if (this.firstOwnerCallbackFailure) throw this.firstOwnerCallbackFailure.error;
  }

  private resolveIdleIfNeeded(): void {
    if (this.pendingByChat.size !== 0 || this.activeChats !== 0 || this.waiting.length !== 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
```

Make the first branch in `enqueue` reject closed admission:

```ts
    if (!this.accepting) {
      this.dropped += 1;
      return false;
    }
```

Call `this.resolveIdleIfNeeded()` after the pending count and chain cleanup in the existing `finally` block.

Use this exact observed-work contract; ChatQueue remains independent of the
durability implementation while retaining the immutable claim as opaque
ownership evidence:

```ts
export interface ChatQueueTaskOwner {
  readonly claim: InboundProcessingClaim;
  readonly onError: (
    claim: InboundProcessingClaim,
    error: unknown,
  ) => void | Promise<void>;
}

export interface ChatQueueWork {
  readonly run: () => Promise<void>;
  readonly owner?: ChatQueueTaskOwner;
}

export interface QueueFailureHealth {
  readonly taskFailed: boolean;
  readonly ownerCallbackFailed: boolean;
}

enqueue(chatJid: string, work: ChatQueueWork): Promise<boolean>;
getFailureHealth(): QueueFailureHealth;
```

The queue awaits `work.run()`. On rejection it stores the first task error as
`{error: unknown}`, then awaits `owner.onError(owner.claim, error)` before chain
cleanup or idle resolution. A callback rejection is stored separately and emits
one bounded `chat_queue_error_owner_failed`; it never replaces the original task
error. `idle()` waits both operations, then throws the original task error, or
the callback error only when no task error exists, without clearing the bounded
health latch. Claimless synthetic/legacy work may omit `owner`, but its task
failure is still observed. Adapt simple queue tests to `{ run: ... }` and add
held owner, callback-throw, already-terminal/delivery-pending/stale-claim, and
same-sequence attempt-N/N+1 tests.

Add the mirrored Agent contract:

```ts
export interface TurnQueueOpts {
  maxDepth?: number;
  onReject?: (turn: QueuedTurn) => void;
  onTaskError?: (
    turn: QueuedTurn,
    error: unknown,
  ) => void | Promise<void>;
}
```

TurnQueue awaits that callback before advancing/idle, retains primary and
callback failures with the same precedence, and exposes `getFailureHealth()`.
AgentRuntime supplies a callback that uses `turn.inboundAuthority.claim` for the guarded
failure CAS; claimless jobs only latch the task failure. ChatRuntime builds a
`ChatQueueTaskOwner` per durable message and uses its exact claim. Both runtimes
store the first actual error privately, expose only the bounded two booleans in
health, and make shutdown drain every task/error callback before throwing the
primary retained error. Shutdown must continue its remaining local stops before
throwing; Task 6 folds these into the process-wide continue-all phase runner.

Either queue failure flag forces the owning Chat/Agent `RuntimeHealth.status` to
`unhealthy` until process restart and top-level `/health` to HTTP 503. Details
are limited to `queue_task_failed` and `queue_error_owner_failed` booleans plus
the bounded runtime kind; no error, claim identity, JID, or content is exposed.
Add before/after health tests for task-only and owner-callback failures in both
runtimes, including a failure settled before the first health request.

Give TurnQueue the same two `{error: unknown} | null` fields and exact
`throwRetainedFailure()` method. Its `idle()` must call that method both when the
queue is already empty and after its processor/error callback chain drains; it
must not clear either bounded health latch. Add mutation tests that delete each
call so an early-settled task failure cannot report a clean shutdown.

In `src/runtimes/types.ts`, add the bounded cross-runtime return without importing the durability layer, and widen the existing interface:

```ts
export interface RuntimeQueueRejection {
  outcome: 'queue_rejected';
  reason: 'chat_queue_full' | 'agent_queue_full';
}

export interface Runtime {
  start(): Promise<void>;
  handleMessage(msg: IncomingMessage): Promise<void | RuntimeQueueRejection>;
  // Preserve the existing remaining members unchanged.
}
```

Thread the immutable processing claim through every delayed runtime owner in
this commit. `QueuedTurn` carries `inboundAuthority?: AdmittedTurnAuthority`; a
durability-owned turn requires it and derives `inboundSeq`/claim from it. Replace the
per-chat `Map<string, number[]>` sequence FIFO with one FIFO of claims so shift,
crash, completion, and coalescing cannot desynchronize parallel arrays. Shared
and per-chat current-turn fields retain the claim object, not a bare sequence.
`ImageCoalescer` stores a claim per buffered inbound and uses claim-guarded skip
for every non-representative/abort row and claim-guarded failure for the
representative; all switches handle `changed`, `already_terminal`,
`delivery_pending`, and `stale_claim` without disarming or mutating a newer
attempt. Add initial-attempt and replay-attempt queue/coalescer tests, including a
delayed attempt N callback after N+1 owns the same sequence.

ImageCoalescer must also own already-fired timer work. Add an `accepting` latch,
a retained set of buffered claims awaiting shutdown disposition, and
catch-before-delete `activeFlushes: Set<Promise<void>>`; every timer callback
registers `flushImageCoalesce` before awaiting provider/session/durability work.
Its idempotent synchronous `quiesce(): void` flips `accepting` first, clears
not-yet-fired timers, and moves (without deleting) every associated buffered
claim into that retained shutdown set. It starts no async work and therefore is
safe before the first process-shutdown await. `closeAndDrain()` first calls
`quiesce()`, then calls `deferInboundOrThrow(claim, 'shutdown_deadline', 0)` once
for every retained buffered claim whose flush has not fired. It exhaustively handles `deferred`,
`already_terminal`, `delivery_pending`, and `stale_claim`; only `deferred`
increments the shutdown-deferral count, and no losing outcome disarms or mutates
a newer attempt. A SQLite/invariant failure is retained as the primary coalescer
failure and marks runtime health unhealthy. After those guarded transitions it
awaits all already-active flush and error-owner promises. AgentRuntime shutdown
awaits `closeAndDrain()` before session/DB teardown and exposes its retained
bounded failure. Add a multi-image buffered shutdown test with exact DB rows and
counter deltas, an explicit quiesce-before-drain test proving buffered ownership
is retained, a held flush that crosses shutdown, a throwing flush/CAS, and
stale attempt N/N+1 cases proving no provider launch, journal, send, or write
occurs after close and every pre-close claim has a terminal/deferred/owned
outcome.

Make the pre-Task-8 runtime completion boundary claim-aware too. Existing
`completeTurn`/runtime skip calls accept the retained `InboundProcessingClaim`
and include status/route/attempt in their guarded UPDATE; this commit preserves
the current delivery criterion but cannot complete a newer attempt. Task 8 later
replaces that criterion with exact terminal-operation/echo proof. Remove or make
internal every unconditional runtime completion/skip/failure method and add a
source inventory. Synthetic/durability-disabled work is the only claimless
runtime path and performs no inbound lifecycle mutation.

Move the minimum stale-send fence into this commit. Add one narrow exported
DurabilityEngine transaction reused by
`sendTracked`:

```ts
interface OutboundOpBaseParams {
  conversationKey: string;
  chatJid: string;
  opType: string;
  payload: string;
  replayPolicy: 'safe' | 'unsafe' | 'read_only';
  isTerminal?: boolean;
}

type AdmittedOutboundPayloadParams = Omit<
  OutboundOpBaseParams,
  'conversationKey' | 'chatJid'
>;

export type OutboundOpParams = OutboundOpBaseParams & {
  sourceInboundSeq?: never;
  sourceInboundRoute?: never;
  sourceInboundAttempt?: never;
};

export interface OutboundOpRow {
  // Preserve every existing field.
  sourceInboundSeq: number | null;
  sourceInboundRoute: string | null;
  sourceInboundAttempt: number | null;
}

export type ClaimGuardedOutboundReservation =
  | {
      outcome: 'reserved';
      outboundOpId: number;
      transportTarget: Readonly<{ conversationKey: string; chatJid: string }>;
    }
  | {
      outcome: 'existing_terminal';
      outboundOpId: number; status: OutboundStatus;
    }
  | { outcome: 'inbound_closed' }
  | { outcome: 'stale_claim' };

export type ClaimGuardedOutboundParams = {
  claim: InboundProcessingClaim;
} & AdmittedOutboundPayloadParams;

reserveOutboundForClaim(
  input: ClaimGuardedOutboundParams,
): ClaimGuardedOutboundReservation;

export type AdmittedTrackedSendResult =
  | { outcome: 'submitted'; outboundOpId: number }
  | Exclude<ClaimGuardedOutboundReservation, { outcome: 'reserved' }>;

export type SystemTrackedSendResult = {
  outcome: 'submitted';
  outboundOpId: number;
};

export type DurabilityDisabledSendResult = {
  outcome: 'submitted';
  tracking: 'disabled';
};

interface SendTrackedBaseOptions {
  replayPolicy: 'safe' | 'unsafe' | 'read_only';
  isTerminal?: boolean;
  caller?: GuardCaller;
  sourceInboundSeq?: never;
  sourceInboundRoute?: never;
  sourceInboundAttempt?: never;
}

export type SendTrackedOptions =
  | (SendTrackedBaseOptions & {
      lane: 'admitted';
      inboundClaim: InboundProcessingClaim;
    })
  | (SendTrackedBaseOptions & {
      lane: 'system' | 'synthetic';
      inboundClaim?: never;
    })
  | (SendTrackedBaseOptions & {
      lane: 'durability_disabled';
      inboundClaim?: never;
    });

export type SendTrackedRequest =
  | {
      messenger: Messenger;
      text: string;
      durability: DurabilityEngine;
      chatJid?: never;
      options: Extract<SendTrackedOptions, { lane: 'admitted' }>;
    }
  | {
      messenger: Messenger;
      text: string;
      durability: DurabilityEngine;
      chatJid: string;
      options: Extract<SendTrackedOptions, { lane: 'system' | 'synthetic' }>;
    }
  | {
      messenger: Messenger;
      text: string;
      durability?: undefined;
      chatJid: string;
      options: Extract<SendTrackedOptions, { lane: 'durability_disabled' }>;
    };

export function sendTracked(
  input: Extract<SendTrackedRequest, { options: { lane: 'admitted' } }>,
): Promise<AdmittedTrackedSendResult>;
export function sendTracked(
  input: Extract<SendTrackedRequest, { options: { lane: 'system' | 'synthetic' } }>,
): Promise<SystemTrackedSendResult>;
export function sendTracked(
  input: Extract<SendTrackedRequest, { options: { lane: 'durability_disabled' } }>,
): Promise<DurabilityDisabledSendResult>;
```

Its single `INSERT ... SELECT` matches `seq`, `routed_to`, and `attempt_count`,
requires status `processing` or the same claim's `turn_done` continuation, and
inserts `source_inbound_seq`, `source_inbound_route`, and
`source_inbound_attempt` from that immutable claim in the same statement. Every
admitted reservation, terminal or auxiliary, requires no prior terminal op in
any status so late progress/media cannot follow a chosen terminal owner. It classifies a lost
CAS by exact current state and never remints authority. Transport is allowed
only for `reserved`; `existing_terminal` transfers ownership to reconciliation,
while `stale_claim`/`inbound_closed` perform zero send. Every admitted
`sendTracked`/media/notice path must supply the exact claim and use this first
outbound reservation; claimless synthetic/system/disabled sends retain their
explicit lane and target. Every positional legacy call is migrated to this
object form. An admitted request cannot carry `chatJid`; a system/synthetic or
durability-disabled request must carry it and cannot carry an inbound claim. A
fast `isInboundClaimCurrent` check may avoid expensive provider
launch, but is not transport authority. Race attempt N→N+1 between that read and
the INSERT and assert zero op and zero transport from N. Task 8 consumes this
transaction and expands its receipt/echo semantics rather than redeclaring a
second terminal-claim primitive.

Implement the reservation inside `withImmediateTransaction` with one
`INSERT ... SELECT` from `inbound_events e`; the selected target and provenance
values are `e.conversation_key`, `e.chat_jid`, `e.seq`, `e.routed_to`, and
`e.attempt_count`. An admitted caller has no conversation/JID fields to supply,
even through the public TypeScript shape. The WHERE clause repeats the supplied
claim tuple plus the allowed `processing`/same-claim `turn_done` states and
all-status terminal-owner exclusion. Do not insert caller-provided target or
provenance values after a separate current-state read. If the INSERT changes
zero rows, classify existing-terminal, inbound-closed, stale-claim, or the
impossible still-open state inside that same immediate transaction. Add a
two-connection reservation race and fault after INSERT/before COMMIT.

```sql
INSERT INTO outbound_ops (
  conversation_key, chat_jid, op_type, payload, payload_hash, status,
  source_inbound_seq, source_inbound_route, source_inbound_attempt,
  is_terminal, replay_policy
)
SELECT e.conversation_key, e.chat_jid, ?, ?, ?, 'sending',
       e.seq, e.routed_to, e.attempt_count, ?, ?
FROM inbound_events e
WHERE e.seq = ?
  AND e.processing_status IN ('processing', 'turn_done')
  AND e.routed_to = ?
  AND e.attempt_count = ?
  AND NOT EXISTS (
    SELECT 1 FROM outbound_ops prior
    WHERE prior.source_inbound_seq = e.seq
      AND prior.is_terminal = 1
  )
RETURNING id, conversation_key, chat_jid;
```

Decode every returned or existing exact database identifier with one
`requireSafePositiveDbId(value, kind)` SSOT before it can enter a JS claim,
receipt, waiter, log, or transport call. A new outbound reservation validates
the `RETURNING id` inside its immediate transaction so an unsafe/rounded ID
throws and rolls the insert back. Existing unsafe terminal/op IDs are never
rounded/rebound; SQL-only health classification latches an invalid-authority
blocker for operator repair. Test exact `MAX_SAFE_INTEGER`, `MAX_SAFE+1`, and a
lossy `MAX_SAFE+2` for single reservation, existing-owner readback, completion,
and waiter registration; only the exact safe boundary may proceed.

An admitted reservation commits directly as `sending`; there is no durable
`pending -> sending` gap in which a later owner can claim the same inbound while
the first caller already intends transport. Crash recovery treats an unreceipted
`sending` row through the existing ambiguous/quarantine path. Claimless system
operations may retain their existing pending workflow because they own no inbound
terminal guarantee. The admitted transport uses only the returned DB-derived
`transportTarget`; it never reuses a caller/queue JID after reservation. Add
wrong-target cast, crash-before-transport, and lost-receipt tests.

The general `createOutboundOp` surface is now claimless/system-only and forbids
all three provenance inputs at runtime as well as in TypeScript.
`reserveOutboundForClaim` is the sole normal linked-op creator; the atomic
access-denied approval transaction is the sole post-terminal exception. No
normal admitted caller may fabricate route/attempt or create a linked
null-provenance row; only raw-SQL legacy fixtures may do so in tests. Inventory
both `sendTracked(` and `createOutboundOp(` across `src` and `tests`. Add
compile-negative, cast-around-runtime, row-decoding, and exact SQL mutation
tests. The cast-around cases deliberately provide a different conversation key
and JID and prove the stored inbound target is the only journal/transport
target; if a compatibility wrapper still accepts target hints, any mismatch is
an invariant before transport rather than an override.

Every admitted outbound row created after migration 37 must have non-null route
and attempt provenance. A pre-migration row with null provenance remains a
conservative all-status terminal owner and therefore blocks a resend, but it is
not exact completion proof for a modern attempt. The sole compatibility case
that may treat null provenance as exact is an unchanged legacy inbound tuple
whose `attempt_count=0` and whose lease/replay metadata are all null; any claimed
or replayed attempt (`attempt_count>=1`) paired with null outbound provenance is
`delivery_pending` plus a bounded legacy-provenance health finding, never
`complete`. Add fresh, legacy-attempt-zero, replay-attempt-one, mixed-provenance,
and forged-route/attempt tests. Do not backfill a route or attempt by guessing
from current mutable inbound state.

Reuse Task 3's `DurabilityHealthStats.invalidOutboundProvenance`, stable event,
health mapping, and bounded inspection query unchanged. Extend the dry-run-first, stopped-ingress repair tool with
`--archive-invalid-outbound-provenance`: after backup/checksum it atomically
marks each affected inbound `failed/operator_invalid_outbound_provenance`
without changing/resending/deleting the ambiguous op. It never backfills guessed
provenance. A restart may clear the persisted incident only after the active
gauge is zero. Test modern-null, mixed-null corruption, forged route/attempt,
proactive-null, exact legacy, dry-run, rollback, archive, and no blind resend.

The one deliberate post-terminal exception is the initial unknown-sender
operator approval notice. In the same immediate transaction where
`markAdmittedAccessDeniedIfCurrent` proves the exact claim/current alias/current
denial and wins `complete/access_denied`, it inserts at most one nonterminal
`outbound_ops` row with `op_type='approval_request'`, a constant content-free
payload marker, unsafe replay policy, and the exact source sequence/route/attempt
provenance captured from the exact authorizing ownership claim **before** the
inbound row moves to `access_denied`; the normal initial-denial shape is
`pending/ingest`. The transition API may consume processing/replay ownership for
policy closure, but `reserveInitialApproval=true` is valid only for a proven
initial pending claim; processing/replay never creates a notice. It must not copy the subsequently changed route.
This exception deliberately targets the trusted operator, never the untrusted
inbound chat. Resolve and validate the admin JID from the canonical
admin/access configuration before the transaction and derive its conversation
key with the canonical identity helper. The inbound row supplies only the exact
provenance; neither the unknown sender, a runtime callback, nor a cast-around
caller may override the trusted admin target. The duplicate guard considers any prior `approval_request` for
the sequence, including a legacy-null row, so upgrade cannot send a second
notice. The structured
`changed` result returns either a new
`{outcome:'reserved',outboundOpId,transportTarget}` receipt whose target is read
back from the inserted approval row
or `{outcome:'existing_notice',outboundOpId,status,transportTarget}` whose target
is read back and revalidated from the already-owned approval row. Only after that transaction
commits may `onUnknownSender` submit a newly reserved notice; ALLOW/remap
`policy_changed`, lost/terminal claims, replay calls, and existing notices send
nothing. Transport submission consumes the returned op ID directly and follows
the normal sending/submitted/maybe-sent transitions; it does not remint claim
authority after the inbound becomes terminal. A journal/CAS fault blocks before
transport, while a post-commit send/receipt fault leaves the inbound terminal,
latches bounded admitted-pipeline/operator-notice failure, and never reopens or
blindly resends it. Add crash points before the transaction, after reservation,
after transport submission, and before receipt persistence, plus ALLOW-wins and
attempt N/N+1 races; at most one approval op and transport submission may exist.
An explicit fixture uses `unknownChat !== adminChat`, proves only `adminChat`
appears in the journal/transport, and proves a wrong-target cast blocks before
send rather than notifying the unknown sender.
Task 5 correspondingly changes the initial ownership callback to
`onUnknownSender?: (reservation: {outboundOpId:number,transportTarget:Readonly<{conversationKey:string,chatJid:string}>}) => Promise<void>` and
invokes it only for a committed `changed` result whose approval outcome is
`reserved`. The callback cannot create an op, accept a bare sequence, or run for
`existing_notice`/replay/any losing result.

`sendTracked` accepts the discriminated `SendTrackedRequest` and returns
the lane-specific overload above. It derives all provenance only from
the required `lane:'admitted'` claim and writes all three provenance fields; that
lane reserves first, sends only `reserved`, and
returns `existing_terminal`/`inbound_closed`/`stale_claim` without transport.
Claimless system/synthetic/disabled calls must name their explicit lane and
forbid `inboundClaim` plus all three provenance inputs. Journaled system/synthetic
success requires an op ID; deliberately disabled success is explicitly
`tracking:'disabled'`. The atomic post-terminal approval path
consumes its transaction receipt directly rather than calling `sendTracked`;
every other admitted `sendTracked`, outbound-queue, media-bridge, or user-visible
notice consumes an exact processing claim. Every touched caller exhaustively
handles the result.

Run `rg -n 'sendTracked\(' src tests` and migrate every production caller and
its owning tests in this commit; no optional/default lane exists. Add TypeScript
negative fixtures proving an admitted call without `inboundClaim`, a claimless
call with one, and any call without `lane` fail compilation. Runtime tests prove
that casting around the type still hits the fail-closed lane assertion before
journal or transport.

Replace `OutboundQueue.setInboundSeq` and its mutable bare sequence with
`setInboundAuthority(authority: AdmittedTurnAuthority | undefined)`. Define the
sole shared authority in `src/core/types.ts`:

```ts
export interface AdmittedTurnAuthority {
  readonly claim: InboundProcessingClaim;
  readonly generation: symbol;
  readonly turnCompletionId: symbol;
}
```

Starting a durable turn creates this frozen authority once; OutboundQueue,
Reply Guarantee, media, and runtime finalization all consume the same object and
none creates a parallel generation. Every queued text,
stream fragment, progress item, tool batch, poll callback, flush, retry, and
terminal marker captures that authority at enqueue time rather than rereading a
later global field. Items from different generations cannot be coalesced. Each
outbound operation calls `reserveOutboundForClaim` with the captured claim before
transport; only `reserved` may send, while `existing_terminal`,
`inbound_closed`, and `stale_claim` cancel that item without touching the current
generation. `endTurn`/`abortTurn` clear only an exactly matching authority.
Claimless system/synthetic/disabled items use an explicit separate lane and may
not share a batch with durable work. Add held-flush and held-retry tests in which
attempt N is replaced by N+1 before reservation: N creates no new op/send and
cannot clear N+1. Include redirect/status, chunked text, poll, terminal marker,
and retry-exhaustion paths; remove the current unjournaled final “delivery
failed” transport notice.

Replace the media bridge's mutable `_currentChatJid` with an immutable current
turn descriptor `{authority:AdmittedTurnAuthority}` installed by
`setMediaBridgeTurn(...)`. Each parsed request captures that descriptor before
any async file/provider work. Durable media reserves an exact nonterminal
`outbound_ops` row with `op_type='media_<bounded-type>'` and a constant
content-free payload marker before calling `sendMedia`, then uses the existing
sending/submitted/maybe-sent transitions and returned WhatsApp message ID. The
media transport target is the reservation's DB-derived `transportTarget`, never
a bridge/current-chat field. A
late descriptor from attempt N returns a bounded stale-turn response and sends
nothing after N+1 is installed; clearing the bridge compares generation and
claim. System media must select an explicit claimless bridge lane rather than
falling through from a missing claim. Tests hold file stat/read, first encrypted
temp retry, and transport while replacing N with N+1, and assert exact ops,
stream cleanup, no path/JID/error leakage, and zero stale transport.

Thread the exact `adminClaim` from Task 3 into the Task 5 signatures of
`handleAdminCommand` and `handleFallbackCommand`. Every admitted admin reply or
tracked notice uses `SendTrackedOptions.inboundClaim=adminClaim` and exhaustively
handles the reservation result before the caller terminalizes the admin claim.
Truly process/session/control-plane notices in `session.ts` are enumerated as
the system lane; a notice caused by an admitted current turn is not system work
and is removed at this boundary unless it is claim-reserved. Add a source
inventory and real-DB tests covering admin success/failure, session lifecycle,
control work, and a late admin attempt so no admitted send is mislabeled
claimless.

Do not let queue internals swallow post-admission failures. `ChatQueue` awaits
the work item's `owner.onError(claim, err)` before its chain continues; TurnQueue's
processor does the same with the exact `QueuedTurn`. AgentRuntime and ChatRuntime
retain the first bounded async-task failure in health, run the claim-guarded
failure CAS (preserving terminal outbound ownership), and expose it to later
shutdown drain. Add held/throwing media, provider-preflight, TurnQueue processor,
STDIN, and non-STDIN cases plus stale-attempt races. A log-only catch, detached
shutdown, or a processing row left open must make the suite RED.

Update every Task 5 RED fixture that supplies an `inboundSeq` to a durable
runtime: admit a real row, convert its returned pending claim with
`markInboundProcessing`, pass the resulting claim on the message/queued turn,
and assert the same route/attempt survives rejection or delayed execution. Do
not make the production invariant optional to preserve a bare-sequence mock.

Inventory every non-command `sendDirect`/direct transport path in the touched
runtimes. For an admitted failure in this WS-A03 boundary, do not send after
terminalizing the inbound: remove the outer/session/STDIN “something went
wrong” transports and emit bounded operator evidence only. System/admin-only
sends are explicitly classified and never mutate an admitted row. Task 8 may
restore user-visible failure notices only through an atomic claim-linked
terminal operation. Assert zero transport call without a prior outbound journal
for every crash/spawn/queue-task branch.

In `createAdmittedInboundDispatcher`, keep only `await runtime.handleMessage(msg)` inside its runtime/provider `try/catch`. Immediately after that catch, handle a returned `RuntimeQueueRejection` with this exhaustive boundary; `seq` has already been validated and claimed:

```ts
if (runtimeResult?.outcome === 'queue_rejected') {
  if (!msg.inboundClaim) throw new Error('runtime queue rejection missing processing claim');
  const outcome = durability.deferInboundOrThrow(msg.inboundClaim, runtimeResult.reason);
  switch (outcome) {
    case 'deferred': {
      const deferred = durability.getInboundDeferral(seq);
      if (!deferred) throw new Error('runtime queue deferral state missing after successful transition');
      return { outcome: 'deferred', reason: deferred.reason, replayAfter: deferred.replayAfter };
    }
    case 'already_terminal':
      return { outcome: 'already_terminal' };
    case 'delivery_pending':
      return { outcome: 'delivery_pending' };
    case 'stale_claim':
      return { outcome: 'stale_claim', stage: 'dispatch' };
    default: {
      const neverOutcome: never = outcome;
      throw new Error(`unhandled runtime queue deferral outcome: ${neverOutcome}`);
    }
  }
}
```

Do not place this block inside the runtime catch and do not let ChatRuntime or AgentRuntime call durability. This ordering is what makes a failed deferral reject the initial lifecycle/replay tick rather than masquerade as `runtime_failed`.

Define the access surfaces before implementing them:

```ts
export interface ApplyAccessDecisionInput {
  subjectType: 'phone' | 'group';
  action: 'allow' | 'block';
  subjectId: string;
  replayCap?: number;
  now?: number;
}

export interface ApplyAccessDecisionResult {
  action: 'allow' | 'block';
  subjectType: 'phone' | 'group';
  accessChanged: boolean;
  queued: number;
  alreadyQueued: number;
  refused: Readonly<{
    missingProvenance: number;
    invalidMetadata: number;
    ineligibleState: number;
    terminalOwnership: number;
  }>;
}

applyAccessDecisionAndQueueReplays(
  input: ApplyAccessDecisionInput,
): ApplyAccessDecisionResult;

export type InitialApprovalReservation =
  | {
      outcome: 'reserved';
      outboundOpId: number;
      transportTarget: Readonly<{ conversationKey: string; chatJid: string }>;
    }
  | {
      outcome: 'existing_notice';
      outboundOpId: number;
      status: OutboundStatus;
      transportTarget: Readonly<{ conversationKey: string; chatJid: string }>;
    };

export type AccessDeniedTransitionResult =
  | { outcome: 'changed'; approval: InitialApprovalReservation | null }
  | { outcome: 'policy_changed' }
  | { outcome: 'already_terminal' }
  | { outcome: 'delivery_pending' }
  | { outcome: 'stale_claim' };

markAdmittedAccessDeniedIfCurrent(input: {
  claim: InboundOwnershipClaim;
  subjectType: 'phone';
  normalizedSubjectId: string;
  accessCause: 'unknown' | 'pending' | 'blocked';
  reserveInitialApproval: boolean;
}): AccessDeniedTransitionResult;

export interface HealthDeps {
  // Preserve existing fields.
  applyAccessDecision?: (
    input: ApplyAccessDecisionInput,
  ) => ApplyAccessDecisionResult | Promise<ApplyAccessDecisionResult>;
}
```

Both approval variants are ownership-bearing DB receipts: decode and validate
their full target from the selected/inserted row inside the same transaction.
Add exact-type and runtime tests for reserved and existing-notice paths, including
a legacy existing row with the wrong admin target; the mismatch must block before
the callback or transport, and the callback still runs only for `reserved`.

Normalize `replayCap` once to a finite integer in `0..100` (default the bounded
configured cap). Default `now` once before `BEGIN IMMEDIATE`, then require it to
be a nonnegative safe-integer epoch second; reject NaN, infinity, fractions,
negative values, and overflow rather than coercing them. Reject invalid
action/type/subject data on the same fail-closed boundary.
The shared dispatcher exhaustively switches every access-denial outcome. Admin
and health callers exhaustively consume the result counts. Authenticated
`POST /access` returns 200 only with that bounded result after commit, 400 for
invalid input, and bounded 503 `access_decision_failed` when the callback
rejects; the response/log never contains the subject value or raw exception.
When the optional callback is absent, retain only the legacy direct mutation
mechanism; return the same redacted bounded result shape (with zero replay
counts), never the old subject-bearing response. Add cap 0/1/100/out-of-range, every result branch,
callback-rejection rollback, and response-redaction tests that exclude the
fixture phone/JID from 200/400/503 bodies and logs in both mechanisms. Add
table-driven invalid-`now` cases and exact valid boundary assertions proving no
access or inbound row changes on rejection.

Widening the runtime result exposes direct-call bypasses that must be closed in
the same commit. Add `'access_granted'` to `InboundDeferredReason`, its fully
initialized health-counter map, and the bounded event vocabulary, then implement
the typed `DurabilityEngine.applyAccessDecisionAndQueueReplays(...)` transaction
defined below. Normalize only the bounded subject value before `BEGIN IMMEDIATE`;
resolve database-backed JID/LID aliases and select candidates inside the same
snapshot. For `allow/phone`, queue only a current-schema
`complete/access_denied` DM row with no terminal outbound evidence,
`attempt_count >= 1`, non-null metadata that passes the shared validators, and
the exact Task 3 access-denial provenance/route. Clear its terminal fields and
move it to immediately due `deferred/access_granted` without changing attempt
count. Never synthesize `mentioned_jids_json='[]'`,
`is_response_worthy=1`, or a new inbound row from legacy storage: old
`access_denied` collapsed trigger, mention, protocol, and access decisions and
therefore cannot prove replay eligibility. Null/invalid metadata, message-only
rows, reactions/poll votes/status/protocol/blank input, groups/self messages,
missing/deleted or mismatched messages, other terminal reasons, exhausted
attempts, and terminal outbound evidence are refused with bounded reason counts
and require the explicit repair/reconciliation workflow. Active rows are
reported idempotently as already queued. `block` and group decisions mutate
access without queueing. A failure anywhere rolls back both access and batch;
concurrent double allow queues zero duplicates. Add legacy
non-response-worthy/not-mentioned/reaction/poll/blank/status counterexamples and
prove none reaches the worker, plus a current-provenance row that runs the real
worker exactly once.

Close the remaining policy-decision race with `markAdmittedAccessDeniedIfCurrent`: one guarded immediate transaction joins the exact claim to its persisted message sender, resolves the current JID/LID alias from that same database snapshot, and first requires the resulting normalized phone to equal `normalizedSubjectId`. An alias mismatch returns `policy_changed` without mutation. Only then may it recheck the normalized access row and change the expected `pending/ingest` or `processing/replay` row to `complete/access_denied` while the current subject is still not allowed. Invoke it only for ALLOW-sensitive, replay-eligible DM denial reasons (unknown/pending/blocked access), not for trigger gates such as `not_response_worthy`, not-mentioned, `groups_only`, or `self_only`; those retain the normal guarded policy skip. It returns `policy_changed` when ALLOW or alias remapping won, in which case the shared dispatcher reruns current policy and either claims/continues runtime processing or applies the new current branch; it may not use the stale denial result. Thus either denial terminalization wins first and the ALLOW transaction queues it, or ALLOW/remap wins first and denial cannot terminalize it. Add held two-connection tests for both ALLOW/CAS interleavings and both routes, including a row admitted before ALLOW but paused immediately before the denial CAS. Add both alias-remap directions: blocked A→allowed B before CAS cannot stale-deny B, and allowed A→blocked B before the pre-runtime recheck cannot dispatch B. Repeat with the alias update held before and after the access mutation. Add allowed-but-not-mentioned and non-response-worthy cases proving they terminate once through the generic policy branch without a `policy_changed` loop. Increment `deferralsByReason.access_granted` by the exact changed-row count and emit matching bounded `inbound_deferred{reason:'access_granted'}` events only after the combined transaction commits; rollback, active/idempotent rows, alias mismatch, and `policy_changed` change neither.

Bound the dispatcher's `policy_changed` loop to two fresh rechecks after the
initial decision. If a flapping writer wins both races, throw a bounded
`AdmittedPolicyUnstable` while the exact claim remains unchanged; the initial
pipeline/replay worker blocker latches and no stale denial, approval side
effect, processing claim, or runtime call occurs. Add a held two-connection
ALLOW/BLOCK flapping test and mutate the retry counter to prove the loop cannot
be unbounded.

Add `policy_unstable` and `queue_unavailable` to the bounded
`InboundFailureClass` union and `classifyErrorForInbound`'s explicit
`instanceof` cases. `AdmittedPolicyUnstable` serializes only its fixed message,
failure class, recheck count, and frozen claim tuple into the admitted-pipeline
health snapshot; `LegacyRuntimeQueueUnavailable` serializes only its fixed
message, failure class, and bounded queue reason into the legacy-queue snapshot.
Neither carries a raw cause, JID, subject, message ID, content, or stack into
logs/health/alerts. Add exact-classification and redaction tests, including a
lookalike generic `Error` whose text must not receive either special class.

Define the Task 5-owned types in `src/core/types.ts` and
`src/core/inbound-failure-class.ts` (not in Task 4's health surface):

```ts
// src/core/types.ts
export type RuntimeQueueFailureReason =
  | 'chat_queue_full'
  | 'agent_queue_full';

// src/core/inbound-failure-class.ts
export class AdmittedPolicyUnstable extends Error {
  readonly rechecks = 2;
  constructor(readonly claim: InboundOwnershipClaim) {
    super('admitted inbound policy did not stabilize');
  }
}

export class LegacyRuntimeQueueUnavailable extends Error {
  constructor(readonly reason: RuntimeQueueFailureReason) {
    super('legacy runtime queue admission unavailable');
  }
}
```

`RuntimeQueueRejection.reason` imports and uses
`RuntimeQueueFailureReason`; there is one vocabulary owner and no core→runtime
import or cycle. The two classes are available before the explicit classifier
branches and are introduced, compiled, tested, and committed only by Task 5.

When durability is enabled, both `handleAdminCommand` and the `/access` decision callback call this combined helper instead of calling `updateAccess`/`upsertAccess` or `runtime.handleMessage` first. Rename the health dependency to `applyAccessDecision`; when provided, `POST /access` delegates the entire mutation to it and returns success only after it commits. A callback error returns a bounded non-2xx response and cannot leave the access row changed; the health route uses direct `upsertAccess` only when no transactional callback is configured. Send/log the bounded “queued for replay” count only after commit; Task 4's worker is the sole consumer and rechecks the now-current allow policy. The durable path never marks process-local replay IDs. When durability is deliberately disabled, retain the direct compatibility path but inspect `RuntimeQueueRejection`, move `rememberReplayedId` after accepted runtime admission, and report bounded queue-unavailable failure instead of claiming replay success. Update the admin callback type accordingly. In AgentRuntime's synthetic scheduled-job caller, await its own bounded return before reporting `dispatched: true`; a queue rejection returns `dispatched: false` so the scheduler can retry. Because this commit touches the access paths, replace Pino payloads containing `subjectId`, `senderJid`, phone values, or message IDs with bounded action/type/count/result fields; user-facing admin replies keep their intended text, but logs, health bodies, and metrics do not carry those identifiers. Add real-DB tests for new and legacy access-denied rows, grant-plus-queue rollback, a fault exactly between the access statement and replay updates, concurrent alias-map write versus ALLOW, concurrent double allow, policy recheck, durable queue saturation, durability-disabled rejection, the `/access` non-2xx/unchanged-row boundary, bounded log payloads, and the synthetic-job rejection. This removes every production caller that would otherwise erase the widened return.

Task 3's ordinary durability-disabled `runLegacyInbound` call is another direct
caller. It must inspect `RuntimeQueueRejection`; on rejection it emits only
`inbound_legacy_queue_rejected{reason}`, widens `IngressBlockedSnapshot.stage`
with `legacy_queue` and `operationStage` with `queue_admission`, trips that
distinct blocker with no ownership tuple, and throws a bounded
`LegacyRuntimeQueueUnavailable`. It does not invent a deferral or report the
message handled. Add Chat/Agent saturation plus paused/admin/accepted parity
tests, and prove health is non-green until restart.

Add `RuntimeQueueAdmissionProbe = {outcome:'ready'} |
{outcome:'unavailable';reason:'chat_queue_full'|'agent_queue_full' |
'chat_queue_busy'|'agent_queue_busy'|'chat_queue_closed'|'agent_queue_closed'}`
and required `Runtime.probeQueueAdmission(): Promise<RuntimeQueueAdmissionProbe>`
to the runtime contract. `ChatQueue` and `TurnQueue` each expose a synchronous,
side-effect-free `probeAdmissionState()` executed under the same queue-owned
serialization primitive used by admission. It returns ready only when the queue
is accepting, has capacity, and has no active or pending item; it never enqueues,
dequeues, starts, cancels, or awaits work. Chat and Agent map that atomic state to
the runtime result; Passive returns `ready`. A pre-existing residual durable or
synthetic turn therefore yields `*_queue_busy` without invoking a processor,
provider, session, transport, or durability callback. Add a fixture with one
residual turn and spies for every such side effect: the probe must leave the item
and queue counters unchanged, withhold clear/readiness, and make every spy remain
at zero. A mutation back to a claimless no-op/`idle()` canary must make the test
RED. The `legacy_queue` stage maps only to persisted alert source
`inbound_legacy_queue_blocked`, never
`inbound_admitted_pipeline_blocked`. It has no same-process clear. Before a
restarted process attaches ingress, main runs this side-effect-free real queue
canary after runtime core construction; only `ready` may issue one idempotent
proof-gated clear for a persisted/unknown prior incident. Rejection, callback
failure, or any non-empty residual queue withholds clear and readiness. Add
persisted-incident, false-clear mutation, Chat/Agent/Passive, and callback-fault
tests. The admitted-pipeline canary remains scoped to DB policy/claim/terminal
CAS and cannot clear this queue incident.

Update ChatRuntime admission and shutdown to:

```ts
  async shutdown(): Promise<void> {
    this.chatQueue.close();
    let primaryFailure: { error: unknown } | null = null;
    try {
      await this.chatQueue.idle();
    } catch (error) {
      primaryFailure = { error };
    }
    try {
      await this.enrichmentPoller?.stop();
    } catch (error) {
      primaryFailure ??= { error };
    }
    log.info({ event: 'chat_runtime_shutdown_complete' }, 'ChatRuntime shutdown complete');
    if (primaryFailure) throw primaryFailure.error;
  }

  async handleMessage(msg: IncomingMessage): Promise<void | RuntimeQueueRejection> {
    const traceId = randomBytes(4).toString('hex');
    const startTime = Date.now();
    const durableNormal = this.durability !== undefined && msg.isSyntheticJob !== true;
    if (durableNormal) {
      if (!msg.inboundClaim) throw new Error('durable chat message missing processing claim');
      if (msg.inboundSeq !== undefined && msg.inboundSeq !== msg.inboundClaim.seq) {
        throw new Error('durable chat message ownership mismatch');
      }
      msg.inboundSeq = msg.inboundClaim.seq;
    } else if (msg.inboundClaim !== undefined || msg.inboundSeq !== undefined) {
      throw new Error('claim supplied on claimless chat lane');
    }
    const owner = msg.inboundClaim ? {
      claim: msg.inboundClaim,
      onError: (claim: InboundProcessingClaim, error: unknown) =>
        this.handleDurableTaskError(claim, error),
    } : undefined;
    const admitted = await this.chatQueue.enqueue(
      msg.chatJid,
      {
        run: () => this.processMessage(msg, traceId, startTime),
        owner,
      },
    );
    if (!admitted) return { outcome: 'queue_rejected', reason: 'chat_queue_full' };
  }
```

Import `RuntimeQueueRejection` as a type from `../types.ts` and
`InboundProcessingClaim` from the canonical core types. Implement
`handleDurableTaskError` as the one exhaustive
`markAdmittedInboundFailed(claim, classifyErrorForInbound(error))` owner; it
records bounded health and returns normally for changed/already-terminal,
delivery-pending, or stale-claim, but lets a SQLite/invariant exception reject
the owner callback. Accepted/processed messages preserve the existing
`undefined` return.

- [ ] **Step 4: Add close to TurnQueue and handle agent rejection before dequeue**

Add this field and method to `TurnQueue`:

```ts
  private accepting = true;

  close(): void {
    this.accepting = false;
  }
```

Make `enqueue` reject when closed:

```ts
    if (!this.accepting || this.queue.length >= this.maxDepth) {
      log.warn(
        { event: 'agent_queue_rejected', maxDepth: this.maxDepth, pending: this.queue.length },
        'turn rejected — queue unavailable',
      );
      this.onReject?.(turn);
      return false;
    }
```

Because Task 5 touches the queue decision paths, replace every log payload in `src/runtimes/chat/queue.ts` and the existing `TurnQueue.onReject` callback in `src/runtimes/agent/runtime.ts` that contains `chatJid` or `senderJid`. Use stable events (`chat_queue_rejected`, `chat_queue_started`, `chat_queue_slot_released`, `chat_queue_cleaned`, `agent_queue_rejected`) with only bounded capacity/pending/active counts and reason. Add log-sink tests covering reject, run, slot transfer, cleanup, and agent rejection; fixture JIDs/content must be absent and return/admission behavior unchanged.

Import `RuntimeQueueRejection` as a type and widen both AgentRuntime's existing outer method and `_handleMessageInner` to `Promise<void | RuntimeQueueRejection>`. The current outer method assigns the inner promise to `turnChain` and returns immediately, while its catch erases both queue rejection and runtime failure. Replace that tail with two promises: return the per-message operation to the dispatcher, and retain a separately observed `Promise<void>` only to keep the internal chain live:

```ts
    const operation = this.turnChain.then(() => this._handleMessageInner(msg));
    this.turnChain = operation.then(
      () => undefined,
      (err) => {
        log.error(
          { event: 'agent_message_processing_failed', failureClass: classifyErrorForInbound(err) },
          'unhandled error in message processing',
        );
      },
    );
    return operation;
```

The observer must not call `markInboundFailed`, disarm by sequence, or otherwise consume the error: the returned operation rejects so the shared dispatcher produces `runtime_failed`, after which initial ingest or replay owns the single guarded lifecycle transition. Remove the earlier `markInboundFailed` from the unrecoverable inline-extractor catch as well; that path may mark the bounded continuity candidate, but it emits only bounded class/stage telemetry and throws to the dispatcher without a lifecycle terminal write or user transport. Mechanically replace every log/alert payload in the touched outer method that contains the raw error, message ID, chat/sender JID, phone, or error message with bounded event, content type, stage, and `failureClass`. Awaiting `operation` waits only for existing local routing and queue admission/send acceptance, never for completion of a queued Agent turn. Add an actual outer-method test that fills/closes `TurnQueue` and observes `RuntimeQueueRejection`, an inner-throw test, a log-sink redaction test, and a pre-chain unrecoverable-extractor test proving the caller rejects, the internal chain remains usable for the next message, no user send occurs, the claim-aware Reply Guarantee later observes the resulting state, and no runtime-owned deferral write occurs. Mutating a direct failure write/send back in, restoring an identifier/error payload, or `return operation` back to the old fire-and-forget tail must make the corresponding test RED.

The substrate poller currently requires a synchronous `AgentJobDispatchFn` and reads `.dispatched` immediately. Widen it without making the poller wait for turn completion:

```ts
export type AgentJobDispatchFn = (
  ctx: AgentJobContext,
) => AgentJobDispatchResult | Promise<AgentJobDispatchResult>;
```

Change the private poller method to `async dispatchAgentJob(...): Promise<ExecuteOutcome>` and use `result = await this.agentJobDispatch(...)` inside its existing `try/catch`; `executeTrigger` is already async and returns/assimilates that promise. Update the comment from “synchronous by design” to state that the promise covers queue admission only. Make AgentRuntime's production callback async: await `this.handleMessage(synthetic)`, return `dispatched:false` with a bounded queue-unavailable detail on `RuntimeQueueRejection`, return true only after accepted admission, and map a rejection to the existing failed result. Add poller tests for synchronous compatibility, delayed accepted admission, async queue rejection, and async throw; the trigger result must not be recorded before the admission promise settles, while no test waits for the queued turn itself.

Replace the shared-mode enqueue block at `src/runtimes/agent/runtime.ts:3356-3371` with:

```ts
    if (this.shared) {
      const durableNormal = this.durability !== undefined && msg.isSyntheticJob !== true;
      if (durableNormal) {
        if (!msg.inboundClaim) throw new Error('durable agent turn missing processing claim');
        if (msg.inboundSeq !== undefined && msg.inboundSeq !== msg.inboundClaim.seq) {
          throw new Error('durable agent turn ownership mismatch');
        }
        msg.inboundSeq = msg.inboundClaim.seq;
      } else if (msg.inboundClaim !== undefined || msg.inboundSeq !== undefined) {
        throw new Error('claim supplied on claimless agent lane');
      }
      const claim = msg.inboundClaim;
      const authority: AdmittedTurnAuthority | undefined = claim
        ? Object.freeze({
            claim,
            generation: Symbol('admitted-turn-generation'),
            turnCompletionId: Symbol('admitted-turn-completion'),
          })
        : undefined;
      const admitted = this.turnQueue.enqueue({
        chatJid,
        senderJid: msg.senderJid,
        senderName: msg.senderName ?? null,
        text,
        isGroup: msg.isGroup,
        groupName: msg.isGroup ? chatJid : undefined,
        ...(authority ? {
          inboundSeq: authority.claim.seq,
          inboundAuthority: authority,
        } : {}),
      });
      if (!admitted) {
        return { outcome: 'queue_rejected', reason: 'agent_queue_full' };
      }
```

Do not mutate shared current-turn output state or arm Reply Guarantee before
successful queue admission. `TurnQueue`'s processor-start callback atomically
installs an authority-keyed `SharedTurnOutputState` containing content type,
assistant text, and assistant-item text, then arms that same authority before
the first provider/session call. Event handlers resolve only the active queue
item's canonical authority and its keyed state; they never clear process-global
text fields on admission. Exact finish/abort removes only that entry. Delete the
later shared-mode arm at current `src/runtimes/agent/runtime.ts:3454`.
Add an active held turn plus rejected-next-message test: the rejection must not
change the active authority, output buffers, RGP timers, provider/session call,
or eventual terminal reply. Mutating the pre-enqueue clears/arm back in must make
the test RED.
Mechanically migrate every durability-owned arm, disarm, activity reset, and
diagnostic `isArmed` check in shared, single, and per-chat scopes to the exact
`AdmittedTurnAuthority`. Each scope creates it once at admitted-turn entry and
passes that same object to TurnQueue, OutboundQueue, Reply Guarantee, media, and
finalization; no consumer creates its own generation. A newer same-sequence attempt retires the older claim generation; an old
callback/disarm cannot touch it. Claimless synthetic/durability-disabled paths
do not arm or mutate inbound lifecycle, but they still enqueue and return a
bounded rejection to their direct owner. Add scope-parity, shared synthetic and
durability-disabled accept/reject, and attempt-N/N+1 timer tests.

For both runtimes table-drive the lane discriminator: durable normal with claim
only derives `inboundSeq`; durable normal with matching claim+seq succeeds;
neither, seq-only, or mismatch rejects; durability-disabled and explicit
synthetic work succeeds only with neither authority. A claim on a claimless lane
is an invariant, not a test convenience.

- [ ] **Step 5: Run queue, runtime, and reply-guarantee regression suites**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/chat/queue.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/passive/runtime.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/image-coalescer.test.ts tests/runtimes/agent/outbound-queue.test.ts tests/runtimes/agent/outbound-queue-idempotency.test.ts tests/runtimes/agent/media-bridge.test.ts tests/runtimes/agent/session.test.ts tests/runtimes/agent/control-queue.test.ts tests/runtimes/agent/codex-turn-lifecycle.test.ts tests/runtimes/agent/runtime-edge-coverage.test.ts tests/runtimes/agent/runtime-structural-policy.test.ts tests/runtimes/agent/runtime.test.ts tests/core/substrate/poller.test.ts tests/core/reply-guarantee.test.ts tests/core/ingest.test.ts tests/core/inbound-replay.test.ts tests/core/admin.test.ts tests/core/heal.test.ts tests/core/durability.test.ts tests/core/durability-edge.test.ts tests/core/inbound-failure-class.test.ts tests/core/health.test.ts tests/core/heal-endpoint.test.ts tests/core/health-mark-read.test.ts tests/core/health-schedule.test.ts tests/integration/contracts.test.ts tests/main-bootstrap.test.ts tests/main-bootstrap-helpers.test.ts tests/scripts/requeue-inbound.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
```

Expected: PASS. A rejected Agent queue decision leaves Reply Guarantee and the
already-active turn's authority/output state untouched and returns
`RuntimeQueueRejection`; only an accepted item's processor-start callback arms
its exact authority before provider/session work. The dispatcher test then proves `deferInboundOrThrow(..., 'agent_queue_full')` returning `deferred` is the only point at which replay is scheduled. Open-state false and SQLite-throw mutations must reject rather than become `runtime_failed`. Direct admin/API/synthetic callers must either queue durable replay or surface the bounded rejection, never erase it. Document the `access_granted` transition, atomic ALLOW-plus-replay boundary, non-2xx rollback behavior, inspection query, and worker-owned replay; update the public `/access` surface note. Recompute and stage every affected entrypoint hash before the drift guard.

- [ ] **Step 6: Commit durable queue outcomes**

```bash
git add src/core/types.ts src/runtimes/types.ts src/core/ingest.ts src/core/durability.ts src/core/reply-guarantee.ts src/core/inbound-failure-class.ts src/core/admin.ts src/core/heal.ts src/core/health.ts src/core/substrate/poller.ts src/main.ts src/runtimes/chat/queue.ts src/runtimes/chat/runtime.ts src/runtimes/passive/runtime.ts src/runtimes/agent/turn-queue.ts src/runtimes/agent/image-coalescer.ts src/runtimes/agent/outbound-queue.ts src/runtimes/agent/media-bridge.ts src/runtimes/agent/session.ts src/runtimes/agent/control-queue.ts src/runtimes/agent/runtime.ts scripts/requeue-inbound.ts tests/runtimes/chat/queue.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/passive/runtime.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/image-coalescer.test.ts tests/runtimes/agent/outbound-queue.test.ts tests/runtimes/agent/outbound-queue-idempotency.test.ts tests/runtimes/agent/media-bridge.test.ts tests/runtimes/agent/session.test.ts tests/runtimes/agent/control-queue.test.ts tests/runtimes/agent/codex-turn-lifecycle.test.ts tests/runtimes/agent/runtime-edge-coverage.test.ts tests/runtimes/agent/runtime-structural-policy.test.ts tests/runtimes/agent/runtime.test.ts tests/core/substrate/poller.test.ts tests/core/reply-guarantee.test.ts tests/core/ingest.test.ts tests/core/inbound-replay.test.ts tests/core/admin.test.ts tests/core/heal.test.ts tests/core/durability.test.ts tests/core/durability-edge.test.ts tests/core/inbound-failure-class.test.ts tests/core/health.test.ts tests/core/heal-endpoint.test.ts tests/core/health-mark-read.test.ts tests/core/health-schedule.test.ts tests/integration/contracts.test.ts tests/main-bootstrap.test.ts tests/main-bootstrap-helpers.test.ts tests/scripts/requeue-inbound.test.ts deploy/source-runtime-manifest.json docs/durability.md docs/runbook.md docs/public-surface.md
git commit -m "fix(runtime): make queue rejection a durable outcome"
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
```

Run the source-runtime guard only on the committed Task 5 head. A correction
requires amend plus a full Task 5 matrix rerun.

### Task 6: Quiesce ingress, replay, runtimes, and transport on shutdown (WS-A03, commit 3)

**Files:**
- Modify: `src/runtimes/types.ts` for the abortable split lifecycle contract
- Modify: `src/runtimes/passive/runtime.ts` so its socket server is ready-owned
- Modify: `src/transport/runtime-connection.ts:18-43`
- Modify: `src/transport/connection.ts` for abortable generation-fenced connect
- Modify: `src/transport/twilio/connection-bridge.ts`
- Modify: `src/core/post-connect-recovery.ts` for abortable history/echo waits
- Modify: `src/core/ingest.ts` for the observed pre-ready admission gate
- Modify: `src/core/durability.ts` for `startup_not_ready` deferral ownership
- Modify: `src/core/heal.ts` so degradation sends are awaited by their owner
- Modify: `src/lib/model-advisor.ts` for an owned currency-monitor lifecycle
- Modify: `src/main.ts:385-393, 777-799, 972-1015`
- Modify: `src/main-shutdown-policy.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `src/runtimes/agent/image-coalescer.ts` for synchronous quiesce integration
- Modify: `src/runtimes/agent/session.ts` for generation-owned reset/respawn settlement
- Modify: `src/runtimes/agent/handoff-distill-coordinator.ts`
- Modify: `src/runtimes/chat/runtime.ts` to await enrichment shutdown
- Modify: `src/core/reply-guarantee.ts` to track timeout handlers and await shutdown
- Modify: `src/core/substrate/poller.ts:330-370`
- Modify: `src/core/scheduler.ts:60-100,164-360`
- Modify: `src/core/media-retention.ts:150-200`
- Modify: `src/core/database-retention.ts:119-160`
- Modify: `src/memory/consolidation-scheduler.ts`
- Modify: `src/runtimes/chat/enrichment/poller.ts:40-80`
- Modify: `src/core/health.ts` for required mutation readiness and awaited close/drain
- Modify: `deploy/source-runtime-manifest.json` for changed hashed entrypoints
- Create: `tests/core/inbound-shutdown-lifecycle.test.ts`
- Modify: `tests/core/reply-guarantee.test.ts`
- Modify: `tests/runtimes/chat/runtime.test.ts`
- Modify: `tests/runtimes/passive/runtime.test.ts`
- Modify: `tests/runtimes/agent/image-coalescer.test.ts`
- Modify: `tests/runtimes/agent/session.test.ts`
- Modify: `tests/transport/twilio/connection-bridge.test.ts:190-240`
- Modify: `tests/transport/connection-connect-failure.test.ts`
- Modify: `tests/transport/connection-branches.test.ts`
- Modify: `tests/core/post-connect-recovery.test.ts`
- Modify: `tests/core/ingest.test.ts`
- Modify: `tests/core/inbound-replay.test.ts`
- Modify: `tests/core/durability.test.ts`
- Modify: `tests/core/heal.test.ts`
- Modify: `tests/lib/model-advisor.test.ts`
- Modify: `tests/main-bootstrap.test.ts`
- Modify: `tests/main-bootstrap-helpers.test.ts`
- Modify: `tests/main-shutdown-policy.test.ts`
- Modify: `tests/core/substrate/poller.test.ts`
- Modify: `tests/core/scheduler.test.ts`
- Modify: `tests/core/media-retention.test.ts`
- Modify: `tests/core/database-retention.test.ts`
- Modify: `tests/memory/consolidation-scheduler.test.ts`
- Modify: `tests/runtimes/chat/enrichment/poller.test.ts`
- Modify: `tests/runtimes/agent/runtime.test.ts`
- Modify: `tests/runtimes/agent/handoff-distill-coordinator.test.ts`
- Modify: `tests/runtimes/agent/idle-session-eviction.test.ts`
- Modify: `tests/runtimes/agent/zombie-sessions.test.ts`
- Modify: `tests/core/health.test.ts`
- Modify: `tests/core/heal-endpoint.test.ts`
- Modify: `tests/core/health-mark-read.test.ts`
- Modify: `tests/core/health-schedule.test.ts`
- Modify: `tests/integration/contracts.test.ts`
- Modify: `tests/transport/reconnect.test.ts`
- Modify: `docs/durability.md`
- Modify: `docs/runbook.md`
- Modify: `docs/public-surface.md`

**Interfaces:**
- Consumes: `InboundReplayWorker` from Task 4, `createAdmittedInboundDispatcher` from Task 3, async AgentJob dispatch from Task 5, and queue `close()/idle()` from Task 5.
- Produces: one `AbortController`-backed startup/readiness/shutdown lifecycle, generation-fenced `RuntimeConnection.connect(signal)`/`shutdown()`, abortable post-connect recovery, split runtime core/background startup, owned/drained main and runtime producers, `ReplyGuaranteeManager.shutdown(): Promise<void>`, awaited `TriggerPoller.stop()`/`MessageScheduler.stop()`, an awaited health-server close/drain, fail-closed authenticated mutation readiness, and a shutdown order of latch/abort/switch the still-attached ingress router to stopping → stop/drain health mutations and producers → close ingest admission → stop replay/poller/scheduler admission and await in-flight work → settle ingest pipelines → drain/defer runtime/watchdogs → await transport → detach the now-closed ingress callback → await startup settlement → close DB.

- [ ] **Step 1: Write a shutdown-order source-and-behavior test**

Create `tests/core/inbound-shutdown-lifecycle.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TurnQueue } from '../../src/runtimes/agent/turn-queue.ts';

describe('inbound shutdown lifecycle', () => {
  it('drains an admitted turn after admission closes', async () => {
    const release = vi.fn();
    const queue = new TurnQueue();
    const claim = Object.freeze({
      seq: 9, status: 'processing' as const, route: 'agent', attemptCount: 1,
    });
    const authority = Object.freeze({
      claim,
      generation: Symbol('shutdown-generation'),
      turnCompletionId: Symbol('shutdown-completion'),
    });
    queue.enqueue({
      chatJid: 'shutdown@s.whatsapp.net',
      senderJid: 'sender@s.whatsapp.net',
      senderName: 'Shutdown User',
      text: 'finish me',
      isGroup: false,
      inboundSeq: 9,
      inboundAuthority: authority,
    });
    queue.close();
    queue.setProcessor(async () => { release(); });
    await queue.idle();
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps the stopping router attached through transport, then detaches before database close', () => {
    const source = readFileSync(resolve('src/main.ts'), 'utf8');
    const stopping = source.indexOf("lifecycleState = 'stopping'");
    const abort = source.indexOf('lifecycleController.abort(', stopping);
    const stoppingRouter = source.indexOf('lifecycleIngressRouter.enterStopping(', abort);
    const preReadyQuiesce = source.indexOf('preReadyIngressGate.quiesce()', stoppingRouter);
    const quiesce = source.indexOf('runtime.quiesce()', preReadyQuiesce);
    const producerQuiesce = source.indexOf('mainProducerRegistry.quiesce()', quiesce);
    const preReadyIdle = source.indexOf("runShutdownPhase('pre_ready_ingress'", producerQuiesce);
    const ingestClose = source.indexOf("runShutdownPhase('ingest_close'", preReadyIdle);
    const replay = source.indexOf("runShutdownPhase('replay'", ingestClose);
    const mainProducers = source.indexOf("runShutdownPhase('main_producers'", replay);
    const ingestIdle = source.indexOf("runShutdownPhase('ingest_idle'", mainProducers);
    const runtime = source.indexOf("runShutdownPhase('runtime'", ingestIdle);
    const transport = source.indexOf("runShutdownPhase('transport'", runtime);
    const detach = source.indexOf('connectionManager.onMessage = null', transport);
    const close = source.indexOf("runShutdownPhase('database'", transport);
    expect(stopping).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(stopping);
    expect(stoppingRouter).toBeGreaterThan(abort);
    expect(preReadyQuiesce).toBeGreaterThan(stoppingRouter);
    expect(ingestClose).toBeGreaterThan(stoppingRouter);
    expect(quiesce).toBeGreaterThan(stoppingRouter);
    expect(producerQuiesce).toBeGreaterThan(quiesce);
    expect(preReadyIdle).toBeGreaterThan(producerQuiesce);
    expect(replay).toBeGreaterThan(ingestClose);
    expect(mainProducers).toBeGreaterThan(replay);
    expect(ingestIdle).toBeGreaterThan(mainProducers);
    expect(runtime).toBeGreaterThan(ingestIdle);
    expect(transport).toBeGreaterThan(runtime);
    expect(detach).toBeGreaterThan(transport);
    expect(close).toBeGreaterThan(transport);
  });
});
```

- [ ] **Step 2: Run the shutdown tests and verify transport close is currently unawaited**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-shutdown-lifecycle.test.ts tests/transport/twilio/connection-bridge.test.ts --pool=forks
```

Expected: FAIL because `main.ts` calls `connectionManager.shutdown()` without
`await`, does not switch the attached router to a stopping gate before drains,
and lacks the post-transport callback detach proof.

- [ ] **Step 3: Make asynchronous shutdown part of the transport contract**

Change the `RuntimeConnection` signature to a proof-carrying result:

```ts
export type TransportShutdownOutcome =
  | { outcome: 'closed'; deliveryClosed: true }
  | { outcome: 'closed_with_failure'; deliveryClosed: true; failureClass: TransportShutdownFailureClass }
  | { outcome: 'close_unproven'; deliveryClosed: false; failureClass: TransportShutdownFailureClass };

export type TransportShutdownFailureClass =
  | 'adapter_close_failed'
  | 'socket_close_failed'
  | 'webhook_close_failed'
  | 'subscription_close_failed'
  | 'callback_drain_failed'
  | 'unknown_transport_close_failure';

shutdown(): Promise<TransportShutdownOutcome>;
isDeliveryClosed(): boolean;
```

The monotonic `deliveryClosed` latch becomes true only after sockets/adapters,
webhooks/subscriptions, reconnect timers, and every delivery callback source are
irreversibly closed. Both transports continue teardown after an internal error,
return `closed_with_failure` only when that latch is proven, and otherwise
return `close_unproven`; an unexpected rejection is converted at main only
after rereading `isDeliveryClosed()`. Update fakes to return an explicit
outcome—`mockResolvedValue(undefined)` is forbidden because it proves nothing.
Each adapter and main maps errors exhaustively to the closed failure-class
union; unknown values use only `unknown_transport_close_failure`. Cast-around
raw strings/errors/stacks never reach the outcome, log, or health snapshot.
Add one test per class plus arbitrary object/string/credential-shaped errors and
assert bounded mapping and redaction.

- [ ] **Step 4: Wire and order the replay worker in main**

Reuse the exact `dispatchAdmitted` and retained `ingestHandler` created by Task
3, including its admission-blocked callback; do not redeclare either or replace
the handler with an optionless factory call. Pass that same dispatcher into
replay. There must be no direct `runtime.handleMessage` callback in replay
wiring:

```ts
const inboundReplayWorker = new InboundReplayWorker(db, durability, {
  dispatchAdmitted,
  batchSize: 10,
  intervalMs: 5_000,
  onBlocked: (snapshot) => {
    latchRuntimeMutationBlock('replay_worker', snapshot);
    lifecycleIngressRouter.enterBlocked(blockedIngressGate);
    requestObservedControlledShutdown('replay_worker_blocked');
  },
});
```

Pass `getReplayHealth: () => inboundReplayWorker.getHealth()` and the same
fail-closed `isMutationReady` callback into `HealthDeps`. The replay `onBlocked`
callback is installed before `start()`. `latchRuntimeMutationBlock` is a
main-owned idempotent helper that synchronously stores the first bounded blocker
and irreversibly sets `mutationReady=false`. The callback synchronously moves the
single lifecycle ingress router to an observed blocked gate before any alert/callback await and
cannot be cleared in process. The blocked gate continues authenticated self-echo
storage/correlation; ordinary messages use Task 2 atomic admission and exact
`deferInboundOrThrow(claim, 'runtime_blocked', 0)` with no runtime/admin/provider
side effect; authenticated control frames remain unacknowledged for upstream
redelivery. It then requests the existing observed controlled-shutdown path.
Using `onMessage=null` is forbidden because that can silently drop both echo
proof and new inbound while transport remains connected. A post-ready tick
failure must therefore make `/health` 503 and all
authenticated mutations 503 while preserving the worker's original failure;
callback/alert/shutdown-request failure cannot restore either surface. Add
`runtime_blocked` to the bounded deferral vocabulary/counters and test a held
ordinary message, self echo, and control frame between blocker latch and
transport close.

Construction must not start asynchronous producers. Change the canonical runtime
contract and every implementation/mock explicitly:

```ts
export interface Runtime {
  start(signal: AbortSignal): Promise<void>; // core initialization only
  startReadyProducers(signal: AbortSignal): Promise<void>;
  activateReadyProducers(): void;
  quiesce(): void;
  stopReadyProducers(): Promise<void>;
  handleMessage(msg: IncomingMessage): Promise<void | RuntimeQueueRejection>;
  shutdown(): Promise<void>;
  // Preserve the remaining existing members.
}

export interface OwnedProducerHandle {
  readonly name: string;
  stop(): Promise<void>;
}

export interface OwnedProducerRegistry {
  quiesce(): void;
  stopOwned(name: string): Promise<void>;
  stopRemaining(): Promise<void>;
}
```

Chat and Agent own an internal producer registry. Passive `start(signal)` is
core-only and does not open its current socket server;
`startReadyProducers(signal)` owns creation/bind of that server behind a dormant
request gate, `activateReadyProducers()` opens the gate, and
`quiesce()`/`stopReadyProducers()` stop admission then drain/close it. Passive is
not allowed to implement the ready methods as no-ops while the socket exists.
`start(signal)` may open/configure only bounded
core state needed for recovery and queue admission. Agent global MCP/media socket
servers, proactive session creation/resume, pending-poll rehydration and expiry
notices, provider probes, health/queue/session timers, workspace/zombie/idle
sweepers, control-session timers, and handoff distillation all move to
`startReadyProducers`. Every MCP/request handler also checks the lifecycle signal
and dormant/ready latch before mutation/session/send. Chat enrichment moves to its ready
phase. A runtime ready-start failure stops every handle already started in reverse
order, awaits all stops, retains the first start/rollback error, and leaves the
runtime unready; `activateReadyProducers()` is synchronous, idempotent, and
non-throwing after successful preparation; `stopReadyProducers()` is idempotent and uses the same reverse
continue-all drain. `quiesce()` synchronously closes queue admission and latches
Reply Guarantee, enrichment, probes, sweepers, sockets, poll/control callbacks,
and distillation against new work without awaiting. `shutdown()` invalidates the
runtime startup generation before awaiting anything, calls `quiesce()` and
`stopReadyProducers()`, and prevents a held `start()` or ready continuation from
later creating a session/socket/timer. Agent, Chat, and Passive each retain an
in-flight start promise plus a generation/stopped latch: shutdown invalidates
the generation before teardown, and every continuation disposes resources it
created if it no longer owns that generation. Hold internal Agent/Passive await
seams in tests, start shutdown, then release them and prove they cannot repopulate
sessions, sockets, callbacks, or timers.

In main, construct but do not start startup
cleanup, metrics backfill/aggregation, daily retention, media/process-temp/
database retention, echo/stuck-inbound/degradation/LID intervals,
MessageScheduler, TriggerPoller, MemoryConsolidationScheduler,
InboundReplayWorker, or the model-currency monitor. Move
`messageScheduler.recoverStale()` too because it mutates SQLite.

After `await runtime.start(signal)`, abortable transport connect, and abortable
history/echo recovery all succeed, main awaits Task 4's
`drainPreReadyTerminalReconciliationOrThrow(...)` and exhaustively handles its
`drained|blocked_evidence` result. Only a `drained` result may proceed; blocked
evidence latches mutation health and fails startup, while abort/generation loss
throws the exact startup abort. Then one main-owned `OwnedProducerRegistry` checks
the lifecycle signal before every item, starts the runtime ready producers, then
the complete enumerated main producer registry in a **dormant** state. It
registers each handle only after a successful preparation/start. Every callback,
including an immediate timer/poller/scheduler/replay callback, first checks the
shared activation latch and may perform no fetch, claim, write, session, or send
while it is closed. If item N fails/aborts, the registry stops N-1..1 in reverse,
then calls `runtime.stopReadyProducers()`, awaits every rollback, retains the first
failure, and never sets ready. Once all handles are registered, main moves the
lifecycle router to the admission-only handoff gate, closes/idles the original
gate, and drains the retained exact admin
claims while the activation latch remains closed. Only after that succeeds does
one synchronous commit set lifecycle/mutation readiness, call
`runtime.activateReadyProducers()`, and open the main activation latch; JavaScript
cannot interleave a callback inside that commit. Each async callback enters
an observed catch-before-delete task set; synchronous callbacks are explicitly
classified and cancelled by retained handles. `startModelCurrencyMonitor`
becomes an owned start/stop/drain handle rather than launching an unretained
fetch/interval. Lifecycle moves through `starting -> recovering ->
starting_producers -> ready`; `ready` and mutation readiness flip only after the
entire registry succeeds, remains dormant, and the pre-ready ingress gate below drains. If any
readiness step rejects or aborts, no producer remains and startup fails. Add a
source inventory that accounts for every main/runtime
`setTimeout`, `setInterval`, `.start()`, and fire-and-forget promise.

Add fake-clock bootstrap tests that advance past every interval while each of
runtime/connect/history/echo-grace readiness is held and prove no cleanup,
provider/Pinecone fetch, recovery write, claim, AgentJob dispatch, scheduled
send, enrichment, or replay. Release all barriers and prove every registry item
starts exactly once only after activation. Fault each registry index and assert
reverse rollback with zero surviving handle. Force every prepared producer's
nominal immediate callback before activation and assert zero side effects, then
activate and assert exactly one owned run. Hold Agent global MCP, proactive resume, pending-poll
rehydration, and Chat enrichment separately and prove no request/session/send
starts before the full recovery boundary. Any unclassified producer or start
before post-connect recovery must make the test RED.

Use one main-owned lifecycle state plus one `AbortController`, not independent
booleans: startup begins in `starting`, passes through `recovering` and
`starting_producers`, moves to `ready` only after post-connect/history recovery,
Task 4's pre-ready terminal reconciliation, transactional producer start,
lifecycle-router handoff, and pre-ready ingress drain, and moves irreversibly to
`stopping`. Shutdown assigns `stopping`, aborts the controller, synchronously
switches the still-attached lifecycle router to `stoppingIngressGate`, and
quiesces runtime before its first await; it does not detach ingress until
transport closure is proven.
Check the signal after every awaited readiness
boundary, at entry to the recovery callback before any post-connect DB work, and
immediately before each producer start. Retain and
observe the top-level startup promise. Shutdown first moves the lifecycle to
`stopping`; after runtime/transport teardown it awaits that startup promise
(treating the bounded internal startup-aborted sentinel as expected) before DB
close. This lets transport shutdown unblock a held connect without allowing the
continuation to start history recovery or producers. Add table-driven held
runtime-start, connect, history, and recovery tests: begin shutdown at each
barrier, release it, and prove no late producer launch, SQLite write, or send
occurs after teardown/close and DB close remains blocked until startup settles.
Any continuation that checks only once, or a shutdown path that closes the DB
without owning startup settlement, must make a test RED.

Define the bounded abort sentinel in `src/main-shutdown-policy.ts`, and the
mutation-block owner in `src/main.ts`; neither is pseudocode-only:

```ts
export class StartupAborted extends Error {
  readonly code = 'STARTUP_ABORTED';
  constructor() {
    super('startup aborted');
    this.name = 'StartupAborted';
  }
}

function latchRuntimeMutationBlock(
  source: 'replay_worker' | 'pre_ready_ingress' | 'reply_guarantee',
  snapshot: Readonly<Record<string, unknown>>,
): void {
  mutationReady = false;
  runtimeMutationBlock ??= toBoundedRuntimeMutationBlock(source, snapshot);
}
```

`toBoundedRuntimeMutationBlock` is an exhaustive local mapper that keeps only
enumerated stage/failure/count fields and rejects raw error/JID/content input.
`settleStartupAfterShutdown` suppresses only `instanceof StartupAborted`; text
matching is forbidden. Unit tests cover repeated latches, a lookalike generic
error, and preservation of the first snapshot.
Transport/runtime layers do not import or recreate this main-owned sentinel.
After disposing a losing generation they rethrow the exact `signal.reason`
(using `signal.throwIfAborted()` where available), so the instance supplied by
main reaches `settleStartupAfterShutdown` unchanged and passes the `instanceof`
check. Add an identity test across each abortable boundary.

Do not attach the full `ingestHandler` before readiness. Before transport connect,
attach one observed `lifecycleIngressRouter` whose initial target is a distinct
`preReadyIngressGate` with no runtime/provider/admin/approval/control side
effects. The router owns synchronous modes
`pre_ready | handoff | ready | blocked | stopping`; transport never swaps among
raw async callbacks itself. It preserves authenticated self-echo storage and
correlation. Every other ordinary/admin message first uses Task 2 atomic
admission; a normal `pending/ingest` claim is immediately handled through
`deferInboundOrThrow(claim, 'startup_not_ready', 0)`, while a bounded set of
exact `pending/admin` claims is retained for initial-only post-producer drain.
Add `startup_not_ready` to `InboundDeferredReason` and its initialized
counter/event map. If the admin set reaches its fixed bound, terminalize the
new row only after `markInboundProcessing(pendingClaim, 'admin')` returns its
exact processing claim, then use the normal exact failure CAS to
`failed/admin_command_failed` with route `startup_admin_capacity_refused`.
`pending` authority is never passed to a processing-only failure method. A lost
processing claim is classified exhaustively as already-terminal,
delivery-pending, or stale and executes no side effect; an unexplained open row
or storage fault latches ingress unhealthy and prevents readiness. Emit/alert
once only after the committed failure transition, and execute no admin side effect.
Every pre-ready promise is catch-before-delete tracked; a storage/CAS fault
latches ingress unhealthy and prevents readiness.

After both dormant producer registries succeed, synchronously move the router to
an admission-only `handoffIngressGate`, then seal/close/idle the original
pre-ready gate and drain its retained admin claims in admission order through
the exact Task 3 admin-claim path. The handoff gate preserves self echoes and
atomically admits then exact-defers **all** ordinary/admin messages as
`startup_not_ready`; it executes no admin/control/runtime side effect and retains
no process-only admin queue. Thus arrivals during any awaited original-gate or
admin drain cannot reach the full runtime.

Only after that drain succeeds does one synchronous, non-throwing commit set
lifecycle/mutation state to `ready`, point the router at the full `ingestHandler`,
call `runtime.activateReadyProducers()`, and open the main producer activation
latch. Then close/idle the handoff gate; its already-started atomic admissions
settle only as durable deferrals and are consumed by the now-active replay
worker. Shutdown moves the router to `stopping`, closes both gates, and awaits
their active admissions; any remaining leased claim is left for next-start
recovery, not reminted in the exiting process. Add messages at every handoff
await seam and prove one admission, zero early runtime/admin effects, and one
later replay outcome. A raw `onMessage=ingestHandler` assignment before the
synchronous commit must make the source/behavior test RED.

Authenticated control-protocol frames remain outside `messages`. The transport
gate must hold them in its existing delivery/ack boundary until the full handler
is installed; an acknowledged in-memory-only buffer is forbidden. Add captured
WhatsApp and Twilio contract tests proving a frame emitted at held connect,
history, and echo-grace is either delivered exactly once after activation or
left unacknowledged for upstream redelivery after abort. If either adapter cannot
prove that contract, Task 6 is blocked until a dedicated durable control-message
lifecycle is added; do not report the ordinary-message gate as covering control.
Tests for normal/admin/self-echo delivery at every barrier prove one durable
admission, zero pre-ready runtime/control/approval effects, and exactly one
post-ready dispatch/admin execution or exact shutdown/startup-recovery outcome.

Change `RuntimeConnection.connect(signal: AbortSignal)` and both transports to
generation-fenced startup. `ConnectionManager` and Twilio capture a connect
generation, recheck generation/stopped/signal after every auth, version,
adapter, webhook, and subscription await, and dispose any socket/server created
by a losing generation before rejecting with the bounded startup-aborted
sentinel. `shutdown()` latches stopped and increments the generation before
teardown, so a held connect cannot install a live socket/webhook afterward.
Add held tests at each await seam for both transports; release after shutdown
and prove no message/history handler, socket, webhook, or reconnect timer is
installed and a second close is idempotent.

Every connect/reconnect attempt receives a new generation. Initial
`ConnectionManager.connect(signal)` does not resolve merely after handler/socket
construction: it awaits that generation's usable `connection=open` proof (or an
equivalent `whenConnected(signal)` promise), and setup/auth/socket errors reject
startup rather than being swallowed into a reconnect loop. A losing Twilio
generation calls `adapter.disconnect()` so its poll interval cannot survive and
cancels/generation-checks the deferred `setImmediate(historySyncComplete)`.
Connection tests cover overlapping connect/reconnect generations, a setup error,
shutdown before usable-open, and a late open from the loser.

Give `waitForHistorySyncThenRecover` the same `AbortSignal`. Abort clears and
rejects both the history timeout and echo-grace wait and checks again before the
recovery callback. Test shutdown during history wait, timeout transition, echo
grace, and immediately before recovery; none may run post-connect DB work or
outlive the process hard ceiling.

Extend the history dependency with a disposable subscription (`off` or a
returned unsubscribe handle). Success, timeout, abort, and recovery rejection
all remove the exact `historySyncComplete` listener in `finally`; listener-count
tests must return to baseline after every branch and after repeated reconnects.

Keep read-only `/health` available during startup, but add a required
main-provided `isMutationReady` callback to `HealthDeps`; there is no fail-open
default, and every direct server fixture supplies an explicit state. After authenticating each POST route
and before reading its body or touching runtime/transport/SQLite, fail closed
with HTTP 503 and a fixed `startup_not_ready` body unless lifecycle state is
`ready`. Cover `/send`, `/schedule`, `/agent/compact`, `/heal`, `/access`, and
`/mark-read` in a table-driven health test; an unauthenticated request must retain
its existing auth response rather than gaining a readiness oracle. Hold every
readiness barrier, invoke each authenticated mutation, and prove zero send,
runtime, callback, or DB effects; release readiness and prove the same route can
execute. Once state becomes `stopping`, the callback never becomes ready again.
The same callback participates in `/health`: while lifecycle state is
`starting` or `stopping`, the body exposes only bounded
`mutation_ready:false` and `startup_state`, forces overall `unhealthy`, and
returns HTTP 503 even if transport has connected. It cannot report a
healthy/readiness-shaped result while every mutation is refused. Add the held
history/recovery case explicitly, then prove `ready` flips the body/status once
and `stopping` is irreversible. Document early endpoint reachability versus
readiness in `docs/runbook.md` and the startup/recovery section of
`docs/durability.md`.

Add one main-owned outbound-background registry for the echo-timeout
`drainPendingOutbound` promise and delayed startup/back-online notification
timers/sends. Every timer handle is retained; every launched promise is observed
catch-before-delete in a set. Shutdown first latches new launches off and clears
not-yet-fired timers, then awaits the active set before runtime/transport/DB
teardown. The echo interval callback may never fire-and-forget an untracked
drain. Add a held-drain test and an immediate-shutdown-before-3s test: active
drain completion is awaited, delayed notifications are cancelled before send,
and neither path touches durability/transport after close. Reuse this registry
rather than adding unrelated one-off flags per timer.

Add this import:

```ts
import { InboundReplayWorker } from './core/inbound-replay.ts';
```

Do not put the shutdown sequence in one fail-fast `try`: an early rejection must
not skip runtime or transport teardown and fall directly into `db.close()`.
Record the first failure, log only bounded phase/class metadata, and attempt every
phase in order with a small local `runShutdownPhase(name, fn)` helper. The ordered
phases begin with:

```ts
    lifecycleState = 'stopping';
    lifecycleController.abort(new StartupAborted());
    lifecycleIngressRouter.enterStopping(stoppingIngressGate);
    preReadyIngressGate.quiesce();
    runtime.quiesce();
    mainProducerRegistry.quiesce();
    stopMainOutboundScheduling();
    await runShutdownPhase('health', () => closeHealthServer(healthServer));
    await runShutdownPhase('pre_ready_ingress', () => preReadyIngressGate.closeAndDrain());
    await runShutdownPhase('ingest_close', () => ingestHandler.close());
    await runShutdownPhase('replay', () => mainProducerRegistry.stopOwned('replay'));
    await runShutdownPhase('trigger_poller', () => mainProducerRegistry.stopOwned('trigger_poller'));
    await runShutdownPhase('message_scheduler', () => mainProducerRegistry.stopOwned('message_scheduler'));
    await runShutdownPhase('memory_consolidation', () => mainProducerRegistry.stopOwned('memory_consolidation'));
    await runShutdownPhase('media_retention', () => mainProducerRegistry.stopOwned('media_retention'));
    await runShutdownPhase('database_retention', () => mainProducerRegistry.stopOwned('database_retention'));
    await runShutdownPhase('main_outbound', stopAndDrainMainOutboundBackground);
    await runShutdownPhase('main_producers_remaining', () => mainProducerRegistry.stopRemaining());
    await runShutdownPhase('runtime_producers', () => runtime.stopReadyProducers());
    await runShutdownPhase('ingest_idle', () => ingestHandler.idle());
```

The stopping assignment, abort, attached-router mode switch,
pre-ready/runtime quiesce, and
both main launch latches are synchronous and occur before the first awaited
phase. `preReadyIngressGate.closeAndDrain()` awaits every observed admission and
then exact-defers or leaves restart-owned every retained claim; it cannot drop an
admin/control item. `stopOwned(name)` atomically marks one registered handle as
consumed before invoking its stop callback; `stopRemaining()` then drains only
unconsumed handles in reverse registration order. A named stop rejection is
retained but is never invoked again by `stopRemaining`. Thus the registry is the
sole lifecycle owner even though `runShutdownPhase` preserves named phase
observability. Add a registry mutation test that counts every underlying stop
exactly once, including when an earlier named stop rejects. Advance fake
clocks while queue/health/replay drains are held and prove no new watchdog,
enrichment, MCP, session, poll, probe, sweeper, distillation, or main callback
starts. `runShutdownPhase` catches and retains the first `{phase,error}` while
returning normally so every later phase is attempted; no raw `await` outside
that helper may make one failure skip a later owner.

Make `TriggerPoller.stop()` latch new scheduling off, clear the next timer, and
await the currently owned `tickOnce/processTrigger` promise before resolving.
Track the active promise with catch-before-delete semantics, and recheck the
stopped latch before a completed tick schedules another timer. A manual tick
after stop starts no dispatch/write. This awaited poller phase must precede
runtime and database teardown because AgentJob dispatch and `trigger_runs`
writes are asynchronous.

Give `MessageScheduler` the same ownership contract: `stop(): Promise<void>`
latches scheduling off, clears the interval, and awaits the immediate or interval
`tick()` currently using transport/SQLite. Serialize tick ownership so overlapping
timer/manual invocations cannot escape the tracked promise, and recheck the latch
before scheduling again. Add a held scheduled-send test that starts shutdown
during transport, proves stop is pending, releases the send and final SQLite
write, then permits transport/DB teardown; no send or write may occur afterward.

Wrap the Node health server's callback close in `closeHealthServer():
Promise<void>` (or return an equivalent async handle from `startHealthServer`).
It stops accepting new requests and resolves only after active handlers and
connections drain; do not call synchronous-looking `healthServer.close()` and
continue. This phase precedes runtime/transport/DB teardown because `/access`
now owns an async transaction and `/send` may use transport. Add held authenticated
`/access` and `/send` integration tests: begin each handler, start shutdown,
prove later teardown is blocked, release the handler, observe its response/state,
then prove runtime/transport and DB close occur. New requests after close begins
must be refused and no handler may write/send after teardown.

After background timer cleanup, the final phases are:

```ts
    await runShutdownPhase('runtime', () => runtime.shutdown());
    const transportOutcome = await runTransportShutdownPhase(connectionManager);
    if (transportOutcome.deliveryClosed) {
      await runShutdownPhase('stopping_ingress', () => stoppingIngressGate.closeAndDrain());
      connectionManager.onMessage = null;
      await runShutdownPhase('startup_settlement', settleStartupAfterShutdown);
      await runShutdownPhase('database', async () => { db.close(); });
    } else {
      await runShutdownPhase('startup_settlement', settleStartupAfterShutdown);
      await awaitProcessHardDeadlineAndForceExit();
    }
```

`runTransportShutdownPhase` exhaustively classifies the proof-carrying result,
retains a `closed_with_failure` as the first error when appropriate, and on an
unexpected rejection uses the monotonic close latch only to distinguish proven
closed from unproven. `close_unproven` is not a normal caught phase: main keeps
the stopping gate/callback attached, performs no DB close or further mutation,
and waits only for the single process hard deadline before forced exit. A later
process owns recovery. Test rejection/returned failure both before close and
after close; only the proven-after-close cases may detach and close SQLite.

`stoppingIngressGate` stays attached until transport closure is proven. It continues authenticated self-echo storage/correlation, atomically
admits then exact-defers ordinary arrivals as `shutdown_deadline`, and leaves
control frames unacknowledged; it starts no admin/runtime/provider work. Only
after transport is closed may main null the callback. Add arrivals during held
health, replay, runtime, and transport drains for echo/ordinary/control cases;
none may be dropped, executed early, or acknowledged without durable ownership.
`closeAndDrain()` first latches the gate closed, then awaits every already-started
echo/admission/deferral promise. Even if that phase rejects, `runShutdownPhase`
retains the failure and main still nulls the now-closed transport callback before
startup settlement/DB close. Assert the final postcondition
`stoppingIngressGate.accepting === false`, no active gate promise, callback null,
and no post-DB write/send for both success and rejection fixtures.

`settleStartupAfterShutdown()` observes the retained top-level startup promise
and suppresses only the exact internal startup-aborted sentinel; any unrelated
startup failure participates in first-error retention. Only after the awaited
transport is positively closed and startup settlement has completed may a
database phase start. A settled but unproven transport failure never satisfies
that precondition. Then rethrow/report the retained first error; a
later error never masks it, but every later phase is still attempted. A DB-close error
is retained only when no prior phase failed. Add fault tests where
`ingestHandler.idle()` rejects and where `runtime.shutdown()` rejects; in both,
the replay stop, later runtime/transport phase, and DB close still occur in order,
transport's promise settles before close, and the original first error remains
the reported outcome. Add a held AgentJob dispatch test: call stop while it is
in flight, prove stop remains pending, release it, observe its final
`trigger_runs` write, and only then allow runtime/DB teardown; no write may occur
after DB close. A fail-fast `try/finally` or timer-only poller stop mutation must
make the focused tests RED.

Propagate that retained outcome to the real process exit seam. Change
`shutdownExitCode` to accept whether any shutdown phase failed (or an equivalent
bounded shutdown result): clean operator `SIGINT`/`SIGTERM` remains exit 0, but
any retained phase/startup/DB/transport failure exits 1 regardless of signal;
non-operator causes remain 1. The final log carries only first failed phase and
bounded failure class, never the raw error. Extend `tests/main-shutdown-policy.test.ts`
through the actual `process.exit(shutdownExitCode(...))` source seam and a
behavioral shutdown harness: one phase rejects, every later phase still runs,
the first phase metadata wins, and the requested clean signal cannot mask the
nonzero result.

Route `SIGINT`, `SIGTERM`, startup failure, uncaught exception, and unhandled
rejection through one idempotent `requestShutdown(cause)`. The first cause owns
the single process-level 10-second hard deadline; remove the current separate
five-second uncaught/unhandled timers and do not arm another timer on later
causes. The hard timer remains armed through final bounded logger flush and is
cleared only immediately before the single orderly `process.exit`; if it fires,
it records the pending phase and exits once. The forced-exit process performs no
last-chance SQLite/deferral write after the deadline—only the next startup runs
claim-guarded recovery. Fake-clock tests prove no exit at five seconds, exactly
one exit at the shared ceiling, first-cause/first-phase precedence, a later cause
cannot extend the deadline, and logger flush cannot create a no-ceiling hang.

Apply the same in-flight rule to the two asynchronous DB-owning retention timers:
`MediaRetentionTimer.stop()` and `DatabaseRetentionTimer.stop()` clear/latch new
runs and await their tracked immediate/periodic cleanup promise. The synchronous
process-temp and main metrics/retention/LID callbacks only need their handles
cleared because JavaScript cannot interleave shutdown inside those synchronous
calls. Add held cleanup tests proving media/database retention settles before DB
close; the producer inventory test must enumerate every main-owned timer and
classify it as synchronous-cancelled or asynchronous-drained.

Include `MemoryConsolidationScheduler` in that producer inventory. Remove the
current `stop(timeoutMs)` behavior that logs and resolves while `activeRun` can
still use the provider/Pinecone. Its `stop(): Promise<void>` latches future runs
off, clears the interval, and awaits the exact active run without an internal
false-drain timeout. The existing process-level shutdown deadline remains the
only hard ceiling; if it forces process exit, log/report that phase as pending
rather than claiming it drained. Add a held provider/search-upsert test proving
stop and DB-close eligibility remain pending, no second run starts, and release
allows orderly completion. Replace the existing tests that expect timeout-based
success; a never-settling fake may be used only to prove the promise remains
pending until the external hard-ceiling harness intervenes.

Make `EnrichmentPoller.stop(): Promise<void>` latch new cycles off, clear the
timer, and await its tracked `tick()/runCycle()` across provider awaits and final
SQLite writes. `ChatRuntime.shutdown()` awaits that stop after closing/draining
its chat queue. Add a held provider-cycle test proving runtime shutdown remains
pending through the final enrichment write and no cycle starts or writes after
shutdown resolves.

Give the existing `ReplyGuaranteeManager` the same pre-close ownership rule.
Add idempotent `quiesce(): void`, a stopped latch, and a set of fully observed
timeout-handler promises. `quiesce()` synchronously latches new arms/callbacks
off and clears every not-yet-fired timer without awaiting; a
timer callback checks the latch before starting and adds its handler to the set
synchronously before the first await. `shutdown(): Promise<void>` latches new
arms/callbacks off by calling `quiesce()`, then awaits the set. It must not
close the DB underneath an in-flight fallback. Task 7 retains this contract when
it splits the timer into soft/hard stages. Add a held fallback test proving the
manager and AgentRuntime shutdown promises remain pending until the sender
settles, queued timer callbacks after the latch are no-ops, and no durability or
transport call occurs after shutdown resolves.

Make Agent session replacement and auto-respawn part of the same owned runtime
lifecycle. Replace map-delete-first `/new` handling with a generation-owned
session slot. Build the replacement queue/manager off-map, retain the old slot
while `old.handleNew()` and replacement preparation settle, and atomically swap
the slot only when both succeed, the command's runtime generation is still
current, and shutdown has not quiesced admission. On failure, dispose the
detached replacement, retain the old manager as the bounded failed owner for
shutdown/health, and do not expose a half-created queue. A stale `/new`
continuation can dispose only its detached generation and cannot delete the
newer slot.

Likewise, a scheduled crash auto-respawn is owned by a dedicated runtime
respawn registry `{slotGeneration,timer,inFlight}` rather than merely by the
manager's continued presence in `chatSessions`. Crash-notification/turn cleanup
may clear turn-local state but cannot remove or cancel that registry entry.
When the timer fires, its promise is registered before the first await; success
installs/updates only the matching slot generation, failure remains observed,
and shutdown quiesce cancels timers that have not fired then awaits every
already-fired spawn/continuation before disposing session managers. Add held
`/new`, replacement failure, stale two-`/new`, crash-notice-plus-scheduled-
respawn, respawn failure, and shutdown-during-respawn tests. Each proves one
manager owner at all times, no post-shutdown install, and no cancellation of
auto-respawn merely because notification cleanup ran.

At the start of `AgentRuntime.quiesce()`, before any await, latch all runtime
producers and queue admission:

```ts
  quiesce(): void {
    this.turnQueue.close();
    this.replyGuarantee?.quiesce();
    this.imageCoalescer.quiesce();
    this.readyProducerRegistry.quiesce();
    this.acceptingRuntimeWork = false;
  }
```

`AgentRuntime.shutdown()` calls `quiesce()` idempotently, then uses its own
continue-all phase runner to await ready producers, ImageCoalescer active work,
TurnQueue task/error owners, Reply Guarantee handlers, MCP/media/control sockets,
sessions, and remaining resources before rethrowing the first failure. Chat uses
the same pattern: enrichment is latched before queue drain, then both are awaited
even if either fails. Fake clocks advance while queue idle is held and prove no
watchdog/enrichment/probe/session callback can start during the wait.

The shared process-level 10-second deadline remains the sole hard ceiling. If it
fires, unresolved owners stay durably open; the next process's
`preConnectRecovery()` converts eligible exact leased inbound to `deferred`.
Do not claim that the forced-exit process writes after its deadline, and do not
add a second process-exit path.

- [ ] **Step 5: Run shutdown, transport, runtime, and main wiring tests**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-shutdown-lifecycle.test.ts tests/core/ingest.test.ts tests/core/inbound-replay.test.ts tests/core/durability.test.ts tests/core/reply-guarantee.test.ts tests/core/substrate/poller.test.ts tests/core/scheduler.test.ts tests/core/media-retention.test.ts tests/core/database-retention.test.ts tests/memory/consolidation-scheduler.test.ts tests/core/post-connect-recovery.test.ts tests/core/heal.test.ts tests/core/health.test.ts tests/core/heal-endpoint.test.ts tests/core/health-mark-read.test.ts tests/core/health-schedule.test.ts tests/lib/model-advisor.test.ts tests/integration/contracts.test.ts tests/transport/twilio/connection-bridge.test.ts tests/transport/connection-connect-failure.test.ts tests/transport/connection-branches.test.ts tests/transport/reconnect.test.ts tests/runtimes/passive/runtime.test.ts tests/runtimes/chat/enrichment/poller.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/image-coalescer.test.ts tests/runtimes/agent/session.test.ts tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/handoff-distill-coordinator.test.ts tests/runtimes/agent/idle-session-eviction.test.ts tests/runtimes/agent/zombie-sessions.test.ts tests/main-bootstrap.test.ts tests/main-bootstrap-helpers.test.ts tests/main-shutdown-policy.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
```

Expected: PASS. Held startup/readiness, ingest/capacity, request, AgentJob, scheduled-send, outbound-drain, retention, and Reply-Guarantee probes must prove no producer or authenticated mutation runs early and every stop remains pending until its owning promise and final SQLite/transport action settle. The full observed order is stopping latch/router mode switch → health drain → ingress close → replay/poller/scheduler/retention/background drain → ingest idle → runtime/watchdog → transport → callback detach → startup settlement → DB, with no shutdown row dropped/redispatched and no callback, send, or write after close. A test that only checks methods or source strings is insufficient. Recompute the manifest SHA for `src/main.ts` and every other listed runtime entrypoint before running the drift guard.

- [ ] **Step 6: Commit shutdown durability**

```bash
git add src/runtimes/types.ts src/runtimes/passive/runtime.ts src/transport/runtime-connection.ts src/transport/connection.ts src/transport/twilio/connection-bridge.ts src/core/post-connect-recovery.ts src/core/ingest.ts src/core/durability.ts src/core/heal.ts src/lib/model-advisor.ts src/core/reply-guarantee.ts src/core/substrate/poller.ts src/core/scheduler.ts src/core/media-retention.ts src/core/database-retention.ts src/memory/consolidation-scheduler.ts src/core/health.ts src/runtimes/chat/enrichment/poller.ts src/runtimes/chat/runtime.ts src/main.ts src/main-shutdown-policy.ts src/runtimes/agent/runtime.ts src/runtimes/agent/image-coalescer.ts src/runtimes/agent/session.ts src/runtimes/agent/handoff-distill-coordinator.ts deploy/source-runtime-manifest.json tests/core/inbound-shutdown-lifecycle.test.ts tests/core/ingest.test.ts tests/core/inbound-replay.test.ts tests/core/durability.test.ts tests/core/reply-guarantee.test.ts tests/core/substrate/poller.test.ts tests/core/scheduler.test.ts tests/core/media-retention.test.ts tests/core/database-retention.test.ts tests/memory/consolidation-scheduler.test.ts tests/core/post-connect-recovery.test.ts tests/core/heal.test.ts tests/core/health.test.ts tests/core/heal-endpoint.test.ts tests/core/health-mark-read.test.ts tests/core/health-schedule.test.ts tests/lib/model-advisor.test.ts tests/integration/contracts.test.ts tests/transport/twilio/connection-bridge.test.ts tests/transport/connection-connect-failure.test.ts tests/transport/connection-branches.test.ts tests/transport/reconnect.test.ts tests/runtimes/passive/runtime.test.ts tests/runtimes/chat/enrichment/poller.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/image-coalescer.test.ts tests/runtimes/agent/session.test.ts tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/handoff-distill-coordinator.test.ts tests/runtimes/agent/idle-session-eviction.test.ts tests/runtimes/agent/zombie-sessions.test.ts tests/main-bootstrap.test.ts tests/main-bootstrap-helpers.test.ts tests/main-shutdown-policy.test.ts docs/durability.md docs/runbook.md docs/public-surface.md
git commit -m "fix(runtime): drain inbound work before transport shutdown"
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
```

Run the source-runtime guard only on the committed Task 6 head. A correction
requires updated hashes, amend, and the full Task 6 matrix plus docs/public
guards again; its dirty/staged rejection is `Inconclusive`, never semantic RED
or a passing release result.

### Task 7: Implement the two-stage Reply Guarantee watchdog (WS-A01, commit 1)

**Files:**
- Modify: `src/core/types.ts` only if the canonical readonly claim export needs a shared health reference; never redeclare it
- Modify: `src/core/durability.ts`
- Modify: `src/core/health.ts`
- Modify: `src/core/inbound-failure-class.ts`
- Modify: `src/core/reply-guarantee.ts:7-220`
- Modify: `src/core/ingest.ts` for the bounded `reply_guarantee_blocked` deferral reason
- Modify: `src/main.ts` to route a manager blocker through the Task 6 lifecycle gate
- Modify: `src/runtimes/agent/runtime.ts` to await Reply Guarantee shutdown and
  compile against the two-sender contract with a fail-closed interim hard sender
- Modify: `tests/core/durability.test.ts`
- Modify: `tests/core/health.test.ts`
- Modify: `tests/core/inbound-failure-class.test.ts`
- Modify: `tests/core/reply-guarantee.test.ts:1-408`
- Modify: `tests/runtimes/agent/runtime.test.ts`
- Modify: `tests/core/ingest.test.ts`
- Modify: `tests/main-bootstrap.test.ts` and `tests/main-bootstrap-helpers.test.ts`
- Modify: `scripts/requeue-inbound.ts` and `tests/scripts/requeue-inbound.test.ts` for explicit failed-watchdog resolution
- Modify: `deploy/source-runtime-manifest.json` for any changed hashed entrypoint
- Modify: `docs/reply-guarantee.md`, `docs/durability.md`, `docs/runbook.md`, and `docs/public-surface.md`

**Interfaces:**
- Consumes: Task 6's `quiesce()`/awaited `shutdown()` ownership contract, Task 5's canonical `AdmittedTurnAuthority` and all-status terminal-owner checks, and exact claim classification.
- Produces: authority-bearing `ReplyGuaranteeSoftSender` / `ReplyGuaranteeTerminalSender`, a discriminated `ReplyGuaranteeTerminalResult` for echoed/closed/submitted/ambiguous/existing/stale/no-send ownership, independent soft and absolute-hard deadlines per exact authority plus private timer generation, exact-authority `notifyActivity`/`disarm`/`isArmed`, bounded journal/transition/handler/guard retry budgets, persistent bounded manager health, `createReplyGuaranteeSoftSender({ messenger })`, and `DurabilityEngine.failReplyGuaranteeExhaustedOrThrow(claim)`. Transport submission, pre-existing unclassified terminal ownership, or durable ambiguity is observable but not terminal proof; only exact echo is delivery proof. At this commit boundary AgentRuntime uses the real soft sender and an explicit fail-closed hard sender; Task 8 replaces only that hard sender with durable outbound ownership.

- [ ] **Step 1: Replace unsafe typing-terminal tests with the two-stage contract**

First, before changing the production API or deleting the old tests, append one
old-API characterization named `typing presence is not terminal delivery`: use
the current `timeoutMs`/`sendFallback` surface, make the fallback perform only
`setTyping`, advance the real current timer, and assert `completeTurn` was not
called. Run only that test in Step 2 and retain its output: it must fail at the
terminal-completion assertion after actually reaching the callback. A type,
fixture, timeout, or module failure is not RED. After that semantic RED is
captured, replace the first two manager tests and the old
`createReplyGuaranteeLivenessSender` describe with the following contract tests
and add the minimal compiling type/constructor scaffold at the start of Step 3;
the scaffold must not implement timers, send, or completion behavior:

```ts
const claim = (seq: number, attemptCount = 1): InboundProcessingClaim =>
  Object.freeze({ seq, status: 'processing', route: 'agent', attemptCount });
const turnAuthority = (seq: number, attemptCount = 1): AdmittedTurnAuthority =>
  Object.freeze({
    claim: claim(seq, attemptCount),
    generation: Symbol(`turn-${seq}`),
    turnCompletionId: Symbol(`completion-${seq}`),
  });
const resolveTargetForClaim = (value: InboundProcessingClaim) => Object.freeze({
  conversationKey: `conversation-${value.seq}`,
  chatJid: `1555010${String(value.seq).padStart(4, '0')}@s.whatsapp.net`,
});

it('soft deadline sends presence but keeps the inbound armed and incomplete', async () => {
  const durability = makeDurability('processing');
  const sendSoftLiveness = vi.fn(async () => 'sent' as const);
  const sendTerminalNotice = vi.fn(async () => ({
    proof: 'awaiting_echo' as const,
    reason: 'submitted' as const,
    outboundOpId: 700,
  }));
  const manager = new ReplyGuaranteeManager({
    durability,
    resolveTargetForClaim,
    onBlocked: vi.fn(),
    sendSoftLiveness,
    sendTerminalNotice,
    softTimeoutMs: 100,
    hardTimeoutMs: 200,
    rateLimitMs: 1_000,
  });

  const authority = turnAuthority(7);
  manager.arm({ authority });
  await vi.advanceTimersByTimeAsync(100);

  expect(sendSoftLiveness).toHaveBeenCalledOnce();
  expect(sendTerminalNotice).not.toHaveBeenCalled();
  expect(durability.completeTurn).not.toHaveBeenCalled();
  expect(manager.isArmed(authority)).toBe(true);
});

it('hard deadline sends a tracked notice and waits for echo proof', async () => {
  const durability = makeDurability('processing');
  const sendTerminalNotice = vi.fn(async () => ({
    proof: 'awaiting_echo' as const,
    reason: 'submitted' as const,
    outboundOpId: 800,
  }));
  const manager = new ReplyGuaranteeManager({
    durability,
    resolveTargetForClaim,
    onBlocked: vi.fn(),
    sendSoftLiveness: vi.fn(async () => 'sent' as const),
    sendTerminalNotice,
    softTimeoutMs: 100,
    hardTimeoutMs: 200,
    rateLimitMs: 1_000,
  });

  const authority = turnAuthority(8);
  manager.arm({ authority });
  await vi.advanceTimersByTimeAsync(300);

  expect(sendTerminalNotice).toHaveBeenCalledWith({
    authority,
    transportTarget: resolveTargetForClaim(authority.claim),
    text: DEFAULT_REPLY_GUARANTEE_TEXT,
  });
  expect(durability.completeTurn).not.toHaveBeenCalled();
  expect(manager.isArmed(authority)).toBe(false);
});

it('keeps a non-echoing transport submission open for reconciliation', async () => {
  const durability = makeDurability('processing');
  const manager = new ReplyGuaranteeManager({
    durability,
    resolveTargetForClaim,
    onBlocked: vi.fn(),
    sendSoftLiveness: vi.fn(async () => 'sent' as const),
    sendTerminalNotice: vi.fn(async () => ({
      proof: 'awaiting_echo' as const,
      reason: 'submitted' as const,
      outboundOpId: 900,
    })),
    softTimeoutMs: 100,
    hardTimeoutMs: 200,
  });
  manager.arm({ authority: turnAuthority(9) });
  await vi.advanceTimersByTimeAsync(300);
  expect(durability.completeTurn).not.toHaveBeenCalled();
});

it('retries the same inbound when terminal journaling fails before transport', async () => {
  const durability = makeDurability('processing');
  const sendTerminalNotice = vi.fn()
    .mockRejectedValueOnce(new Error('synthetic outbound journal failure'))
    .mockResolvedValueOnce({
      proof: 'awaiting_echo' as const,
      reason: 'submitted' as const,
      outboundOpId: 1_000,
    });
  const manager = new ReplyGuaranteeManager({
    durability,
    resolveTargetForClaim,
    onBlocked: vi.fn(),
    sendSoftLiveness: vi.fn(async () => 'sent' as const),
    sendTerminalNotice,
    softTimeoutMs: 100,
    hardTimeoutMs: 200,
    hardJournalRetryMs: 50,
    rateLimitMs: 10_000,
  });
  const authority = turnAuthority(10);
  manager.arm({ authority });
  await vi.advanceTimersByTimeAsync(300);
  expect(durability.completeTurn).not.toHaveBeenCalled();
  expect(manager.isArmed(authority)).toBe(true);
  await vi.advanceTimersByTimeAsync(50);
  expect(sendTerminalNotice).toHaveBeenCalledTimes(2);
  expect(sendTerminalNotice.mock.calls.map(([input]) => input.authority)).toEqual([
    authority, authority,
  ]);
  expect(manager.isArmed(authority)).toBe(false);
});

it('delays a rate-limited hard notice without dropping the same inbound', async () => {
  const durability = makeDurability('processing');
  const sendTerminalNotice = vi.fn(async () => ({
    proof: 'awaiting_echo' as const,
    reason: 'submitted' as const,
    outboundOpId: 1_100,
  }));
  const manager = new ReplyGuaranteeManager({
    durability,
    resolveTargetForClaim,
    onBlocked: vi.fn(),
    sendSoftLiveness: vi.fn(async () => 'sent' as const),
    sendTerminalNotice,
    softTimeoutMs: 100,
    hardTimeoutMs: 200,
    rateLimitMs: 1_000,
  });
  const firstAuthority = turnAuthority(11);
  const secondAuthority = turnAuthority(12);
  manager.arm({ authority: firstAuthority });
  await vi.advanceTimersByTimeAsync(300);
  manager.arm({ authority: secondAuthority });
  await vi.advanceTimersByTimeAsync(300);
  expect(manager.isArmed(secondAuthority)).toBe(true);
  expect(sendTerminalNotice).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(700);
  expect(sendTerminalNotice).toHaveBeenCalledTimes(2);
  expect(sendTerminalNotice.mock.calls[1]![0].authority).toBe(secondAuthority);
});
```

Retain and adapt the existing duplicate timer, disarm, activity reset,
closed-status, rate-limit, finalize-failure, and shutdown tests. Every
constructor must now pass the exact-claim target resolver plus both senders and
use `softTimeoutMs`/`hardTimeoutMs`; do not delete those behavioral cases.
Add one fake-clock exhaustion test with `maxHardJournalAttempts: 3`: the same
exact `{claim,generation,turnCompletionId}` authority reaches the terminal sender exactly three times, no
transport call occurs, the manager changes to `failure_transition`, the exact
claim-guarded failure CAS succeeds before that generation is retired, and one
bounded `reply_guarantee_failed` event plus alert is emitted. Fault-inject the CAS
twice and prove the exact generation remains in `failure_transition` with no
fourth terminal send; make it fail permanently and prove the independent
transition budget latches unhealthy with no timer. Add races where an echoed,
submitted, or maybe-sent terminal operation appears after a journal failure but
before retry/exhaustion: no state is overwritten or resent, and only the exact
generation retires. Hold soft across exact-claim activity and attempt-N→N+1;
the stale callback cannot emit or move the absolute hard deadline. Hold terminal
send across activity and prove its result retires only its original generation.
Hold a same-chat terminal attempt beyond `rateLimitMs`; a second exact claim is
suppressed/retried until the owning token resolves. Failure releases the token;
success records one validated `readNowOrThrow()` sample after await and enforces a fresh full rate window.
`inbound_closed` and `ownership_lost` release the token, do not update rate state,
and touch only their exact authority. Add no-durability and unsupported-typing
cases, plus permanent generic status/evidence faults proving no unbounded catch
rearm.

Inject `not_sent/echo_guard_suppressed` directly into manager tests before Task
8 wires the real group guard. Below the independent cap it schedules the exact
generation after the validated `retryAfterMs`, increments only guard-suppression
state/event/counter, and changes no journal attempt, failure-transition, transport,
or rate-limit timestamp. At the cap it clears all timers, invokes `onBlocked`
once, and never rearms. A stale N result after N+1 owns the sequence changes no
counter/timer; a false/throwing supervisor cannot reopen the manager. These tests
make the Task 7 half of the Task 8 guard contract executable before integration.

- [ ] **Step 2: Run the Reply Guarantee suite and confirm typing currently finalizes**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/reply-guarantee.test.ts --pool=forks -t "typing presence is not terminal delivery"
```

Expected: FAIL only because the current manager calls `completeTurn` after the
typing-only sender. Once that receipt is saved, replace the tests and create the
new compile scaffold; do not count the new surface's initially missing members
as semantic RED.

- [ ] **Step 3: Implement two timers and explicit proof handling**

Import `classifyErrorForInbound` from `./inbound-failure-class.ts`, plus the existing bounded `emitAlertChecked` and config surfaces; timeout handlers log only bounded class, stage, attempt count, and inbound sequence.

Replace the option and armed-turn types in `src/core/reply-guarantee.ts` with:

```ts
export const DEFAULT_REPLY_GUARANTEE_SOFT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_REPLY_GUARANTEE_HARD_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS = DEFAULT_REPLY_GUARANTEE_SOFT_TIMEOUT_MS;

export interface ReplyGuaranteeFallbackInput {
  readonly authority: AdmittedTurnAuthority;
  // Manager-resolved from authority.claim; never caller supplied.
  readonly transportTarget: Readonly<{ conversationKey: string; chatJid: string }>;
  readonly text: string;
}

export type ReplyGuaranteeSoftSender = (
  input: ReplyGuaranteeFallbackInput,
) => Promise<'sent' | 'unsupported'>;

export type ReplyGuaranteeTerminalResult =
  | { proof: 'echoed'; reason: 'echoed'; outboundOpId: number }
  | { proof: 'inbound_closed'; reason: 'inbound_closed' }
  | { proof: 'ownership_lost'; reason: 'stale_claim' }
  | { proof: 'awaiting_echo'; reason: 'submitted'; outboundOpId: number }
  | {
      proof: 'not_sent';
      reason: 'echo_guard_suppressed';
      retryAfterMs: number;
    }
  | {
      proof: 'awaiting_reconciliation';
      reason: 'ambiguous' | 'existing_terminal';
      outboundOpId: number;
    };

export type ReplyGuaranteeTerminalSender = (
  input: ReplyGuaranteeFallbackInput,
) => Promise<ReplyGuaranteeTerminalResult>;

export interface ReplyGuaranteeManagerOptions {
  durability: ReplyGuaranteeDurability | undefined;
  resolveTargetForClaim: (claim: InboundProcessingClaim) => Readonly<{
    conversationKey: string;
    chatJid: string;
  }>;
  sendSoftLiveness: ReplyGuaranteeSoftSender;
  sendTerminalNotice: ReplyGuaranteeTerminalSender;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  hardJournalRetryMs?: number;
  maxHardJournalAttempts?: number;
  maxFailureTransitionAttempts?: number;
  maxTimerHandlerFailures?: number;
  maxGuardSuppressionAttempts?: number;
  rateLimitMs?: number;
  maxRateLimitChats?: number;
  fallbackText?: string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
  onBlocked: (snapshot: ReplyGuaranteeBlockedSnapshot) => void;
}

interface ArmedTurn {
  readonly authority: AdmittedTurnAuthority;
  readonly claim: InboundProcessingClaim;
  readonly generation: symbol;
  readonly turnCompletionId: symbol;
  readonly timerGeneration: symbol;
  readonly transportTarget: Readonly<{ conversationKey: string; chatJid: string }>;
  readonly chatJid: string;
  readonly hardDeadlineAt: number;
  stage: 'armed' | 'hard_retry' | 'failure_transition' | 'blocked';
  hardJournalAttempts: number;
  failureTransitionAttempts: number;
  timerHandlerFailures: number;
  guardSuppressionAttempts: number;
  softTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export type ReplyGuaranteeClaimDisposition =
  | 'open'
  | 'delivery_pending'
  | 'already_terminal'
  | 'stale_claim';

export interface ReplyGuaranteeBlockedSnapshot {
  readonly blocked: true;
  readonly stage: 'hard_handler' | 'failure_transition' | 'echo_guard';
  readonly failureClass: InboundFailureClass;
  readonly ownership: InboundProcessingClaim;
  readonly attemptCount: number;
}

export interface ReplyGuaranteeStats {
  softSent: number;
  softUnsupported: number;
  softFailed: number;
  hardSubmitted: number;
  hardEchoed: number;
  closedBeforeSend: number;
  awaitingReconciliation: number;
  journalRetries: number;
  journalExhausted: number;
  rateLimited: number;
  guardSuppressed: number;
  inFlightSuppressed: number;
  hardInFlight: number;
  timerFailures: number;
  failed: number;
  ownershipLost: number;
  alertFailures: number;
  blocked: boolean;
}
```

`resolveTargetForClaim` is wired to a durability read that requires the exact
persisted sequence/route/attempt and returns that row's canonical conversation
key/JID. A stale/missing/malformed row rejects before arming. Callers never pass
a chat target to `arm`; the manager stores only this resolved target and supplies
it to both senders. Add wrong-chat cast and N→N+1 resolution races proving no
typing, terminal queue lookup, journal row, rate token, or transport can use a
caller-cached JID.

Add bounded `ReplyGuaranteeEchoGuardBlocked` in
`src/core/inbound-failure-class.ts`; its fixed message/classification contains no
chat or claim data. `classifyErrorForInbound` recognizes only the exact class,
not a lookalike message. It is used when guard suppression reaches its separate
cap and is covered by classification/redaction tests.

Extend `ReplyGuaranteeDurability` with
`classifyReplyGuaranteeClaim(claim): ReplyGuaranteeClaimDisposition` and
`failReplyGuaranteeExhaustedOrThrow(claim): 'failed' | 'already_terminal' |
'delivery_pending' | 'stale_claim'`. The classifier reads one ownership row,
compares route and attempt first, returns `stale_claim` on mismatch,
`already_terminal` for complete/failed, `delivery_pending` for any all-status
terminal outbound owner, and `open` only for the same route/attempt in
`processing` or `turn_done`; missing/unknown state is an invariant. This avoids
misclassifying the allowed same-claim `turn_done` continuation through Task 3's
stricter status-equality helper.

Implement failure as one guarded CAS from matching route/attempt
`processing`/`turn_done` to `failed/db_error` with route
`reply_guarantee_failed`, only when no terminal outbound operation exists in any
status. On zero changes delegate to that classifier: return each non-open losing
outcome and throw if it still says `open`. It must
never call the existing unconditional `markInboundFailed` method.
The terminal sender contract is strict: a known existing terminal row returns
`existing_terminal`; it throws only when the guarded journal claim failed before
either new or existing ownership was established. A transport exception after
journaling returns `awaiting_reconciliation`, transferring ownership to the
durable outbound row.

Replace the manager's timeout fields and timer functions with:

```ts
  private readonly durability: ReplyGuaranteeDurability | undefined;
  private readonly resolveTargetForClaim: ReplyGuaranteeManagerOptions['resolveTargetForClaim'];
  private readonly sendSoftLiveness: ReplyGuaranteeSoftSender;
  private readonly sendTerminalNotice: ReplyGuaranteeTerminalSender;
  private readonly softTimeoutMs: number;
  private readonly hardTimeoutMs: number;
  private readonly hardJournalRetryMs: number;
  private readonly maxHardJournalAttempts: number;
  private readonly maxFailureTransitionAttempts: number;
  private readonly maxTimerHandlerFailures: number;
  private readonly maxGuardSuppressionAttempts: number;
  private readonly rateLimitMs: number;
  private readonly maxRateLimitChats: number;
  private readonly fallbackText: string;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly now: () => number;
  private readonly onBlocked: (snapshot: ReplyGuaranteeBlockedSnapshot) => void;
  private readonly armed = new Map<number, ArmedTurn>();
  private readonly lastFallbackByChat = new Map<string, number>();
  private readonly stats: ReplyGuaranteeStats = {
    softSent: 0,
    softUnsupported: 0,
    softFailed: 0,
    hardSubmitted: 0,
    hardEchoed: 0,
    closedBeforeSend: 0,
    awaitingReconciliation: 0,
    journalRetries: 0,
    journalExhausted: 0,
    rateLimited: 0,
    guardSuppressed: 0,
    inFlightSuppressed: 0,
    hardInFlight: 0,
    timerFailures: 0,
    failed: 0,
    ownershipLost: 0,
    alertFailures: 0,
    blocked: false,
  };

  getStats(): Readonly<ReplyGuaranteeStats> {
    return { ...this.stats, hardInFlight: this.hardAttemptByChat.size };
  }

  private readonly hardAttemptByChat = new Map<string, Readonly<{
    token: symbol;
    authority: AdmittedTurnAuthority;
    claim: InboundProcessingClaim;
    timerGeneration: symbol;
  }>>();
  private blockedSnapshot: ReplyGuaranteeBlockedSnapshot | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private lastObservedNow: number | null = null;
  private stopped = false;

  getHealth(): ReplyGuaranteeBlockedSnapshot | null {
    return this.blockedSnapshot ? {
      ...this.blockedSnapshot,
      ownership: { ...this.blockedSnapshot.ownership },
    } : null;
  }

  private releaseChatAttempt(active: ArmedTurn, token: symbol): void {
    const owner = this.hardAttemptByChat.get(active.chatJid);
    if (owner?.token !== token
        || owner.authority !== active.authority
        || owner.timerGeneration !== active.timerGeneration
        || !this.claimsEqual(owner.claim, active.claim)) return;
    this.hardAttemptByChat.delete(active.chatJid);
  }

  private pruneRateLimitState(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('invalid reply guarantee rate time');
    }
    for (const [chatKey, recordedAt] of this.lastFallbackByChat) {
      const age = now - recordedAt;
      if (!Number.isSafeInteger(recordedAt) || recordedAt < 0 || age < 0) {
        throw new RangeError('invalid reply guarantee rate history');
      }
      if (age >= this.rateLimitMs) this.lastFallbackByChat.delete(chatKey);
    }
    const oldest = [...this.lastFallbackByChat.entries()]
      .sort(([leftKey, leftAt], [rightKey, rightAt]) =>
        leftAt - rightAt || leftKey.localeCompare(rightKey));
    while (oldest.length > this.maxRateLimitChats) {
      const [chatKey] = oldest.shift()!;
      this.lastFallbackByChat.delete(chatKey);
    }
  }

  private recordRateLimitSuccess(chatKey: string, now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('invalid reply guarantee rate time');
    }
    this.pruneRateLimitState(now);
    this.lastFallbackByChat.delete(chatKey);
    while (this.lastFallbackByChat.size >= this.maxRateLimitChats) {
      const [oldestKey] = [...this.lastFallbackByChat.entries()]
        .sort(([leftKey, leftAt], [rightKey, rightAt]) =>
          leftAt - rightAt || leftKey.localeCompare(rightKey))[0]!;
      this.lastFallbackByChat.delete(oldestKey);
    }
    this.lastFallbackByChat.set(chatKey, now);
  }

  private schedule(
    active: ArmedTurn,
    kind: 'soft' | 'hard' | 'failure_transition',
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    this.requireTimerDelay(delayMs);
    let timer: ReturnType<typeof setTimeout>;
    timer = this.setTimer(() => {
      if (this.stopped) return;
      const current = this.currentArmed(active.claim, active.timerGeneration);
      if (!current || current.stage === 'blocked') return;
      const task = kind === 'soft'
        ? this.onSoftTimeout(current, timer)
        : kind === 'hard'
          ? this.onHardTimeout(current, timer)
          : this.onFailureTransition(current, timer);
      let observed!: Promise<void>;
      observed = task.catch((error) => {
          const stillCurrent = this.currentArmed(active.claim, active.timerGeneration);
          if (!stillCurrent || stillCurrent.stage === 'blocked') return;
          // Soft-handler faults never delay the independently armed hard deadline.
          if (kind === 'soft') {
            this.stats.timerFailures += 1;
            log.error({
              event: 'reply_guarantee_timer_failed',
              inboundSeq: active.claim.seq,
              stage: kind,
              failureClass: classifyErrorForInbound(error),
            });
            return;
          }
          const nextHandlerFailures = stillCurrent.timerHandlerFailures + 1;
          if (nextHandlerFailures >= this.maxTimerHandlerFailures) {
            this.stats.timerFailures += 1;
            stillCurrent.timerHandlerFailures = nextHandlerFailures;
            this.latchBlocked(
              stillCurrent,
              kind === 'failure_transition' ? 'failure_transition' : 'hard_handler',
              error,
            );
            return;
          }
          let retryTimer: ReturnType<typeof setTimeout>;
          try {
            retryTimer = this.schedule(
              stillCurrent, kind, this.hardJournalRetryMs,
            );
          } catch (scheduleError) {
            this.latchBlocked(
              stillCurrent,
              kind === 'failure_transition' ? 'failure_transition' : 'hard_handler',
              scheduleError,
            );
            return;
          }
          this.stats.timerFailures += 1;
          stillCurrent.timerHandlerFailures = nextHandlerFailures;
          stillCurrent.retryTimer = retryTimer;
          log.error(
            {
              event: 'reply_guarantee_timer_failed',
              inboundSeq: active.claim.seq,
              stage: kind,
              attemptCount: stillCurrent.timerHandlerFailures,
              failureClass: classifyErrorForInbound(error),
            },
            'reply guarantee timer handler failed; ownership retained',
          );
        }).finally(() => this.inFlight.delete(observed));
      this.inFlight.add(observed);
    }, delayMs);
    timer.unref?.();
    return timer;
  }

  private scheduleRetryOrBlock(
    active: ArmedTurn,
    kind: 'hard' | 'failure_transition',
    delayMs: number,
    blockedStage: ReplyGuaranteeBlockedSnapshot['stage'],
  ): ReturnType<typeof setTimeout> | null {
    try {
      return this.schedule(active, kind, delayMs);
    } catch (error) {
      this.latchBlocked(active, blockedStage, error);
      return null;
    }
  }

  private latchBlocked(
    active: ArmedTurn,
    stage: ReplyGuaranteeBlockedSnapshot['stage'],
    error: unknown,
  ): void {
    for (const armed of this.armed.values()) {
      this.clearArmedTimers(armed);
      armed.stage = 'blocked';
    }
    this.armed.clear();
    if (this.blockedSnapshot) return;
    this.blockedSnapshot = Object.freeze({
      blocked: true,
      stage,
      failureClass: classifyErrorForInbound(error),
      ownership: Object.freeze({ ...active.claim }),
      attemptCount: stage === 'failure_transition'
        ? active.failureTransitionAttempts
        : stage === 'echo_guard'
          ? active.guardSuppressionAttempts
          : active.timerHandlerFailures,
    });
    this.stats.blocked = true;
    try {
      this.onBlocked(this.getHealth()!);
    } catch (callbackError) {
      log.error({
        event: 'reply_guarantee_supervisor_failed',
        failureClass: classifyErrorForInbound(callbackError),
      });
    }
    try {
      const delivered = emitAlertChecked(
        config.botName,
        'reply_guarantee_failed',
        `whatsoup@${config.botName} reply guarantee blocked`,
        `stage=${stage} failure_class=${this.blockedSnapshot.failureClass}`,
      );
      if (!delivered) {
        this.stats.alertFailures += 1;
        log.error({
          event: 'reply_guarantee_alert_failed',
          failureClass: 'alert_delivery_failed',
        });
      }
    } catch (alertError) {
      this.stats.alertFailures += 1;
      log.error({
        event: 'reply_guarantee_alert_failed',
        failureClass: classifyErrorForInbound(alertError),
      });
    }
  }
```

Initialize those fields in the constructor:

```ts
    const maxTimerDelayMs = 2_147_483_647;
    this.durability = opts.durability;
    this.resolveTargetForClaim = opts.resolveTargetForClaim;
    this.sendSoftLiveness = opts.sendSoftLiveness;
    this.sendTerminalNotice = opts.sendTerminalNotice;
    this.fallbackText = opts.fallbackText ?? DEFAULT_REPLY_GUARANTEE_TEXT;
    this.setTimer = opts.setTimer ?? setTimeout;
    this.clearTimer = opts.clearTimer ?? clearTimeout;
    this.now = opts.now ?? Date.now;
    this.onBlocked = opts.onBlocked;
    this.softTimeoutMs = normalizeTimerDelayMs(
      opts.softTimeoutMs,
      DEFAULT_REPLY_GUARANTEE_SOFT_TIMEOUT_MS,
    );
    this.hardTimeoutMs = normalizeTimerDelayMs(
      opts.hardTimeoutMs,
      DEFAULT_REPLY_GUARANTEE_HARD_TIMEOUT_MS,
    );
    if (this.softTimeoutMs + this.hardTimeoutMs > maxTimerDelayMs) {
      throw new RangeError('reply guarantee absolute deadline exceeds timer limit');
    }
    this.hardJournalRetryMs = normalizeTimerDelayMs(opts.hardJournalRetryMs, 30_000);
    this.rateLimitMs = normalizeTimerDelayMs(opts.rateLimitMs, 60_000);
    this.maxHardJournalAttempts = normalizeAttemptBudget(opts.maxHardJournalAttempts, 3);
    this.maxFailureTransitionAttempts = normalizeAttemptBudget(
      opts.maxFailureTransitionAttempts, 3,
    );
    this.maxTimerHandlerFailures = normalizeAttemptBudget(
      opts.maxTimerHandlerFailures, 3,
    );
    this.maxGuardSuppressionAttempts = normalizeAttemptBudget(
      opts.maxGuardSuppressionAttempts, 3,
    );
    this.maxRateLimitChats = normalizeBoundedSize(opts.maxRateLimitChats, 1_000);
```

`normalizeAttemptBudget(undefined, fallback)` returns the fallback; otherwise it
requires a finite safe integer, clamps integer values into `1..10`, and throws a
fixed `RangeError` for NaN, either infinity, fractions, or unsafe overflow.
`normalizeBoundedSize` applies the same rule with `1..10_000`. Table-drive
undefined, negative, zero, one, ten, above-max, NaN, both infinities, fraction,
and unsafe overflow for every budget so no invalid value can make a retry
comparison permanently false.

`normalizeTimerDelayMs` requires a finite safe integer in
`1..2_147_483_647`; it never clamps an oversized delay because Node converts
oversized timers into near-immediate callbacks. The manager's one canonical
`requireTimerDelay` method applies the same invariant to every computed retry
delay before calling `setTimer`. Validate the
soft-plus-hard sum before assigning a deadline, and validate each `now()` sample
as finite/safe before arithmetic. Table-drive the Node boundary, boundary+1,
unsafe sums, changing clocks, and invalid custom `retryAfterMs`; no invalid timer
may be scheduled or treated as elapsed.

Retain the existing messenger dependency and replace
`createReplyGuaranteeLivenessSender` in this commit with the final soft-stage
factory (Task 8 must not redefine it):

Set `DEFAULT_REPLY_GUARANTEE_TEXT` to the terminally truthful
`I couldn't complete that response. Please try again.` The old “still working / follow up”
promise is incompatible with terminal ownership and stale-send suppression.
Task 8 must cancel/suppress a late provider result after this interruption owns
the terminal operation; a separate follow-up lifecycle is not introduced here.

```ts
export function createReplyGuaranteeSoftSender({
  messenger,
}: {
  messenger: Messenger;
}): ReplyGuaranteeSoftSender {
  return async ({ transportTarget }) => {
    if (!messenger.setTyping) return 'unsupported';
    await messenger.setTyping(transportTarget.chatJid, 'composing');
    return 'sent';
  };
}
```

At the same Task 7 commit boundary, update AgentRuntime's imports and
`setDurability` construction to pass that real soft sender and an inline hard
sender that always rejects with a fixed internal configuration error. The
manager owns that rejection, keeps the inbound armed, applies its bounded retry
and exhaustion transition, and logs only the classified failure; it must not
send, complete, or expose the error text. This temporary hard sender is a
fail-closed compile bridge, not a public exported factory, and Task 8 removes it
when the atomic tracked sender is available. The WS-A01 branch is not
release-eligible or publishable at this intermediate commit; Task 8 adds a
source assertion that the fixed-error bridge is absent before verification. Add an AgentRuntime constructor
test that installs durability, proves the soft stage calls `setTyping`, advances
the hard stage, and observes no `sendMessage` or false inbound completion while
the journal retry remains owned. Removing either required sender from the
construction must fail Task 7's typecheck and this runtime boundary test.

`onBlocked` is required and installed before the first arm. AgentRuntime's
callback synchronously sets `acceptingRuntimeWork=false`, closes `TurnQueue`, and
stores the first bounded Reply Guarantee snapshot before invoking the main-owned
runtime-block callback. Main immediately calls Task 6's
`latchRuntimeMutationBlock('reply_guarantee', snapshot)` and moves the lifecycle
ingress router to its blocked gate; any callback/alert/controlled-shutdown error
cannot reopen either latch. A direct race that already entered AgentRuntime after
the latch returns `{outcome:'queue_rejected',reason:'reply_guarantee_blocked'}`;
the dispatcher exact-defers it, and no provider/send/new timer starts. Add
`reply_guarantee_blocked` to `RuntimeQueueFailureReason`,
`InboundDeferredReason`, initialized counters, events, and exhaustive switches.
Health and every authenticated mutation become 503 immediately. Test an inbound
and each mutation route at the latch boundary, a throwing supervisor after the
synchronous close, and restart-only recovery. A manager blocker with an accepting
Agent queue or ready mutation surface is a release blocker.

At the first line of `arm({authority})`, return without creating a
timer or map entry when `this.stopped`, `this.blockedSnapshot` is non-null, or
durability is absent. A map may be keyed by sequence only for lookup efficiency;
every read compares status/route/attempt plus the shared authority and private
timer generation. Re-arming the same exact authority is idempotent. A different
authority for the same sequence clears only the old timer generation and installs the new frozen claim with
independent soft and absolute-hard timers. Initialize `stage:'armed'`, all three
attempt counters to zero, `softTimer` at `softTimeoutMs`, and `hardTimer` at
`softTimeoutMs + hardTimeoutMs` before either callback can await. Retain Task 6's
async runtime-drain contract:

```ts
  quiesce(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const armed of this.armed.values()) this.clearArmedTimers(armed);
    this.armed.clear();
  }

  async shutdown(): Promise<void> {
    this.quiesce();
    await Promise.all([...this.inFlight]);
    this.hardAttemptByChat.clear();
  }
```

Every timer callback adds its fully observed handler promise to `inFlight`
synchronously before the first await and removes it in `finally`. AgentRuntime
must `await this.replyGuarantee?.shutdown()` before session/transport teardown.
The existing process-level shutdown deadline remains the hard external ceiling:
if a tracked terminal transport never settles, the runtime waits rather than
closing the DB underneath it, and forced exit relies on the already-created
outbound journal plus restart recovery. Add a held hard-sender shutdown test
proving runtime shutdown and DB-close eligibility remain pending until the
sender settles, while no timer can rearm after the stopped latch.

Add `isArmed(authority)`, `disarm(authority)`, and `notifyActivity(authority)` as
exact-authority APIs. `notifyActivity` affects only that authority (not every timer for the chat),
retires only its private timer generation, rearms the soft deadline, and carries forward the
original absolute `hardDeadlineAt` into the replacement generation;
`disarm` ignores a stale claim/generation/turnCompletionId. A same-chat A/B test proves activity for
A cannot postpone B. Attempt-N callbacks released after N+1 is installed emit
no telemetry, mutate no DB/map/counter, and never clear N+1.

Replace the old one-stage timeout implementation with this exact-claim,
generation-fenced algorithm. The code may be factored, but these signatures,
ordering points, and outcomes are normative:

~~~ts
private claimsEqual(
  left: InboundProcessingClaim,
  right: InboundProcessingClaim,
): boolean {
  return left.seq === right.seq
    && left.status === right.status
    && left.route === right.route
    && left.attemptCount === right.attemptCount;
}

private authorityMatches(
  active: ArmedTurn,
  authority: AdmittedTurnAuthority,
): boolean {
  return active.authority === authority
    && this.claimsEqual(active.claim, authority.claim)
    && active.generation === authority.generation
    && active.turnCompletionId === authority.turnCompletionId;
}

private currentArmed(
  claim: InboundProcessingClaim,
  timerGeneration: symbol,
): ArmedTurn | undefined {
  const active = this.armed.get(claim.seq);
  return active
    && active.timerGeneration === timerGeneration
    && this.claimsEqual(active.claim, claim)
    ? active
    : undefined;
}

private readNowOrThrow(): number {
  const value = this.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('invalid reply guarantee clock');
  }
  if (this.lastObservedNow !== null && value < this.lastObservedNow) {
    throw new RangeError('reply guarantee clock moved backward');
  }
  this.lastObservedNow = value;
  return value;
}

private clearArmedTimers(active: ArmedTurn): void {
  for (const timer of [active.softTimer, active.hardTimer, active.retryTimer]) {
    if (timer !== null) this.clearTimer(timer);
  }
  active.softTimer = null;
  active.hardTimer = null;
  active.retryTimer = null;
}

private requireTimerDelay(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError('invalid reply guarantee timer delay');
  }
}

private installArmedReplacementOrThrow(
  prior: ArmedTurn | undefined,
  replacement: ArmedTurn,
  softDelayMs: number,
  hardDelayMs: number,
): void {
  let softTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    softTimer = this.schedule(replacement, 'soft', softDelayMs);
    hardTimer = this.schedule(replacement, 'hard', hardDelayMs);
  } catch (error) {
    if (softTimer !== null) this.clearTimer(softTimer);
    if (hardTimer !== null) this.clearTimer(hardTimer);
    throw error;
  }
  replacement.softTimer = softTimer;
  replacement.hardTimer = hardTimer;
  if (prior) this.clearArmedTimers(prior);
  this.armed.set(replacement.claim.seq, replacement);
}

arm(input: {
  authority: AdmittedTurnAuthority;
}): void {
  if (this.stopped || this.blockedSnapshot || !this.durability) return;
  const prior = this.armed.get(input.authority.claim.seq);
  if (prior && prior.generation === input.authority.generation
      && prior.turnCompletionId === input.authority.turnCompletionId
      && this.claimsEqual(prior.claim, input.authority.claim)) return;
  const transportTarget = this.resolveTargetForClaim(input.authority.claim);
  const armedAt = this.readNowOrThrow();
  const hardDeadlineAt = armedAt + this.softTimeoutMs + this.hardTimeoutMs;
  if (!Number.isSafeInteger(hardDeadlineAt)) {
    throw new RangeError('reply guarantee absolute deadline is unsafe');
  }
  const hardDelayMs = hardDeadlineAt - armedAt;
  this.requireTimerDelay(this.softTimeoutMs);
  this.requireTimerDelay(hardDelayMs);
  const active: ArmedTurn = {
    authority: input.authority,
    claim: input.authority.claim,
    generation: input.authority.generation,
    turnCompletionId: input.authority.turnCompletionId,
    timerGeneration: Symbol('reply-guarantee-timer'),
    transportTarget,
    chatJid: transportTarget.chatJid,
    hardDeadlineAt,
    stage: 'armed',
    hardJournalAttempts: 0,
    failureTransitionAttempts: 0,
    timerHandlerFailures: 0,
    guardSuppressionAttempts: 0,
    softTimer: null,
    hardTimer: null,
    retryTimer: null,
  };
  this.installArmedReplacementOrThrow(
    prior, active, this.softTimeoutMs, hardDelayMs,
  );
}

isArmed(authority: AdmittedTurnAuthority): boolean {
  const active = this.armed.get(authority.claim.seq);
  return active !== undefined && this.authorityMatches(active, authority)
    && active.stage !== 'blocked';
}

disarm(authority: AdmittedTurnAuthority): void {
  const active = this.armed.get(authority.claim.seq);
  if (!active || !this.authorityMatches(active, authority)) return;
  this.clearArmedTimers(active);
  this.armed.delete(authority.claim.seq);
}

notifyActivity(authority: AdmittedTurnAuthority): void {
  const prior = this.armed.get(authority.claim.seq);
  if (!prior || !this.authorityMatches(prior, authority)
      || prior.stage !== 'armed' || this.stopped) return;

  const activityAt = this.readNowOrThrow();
  const hardDelayMs = Math.max(1, prior.hardDeadlineAt - activityAt);
  this.requireTimerDelay(this.softTimeoutMs);
  this.requireTimerDelay(hardDelayMs);
  // Invalidate a held soft callback without moving the absolute hard deadline.
  const replacement: ArmedTurn = {
    ...prior,
    timerGeneration: Symbol('reply-guarantee-activity-timer'),
    softTimer: null,
    hardTimer: null,
    retryTimer: null,
  };
  this.installArmedReplacementOrThrow(
    prior, replacement, this.softTimeoutMs, hardDelayMs,
  );
}

private retireExact(active: ArmedTurn): void {
  if (!this.currentArmed(active.claim, active.timerGeneration)) return;
  this.clearArmedTimers(active);
  this.armed.delete(active.claim.seq);
}

private async onSoftTimeout(
  active: ArmedTurn,
  timer: ReturnType<typeof setTimeout>,
): Promise<void> {
  const current = this.currentArmed(active.claim, active.timerGeneration);
  if (!current || current.stage !== 'armed'
      || current.softTimer !== timer || !this.durability) return;
  current.softTimer = null;

  const disposition = this.durability.classifyReplyGuaranteeClaim(current.claim);
  if (disposition !== 'open') {
    if (disposition === 'delivery_pending') {
      this.stats.awaitingReconciliation += 1;
    } else if (disposition === 'stale_claim') {
      this.stats.ownershipLost += 1;
    }
    this.retireExact(current);
    return;
  }

  let result: 'sent' | 'unsupported' | undefined;
  let failure: unknown;
  try {
    result = await this.sendSoftLiveness({
      authority: current.authority,
      transportTarget: current.transportTarget,
      text: this.fallbackText,
    });
  } catch (error) {
    failure = error;
  }
  const stillCurrent = this.currentArmed(current.claim, current.timerGeneration);
  if (!stillCurrent || stillCurrent.stage !== 'armed') return;
  if (failure !== undefined) {
    this.stats.softFailed += 1;
    log.warn({
      event: 'reply_guarantee_soft_failed',
      inboundSeq: current.claim.seq,
      stage: 'soft_liveness',
      failureClass: classifyErrorForInbound(failure),
    });
  } else if (result === 'sent') {
    this.stats.softSent += 1;
    log.info({
      event: 'reply_guarantee_soft_sent',
      inboundSeq: current.claim.seq,
      stage: 'soft_liveness',
    });
  } else {
    this.stats.softUnsupported += 1;
    log.debug({
      event: 'reply_guarantee_soft_unsupported',
      inboundSeq: current.claim.seq,
      stage: 'soft_liveness',
    });
  }
  // The absolute hard timer was installed by arm/notifyActivity before this await.
}

private async onHardTimeout(
  active: ArmedTurn,
  timer: ReturnType<typeof setTimeout>,
): Promise<void> {
  const current = this.currentArmed(active.claim, active.timerGeneration);
  if (!current || (current.hardTimer !== timer && current.retryTimer !== timer)
      || !this.durability) return;
  if (current.hardTimer === timer) current.hardTimer = null;
  if (current.retryTimer === timer) current.retryTimer = null;
  if (current.softTimer !== null) {
    this.clearTimer(current.softTimer);
    current.softTimer = null;
  }
  current.stage = 'hard_retry';

  const disposition = this.durability.classifyReplyGuaranteeClaim(current.claim);
  if (disposition !== 'open') {
    if (disposition === 'delivery_pending') {
      this.stats.awaitingReconciliation += 1;
    } else if (disposition === 'stale_claim') {
      this.stats.ownershipLost += 1;
    }
    this.retireExact(current);
    return;
  }

  const chatOwner = this.hardAttemptByChat.get(current.chatJid);
  if (chatOwner !== undefined) {
    const retryTimer = this.scheduleRetryOrBlock(
      current, 'hard', this.hardJournalRetryMs, 'hard_handler',
    );
    if (retryTimer === null) return;
    current.retryTimer = retryTimer;
    this.stats.inFlightSuppressed += 1;
    return;
  }

  const rateNow = this.readNowOrThrow();
  this.pruneRateLimitState(rateNow);
  const lastTerminalAt = this.lastFallbackByChat.get(current.chatJid);
  const elapsedSinceTerminal = lastTerminalAt === undefined
    ? undefined
    : rateNow - lastTerminalAt;
  if (elapsedSinceTerminal !== undefined && elapsedSinceTerminal < 0) {
    throw new RangeError('reply guarantee clock moved backwards');
  }
  if (elapsedSinceTerminal !== undefined
      && elapsedSinceTerminal < this.rateLimitMs) {
    const retryTimer = this.scheduleRetryOrBlock(
      current,
      'hard',
      this.rateLimitMs - elapsedSinceTerminal,
      'hard_handler',
    );
    if (retryTimer === null) return;
    current.retryTimer = retryTimer;
    this.stats.rateLimited += 1;
    return;
  }

  const token = Symbol('reply-guarantee-hard-attempt');
  this.hardAttemptByChat.set(current.chatJid, {
    token,
    authority: current.authority,
    claim: current.claim,
    timerGeneration: current.timerGeneration,
  });
  let result: ReplyGuaranteeTerminalResult;
  try {
    result = await this.sendTerminalNotice({
      authority: current.authority,
      transportTarget: current.transportTarget,
      text: this.fallbackText,
    });
  } catch (error) {
    this.releaseChatAttempt(current, token);
    const stillCurrent = this.currentArmed(current.claim, current.timerGeneration);
    if (!stillCurrent) return;
    const afterFailure = this.durability.classifyReplyGuaranteeClaim(
      stillCurrent.claim,
    );
    if (afterFailure !== 'open') {
      if (afterFailure === 'delivery_pending') {
        this.stats.awaitingReconciliation += 1;
      } else if (afterFailure === 'stale_claim') {
        this.stats.ownershipLost += 1;
      }
      this.retireExact(stillCurrent);
      return;
    }

    const nextJournalAttempts = stillCurrent.hardJournalAttempts + 1;
    if (nextJournalAttempts >= this.maxHardJournalAttempts) {
      const retryTimer = this.scheduleRetryOrBlock(
        stillCurrent, 'failure_transition', this.hardJournalRetryMs,
        'failure_transition',
      );
      if (retryTimer === null) return;
      stillCurrent.hardJournalAttempts = nextJournalAttempts;
      stillCurrent.stage = 'failure_transition';
      stillCurrent.retryTimer = retryTimer;
      this.stats.journalExhausted += 1;
      return;
    }
    const retryTimer = this.scheduleRetryOrBlock(
      stillCurrent, 'hard', this.hardJournalRetryMs, 'hard_handler',
    );
    if (retryTimer === null) return;
    stillCurrent.hardJournalAttempts = nextJournalAttempts;
    stillCurrent.retryTimer = retryTimer;
    this.stats.journalRetries += 1;
    return;
  }
  this.releaseChatAttempt(current, token);

    if (result.proof === 'not_sent') {
      const stillCurrent = this.currentArmed(current.claim, current.timerGeneration);
      if (!stillCurrent) return;
      this.requireTimerDelay(result.retryAfterMs);
      const nextGuardAttempts = stillCurrent.guardSuppressionAttempts + 1;
      if (nextGuardAttempts >= this.maxGuardSuppressionAttempts) {
        stillCurrent.guardSuppressionAttempts = nextGuardAttempts;
        this.stats.guardSuppressed += 1;
        this.latchBlocked(
          stillCurrent,
          'echo_guard',
          new ReplyGuaranteeEchoGuardBlocked(),
        );
        return;
      }
      const retryTimer = this.scheduleRetryOrBlock(
        stillCurrent, 'hard', result.retryAfterMs, 'echo_guard',
      );
      if (retryTimer === null) return;
      stillCurrent.guardSuppressionAttempts = nextGuardAttempts;
      this.stats.guardSuppressed += 1;
      stillCurrent.retryTimer = retryTimer;
      log.warn({
        event: 'reply_guarantee_echo_guard_suppressed',
        inboundSeq: stillCurrent.claim.seq,
        attemptCount: stillCurrent.guardSuppressionAttempts,
      });
      return;
    }
    if (result.proof === 'inbound_closed') {
      if (!this.currentArmed(current.claim, current.timerGeneration)) return;
      this.stats.closedBeforeSend += 1;
      this.retireExact(current);
      return;
    }
    if (result.proof === 'ownership_lost') {
      if (!this.currentArmed(current.claim, current.timerGeneration)) return;
      this.stats.ownershipLost += 1;
      this.retireExact(current);
      return;
    }

    // These are durable ownership/actual-send facts. Record them even if the
    // same claim's in-memory generation changed while the sender was awaiting;
    // retireExact below still cannot touch the replacement generation.
    if (result.proof === 'echoed'
        || result.reason === 'submitted'
        || result.reason === 'ambiguous') {
      this.recordRateLimitSuccess(current.chatJid, this.readNowOrThrow());
    }
    if (!this.currentArmed(current.claim, current.timerGeneration)) return;
    if (result.proof === 'awaiting_reconciliation') {
      this.stats.awaitingReconciliation += 1;
    } else if (result.proof === 'echoed') {
      this.stats.hardEchoed += 1;
    } else {
      this.stats.hardSubmitted += 1;
    }
    this.retireExact(current);
}

private async onFailureTransition(
  active: ArmedTurn,
  timer: ReturnType<typeof setTimeout>,
): Promise<void> {
  const current = this.currentArmed(active.claim, active.timerGeneration);
  if (!current || current.stage !== 'failure_transition'
      || current.retryTimer !== timer || !this.durability) return;
  current.retryTimer = null;

  let outcome:
    | 'failed'
    | 'already_terminal'
    | 'delivery_pending'
    | 'stale_claim';
  try {
    outcome = this.durability.failReplyGuaranteeExhaustedOrThrow(current.claim);
  } catch (error) {
    const nextTransitionAttempts = current.failureTransitionAttempts + 1;
    if (nextTransitionAttempts >= this.maxFailureTransitionAttempts) {
      current.failureTransitionAttempts = nextTransitionAttempts;
      this.latchBlocked(current, 'failure_transition', error);
      return;
    }
    const retryTimer = this.scheduleRetryOrBlock(
      current, 'failure_transition', this.hardJournalRetryMs,
      'failure_transition',
    );
    if (retryTimer === null) return;
    current.failureTransitionAttempts = nextTransitionAttempts;
    current.retryTimer = retryTimer;
    return;
  }

  switch (outcome) {
    case 'failed':
      this.stats.failed += 1;
      log.error({
        event: 'reply_guarantee_failed',
        inboundSeq: current.claim.seq,
        stage: 'terminal_journal',
        attemptCount: current.hardJournalAttempts,
      });
      try {
        const delivered = emitAlertChecked(
          config.botName,
          'reply_guarantee_failed',
          `whatsoup@${config.botName} reply guarantee failed`,
          `stage=terminal_journal attempts=${current.hardJournalAttempts}`,
        );
        if (!delivered) {
          this.stats.alertFailures += 1;
          log.error({
            event: 'reply_guarantee_alert_failed',
            failureClass: 'alert_delivery_failed',
          });
        }
      } catch (error) {
        this.stats.alertFailures += 1;
        log.error({
          event: 'reply_guarantee_alert_failed',
          failureClass: classifyErrorForInbound(error),
        });
      }
      break;
    case 'delivery_pending':
      this.stats.awaitingReconciliation += 1;
      break;
    case 'stale_claim':
      this.stats.ownershipLost += 1;
      break;
    case 'already_terminal':
      break;
    default: {
      const neverOutcome: never = outcome;
      throw new Error(`unhandled reply guarantee exhaustion outcome: ${neverOutcome}`);
    }
  }
  this.retireExact(current);
}
~~~

Target resolution, clock/deadline arithmetic, and both timer delays are validated
before the prior authority or its timers are mutated. Replacement timer creation
is rollback-safe: if either timer cannot be created, any newly created timer is
cleared and the prior exact authority remains installed and protected. With no
prior authority, the failure propagates to the admitted-pipeline blocker rather
than leaving an apparently armed entry with zero timers. `notifyActivity` follows the same order;
an invalid, backward, fractional, or overflowing clock sample cannot cancel the
old watchdog. Add fake-clock and throwing-scheduler tests for both `arm` and
`notifyActivity`, asserting either the prior timers still fire or the explicit
blocked health state owns shutdown—never silent timer loss.

hardAttemptByChat stores the exact `{token,authority,claim,timerGeneration}`;
release compares the token, canonical authority identity, claim, and timer
generation. The sender receives that same authority object.
recordRateLimitSuccess inserts only after an ownership-bearing sender
result and prunes entries older than rateLimitMs. If the map is still above
maxRateLimitChats, evict oldest entries deterministically until bounded. A
10,001-chat fake-clock test proves TTL and hard-cap behavior without raw chat keys
in logs/metrics. A cap+1 equal-timestamp case proves eviction happens before the
fresh success is inserted, so that just-recorded chat remains rate-limited for
the full window.

Every state/timer mutation has a named structured event emitted **after** the
mutation: hard in-flight acquisition/release, guard suppression/retry/block,
rate-limit retry, journal retry/exhaustion, failure-transition retry/success,
ownership loss, reconciliation, and timer-handler retry/block. Counters change at
the same proof point and never before a schedule/transition succeeds. Capture
exact event/counter/timer deltas for each branch, including rejected scheduling,
stale N→N+1 callbacks (with the sole rate-map exception below), and `emitAlertChecked=false`; removing or moving the state
mutation, event, or counter must make a mutation test RED.

The independently installed hard timer must fire at the original absolute
soft-plus-hard deadline even when sendSoftLiveness never settles. Activity may
invalidate/rearm the soft callback but carries forward hardDeadlineAt and never
moves it. Once hard work starts, activity is a no-op for scheduling and cannot
reset budgets. A held-soft test advances to the absolute deadline and observes
one hard sender while soft remains pending; releasing soft later emits no stale
telemetry.

Every ownership-bearing or losing result retires only the originating exact
full authority. It never clears every same-sequence entry. Add real-DB
attempt-N/N+1 races across soft, hard, journal exhaustion, failure transition,
activity, disarm, and sender completion. N may produce no new send and may not
mutate N+1 authority/timers/counters/inbound after N+1 wins; a terminal owner
discovered for N transfers only N to reconciliation. If N's already-awaited
sender returns proven `echoed|submitted|ambiguous`, its one permitted
process-level mutation is the conservative chat rate-limit timestamp because an
actual/possible send occurred. That rate entry is not authority state and must
not retire/rearm/touch N+1. Add exact rate-only delta assertions for this race.

Unexpected hard/status/evidence handler failures use the separately bounded
maxTimerHandlerFailures path in schedule. At exhaustion latchBlocked first clears
and marks blocked every armed generation, then stores the first bounded snapshot
and emits at most one alert; later concurrent blockers still clear their own/all
timers. No blocked or exhausted path rearms. A two-claim simultaneous-failure test
proves one alert/snapshot, zero remaining timers/transports, shutdown completion,
and preserved exact rows. Soft-handler exceptions are logged with bounded
failure class and leave the independent hard timer intact.

Expose getHealth() through AgentRuntime.getHealthSnapshot and HealthDeps. A
manager blocker or a current failed/reply_guarantee_failed/db_error durability
gauge forces overall unhealthy/HTTP 503 with only stage, failure class, attempt
count, and bounded claim tuple. Extend scripts/requeue-inbound.ts with
--resolve-reply-guarantee retry|archive: stop ingress, require backup/checksum and
dry-run. `retry` is accepted only while `attempt_count < MAX_INBOUND_ATTEMPTS`;
it atomically moves the exact failed row to due `deferred/crash_recovery`
without resetting attempts. A capped row refuses retry and requires `archive`,
which preserves the failure evidence and moves it to
`operator_reply_guarantee_resolved` with a fresh completion marker. No terminal
outbound owner may be overridden, and neither mode backfills provenance or
sends.

The persisted incident has no same-process clear and no synthetic or
rollback-only “echo canary.” Repair requires restart. The restarted process keeps
a bounded process-local set of modern exact terminal op IDs that **this boot**
successfully reserved after lifecycle readiness; startup-loaded, reconciled, or
legacy rows never enter it. Only `matchEcho` for one of those IDs, observed by
the live post-ready ingress path, may set a one-shot
`replyGuaranteeRecoveryProof`. With that proof plus fresh zero
failure/provenance gauges, the process may call `clearAlertSourceChecked` for a
persisted/unknown prior incident. A `false` return or throw emits/increments
`reply_guarantee_alert_clear_failed`, retains the incident and unhealthy clear
status, and leaves the proof available for one bounded retry; a true return
consumes it and is idempotent. Bound/prune the current-boot ID set without raw
chat keys. If no new healthy send+echo occurs, the incident remains.
Test below-cap retry, capped refusal/archive, rollback, no-incident/no-clear,
pre-stored/startup-reconciled/foreign/submitted evidence refusal, current-boot
live echo, helper false/throw/true, persisted incident, and no clear without real
post-restart traffic.

Add exact-delta event/stat tests for every result. stale_claim, failed/lost CAS,
already_terminal, stale callbacks, and blocked retries increment no success
counter.

- [ ] **Step 4: Run the manager suite and inspect the fake-clock stage boundary**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/reply-guarantee.test.ts tests/core/durability.test.ts tests/core/ingest.test.ts tests/core/health.test.ts tests/core/inbound-failure-class.test.ts tests/scripts/requeue-inbound.test.ts tests/runtimes/agent/runtime.test.ts tests/main-bootstrap.test.ts tests/main-bootstrap-helpers.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
```

Expected: PASS. In manager-unit tests, exactly the soft deadline observes no terminal sender and no `completeTurn`, while soft plus hard invokes the injected terminal-sender contract once. At this Task 7 AgentRuntime boundary, the real soft sender calls typing but the explicit interim hard sender fails closed: there is no transport send or false completion, and the retry/exhaustion owner remains observable. Rate limiting and pre-transport journal failure retain the same inbound timer, while a durable `maybe_sent` fixture transfers ownership to reconciliation without an inline resend. A held hard sender keeps manager/runtime shutdown pending; after release, the in-flight gauge returns to zero and shutdown resolves without rearming a timer. Task 8 is the first commit whose runtime test expects a real tracked hard send.

- [ ] **Step 5: Commit the watchdog state machine**

```bash
git add src/core/types.ts src/core/durability.ts src/core/ingest.ts src/core/health.ts src/core/inbound-failure-class.ts src/core/reply-guarantee.ts src/main.ts src/runtimes/agent/runtime.ts scripts/requeue-inbound.ts tests/core/durability.test.ts tests/core/ingest.test.ts tests/core/health.test.ts tests/core/inbound-failure-class.test.ts tests/core/reply-guarantee.test.ts tests/scripts/requeue-inbound.test.ts tests/runtimes/agent/runtime.test.ts tests/main-bootstrap.test.ts tests/main-bootstrap-helpers.test.ts deploy/source-runtime-manifest.json docs/reply-guarantee.md docs/durability.md docs/runbook.md docs/public-surface.md
git commit -m "fix(durability): split reply guarantee soft and hard deadlines"
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
```

Run the source-runtime guard only on the committed Task 7 head. If hashes or
implementation change, amend and rerun the entire Task 7 matrix plus docs/public
guards; a dirty/staged guard result is `Inconclusive`.

### Task 8: Send every terminal outcome through exact outbound ownership and echo proof (WS-A01, commit 2)

**Files:**
- Modify: `src/core/database.ts` for migration 38 token-accounting provenance
- Modify: `tests/core/database.test.ts`
- Modify: `tests/core/migration-safety.test.ts` and `tests/core/durability-schema.test.ts`
- Create: `tests/core/migration-38-token-provenance.test.ts`
- Modify: `src/core/types.ts`
- Create: `src/core/admitted-turn.ts`
- Modify: `src/core/durability.ts`
- Modify: `src/core/ingest.ts`
- Modify: `src/core/inbound-replay.ts`
- Modify: `src/core/reply-guarantee.ts`
- Modify: `src/core/admin.ts`
- Modify: `src/core/echo-guard.ts`
- Modify: `src/core/health.ts`
- Modify: `src/core/inbound-failure-class.ts`
- Modify: `src/main.ts` and `src/main-shutdown-policy.ts` for coordinator construction, quiesce, orderly handoff, drain, and DB-close ordering
- Modify: `src/runtimes/types.ts`
- Modify: `src/runtimes/passive/runtime.ts`
- Modify: `src/runtimes/chat/runtime.ts`
- Modify: `src/runtimes/chat/queue.ts` for atomic lease transfer before publish/drain
- Modify: `src/runtimes/agent/turn-queue.ts`
- Modify: `src/runtimes/agent/outbound-queue.ts`
- Modify: `src/runtimes/agent/image-coalescer.ts`
- Modify: `src/runtimes/agent/media-bridge.ts`
- Modify: `src/runtimes/agent/session.ts`
- Modify: `src/runtimes/agent/session-db.ts`
- Modify: `src/runtimes/agent/providers/budget.ts`
- Modify: `src/runtimes/agent/control-queue.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `deploy/scripts/retire-outbound-quarantine.py`
- Modify: `deploy/scripts/README-bot-errors.md`
- Modify: `deploy/source-runtime-manifest.json`
- Modify: `docs/configuration.md`
- Modify: `docs/durability.md`
- Modify: `docs/reply-guarantee.md`
- Modify: `docs/runbook.md`
- Modify: `docs/public-surface.md`
- Modify: `tests/core/durability.test.ts`
- Create: `tests/core/admitted-turn.test.ts`
- Modify: `tests/core/durability-edge.test.ts`
- Modify: `tests/core/durability-drain.test.ts`
- Modify: `tests/core/durability-continuity-marker.test.ts`
- Modify: `tests/core/durability-echoed-terminal-recovery.test.ts`
- Modify: `tests/core/durability-turn-done-recovery.test.ts`
- Modify: `tests/core/durability-recovery.test.ts`
- Modify: `tests/core/durability-stuck-inbound-sweep.test.ts`
- Modify: `tests/core/perf-prepared-statements.test.ts`
- Modify: `tests/core/reply-guarantee.test.ts`
- Modify: `tests/core/admin.test.ts`
- Modify: `tests/core/echo-guard.test.ts`
- Modify: `tests/core/ingest.test.ts`
- Modify: `tests/core/inbound-replay.test.ts`
- Modify: `tests/core/health.test.ts`
- Modify: `tests/core/inbound-failure-class.test.ts`
- Modify: `tests/core/inbound-shutdown-lifecycle.test.ts`, `tests/main-bootstrap.test.ts`, `tests/main-bootstrap-helpers.test.ts`, and `tests/main-shutdown-policy.test.ts`
- Modify: `tests/integration/crash-recovery.test.ts`
- Modify: `tests/runtimes/passive/runtime.test.ts`
- Modify: `tests/runtimes/chat/runtime.test.ts`
- Modify: `tests/runtimes/chat/queue.test.ts`
- Modify: `tests/runtimes/agent/turn-queue.test.ts`
- Modify: `tests/runtimes/agent/outbound-queue.test.ts`
- Modify: `tests/runtimes/agent/outbound-queue-idempotency.test.ts`
- Modify: `tests/runtimes/agent/image-coalescer.test.ts`
- Modify: `tests/runtimes/agent/media-bridge.test.ts`
- Modify: `tests/runtimes/agent/session.test.ts`
- Modify: `tests/runtimes/agent/session-db.test.ts`
- Modify: `tests/runtimes/agent/session-budget.test.ts`
- Modify: `tests/runtimes/agent/providers/budget.test.ts`
- Modify: `tests/runtimes/agent/providers/budget-and-mapping.test.ts`
- Modify: `tests/runtimes/agent/control-queue.test.ts`
- Modify: `tests/runtimes/agent/control-timeout.test.ts`
- Modify: `tests/runtimes/agent/codex-turn-lifecycle.test.ts`
- Modify: `tests/runtimes/agent/fallback-cost-accumulation.test.ts`
- Modify: `tests/runtimes/agent/fallback-empty-turn.test.ts`
- Modify: `tests/runtimes/agent/idle-session-eviction.test.ts`
- Modify: `tests/runtimes/agent/per-chat-actor-binding.test.ts`
- Modify: `tests/runtimes/agent/per-chat-empty-output-replay.test.ts`
- Modify: `tests/runtimes/agent/provider-fallback.test.ts`
- Modify: `tests/runtimes/agent/runtime-edge-coverage.test.ts`
- Modify: `tests/runtimes/agent/runtime-secondhalf-branches.test.ts`
- Modify: `tests/runtimes/agent/runtime-structural-policy.test.ts`
- Modify: `tests/runtimes/agent/runtime.test.ts`
- Modify: `tests/runtimes/agent/zombie-sessions.test.ts`
- Modify: `tests/scripts/retire-outbound-quarantine.test.ts`

**Interfaces:**
- Consumes: migration 37 exact outbound provenance; Task 3's claim-first terminal-evidence classifier and recovery-only reconciliation; Task 5's sole `reserveOutboundForClaim` transaction, canonical `{claim,generation,turnCompletionId}` authority, and claim-capturing queue/media lanes; Task 6's producer/shutdown ownership; and Task 7's exact-authority watchdog, `not_sent/echo_guard_suppressed` retry result, and blocker callback.
- Produces: migration 38 durable provider-result accounting IDs and provider-attempt cancellation tombstones; one private transaction helper shared by Task 5 single-op and Task 8 terminal-batch reservation; inert Agent/Chat installed capabilities plus closure-bound queue/admin/RGP owner handles; owner-private `sendTrackedWithOutcome`; exact `TerminalBatchReceipt`; private claim-bound completion helpers; typed provider/non-provider finalization inputs; exact monotonic echo/receipt transitions; atomic minimal-mode promotion through the same owner transaction; per-turn result-finalization barriers; and `createReplyGuaranteeTrackedSender` backed by the same terminal queue and the `src/core/echo-guard.ts` SSOT as provider output. No private second terminal-claim primitive, mutable sequence authority, latest-op lookup, raw-authority public completion/accounting/waiter, or claimless admitted send survives this task.

- [ ] **Step 1: Add migration 38 for idempotent provider-result accounting**

Write `tests/core/migration-38-token-provenance.test.ts` before production code. A fresh database and a full version-37 fixture must gain nullable `agent_token_events.source_inbound_seq`, `source_inbound_route`, `source_inbound_attempt`, `source_result_id`, `source_provider_id`, and `cancelled_at`. The four inbound-claim/result fields are null together for legacy/system accounting or form a valid tuple: positive safe sequence/attempt, nonblank route, and a result ID whose UTF-8 byte length is `1..128` (`MAX_PROVIDER_ATTEMPT_ID_BYTES`). Every new exact or system provider event supplies a canonical `source_provider_id` whose UTF-8 byte length is `1..64` (`MAX_PROVIDER_ID_BYTES`); only migrated legacy rows may retain it null. The CHECK permits null provider ID with an all-null legacy claim tuple, permits a bounded provider ID with an all-null system tuple, and requires it for every exact tuple. `cancelled_at` must be null whenever the claim tuple is null; for an exact tuple it is null or a nonnegative safe-integer epoch second. Put those rules and both byte-length bounds in the last new column CHECK. Add partial unique index:

```sql
CREATE UNIQUE INDEX idx_agent_token_events_claim_result
ON agent_token_events(
  source_inbound_seq,
  source_inbound_route,
  source_inbound_attempt,
  source_result_id
)
WHERE source_inbound_seq IS NOT NULL
  AND source_inbound_route IS NOT NULL
  AND source_inbound_attempt IS NOT NULL
  AND source_result_id IS NOT NULL;
```

The exact claim/attempt ID—not session ID—is the uniqueness authority. A repeat
key whose stored `agent_session_id`, `source_provider_id`, or prior counts
disagree is an invariant, not a second row. Provider attribution is never
inferred from the session during restart rebuild. The migration preserves all existing token-event fields/indexes and legacy null rows, fails closed if `agent_token_events` is missing, is idempotent on reopen/forced rerun, and rolls back all six columns plus the index on a fault after the ALTERs. Do not add a foreign key to inbound events. Advance the current migration and safety inventories from 37 to 38 only in this WS-A01 commit. Add this configuration row:

```markdown
| 38 | Adds exact inbound-claim/provider-result/provider provenance plus a cancellation tombstone to `agent_token_events`, with a partial unique claim/result index so duplicate or cancelled callbacks cannot double-account usage and restart rebuild attributes primary/fallback attempts correctly; system events keep claim/result null but persist provider identity, while migrated legacy provider identity may remain null. |
```

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/migration-38-token-provenance.test.ts tests/core/durability-schema.test.ts tests/core/migration-safety.test.ts tests/core/database.test.ts --pool=forks
```

Expected RED: current tip is 37 and the six fields/index are absent. A missing module, truncated fixture, or runner failure is `Inconclusive`. Implement `runMigration38`, the CHECK, index, missing-table failure, named map entry, full migration-safety updates, and rerun until all four files pass.

- [ ] **Step 2: Capture exact-ownership RED tests at real lifecycle seams**

Use real file-backed databases. Every admitted fixture calls `admitInboundMessage`, then `markInboundProcessing`, and passes the returned frozen claim; never seed a bare `inboundSeq` as runtime authority. Add two-connection barriers for each of these semantic failures:

1. Attempt N cannot reserve, send, complete, fail, disarm, account tokens, or clear N+1 after the second connection advances ownership.
2. A submitted supplied terminal op remains `delivery_pending` even when a different op for the sequence is echoed. Only the supplied exact terminal op itself can prove delivery.
3. `quarantined`/`failed_permanent` exact terminal ownership reconciles the exact inbound to failed; it cannot remain indefinitely delivery-pending. A foreign/legacy-invalid failed op never fails a newer attempt.
4. Provider finalization and Reply Guarantee race through one terminal-owner transaction. Exactly one owner exists and at most one transport path runs.
5. A provider terminal batch is all-or-nothing before transport. Faulting item N rolls back every chunk, optional voice marker, and terminal row. No transport begins from a partial batch.
6. A held result finalization for turn N prevents turn N+1 from installing/clearing current ownership in shared, single, and per-chat scopes. A system-result event does not release the user-turn barrier.
7. A fallback-scheduled provider result retains the same full authority across provider attempts; it is not shifted, popped/re-enqueued, or reminted.
8. Group echo guard suppression creates no op/send/rate timestamp and returns Task 7's retry-without-ownership result.
9. Minimal mode, voice, echo, `/new`, and shutdown races meet the contracts below.
10. Duplicate/cumulative callbacks with the same provider-attempt ID apply only monotonic token deltas; distinct primary/fallback attempt IDs for the same claim each account once. A cancellation/usage race serializes so usage committed before the tombstone is counted and callbacks after it return `cancelled` with zero delta.

For each family first run the new test against current code and retain an intended state/transport assertion failure. Type errors caused only by the new interface are scaffold failures, not semantic RED. Add a compiling inert scaffold, rerun, and capture a true lifecycle failure before GREEN.

Every `agentSessionId`, outbound op ID, inbound sequence, attempt, timestamp,
token count, and enqueue ordinal crossing into JavaScript is a safe integer in
its documented positive/nonnegative range. In particular, accounting rejects a
zero, negative, fractional, non-finite, unsafe, or mismatched session ID before
SQL; batch reservation validates every returned op ID before commit and rolls
the whole batch back on one unsafe ID. Add `MAX_SAFE`, `MAX_SAFE+1`, and lossy
`MAX_SAFE+2` cases for batches and accounting as well as the Task 5 single-op
cases.

- [ ] **Step 3: Implement the sole reservation, receipt, completion, and accounting contracts**

Do not add `createTerminalOutboundOpIfAbsent`. Main owns one
`AdmittedTurnCoordinator` bound to the process's `DurabilityEngine` and transport
adapters. At each successful pending→processing or replay claim, the shared
dispatcher creates the canonical frozen authority once and installs one
closure-bound `InstalledAdmittedTurnCapability`; it passes that same authority
and capability to AgentRuntime, ChatRuntime, core admin/fallback handling,
TurnQueue, OutboundQueue, Reply Guarantee, media, and finalization. Agent turns
receive an extended provider-accounting capability, while Chat/admin use the
checkpoint-free base capability. Passive/policy skips never install one.

All DurabilityEngine SQL helpers for normal admitted reservation, target proof,
completion, accounting, and waiter registration are module-private and accept
only the already-validated claim. No public/cast caller can invoke a DB helper
with an authority directly. The coordinator compares authority object identity,
engine binding, runtime lane, and installed generation before every operation.
Exact abort removes the entry only after all capability operations settle;
shutdown quiesces installs, drains them, then clears the registry.
Authorities/capabilities never survive restart. Task 5's claim-only approval
exception remains the sole pending/ingest exception because an unknown-sender
denial terminalizes before pending→processing and therefore cannot install a
turn capability. Its atomic trusted-admin-target receipt/dedupe contract remains
unchanged. Core admin/fallback command replies, which do claim processing
ownership, migrate to the installed base capability.
Add direct-helper export inventory, Agent/Chat/admin parity, reminted-object,
engine-A/engine-B, wrong-lane, abort-in-flight, shutdown, and restart tests.

Define `DispatcherAdmittedTurnLease` in `src/core/admitted-turn.ts` beside the
coordinator, its unexported brand value, and private factory. Export only the
branded type:

```ts
const DISPATCHER_TURN_LEASE: unique symbol = Symbol('dispatcher-turn-lease');

export interface DispatcherAdmittedTurnLease {
  readonly authority: AdmittedTurnAuthority;
  readonly [DISPATCHER_TURN_LEASE]: true;
}
```

Task 8 then replaces Task 5's runtime-side symbol minting with this
final dispatch envelope in `src/runtimes/types.ts`:

```ts
import type {
  DispatcherAdmittedTurnLease,
  InstalledAdmittedTurnCapability,
  InstalledAgentTurnCapability,
} from '../core/admitted-turn.ts';

export type AdmittedRuntimeTurnBinding =
  | {
      runtimeKind: 'agent';
      authority: AdmittedTurnAuthority;
      capability: InstalledAgentTurnCapability;
      dispatcherLease: DispatcherAdmittedTurnLease;
    }
  | {
      runtimeKind: 'chat';
      authority: AdmittedTurnAuthority;
      capability: InstalledAdmittedTurnCapability;
      dispatcherLease: DispatcherAdmittedTurnLease;
    };

export type RuntimeHandleRequest =
  | {
      lane: 'admitted';
      message: Omit<IncomingMessage, 'inboundSeq' | 'inboundClaim'> & {
        inboundSeq?: never;
        inboundClaim?: never;
      };
      turn: AdmittedRuntimeTurnBinding;
    }
  | {
      lane: 'synthetic' | 'durability_disabled';
      message: Omit<IncomingMessage, 'inboundSeq' | 'inboundClaim'> & {
        inboundSeq?: never;
        inboundClaim?: never;
      };
      turn?: never;
    };

export type RuntimeQueueAdmissionResult =
  | { outcome: 'queue_accepted' }
  | RuntimeQueueRejection;

export interface Runtime {
  // Preserve the remaining lifecycle/health members unchanged.
  handleMessage(request: RuntimeHandleRequest): Promise<RuntimeQueueAdmissionResult>;
}
```

The shared dispatcher asks the coordinator to install the binding after the
exact processing claim wins, then calls `runtime.handleMessage(request)`.
Runtime kind, authority object, capability authority, and engine binding must
all match before queue admission. The dispatcher lease type is exported only for
type handoff; its unique-symbol value/constructor and registry record remain
private to the coordinator. Agent/Chat queues carry the binding unchanged;
the final runtime path derives sequence/claim only from
`request.turn.authority.claim` and never reads lifecycle authority from the
message. Task 8 removes the Task 5 message fields before calling the runtime;
cast-around duplicates must exactly match and are then stripped, while mismatch
blocks before queue/state mutation. No runtime, queue, media bridge, admin helper, or test remints symbols. Synthetic
and durability-disabled lanes reject any binding. Policy/CAS failure aborts an
unconsumed install; queue rejection remains dispatcher-owned durable deferral
and aborts only after that transition. Add compile-negative and cast-around
wrong-kind/missing/reminted/synthetic-binding tests plus exact Agent/Chat queue
handoff tests.

Task 8 migrates every production/test caller to the request/result contract in
this commit. `queue_accepted` means only that the real queue atomically accepted
the owner lease; it does not mean provider completion. The shared dispatcher
maps it to `dispatched`, while synthetic/scheduler owners consume it directly.
No final `Promise<void>` compatibility overload remains.

The coordinator injects a private
`acceptQueueLease(dispatcherLease, queueIdentity)` function into each real queue
and an analogous admin acceptor. Inside the synchronous acceptance critical
section, the queue consumes the dispatcher lease and receives an opaque
queue-owner lease stored on the item before publish/drain. On rejection/throw
the dispatcher retains the unconsumed lease and may call only the coordinator's
dispatcher-abort operation after durable disposition. Capability methods and
synthetic requests cannot construct or consume leases. Add missing/forged/
already-consumed lease, wrong-queue, eager-drain, abort-after-transfer, and
rejection-abort tests.

Installation returns a dispatcher-owned lease with states
`dispatcher_owned → queue_owned|admin_owned → finalizing → settled`; transitions
are one-way and object-identity checked. Agent/Chat call `transferToQueue` only
inside the real queue's synchronous acceptance critical section, after capacity
validation but before the item is published/pushed or any drain/processor can
run. Transfer failure rolls back acceptance with no visible item. Only then may
the runtime return `{outcome:'queue_accepted'}`; core admin similarly transfers only after its
handler owns the command. A pre-queue throw or bounded queue rejection leaves
the lease dispatcher-owned. The dispatcher first performs the exact durable
deferral/failure/policy transition, then aborts a dispatcher-owned install only
after that transition commits. If the transition throws, it latches the blocker
and retains/drains the capability—never leaking it silently or invalidating an
open processing claim before recovery. Once transferred, only the queue/admin
owner may finish/abort; the dispatcher cannot. Define the runtime admission
result explicitly as `queue_accepted | RuntimeQueueRejection` and exhaust every
branch. Add queue-reject+successful-deferral, queue-reject+deferral-fault,
pre-queue throw, admin throw, double-transfer, wrong-owner abort, and shutdown
drain tests with exact registry-size assertions. Include an eager TurnQueue
processor and Chat microtask scheduler proving neither can observe work before
the atomic transfer.

Abort/finalize authority lives on opaque owner-specific lease handles, not on
the shared capability. A dispatcher lease can abort only while
`dispatcher_owned`; atomic transfer consumes it and returns a queue/admin lease
whose abort/finalize methods carry a private owner token. The coordinator alone
holds the shutdown token. No parameterless capability abort exists. Compile and
runtime tests prove a retained dispatcher handle, wrong queue, copied token, or
double abort cannot affect the current owner.

Factor Task 5's existing immediate transaction into a private transaction-scoped
helper and keep `reserveOutboundForClaim` only for the Task 5 intermediate slice
and the explicit approval exception. The final Task 8 normal admitted surface is
a queue-private batch operation that reuses the SQL helper under the same
`BEGIN IMMEDIATE`:

```ts
export interface TerminalBatchItem {
  readonly kind: 'assistant_content' | 'command_reply' | 'reply_guarantee' | 'voice';
  readonly enqueueOrdinal: number;
  readonly opType: string;
  readonly payload: string;
  readonly replayPolicy: 'safe' | 'unsafe' | 'read_only';
}

export type TerminalOwnerKind =
  | 'provider_result'
  | 'reply_guarantee'
  | 'non_provider';

const TERMINAL_OWNER_PERMIT: unique symbol = Symbol('terminal-owner-permit');

interface TerminalOwnerPermit {
  readonly ownerKind: TerminalOwnerKind;
  readonly providerAttemptId: string | null;
  readonly [TERMINAL_OWNER_PERMIT]: true;
}

export type TerminalBatchReservation =
  | {
      outcome: 'reserved';
      authority: AdmittedTurnAuthority;
      transportTarget: Readonly<{ conversationKey: string; chatJid: string }>;
      items: readonly Readonly<{
        outboundOpId: number;
        enqueueOrdinal: number;
        kind: TerminalBatchItem['kind'];
        isTerminal: boolean;
      }>[];
      terminalOpId: number;
    }
  | {
      outcome: 'existing_terminal'; authority: AdmittedTurnAuthority;
      outboundOpId: number; status: OutboundStatus;
    }
  | { outcome: 'inbound_closed'; authority: AdmittedTurnAuthority }
  | { outcome: 'stale_claim'; authority: AdmittedTurnAuthority };

interface PreparedTerminalTarget {
  readonly transportTarget: Readonly<{ conversationKey: string; chatJid: string }>;
  // Opaque unexported symbol binds authority + engine + current DB target.
  readonly targetProof: symbol;
}

export type InstalledTurnCompletionResult =
  | { outcome: 'complete' | 'failed' | 'already_terminal' | 'stale_claim' }
  | {
      outcome: 'awaiting_disposition';
      terminalOpId: number;
      status: 'sending' | 'submitted' | 'maybe_sent';
    }
  | {
      outcome: 'blocked_evidence';
      reason: 'pending_owner';
      terminalOpId: number;
      status: 'pending';
    }
  | {
      outcome: 'blocked_evidence';
      reason: 'invalid_provenance';
      terminalOpId?: number;
      status?: OutboundStatus;
    }
  | {
      outcome: 'blocked_evidence';
      reason: 'unsafe_op_id';
      terminalOpId?: never;
      status?: never;
    }
  | { outcome: 'shutdown_handoff'; terminalOpId: number };

export interface InstalledAdmittedTurnCapability {
  readonly authority: AdmittedTurnAuthority;
}
```

`PreparedTerminalTarget` is a frozen, unexported runtime token, not a caller
target hint; its proof is stored in a private `WeakMap`, not accepted by
structural equality. Preparation reads and validates the exact current DB target
under the engine's serialized boundary. Reservation revalidates the proof and
includes both target columns plus the exact claim in its `INSERT ... SELECT`
predicate. A target/alias mutation between prepare and INSERT yields no op and a
bounded invariant blocker; the returned DB target must equal the prepared target
before any guard/transport action.

Every reservation consumes an opaque, single-use owner permit stored in a
private WeakMap and records its closed `ownerKind`. No installed capability
exposes target preparation, permit minting, reservation, send, waiter, abort, or
completion. Those operations exist only on the queue/admin owner handles defined
in Step 4 after a dispatcher lease has transferred. A provider-owner handle is
created only for its validated exact active attempt; the dedicated RGP factory
atomically captures the currently competing active attempt; and a non-provider
owner handle carries a null attempt plus a closed source class. The private
brand values/constructors are unexported; raw `ownerKind` is never accepted. The synchronous Agent hook
receives the validated permit data: `provider_result` fences later chunks but never cancels its own
successful provider attempt; `reply_guarantee` fences and begins the competing
provider cancellation/tombstone sequence; `non_provider` cannot impersonate
either path. The RGP factory is the only producer of `reply_guarantee`, and the
provider-result finalizer is the only producer of `provider_result`; private
factory tokens plus runtime validation reject cast-around misclassification.
Add provider-own-no-self-cancel, RGP-pre-transport-cancel, non-provider, and
forged/replayed/stale-attempt owner-permit tests.

The owner-handle-private `sendTrackedWithOutcome` is only a convenience wrapper for a one-item terminal non-provider/RGP send that
prepares the target and calls this exact `reserveTerminalBatch` transaction with
one non-voice item whose ordinal is terminal; it has no caller-controlled
`isTerminal` flag, independent INSERT, auxiliary transport, or completion path.
Provider text uses the buffered batch owner instead.
Source-structure and SQL-spy mutation tests fail if the terminal wrapper bypasses
batch validation, target proof, guard, or the synchronous reservation hook.

The concrete queue first validates the canonical frozen authority object against
its installed registry entry and engine binding; only then does its private DB
helper validate the exact persisted claim. It never accepts or creates separate
claim/generation/completion fields. The transaction validates strictly
unique/nonnegative safe
ordinals, exactly one terminal item, and no prior terminal owner in any status.
The terminal ordinal must name an
`assistant_content|command_reply|reply_guarantee` item, never `voice`, and must
be the greatest non-voice ordinal so no later visible text remains unsent when
its echo closes the turn. Voice alone is never delivery proof. Add cast-around
voice-terminal and terminal-middle/later-text rejection tests.
It inserts every row with database-copied conversation/JID target and
sequence/route/attempt provenance and committed `status='sending'`; any
insert/constraint/fault rolls the batch back. The single returned
`transportTarget` is copied from that same inbound row and is the only target
used by every batch transport. Returned entries preserve input ordinal order—
transport never sorts by op ID or settlement order. Repeated exact calls return
the existing owner and send nothing. Every later admitted single-op reservation
is blocked once a terminal owner exists. Cast-around wrong-conversation/JID or
reminted-symbol inputs cannot override the installed authority and produce no
journal/transport/completion.

Optional voice is the only **non-text** auxiliary item permitted in a terminal
batch; earlier bounded assistant-text chunks may be nonterminal while the
greatest non-voice text is terminal. Voice is reserved in that same transaction
before either text or media transport and shares the exact full authority. There
is no post-terminal voice reservation API. If Reply Guarantee wins before the
batch, reserve/send neither provider text nor voice. If the provider batch wins,
a text echo may close the inbound while the already-authorized voice settles;
no later synthesis/send can be invented.

Define exact send and receipt results:

```ts
export type SendTrackedWithOutcome =
  | { outcome: 'echoed'; outboundOpId: number }
  | { outcome: 'submitted'; outboundOpId: number }
  | { outcome: 'ambiguous'; outboundOpId: number }
  | { outcome: 'existing_terminal'; outboundOpId: number; status: OutboundStatus }
  | { outcome: 'inbound_closed' }
  | { outcome: 'stale_claim' };

export type TerminalBatchReceipt =
  | {
      outcome: 'terminal';
      authority: AdmittedTurnAuthority;
      opIds: readonly number[];
      terminalOpId: number;
      delivery: 'echoed' | 'submitted' | 'ambiguous';
    }
  | {
      outcome: 'none';
      authority: AdmittedTurnAuthority;
      reason: 'empty' | 'deduplicated' | 'echo_guard_suppressed';
    }
  | {
      outcome: 'existing_terminal';
      authority: AdmittedTurnAuthority;
      outboundOpId: number;
      status: OutboundStatus;
    }
  | {
      outcome: 'inbound_closed'; authority: AdmittedTurnAuthority;
    }
  | {
      outcome: 'stale_claim'; authority: AdmittedTurnAuthority;
    };
```

The owner handle's private `sendTrackedWithOutcome` replaces Task 5's admitted overload,
is closure-bound to the canonical authority, transferred queue/admin lease,
exact engine, and no chat target,
and preserves the exact locally
returned op ID through sending/submitted/maybe-sent/echoed transitions, and
never queries a latest/global op. There is no engine parameter to mix up and no
free exported admitted sender; an engine-A capability cannot be installed or
used in engine B. A field-equal reminted authority is rejected.
Claimless system/synthetic lanes retain the separate Task 5 API and cannot
return an admitted receipt.

Add exact completion APIs:

```ts
const NO_OUTBOUND_RECEIPT: unique symbol = Symbol('no-outbound-receipt');

export interface LocalCommandSilentReceipt {
  readonly kind: 'local_command_silent';
  readonly authority: AdmittedTurnAuthority;
  readonly commandClass: 'typed_silent';
  readonly [NO_OUTBOUND_RECEIPT]: true;
}

export interface PollPartialNoReplyReceipt {
  readonly kind: 'poll_partial_no_reply';
  readonly authority: AdmittedTurnAuthority;
  readonly pollClass: 'partial_no_visible_reply';
  readonly [NO_OUTBOUND_RECEIPT]: true;
}

export type NoOutboundCompletion =
  | {
      reason: 'local_command_no_output';
      evidence: LocalCommandSilentReceipt;
    }
  | {
      reason: 'poll_partial';
      evidence: PollPartialNoReplyReceipt;
    };

type NoOutboundOwnerCompletionEvidence =
  | { outcome: 'complete' | 'failed' | 'already_terminal' | 'stale_claim' }
  | {
      outcome: 'delivery_pending';
      terminalOpId: number;
      status: 'sending' | 'submitted' | 'maybe_sent';
    }
  | {
      outcome: 'blocked_evidence';
      reason: 'pending_owner';
      terminalOpId: number;
      status: 'pending';
    }
  | {
      outcome: 'blocked_evidence';
      reason: 'invalid_provenance';
      terminalOpId?: number;
      status?: OutboundStatus;
    }
  | {
      outcome: 'blocked_evidence';
      reason: 'unsafe_op_id';
      terminalOpId?: never;
      status?: never;
    };

// Module-private SQL helper; called only after transferred-owner validation.
completeInboundWithoutOutboundForInstalledClaim(input: {
  claim: InboundProcessingClaim;
  completion: NoOutboundCompletion;
}): NoOutboundOwnerCompletionEvidence;
```

The runtime brand value, symbol key, and constructors remain unexported and
private to the turn-finalization owner; receipt identity in the registry is the
actual authorization, so copying the symbol/property still fails.
That owner keeps a bounded object-identity registry keyed by the exact canonical
authority and mints a frozen receipt only after the inventoried command/poller
branch returns its typed bounded outcome. A receipt is single-use: completion
atomically marks its registry entry `in_flight` before DB work; concurrent or
replayed use rejects; a DB exception restores it for the same authority; any
committed terminal, pending-reconciliation, closed, or stale outcome consumes
it. Exact abort/finalization removes only that authority's unused receipt.
Registry capacity is tied to the bounded active-turn count and never evicts a
live turn. Receipts are in-memory only and cannot cross restart; startup recovery
uses its durability-owned paths. Compile-negative construction plus plain-object,
copied-brand, duplicate, concurrent, stale-generation, abort, and restart tests
prove the runtime registry—not structural typing—is the authority.

The no-output helper runs in one immediate transaction and classifies attempt
ownership before terminal state. A newer attempt is always `stale_claim`.
When an exact terminal owner already exists, it returns that exact safe-positive
op ID/status in the same serialized read; the non-provider owner handle, not the
capability, installs and retains the exact waiter before returning
`awaiting_disposition`. It never queries a latest op. Only exact
`sending|submitted|maybe_sent` evidence enters a waiter. A pending legacy owner,
invalid/mixed provenance, or unsafe op ID returns the corresponding split
`blocked_evidence`, latches health, and retains the barrier; the unsafe branch's
type cannot carry an ID/status. Add no-output↔RGP/provider reservation races,
pre-stored disposition, adjacent safe/unsafe IDs, dropped caller results, every
`OutboundStatus`, and modern/legacy provenance. The authoritative waiter must
settle or hand off once and no result branch may cast/default.

Passive/response-unworthy work remains owned by Task 3's policy-skip transition
and never reaches this runtime API. A transferred non-provider owner handle may
invoke `completeInboundWithoutOutboundForInstalledClaim` only for
the two closed non-provider receipts above. Each receipt is created by the
owning command/poller branch after its typed result proves no visible reply is
required, embeds the exact authority, and is checked at runtime against that
branch's bounded outcome registry; a plain object or cast is rejected. The
transaction validates receipt authority, current claim, and reason-specific
evidence, refuses to complete over an all-status terminal owner, and returns
`delivery_pending` if Reply Guarantee/provider reservation wins the race.
Inventory the production consumers for both reasons; a reason with no real
consumer is removed rather than retained speculatively. Add positive consumer
tests plus response-worthy provider empty, usage/rate suppression, visible local
command, full/visible poll, forged receipt, and stale-authority counterexamples.
Echo guard/dedup of user-visible content normally leaves Reply Guarantee armed
or returns its explicit suppression result; it is not silently translated to
no-output completion. Recovery does not manufacture a runtime processing claim:
Task 4's `completeInboundFromRecoveryTerminalOrThrow` and turn-done recovery
remain the sole startup owners for recovered turn-done/stored echo evidence.
Exact failed-op reconciliation maps `failed -> failed` and `echo_won -> complete`;
every other reconciliation result is translated explicitly, never cast.

Make outbound state monotonic exact-op CAS: `sending -> submitted|maybe_sent`, `submitted|maybe_sent -> echoed`, and no terminal/failure regression. `matchEcho` first requires a stored `messages.is_from_me=1` row, rejects duplicate `wa_message_id` matches as an invariant blocker, and completes only through the matched op's exact provenance. A forged/copied inbound message ID cannot correlate. Pre-stored echo, simultaneous echo/quarantine, duplicate callback, and attempt N/N+1 tests are mandatory.

Add provider-result accounting:

```ts
export interface ProviderResultAccounting {
  readonly providerAttemptId: string;
  readonly providerId: string;
  readonly agentSessionId: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ProviderAttemptUsageCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ProviderUsageAccountingResult =
  | {
      outcome: 'inserted' | 'advanced';
      committedDelta: Readonly<{ inputTokens: number; outputTokens: number }>;
    }
  | { outcome: 'duplicate' }
  | { outcome: 'cancelled' }
  | { outcome: 'stale_claim' };

export interface InstalledAgentTurnCapability extends InstalledAdmittedTurnCapability {
  readonly runtimeKind: 'agent';
}
```

The base capability is intentionally inert except for its canonical authority.
The Agent extension adds only a lane discriminator, which is still validated by
the private registry rather than trusted structurally. Partial usage and voice
creation live on the exact `ProviderAttemptOwnerHandle`; a retained/shared
capability cannot invent a provider attempt. Provider cancellation lives only on the dedicated RGP owner handle,
and admitted completion lives only on transferred queue/admin owner handles.
Direct raw-authority calls, a retained capability, a base capability cast to the
Agent extension, and cross-engine/cross-runtime capabilities must fail before
reservation, transport, checkpoint, waiter registration, cancellation, or
budget changes. Partial accounting remains claim-CAS guarded and cannot release
the barrier.

Assign a bounded immutable `providerAttemptId` and canonical `providerId` before each provider attempt;
every `token_usage` and final `result` callback for that attempt reuses it, while
a fallback attempt receives a different ID. Treat provider counts as cumulative
per attempt. Validate safe nonnegative counts/ID before SQL. In one immediate
transaction, require the exact registered provider-attempt owner and reject a newer
claim first, then insert the row or monotonically
advance its cumulative counts. Update only the referenced
`agent_sessions.total_input_tokens/total_output_tokens` row by the positive
delta from the stored ledger row and return that committed delta. A missing
session row, zero-row update, negative/non-safe stored total, or safe-integer
overflow is an invariant that rolls back the ledger change. There is no
message-total write in this contract. Identical counts are `duplicate`; a decrease,
session-ID/provider-ID mismatch, or conflicting claim/result reuse is an invariant and
latches bounded health. The SQLite transaction atomically updates only the token
ledger plus that persisted session aggregate; it cannot roll back the in-memory
`ProviderBudget`. On an RGP win AgentRuntime first fences visible provider output
in memory but leaves usage accounting admissible, then aborts/disposes the exact
attempt and proves turn-local cancellation or owned session replacement. If that
proof fails, no tombstone is written, late cumulative usage still accounts, and
the barrier remains held. Only after cancellation/disposal proof does the RGP
owner handle's private cancellation operation validate the exact terminal op and authority and, in one
serialized transaction, insert a zero-count row or mark the existing exact
attempt with the first immutable `cancelled_at`. A racing usage transaction
either commits its prior cumulative delta before the tombstone or observes the
tombstone and returns `cancelled`; usage is never silently discarded while the
provider remains live. A duplicate cancellation is idempotent;
session/claim/op mismatch is an invariant. After the tombstone commits,
AgentRuntime calls `ProviderBudget.cancelAttempt` and may release the barrier. A
tombstone write or budget-cancel failure keeps the blocker/barrier and is retried
without re-running transport. After accounting commit, refresh ProviderBudget from the DB-authoritative
completed aggregate (absolute replacement, not delta application). Replace the
old scalar pending count/`recordUsage` with attempt-aware methods:
`admitAttempt(providerAttemptId, metadata)`, `settleAttempt(providerAttemptId)`,
`cancelAttempt(providerAttemptId)`, and
`replaceCompletedUsageFromLedger(snapshot)`. Pending attempts are a bounded map
by immutable ID; settling/cancelling A removes only A and preserves concurrent
B. A bounded settled-ID set makes duplicate A a no-op and rejects metadata
mismatch. The absolute completed refresh never overwrites pending ownership.
Normal provider finalization calls `settleAttempt` only after its final ledger
transaction and absolute refresh succeed; a settle/metadata mismatch latches the
same admission blocker before N+1. Cancellation uses the separately ordered
tombstone path above. Startup rebuilds completed provider windows/totals by
grouping token attempts on persisted `source_provider_id` before readiness; the
session join proves only aggregate/session integrity and never supplies provider
identity. A primary→fallback crash/restart fixture rebuilds both canonical
provider budgets exactly once even when both attempts reference one session.
Prior-process pending attempts are not
pretended live and their inbound/outbound recovery remains the durability owner.
Cancelled rows contribute only their already-committed cumulative usage and are
never rebuilt as pending; their tombstone continues rejecting duplicate late
callbacks after restart.
A refresh failure latches budget health and blocks further provider admission
until rebuild; retry cannot double-apply or release another attempt. Remove every
parallel mid-turn DB/budget increment so this ledger is the sole completed-usage
owner. Add concurrent A/B, duplicate A result/cancel, mismatch, refresh-during-B,
crash/restart rebuild, and cap-boundary tests. `agent_token_events.timestamp` is the first
durable observation time for the provider attempt and remains unchanged by
cumulative advances; docs/metrics use that stable attribution.

An open exact claim or an already-terminal exact outbound op may authorize
provider accounting. The non-provider `no_outbound` lane forbids accounting;
provider empty/rate-suppressed turns record cumulative usage through the exact
attempt-owner accounting API while leaving their authority and Reply Guarantee
armed. If guard suppression, an existing terminal owner, or another
provider-output suppression prevents provider terminal reservation, the owner
finalization path internally calls `settleFinalUsageWithoutProviderTerminal`
with its final cumulative counts before it can return; callers cannot skip that
step. That accounting-only transaction is exact-
attempt/claim guarded and idempotent, updates ledger/session aggregate/budget,
but cannot checkpoint, complete inbound, release the user-turn barrier, or
invent terminal ownership. This
permits partial usage updates, crash recovery, and primary plus fallback usage once each without double-counting duplicate
`token_usage`/`result` events. Add sequences `5→8→8`, out-of-order `8→5`, result
without prior usage, duplicate result after restart, session mismatch, fallback
attempt, transaction rollback, and stale N→N+1. A stale claim changes no token
row, totals, budget, checkpoint, or newer inbound state.

- [ ] **Step 4: Make OutboundQueue and turn finalization exact and ordered**

Replace every remaining `setInboundSeq`, sequence FIFO, `getLastOpId`, `markLastTerminal`, mutable current-op, and latest-op completion dependency with the Task 5 `{claim,generation,turnCompletionId}` authority captured at enqueue time. `ITerminalOutboundQueue` exposes only:

```ts
const PREPARED_VOICE: unique symbol = Symbol('prepared-terminal-voice');

export interface PreparedTerminalVoice {
  readonly kind: 'voice';
  readonly authority: AdmittedTurnAuthority;
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly durationSeconds: number;
  readonly ptt: true;
  readonly [PREPARED_VOICE]: true;
}

interface ITerminalOutboundQueue {
  beginAdmittedTurn(
    binding: Extract<AdmittedRuntimeTurnBinding, { runtimeKind: 'agent' }>,
  ): AdmittedTerminalQueueTurn;
}

const TERMINAL_QUEUE_TURN: unique symbol = Symbol('terminal-queue-turn');

export interface AdmittedTerminalQueueTurn {
  readonly authority: AdmittedTurnAuthority;
  readonly [TERMINAL_QUEUE_TURN]: true;
  beginProviderAttempt(input: Readonly<{
    providerAttemptId: string;
    providerId: string;
    agentSessionId: number;
    outputMode: 'batch' | 'minimal';
  }>): ProviderAttemptOwnerHandle;
  beginAgentNonProviderTerminalOwner(
    receipt: AgentNonProviderBranchReceipt,
  ): AgentNonProviderTerminalOwnerHandle;
}

const AGENT_NON_PROVIDER_BRANCH: unique symbol = Symbol('agent-non-provider-branch');
interface AgentNonProviderBranchReceipt {
  readonly source: 'local_command' | 'policy_notice';
  readonly [AGENT_NON_PROVIDER_BRANCH]: true;
}

const PROVIDER_TERMINAL_OWNER: unique symbol = Symbol('provider-terminal-owner');
interface ProviderAttemptOwnerBase {
  readonly [PROVIDER_TERMINAL_OWNER]: true;
  readonly outputMode: 'batch' | 'minimal';
  recordUsageCumulative(input: {
    counts: ProviderAttemptUsageCounts;
  }): ProviderUsageAccountingResult;
  settleFinalUsageWithoutProviderTerminal(input: {
    counts: ProviderAttemptUsageCounts;
    reason:
      | 'echo_guard_suppressed'
      | 'existing_terminal'
      | 'provider_output_suppressed'
      | 'empty_content';
  }): ProviderUsageAccountingResult;
  abandonUnsentBufferForFallback(): void;
  prepareTerminalVoice(input: {
    buffer: Buffer;
    mimeType: string;
    durationSeconds: number;
    ptt: true;
  }): PreparedTerminalVoice;
}

export interface ProviderBatchAttemptOwnerHandle extends ProviderAttemptOwnerBase {
  readonly outputMode: 'batch';
  enqueueAssistantContent(input: { text: string }): Promise<void>;
  finishProviderTurn(input: {
    completion: ProviderTerminalFinalizationInput;
    voice?: PreparedTerminalVoice;
  }): Promise<InstalledTurnCompletionResult>;
}

export interface ProviderMinimalAttemptOwnerHandle extends ProviderAttemptOwnerBase {
  readonly outputMode: 'minimal';
  bufferMinimalCandidate(input: { text: string }): Promise<PreparedMinimalCandidate>;
  promoteMinimalAndFinish(input: {
    candidate: PreparedMinimalCandidate;
    completion: ProviderTerminalFinalizationInput;
    voice?: PreparedTerminalVoice;
  }): Promise<InstalledTurnCompletionResult>;
}

export type ProviderAttemptOwnerHandle =
  | ProviderBatchAttemptOwnerHandle
  | ProviderMinimalAttemptOwnerHandle;

const PREPARED_MINIMAL_CANDIDATE: unique symbol = Symbol('prepared-minimal-candidate');
interface PreparedMinimalCandidate {
  readonly [PREPARED_MINIMAL_CANDIDATE]: true;
}

const AGENT_NON_PROVIDER_OWNER: unique symbol = Symbol('agent-non-provider-owner');
export interface AgentNonProviderTerminalOwnerHandle {
  readonly [AGENT_NON_PROVIDER_OWNER]: true;
  enqueueCommandReply(input: { text: string }): Promise<void>;
  finishVisibleOrNoOutbound(
    input: AgentNonProviderFinalizationInput,
  ): Promise<InstalledTurnCompletionResult>;
}

interface BaseNonProviderTerminalOwnerHandle {
  enqueueVisibleContent(input: { text: string }): Promise<void>;
  finishVisibleOrNoOutbound(
    input: InstalledBaseCompleteTurnInput,
  ): Promise<InstalledTurnCompletionResult>;
}

const REPLY_GUARANTEE_OWNER: unique symbol = Symbol('reply-guarantee-owner');
// Constructed only inside createReplyGuaranteeTrackedSender through a
// coordinator factory token; never selectable from a public string.
export interface ReplyGuaranteeTerminalOwnerHandle {
  readonly [REPLY_GUARANTEE_OWNER]: true;
  sendInterruptionAndFinalize(input: {
    text: string;
    expectedTarget: Readonly<{ conversationKey: string; chatJid: string }>;
    now: number;
  }): Promise<ReplyGuaranteeTerminalResult>;
}

const REPLY_GUARANTEE_OWNER_FACTORY: unique symbol = Symbol('reply-guarantee-owner-factory');
export interface ReplyGuaranteeOwnerFactory {
  readonly [REPLY_GUARANTEE_OWNER_FACTORY]: true;
  acquire(authority: AdmittedTurnAuthority): ReplyGuaranteeTerminalOwnerHandle;
}
```

ChatQueue and the core-admin owner expose only the analogous private
`BaseNonProviderTerminalOwnerHandle` after their dispatcher lease transfers;
they do not receive an Agent queue handle, provider factory, checkpoint writer,
or RGP factory. All four handle families are backed by private WeakMap registry
entries, not their structural TypeScript brands. Retained capability,
wrong-owner, copied-handle, fake-RGP string/cast, cross-queue, and post-N+1 tests
must fail before target read, SQL, hook, transport, waiter, checkpoint, or
cancellation.
The Agent non-provider factory additionally consumes an unforgeable
`AgentNonProviderBranchReceipt` minted only by the inventoried local-command or
policy-notice classifier after its bounded outcome is known; a provider result
callback cannot select that lane by string or cast.

`ProviderAttemptOwnerHandle.enqueueAssistantContent` and the Agent/base
non-provider owner content methods are nonterminal-only and cannot return a
terminal receipt. The generic turn handle exposes no content enqueue at all.
They place bounded text in their exact attempt/owner-scoped buffers and perform
no journal or transport. On final
provider/local completion, the owner transaction reserves every buffered text
item together, marks the greatest non-voice text terminal, persists
accounting/checkpoint/waiter state, and only then transports the batch in order.
Provider chunks cannot bypass the attempt handle. A failed/superseded provider
attempt calls `abandonUnsentBufferForFallback()` before the new fallback handle
is created; it destroys only that unsent attempt buffer and cannot affect the
new one. This intentionally trades visible token streaming for crash-safe terminal
ownership; soft presence remains Task 7's liveness surface. Item count and UTF-8
bytes are bounded; overflow becomes a durable runtime failure/Reply Guarantee
path, never partial transport. Minimal mode uses its attempt owner's
`bufferMinimalCandidate` in the same private in-memory registry. No public/cast
caller can label content `reply_guarantee`, terminal, or voice.

If a provider result has no nonempty buffered text (including voice-only), it
cannot call either terminal finalizer. The attempt owner records final cumulative
usage through `settleFinalUsageWithoutProviderTerminal(reason:'empty_content')`,
discards any prepared voice, creates no op/finalization marker/waiter, invokes no
terminal hook or transport, and leaves Reply Guarantee plus the user-turn
barrier armed. Add batch/minimal empty, whitespace-only, and voice-only tests,
including result-without-prior-usage; a cast that sends voice or reserves a
terminal without text must fail before SQL/transport.

`beginProviderAttempt` runs before provider launch, validates canonical provider
metadata plus the immutable `batch|minimal` output mode, and returns the sole
discriminated handle for that immutable attempt. The private registry rejects a
cast that calls a batch method on minimal mode or vice versa. All
`token_usage` updates, final result accounting, voice preparation, terminal
reservation/promotion, and accounting-only settlement after guard suppression
or an existing-terminal loss reuse that handle. Each fallback receives a new
handle; the final callback never creates or looks up one after an await. The RGP
owner derives its pending checkpoint internally from the installed exact turn;
no caller supplies checkpoint fields. Its public method returns only Task 7's
prompt proof/result after ownership is installed, while the coordinator retains
the separate authoritative completion-barrier promise internally.
Add primary-partial→fallback proof that only fallback text is reserved/sent,
wrong/stale-attempt enqueue/finish failures, and normal-buffer crash before
finalization with zero op/transport; a stable-policy below-ceiling fixture then
produces exactly one replay-owned reply.
Add cross-mode compile/runtime negatives and a fallback whose mode changes.
After a process crash, both buffer modes disappear with zero old outbound row,
waiter, checkpoint marker, or transport. Startup applies the existing exact
inbound recovery contract: below the shared attempt ceiling it defers/replays
only after current-policy revalidation; at the ceiling it becomes
`failed/crash_recovery` with zero send; and changed policy may skip/fail/defer as
that policy dictates but can never revive the old buffer. Test all three states
for batch and minimal modes and assert no stale buffer/pending accumulation.

`beginAdmittedTurn` atomically installs and freezes the already-created Task 8
binding, identity-checking `binding.authority === binding.capability.authority`
and the Agent lane/engine before publishing it to the queue. It consumes the
dispatcher lease and returns a branded closure-bound turn handle that privately
captures the resulting queue-owner lease. All enqueue/owner-factory/finish operations
exist only on that handle and validate the retained lease/current queue owner;
they accept no repeat authority or owner token. It does not mint symbols, accept
a bare claim, or support a later capability setter. A second different object for the
same tuple is an invariant, even if its fields look equal. Every
callback captures this exact handle before its first await. Queue/admin abort is
an internal coordinator operation carrying that owner lease, not an exported
handle method. A handle retained after finish, passed to another queue, copied by cast, or used after N+1
must fail before reservation/send/finalization; add those owner-lease tests.
`ProviderAttemptOwnerHandle.finishProviderTurn` is the only typed voice ingress. It validates a successful
attempt-owner-created artifact's private WeakMap/token identity, bounded nonempty
buffer, canonical MIME type, safe nonnegative duration, and exact canonical
authority/generation, then adds one auxiliary `voice` item
to the same private batch before reservation. There is no `enqueueVoice`, media
bridge post-terminal insertion, or voice-only terminal path. Compile-negative
and runtime tests reject voice on any other method, forged/late artifacts,
duplicate voice, attempt-N voice supplied to N+1, and a finish call after
terminal ownership. The exact provider-attempt owner exposes the sole
`prepareTerminalVoice(rawSynthesisResult)` constructor; the descriptor type is
exported only for type-only handoff, while its unique-symbol brand value,
constructor, and WeakMap remain unexported.
The final provider-result callback calls
`beginProviderAttempt({providerAttemptId,providerId,agentSessionId})` before
provider launch and reuses it in the final callback; every usage/finalization
value must match that frozen metadata. It
uses only the returned closure-bound handle. The queue privately validates and
consumes its provider permit before batch reservation. Agent local/non-provider
paths use their separately branded handle. Reply Guarantee is absent from this
interface entirely and receives its owner only through the private coordinator
factory in Step 5. A stale/missing/wrong-kind/copied handle cannot finish a
provider batch, and provider attempt identity cannot be inferred from the
current session after an await.
chunk/progress/tool callback captures the immutable authority before its first
await. Items from different generations never coalesce. Terminal ownership is
reserved synchronously at the start of the provider result callback before
another event can install N+1. Batch transport follows enqueue ordinal, updates
exact op IDs, and returns the receipt; terminality is never marked after
transport. Add a compile-negative bare-claim case and a runtime cast case whose
reminted symbols cannot reserve, send, settle, disarm, or release the original
turn.

Once a terminal batch commits, its transport loop owns every reserved item and
attempts them in enqueue-ordinal order even if an earlier item throws. A
transport throw is ambiguous: transition that exact item from `sending` to
`maybe_sent`, retain the bounded error class, and continue to the next reserved
item so the terminal row cannot be stranded unstarted behind an auxiliary
failure. A successful submission transitions only that exact ID to `submitted`;
pre-stored echo may advance it to `echoed`. After every item has a settled
transport disposition, return the receipt from the exact terminal op. Shutdown
awaits this loop. A journal-transition failure after a transport call latches the
runtime/DB blocker and holds shutdown until the process hard deadline; startup
quarantine owns any surviving `sending` row, and no false inline outcome is
claimed. Add first/middle assistant/voice throw and ambiguity, terminal still
submitted/maybe-sent, held terminal transport, transition-write fault, orderly
shutdown, forced-exit, and restart-quarantine tests. Mutating the loop to break
on the first auxiliary failure must leave the terminal row `sending` and make the
test RED.

Add an exact per-turn completion barrier to TurnQueue/AgentRuntime. `SessionManager.sendTurn()` resolving after stdin write is not turn completion. The user-turn queue remains owned by `{claim,generation,turnCompletionId}` until an exact provider final result/final failure, typed local/no-output completion, or Reply Guarantee terminal disposition durably settles it. Provider callbacks additionally match their `providerAttemptId`; no provider callback alone is the universal barrier key. System-result events and stale callbacks cannot release it. Shared/single use one ordered barrier; per-chat uses one per canonical chat key.

Define a single exact-op disposition registry internally owned by
`DurabilityEngine` and reachable only through transferred owner-handle private
methods:

```ts
export type TerminalDisposition =
  | { outcome: 'echoed'; outboundOpId: number }
  | { outcome: 'failed'; outboundOpId: number; status: 'quarantined' | 'failed_permanent' }
  | { outcome: 'ownership_lost' }
  | { outcome: 'shutdown_handoff'; outboundOpId: number };

// Private method on an owner handle; authority and owner lease are closure-bound.
awaitTerminalDispositionForOwner(input: {
  terminalOpId: number;
}): Promise<TerminalDisposition>;
```

Registration first reads the exact op and its claim provenance in the same
serialized durability boundary so a pre-stored echo/failure cannot be missed.
After commit, only exact-op `matchEcho`, quarantine, or permanent-failure
transitions notify the registry; sequence-level or latest-op notifications are
forbidden. Each notifier proves the op's sequence/route/attempt equals the
authority before settling one waiter. `submitted`/`maybe_sent` and
`existing_terminal` receipts therefore keep the user-turn barrier held until
that exact op echoes or fails. A bounded health gauge exposes unresolved
waiters; ordinary runtime timeout never converts them to success or failure.
No installed capability exposes this method or can register a waiter.

Task 8 replaces Task 6's monolithic `runtime.shutdown()` with a proof-carrying
split lifecycle:

```ts
const REMOTE_WAITER_TRANSFER: unique symbol = Symbol('remote-waiter-transfer');
export interface RemoteWaiterTransferHandle {
  readonly [REMOTE_WAITER_TRANSFER]: true;
}

const RUNTIME_STOPPED_PROOF: unique symbol = Symbol('runtime-stopped-proof');
export interface RuntimeStoppedProof {
  readonly [RUNTIME_STOPPED_PROOF]: true;
}

const ADMITTED_TURN_SHUTDOWN_TRANSFER: unique symbol = Symbol('admitted-turn-shutdown-transfer');
export interface AdmittedTurnShutdownTransfer {
  readonly [ADMITTED_TURN_SHUTDOWN_TRANSFER]: true;
  transferRemoteOwner(owner: RemoteWaiterTransferHandle): void;
  finishRuntimeStop(): RuntimeStoppedProof;
}

export type RuntimeShutdownFailureClass =
  | 'queue_drain_failed'
  | 'local_transport_unsettled'
  | 'owner_transfer_failed'
  | 'runtime_stop_latch_failed'
  | 'unknown_runtime_shutdown_failure';

export type RuntimeShutdownLocalDrainResult =
  | {
      outcome: 'local_settled';
      runtimeStopped: true;
      transferredRemoteWaiters: number;
      stoppedProof: RuntimeStoppedProof; // opaque type-only handoff
    }
  | {
      outcome: 'local_settlement_unproven';
      runtimeStopped: false;
      failureClass: RuntimeShutdownFailureClass;
    };

export type AdmittedTurnHandoffResult =
  | { outcome: 'drained'; remainingOwners: 0 }
  | {
      outcome: 'handoff_unproven';
      failureClass:
        | 'remote_owner_reread_failed'
        | 'remote_owner_settlement_failed'
        | 'coordinator_not_empty'
        | 'unknown_handoff_failure';
    };

interface Runtime {
  prepareShutdown(): void;
  drainLocalAndLatchStopped(
    transfer: AdmittedTurnShutdownTransfer,
  ): Promise<RuntimeShutdownLocalDrainResult>;
  finalizeShutdown(): Promise<void>;
}
```

Update Task 6's source-order/behavior test in this same commit to assert
`prepareShutdown → drainLocalAndLatchStopped → proven handoff/drain →
runtime_finalize → proven transport close → stopping-gate detach → DB`, and
remove its intermediate raw `runShutdownPhase('runtime', runtime.shutdown)`
expectation.

All brand values, constructors, coordinator IDs, and WeakMaps for
`RemoteWaiterTransferHandle`, `RuntimeStoppedProof`,
`AdmittedTurnShutdownTransfer`, `ReplyGuaranteeOwnerFactory`, and RGP/terminal
owner handles live in `src/core/admitted-turn.ts` and are not exported. Only
their interfaces are exported for type handoff. Runtimes import those types and
receive concrete closures from main/coordinator; `admitted-turn.ts` never
imports a runtime implementation. Every operation validates object identity and
originating coordinator in its WeakMap. Add compile/runtime forged,
field-copied, cross-coordinator, replayed-proof, and wrong-engine negatives.

At the synchronous stopping boundary,
`admittedTurnCoordinator.quiesceNewInstalls()` rejects only new dispatcher
installs/initial queue transfers and `runtime.prepareShutdown()` rejects new queue
admission. Already-transferred queue/admin owner handles remain fully operative
and the dedicated shutdown-transfer channel remains open;
so accepted-but-not-started work can reserve, send, persist finalization, and
settle during the local drain. `drainLocalAndLatchStopped` waits for every local
reservation/transport/finalization owner. A `sending` op or active transport
promise is local and cannot transfer. Once an exact owner has locally settled to
`submitted|maybe_sent` and waits only for remote disposition, the runtime
atomically transfers **both** its exact waiter and queue/admin owner lease to
`AdmittedTurnCoordinator` through the opaque `AdmittedTurnShutdownTransfer`;
only a successful transfer releases the runtime queue barrier. After all local
owners settle or transfer, the runtime irreversibly rejects further old-handle
operations, latches stopped, and returns its opaque proof. The method catches
and exhaustively maps internal errors to the closed union; an unexpected
rejection is `local_settlement_unproven` and never fabricates proof.

Main does not wrap that critical result in continue-all `runShutdownPhase`:

```ts
admittedTurnCoordinator.quiesceNewInstalls();
runtime.prepareShutdown();
const runtimeDrain = await runtime.drainLocalAndLatchStopped(
  admittedTurnCoordinator.shutdownTransfer(),
);
if (runtimeDrain.outcome !== 'local_settled') {
  retainShutdownFailure('runtime_local', runtimeDrain.failureClass);
  await awaitProcessHardDeadlineAndForceExit();
} else {
  const handoff = await admittedTurnCoordinator.handoffAndDrainTransferredOwners(
    runtimeDrain.stoppedProof,
  );
  if (handoff.outcome !== 'drained') {
    retainShutdownFailure('admitted_turn_handoff', handoff.failureClass);
    await awaitProcessHardDeadlineAndForceExit();
  } else {
    await runShutdownPhase('runtime_finalize', () => runtime.finalizeShutdown());
    const transportOutcome = await runTransportShutdownPhase(connectionManager);
    // Continue to Task 6's stopping-gate detach/startup-settlement/DB close only
    // when transportOutcome.deliveryClosed is true.
  }
}
```

`handoffAndDrainTransferredOwners` validates the unforgeable stopped proof and
that every local owner is settled before rereading exact remote ops. Calling it
before the proof, twice, or after transport/DB teardown is an invariant. It
returns `drained` only after every transferred waiter and owner lease has been
handed off/settled and the coordinator registry is exactly zero. A failure or
unexpected rejection maps to `handoff_unproven`; main retains provider sessions,
WhatsApp transport, stopping ingress/callback, and DB until forced exit. It never
continues through a generic continue-all phase.
`runtime.finalizeShutdown()` performs provider-session/socket disposal only
after handoff; its stopped latch prevents any late callback from reserving,
sending, or writing even if final disposal reports a retained failure. Add
queued-at-SIGTERM, post-quiesce-new-install, post-stop-old-handle, source-order,
held local transport, exact remote-owner transfer, runtime rejection before and
after local settlement, handoff failure before and after one remote settlement,
coordinator-nonzero, and session-finalize tests. For submitted/no-echo,
runtime drain must resolve with exactly one coordinator-owned lease, handoff
settles it once, final teardown follows, and DB close remains last. For `sending`,
runtime drain stays pending; an unproven outcome keeps runtime sessions,
transport, stopping ingress, callback, and DB intact until forced exit.

No new SQLite status is invented: the exact persisted `submitted|maybe_sent`
row plus claim provenance is the durable handoff record already consumed by
startup recovery/quarantine. The process cannot resume after detaching the
waiter. The inbound remains open; shutdown does not complete, fail, resend,
or delete it. Only then may transport/session and DB teardown proceed. A `sending` op whose
transport promise has not settled is not eligible for handoff and keeps orderly
shutdown pending; if the sole process hard deadline fires, it performs forced
exit only and runs no handoff callback/write. Forced exit leaves its durable
state for startup quarantine. Test pre-stored disposition, exact echo and exact
failure, foreign-op notification, registration race, submitted shutdown
handoff, held sending transport, DB-close ordering, and restart reconciliation.

Ordinary callers cannot abort or detach this sole waiter. Owner-handle finish
accepts no `AbortSignal`; its internally retained promise settles only from an
exact durable disposition or the coordinator's proven stopped-runtime handoff.
Install/transfer quiesce does not disable operations on existing owner handles;
the irreversible stopped latch does, but only after every local owner settled or
transferred. Add pre-wait abort attempts, dropped promises, mid-wait shutdown,
shutdown-before-registration, queued-before-quiesce, and shutdown-during-wait
tests proving no barrier release, orphaned registry entry, invented cancellation
result, or stranded accepted item.

Provider failure that schedules fallback retains the same full authority/barrier and creates a new provider-attempt ID. Per-chat code must not shift the claim before deciding fallback. It neither pops/re-enqueues nor remints ownership. Final fallback success settles only through its tracked terminal receipt. Final fallback failure is never provider no-output: record any cumulative usage, keep Reply Guarantee and the barrier armed, and require a tracked terminal failure notice or RGP ownership; if neither can settle, remain blocked for recovery/shutdown rather than releasing the turn.

Minimal mode is the `ProviderAttemptOwnerHandle.promoteMinimalAndFinish`
variant of the sole owner-handle reservation/finalization transaction, not a
second SQL primitive. `bufferMinimalCandidate` first captures the candidate as
private bounded in-memory content and does not journal or start transport; its
opaque WeakMap proof binds the buffer entry, generation, and attempt. The
provider owner selects that greatest buffered `assistant_content` candidate and
calls promotion **before** any final-candidate transport. The transaction
consumes the proof, revalidates current claim/attempt/target and terminal-owner
absence, inserts the candidate directly as the sole terminal `sending` row,
persists final accounting plus the derived pending checkpoint/finalization
record, and registers the same exact receipt/waiter data. After commit it invokes the
same synchronous `onTerminalReserved` hook and only then launches transport. It
never accepts an already-journaled/transported auxiliary op, progress/status,
another generation, or another inbound; legacy auxiliary rows remain
recovery/blocker inputs. A crash before promotion leaves no op and sends
nothing; startup follows the shared qualified buffer-crash contract above
(stable below-cap may replay once, at-cap or changed-policy cases send zero).
Reply Guarantee and promotion race through the same owner
transaction; one owner wins and the loser performs no hook/send/finalization.
Add every candidate kind, forged/consumed proof, stale registry/attempt,
no-candidate, crash after buffer before promotion (zero old transport/op; stable
below-cap one replay, cap/policy cases zero; no pending accumulation),
two-connection, held
promotion/transport, hook failure/recovery, N+1, and RGP win/loss test.

Define separate closure-bound base/Agent inputs rather than a loose
authority/reason/op bag:

```ts
export type InstalledBaseCompleteTurnInput =
  | {
      mode: 'visible_terminal';
      completion?: never;
    }
  | {
      mode: 'no_outbound';
      completion: NoOutboundCompletion;
    };

export interface AgentTurnCheckpointInput {
  readonly checkpoint: Readonly<{
    fields: Omit<
      SessionCheckpointFields,
      'activeTurnId' | 'lastInboundSeq' | 'lastFlushedOutboundId' | 'watchdogState'
    >;
  }>;
}

export interface ProviderTerminalFinalizationInput extends AgentTurnCheckpointInput {
  readonly counts: ProviderAttemptUsageCounts;
}

export type AgentNonProviderFinalizationInput = AgentTurnCheckpointInput & (
  | { mode: 'visible_terminal'; completion?: never }
  | { mode: 'no_outbound'; completion: NoOutboundCompletion }
);

export interface CompleteSystemTurnParams {
  readonly systemAttemptId: string;
  readonly accounting?: Omit<ProviderResultAccounting, 'providerAttemptId'>;
  readonly checkpoint: Readonly<{
    conversationKey: string;
    fields: Pick<
      SessionCheckpointFields,
      'sessionId' | 'transcriptPath' | 'workspacePath' | 'claudePid' | 'sessionStatus'
    >;
  }>;
}
```

For every transferred owner-handle finalization, the handle creates the internal
terminal receipt itself; callers never pass or replay one. Require every
no-output evidence object to carry the handle's same canonical authority object identity before work;
field-equal reminted symbols are rejected. The base method is checkpoint-free,
forbids provider/accounting inputs at compile time and runtime, and serves
Chat/core-admin visible or typed-silent outcomes. The Agent provider,
non-provider, and RGP owner handles alone accept
the typed provider/non-provider finalization inputs and session
checkpoint/accounting.
Classify the claim before token/checkpoint writes
and derive the checkpoint key only from that exact inbound row's persisted
`conversation_key`. The separate claimless `completeSystemTurn` validates and uses its explicit key; it
cannot borrow an admitted authority or inferred current chat, and its narrow
allowlist cannot write `activeTurnId`, `lastInboundSeq`,
`lastFlushedOutboundId`, or `watchdogState`. The concurrent-system-result test
starts an admitted turn, applies a system checkpoint, and proves all four
admitted lifecycle columns remain byte-for-byte unchanged.
`activeTurnId`, `lastInboundSeq`, `lastFlushedOutboundId`, and `watchdogState` are derived inside
the transaction from the exact authority, receipt/disposition, and lifecycle
outcome; callers cannot provide them. A compile-negative fixture and a
cast-around runtime mismatch test prove fabricated checkpoint ownership blocks
before accounting, checkpoint, inbound mutation, or barrier release. Provider terminal
requires accounting; non-provider local/policy/RGP completion forbids it.
Duplicate/cumulative callbacks apply monotonic accounting deltas; distinct
fallback attempt IDs remain countable. Every `existing_terminal`,
`inbound_closed`, `stale_claim`, `none`, submitted/ambiguous, and failed-op
branch is exhaustive before checkpoint/barrier release and mutation-tested.

The owner handles share one private admitted finalization coordinator and are
its only admitted entry points. Partial provider usage callbacks use a
ledger/session-aggregate-only immediate transaction and cannot touch checkpoint,
inbound outcome, receipt disposition, or barrier. A final provider result has no
post-transport accounting window: the provider owner passes its final cumulative
accounting and checkpoint into the sole reservation/promotion transaction. That
transaction first revalidates the exact owner/attempt, then atomically reserves
or promotes the terminal op, applies the last cumulative ledger delta, updates
the exact session aggregate, and persists the concrete Agent finalization marker
in the existing `session_checkpoints` row selected from the inbound's persisted
conversation: `active_turn_id` derived only by its existing persisted session
semantics, exact `last_inbound_seq`, `last_flushed_outbound_id=terminalOpId`, and fixed
`watchdog_state='awaiting_terminal_echo'`, while preserving unrelated fields,
before
`onTerminalReserved` or any transport. Result-without-prior-usage is therefore
durable at reservation. The transaction also installs all durable data needed
for exact echo/failure finalization; an in-memory waiter is registered from its
exact safe op ID before the owner can return.

Task 8 extends the earlier `matchEcho` SSOT rather than adding a waiter-side DB
transition. For an installed finalization record, the serialized exact
`matchEcho` transaction requires that exact checkpoint marker plus stored self
echo and op provenance, CASes
that op to `echoed`, applies the persisted derived final checkpoint, and closes
the same inbound atomically; exact quarantine/permanent failure analogously
applies the persisted failure checkpoint and fails the inbound. It notifies the
waiter only after commit, and that notifier merely releases the owner/barrier—it
performs no second checkpoint or inbound write. When no installed record exists,
the explicitly separate Task 3/recovery exact-op path applies. A pre-stored echo
is detected inside the reservation transaction and completes through the same
persisted data before transport. Non-provider visible and sealed no-output owner
paths atomically write their derived checkpoint plus inbound outcome without
provider accounting. Chat/admin have no Agent checkpoint marker; their exact
terminal op plus inbound tuple is the complete persisted intent. A mismatched or
missing Agent marker is `blocked_evidence`, never guessed from the current
session. Add concurrent claimless system-checkpoint writes and mismatched-marker
restart tests proving unrelated fields survive and the admitted marker cannot be
borrowed or overwritten.
The process-local `turnCompletionId` symbol is never serialized; durable
route/attempt authority comes from the inbound/outbound join.

Any SQL/invariant failure rolls back every member of its transaction and leaves
the barrier held. The post-commit absolute ProviderBudget refresh runs before
N+1 admission; failure latches budget health and closes provider admission
without undoing the durable ledger/finalization record. Add fault injection
between every write, echo-CAS→checkpoint/inbound faults, pre-stored/fast echo,
crash after reserve, after each batch transport, after receipt but before owner
return, primary→fallback with no prior `token_usage`, restart budget/checkpoint
rebuild, exact-op disposition races, and budget-refresh failure. No checkpoint-
only, completion-only, accounting-only final transaction, lost final usage, or
N+1 admission is allowed.

Provider `empty_content` or a suppressed usage/rate-limit notice is never a
no-outbound completion for a response-worthy admitted turn. Record any usage
cumulatively, keep the exact authority/barrier and Reply Guarantee armed, and
let a tracked terminal notice or explicit policy outcome settle it. The only
no-outbound reasons are the closed non-provider inventory above, whose owning
policy test proves visible response was not required. Add response-worthy empty,
tool-only empty, rate-limit suppression, and non-response policy counterexamples.

System-result events use the explicit claimless lane, never release an admitted
turn barrier, and write system token rows with all inbound claim/result
provenance null but the canonical provider ID present. Migrated legacy rows may
retain a null provider ID and are explicitly excluded/flagged as unattributable
instead of guessed.
They dedupe only within the current boot by bounded `systemAttemptId`; provider
callbacks cannot survive process restart, and no cross-restart idempotency is
claimed for this non-admitted lane. Duplicate current-boot system callbacks are
no-ops; ID/metadata mismatch is an invariant. Add system-with/without-accounting,
duplicate, concurrent user turn, and restart-boundary tests.

- [ ] **Step 5: Integrate Reply Guarantee, provider output, commands, fallback, and voice**

Replace Task 7's fixed-error hard sender with:

```ts
createReplyGuaranteeTrackedSender(input: {
  acquireReplyGuaranteeOwner: ReplyGuaranteeOwnerFactory;
}): ReplyGuaranteeTerminalSender;
```

The factory resolves the exact active `{claim,generation,turnCompletionId}`
authority and obtains a dedicated `ReplyGuaranteeTerminalOwnerHandle` through
the unexported, WeakMap-validated `ReplyGuaranteeOwnerFactory`; neither the
generic queue handle nor installed capability can call or imitate that factory.
The owner binds the `src/core/echo-guard.ts` SSOT and performs this order
internally: mint its private RGP permit while atomically capturing the exact competing provider attempt;
prepare the
opaque exact DB target; compare both fields to the manager-resolved
`input.transportTarget`; atomically acquire a group-guard permit for that target;
reserve with the same target proof in the SQL predicate; invoke the synchronous
exact-authority `onTerminalReserved`; commit the guard permit; then begin
transport. Guard lookup never uses a caller/chat target. A target/alias change
between prepare, guard, and INSERT releases the pending permit, creates no op or
send, and latches the invariant. Any suppressed/failed pre-reservation path
consumes/releases both owner and guard permits so neither can be replayed. Add same-JID/wrong-conversation, wrong-JID, and
alias-change-at-each-boundary tests. Guard suppression returns
`{proof:'not_sent',reason:'echo_guard_suppressed',retryAfterMs}` with no
op/send/rate timestamp. A reserved/echoed op returns the exact
`outboundOpId` with `echoed`; submitted returns that exact ID with
`awaiting_echo`; transport ambiguity or existing terminal returns that exact ID
for reconciliation; closed/stale returns the corresponding losing proof. It
never calls `Messenger` directly and never resolves an op through the current
chat or latest-op state.

The RGP owner persists its authority-derived pending Agent checkpoint,
terminal finalization record, exact waiter registration data, and any proven
provider-cancellation tombstone before transport. It then retains the queue
owner lease and waiter internally until exact echo/failure or shutdown handoff,
even if `onHardTimeout` or another caller drops the returned promise/result.
Immediate echo completes through the one `matchEcho` transaction; submitted or
ambiguous delivery returns a public proof only after that internal ownership is
installed. Task 7 may retire its timer generation after the sender returns
because ownership has transferred, but it never treats timer retirement as turn
completion. Add immediate/delayed echo, deliberately dropped result, checkpoint
fault, cancellation fault, and shutdown-handoff tests with exact registry/lease
counts; no branch may orphan the inbound or release N+1 early.

The Task 7 manager target remains a defense-in-depth snapshot, not transport
authority. A conversation or JID mismatch with the freshly prepared DB target
blocks before guard/reservation and produces no op/rate/send; only the
capability-prepared/returned DB target reaches transport.

Adapt the existing `canSendToGroup`/`recordGroupOutbound` implementation into
one `GroupEchoGuard` owner in `src/core/echo-guard.ts`. That module exports only
an acyclic `EchoGuardTarget = Readonly<{conversationKey:string;chatJid:string}>`
contract; the owner handle privately validates the opaque proof, then passes its
immutable `transportTarget` value to `tryReserve(target, now)`. The guard never
sees or exports `PreparedTerminalTarget`. `tryReserve` atomically returns either an opaque pending
permit or a suppressed result with a safe timer-range `retryAfterMs`;
`commit(permit)` records the conservative outbound timestamp only after journal
reservation and `onTerminalReserved` succeed, while `release(permit)` records
nothing. Permits are identity-bound, bounded, single-use, and drained on
shutdown. Provider output and RGP share this exact owner. Add concurrency,
suppression, invalid retry-after/clock, commit/release, wrong-target, duplicate
permit, ambiguous transport, and restart-reset tests in
`tests/core/echo-guard.test.ts`.
Add a compile-boundary test proving `echo-guard.ts` cannot import or construct
the owner handle's private target proof.

The Agent install supplies
`onTerminalReserved({authority,terminalOpId,ownerKind,providerAttemptId})`. The
provider-result path supplies its own exact active attempt ID; the RGP path
captures the exact competing active attempt ID at reservation time; non-provider
uses null. The hook validates that ID against the installed turn before any
fence/cancel action. The private owner finalization coordinator calls it
synchronously after the reservation transaction commits and before guard commit
or any transport await. It immediately fences provider visible output and
records exact terminal ownership in the Agent turn state. A thrown/mismatched
hook latches the admitted-pipeline blocker, leaves the exact journal row for
recovery, releases the uncommitted guard permit, starts no transport, and keeps
the turn barrier. Race tests release a late provider chunk at every boundary and
prove nothing can escape after the hook.
Add stale/wrong/missing attempt-ID cases: provider-owned output must not
self-cancel, while RGP must tombstone/cancel exactly the matched active attempt
and no other fallback/next-turn attempt.

Provider finalization and Reply Guarantee use the same terminal reservation. If
provider wins, RGP sees existing ownership and sends nothing. If RGP wins,
AgentRuntime synchronously marks the full authority terminal-owned and fences
every callback by both authority and `providerAttemptId`. It aborts/disposes the
exact provider attempt; for a shared/single CLI session that cannot prove
turn-local cancellation, it terminates and replaces that owned session rather
than reusing it. After cancellation/session-disposal proof, the runtime persists
the exact cancellation tombstone and then calls
`ProviderBudget.cancelAttempt(providerAttemptId)`; all three settle before
releasing the user-turn barrier. If cancellation cannot be proved, the barrier remains
held even after RGP echo, so turn N+1 cannot interleave with the old provider
stream. The accounting cancellation fence is persisted, but provider-process
settlement is not: an echoed RGP op does **not** qualify for the
submitted/maybe-sent outbound handoff above;
graceful shutdown remains blocked until the provider promise/session disposal
settles. If the process hard deadline wins, forced exit is the only fallback and
the next boot reconciles the already-durable exact RGP op without reviving the
old provider callback. Unsent chunks,
notices, command output, and voice items are discarded. A late provider callback
cannot borrow the RGP op as its receipt; usage callbacks remain permitted to
account until proven cancellation, then observe the tombstone and cannot account again or create a
follow-up lifecycle. Test held provider → RGP echo → attempted N+1 in
shared, single, and per-chat scopes, plus cancellation failure, late result,
budget cancellation, session replacement, graceful-shutdown blockage, hard-exit
receipt, and next-boot reconciliation.

Inventory every local command. Arm RGP and install exact queue ownership before classification. Each command returns exactly one of `forwarded`, typed `silent`, or tracked terminal receipt. Visible `/status`, `/help`, `/sessions`, `/kill-session`, routing, error, and `/new` replies use the exact terminal queue; admitted `sendDirect` is forbidden. `/model default` may reserve a claim-linked nonterminal acknowledgement while retaining the same claim for the forwarded provider turn. `/new` uses Task 6's generation-owned replacement slot, transfers the exact claim to the detached replacement queue, and emits its tracked reply only after the atomic slot swap; failure retains old ownership and no claimless reply.

Voice synthesis is best-effort but never claimless. Determine whether voice is
planned before terminal reservation and run it behind a bounded, shutdown-owned
timeout. Synthesis failure/timeout produces a text-only terminal batch; it can
never strand provider text or the turn barrier. On success, atomically reserve
the optional content-free voice op in the same provider terminal batch. Only
after the batch commits may text/voice transports run. If RGP or a prior
terminal owner wins first, discard synthesis and send neither. If the batch
reserves first, voice may finish after text echo closes the inbound because it
was already authorized. Journal/synthesis/media faults remain observed and
cannot alter terminality or create a second owner. Test synthesis reject,
timeout, late success after timeout, RGP during synthesis, text-only fallback,
held media, and shutdown.

Chat visible output reserves a terminal op and waits for exact proof. Passive and
response-unworthy outcomes stay at Task 3's admitted policy seam; they do not
enter a runtime no-output path. Only the inventoried local-command and partial-
poll receipts may use no-outbound completion. No runtime accepts a bare
sequence. Update every provider cleanup/usage-limit/empty/fallback call site and
mock; `stale_claim` is mandatory in every exhaustive switch.

Before RED, freeze `rg -l 'cleanupUsageLimitTurn|usage-limit|providerFailureKind'
tests/runtimes/agent` plus `tests/runtimes/agent/fallback-*.test.ts` into the Task
8 evidence manifest. Run all of them. Any file whose fixture/mock must change is
added explicitly to this task's final staged-file receipt; Task 9's actual-diff
cross-check fails the commit if the static list above or the staged command omits
it. Do not treat an unmodified-but-run suite as a promised code change.

- [ ] **Step 6: Make quarantine retirement and documentation truthful**

`deploy/scripts/retire-outbound-quarantine.py` must not unconditionally set
`is_terminal=1`. Preserve the reviewed row's existing terminality. The mutating
mode fails closed unless it proves the owning service/runtime is fully stopped,
not merely that ingress is paused; a live process may own an in-memory exact-op
waiter that an external SQLite mutation cannot notify. Dry-run may run live but
states that limitation. Retiring an exact terminal row to `failed_permanent`
must atomically invoke/prove exact inbound failure reconciliation before
reporting success or clearing its incident, then require a normal service
restart so startup recovery observes the new durable disposition. Retiring
auxiliary voice/progress leaves `is_terminal=0` and cannot create a second
terminal owner. Refuse a live/unknown service state, unsafe promotion, mismatched
claim, active transport state, missing backup, or reconciliation fault. Dry-run
reports both op and inbound effects without writing. Add live-service refusal,
stopped-service success, mandatory-restart/recovery, auxiliary-plus-existing-
terminal, exact terminal, legacy-invalid, rollback, emit/clear false, and backup
tests. The script remains an intentional manual-CLI manifest suppression;
assert `guard:bot-errors-runtime-manifest` still recognizes that status, and
update the README's false claim that retirement always flips terminality.

Rewrite durability/Reply Guarantee/runbook/public-surface/configuration wording so typing, journal reservation, submission, echo, failure reconciliation, no-output completion, token accounting, voice, and operator retirement are distinct. Document exact inspection queries, current-boot recovery proof, migration 38, rollout/rollback order, and that terminal interruption suppresses late provider output. Remove any promise of an untracked follow-up.

Run the full focused matrix:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/database.test.ts tests/core/admitted-turn.test.ts tests/core/admin.test.ts tests/core/echo-guard.test.ts tests/core/inbound-shutdown-lifecycle.test.ts tests/main-bootstrap.test.ts tests/main-bootstrap-helpers.test.ts tests/main-shutdown-policy.test.ts tests/core/migration-38-token-provenance.test.ts tests/core/durability-schema.test.ts tests/core/migration-safety.test.ts tests/core/durability.test.ts tests/core/durability-edge.test.ts tests/core/durability-drain.test.ts tests/core/durability-continuity-marker.test.ts tests/core/durability-echoed-terminal-recovery.test.ts tests/core/durability-turn-done-recovery.test.ts tests/core/durability-recovery.test.ts tests/core/durability-stuck-inbound-sweep.test.ts tests/core/perf-prepared-statements.test.ts tests/core/reply-guarantee.test.ts tests/core/ingest.test.ts tests/core/inbound-replay.test.ts tests/core/health.test.ts tests/core/inbound-failure-class.test.ts tests/integration/crash-recovery.test.ts tests/runtimes/passive/runtime.test.ts tests/runtimes/chat/queue.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/outbound-queue.test.ts tests/runtimes/agent/outbound-queue-idempotency.test.ts tests/runtimes/agent/image-coalescer.test.ts tests/runtimes/agent/media-bridge.test.ts tests/runtimes/agent/session.test.ts tests/runtimes/agent/session-db.test.ts tests/runtimes/agent/session-budget.test.ts tests/runtimes/agent/providers/budget.test.ts tests/runtimes/agent/providers/budget-and-mapping.test.ts tests/runtimes/agent/control-queue.test.ts tests/runtimes/agent/control-timeout.test.ts tests/runtimes/agent/codex-turn-lifecycle.test.ts tests/runtimes/agent/fallback-cost-accumulation.test.ts tests/runtimes/agent/fallback-empty-turn.test.ts tests/runtimes/agent/idle-session-eviction.test.ts tests/runtimes/agent/per-chat-actor-binding.test.ts tests/runtimes/agent/per-chat-empty-output-replay.test.ts tests/runtimes/agent/provider-fallback.test.ts tests/runtimes/agent/runtime-edge-coverage.test.ts tests/runtimes/agent/runtime-secondhalf-branches.test.ts tests/runtimes/agent/runtime-structural-policy.test.ts tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/zombie-sessions.test.ts tests/scripts/retire-outbound-quarantine.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/agent/fallback-*.test.ts $(rg -l 'cleanupUsageLimitTurn|usage-limit|providerFailureKind' tests/runtimes/agent | sort) --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:test-integrity
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
bash scripts/run-with-pinned-npm.sh run guard:publication:all
bash scripts/run-with-pinned-npm.sh run guard:bot-errors-runtime-manifest
git diff --check
```

Expected: PASS with no skipped/filtered owners. Test Integrity must inspect every changed test; masked, stale, empty, or partial output is `Inconclusive`. Run these source inventories and require zero obsolete production authority:

```bash
rg -n 'setInboundSeq|getLastOpId|markLastTerminal|createTerminalOutboundOpIfAbsent' src tests
rg -n 'completeInbound\([^,{]|markInboundFailed\([^,{]|replyGuarantee\?\.(arm|disarm|notifyActivity)\([^\{]' src tests
rg -n 'sendDirect\(|sendTracked\(|createOutboundOp\(' src/runtimes src/core
```

Every match is classified in the receipt; admitted bare-sequence/latest-op/claimless transport matches are blockers. Recompute every changed source-runtime hash before staging.

- [ ] **Step 7: Commit exact terminal ownership**

```bash
git add src/core/database.ts src/core/types.ts src/core/admitted-turn.ts src/core/durability.ts src/core/ingest.ts src/core/inbound-replay.ts src/core/reply-guarantee.ts src/core/admin.ts src/core/echo-guard.ts src/core/health.ts src/core/inbound-failure-class.ts src/main.ts src/main-shutdown-policy.ts src/runtimes/types.ts src/runtimes/passive/runtime.ts src/runtimes/chat/queue.ts src/runtimes/chat/runtime.ts src/runtimes/agent/turn-queue.ts src/runtimes/agent/outbound-queue.ts src/runtimes/agent/image-coalescer.ts src/runtimes/agent/media-bridge.ts src/runtimes/agent/session.ts src/runtimes/agent/session-db.ts src/runtimes/agent/providers/budget.ts src/runtimes/agent/control-queue.ts src/runtimes/agent/runtime.ts deploy/scripts/retire-outbound-quarantine.py deploy/scripts/README-bot-errors.md deploy/source-runtime-manifest.json tests/core/database.test.ts tests/core/admitted-turn.test.ts tests/core/admin.test.ts tests/core/echo-guard.test.ts tests/core/inbound-shutdown-lifecycle.test.ts tests/main-bootstrap.test.ts tests/main-bootstrap-helpers.test.ts tests/main-shutdown-policy.test.ts tests/core/migration-38-token-provenance.test.ts tests/core/migration-safety.test.ts tests/core/durability-schema.test.ts tests/core/durability.test.ts tests/core/durability-edge.test.ts tests/core/durability-drain.test.ts tests/core/durability-continuity-marker.test.ts tests/core/durability-echoed-terminal-recovery.test.ts tests/core/durability-turn-done-recovery.test.ts tests/core/durability-recovery.test.ts tests/core/durability-stuck-inbound-sweep.test.ts tests/core/perf-prepared-statements.test.ts tests/core/reply-guarantee.test.ts tests/core/ingest.test.ts tests/core/inbound-replay.test.ts tests/core/health.test.ts tests/core/inbound-failure-class.test.ts tests/integration/crash-recovery.test.ts tests/runtimes/passive/runtime.test.ts tests/runtimes/chat/queue.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/outbound-queue.test.ts tests/runtimes/agent/outbound-queue-idempotency.test.ts tests/runtimes/agent/image-coalescer.test.ts tests/runtimes/agent/media-bridge.test.ts tests/runtimes/agent/session.test.ts tests/runtimes/agent/session-db.test.ts tests/runtimes/agent/session-budget.test.ts tests/runtimes/agent/providers/budget.test.ts tests/runtimes/agent/providers/budget-and-mapping.test.ts tests/runtimes/agent/control-queue.test.ts tests/runtimes/agent/control-timeout.test.ts tests/runtimes/agent/codex-turn-lifecycle.test.ts tests/runtimes/agent/fallback-cost-accumulation.test.ts tests/runtimes/agent/fallback-empty-turn.test.ts tests/runtimes/agent/idle-session-eviction.test.ts tests/runtimes/agent/per-chat-actor-binding.test.ts tests/runtimes/agent/per-chat-empty-output-replay.test.ts tests/runtimes/agent/provider-fallback.test.ts tests/runtimes/agent/runtime-edge-coverage.test.ts tests/runtimes/agent/runtime-secondhalf-branches.test.ts tests/runtimes/agent/runtime-structural-policy.test.ts tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/zombie-sessions.test.ts tests/scripts/retire-outbound-quarantine.test.ts docs/configuration.md docs/durability.md docs/reply-guarantee.md docs/runbook.md docs/public-surface.md
git commit -m "fix(durability): require exact terminal delivery proof"
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
```

Run the source-runtime guard only on the committed Task 8 head. Any correction requires updated hashes, amend, and the entire Task 8 matrix plus Test Integrity/docs/publication/bot-errors guards again. The fixed-error Task 7 hard-sender bridge and every obsolete authority search above must be absent before this WS-A01 head is publishable.

### Task 9: Verify each PR boundary and the combined train

**Files:**
- Verify only; no product file changes unless a failing semantic assertion identifies a real defect.

**Interfaces:**
- Consumes: all interfaces produced by Tasks 1-8.
- Produces: three exact-head PR receipts, one exact-`origin/main` integrated
  receipt, and explicit proof gaps for staging-only behavior. Every command and
  assertion is classified only `Pass`, `Fail`, `Inconclusive`, or `Blocked`;
  “clean” is not a substitute for those receipts.

- [ ] **Step 0: Refresh each branch and scan changed exports before verification**

For each PR, fetch `origin`, prove its merge base is current `origin/main`, rebase
before any release claim, and capture ahead/behind plus exact SHA. Mechanically
record the sorted union of every owning task's test paths from its `Files`, final
focused command, final stage list, and actual `origin/main...HEAD` diff. Expand
declared globs with `git ls-files` at that exact head and store the resulting
paths in the branch receipt. Any task/diff test absent from the receipt, any
receipt path that does not exist, or any changed test omitted from Test Integrity
is `Blocked`; rerun the complete recorded union at the exact branch SHA after
every rebase or code change. Run
`bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift`,
`bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift`, and a
production-reference scan for every added/changed exported symbol. Record each
export, defining file, production consumers, test consumers, or an explicit
reason it is intentionally public. An exported seam with only test consumers is
either made private or blocks the PR as unwired.

Execute every Step 1–3 block as one fail-fast shell and record each command,
start/end UTC, exact head SHA, exit status, and untruncated output in the branch
receipt. `set -euo pipefail` is mandatory; a later zero exit can never mask an
earlier failure. If the harness cannot provide per-command exit receipts, the
block is `Inconclusive` even when its final process exit is zero.

- [ ] **Step 1: Verify WS-A02 at its branch tip**

Run:

```bash
set -euo pipefail
bash scripts/run-with-pinned-npm.sh test -- tests/core/access-policy.test.ts tests/core/admin.test.ts tests/core/database.test.ts tests/core/db-tx.test.ts tests/core/decryption-failures.test.ts tests/core/durability-schema.test.ts tests/core/durability.test.ts tests/core/health.test.ts tests/core/inbound-admission.test.ts tests/core/inbound-failure-class.test.ts tests/core/ingest-backpressure.test.ts tests/core/ingest-control.test.ts tests/core/ingest-fallback-routing.test.ts tests/core/ingest-paused-chats.test.ts tests/core/ingest.test.ts tests/core/messages.test.ts tests/core/migration-37-inbound-replay.test.ts tests/core/migration-safety.test.ts tests/integration/heal-flow.test.ts tests/main-bootstrap.test.ts tests/runtimes/agent/outbound-queue-idempotency.test.ts tests/runtimes/agent/outbound-queue.test.ts tests/runtimes/agent/runtime.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/passive/runtime.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:lint:src
bash scripts/run-with-pinned-npm.sh run verify:release
```

Expected: all commands exit 0. Capture the test totals and note that real process crash timing is not proven by an in-memory SQLite test.
Also capture the read-only, `SQLITE_FULL`, rollback-usability, two-connection, redelivery-at-attempt-ceiling, and trigger-metadata assertions by test name; missing or filtered cases are `Inconclusive`.

- [ ] **Step 2: Verify WS-A03 at its branch tip**

Run:

```bash
set -euo pipefail
bash scripts/run-with-pinned-npm.sh test -- tests/core/admin.test.ts tests/core/database-retention.test.ts tests/core/database.test.ts tests/core/durability-edge.test.ts tests/core/durability-recovery.test.ts tests/core/durability-stuck-inbound-sweep.test.ts tests/core/durability.test.ts tests/core/heal-endpoint.test.ts tests/core/heal.test.ts tests/core/health-mark-read.test.ts tests/core/health-schedule.test.ts tests/core/health.test.ts tests/core/inbound-admission.test.ts tests/core/inbound-failure-class.test.ts tests/core/inbound-replay.test.ts tests/core/inbound-shutdown-lifecycle.test.ts tests/core/ingest.test.ts tests/core/media-retention.test.ts tests/core/messages.test.ts tests/core/post-connect-recovery.test.ts tests/core/reply-guarantee.test.ts tests/core/scheduler.test.ts tests/core/substrate/poller.test.ts tests/integration/contracts.test.ts tests/lib/model-advisor.test.ts tests/main-bootstrap-helpers.test.ts tests/main-bootstrap.test.ts tests/main-shutdown-policy.test.ts tests/memory/consolidation-scheduler.test.ts tests/runtimes/agent/codex-turn-lifecycle.test.ts tests/runtimes/agent/control-queue.test.ts tests/runtimes/agent/handoff-distill-coordinator.test.ts tests/runtimes/agent/idle-session-eviction.test.ts tests/runtimes/agent/image-coalescer.test.ts tests/runtimes/agent/media-bridge.test.ts tests/runtimes/agent/outbound-queue-idempotency.test.ts tests/runtimes/agent/outbound-queue.test.ts tests/runtimes/agent/runtime-edge-coverage.test.ts tests/runtimes/agent/runtime-structural-policy.test.ts tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/session.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/zombie-sessions.test.ts tests/runtimes/chat/enrichment/poller.test.ts tests/runtimes/chat/queue.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/passive/runtime.test.ts tests/scripts/requeue-inbound.test.ts tests/transport/connection-branches.test.ts tests/transport/connection-branch-residuals.test.ts tests/transport/connection-connect-failure.test.ts tests/transport/reconnect.test.ts tests/transport/twilio/connection-bridge.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
bash scripts/run-with-pinned-npm.sh run verify:release
```

Expected: exit 0. A forced process exit, Docker restart, systemd stop deadline, and live Twilio close remain staging drills rather than unit-test proof.

- [ ] **Step 3: Verify WS-A01 at its branch tip**

Run:

```bash
set -euo pipefail
FALLBACK_TESTS="$(git ls-files 'tests/runtimes/agent/fallback-*.test.ts' | sort)"
PROVIDER_CLEANUP_TESTS="$(rg -l 'cleanupUsageLimitTurn|usage-limit|providerFailureKind' tests/runtimes/agent | sort)"
test -n "$FALLBACK_TESTS"
test -n "$PROVIDER_CLEANUP_TESTS"
bash scripts/run-with-pinned-npm.sh test -- tests/core/admin.test.ts tests/core/admitted-turn.test.ts tests/core/database.test.ts tests/core/durability-continuity-marker.test.ts tests/core/durability-drain.test.ts tests/core/durability-echoed-terminal-recovery.test.ts tests/core/durability-edge.test.ts tests/core/durability-recovery.test.ts tests/core/durability-schema.test.ts tests/core/durability-stuck-inbound-sweep.test.ts tests/core/durability-turn-done-recovery.test.ts tests/core/durability.test.ts tests/core/echo-guard.test.ts tests/core/health.test.ts tests/core/inbound-failure-class.test.ts tests/core/inbound-replay.test.ts tests/core/inbound-shutdown-lifecycle.test.ts tests/core/ingest.test.ts tests/core/migration-38-token-provenance.test.ts tests/core/migration-safety.test.ts tests/core/perf-prepared-statements.test.ts tests/core/reply-guarantee.test.ts tests/integration/crash-recovery.test.ts tests/main-bootstrap-helpers.test.ts tests/main-bootstrap.test.ts tests/main-shutdown-policy.test.ts tests/runtimes/agent/codex-turn-lifecycle.test.ts tests/runtimes/agent/control-queue.test.ts tests/runtimes/agent/control-timeout.test.ts tests/runtimes/agent/fallback-cost-accumulation.test.ts tests/runtimes/agent/fallback-empty-turn.test.ts tests/runtimes/agent/idle-session-eviction.test.ts tests/runtimes/agent/image-coalescer.test.ts tests/runtimes/agent/media-bridge.test.ts tests/runtimes/agent/outbound-queue-idempotency.test.ts tests/runtimes/agent/outbound-queue.test.ts tests/runtimes/agent/per-chat-actor-binding.test.ts tests/runtimes/agent/per-chat-empty-output-replay.test.ts tests/runtimes/agent/provider-fallback.test.ts tests/runtimes/agent/providers/budget-and-mapping.test.ts tests/runtimes/agent/providers/budget.test.ts tests/runtimes/agent/runtime-edge-coverage.test.ts tests/runtimes/agent/runtime-secondhalf-branches.test.ts tests/runtimes/agent/runtime-structural-policy.test.ts tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/session-budget.test.ts tests/runtimes/agent/session-db.test.ts tests/runtimes/agent/session.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/zombie-sessions.test.ts tests/runtimes/chat/queue.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/passive/runtime.test.ts tests/scripts/requeue-inbound.test.ts tests/scripts/retire-outbound-quarantine.test.ts $FALLBACK_TESTS $PROVIDER_CLEANUP_TESTS --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run verify:release
```

Expected: exit 0 with fake-clock proof of soft/hard ordering and SQLite proof of echo-gated completion.

- [ ] **Step 4: Publish, independently review, check, and merge each dependency boundary**

Do not begin this step without a recorded explicit user authorization covering
branch publication, PR create/update, and merge; absent or narrower authority is
`Blocked` and execution stops after local verification.

Before the first push, freeze the repository's check policy from GitHub rather
than inferring it from workflow files or a previous run. Store the complete
responses from `branches/main/protection/required_status_checks`,
`rulesets?includes_parents=true`, and every active branch-ruleset detail. Classify
each active ruleset's `conditions.ref_name` against `refs/heads/main`; an unknown
condition, inaccessible endpoint, or unclassified active ruleset is
`Inconclusive`. Normalize and hash the applicable union of required contexts,
including app IDs where GitHub supplies them. At plan review time that union is
exactly `CodeQL`, `quality (24.x)`, and `quality (25.x)`; any addition, removal,
app change, or strictness change requires a reviewed plan/receipt update before
merge. Capture the CodeQL workflow hash and its three exact Analyze job names so
the `CodeQL` policy context cannot be hand-waved into an unrelated green run.

Before the first live capture, run the normalization routine against saved JSON
fixtures for: index `conditions:null` plus detail `~DEFAULT_BRANCH` (applicable),
zero active rulesets, an exact non-main branch (classified non-applicable),
`~ALL` with/without main exclusion, unknown/glob/missing selectors (fail),
duplicate/unsafe IDs, missing detail, index/detail
name/source/source_type/target/enforcement/updated-at mismatch, and a changed
second index/default-branch/protection response (fail). Retain fixture outputs
and the all-active-ruleset classification artifact. Removing detail-first
classification or the refetch comparison must make the positive/current-live
shape or a negative fixture fail.

Also create one frozen release-check spec from the exact Step 4 PR-head receipts.
It contains these six `{name,app_slug:'github-actions'}` entries and no others:
`quality (24.x)`, `quality (25.x)`, `bot-errors-health-macos`,
`Analyze (actions)`, `Analyze (javascript-typescript)`, and `Analyze (python)`.
For every exact PR head, query all latest check runs by SHA and require its
normalized GitHub-Actions name set to equal that spec exactly, then require every
entry completed/success. A missing expected run or any unclassified added run is
`Inconclusive`; never silently extend or shrink the spec. Record the policy
snapshot SHA-256, all-active-ruleset-classification SHA-256, and
release-check-spec SHA-256 in every Step 4 merge receipt, and
recapture/recompare both policy and classification immediately before and after
every merge.

Before WS-A02 can merge, record a deployment-hold receipt containing the owner,
exact controller/service mechanism, read-only state command/API response, UTC
time, and WS-A02 reviewed SHA. The readback must prove these commits cannot
activate in production independently. Re-read and append the same hold receipt
immediately before and after the WS-A02 and WS-A03 merges and before WS-A01
merge; any missing/changed/unknown state is `Blocked`. The hold is released only
after Step 5 exact-main authorization plus the required backlog/replay/terminal
smokes. If no verifiable hold exists, use the coordinated reviewed merge-window
alternative from Global Constraints and record its owner/window/mechanism before
the first merge.

For WS-A02, then rebased WS-A03, then rebased WS-A01, verify
`git remote get-url origin` is the canonical GitHub SSH URL for this repository,
record `git rev-parse HEAD`, push the
named branch (use `--force-with-lease` only after a recorded rebase), and create
or update its PR. Read back the PR head SHA through `gh api` and require exact
equality with the locally verified SHA. Run `gh pr checks --watch <PR>` and
capture every required Quality matrix and CodeQL result; missing, skipped,
cancelled, neutral where success is required, or stale-SHA checks are
`Inconclusive`/`Fail`, never green.

Dispatch an independent read-only reviewer against that exact pushed SHA and
store a review artifact containing scope, inspected diff/base, commands,
high/medium findings, and disposition. Any unresolved high finding blocks the
merge; any code change invalidates both the local receipt and review and repeats
the applicable task matrix, `verify:release`, push-SHA equality, checks, and
review. Merge only the reviewed exact SHA through the repository's normal PR
method and record an API-readback receipt
`{pr, reviewed_head_sha, merged_head_sha, merge_sha}`. The merged PR head must
equal the reviewed/pushed head; a differing readback or merge-queue rewrite is
`Blocked` until the resulting exact head is independently reviewed and
verified.

After WS-A02 merges, fetch and rebase WS-A03 onto the new `origin/main`, then
repeat Step 0, Step 2, exact-head `verify:release`, publish/check/review, and SHA
proof before merging. After WS-A03 merges, do the same for WS-A01 using Step 0
and Step 3. A local pass from the pre-rebase SHA or CI from an earlier push is
stale and cannot authorize either merge.

- [ ] **Step 5: Prove the exact integrated `origin/main` in a disposable worktree**

Load `WS_A02_MERGE_SHA`, `WS_A03_MERGE_SHA`, and `WS_A01_MERGE_SHA` only from
the Step 4 API receipts. Materialize all Step 5 code fences plus the Step 1–3
test commands as one receipt script and execute it once in one retained
`set -euo pipefail` shell; the fences below are contiguous fragments, not
independent terminal invocations. Run from a clean controller checkout:

```bash
set -euo pipefail
EXPECTED_REMOTE='git'@'github.com:LucasQuiles/WhatSoup.git'
test "$(git remote get-url origin)" = "$EXPECTED_REMOTE"
git fetch --prune origin
INTEGRATED_SHA="$(git rev-parse origin/main)"
TRAIN_ROOT="$(git rev-parse --show-toplevel)"
RELEASE_WORKTREE="${TMPDIR:-/tmp}/whatsoup-release-${INTEGRATED_SHA}"

for MERGE_SHA in "$WS_A02_MERGE_SHA" "$WS_A03_MERGE_SHA" "$WS_A01_MERGE_SHA"; do
  test -n "$MERGE_SHA"
  git cat-file -e "$MERGE_SHA^{commit}"
  git merge-base --is-ancestor "$MERGE_SHA" "$INTEGRATED_SHA"
done

test ! -e "$RELEASE_WORKTREE"
git worktree add --detach "$RELEASE_WORKTREE" "$INTEGRATED_SHA"
cd "$RELEASE_WORKTREE"
test "$(git rev-parse HEAD)" = "$INTEGRATED_SHA"
test -z "$(git status --porcelain=v1 --untracked-files=all)"

bash scripts/run-with-pinned-npm.sh ci
bash scripts/run-with-pinned-npm.sh ci --prefix console
bash scripts/run-with-pinned-npm.sh ci --prefix tools/whatsoup_guard
test ! -L node_modules
test ! -L console/node_modules
test ! -L tools/whatsoup_guard/node_modules
```

In that detached worktree rerun, without omission, the recorded sorted test
unions and dynamic expansions from Steps 1, 2, and 3, followed by:

```bash
set -euo pipefail
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:test-integrity
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
bash scripts/run-with-pinned-npm.sh run verify:release
test "$(git rev-parse HEAD)" = "$INTEGRATED_SHA"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Load the frozen policy/check-spec SHA-256 values from the Step 4 receipts. Query
GitHub by commit SHA, never branch name. First recapture the branch-protection
and applicable-ruleset policy with the exact Step 4 normalization routine and
require a byte-identical normalized snapshot and SHA-256. Then use the frozen
release-check spec; do not reconstruct it from the hard-coded prose below. This
bounded poll is another fragment of the same shell:

```bash
EVIDENCE_DIR="$TRAIN_ROOT/artifacts/release-evidence/$INTEGRATED_SHA"
mkdir -p "$EVIDENCE_DIR"
test -f "$STEP4_NORMALIZED_CHECK_POLICY"
test -f "$STEP4_RULESET_CLASSIFICATION"
test -f "$STEP4_REQUIRED_CHECK_SPEC"
test "$(shasum -a 256 "$STEP4_NORMALIZED_CHECK_POLICY" | awk '{print $1}')" = "$STEP4_CHECK_POLICY_SHA256"
test "$(shasum -a 256 "$STEP4_RULESET_CLASSIFICATION" | awk '{print $1}')" = "$STEP4_RULESET_CLASSIFICATION_SHA256"
test "$(shasum -a 256 "$STEP4_REQUIRED_CHECK_SPEC" | awk '{print $1}')" = "$STEP4_CHECK_SPEC_SHA256"

# Step 4 invokes this identical function for its frozen snapshot. It classifies
# only detail responses; index entries are identity/race evidence, never the
# conditions authority.
capture_normalized_check_policy() {
  local output="$1"
  local parts="${output}.parts"
  mkdir "$parts"
  gh api repos/LucasQuiles/WhatSoup > "$parts/repository.json"
  test "$(jq -r '.default_branch' "$parts/repository.json")" = main
  gh api repos/LucasQuiles/WhatSoup/branches/main/protection/required_status_checks \
    > "$parts/branch-protection.json"
  gh api --paginate --slurp \
    'repos/LucasQuiles/WhatSoup/rulesets?includes_parents=true&targets=branch&per_page=100' \
    > "$parts/rulesets-index-first.json"
  jq -S '[.[][]] | sort_by(.id)' "$parts/rulesets-index-first.json" \
    > "$parts/rulesets-index-normalized.json"
  jq -e '
    all(.[];
      (.id | type) == "number" and (.id | floor) == .id
      and .id > 0 and .id <= 9007199254740991
      and (.name | type) == "string" and (.name | length) > 0
      and (.enforcement == "active"
        or .enforcement == "evaluate" or .enforcement == "disabled")
      and ((.target == null) or .target == "branch")
      and (.source | type) == "string" and (.source | length) > 0
      and (.source_type | type) == "string" and (.source_type | length) > 0
      and (.updated_at | type) == "string" and (.updated_at | length) > 0
    )
    and ((map(.id) | unique | length) == length)
  ' "$parts/rulesets-index-normalized.json" >/dev/null
  jq -S '[.[] | select(.enforcement == "active")]
    | sort_by(.id)' "$parts/rulesets-index-normalized.json" \
    > "$parts/active-branch-index.json"
  jq -e '
    all(.[];
      (.id | type) == "number"
      and (.id | floor) == .id
      and .id > 0 and .id <= 9007199254740991
      and (.name | type) == "string" and (.name | length) > 0
      and ((.target == null) or .target == "branch")
      and .enforcement == "active"
      and (.source | type) == "string" and (.source | length) > 0
      and (.source_type | type) == "string" and (.source_type | length) > 0
      and (.updated_at | type) == "string" and (.updated_at | length) > 0
    )
    and ((map(.id) | unique | length) == length)
  ' "$parts/active-branch-index.json" >/dev/null

  jq -n '[]' > "$parts/ruleset-details.json"
  jq -n '[]' > "$parts/ruleset-classification.json"
  jq -r '.[].id' "$parts/active-branch-index.json" | while IFS= read -r ruleset_id; do
      test -n "$ruleset_id"
      gh api "repos/LucasQuiles/WhatSoup/rulesets/$ruleset_id" \
        > "$parts/ruleset-$ruleset_id.json"
      jq -e --slurpfile index "$parts/active-branch-index.json" '
        . as $detail
        | ($index[0] | map(select(.id == $detail.id))) as $match
        | ($match | length) == 1
          and ($match[0].name == $detail.name)
          and $detail.target == "branch"
          and (($match[0].target == null) or ($match[0].target == $detail.target))
          and ($match[0].enforcement == $detail.enforcement)
          and ($match[0].source == $detail.source)
          and ($match[0].source_type == $detail.source_type)
          and ($match[0].updated_at == $detail.updated_at)
      ' "$parts/ruleset-$ruleset_id.json" >/dev/null
      jq -e '
        def valid_ref:
          . == "~ALL" or . == "~DEFAULT_BRANCH" or . == "refs/heads/main"
          or (type == "string" and test("^refs/heads/[A-Za-z0-9._/-]+$"));
        .conditions.ref_name as $ref
        | ($ref | type) == "object"
          and ($ref.include | type) == "array" and ($ref.include | length) > 0
          and ($ref.exclude | type) == "array"
          and all($ref.include[]; valid_ref)
          and all($ref.exclude[]; valid_ref)
          and (($ref.include | unique | length) == ($ref.include | length))
          and (($ref.exclude | unique | length) == ($ref.exclude | length))
          and (.rules | type) == "array"
          and all(.rules[]; type == "object" and (.type | type) == "string")
          and ([.rules[] | select(.type == "required_status_checks")] | length) <= 1
          and all(.rules[] | select(.type == "required_status_checks");
            (.parameters | type) == "object"
            and (.parameters.strict_required_status_checks_policy | type) == "boolean"
            and (.parameters.do_not_enforce_on_create | type) == "boolean"
            and (.parameters.required_status_checks | type) == "array"
            and (.parameters.required_status_checks | length) > 0
            and all(.parameters.required_status_checks[];
              (.context | type) == "string" and (.context | length) > 0
              and ((.integration_id == null) or (
                (.integration_id | type) == "number"
                and (.integration_id | floor) == .integration_id
                and .integration_id > 0
                and .integration_id <= 9007199254740991
              )))
            and ((.parameters.required_status_checks
              | map([.context, .integration_id]) | unique | length)
              == (.parameters.required_status_checks | length))
          )
      ' "$parts/ruleset-$ruleset_id.json" >/dev/null
      jq -S '
        def hits_main:
          . == "~ALL" or . == "~DEFAULT_BRANCH" or . == "refs/heads/main";
        .conditions.ref_name as $ref
        | {
            id, name, target, enforcement, source, source_type, updated_at,
            include: ($ref.include | sort),
            exclude: ($ref.exclude | sort),
            applicable_main:
              (any($ref.include[]; hits_main)
                and (any($ref.exclude[]; hits_main) | not))
          }
      ' "$parts/ruleset-$ruleset_id.json" > "$parts/classification-$ruleset_id.json"
      jq --slurpfile detail "$parts/ruleset-$ruleset_id.json" \
        '. + [$detail[0]]' "$parts/ruleset-details.json" \
        > "$parts/ruleset-details.next.json"
      mv "$parts/ruleset-details.next.json" "$parts/ruleset-details.json"
      jq --slurpfile classification "$parts/classification-$ruleset_id.json" \
        '. + [$classification[0]]' "$parts/ruleset-classification.json" \
        > "$parts/ruleset-classification.next.json"
      mv "$parts/ruleset-classification.next.json" "$parts/ruleset-classification.json"
    done
  jq -S 'sort_by(.id)' "$parts/ruleset-details.json" > "$parts/ruleset-details.sorted.json"
  mv "$parts/ruleset-details.sorted.json" "$parts/ruleset-details.json"
  jq -S 'sort_by(.id)' "$parts/ruleset-classification.json" \
    > "$parts/ruleset-classification.sorted.json"
  mv "$parts/ruleset-classification.sorted.json" "$parts/ruleset-classification.json"
  jq -e --slurpfile index "$parts/active-branch-index.json" \
    'length == ($index[0] | length)
      and (map(.id) == ($index[0] | map(.id)))' \
    "$parts/ruleset-details.json" >/dev/null
  jq -e --slurpfile index "$parts/active-branch-index.json" '
    length == ($index[0] | length)
      and (map(.id) == ($index[0] | map(.id)))
      and ((map(.id) | unique | length) == length)
  ' "$parts/ruleset-classification.json" >/dev/null

  # Refetch after all details so a moving index cannot produce a mixed snapshot.
  gh api --paginate --slurp \
    'repos/LucasQuiles/WhatSoup/rulesets?includes_parents=true&targets=branch&per_page=100' \
    > "$parts/rulesets-index-second.json"
  jq -S '[.[][]] | sort_by(.id)' "$parts/rulesets-index-second.json" \
    > "$parts/rulesets-index-second-normalized.json"
  cmp -s "$parts/rulesets-index-normalized.json" \
    "$parts/rulesets-index-second-normalized.json"
  gh api repos/LucasQuiles/WhatSoup > "$parts/repository-second.json"
  jq -S . "$parts/repository.json" > "$parts/repository-normalized.json"
  jq -S . "$parts/repository-second.json" > "$parts/repository-second-normalized.json"
  cmp -s "$parts/repository-normalized.json" "$parts/repository-second-normalized.json"
  gh api repos/LucasQuiles/WhatSoup/branches/main/protection/required_status_checks \
    > "$parts/branch-protection-second.json"
  jq -S . "$parts/branch-protection.json" > "$parts/branch-protection-normalized.json"
  jq -S . "$parts/branch-protection-second.json" \
    > "$parts/branch-protection-second-normalized.json"
  cmp -s "$parts/branch-protection-normalized.json" \
    "$parts/branch-protection-second-normalized.json"

  jq -e '
    (.strict | type) == "boolean"
    and (.contexts | type) == "array"
    and (.checks | type) == "array"
    and all(.contexts[]; type == "string" and length > 0)
    and ((.contexts | unique | length) == (.contexts | length))
    and all(.checks[];
      (.context | type) == "string" and (.context | length) > 0
      and ((.app_id == null) or (
        (.app_id | type) == "number"
        and (.app_id | floor) == .app_id
        and .app_id > 0 and .app_id <= 9007199254740991)))
    and ((.checks | map([.context, .app_id]) | unique | length)
      == (.checks | length))
  ' "$parts/branch-protection.json" >/dev/null
  jq -S -n \
    --slurpfile branch "$parts/branch-protection.json" \
    --slurpfile details "$parts/ruleset-details.json" \
    --slurpfile classes "$parts/ruleset-classification.json" '
    ($branch[0]) as $branch
    | ($details[0]) as $details
    | ($classes[0]) as $classes
    | {
        branch_protection: {
          strict: $branch.strict,
          contexts: ($branch.contexts | unique | sort),
          checks: ([$branch.checks[]? | {context, app_id}]
            | unique_by(.context, .app_id) | sort_by(.context, .app_id))
        },
        applicable_active_rulesets: ([$details[] as $detail
          | ($classes[] | select(.id == $detail.id and .applicable_main)) as $class
          | $detail | {
          id, name, target, enforcement, source, source_type, updated_at, conditions,
          required_status_checks: ([.rules[]
            | select(.type == "required_status_checks")
            | .parameters
            | {
                strict_required_status_checks_policy,
                do_not_enforce_on_create,
                required_status_checks: ([.required_status_checks[]
                  | {context, integration_id}]
                  | unique_by(.context, .integration_id)
                  | sort_by(.context, .integration_id))
              }
          ])
        }] | sort_by(.id))
      }
  ' > "$output"
}

CURRENT_POLICY="$EVIDENCE_DIR/normalized-check-policy.json"
capture_normalized_check_policy "$CURRENT_POLICY"
cmp -s "$STEP4_NORMALIZED_CHECK_POLICY" "$CURRENT_POLICY"
test "$(shasum -a 256 "$CURRENT_POLICY" | awk '{print $1}')" = "$STEP4_CHECK_POLICY_SHA256"
CURRENT_CLASSIFICATION="$CURRENT_POLICY.parts/ruleset-classification.json"
cmp -s "$STEP4_RULESET_CLASSIFICATION" "$CURRENT_CLASSIFICATION"
test "$(shasum -a 256 "$CURRENT_CLASSIFICATION" | awk '{print $1}')" = "$STEP4_RULESET_CLASSIFICATION_SHA256"
jq -e '
  ([
    .branch_protection.contexts[]?,
    .branch_protection.checks[]?.context,
    .applicable_active_rulesets[]
      .required_status_checks[]
      .required_status_checks[]?.context
  ] | unique | sort)
  == (["CodeQL", "quality (24.x)", "quality (25.x)"] | sort)
' "$CURRENT_POLICY" >/dev/null
test -f "$CURRENT_CLASSIFICATION"

REQUIRED_CHECK_SPEC="$EVIDENCE_DIR/required-check-spec.json"
CHECK_RUNS="$EVIDENCE_DIR/check-runs.json"
cp "$STEP4_REQUIRED_CHECK_SPEC" "$REQUIRED_CHECK_SPEC"
jq -e '
  length == 6
  and (map(.name) | sort) == ([
    "Analyze (actions)",
    "Analyze (javascript-typescript)",
    "Analyze (python)",
    "bot-errors-health-macos",
    "quality (24.x)",
    "quality (25.x)"
  ] | sort)
  and all(.[]; .app_slug == "github-actions")
' "$REQUIRED_CHECK_SPEC" >/dev/null

all_release_checks_green() {
  local runs_file="$1"
  jq -e --arg sha "$INTEGRATED_SHA" --slurpfile spec "$REQUIRED_CHECK_SPEC" '
    . as $pages
    | [$pages[] | .check_runs[] | select(.head_sha == $sha)] as $runs
    | ($spec[0] | map(.name) | sort) as $expected_names
    | (($runs | map(.name) | unique | sort) == $expected_names)
      and all($spec[0][];
        . as $required
        | [$runs[] | select(
            .name == $required.name
            and .app.slug == $required.app_slug
          )] as $matches
        | (($matches | length) == 1)
          and all($matches[];
            .status == "completed" and .conclusion == "success"
          )
      )
  ' "$runs_file" >/dev/null
}

# Falsify the old `while`-returns-the-last-status bug: one failed early check
# plus five successful later checks must never satisfy the aggregate predicate.
MIXED_CHECK_RUNS="$EVIDENCE_DIR/mixed-check-runs-negative-control.json"
jq -n --arg sha "$INTEGRATED_SHA" --slurpfile spec "$REQUIRED_CHECK_SPEC" '
  [{check_runs: ($spec[0] | to_entries | map({
    name: .value.name,
    head_sha: $sha,
    app: {slug: .value.app_slug},
    status: "completed",
    conclusion: (if .key == 0 then "failure" else "success" end)
  }))}]
' > "$MIXED_CHECK_RUNS"
if all_release_checks_green "$MIXED_CHECK_RUNS"; then
  echo 'mixed-status negative control falsely passed' >&2
  exit 1
fi

for attempt in $(seq 1 120); do
  gh api --paginate --slurp \
    "/repos/LucasQuiles/WhatSoup/commits/$INTEGRATED_SHA/check-runs?per_page=100&filter=latest" \
    > "$CHECK_RUNS.tmp"
  mv "$CHECK_RUNS.tmp" "$CHECK_RUNS"
  if all_release_checks_green "$CHECK_RUNS"; then
    break
  fi
  test "$attempt" -lt 120
  sleep 15
done

# The exact SHA's combined rollup must independently show GitHub evaluated all
# applicable policy contexts successfully; store the raw GraphQL response.
gh api graphql -f owner=LucasQuiles -f repo=WhatSoup -f oid="$INTEGRATED_SHA" \
  -f query='query($owner:String!,$repo:String!,$oid:GitObjectID!){repository(owner:$owner,name:$repo){object(oid:$oid){... on Commit{statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion checkSuite{app{name slug}}} ... on StatusContext{context state creator{login}}}}}}}}}' \
  > "$EVIDENCE_DIR/status-check-rollup.json"
jq -e '.data.repository.object.statusCheckRollup.state == "SUCCESS"' \
  "$EVIDENCE_DIR/status-check-rollup.json" >/dev/null
```

Missing, duplicated-latest, queued beyond the bound, skipped, cancelled, neutral
where success is required, or a different `head_sha` is `Inconclusive`/`Fail`.
The mixed-status negative control, exact observed-name-set comparison, fresh
policy hash comparison, and `statusCheckRollup=SUCCESS` are all mandatory.
Store the independent read-only review at
`$EVIDENCE_DIR/integrated-review.md` with exact integrated/base/three merge SHAs,
review scope, inspected diff, commands, high/medium findings, disposition, UTC
time, and a file checksum recorded in the Step 5 receipt. Unresolved high
findings, a missing field, or any resulting code change restarts Step 5 from a
fresh fetch and new worktree.

Immediately before claiming the train verified, fetch again and require remote
main to be unchanged:

```bash
set -euo pipefail
cd "$TRAIN_ROOT"
git fetch origin main
test "$(git rev-parse origin/main)" = "$INTEGRATED_SHA"
test -z "$(git -C "$RELEASE_WORKTREE" status --porcelain=v1 --untracked-files=all)"
test "$(git -C "$RELEASE_WORKTREE" rev-parse HEAD)" = "$INTEGRATED_SHA"
test "$(git worktree list --porcelain | awk -v p="$RELEASE_WORKTREE" '
  $1 == "worktree" && $2 == p { found = 1 }
  END { print found + 0 }
')" = 1
# npm ci created only disposable ignored dependency trees in this isolated
# release worktree. After proving its exact HEAD and tracked/unignored cleanliness,
# remove the registered worktree forcibly; never use git clean.
git worktree remove --force "$RELEASE_WORKTREE"
test ! -e "$RELEASE_WORKTREE"
test "$(git worktree list --porcelain | awk -v p="$RELEASE_WORKTREE" '
  $1 == "worktree" && $2 == p { found = 1 }
  END { print found + 0 }
')" = 0
```

Expected: three exact-head PR receipts plus this one exact-main integrated
receipt. Any skipped transcription/provider test, missing dependency/browser,
masked shell failure, empty output, stale SHA, or unavailable ARC sibling
verification is an explicit `Inconclusive` gap and cannot be described as a
pass. The receipt also records the successful disposable-worktree removal and
absence from `git worktree list`. Deployment activation remains paused until remote CI and the authorized
backlog-health, replay, and terminal-smoke receipts exist.

- [ ] **Step 6: Record staging drills without publishing**

Record these exact residual checks in the PR briefs; do not perform them against a live account without explicit approval:

```text
1. Kill the process after messages INSERT but before inbound dispatch; restart and observe deferred -> processing -> terminal.
2. Saturate ingest, ChatQueue, and TurnQueue independently; observe one durable deferred row per shed message and bounded FIFO replay.
3. SIGTERM with queued turns; observe attached router enter stopping mode, queue drain/defer, awaited transport close, callback detach, then DB close.
4. Delay a Reply Guarantee transport echo past the hard send; observe submitted/open before echo and complete after echo.
5. Drop the outbound journal write before the hard send; observe no transport call and an open inbound row.
```

| Deferred staging proof | Owner | Authorization/trigger | Artifact path | Closure threshold |
|---|---|---|---|---|
| Forced crash between admission and dispatch | WS-A03 release owner | disposable staging instance and explicit mutation approval | `staging_evidence/ws-a03/crash-recovery.md` | one row replays once to terminal; DB backup retained |
| Saturated ingress/chat/agent queues | WS-A03 release owner | synthetic sender approval and isolated instance | `staging_evidence/ws-a03/queue-saturation.md` | durable FIFO backlog, bounded cap, no loss/duplicate |
| SIGTERM/service deadline | Operations owner | maintenance window | `staging_evidence/ws-a03/shutdown.md` | recorded stopping-router → drain/defer → transport → detach → DB order |
| Delayed WhatsApp echo | WS-A01 release owner | explicit live-account approval | `staging_evidence/ws-a01/delayed-echo.md` | submitted/open before echo, complete after echo |
| Live Twilio close | Transport owner | explicit Twilio staging approval | `staging_evidence/ws-a03/twilio-close.md` | shutdown promise settles and no accepted work is lost |

Until its artifact exists with the threshold met, each row stays `Inconclusive`; the named owner must re-open the release checklist when its trigger becomes available.

- [ ] **Step 7: Complete per-PR rollback and release-note receipts**

Capture the exact rollback-readiness query/result from **Blast Radius and
Rollback**, database identity/checksum, UTC timestamp, owner, every ordered
merge SHA, and every exact `git revert <merge-sha>` command. WS-A01 may revert
alone. Removing WS-A03 records and executes WS-A01 → WS-A03; removing WS-A02
records and executes WS-A01 → WS-A03 → WS-A02. After each dependency-removal
boundary run the combined affected focused matrices plus `verify:release` on the
new exact head before continuing. `incompatible_rows=0` is necessary, never
sufficient, and a nonzero result blocks removal until deliberately drained,
terminalized/migrated, or retained with a compatible consumer. Migrations 37 and
38 and their columns remain in place during product-code rollback.

The release note checklist marks each item `shipped`, `deferred` with
owner/trigger/artifact, or `unsupported`: schema/state changes; retry
ceiling/backoff; policy revalidation; invalid-row repair; health
counters/events; queue/shutdown behavior; Reply Guarantee soft/hard semantics;
operator commands; configuration/defaults; compatibility/partial deployment;
rollback; and staging gaps. No blank or “N/A” disposition is accepted without a
reason.

## Self-Review Notes

- **Spec coverage:** WS-A01 maps to Tasks 7-8, WS-A02 to Tasks 1-3, and WS-A03 to Tasks 4-6. Task 9 now defines the required exact-head and exact-main receipts, but this self-review remains `Inconclusive` until the rewritten plan is frozen and the mechanical inventory/consistency review below is rerun against that SHA.
- **Deferred-step scan:** The rewritten steps contain concrete TypeScript, SQL, Markdown, or exact replacement contracts; whether any unspecified or contradictory implementation seam remains is `Inconclusive` until the current-sha final review completes.
- **Type consistency:** Intended canonical types are one `AdmittedTurnAuthority`, exact-op `TerminalDisposition`, `InstalledBaseCompleteTurnInput` / `ProviderTerminalFinalizationInput` / `AgentNonProviderFinalizationInput` / `CompleteSystemTurnParams`, and the four durable deferral outcomes (`deferred`, `already_terminal`, `delivery_pending`, or `stale_claim`). Only exact echo is terminal delivery proof; submitted/ambiguous ownership holds the barrier or transfers durably at shutdown. Compile consistency is not claimed by this planning artifact and must be proven by the owning task typechecks.
- **Sequencing decision:** Publish and merge WS-A02 → WS-A03 → WS-A01. The tracked hard notice depends on truthful admission, replay, and shutdown semantics; no alternate A01-first train is supported.
- **Known proof gaps:** Replay derives `isGroup` from the canonical `@g.us` chat identity and reconstructs `mentionedJids`/`isResponseWorthy` from migration-37 metadata; legacy or malformed metadata fails closed. Live WhatsApp echo timing, live Twilio shutdown, filesystem-permission behavior outside deterministic SQLite simulation, and forced process crash behavior require the owned staging drills above.

## Final Review Synthesis

### Requirement traceability

| Source invariant | Plan ownership | Production surfaces | Proving evidence | Disposition |
|---|---|---|---|---|
| I1 — durable, replayable inbound admission | Tasks 1–6 (WS-A02/WS-A03) | `database.ts`, `inbound-admission.ts`, `durability.ts`, `ingest.ts`, `inbound-replay.ts`, runtime queues, `main.ts` | Migration rollback/reopen, two-connection admission contention, policy-order characterization, bounded replay exhaustion, queue rejection, and shutdown lifecycle tests | Planned; current final plan review and implementation evidence pending. |
| I2 — terminal only after durable visible outcome | Tasks 7–8 (WS-A01) | `reply-guarantee.ts`, agent runtime, `outbound_ops`/echo correlation | Fake-clock soft/hard boundary, journal-failure negative test, submitted/open then echo/complete real-DB test | Planned; current final plan review, implementation, and live timing evidence pending. |
| I3 — delivery truth separate from audit truth | Sibling plans WS-A04/WS-A05 | Send pipeline and retry identity | `2026-07-09-delivery-audit-and-idempotency.md` | Out of scope here; no claim of closure. |
| I4 — unknown state remains unknown | Sibling plans WS-B01/WS-B02 and WS-C04–C06 | Health, recovery, self-update, metrics/realtime | Health/recovery and metrics-completeness plans | Out of scope here; no claim of closure. |
| I5 — metadata-only routine telemetry | Cross-cutting constraint here; primary ownership WS-A06–A08/WS-C01–C03 | Pino events and counters touched by Tasks 1–8 | Redaction/low-cardinality assertions required by Logging and Error Traceability contracts | Constrained here; broader privacy/telemetry closure belongs to sibling plans. |
| I6 — deletion at downstream boundaries | Sibling plans WS-A06–A08 | Enrichment, facts, telemetry, media | `2026-07-09-privacy-erasure-and-media-confinement.md` | Out of scope here; no claim of closure. |
| I7 — truthful UI and recovery material | Sibling plans WS-B03–B06 | Console session/send/load/update UX | `2026-07-09-console-truthful-session-update-and-send-ux.md` | Out of scope here; no claim of closure. |

### Scenario-to-proof classification

| Scenario | Primary proof class | Load-bearing check | Residual evidence state |
|---|---|---|---|
| Atomic message plus admission, including write faults | File-backed SQLite integration and fault injection | Task 2 rollback, post-rollback usability, and two-connection single-winner tests | Planned; must show semantic RED then GREEN. |
| Migration upgrade and failure recovery | File-backed migration/reopen integration | Task 1 legacy lifecycle, idempotent reopen, and injected rollback tests | Planned; migration number must be refreshed. |
| Policy/capacity ordering and queue shedding | Runtime integration plus removal-sensitive characterization | Tasks 3–5 assert current policy on both initial/replay dispatch, metadata reconstruction, processing CAS before dispatch, and durable rejection | Planned; direct-runtime mutation must make the revoke test fail. |
| Bounded deferred replay and exhaustion | File-backed integration with fake clock and mutation | Tasks 2 and 4 prove the shared cap on transport and worker paths, capped backoff, clock jumps, invalid terminalization/repair, exhaustion health, and removal mutation | Planned; broader load timing remains implementation evidence. |
| Shutdown ordering | Runtime/transport integration plus a narrow source-order guard | Task 6 drains admitted work, awaits transport close, and checks top-level order | Forced process exit and service deadline remain staging-only. |
| Reply Guarantee soft/hard delivery | Fake-clock unit plus real-DB outbound integration | Tasks 7–8 prove no completion at soft deadline or submission, and completion only after echo | Live transport echo timing remains staging-only. |
| Full integrated train | Exact-head local release, remote Quality/CodeQL, independent review | Task 9 `verify:release`, unmasked CI, and reviewed branch SHA | Cannot pass before implementation branches exist. |

### Closeout disposition

- Documentation publication status is `Inconclusive` until the rewritten plan is
  frozen, independently reviewed, and its repository gates pass. It does not
  assert that WS-A01–A03 are implemented, production-ready, or staging-proven.
- The prior 320-question bank (52 `PASS`, 23 `PARTIAL`, 12 `FAIL`, 233
  `INCONCLUSIVE`) is historical evidence only for manifest Git SHA
  `373686b3…`; its pass 27 was `Inconclusive`, and that manifest records neither
  the current plan SHA-256 nor a matching final SHA-256. None of those counts or
  dispositions proves this rewrite.
- Current structured review/question-bank, consistency, and final-review status is
  `Inconclusive` until all are rerun against one frozen file and their manifest
  records identical input/final plan SHA-256 values. Any edit after freezing
  invalidates that closeout and requires another run.
- Product implementation, real crash timing, live transport echo timing, and
  forced service-stop behavior remain `Inconclusive` until Tasks 1–9 and the
  separately authorized staging drills produce exact evidence.
