# Provider-Event Lifecycle Implementation Tasks

**Status:** Active — refreshed against canonical base `482b707d716aee5641db25d40c2a954caee5d78f`, which understands migrations through 46; the current branch advances the schema to migration 47 for recovery-receipt chronology, and no provider-lifecycle implementation or deployment is authorized

**Schema allocation:** current canonical schema is migration 47; bounded terminal recovery/canonical `not_sent` is forward migration 48; the provider-event lifecycle ledger is migration 49. Migration 47 is consumed by recovery-receipt chronology, so the still-unpublished forward allocations move to migrations 48 and 49.

> **REQUIRED COMPANION SKILL:** superpowers:spec-driven-development

## Overview

- **Goal:** Replace silent post-boundary suppression with a causal, durable,
  fail-closed provider-event lifecycle that prevents unsafe fallback replay.
- **Architecture:** Provider adapters emit causal metadata into a normalized
  envelope; `DurabilityEngine` owns content-free receipts and transitions; runtime
  admission correlates live continuations; terminal/fallback paths consume a
  monotonic replay veto; existing outbound, tool, terminal, and recovery stores keep
  their current ownership.
- **Tech Stack:** TypeScript, Node.js, SQLite, Vitest, shell-based repository and
  release guards.

## Sequencing & Dependencies

1. Land this approved structured spec as a documentation-only pull request so its
   requirement/check identifiers exist on canonical `main` before implementation.
2. Schema-lineage canonicalization is merged through PR #1768
   (`cf1fc6e3e2d3faa3cae80737466f52d40e34b9bf`, reviewed head
   `1dad6a9d7171060351142f7e4e0f88146a5b8508`), restoring immutable historical
   migrations 41/42 and adding forward repair migration 43. Canonical base
   `482b707d716aee5641db25d40c2a954caee5d78f` additionally contains migrations
   44 through 46. The current branch advances the schema to migration 47 with the
   recovery-receipt chronology fence.
3. Treat #1744/#1749 as required terminal-recovery prerequisites and #1750 as an open
   taxonomy issue. Merged PR #1748 (`625b17f0`) proves a governor
   shed is a local non-send but still persists `failed_permanent` and collapses the
   terminal delivery kind to `none`; it is not durable canonical `not_sent`. Land a
   focused prerequisite PR that makes positive no-transmission truth queryable after
   restart in both lockstepped validators while generic `failed_permanent` remains
   uncertain. PR #1770 (`84ba01a04941d29becbaa4ffac274e604ee89820`, merged as
   `56e232223132d33c347cd2d2521620f911d4f4b6`) separates active recovery work
   from audit-health debt, but it does not create canonical `not_sent` or the bounded
   terminal closure. The prerequisite also gives blocked/exhausted/expired/orphaned/terminal-
   non-echoed recovery owners a five-minute fail-closed abandonment path that closes
   the inbound, preserves evidence/replay veto, and releases scope without asserting
   delivery truth. Implement that prerequisite as forward migration 48 on canonical
   schema 47; do not alter historical migrations or merge the stale
   DGX recovery branch wholesale.
4. Exact-head verify and publish the current branch's migration-47 receipt-chronology
   guard, fleet-verify schema compatibility, then land terminal recovery migration
   48. Rebase the implementation branch onto both resulting canonical merges;
   migration 49 is then available to the provider-event ledger.
5. Add and commit each task's owned failing checks immediately before that production
   slice.
6. Implement the ledger before runtime admission, then add quarantine/replay policy
   and observability.
7. Rebase onto and reverify the already-merged queue/session cancellation dependency:
   PR #1747, head `5c52f571`, merged as `77cd0718`. Any residual evidence gap gets a
   new focused PR; unpublished live-checkout shutdown commits are not part of this
   dependency and must not be folded into lifecycle work.
8. Update canonical manifests and runbooks, complete release verification and
   independent review, then merge. Deployment remains a post-merge coordinated
   operation.

## Risks & Rollback

- **Split schema lineage:** A recorded v42 database may have the original or already
  hardened shape. Migration 43 must recognize both and reject unknown partial
  fingerprints. Never delete migration rows or rewrite an applied migration.
- **Wrong-owner continuation:** Correlation uses the complete discriminated
  `CausalOwner`, provider-request identity, generation, and adapter evidence.
  Session/system events never fabricate turns; ambiguity quarantines before any
  generation/map/queue return.
- **Duplicate or partial effects:** Composite runtime event keys are unique, state
  transitions are compare-and-swap, and immutable many-to-many effect links cover
  every typed outbound/tool/presence/provider-managed/no-send seam before owned
  execution. Agent MCP calls require an exact-bound single-use non-loggable effect-
  admission token and nested effects use hierarchical plans. Composite owner/target
  constraints reject mixed-owner aggregation and cross-chat effects without a
  separate durable authorization.
- **Privacy regression:** Lifecycle storage and logs retain no raw frames, text,
  prompts, tool payloads, native IDs, derived digests, or previews. Canary tests
  scan tables, logs, alerts, and sidecars, including legacy diagnostic paths.
- **Observation gap:** A durable reserved attempt plus claim/commit gate precedes
  provider invocation; durable request segments and continuation obligations replace
  in-memory completion counts;
  lifecycle write failures stop owned effects and latch replay unsafe. Crash tests
  cover every boundary from pre-start through effect linking.
- **Fragment pressure:** Deltas coalesce into completed bounded egress batches at
  size/time/item/non-text/result boundaries; effect/boundary events do not.
  High-fragment-count tests enforce ordering, write, latency, and row budgets. Soft
  thresholds alert; globally accounted per-attempt emergency byte leases and stream backpressure stop parsing
  before capacity exhaustion while preserving in-flight evidence.
- **Fallback regression:** Replay safety is a monotonic latch. Genuine empty output
  requires `closed_safe_empty`; typed pre-execution rejection uses the distinct
  `closed_safe_rejected` state and never increments empty counts.
- **Provider drift:** The sanitized target CLI 2.1.207 file is a non-gating design
  specimen until TSK-002 replaces it with reproducibly captured, cryptographically
  tied evidence. A six-provider capability registry and negative version/build/field
  perturbations keep every unproved adapter path quarantined.
- **Fleet drift:** Installed artifacts are compared to repository manifests. No raw
  reinstall, state replacement, or uncoordinated restart is permitted.
- **Rollback:** After activation the runtime is roll-forward-only; before activation,
  rollback permits the immutable migration-49 marker but requires no activation row,
  zero rows across the other nine lifecycle tables, zero nonterminal inbound rows,
  zero active agent sessions, and runtime proof of no provider request/process. A downgrade
  otherwise requires full v49 write compatibility or drain/read-only rejection of
  every new provider turn. Pre-activation rollout requires a quiesced SQLite backup,
  integrity check, scratch restore proof, and checkpoint. Unresolved evidence and
  migration history are never manually/in-place deleted or rewritten. The sole
  exception is the verified preactivation whole-database restore, which returns both
  data and schema history to the exact schema-48 backup fingerprint and removes the source
  v49 row as part of that atomic state replacement. Unknown fleet fingerprints stop rollout.

## Validation Strategy

- Each active acceptance criterion has one owner and one planned `CHK-###`.
- Executable conformance tests live under the dedicated
  `tests/spec-conformance/provider-event-lifecycle/` root so this spec's generic
  REQ/CON/CHK IDs cannot collide with markers owned by other specs.
- New conformance tests include adjacent `@check CHK-###` and
  `@traces REQ/CON-###.AC-##` marker lines.
- TDD evidence records the exact failing assertion before each production slice and
  the exact passing command after it.
- Plan, execution, and final traceability lint run from the structured spec tooling.
- Verification includes focused tests, migration matrices, privacy/log assertions,
  type checking, test-integrity, repository/publication/manifest guards, the full
  release gate, exact-head local review, independent spec review, and independent
  code-quality/security review.

---

## Tasks

#### TSK-010: Land migration-48 canonical terminal no-send/recovery-owner prerequisites
- **Status:** pending — canonical base includes migrations through 46 and the current branch consumes migration 47 for receipt chronology; canonical `not_sent`, bounded terminal closure, and migration 48 remain absent
- **Traces-from:** REQ-006, CON-002, CON-004, DES-006
- **Owns-AC:** REQ-006.AC-06, CON-002.AC-06, CON-004.AC-07
- **Checks:** CHK-075, CHK-076, CHK-078
- **Steps:**
  - [x] Record PR #1770 reviewed head
    `84ba01a04941d29becbaa4ffac274e604ee89820`, merged as
    `56e232223132d33c347cd2d2521620f911d4f4b6`. It separates active recovery
    work from unresolved audit-health debt and is a required baseline correction,
    but it does not satisfy TSK-010's durable no-send or terminal-closure criteria.
  - [ ] Add the marked `CHK-075`/`CHK-076`/`CHK-078` RED cases against canonical main before production
    changes. Record merged PR #1748 (`625b17f0`) as a partial classification fix only:
    governor shed becomes runtime `not_sent`, but the operation remains
    `failed_permanent` and terminal persistence becomes `none`. Record #1744/#1749 as
    required recovery prerequisites and #1750 as a separate open taxonomy issue.
  - [ ] In a focused prerequisite PR, add a durable typed `not_sent` operation/
    terminal state (or another reviewed durable positive no-transmission proof) and
    update both lockstepped terminal validators plus restart recovery queries. Add an
    exact idempotent terminal-non-echoed/`abandoned_unsafe`-equivalent transaction and
    reachable audited operator resolver. Within the exported five-minute maximum it
    must preserve the outbound op, terminal record, job history, and replay veto;
    close the inbound as failed-uncertain without asserting delivery truth; and
    release scope. Only active, unexpired progress may block admission. Prove generic
    `failed_permanent` is not accepted as no-transmission truth and cannot cause a
    repeating durable-failure incident.
  - [ ] Reserve `outbound_ops.status='not_sent'` for typed pre-send rejection and keep
    the exact op ID/status in terminal `deliveryKind=not_sent`. Migration 48 permits
    terminal aggregate no-send only for positively proved single-op answers; 1:N stays
    partial/uncertain until migration 49's immutable sealed expected set proves every
    required sibling not-sent. Cover missing/late-created siblings and crash-between-
    chunks; any echoed/submitted/maybe-sent/pending/sending/quarantined/generic-failure
    sibling dominates. Prove no-send never clears provider/tool/lifecycle replay veto.
  - [ ] Base this work on canonical schema 47 and allocate forward migration 48 for
    canonical outbound/terminal `not_sent`, immutable transfer
    deadlines, and append-only `turn_recovery_terminal_closures` witnesses. The unique
    witness retains exact terminal/job/inbound/op identity, nullable job for valid
    orphans, closure/trigger/resolver/proof fields, deadline, timestamp, and fixed
    replay-never policy. Reuse the exact-witness/idempotent-replay/fail-closed test
    patterns from the prior recovery line only after diffing them against canonical
    main; do not cherry-pick its stale migrations/catch-up implementation, freeze
    uncertain outbound status, or fabricate a claim/replay-safety proof to satisfy the
    current `completed` constraint.
  - [ ] Implement one `BEGIN IMMEDIATE` exact-identity closure transaction shared by
    startup, supervisor, admission, echo, and the audited resolver. Backfill immutable
    database-UTC transfer start/deadline no later than 300 seconds; cap claims/backoff
    at it and never extend it for progress/restart. Persist a monotonic wall-clock high-
    water mark and combine it with live monotonic elapsed time; backward time beyond
    five seconds becomes due/sticky alerted integrity failure. At canonical
    no-send, fifth-attempt exhaustion, expiry, or deadline insert/return the unique
    witness, terminalize the inbound, and release scope atomically. The resolver uses
    the existing authenticated control surface with immutable actor/request/reason/
    instance/scope binding and idempotent CAS/audit; deny unauthenticated, cross-
    instance/scope, stale, substituted, conflicting-replay, and competing requests.
    Completed witnesses
    make claim/renew/promote/reassign/requeue/worker queries ineligible while remaining
    durable history/retention roots.
  - [ ] Add a declared closure-eligibility index and migration-48 storage accounting.
    Prune oldest first only after the bound inbound, terminal, optional job, selected
    op, and every late-echo/conflict row are terminal, no live owner/reference remains,
    and the canonical cutoff passes; delete the witness last in the guarded aggregate.
    The marked `CHK-078` RED case proves unresolved, recent, owner-bearing, and
    conflict-pending witnesses never prune and that the witness is deleted last.
  - [ ] Cover `blocked_unsafe`, pending, live/expired claim, fifth-attempt exhaustion,
    canonical no-send, generic `failed_permanent`, quarantine, valid orphan, corrupt
    link, startup, transaction rollback, wall-clock rollback/high-water/restart/exact-
    deadline fake clocks, repeated progress just before deadline, duplicate resolver,
    resolver authorization/binding denials, and echo-versus-abandon races. Echo
    after abandonment records actual outbound truth/conflict without reopening the
    turn. Assert one witness winner, no replay, no evidence deletion, no false sent/
    not-sent/echo claim, no `processing` inbound excluded from every path, and no
    ordinary scope block beyond five minutes; persistence/integrity failure is sticky
    and alerted instead of silently releasing.
  - [ ] Run the focused outbound durability, finalizer, validator-lockstep, and
    recovery-owner suites; obtain review, merge the prerequisites, and record their
    exact canonical merge commit(s).
  - [ ] Rebase lifecycle implementation onto those commits. TSK-006 consumes that
    contract but must not redefine terminal outbound truth inside this PR.

#### TSK-001: Maintain canonical schema history and publish migration 47
- **Status:** in progress — canonical base `482b707d716aee5641db25d40c2a954caee5d78f` understands migrations through 46 and contains the schema-ceiling guard plus CHK-071; exact-head review, publication, and fleet verification of migration 47 remain pending
- **Traces-from:** CON-005, DES-008, DES-009
- **Owns-AC:** CON-005.AC-01, CON-005.AC-05
- **Checks:** CHK-001, CHK-071
- **Steps:**
  - [x] Merge schema-history canonicalization through PR #1768 at
    `cf1fc6e3e2d3faa3cae80737466f52d40e34b9bf` (reviewed head
    `1dad6a9d7171060351142f7e4e0f88146a5b8508`). The canonical 41-43 source was
    introduced by `a5a44230f76a29a8aa150bdbf0362bed8520004b` and its recovery-proof
    schema was attested by `807fc8210ba9999f77c13643bf205b9fbb628dcf`.
  - [x] Preserve a read-only private preflight evidence packet plus this sanitized
    tracked index. The packet inventories installed
    units/drop-ins, wrappers/symlinks and accepted local shims, managed/source
    manifests, config/env ownership and modes, active XDG auth/data/state roots,
    migration rows/schema fingerprints, provider versions, source SHA, private
    overrides, and legacy/decoy paths. Mutate none of these artifacts.
  - [x] Restore the exact final historical migration-41 source and the exact
    originally deployed migration-42 source without changing their DDL; add forward
    repair migration 43 with fresh/original-v42/hardened-v42/invalid-partial upgrade
    coverage. Canonical base now understands migrations through 46; historical
    migrations remain immutable.
  - [x] Add the marked `CHK-071` conformance case under
    `tests/spec-conformance/provider-event-lifecycle/` so real SQLite future-schema
    rejection and the 47/48/49 allocation remain executable against this spec.
  - [x] Add or relocate the remaining marked `CHK-001` plan-stage conformance case
    without duplicating existing migration unit coverage.
  - [x] Capture the marked `CHK-071` stale-documentation RED against the existing
    production rejection behavior. Canonical base extends
    `Database.runPendingMigrations` and agent-turn admission with a schema-ceiling
    drain/read-only gate. When database max migration exceeds the binary maximum,
    preserve backup/inspection but reject every provider turn.
  - [ ] After exact-head review and publication, deploy and verify the guard fleet-wide
    before any schema-48/49 writer; record and prohibit older pre-guard binary
    fingerprints as rollback targets.
  - [x] Preserve recovery retention roots required by the installed tables; remove
    incident-specific labels and regenerate current-main indexes/manifests only.
    Relative to canonical main, this prerequisite changes no historical
    `database-migration-*.ts`, recovery-pruning, or retention-policy source. The
    regenerated tracked work index and the current runtime manifest contain no
    incident chat, sequence, or private-path identifiers.
  - [ ] Run the focused migration/recovery suite, `npm run typecheck:all`,
    `npm run guard:test-integrity`, and `npm run verify:release` through
    `scripts/run-with-pinned-npm.sh`.
  - [ ] Obtain exact-head local and independent review for migration 47, publish it
    as a focused pull request, wait for required checks, merge it, and record its
    canonical merge hash separately from PR #1768.
  - [ ] After TSK-010 also merges migration 48, rebase this lifecycle branch onto both
    exact prerequisite merge commits before TSK-002; do not begin fixtures on the
    intermediate migration-47-only base.

#### TSK-002: Add the sanitized fixture corpus and conformance scaffolding
- **Status:** pending
- **Traces-from:** REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, CON-001, CON-003
- **Owns-AC:**
- **Checks:**
- **Steps:**
  - [ ] Add sanitized fixtures under
    `tests/fixtures/provider-event-lifecycle/` for background registration,
    intermediate result, correlated completion, parent answer, genuine reminder,
    duplicate, out-of-order, parser error, missing IDs, cross-conversation,
    cross-generation, restart, native-ID reuse, provider-version drift, XML-like
    origin spoofing, obligation close/abandon, later causal final boundary, and every
    supported adapter-event variant. Start from the non-gating
    `provider-contract-claude-code-2.1.207.json` schema projection, add the exact
    sanitized DGX persistent-session ordering (registration, intermediate result,
    completion/obligation close, child output, parent answer, causal final boundary),
    and perturb each session/request/task/tool/parent/version field independently.
    Include init-before-turn, compact, serialized and interleaved FIFO lanes,
    concurrent system/user requests, concurrent parent/child identical reordered MCP
    calls, stale/missing child connection origin, invocation claim/commit crashes,
    self/cyclic/over-budget handoffs, boundary/chrome crash points, same-version/
    different-binary fingerprints, payload-cache pressure, a high-fragment-count
    stream, and 1-to-N/N-to-1 effect cases. Add separate sanitized native pre-execution-rejection fixtures for
    every adapter/version/build that may enable that capability; absence keeps it disabled.
  - [ ] Add a checked versioned content-free projection/sanitizer helper that consumes
    raw stream input only in memory, substitutes synthetic equality classes, and
    records capture source/mode, prompt-omitting command template, binary/source hash,
    raw/projected event counts, and projection version. Retain no raw capture.
  - [ ] Add common unmarked fixture loaders/factories and checked source-location
    manifests, but no broad failing conformance suite. The suppression/effect/result
    inventory covers adapter callbacks/parser exits; generation/session-key/map/queue;
    missing immutable context/inbound sequence/durability and unowned-result flush;
    shutdown/exit drain; post-result/manual/auto/silent compact; route hold/buffer;
    provider failure/auto-switch; minimal-result/`AskUserQuestion`; polls/system/
    context/recovery injection; terminal dedupe/empty normalization; text/media/voice/
    poll/reaction/presence/direct-notice/redirect/tool/nested effects; outbound echo/
    policy/queued/chunked sends; usage/cost/token/session accounting; capability/health
    counters; alerts/diagnostics; session shutdown/respawn; workspace touch/sweep; and
    auto-compact scheduling.
  - [ ] Ensure fixtures contain no operational identifiers and use a unique
    synthetic canary solely to prove non-persistence.
  - [ ] Run fixture/projector integrity tests GREEN and commit only the corpus,
    projector, manifests, and common scaffold as
    `test(agent): add causal lifecycle fixture corpus`. TSK-003 through TSK-008 each
    add and commit their own marked failing `CHK` cases immediately before the
    corresponding production slice, so no task inherits an ownerless broad RED suite.

#### TSK-003: Add migration 49 and the durable receipt ledger
- **Status:** pending
- **Traces-from:** REQ-002, CON-001, CON-002, CON-004, CON-007, DES-002, DES-003
- **Owns-AC:** REQ-002.AC-03, REQ-002.AC-13, CON-001.AC-01, CON-001.AC-03, CON-002.AC-01, CON-002.AC-02, CON-002.AC-03, CON-002.AC-07, CON-004.AC-01, CON-004.AC-02, CON-004.AC-03, CON-004.AC-04, CON-004.AC-05, CON-004.AC-06, CON-007.AC-01, CON-007.AC-03
- **Checks:** CHK-004, CHK-072, CHK-011, CHK-012, CHK-013, CHK-014, CHK-080, CHK-048, CHK-049, CHK-050, CHK-051, CHK-052, CHK-053, CHK-066, CHK-068, CHK-070
- **Steps:**
  - [ ] Add only TSK-003's marked migration/durability `CHK` cases from the fixture
    scaffold, run them to capture the expected RED assertions, and commit that RED
    slice before changing production schema or durability code.
  - [ ] Add `src/core/database-migration-49.ts` and register it in
    `src/core/database.ts`; create an initially empty
    `provider_lifecycle_activation` plus content-free `provider_request_attempts`,
    immutable `provider_attempt_handoffs`, append-only `provider_request_segments`
    and `provider_continuation_obligations`, `provider_event_receipts`, append-only
    `provider_event_transitions`, sealed `provider_event_effect_plans`, immutable many-
    to-many `provider_event_effect_links`, and `provider_effect_authorizations` with
    bounded checks, non-null owner token/discriminator, variant sentinels, null-safe
    composite owner/attempt/segment/target foreign keys/triggers, valid-state
    enforcement, composite runtime uniqueness, controlled retention, and exact-owner/
    open/capacity indexes.
  - [ ] Add primitive activation/attempt/handoff/segment/obligation/receipt/
    transition/effect-plan/link/authorization contracts and random opaque runtime
    identity generation in `src/core/provider-event-lifecycle.ts`;
    persist no payload/native-ID digest.
  - [ ] Extend `src/core/durability.ts` with storage-only open/close-attempt,
    invocation claim/commit, segment/obligation start/close/abandon, observe,
    transition, atomic bounded acyclic attempt-handoff/destination-capacity/next-
    attempt reservation, atomic create-complete effect-plan with per-kind cardinalities
    and immutable already-sealed plan inserted last under deferred exact foreign keys,
    exact-owner/single-target/authorized-redirect
    summary, inspection, deterministic policy tombstone, guarded shared-plan/
    receipt/terminal-attempt aggregate prune, capacity, and startup-reconciliation
    methods using the existing database transaction.
  - [ ] Install a connection-level SQLite `setAuthorizer` with private synchronous,
    re-entry-guarded operation capabilities over only the ten protected lifecycle
    tables: each create/mutation method declares its exact INSERT manifest; transition
    mode allows exact attempt phase/state/lease, receipt-state, and single-use
    authorization-consume CAS UPDATE plus only its paired transition INSERT and no
    DELETE; segment/obligation
    closure and receipt transitions append rows, and immutable plans insert already
    sealed. Prune mode allows only the guarded ordered DELETE set and no unrelated
    UPDATE. Existing outbound/tool/inbound/session/terminal APIs remain under their
    current constraints and a lifecycle mode cannot broaden them. Reinstall the applicable
    authorizer on entry and deny-by-default in `finally`; freshly prepare/fully execute
    via `.run()`/discard every mutating statement within that exact synchronous scope.
    Forbid mutating `RETURNING`, iterator/cursor APIs, partial stepping, and arbitrary
    callbacks; never cache, return, capture, or reuse a statement across mode/scope
    boundaries. Keep both capabilities unexported.
  - [ ] Integrate lifecycle root predicates and guarded ordering into
    `src/core/database-retention.ts`; existing outbound/tool cleanup must use
    `NOT EXISTS` lifecycle-root predicates and cannot erase linked evidence first.
  - [ ] Complete the marked migration and durability conformance tests with
    the exact checks listed above mapped one-to-one to the owned criteria.
  - [ ] Prove invalid/reverse transitions, duplicate composite event keys, oversized
    values, raw/alternate prepared INSERT/UPDATE/DELETE, fabricated receipt/transition/
    plan/link history, transition/current-state skew, prepare-under-transition/run-after-
    scope, prepare-under-prune/run-after-scope, cross-mode execution, cached-statement
    reuse, active `UPDATE/DELETE ... RETURNING` iterator after exit, nested
    authorization/re-entry, ordinary non-lifecycle outbound/tool/terminal writes,
    lifecycle-scope attempts to broaden those writes, unsafe prune ordering/recovery roots, live
    attempt-handoff roots, cross-mode authorizer misuse, shared-plan partial eligibility, missing or
    unsealed/cardinality-mismatched 1-to-N/N-to-1 effect plans, mixed owner/target raw
    SQL (including NULL-injection cases), unauthorized redirects, invalid invocation claim/commit transitions, cyclic/
    self/over-budget handoffs, cross-plan receipt membership, duplicate/out-of-order segment/obligation closure,
    crash-abandonment/final-boundary races, and non-readmittable restart/generation
    quarantines fail without partial state. Prove terminal
    attempts prune last only after all children/cutoffs/roots clear and the canonical
    30-day/default, 1-day-minimum retention window passes; unresolved state never
    age-prunes. Prove unresolved storage API accounting across the nine work tables
    plus byte leases, total accounting across all ten lifecycle tables, maximum 256
    open attempts, 64-KiB per-attempt/16-MiB global emergency-pool accounting, exact-cardinality/destination
    reservation, `soft + reserve <= hard`,
    `max_open * emergency_bytes <= emergency_pool <= residual_reserve`, the
    40,000/10,000/50,000 unresolved and
    400,000/500,000 total-row admission limits, one plan per receipt, 128-receipt/256-effect/1,024-link/
    256-authorization plan maxima, six transitions and one readmission per receipt,
    4,096-mutation/4-MiB-encoded/32-MiB-projected transaction maxima, 1/2-GiB
    aggregate main+WAL+SHM admission thresholds, 64-MiB residual reserve, 1-GiB
    free-space floor, bounded passive-checkpoint/pinned-reader behavior, prune-before-
    reject behavior, and all field/cache constants. The projected-allocation tests
    enumerate base/index/trigger/page-split/WAL-frame/SHM growth, reject unknown/
    overflow before writing, and cover boundary math, largest bounded effect-plan/
    prune transactions, page-split amplification, deliberate over-cap rejection, and
    post-commit backpressure, the schema-tested worst-case atomic-aggregate inequality,
    maximally populated aggregate prune, state-path property bound, serialized emergency-CAS use/release, concurrent abort
    storms, and two-connection `BEGIN IMMEDIATE` competing reservations with under-lock
    remeasurement. Checkpoint tests inspect exact WAL/backfill/page-size state and
    project aggregate growth for no more than 4,096 frames/32 MiB under the serialized
    lock while preserving residual reserve; use a proved cancellable 250-ms primitive
    or skip before invocation, alert, and reject/backpressure. Cover a large WAL with
    new pages plus a pinned reader where checkpointing temporarily increases aggregate
    bytes, unavailable cancellation, unknown projection metadata, timeout, and
    post-checkpoint remeasurement; never force/restart/truncate. Real provider-start
    gating and stream-reader backpressure belong to TSK-004; real effect-seam
    transactions belong to TSK-005 and cannot be satisfied here with mocks.
  - [ ] Run migration, durability, schema, and typecheck suites until GREEN.
  - [ ] Commit as `feat(durability): add provider-event receipt ledger`.

#### TSK-004: Normalize envelopes and correlate live continuations
- **Status:** pending
- **Traces-from:** REQ-001, REQ-002, REQ-003, CON-003, CON-007, DES-001, DES-004
- **Owns-AC:** REQ-001.AC-01, REQ-001.AC-02, REQ-001.AC-03, REQ-001.AC-04, REQ-001.AC-05, REQ-002.AC-01, REQ-003.AC-01, REQ-003.AC-02, REQ-003.AC-04, REQ-003.AC-05, REQ-003.AC-06, CON-003.AC-01, CON-003.AC-02, CON-003.AC-03, CON-007.AC-02, CON-007.AC-04
- **Checks:** CHK-015, CHK-016, CHK-017, CHK-018, CHK-055, CHK-002, CHK-019, CHK-020, CHK-022, CHK-059, CHK-077, CHK-023, CHK-024, CHK-065, CHK-069, CHK-073
- **Steps:**
  - [ ] Add only TSK-004's marked parser/envelope/continuation `CHK` cases, run them
    RED against current behavior, and commit that failing slice before production
    parser or runtime changes.
  - [ ] Extend `src/runtimes/agent/stream-parser.ts` to retain optional
    transient provider-native causal metadata, classify the complete `AgentEvent`
    union exhaustively, and emit bounded unknown/parser-error events without raw
    frame diagnostics.
  - [ ] Add `src/runtimes/agent/provider-event-envelope.ts` for runtime request
    attempt/segment IDs, event ordinals, the `logical_turn | system_request |
    session_generation` `CausalOwner` union, bounded kind/origin, lengths/fragment
    counts, random opaque correlation tokens, and transient adapter evidence.
    Coalesce contiguous deltas using the exported 16,384-byte/256-fragment/250-ms
    limits and item/non-text/result flush rules before owned egress.
  - [ ] Thread the provider-request context through
    `src/runtimes/agent/session.ts`,
    `src/runtimes/agent/runtime-turn-coordinator.ts`, and
    `src/runtimes/agent/runtime.ts`. Normalize/observe before superseded-generation,
    session-key, map, queue, missing immutable runtime context/inbound sequence/
    durability, unowned-result flush, shutdown, and route guards. Integrate the real
    provider-start seam with attempt reserve/claim/commit and the real stream reader
    with capacity backpressure/typed abort before callback; these checks use the
    actual durability API, not storage mocks. Replace per-scope system-result counters
    with immutable FIFO system-request identities only for fixture-proved strictly
    serialized/non-interleaving lanes; otherwise missing request binding quarantines.
  - [ ] Add `src/runtimes/agent/provider-continuation-registry.ts` for
    same-generation live correlation backed by durable request-segment and
    continuation-obligation start/close/abandon APIs. Append start before scheduling
    runtime-managed/API work. For un-interposable CLI work, persist the observed
    registration before any subsequent event/effect; write failure records/latches
    already-effectful/uncertain, aborts transport, and vetoes replay. Exact duplicate/
    out-of-order terminal events cannot close another row. Mint child
    request segments for provider-internal passes; require native kind/origin and
    tested adapter/provider version/build contract. Content tags alone never register
    or close work.
  - [ ] Add a versioned capability registry and contract adapters for all six
    canonical providers. Wire both direct API emitters and CLI parsers through the
    same lifecycle boundary; gate CLI capabilities on semantic version plus exact
    executable/source SHA-256 and direct APIs on immutable SDK/event-schema contract
    fingerprint. Use TSK-002's reproducibly captured replacement target
    CLI 2.1.207 golden plus sanitized DGX ordering and one-field perturbation
    negatives. Keep a separate
    native-pre-execution-rejection capability bit disabled unless that exact adapter/
    version/build has its own sanitized no-activity rejection contract fixture.
    Add a separate exact `causal_finality` capability defining either stream EOF plus
    drained decoder/callback queue or a native terminal event proved to follow every
    continuation registration/actionable frame. Require it for every successful invoked-
    attempt closure (including `closed_with_evidence`), every handoff, and logical-turn
    finalization. Streaming effects may execute earlier, but terminal CAS, queue cleanup,
    logical-turn publication, and fallback cannot. A result, zero known obligations,
    idle timer, or empty queue alone is not finality. An explicit transport crash/error
    may close failed-uncertain without claiming finality; provider-never-crossed runtime
    rejection is the sole successful-closure exemption. On barrier crossing append an
    immutable `attempt_finality` receipt carrying bounded finality kind, exact capability
    contract fingerprint/version, owner/attempt/request segment, event ordinal, runtime
    epoch, and proof time. The close/handoff transaction references and consumes that
    exact receipt; missing, forged, stale-epoch, cross-attempt, or cross-segment proof
    fails, and restart revalidates rather than infers it from closed state.
  - [ ] For un-interposable CLI registration, require the exact build-gated fixture to
    prove registration precedes all completion/final frames. Block the registration
    durability call while the fixture schedules work and emits later frames; prove no
    later frame/effect, successful obligation closure, fallback, or replay crosses
    the blocked boundary. Add real stream tests where a pinned reader inflates WAL and
    external disk use crosses the free-space reserve after provider start; the next
    callback/effect/handoff reservation aborts before parse/effect and reports each
    storage component. Inject `ENOSPC`/`SQLITE_FULL` after a passing projection and
    prove atomic rollback, transport abort, exclusive use of the leased emergency CAS,
    and—if that CAS also fails—the open invocation-committed row remains the durable
    replay veto consumed by startup reconciliation before any later effect.
    Add the marked `CHK-077` fixture: emit result with zero known obligations, hold the
    finality barrier, then emit delayed registration/text/tool frames both with and
    without earlier visible output/tool evidence and prove no successful attempt close,
    logical-turn finalization, fallback handoff, or destination invocation crosses the
    barrier. Revalidate the durable finality receipt after restart; missing/drifted/
    forged/stale/cross-attempt proof closes failed-uncertain.
  - [ ] Structurally inventory every side effect in
    `src/runtimes/agent/runtime-turn-result-handler.ts` and classify it as
    request-segment-safe or logical-turn-final-only. An intermediate result closes
    only its segment. Segment usage/cost/token/session accounting and explicitly
    segment-scoped capability/health diagnostics commit exactly once. Queue/notices
    flush/end, tool/watchdog/tracker clearing, assistant/voice/route buffers,
    workspace touch/sweep, compact baselines and auto-compact scheduling, turn-level
    capability/health outcome, alerts, session shutdown/respawn, fallback, reply
    guarantee, post-result admission, empty/fallback accounting, and terminal
    publication defer until a later causally final provider boundary is consumed with
    zero durable obligations/segments. Obligation close transitions only its exact
    durable row and cannot finalize. Remove the host Set's arm/delete contract.
  - [ ] Complete parser and lifecycle tests with the exact checks listed above
    mapped one-to-one to the owned criteria.
  - [ ] Prove absent/partial IDs do not fabricate evidence, reused IDs do not cross
    generations, unknown provider versions quarantine, XML-like user/tool-result
    content cannot spoof origin, and adapters without proved capabilities fail
    closed without changing ordinary in-boundary behavior. Include same-version/
    different-hash, unavailable-hash, API-schema drift, interleaved FIFO, competing
    invocation claims, crash-before/after invocation commit, duplicate/out-of-order
    obligation close, crash abandonment, and boundary-race fixtures. Prove task/
    control and child output are classified with exact internal origin for TSK-005;
    TSK-004 does not satisfy sealed no-send/effect behavior with a mock.
    Cover no-item-ID,
    timer/size/boundary flush, and crash-with-incomplete-batch semantics; enforce
    high-fragment row/write/ordering budget and the pinned 50-ms p95 per-completed-
    batch benchmark.
  - [ ] Run parser, session, coordinator, runtime, and lifecycle tests until GREEN.
  - [ ] Commit as `fix(agent): correlate provider continuations by turn`.

#### TSK-005: Replace every silent exit with a durable disposition
- **Status:** pending
- **Traces-from:** REQ-002, REQ-003, REQ-004, CON-002, DES-003, DES-005
- **Owns-AC:** REQ-002.AC-02, REQ-002.AC-05, REQ-002.AC-06, REQ-002.AC-08, REQ-002.AC-09, REQ-002.AC-11, REQ-002.AC-12, REQ-003.AC-03, REQ-004.AC-01, REQ-004.AC-02, REQ-004.AC-03, REQ-004.AC-04, REQ-004.AC-05, REQ-004.AC-06, REQ-004.AC-07, CON-002.AC-05
- **Checks:** CHK-003, CHK-006, CHK-007, CHK-009, CHK-010, CHK-057, CHK-058, CHK-021, CHK-025, CHK-026, CHK-027, CHK-028, CHK-029, CHK-054, CHK-060, CHK-074
- **Steps:**
  - [ ] Add only TSK-005's marked admission/effect `CHK` cases, capture their expected
    RED failures, and commit that failing slice before changing production admission,
    outbound, tool, or MCP code.
  - [ ] Add `src/runtimes/agent/provider-event-admission.ts` with bounded reason,
    proof, actor, and replay-policy enums plus deterministic state decisions.
  - [ ] Remove every shared, singleton, and per-chat `postTurnGate` branch and its
    arm/delete sites. Replace the checked source-location inventory from adapter
    callback/parser through generation/session-key/map/queue, missing immutable
    context/inbound sequence/durability, unowned-result flush, and shutdown guards,
    `src/runtimes/agent/runtime.ts`, result handling, route/compact/provider gates,
    minimal-result/`AskUserQuestion`, terminal dedupe, empty normalization, and
    `src/runtimes/agent/outbound-queue.ts` with observe/admit/quarantine/tombstone or
    typed no-send calls; no actionable branch may log and discard.
  - [ ] Carry receipt identity through queued text and every split chunk. Link all
    text, media/voice, poll, reaction, presence/typing, direct notice, redirected tool status, and
    nested tool outbound operations for 1-to-N output and all contributing receipts
    for N-to-1 aggregation through an atomically complete per-kind sealed effect plan
    before first effect. Reject more than 1,024 links and any unavailable/over-limit
    row, encoded-input, or projected-allocation proof before the transaction/first
    effect; do not partially seal or split a logical plan. Enforce at most one plan per
    receipt; mint a new `runtime_intent` receipt for child/dynamic effects. Classify every link as `provider_activity` or
    `runtime_terminal_chrome`; provider output/tool/internal-child/policy-no-send uses
    the former, while presence and automatic fallback/no-response/error notices use
    the latter. Record crash-before/after each effect, retry, truncation,
    partial-send, echo, and policy outcomes. Prove terminal presence sent/not-sent/
    uncertain is exact-targeted, never recovered, never reply-satisfying, and does
    not prevent a genuinely empty provider attempt from closing safe-empty. Create a
    `runtime_intent` receipt/plan before pre-provider presence and a separately sealed
    child plan for every refresh/nested dynamic effect; enforce 120-refresh/ten-minute
    bounds and never grow a sealed plan.
  - [ ] Extend `src/mcp/types.ts`, `src/mcp/socket-server.ts`,
    `src/mcp/registry.ts`, `src/runtimes/agent/providers/mcp-bridge.ts`, both managed
    API providers, and CLI socket wiring with explicit execution origin and
    cryptographically unguessable, non-loggable, exact-bound, single-use effect-
    admission tokens. Atomically bind/consume owner, generation, attempt, exact
    request segment, receipt/plan, tool intent, and origin; missing/substituted/reused tokens fail without
    handler execution, while concurrent retry reconciles the existing durable effect.
    Authenticated operator recovery remains a distinct audited origin. Enforce the
    owner/effect matrix before the handler: system/session/control and unproved child
    origins are no-send/no-effect; child CLI calls execute only when a version/build-
    gated pre-handler connection field proves the exact segment and tool policy
    permits it. Treat CLI MCP socket receipt as authoritative execution evidence;
    join later stdout only by that native field, otherwise record stdout independently
    as already-effectful/uncertain. Test wrong tool/owner/generation/segment, stale or
    missing connection origin, concurrent parent/child calls with identical arguments
    and reordered completion, reuse, and token absence from MCP errors/logs.
  - [ ] Enforce one owner and one target per real effect plan through the production
    outbound/tool seams. Default to the immutable logical-turn target; require a
    separate exact durable authorization for redirect/cross-chat effects, and reject
    mixed-owner/mixed-target N-to-1 aggregation before any operation is created.
    Admitted task/control frames update internal state only; exact child output seals
    `internal_child_output` no-send and cannot satisfy reply or egress.
  - [ ] Permit quarantine-to-admission only with new exact same-generation evidence;
    implement the 1-MiB/event, 32-MiB/1,024-entry readmittable cache with fail-closed
    eviction/release/zeroization and no disk spill. Permit tombstoning only through
    the closed deterministic adapter/version/build/event-
    kind policy enum and expected-state CAS. Add no operator mutation command; human-
    only judgments remain quarantined for a separately reviewed control plane.
  - [ ] Keep open quarantine protected from TTL cleanup and prevent tombstones from
    delivery, execution, reattachment, or replay.
  - [ ] Complete lifecycle tests with the exact checks listed above mapped one-to-
    one to the owned criteria. Include managed API, CLI MCP, missing-owner,
    durability-failure, operator-recovery separation, owner/target redirect denial,
    bounded dynamic presence, payload-cache eviction, nested-outbound, and crash
    boundaries. These tests exercise real operation creation/plan sealing in the
    shared database transaction rather than storage-only mocks.
  - [ ] Run lifecycle, runtime, durability, and duplicate/race tests until GREEN.
  - [ ] Commit as `fix(agent): quarantine ambiguous provider events`.

#### TSK-006: Integrate monotonic replay veto and restart reconciliation
- **Status:** pending
- **Traces-from:** REQ-002, REQ-005, REQ-006, CON-002, DES-006
- **Owns-AC:** REQ-002.AC-04, REQ-002.AC-07, REQ-002.AC-10, REQ-005.AC-01, REQ-005.AC-02, REQ-005.AC-03, REQ-005.AC-04, REQ-005.AC-05, REQ-005.AC-06, REQ-006.AC-01, REQ-006.AC-02, REQ-006.AC-03, REQ-006.AC-04, REQ-006.AC-05, REQ-006.AC-07, CON-002.AC-04
- **Checks:** CHK-005, CHK-008, CHK-056, CHK-030, CHK-031, CHK-032, CHK-033, CHK-034, CHK-061, CHK-035, CHK-036, CHK-037, CHK-038, CHK-062, CHK-064, CHK-079
- **Steps:**
  - [ ] Add only TSK-006's marked closure/replay/recovery `CHK` cases, capture their
    expected RED failures, and commit that failing slice before production finalizer,
    fallback, or recovery changes.
  - [ ] Extend `src/runtimes/agent/runtime-turn-context.ts` with two independent
    gates: an `unsafeEvidence` latch that only moves false-to-true and an
    attempt-completeness blocker that is removed only by terminal attempt closure;
    closing safely never clears unsafe evidence.
  - [ ] Update `src/runtimes/agent/runtime-turn-result-handler.ts` and fallback
    activation paths in `src/runtimes/agent/runtime.ts` to require
    `closed_safe_empty` plus safe summary for empty-output, or the distinct
    `closed_safe_rejected` state plus version/build-gated native pre-execution proof
    and a separate typed, policy-allowed rejection reason for fallback. Every invoked
    attempt also revalidates TSK-004's exact causal-finality barrier before safe close/
    handoff; only provider-never-crossed runtime rejection is exempt. Conflated/
    unknown `admission_rejected`, `queue_full`, `queue_halted`, `queue_closed`,
    `pre_dispatch_failure`, and `scope_blocked_recovery` never create a handoff,
    fallback, requeue, or replay. Rejection never increments empty counts; spoofed prose,
    preceding activity, version drift, network uncertainty, and ambiguous server
    errors close `failed_uncertain` and veto replay.
  - [ ] Extend `src/core/turn-finalization-contract.ts`,
    `src/runtimes/agent/turn-finalizer.ts`, the coordinator, inbound disposition,
    and result handler so one caller-owned transaction consumes each terminal
    attempt's `attempt_boundary` receipt through idempotent
    `finalizeAttemptBoundary`, selects all four
    attempt states, and commits bookkeeping. Generic receipt recovery must never
    consume a boundary. If a proved fallback/retry is selected, atomically create one
    bounded acyclic handoff, destination capacity reservation, and next reserved
    attempt under the same recovery owner/increasing ordinal and do not perform
    terminal CAS/inbound disposition. Only the final logical-turn boundary with no retry/continuation owner
    and zero obligations/segments performs terminal CAS/inbound disposition; non-turn
    owners never do. Intermediate results and obligation-close events remain open;
    duplicate/late closure cannot publish partial state or start a nested transaction.
    Fallback notices/presence cannot delay atomic handoff. Required final no-response/
    error chrome keeps the boundary admitted/attempt open until truth settles, then
    recovery re-enters the same finalizer.
  - [ ] For a causally terminal provider error/crash with open background work,
    targeted-invalidate/abort only that attempt/session generation, atomically mark
    remaining obligations/segments abandoned-uncertain, close `failed_uncertain`, and
    terminalize only the logical owner as failure. Quarantine racing old-generation
    child output; do not call the separate broad queue/session cancellation path.
  - [ ] Add RED cases proving a provider-never-invoked safe rejection creates a
    typed runtime boundary under the open attempt/exact owner and atomically appends
    observed/admitted/consumed transitions plus invocation-gate proof during closure;
    no-frame absence, partial boundary persistence, and spoofed rejection remain
    `failed_uncertain`.
  - [ ] Invoke durability startup/shutdown reconciliation without reconstructing
    provider content. Reconcile reserved, invocation-claimed, and invocation-committed
    attempts separately: only the exact durable owner can claim/reclaim pre-commit;
    committed without terminal boundary becomes failed-uncertain and never re-invokes.
    Validate immutable chain budget/ordinal/acyclic owner and destination capacity.
    Delegate outbound/runtime-tool evidence to existing owners;
    settle sealed no-send/presence locally without re-emission; never delegate or
    re-execute provider-managed effects; and settle mixed/shared receipts consumed
    only after every typed effect owner reports compatible terminal truth. Treat
    canonical durable `not_sent` from TSK-010 as positive no-transmission evidence
    only with its exact op proof and all required sibling operations not-sent; generic
    `failed_permanent` and mixed/ambiguous siblings remain uncertain. Never clear an
    independent provider/tool/lifecycle replay veto. Otherwise idempotently quarantine
    and preserve the recovery root.
  - [ ] Complete runtime-context, result-handler, fallback, restart, finalization,
    and lifecycle tests with the exact checks listed above mapped one-to-one to the
    owned criteria. Cover each terminal state, duplicate CAS, late-event race,
    crash between closure/publication, obligation-close-before-parent-answer, child-
    only no-send without reply satisfaction, safe-empty/rejected-to-fallback attempt
    handoff, fallback failure, competing invocation claims, self/cyclic/over-budget
    handoffs, configuration drift, capacity reservation failure, crash before/after
    claim/commit and source close/destination invocation, duplicate scheduler
    rejection, final answer exactly once, terminal crash/error with open background
    work plus completion race, downstream settlement for every effect kind and mixed/
    shared plans, and restart.
    Include genuinely empty turns with each terminal presence outcome and prove the
    normal empty/fallback threshold remains available. Add empty-plus-no-response,
    rejected-plus-fallback-notice, and runtime-error-notice cases proving chrome
    delivery is sealed/reconciled without rewriting provider attempt state. Add crash
    cases before/after chrome settlement and before/after boundary finalization,
    proving generic recovery never consumes the boundary and fallback handoff is not
    chrome-blocked.
    Add negative admission-rejection fixtures for queue-full/halted/closed, pre-
    dispatch failure, scope-blocked recovery, and unknown/conflated taxonomy; each may
    terminalize safely but cannot create a fallback handoff.
  - [ ] Prove every veto source is monotonic, crash at every provider/observe/link
    boundary remains unsafe, genuine positively closed empty turns preserve the
    existing threshold, every injected lifecycle write/read failure blocks owned
    effects/empty/fallback without catch-and-default, and restart/generation
    rotation cannot reconsume events.
  - [ ] Run `runtime-turn-context`, `runtime-turn-result-handler`,
    `provider-fallback`, `fallback-empty-output-arms`, durability-recovery, and
    lifecycle suites until GREEN.
  - [ ] Commit as `fix(agent): veto unsafe replay from event evidence`.

#### TSK-007: Add content-free diagnostics and privacy enforcement
- **Status:** pending
- **Traces-from:** REQ-007, CON-001, DES-007
- **Owns-AC:** REQ-007.AC-01, REQ-007.AC-02, REQ-007.AC-03, REQ-007.AC-04, REQ-007.AC-05, CON-001.AC-02
- **Checks:** CHK-039, CHK-040, CHK-041, CHK-042, CHK-063, CHK-043
- **Steps:**
  - [ ] Add only TSK-007's marked diagnostics/privacy `CHK` cases, capture their
    expected RED failures, and commit that failing slice before production logging,
    health, or inspection changes.
  - [ ] Add structured lifecycle logs at observe/transition/veto sites using receipt,
    bounded state/reason, owner discriminator, and the approved redacted/hashed
    runtime correlation projection. Never emit exact owner, conversation key, raw
    chat/JID, provider-native ID, or effect-admission token. Emit the existing
    approved turn projection only for `logical_turn`; never fabricate it for
    `system_request` or `session_generation`.
    Remove raw/bounded previews and whole-event logging from existing
    result/tool/unknown/parser-error paths, operations alerts, and crash sidecars.
  - [ ] Extend agent runtime health statistics with open/current-state and bounded
    reason counts sourced from `DurabilityEngine`.
  - [ ] Add inspection methods by receipt and exact `CausalOwner`; do not add a
    content-replay, admission, tombstone, or general mutation endpoint.
  - [ ] Generate and review a source-location manifest for every WhatSoup-owned
    provider/parser/result/outbound/tool/terminal-dedupe/operations-alert/crash-
    sidecar/health sink. Force each with a dedicated canary and add a static guard
    for prohibited raw/preview/hash fields where mechanically detectable.
  - [ ] Add log/alert/sidecar capture, table-scan, and health-snapshot tests with the
    exact checks listed above mapped one-to-one to the owned criteria.
  - [ ] Prove the synthetic canary, frames, assistant text, prompts, and tool
    payloads, provider-native IDs, conversation/JID canaries, effect-admission tokens,
    raw SHA-256, and test-keyed digests are absent
    from lifecycle tables and every captured WhatSoup-owned diagnostic sink.
    Provider-owned transcripts and existing outbound/tool stores remain separately
    owned and are not copied into the lifecycle.
  - [ ] Expose open-quarantine age/count, readmittable-cache bytes/entries/evictions,
    attempt/receipt capacity and backpressure, total lifecycle rows, main/WAL/SHM
    bytes, passive-checkpoint/pinned-reader health, filesystem free-space margin,
    lifecycle write failures, and
    untested adapter/provider version/build fingerprints in health.
  - [ ] Run lifecycle, health, privacy, durability, and typecheck suites until GREEN.
  - [ ] Commit as `feat(agent): expose provider-event lifecycle health`.

#### TSK-008: Align manifests, runbook, and change-set boundaries
- **Status:** pending
- **Traces-from:** CON-005, CON-006, DES-008, DES-009
- **Owns-AC:** CON-005.AC-02, CON-005.AC-03, CON-005.AC-04, CON-006.AC-01, CON-006.AC-02
- **Checks:** CHK-044, CHK-045, CHK-067, CHK-046, CHK-047
- **Steps:**
  - [ ] Add only TSK-008's marked deployment/change-boundary `CHK` cases, capture
    their expected RED failures, and commit that failing slice before changing
    deployer, preflight, manifests, or runbooks.
  - [ ] Update `deploy/source-runtime-manifest.json`,
    `deploy/bot-errors-runtime-manifest.json`, and
    `deploy/managed-components.json` only where their existing ownership rules
    require changed runtime entrypoints.
  - [ ] Add the `provider-event-lifecycle` runbook under `docs/runbooks/` and its
    publication-audit classification.
  - [ ] Preserve and validate the sanitized machine-readable
    `installation-evidence-ledger.json` as an index only: resolve its private packet,
    verify the private root/file modes and SHA-256, then validate exact capture time/
    commands, path classification, symlink targets, ownership/modes, installed hashes,
    deployed commit, provider fingerprints, schema query/result, and XDG/config posture
    inside that authorized packet. Publish only boolean/delta-free pass/fail; never
    copy local posture or fingerprints into tracked files or PR output. Require rollout
    to recapture and compare privately; missing/stale evidence blocks activation.
    Explicitly ignore legacy/zero-byte DB decoys and perform no raw setup or overwrite.
  - [ ] Extend the existing deploy preflight/cutover path and managed compatibility
    metadata with a fail-closed schema-ceiling gate. Before starting a selected
    runtime artifact, it proves that artifact is v49 write-compatible; otherwise it
    keeps the instance drained/read-only and rejects all new provider turns. The
    rollback selector refuses an older unproved artifact even if it can read the
    database. Cover the empty-on-migration activation table, its atomic first-attempt
    marker, and pre-activation checkpoint rollback.
  - [ ] Complete the marked deployment conformance test with the exact
    checks listed above mapped one-to-one to the owned criteria; assert
    manifest ownership, runbook prohibitions, no content-replay surface, and the
    separate cancellation boundary.
  - [ ] Document receipt inspection, quarantine/tombstone meaning, replay veto,
    schema fingerprinting, roll-forward activation, quiesced application-consistent
    SQLite backup, source/backup integrity, scratch restore/fingerprint proof,
    pre-activation checkpoint/rollback (the sole state-replacement exception is the
    exact verified schema-48 (pre-v49) backup while still quiesced with no activation marker,
    zero rows in the other nine named lifecycle tables, zero nonterminal inbound rows,
    zero active agent sessions, and runtime proof of no provider request/process;
    the migration-49 marker may exist in the source; the whole-database restore returns
    schema history to the exact schema-48 backup fingerprint and is the sole allowed removal
    of that row; never manually/in-place delete/rewrite migration history; verify restore
    integrity/fingerprint before restart; never restore after activation),
    capacity/backpressure/storage governors, provider version/build gating, staged targeted update, and the
    prohibition on raw reinstall/state replacement/uncoordinated restart. Require a
    downgrade to be fully v49 write-compatible or drain/read-only with all new
    provider turns rejected.
  - [ ] Reverify merged PR #1747 (`5c52f571`, merge `77cd0718`) for active, pending,
    rejected, retry-owned, published-context, and non-settling teardown evidence. File
    any residual gap as a new focused PR; do not fold unpublished live-checkout
    shutdown commits into this diff.
  - [ ] Run `guard:source-runtime-drift`,
    `guard:bot-errors-runtime-manifest`, `guard:publication:all`,
    `guard:repo`, `guard:doc-drift`, `guard:doc-tally`, and manifest parity.
  - [ ] Commit manifest changes as
    `chore(deploy): track provider-event runtime sources` and documentation as
    `docs(runbook): document provider-event recovery`.

#### TSK-009: Complete traceability, release verification, review, and merge
- **Status:** pending
- **Traces-from:** REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-007, CON-001, CON-002, CON-003, CON-004, CON-005, CON-006, CON-007
- **Owns-AC:**
- **Checks:**
- **Steps:**
  - [ ] Update TSK statuses/checkboxes and run
    `traceability-lint.sh docs/superpowers/specs/provider-event-lifecycle --stage=execution --test-root=tests/spec-conformance/provider-event-lifecycle`.
  - [ ] Generate `conformance.md`, review every CHK-to-AC mapping, and run final
    traceability lint with
    `--stage=final --test-root=tests/spec-conformance/provider-event-lifecycle`.
  - [ ] Run the complete focused lifecycle/migration/fallback suite under pinned
    Node with `--pool=forks`; record exact file/test counts and commit SHA.
  - [ ] Run `npm run typecheck:all`, `npm run guard:test-integrity`,
    `npm run guard:repo`, `npm run guard:publication:all`, relevant manifest
    guards, and `npm run verify:release` through
    `scripts/run-with-pinned-npm.sh`.
  - [ ] Inspect `git diff origin/main...HEAD`, commit boundaries, authorship,
    generated artifacts, and worktree cleanliness; update only task/conformance
    evidence in a final documentation commit.
  - [ ] Request independent spec-conformance review and independent
    code-quality/security/test-integrity review against the exact head; resolve all
    findings and rerun affected verification.
  - [ ] Push the branch, open a pull request with requirement/check evidence, verify
    required GitHub checks, merge without bypass, fetch canonical `main`, and
    verify the merge commit contains the reviewed head.
  - [ ] Hand the merged commit to the coordinated targeted rollout; fingerprint each
    fleet schema first and stop on any shape other than the proved migration matrix.
