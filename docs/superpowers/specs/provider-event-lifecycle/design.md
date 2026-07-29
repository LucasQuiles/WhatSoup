# Provider-Event Lifecycle Design

**Status:** Active — refreshed against canonical base `482b707d716aee5641db25d40c2a954caee5d78f`; the current branch advances the schema to migration 47 for recovery-receipt chronology, and provider-lifecycle implementation remains blocked on the migration-48 terminal-recovery prerequisite

**Schema allocation:** current canonical schema is migration 52; bounded terminal recovery/canonical `not_sent` is forward migration 53; the provider-event lifecycle ledger is migration 54. Migrations 50 and 51 are consumed by metadata-only durability evidence and migration 52 by outbound ambiguity-episode tracking, so the still-unpublished forward allocations move to migrations 53 and 54.

## Context

The runtime currently reduces provider stream records to text, tool, or result
events and discards most causal metadata. A chat-scoped post-result boolean then
decides whether later text or tools are valid continuations or phantoms. Suppressed
events are logged but have no durable receipt, while empty-output and fallback
logic cannot distinguish true silence from discarded activity.

This documentation snapshot is based on canonical base
`482b707d716aee5641db25d40c2a954caee5d78f`. It includes the schema-history
canonicalization from PR #1768
(`cf1fc6e3e2d3faa3cae80737466f52d40e34b9bf`, reviewed head
`1dad6a9d7171060351142f7e4e0f88146a5b8508`) plus migration 44's
token-accounting separation, introduced by
`f14a53f85c490811daa3fd5d4cb1673abdd84296` and merged in PR #1790 as
`e0cfc1e12c75caaa27bbc278528b5fd5ccbb0218`; migrations 45 and 46 are now
consumed by recovery-run status and durable background work. The canonical 41-43 source was introduced by
`a5a44230f76a29a8aa150bdbf0362bed8520004b` and its recovery-proof schema was
attested by `807fc8210ba9999f77c13643bf205b9fbb628dcf`. PR #1770 separates
active recovery work from audit-health debt. The current branch consumes migration
47 for recovery-receipt chronology. Durable canonical `not_sent` and bounded
terminal recovery remain allocated to migration 48; provider lifecycle storage and
activation remain allocated to migration 49. Historical migrations are never
rewritten, and no provider-lifecycle implementation or deployment is authorized here.

The selected design replaces that boolean decision with a provider-neutral causal
envelope, a child ledger in the existing durability engine, and an explicit
disposition policy. It deliberately retains no provider content and adds no
provider-content replay path.

## Design Decisions

#### DES-001: Normalize events against immutable causal owners and request identities
- **Traces-from:** REQ-001, REQ-003, CON-003, CON-007
- **Rationale:** Each provider invocation receives a runtime-generated attempt ID
  before it starts. WhatSoup-initiated requests receive request-segment IDs at that
  point; provider-internal continuation passes receive child segment IDs, assigned
  from the parent attempt and the next segment ordinal only after a native
  continuation kind plus registered task/tool-use evidence is observed. Every
  actionable logical event carries that identity, a monotonically increasing event
  ordinal, a discriminated `CausalOwner`, bounded kind/origin, byte length,
  and nullable random opaque correlation tokens. Provider-native session, message,
  parent, task, tool-use, and item IDs exist only in the live adapter context and
  map to those random tokens; they and their digests never reach durable storage.
  Correlation also records and gates on the fixture-proven adapter capability,
  provider CLI/API version, content-free protocol-affecting launch-context fingerprint,
  and exact launch-bound executable/source/wrapper/interpreter SHA-256/identity (or
  immutable loaded API SDK/module/event-schema/negotiated-context fingerprint). At the
  invocation seam, every effective executable/script/wrapper/interpreter handle is
  opened, hashed, and pinned pre-commit; after commit the child executes only from those
  handles before any request write. An unsupported chain/provider is disabled rather
  than path-spawned. Pre-commit failure is never-invoked; post-commit exec/attestation
  failure is failed-uncertain. Replacement/symlink/TOCTOU mismatch cannot substitute bytes. Same-
  version/different-build/context and missing-proof adapters remain unproved. Content, including XML-like task notification text, is
  never origin or ownership proof. A logical-turn owner contains a complete
  `TurnIdentity`; system requests use immutable FIFO request IDs only when the exact
  adapter build/context proves a strictly serialized, non-interleaving and gap-free lane
  with exactly one terminal/abandon marker before the next accepted request; a missing/
  duplicate marker poisons FIFO attribution until generation reset. Session/control
  events use manager/generation/control-segment ownership and never fabricate an
  inbound sequence. Otherwise missing native request binding quarantines. Only
  logical-turn owners can affect user reply/fallback state.
  Normalization and observation precede generation, session-key, map, queue,
  shutdown, and route guards so an original owner receives a quarantine instead of
  a silent drop. Contiguous deltas coalesce into completed, bounded egress batches.
  Exported 16,384-byte, 256-fragment, and 250-ms limits plus non-text/result boundaries flush streams
  that lack provider item IDs; each batch's final length/count is known before its
  receipt and owned egress. Effects and request/turn boundaries remain distinct.
- **Alternatives considered:**
  - Keep a chat-scoped post-result boolean: rejected because it cannot represent
    request, task, generation, or parent ownership.
  - Correlate solely by provider-native session or message ID: rejected because IDs
    are optional, adapter-specific, and may be reused.
  - Pass raw provider objects through the runtime: rejected because it couples core
    policy to provider schemas and increases content exposure.

#### DES-002: Separate runtime envelopes from content-minimizing receipts
- **Traces-from:** REQ-001, REQ-002, CON-001
- **Rationale:** The in-memory envelope may carry the event payload long enough for
  an admitted event to be consumed, but its durable receipt stores only runtime
  identities, bounded enums, random opaque correlation tokens, lengths, timestamps,
  and disposition evidence. A composite unique key over immutable owner, attempt,
  request segment, event ordinal, and kind provides idempotency without a content-
  or native-ID-derived fingerprint. Missing native IDs and opaque tokens remain
  null. Readmittable quarantines may retain only a runtime-owned bounded byte buffer:
  at most 1 MiB per event, 32 MiB and 1,024 entries per runtime. Oversize, eviction,
  generation retirement, tombstoning, or ownership loss releases and zeroizes owned
  buffers where representable, marks the receipt non-readmittable, and never spills
  content to disk. Existing outbound/tool tables continue to own application data
  they already require; the receipt ledger never duplicates it.
- **Alternatives considered:**
  - Store raw frames for later recovery: rejected because it creates a second
    sensitive replay store.
  - Store a redacted or bounded preview: rejected because redaction is not a privacy
    boundary and previews are unnecessary for lifecycle proof.
  - Store unkeyed hashes or keyed HMACs: rejected because low-entropy content and
    native IDs remain guessable, while secret rotation adds lifecycle risk without
    improving the runtime-owned composite key.
  - Store only log lines: rejected because logs do not provide transactionality,
    uniqueness, state constraints, or recovery ownership.

#### DES-003: Add a child receipt ledger inside `DurabilityEngine`
- **Traces-from:** REQ-002, REQ-004, REQ-006, CON-002, CON-004, CON-007
- **Rationale:** Migration 54 adds one empty activation marker table plus nine
  content-free lifecycle tables: `provider_request_attempts`, immutable
  `provider_attempt_handoffs`, `provider_request_segments`,
  `provider_continuation_obligations`, `provider_event_receipts`, append-only
  `provider_event_transitions`, sealed `provider_event_effect_plans`, immutable
  `provider_event_effect_links`, and `provider_effect_authorizations`. The first
  lifecycle-enabled attempt inserts `provider_lifecycle_activation` in the same
  transaction; applying the schema alone does not activate it.

  An attempt is idempotently inserted-or-returned `open` at the exact null-safe unique
  owner/request-chain/ordinal key with invocation phase `reserved`. A bounded lease/
  owner CAS advances it to `invocation_claimed`; the claim owner commits
  `invocation_committed` before crossing the provider boundary. No worker invokes
  before commit, an expired pre-commit claim is reclaimable, and a post-commit crash
  is failed-uncertain rather than re-invoked. The original turn stores an immutable
  fallback-chain snapshot and budget (maximum eight attempts). Handoffs advance a
  strictly increasing ordinal, prohibit self/cycles, reserve destination capacity,
  and create the next reserved attempt atomically, so two workers cannot invoke one
  destination and configuration drift cannot rewrite an existing chain. Pre-commit
  reservations carry an immutable five-minute owner deadline. Positive committed-
  generation loss starts a separate immutable recovery deadline without timing out
  healthy live work. The unique attempt-boundary slot serializes provider-final,
  never-invoked owner abandonment, and committed runtime-failure abandonment; the
  recovery winner atomically abandons children uncertain and terminalizes only a
  logical owner as failure without finality/replay claims.

  Segment and obligation rows durably record start, close, and abandoned-uncertain
  transitions under exact owner/attempt/generation/task/tool binding. They—not an
  in-memory count—gate finalization and recovery. Receipts carry an explicit role,
  including `attempt_boundary`, exclusive `attempt_finality`, and runtime-generated
  `runtime_intent`; boundary/finality receipts are consumable only by
  `finalizeAttemptBoundary`. A finality receipt binds the attempt's immutable invocation
  epoch plus exact launch context/proof manifest and remains valid across restart.

  An effect plan persists one immutable owner, one immutable target, per-effect-kind,
  attempt-activity-class, and total receipt/effect/link counts. One private transaction
  creates all owned downstream rows and links, verifies cardinalities, then inserts
  the immutable already-sealed plan last under deferred exact foreign keys before the
  first effect. No unsealed plan commits or needs an UPDATE. Composite foreign keys/triggers require exact equality across owner,
  manager/generation, attempt, segment, handoff, receipt, plan, and operation. The
  attempt mints a non-null runtime owner token; every child repeats it with the owner
  discriminator and variant checks. Nonapplicable variant columns use checked non-
  null sentinels, and triggers use SQLite `IS`/`IS NOT`, so NULL cannot disable a
  composite relationship. The
  target defaults to the logical turn destination; non-turn owners have no external
  target, and an authorized redirect requires a separate exact authorization row minted
  only by a distinct authenticated routing-policy issuer; plan creation may consume but
  cannot mint it.
  Mixed-owner or mixed-target aggregation is impossible.
  A receipt may join at most one plan for its lifetime, enforced by link-insert
  triggers; it can fan out to many effects in that plan, and many receipts can
  contribute to one plan. Nested/dynamic work receives a separate `runtime_intent`
  receipt, so receipt-aggregate retention remains bounded.

  Each link is classified `provider_activity` or `runtime_terminal_chrome`.
  Provider output/tool/internal-child/policy-no-send evidence uses the former;
  automatic presence and fallback/no-response/error notices use the latter. Runtime
  chrome retains delivery truth and may delay final publication/reply satisfaction
  but cannot rewrite proved provider empty/rejected state or delay atomic fallback
  handoff. Pre-provider presence and every later refresh/nested effect is owned by a
  separately sealed `runtime_intent` child plan before execution; refreshes stop at
  120 plans or ten minutes and recovery never re-emits them.

  An attempt closes only as `closed_safe_empty`, `closed_safe_rejected`,
  `closed_with_evidence`, or `failed_uncertain`; absence of child receipts is not a
  safe closure. State changes use compare-and-swap methods and append their
  transition in one database transaction. WhatSoup-owned text, media/voice, poll,
  reaction, notice, redirect, nested outbound, split/coalesced, presence, tool, and
  no-send effects are linked before execution. Agent-owned MCP calls carry a
  cryptographically unguessable, non-loggable, exact-bound, single-use token through
  provider bridge or CLI socket and an out-of-band/non-enumerable `SessionContext`/
  `ToolRegistry` field never visible in prompts, arguments, transcripts, or errors; atomic
  consumption binds owner/generation/attempt/segment/receipt/plan/tool intent/origin.
  CLI socket evidence may authorize a child call only when a version/build-gated
  pre-handler connection field plus an already-durable child segment/obligation/parent
  intent prove the exact child and policy permits the
  origin. System/session/control, missing/stale origin, and unproved child calls fail
  before handler execution. Later stdout only corroborates by native correlation;
  name/arguments/timing/FIFO never authorize retroactively. Provider-managed activity
  that cannot be interposed is already-effectful or uncertain and permanently vetoes
  automatic replay.

  If an attempt-open write fails, the provider does not start. If any later observe,
  transition, or link write fails, the in-memory turn veto is latched before error
  handling, no new WhatSoup-owned effect/empty/fallback is admitted, the attempt is
  left open or marked failed when possible, and terminal plus health escalation is
  emitted. The durable open marker makes a crash after provider-side activity
  unsafe on restart. `turn_terminal_records` remains the only terminal owner and
  `turn_recovery_jobs` remains delivery reconciliation.

  Direct receipt/transition/effect-link mutation is unavailable. The connection's
  SQLite `setAuthorizer` uses non-exported synchronous operation capabilities and
  restores deny-by-default in `finally`: each create/mutation method declares its exact
  protected-table INSERT manifest; a distinct redirect-issuance mode permits only the
  authenticated policy authorization INSERT, while plan mode may consume but never
  insert it. Transition mode permits only the exact
  attempt/receipt/authorization CAS UPDATE plus its paired transition INSERT and no
  DELETE, while prune mode permits
  only the guarded ordered DELETE set and no unrelated UPDATE. Segment/obligation
  closure and receipt transitions are append-only; immutable effect plans are inserted
  already sealed. Deny-by-default applies to INSERT/UPDATE/DELETE only on the ten
  lifecycle-protected tables;
  ordinary non-agent outbound/tool/inbound/session/terminal APIs retain their existing
  behavior only through enumerated non-agent producer capabilities. Downstream effect
  tables are separately default-denied: `agent_lifecycle_effect` admits an agent-origin
  operation only with its same-transaction sealed plan/link manifest, and agent modules
  cannot mint non-agent provenance. Lifecycle scope cannot broaden either class. Entry/exit reinstall the applicable/deny
  authorizer; code never treats a mutable closure flag as runtime revocation because
  SQLite authorizes at statement prepare/reprepare time. Every mutating statement is
  freshly prepared, fully executed via `.run()`, and discarded synchronously within
  one non-reentrant scope. Mutating `RETURNING`, iterators/cursors, partial stepping,
  and arbitrary callbacks are forbidden; a statement is never cached, returned,
  captured, or reused across scopes/modes. The only delete
  path is an authorized `DurabilityEngine` aggregate-prune transaction that proves
  terminal receipt and linked effects, absence of recovery roots, and retention
  cutoff, then removes child transition/link/plan/authorization/receipt and terminal
  segment/obligation rows in guarded order
  before existing downstream cleanup. `src/core/database-retention.ts` applies
  lifecycle `NOT EXISTS` root predicates before its existing outbound/tool cleanup
  so downstream evidence cannot disappear first. A shared plan is pruned only after
  every linked receipt/effect qualifies. A terminal attempt is removed last only after
  all child receipts, segments, obligations, authorizations, and handoff roots are
  gone, the canonical `terminalDurabilityDays` cutoff
  (default 30 days, minimum 1) passes, and it is not a recovery root.
  Open attempts and unresolved receipts root linked evidence and are never age-
  pruned. Capacity counts each physical unresolved attempt/handoff/segment/
  obligation/receipt/transition/plan/link/authorization row plus leased units. For
  runtime-managed/API work, the start row precedes scheduling. For an un-interposable
  external CLI schedule, the callback persists registration before any subsequent
  admission/effect; failure latches already-effectful/uncertain, aborts transport, and
  vetoes replay. At
  40,000 units the instance alerts and rejects new
  attempts before invocation; 10,000 units are reserved for already-open attempts,
  with 50,000 a hard ceiling. Each open attempt materializes its durable replay-veto
  row and leases 64 KiB from a globally accounted 16-MiB emergency byte pool; at most
  256 attempts are open. Before parsing the next frame or
  creating an effect plan, the reader reserves exact cardinality; a handoff reserves
  its destination attempt capacity in the same transaction. Exhaustion applies
  backpressure before callback and aborts transport. Its serialized close CAS may use
  only the leased pool; if it cannot commit, the invocation-committed attempt remains
  durable failed-uncertain/replay-veto evidence and startup never reinvokes it. Unread
  bytes are never interpreted or replayed. Terminal
  rows also count toward total limits. Every new-attempt, callback, effect, and
  handoff/prune transaction caps itself at 4,096 physical mutations and 4 MiB encoded
  inputs, then conservatively projects base/index/trigger/page-split/WAL-frame/SHM
  growth with a documented safety factor. Unknown projection or more than 32 MiB
  projected allocation aborts before writing. The engine acquires the canonical
  serialized SQLite writer/admission lock, then remeasures aggregate main+WAL+SHM
  bytes plus filesystem free space under that lock and requires current bytes plus the
  projection to remain at least 64 MiB below the 2-GiB hard threshold, and remaining
  free space at least 64 MiB above the 1-GiB floor. The 64 MiB is residual reserve,
  not transaction capacity. The engine may prune eligible terminal aggregates only at
  invariant-safe bounded boundaries. A passive checkpoint is a separate optional
  reservation: under the serialized writer/checkpoint lock it inspects exact WAL/
  backfill/page-size state and projects main/WAL/SHM growth for at most 4,096 frames and
  32 MiB while preserving the 64-MiB residual reserve. It is invoked only through a
  proved cancellable primitive with a 250-ms budget; where the binding cannot bound or
  cancel it, or a pinned reader/unknown metadata makes the projection uncertain, the
  engine skips it, alerts health, and rejects/backpressures. External disk loss or a
  skipped/stalled checkpoint cannot authorize a forced/restart/truncating checkpoint.
  Every lifecycle-capable connection sets/verifies `wal_autocheckpoint=0`; implicit
  commit-time work is not bounded by the current binding. Close/shutdown may use only
  the same projected serialized PASSIVE-or-skip path after quiescence and otherwise
  leaves WAL recovery to next open—never FULL/RESTART/TRUNCATE.
  A second connection cannot reuse a stale pre-lock measurement.
  Post-commit remeasurement latches backpressure before another
  reservation. A crossed threshold rejects a new invocation or stops an in-flight
  stream before its next parse/effect/handoff, using only its bounded emergency CAS;
  unresolved roots are never pruned. Exact-owner/open indexes support these checks
  without scanning content.
- **Alternatives considered:**
  - Put one row per provider event in `turn_terminal_records`: rejected because it
    overloads the terminal compare-and-swap contract.
  - Generalize `turn_recovery_jobs` into a provider replay queue: rejected because
    that queue carries a narrower proof-bearing delivery contract.
  - Create a filesystem journal or second database: rejected because it splits
    transactional truth and complicates canonical deployment.

#### DES-004: Register live background work as a logical-turn obligation
- **Traces-from:** REQ-003, CON-003
- **Rationale:** A live provider-attempt context maps native task and tool-use IDs to
  random opaque tokens, but durable segment and obligation rows own their direct
  relationship. The runtime appends the segment/obligation start before scheduling
  runtime-managed or interposable API background work. An external CLI can schedule
  provider-managed work before its stdout frame is observable; the adapter callback
  persists registration before any subsequent admission/effect, but only when an
  exact version/build fixture proves registration precedes every completion/final
  frame. A write failure becomes already-effectful/uncertain, aborts transport, and
  vetoes replay. A blocked-write race may buffer no subsequent frame through the
  admission boundary and cannot close the obligation successfully. It later
  compare-and-swaps only the exact row to closed or
  abandoned-uncertain. Duplicate/out-of-order completion, crash abandonment, and a
  racing final boundary cannot decrement a counter or close another obligation. A
  provider result closes only its exact request segment while obligations remain.
  Every result-handler side effect is
  structurally classified as request-segment-safe or logical-turn-final-only. The
  request-segment-safe class records usage/cost/token/session accounting exactly once
  per segment plus explicitly segment-scoped capability/health counters and
  diagnostics. The logical-turn-final-only class includes queue/notices flush/end,
  tool/watchdog/tracker clearing, assistant/voice/route buffer clearing, workspace
  touch/sweep, compact-baseline and auto-compact scheduling, turn-level capability/
  health outcome, alerts, session shutdown/respawn, reply-guarantee satisfaction,
  post-result admission, empty accounting, and terminal publication. Every source
  seam is checked and no intermediate segment may drop or double usage/cost. Final-
  only work defers until a causally final provider boundary is consumed while zero
  durably open obligations and request segments remain. An obligation-close event
  only transitions its exact durable row and cannot independently finalize. A provider-injected completion
  receives a child request-segment ID under the original attempt and is admitted
  only when its native event kind/origin and task-to-tool-use binding match the same
  turn, manager, generation, adapter capability, tested provider version, and exact
  CLI build fingerprint or API contract fingerprint.
  User-authored or tool-result text containing identical tags cannot register or
  close an obligation. Admitted task/control frames are consumed as internal state
  evidence. Correlated child-assistant text with a non-null parent identity is sealed
  as `internal_child_output` no-send and cannot reach WhatsApp. It sets provider-
  activity/replay-veto evidence but never satisfies the external-user reply guarantee;
  control and presence frames likewise never satisfy that guarantee. Only the null-parent
  top-level answer may egress. Proved inert reminders pass through quarantine to a
  policy-proved tombstone; missing/conflicting evidence stays quarantined. PR1
  correlates only the live generation and fixture-proven adapter versions. The
  checked-in target CLI 2.1.207 specimen records a candidate native `task_started`/
  `task_notification`/child-parent shape but is non-gating because its raw-source
  provenance was not retained. TSK-002 must replace it with a reproducibly captured
  content-free golden; until then, one-field perturbation tests and the six-provider
  capability registry keep that and every other unproved adapter/version/build
  quarantined. FIFO request ownership is enabled only for a fixture-proved serialized
  lane; an interleavable lane requires native request binding.
- **Alternatives considered:**
  - Treat the first result as logical-turn completion: rejected by valid
    background-continuation sequences.
  - Keep every turn open for an arbitrary grace period: rejected because timing is
    not ownership proof and would increase latency.
  - Auto-attach a late event to the newest chat turn: rejected because it permits
    cross-generation and wrong-audience output.

#### DES-005: Use fail-closed admission, quarantine, and tombstone states
- **Traces-from:** REQ-004, REQ-005
- **Rationale:** The lifecycle is:

  ```text
  observed -> admitted -> consumed
      |           |
      v           v
  quarantined <---+
      |       \
      |        +-> admitted -> consumed  (live proof and payload only)
      v
  tombstoned
  ```

  Known-safe ownership admits; deterministic non-user lifecycle proof tombstones;
  everything ambiguous quarantines. Admission may transition back to quarantine
  only when runtime-owned effect linking fails or restart makes consumption
  uncertain. A quarantine-to-admission transition requires newly recorded exact
  same-live-generation evidence, an available entry in the bounded readmittable
  payload cache, and a readmittable reason. The cache enforces 1-MiB per-event,
  32-MiB aggregate, and 1,024-entry hard limits without disk spill. Eviction,
  oversize payloads, generation retirement, tombstoning, or buffer loss zeroizes and
  releases runtime-owned bytes where representable and permanently disables
  readmission. Each receipt has at most six monotonically numbered transitions and
  one readmission epoch; a second request remains quarantined/replay-vetoed and cannot
  grow another cycle. Restart-ambiguous and generation-mismatched quarantines can never
  re-admit. Tombstoning requires a bounded deterministic reason/proof enum and
  `replay_policy=never`. That policy forbids automatic prompt/event replay and
  reconstruction; it does not misclassify a permitted, first-time live readmission
  as replay. An unresolved quarantine cannot be expired into another state.
  This focused change exposes no operator mutation endpoint. Human-only judgments
  remain quarantined; a future operator control plane requires a separate
  authenticated protocol and review.

  Admission owns a checked source-location inventory of every suppression/no-send
  exit, including adapter callback/parsing, superseded generation, missing session
  key/map/queue, immutable runtime context, inbound sequence, durability, unowned-
  result flush, shutdown/exit drain, post-result handling, silent/manual/auto
  compact, route hold/buffer, provider failure and auto-switch, minimal-result and
  `AskUserQuestion` suppression, pending poll/system-result/context-injection/
  recovery obligations, terminal dedupe, empty normalization, outbound echo/policy,
  direct notices/redirects, presence/typing updates, and queued/chunked sends.
  Receipt identity follows each queue chunk. A policy or echo rejection records a
  typed no-send effect; a persistence failure stops the owned path rather than
  degrading to a log-only drop. The legacy `postTurnGate` Set and all arm/delete
  sites are removed rather than retained as a parallel decision model.
- **Alternatives considered:**
  - Drop policy-suppressed events after logging: rejected because it destroys the
    evidence needed by empty-output, fallback, and recovery.
  - Tombstone every post-result event: rejected because some are valid
    continuations.
  - Deliver ambiguous text while suppressing tools: rejected because wrong-audience
    text is itself an unsafe external effect.

#### DES-006: Latch replay safety and delegate downstream reconciliation
- **Traces-from:** REQ-005, REQ-006, CON-002
- **Rationale:** The existing turn replay context remains the authority, but gains
  two independent gates: an `unsafeEvidence` latch initially false and permitted
  only to move false-to-true, plus an attempt-completeness blocker while an attempt
  remains open. Closing an attempt safely removes only the completeness blocker; it
  never clears unsafe evidence. Output, tool activity,
  background work, parser uncertainty, quarantine, ambiguous ownership, delivery
  uncertainty, or post-terminal activity sets `unsafeEvidence=true` and no path can
  clear it. Empty-output requires a positive `closed_safe_empty` attempt plus a safe
  receipt summary. Typed fallback may instead use `closed_safe_rejected` only when
  provider invocation never occurred or tested native evidence proves pre-execution
  rejection with no activity and a separate typed policy-allowed reason authorizes
  fallback; that state never increments empty counters. Conflated/unknown admission
  rejection may terminalize safely but cannot hand off, fallback, requeue, or replay. Text-
  pattern errors, version drift, activity-before-rejection, and ambiguous server/
  network errors become `failed_uncertain`. Zero receipts, an open attempt, or a
  failed ledger write is unsafe.
  On restart, open attempts reconcile by invocation phase. A reserved attempt is
  claimable only by its exact durable handoff/recovery owner within the immutable
  chain budget while that owner already holds prompt/idempotency proof; an expired
  pre-commit claim is reclaimable because execution is forbidden before commit. An
  invocation-committed attempt without a terminal boundary becomes
  `failed_uncertain` and is never invoked again. Cyclic, over-budget, unreserved, or
  owner-mismatched handoffs fail closed. Unresolved observed/admitted receipts become
  restart-ambiguous quarantine, and receipts with complete typed effect plans settle
  by kind without being consumed again. Existing
  outbound/tool owners reconcile their operations; sealed no-send/presence truth is
  never re-emitted; provider-managed activity is never delegated or re-executed and
  settles consumed only from terminal already-effectful proof, otherwise quarantine/
  failed uncertainty. Canonical `not_sent` is a distinct pre-send-rejection operation
  status and terminal evidence retains the exact op ID/status proof; generic
  `failed_permanent` is not. Migration 53 enables aggregate no-send only for proved
  single-op answers; pre-lifecycle multi-op answers remain uncertain because they lack
  a sealed expected set. Migration 54 may prove multi-op no-send only from an immutable
  complete effect plan where every expected sibling is not-sent—missing, late-created,
  echoed, or ambiguous siblings dominate. No-send never clears an
  independent provider/tool/lifecycle replay veto. A receipt in a mixed/shared plan settles consumed only
  after every linked typed owner reports compatible terminal truth, otherwise it is
  quarantined. All lifecycle settlement is idempotent and never repeats an effect.
  Canonical terminal recovery is also total before lifecycle activation. An echo
  owner may complete normally, but a blocked, exhausted, expired, orphaned, or
  terminal-non-echoed owner reaches one idempotent `abandoned_unsafe`-equivalent
  disposition within five minutes. That transaction preserves all evidence and the
  replay veto, fails the inbound without claiming sent/echoed/not-sent truth, and
  releases the conversation scope. Only active, unexpired progress may block
  admission. The database-UTC start/deadline is immutable; a persisted wall-clock
  high-water mark plus live monotonic elapsed time prevents retries/restarts from
  extending it. Backward clock drift beyond five seconds becomes due or sticky clock-
  integrity failure, never ordinary blocking. Echo/abandon/restart races have one
  winner. The resolver reuses the authenticated control surface with exact actor/
  request/reason/instance/scope binding and idempotent audit; it cannot mutate provider
  quarantine.
  Every terminal provider-attempt boundary receipt has role `attempt_boundary`.
  Generic recovery never consumes it. `finalizeAttemptBoundary` alone uses one
  caller-owned database transaction to consume the boundary receipt, close that
  attempt, and commit bookkeeping. When
  retry/fallback is selected it also creates the unique handoff and next open attempt,
  but never terminalizes the logical turn. Only the final logical-turn boundary with
  no retry/continuation owner and zero obligations/segments performs terminal CAS and
  inbound disposition; system-request/session-generation owners never fabricate
  either. Automatic fallback notices/presence settle independently and cannot delay
  atomic handoff. If final no-response/error publication truth is required but
  unresolved, the boundary stays admitted and the attempt open; recovery re-enters
  the same idempotent finalizer only after truth settles. Intermediate results cannot close an attempt. A provider-never-invoked
  safe rejection creates a typed runtime rejection boundary under the open
  attempt/owner and atomically records its observed/admitted/consumed transitions
  plus invocation-gate proof in that closure transaction; missing provider output
  alone is not rejection proof. A causally terminal provider crash/error with open
  obligations invalidates and aborts only that attempt/session generation, atomically
  marks remaining segments/obligations abandoned-uncertain, and closes failed-
  uncertain. The logical owner terminalizes as failure; racing old-generation output
  quarantines. This neither claims successful obligation closure nor invokes the
  separate `/kill-session` queue-cancellation mechanism. Closing a safe-empty or
  safe-rejected attempt also does not close its logical turn when fallback/retry is
  selected: the attempt-close transaction atomically inserts one immutable handoff
  plus the next reserved attempt under the same recovery owner, destination capacity,
  and immutable increasing ordinal, and performs no terminal
  CAS/inbound mutation. Only the final attempt with no retry/continuation owner and
  zero durable obligations/segments terminalizes the turn. Invocation claims plus
  unique handoff/open-attempt keys prevent duplicate scheduling; crash recovery
  preserves the bounded acyclic chain without reconstructing prompt content. Crash
  fixtures cover before/after chrome settlement, invocation claim/commit, and
  boundary finalization.
  Every successful invoked-attempt closure—including `closed_with_evidence`, safe-empty,
  and safe-rejected—every handoff, and successful logical-turn finalization require the adapter's
  exact `causal_finality` capability. The barrier is stream EOF plus a
  drained decoder/callback queue, or a version/build/launch-context/API-contract native
  terminal event proved by an authoritative contract or audited exact-source control
  flow—not capture alone—to follow all continuation registrations/actionable frames. A result,
  zero known obligations, or idle queue is insufficient. Streaming effects may execute
  earlier, but terminal CAS, logical-turn publication, queue cleanup, and fallback
  serialize behind the barrier. Absent/drifted proof closes failed-uncertain without
  fallback; known absence rejects before invocation. An explicit transport crash/error
  or typed recovery boundary may close the attempt/logical turn failed-uncertain without
  reply/delivery/successful-finality claim.
  Barrier crossing appends an immutable `attempt_finality` receipt with bounded kind,
  exact contract, capability-context, pinned launch-chain, and authoritative proof-
  manifest fingerprints/version, attempt/segment/event ordinal, immutable invocation
  epoch/generation recorded on that attempt, and proof time. Closure/handoff references
  and consumes that exact receipt in the same transaction; restart validates it against
  the attempt epoch and cannot infer proof from state. Delayed-frame
  fixtures cover both zero prior output and prior visible output/tool evidence. Only a runtime
  rejection proved before provider invocation is exempt.
- **Alternatives considered:**
  - Recompute replay safety from the last visible event: rejected because later
    cleanup can erase earlier side-effect evidence.
  - Replay quarantined provider content after restart: rejected because the
    lifecycle deliberately stores no content and ownership remains uncertain.
  - Treat suppression as intentional output satisfaction only: rejected because it
    hides whether work was valid, dead, or unsafe.

#### DES-007: Provide content-free inspection, metrics, and retention
- **Traces-from:** REQ-007, CON-001, CON-004, CON-007
- **Rationale:** Structured logs and health statistics report receipt/state/reason
  counts plus owner discriminator and the existing approved redacted/hashed runtime
  correlation projection. Logs, alerts, and sidecars never emit raw conversation/
  JID fields, exact owner identifiers, provider-native IDs, or effect-admission
  tokens. Only authorized durability inspection exposes exact `CausalOwner`; only
  logical-turn owners produce the approved turn projection, and system-request/
  session-generation owners never fabricate it. Durability
  methods inspect current state and append-only history by receipt or exact causal owner. Open-quarantine age/count,
  capacity/backpressure, payload-cache eviction/bytes/entries, total lifecycle rows,
  database bytes/free space, failed-write, and adapter version/build drift are
  explicit health signals. A checked source-location manifest covers every provider/parser/result/
  outbound/tool/terminal-dedupe/operations-alert/crash-sidecar/health sink, including
  content-derived hashes, and a static guard rejects prohibited fields where
  mechanically detectable. Tests force each sink and seed unique canary
  content and native IDs and assert the values, their raw SHA-256, and their
  test-keyed digests are absent from tables and every captured WhatSoup-owned sink.
  Provider-owned transcripts and existing outbound/tool stores keep their separate
  declared ownership; the lifecycle does not copy them.
  Consumed/tombstoned receipt aggregates become retention candidates only after all
  linked effects and segment/obligation children are terminal, no recovery root
  remains, and the cutoff passes; unresolved states remain protected. Total-row and
  storage governors include terminal rows, prune only eligible aggregates first, and
  reject new invocation when a hard limit remains.
- **Alternatives considered:**
  - Include bounded text previews for debugging: rejected because identity,
    disposition, and linked-operation evidence are sufficient.
  - Export full provider frames to a diagnostic file: rejected because it creates an
    unmanaged sensitive store.
  - Hide quarantines from health until they age: rejected because ambiguity must be
    immediately operable and must block replay.

#### DES-008: Canonicalize deployed schema history before allocating the ledger
- **Traces-from:** CON-005
- **Rationale:** Installed databases already prove that schema versions 41 and 42
  crossed a deployment boundary, and canonical main now contains their immutable
  history plus forward repair migration 43 through merged PR #1768. Canonical base
  additionally contains migrations 44 through 46, including token-accounting
  separation, recovery-run status, and durable background work. The deployed
  v42 shape predates the hardening branch. Applied
  migrations are immutable: deleting version rows or rewriting v42 cannot repair an
  installed database. The merged canonicalization restores the historical 41/42
  sources and adds forward repair migration 43, with tests for the deployed v42
  shape. Canonical base `482b707d716aee5641db25d40c2a954caee5d78f`
  understands migrations through 46, and the current branch consumes migration 47
  for recovery-receipt chronology. The terminal-recovery prerequisite uses migration 48 for
  durable terminal `not_sent` plus bounded terminal-non-echoed recovery closure.
  Migration 48 does not alter historical 37-47. It adds the typed outbound/terminal
  no-send shape, an immutable singleton answer-set seal plus late-sibling rejection
  triggers, and lockstepped proof triggers, immutable database-UTC transfer start/
  deadline fields with legacy backfill, the recovery-job clock high-water field, and
  append-only `turn_recovery_terminal_closures`. The witness uniquely binds terminal,
  nullable valid job, inbound, selected op, closure/trigger/resolver/proof, deadline,
  and replay-never policy. The selected operation is the singleton/representative, not
  proof of a larger set. Existing jobs remain operational history; a witness makes
  them ineligible for claim/work/scope while preserving retention and late-echo
  conflict evidence. A declared eligibility index orders closure witnesses oldest first.
  A witness remains a root until the bound inbound, terminal, optional job, selected op,
  and late-echo/conflict evidence are terminal, no live owner/reference remains, and the
  canonical terminal cutoff passes; the guarded aggregate deletes it last. Migration-48
  storage accounting includes these rows, and unresolved/recent witnesses never prune.
  After the migration-48 prerequisite merges, the lifecycle branch rebases
  and allocates provider-event lifecycle
  migration 49. It extends terminal/job/closure ownership with the final attempt's
  immutable aggregate publication-set seal (owner, attempt, invocation epoch, exact
  count/fingerprint/membership) while retaining the selected op only as representative.
  Recovery rederives every member after restart, fences them all on abandonment, and
  records late nonselected-member truth/conflicts. Fresh databases apply 41-49;
  deployed v42 databases apply 43-49; v40 databases apply 41-49. Runtime
  manifests and the targeted deployment mechanism remain the only rollout source of
  truth, and configuration/state/data directories are preserved. The tracked
  `installation-evidence-ledger.json` tracks the private packet schema/trust policy; its
  named mode-0600 packet/hash is a bootstrap historical baseline, not rollout proof.
  Each quiesced target writes a new content-addressed packet and an append-only HMAC-
  SHA-256 attestation using the existing canonical deployment owner's 32-byte Secret
  Service key. The 0700/0600 private chain binds monotonic sequence/previous hash, exact
  target, reviewed merge, capture hash/time, quiescence nonce/proof, verdict, and single-
  use activation request. Cutover consumes only the newest chain-valid unconsumed entry
  no older than five minutes; missing key, gap, replay, stale/wrong target/merge, or
  mismatch fails closed. Exact capture time/commands,
  canonical/local/legacy classification, symlink targets, ownership/modes, installed
  hashes, deployed commit, provider fingerprints, XDG/config posture, and schema
  query/results stay only in that authorized private packet. Public verification
  records boolean/delta-free pass/fail. Missing or stale evidence blocks activation. Accepted
  local shims and private overrides are classified and preserved until a focused
  canonicalization decision. The production schema-ceiling gate must be fleet-verified
  before any schema-48/49 writer. A database max above
  the binary's supported maximum preserves
  backup/inspection but rejects every provider turn in drain/read-only mode; older
  pre-guard fingerprints are prohibited rollback targets. Migration 49 creates an
  empty `provider_lifecycle_activation` table; the first lifecycle-enabled attempt
  inserts its marker atomically before provider invocation. The immutable
  `schema_migrations(version=49)` row alone is not activation. After the activation
  marker, any lifecycle data row, or an activated provider request, runtime deployment is
  roll-forward-only; a prior runtime is safe only if it is fully v49 write-
  compatible or enters drain/read-only mode and rejects all new provider turns.
  Before activation, each target quiesces, creates an application-consistent
  SQLite backup, passes source/backup integrity checks and a scratch restore/schema
  fingerprint, and records the pre-activation checkpoint. While still quiesced, the
  runbook must prove no activation marker, zero rows across the other nine named
  lifecycle data tables, zero nonterminal inbound rows, zero active agent sessions,
  and no runtime provider request/process. Only then may a coordinated restore of
  that exact verified schema-48 (pre-v49) backup followed by integrity/fingerprint verification
  be the sole state-replacement exception. After activation, no data restore is permitted.
  Failure aborts rollout.
- **Alternatives considered:**
  - Reuse migration 41 on current main: rejected because installed databases have
    already recorded 41 and 42.
  - Rewrite migration 42 and ask operators to delete its version row: rejected
    because it violates migration immutability and can re-run unsafe DDL.
  - Run a fresh installer or replace runtime data: rejected because installed
    settings and durable state are inputs to canonicalization, not disposable
    artifacts.

#### DES-009: Split lifecycle, schema canonicalization, and cancellation ownership
- **Traces-from:** CON-006
- **Rationale:** Use focused, ordered pull requests: PR #1747's bounded queue/session
  cancellation core is already merged (`5c52f571` as `77cd0718`) and must be rebased/
  reverified; migrations 41-43 are canonical through PR #1768
  (`cf1fc6e3e2d3faa3cae80737466f52d40e34b9bf`); and PR #1770
  (`84ba01a04941d29becbaa4ffac274e604ee89820` merged as
  `56e232223132d33c347cd2d2521620f911d4f4b6`) separates active recovery work
  from audit health without supplying canonical no-send truth. Land the outstanding
  current migration-47 receipt chronology, then the terminal recovery prerequisite
  on migration 48, then provider-event lifecycle on migration 49.
  Unpublished live-checkout shutdown commits remain a
  separate review lane. The lifecycle PR contains
  no automatic restart continuation replay, operator UI, raw installation, fleet
  restart, or unrelated recovery semantics. This keeps review and rollback
  boundaries explicit while still delivering the complete platform contract.
- **Alternatives considered:**
  - Combine all recovery, cancellation, schema, and provider changes: rejected
    because failure attribution and safe rollback would be impractical.
  - Deploy a single-instance patch before canonical merge: rejected because it
    recreates fleet drift and bypasses manifest verification.

## Logical Data Model

### `provider_lifecycle_activation`

Migration 49 creates this singleton table empty. The first lifecycle-enabled
attempt inserts its immutable activation timestamp, binary/source fingerprint, and
schema-contract version in the same transaction as the attempt. The migration row
in `schema_migrations` is not activation; any activation row makes deployment
roll-forward-only.

### `provider_request_attempts`

The attempt row is inserted before provider invocation and contains a random
attempt ID, immutable `CausalOwner`, an exact caller-durable request-chain ID, bounded
adapter/capability/provider-version plus launch-context/proof-manifest and exact pinned
executable/source/interpreter or loaded-module/contract fingerprints, current state,
invocation phase, immutable invocation epoch/generation, attempt ordinal,
immutable fallback-chain snapshot/budget, capacity reservation, opened/closed
timestamps, and bounded close reason. Invocation phases are `reserved`,
`invocation_claimed`, and `invocation_committed`; claimed rows carry a bounded lease,
owner, epoch, and immutable pre-commit execution-owner deadline. Provider execution is
forbidden before commit, and committed rows
cannot be returned to a prior phase. Valid states are `open`, `closed_safe_empty`, `closed_safe_rejected`,
`closed_with_evidence`, and `failed_uncertain`. The latter four are terminal. A composite exact-owner/open index
supports startup reconciliation and empty-output proof. The safe-empty transition
shares one transaction/CAS with consumption of the final boundary receipt and
proof that no open/unsafe provider-activity receipt, obligation, or effect remains.
Terminal runtime chrome is evaluated separately and does not change attempt state. It contains no
prompt, native provider ID, or content-derived value. Guarded retention removes a
  terminal attempt only after every child aggregate is pruned, its cutoff passes, and
  it is not a recovery root. A null-safe unique owner/request-chain/ordinal key covers
  both the initial ordinal and every handoff destination. Reservation is insert-or-
  return exact match; a parameter conflict is a sticky integrity failure. Two concurrent
  coordinators therefore share one claim/commit gate rather than minting two attempts.

### `provider_attempt_handoffs`

Each immutable row links exactly one closed source attempt to exactly one atomically
created reserved destination attempt under the same logical turn and existing
recovery owner. It stores a random handoff ID, bounded retry/fallback reason and tier,
strictly increasing ordinal, remaining immutable budget, destination capacity
reservation, and a content-free idempotency token; it stores no prompt or provider
content. Composite checks prohibit self-links, cycles, skipped/repeated ordinals,
owner mismatch, and more than eight attempts. Unique source-attempt and logical-turn/
retry-ordinal constraints allow only one scheduler. The row and both attempts are
created/closed in the caller-owned attempt-boundary transaction.
It remains a recovery/retention root until the destination attempt and logical turn
are terminal; startup never reconstructs or blindly replays its prompt. The
destination attempt's invocation claim/commit state is the executable exactly-once
gate, not merely the handoff row's uniqueness.

### `provider_request_segments` and `provider_continuation_obligations`

Each immutable row binds exact owner, manager/generation, attempt, request segment,
and (for an obligation) task/tool correlation tokens. Current state is derived from
an append-only start/close/abandoned-uncertain transition with a compare-and-swap
guard; duplicate, out-of-order, cross-segment, or post-terminal transitions fail.
Finalization queries these indexed durable rows for zero open work. Unresolved rows
are recovery and retention roots; terminal rows prune before their parent attempt.

### `provider_event_receipts`

The receipt row contains:

- random runtime receipt ID and composite-unique runtime event key;
- explicit receipt role (`provider_event`, `attempt_boundary`, `attempt_finality`, or
  `runtime_intent`); boundary kind is `provider_final`,
  `runtime_pre_execution_rejection`, or `runtime_failure_abandonment`;
- bounded provider, event-kind, origin, current-state, reason, actor, and proof enums;
- the discriminated owner kind plus its required immutable logical-turn,
  system-request, or session-generation identity fields;
- provider-attempt ID, request-segment ID/ordinal, and event ordinal;
- nullable random opaque session/message/parent/task/tool-use/item correlation
  tokens resolved only inside the live attempt;
- payload byte length and logical-fragment count;
- observed and last-transition timestamps; and
- immutable `replay_policy=never` once quarantined or tombstoned.

No raw frame, text, prompt, tool input/result, or preview column is permitted.
Database checks bound text/byte lengths and enforce valid state/reason combinations.
Only the exact adapter barrier may append/admit an `attempt_finality` receipt, and only
`finalizeAttemptBoundary` may consume it with its referenced terminal boundary. Generic
settlement/recovery cannot transition it. The proof binds the attempt's immutable
invocation epoch (which remains valid across process restart), segment, event ordinal,
capability context, and authoritative proof manifest; retention treats it as a root
until the referenced close/handoff is terminal.

### `provider_event_transitions`

Each row contains a monotonic sequence, receipt foreign key, prior state, next
state, bounded reason/proof/actor, optional no-send outcome, and timestamp. Inserts
are append-only during normal operation. The durability method updates the
receipt's current state with a compare-and-swap and inserts the transition in one
transaction. Database constraints reject direct updates/deletes and invalid state
edges; only the guarded aggregate-prune method can authorize ordered deletion after
all retention/root predicates pass.

### `provider_event_effect_plans`, `provider_event_effect_links`, and `provider_effect_authorizations`

Each plan stores a random plan ID, one composite owner, one immutable target,
typed outcome, immutable per-effect-kind, attempt-activity-class, total receipt/
effect/link counts, and an immutable sealed marker. Each immutable link joins one receipt and one planned
  durable effect: outbound operation, runtime tool call, provider-managed uncertain
  effect, presence update, or no-send outcome. Each link also stores an immutable reply-
  obligation role (`origin_reply_candidate`, `terminal_failure_notice`,
  `intentional_silence`, `supplementary_nonreply`, `redirected_nonreply`, or
  `internal_no_egress`); plans store per-role counts and schema-check the exhaustive
  owner/target/effect-kind matrix. Composite foreign keys/triggers enforce
  equality of non-null owner token/discriminator, attempt, segment, handoff, receipt,
  plan, operation, and target with null-safe comparisons.
  The target equals the logical-turn destination by default; non-turn owners cannot
  carry an external target. A redirect/cross-chat plan must reference a separate
  immutable authorization row containing exact issuer, authenticated routing-policy
  decision/request/actor, source owner/generation/segment, target, issue/expiry, and
  one-shot state. A distinct non-exported routing-authority scope mints it; the generic
  plan scope can only atomically consume it and cannot self-authorize. Redirected plans
  cannot aggregate with source-target effects. Presence is exact-targeted and one-shot;
  recovery never re-emits it, and its terminal outcomes do not count as provider
  activity or alter empty/replay classification. The engine atomically creates all owned downstream
  operations, inserts every link, verifies cardinalities, and inserts the already-
sealed plan row last under deferred constraints before first execution. Unique receipt/type/effect pairs prevent duplication while
supporting one event split into many outbound operations and many coalesced events
  contributing to one aggregate operation. Recovery accepts only a sealed plan whose
  persisted counts match; otherwise it quarantines and vetoes. Partial-send, retry,
  truncation, crash-before/after-each-chunk, and N-to-1/1-to-N tests define the
contract. Shared plans remain retention roots until every linked receipt and effect
qualifies; SQLite authorizer enforcement prevents raw UPDATE/DELETE outside the
  private guarded maintenance transaction. Pre-provider presence, every refresh, and
  each nested dynamic effect uses a separately sealed `runtime_intent` child plan;
  no plan is grown after sealing.

Agent-origin downstream operation tables carry exact producer provenance and are
protected by connection-authorizer/trigger scopes. The default scope denies their
mutation. `agent_lifecycle_effect` permits only the exact downstream INSERT manifest
whose complete plan/links seal in the same transaction; enumerated `non_agent_effect`
capabilities preserve existing owners but are not importable/mintable by agent runtime
modules. Fresh statements execute synchronously inside the scope, so raw SQL, false
provenance, omitted seams, cached statements, or a generic plan caller cannot bypass it.

Plan creation bounds known payload/input bytes and reserves one row plus 1 KiB of
content-free terminal-settlement capacity per effect from the global 16-MiB unsettled-
effect pool. Post-effect results/transport identifiers/errors are byte-validated. If raw
truth cannot be persisted, the owner writes only typed terminal
`executed_result_unavailable`/`delivery_uncertain_after_execution` proof and never
re-executes; failure uses the attempt's emergency CAS, while an executing row left by a
failed CAS remains an unsafe startup root.

At causal finality, the finalizer freezes a content-free attempt/logical-turn publication
manifest over every exact origin reply-candidate/terminal-failure-notice operation
across every sealed plan; intentional silence has separate typed policy proof and every
nonreply role remains replay/retention evidence but cannot satisfy. Terminal chrome is
classified separately. Exact counts/links/targets and a canonical
fingerprint are restart-rederivable, and no admitted/unplanned receipt or open segment/
obligation may remain. Aggregate no-send requires every member canonical not-sent. A
single plan or selected operation never proves it.

### Protocol bounds

| Exported constant | Unit | Default / hard maximum |
|---|---:|---:|
| `PROVIDER_EVENT_TEXT_BATCH_MAX_BYTES` | UTF-8 bytes | 16,384 / 16,384 |
| `PROVIDER_EVENT_TEXT_BATCH_MAX_FRAGMENTS` | fragments | 256 / 256 |
| `PROVIDER_EVENT_TEXT_BATCH_FLUSH_MS` | milliseconds | 250 / 250 |
| `PROVIDER_EVENT_LABEL_MAX_BYTES` | UTF-8 bytes | 64 / 64 |
| `PROVIDER_EVENT_REASON_MAX_BYTES` | UTF-8 bytes | 96 / 96 |
| `PROVIDER_EVENT_VERSION_MAX_BYTES` | UTF-8 bytes | 64 / 64 |
| `PROVIDER_EVENT_READMIT_MAX_BYTES` | bytes/event | 1 MiB / 1 MiB |
| `PROVIDER_EVENT_READMIT_CACHE_MAX_BYTES` | bytes/runtime | 32 MiB / 32 MiB |
| `PROVIDER_EVENT_READMIT_CACHE_MAX_ENTRIES` | entries/runtime | 1,024 / 1,024 |
| `PROVIDER_EVENT_CAUSAL_ID_MAX_BYTES` | UTF-8 bytes/provider-native field | 512 / 512 |
| `PROVIDER_EVENT_CORRELATION_MAX_ENTRIES_PER_ATTEMPT` | live entries/attempt | 1,024 / 1,024 |
| `PROVIDER_EVENT_CORRELATION_MAX_BYTES_PER_ATTEMPT` | live bytes/attempt | 512 KiB / 512 KiB |
| `PROVIDER_EVENT_CORRELATION_GLOBAL_MAX_BYTES` | live bytes/runtime | 32 MiB / 32 MiB |
| `PROVIDER_EVENT_PRESENCE_MAX_REFRESHES` | child plans/attempt | 120 / 120 |
| `PROVIDER_EVENT_PRESENCE_MAX_DURATION_MS` | milliseconds/attempt | 600,000 / 600,000 |
| `PROVIDER_EVENT_FALLBACK_MAX_ATTEMPTS` | attempts/logical turn | 8 / 8 |
| `TURN_RECOVERY_SCOPE_BLOCK_MAX_MS` | milliseconds/scope | 300,000 / 300,000 |
| `TURN_RECOVERY_CLOCK_ROLLBACK_TOLERANCE_MS` | milliseconds | 5,000 / 5,000 |
| `PROVIDER_EVENT_MAX_OPEN_ATTEMPTS` | attempts/runtime | 256 / 256 |
| `PROVIDER_EVENT_EMERGENCY_BYTES_PER_ATTEMPT` | leased bytes/open attempt | 64 KiB / 64 KiB |
| `PROVIDER_EVENT_EMERGENCY_POOL_BYTES` | globally accounted bytes/runtime | 16 MiB / 16 MiB |
| `PROVIDER_EVENT_EFFECT_SETTLEMENT_PROOF_MAX_BYTES` | content-free terminal proof/effect | 1 KiB / 1 KiB |
| `PROVIDER_EVENT_UNSETTLED_EFFECT_RESERVE_BYTES` | globally reserved future-settlement bytes/runtime | 16 MiB / 16 MiB |
| `PROVIDER_EVENT_PLAN_MAX_RECEIPTS` | receipts/plan | 128 / 128 |
| `PROVIDER_EVENT_RECEIPT_MAX_PLANS` | effect plans/receipt | 1 / 1 |
| `PROVIDER_EVENT_PLAN_MAX_EFFECTS` | typed effects/plan | 256 / 256 |
| `PROVIDER_EVENT_EFFECT_PLAN_MAX_LINKS` | links/plan | 1,024 / 1,024 |
| `PROVIDER_EVENT_PLAN_MAX_AUTHORIZATIONS` | redirect authorizations/plan | 256 / 256 |
| `PROVIDER_EVENT_RECEIPT_MAX_TRANSITIONS` | transitions/receipt | 6 / 6 |
| `PROVIDER_EVENT_RECEIPT_MAX_READMISSIONS` | quarantine-to-admitted epochs/receipt | 1 / 1 |
| `PROVIDER_EVENT_TXN_MAX_ROW_MUTATIONS` | physical direct + triggered mutations/transaction | 4,096 / 4,096 |
| `PROVIDER_EVENT_TXN_MAX_ENCODED_INPUT_BYTES` | bounded encoded bytes/transaction | 4 MiB / 4 MiB |
| `PROVIDER_EVENT_TXN_MAX_PROJECTED_ALLOCATION_BYTES` | conservative main/index/WAL/SHM allocation/transaction | 32 MiB / 32 MiB |
| `PROVIDER_EVENT_CHECKPOINT_MAX_FRAMES` | WAL frames/passive checkpoint projection | 4,096 / 4,096 |
| `PROVIDER_EVENT_CHECKPOINT_MAX_PROJECTED_BYTES` | aggregate main/WAL/SHM growth/passive checkpoint | 32 MiB / 32 MiB |
| `PROVIDER_EVENT_CHECKPOINT_MAX_MS` | proved cancellable passive-checkpoint time budget | 250 / 250 |
| `PROVIDER_EVENT_UNRESOLVED_SOFT_ROWS` | rows across nine work tables/instance (activation marker excluded) | 40,000 / 40,000 |
| `PROVIDER_EVENT_UNRESOLVED_HARD_ROWS` | rows/instance | 50,000 / 50,000 |
| `PROVIDER_EVENT_INFLIGHT_RESERVE_ROWS` | rows/instance | 10,000 / 10,000 |
| `PROVIDER_EVENT_TOTAL_SOFT_ROWS` | all lifecycle rows/instance admission threshold | 400,000 / 400,000 |
| `PROVIDER_EVENT_TOTAL_HARD_ROWS` | all lifecycle rows/instance admission threshold | 500,000 / 500,000 |
| `PROVIDER_EVENT_DATABASE_SOFT_BYTES` | aggregate main + WAL + SHM on-disk admission threshold | 1 GiB / 1 GiB |
| `PROVIDER_EVENT_DATABASE_HARD_BYTES` | aggregate main + WAL + SHM on-disk admission threshold | 2 GiB / 2 GiB |
| `PROVIDER_EVENT_STORAGE_RESIDUAL_RESERVE_BYTES` | bytes retained after projected allocation below hard database/free-space thresholds | 64 MiB / 64 MiB |
| `PROVIDER_EVENT_FILESYSTEM_FREE_MIN_BYTES` | filesystem free admission floor | 1 GiB / 1 GiB |
| canonical `terminalDurabilityDays` | days | 30 / minimum 1; may retain longer |

Configuration can lower batching/capacity values but cannot exceed hard maxima and
must satisfy `soft + reserve <= hard`, positive thresholds,
`max_open_attempts * emergency_bytes_per_attempt <= emergency_pool`, and
`emergency_pool + unsettled_effect_reserve <= residual_reserve`.
The attempt-open transaction acquires the byte lease; only a serialized emergency CAS
may consume it, and closing the attempt releases it. Unresolved states are never age-pruned. Total limits
include terminal rows. Every attempt/callback/effect/handoff/prune transaction first
bounds cardinality/encoded inputs and projects worst-case allocation; unknown or over-
32-MiB projection fails before writing. It then remeasures aggregate main-file/WAL/SHM
bytes and filesystem free space and requires 64 MiB of residual reserve after the
projection. The authorized pruner removes eligible terminal aggregates, then may request
only a separately projected passive checkpoint within the named frame/byte/time bounds.
If the binding cannot cancel/bound it or projection is uncertain, checkpoint execution
is skipped and health/rejection remains fail closed. The engine remeasures before
rejecting or aborting. A crossed
threshold stops new invocation or the next in-flight parse/effect/handoff and allows
only the leased emergency close CAS. Pinned-reader/checkpoint and external-free-space
health are reported; no forced/truncating checkpoint is permitted.
Each commit remeasures and latches backpressure before another reservation. Fixtures
cover the largest effect-plan and prune transactions, deliberate over-cap rejection,
page splits, pinned-reader WAL amplification, and every byte/free-space boundary.
Schema-checked bound arithmetic includes every receipt transition and triggered
mutation and proves the maximally populated valid aggregate remains within all three
transaction caps; no valid aggregate can become permanently unprunable.
An `ENOSPC`/`SQLITE_FULL` race after projection atomically rolls back, aborts transport,
and attempts only the leased emergency CAS. If even that fails, the already-open
invocation-committed row remains the durable replay veto and startup reconciliation
never invokes or classifies it empty. Concurrent abort-storm and competing-connection
fixtures prove the global pool and under-lock remeasurement.
Payload-cache eviction is fail-closed and never spills.
The pinned benchmark requires at most one observe transaction per completed batch,
one seal transaction per effect plan, and 50-ms p95 lifecycle processing overhead
per completed batch across the 10,000-fragment fixture.

## Processing Protocol

1. Before provider start/send, the coordinator reserves capacity, inserts the
   activation marker if absent, and inserts an `open`/`reserved` provider attempt
   from immutable `CausalOwner`. Failure stops before invocation. One worker obtains
   the bounded invocation claim and commits it immediately before crossing the
   provider boundary; no other worker may invoke. While open, an independent attempt-
   completeness blocker prevents empty/fallback decisions without changing the
   monotonic `unsafeEvidence` latch.
2. WhatSoup-initiated work appends the root request-segment start. Background work
   appends an exact continuation-obligation start before scheduling. A provider-
   internal continuation receives a child segment only when its native event kind
   and direct task/tool-use obligation binding prove ownership; terminal transitions
   close/abandon only the exact durable row, and no content tag can mint one.
3. At the adapter callback, before generation/session-key/map/queue/shutdown/route
   guards, the adapter exhaustively classifies and observes every event variant.
   State-affecting events
   retain transient causal metadata; proved non-actionable events carry a bounded
   classification reason and cannot affect runtime state.
4. The normalizer coalesces contiguous fragments into bounded egress batches,
   flushing on size/time, item completion when available, and non-text/result
   boundaries. It then assigns runtime event identity and opaque live-correlation
   tokens, records the batch's final length/fragment count, and calls
   `DurabilityEngine.observeProviderEvent` before first owned egress. A crash with an
   incomplete in-memory batch leaves the attempt open and therefore unsafe; no
   synchronous row or mutable aggregate update is required per token delta.
5. Admission policy evaluates exact causal ownership, provider-native kind/origin,
   tested adapter capability version plus exact build/contract fingerprint, durable
   background work, terminal state, capacity, and duplication evidence. The owner/
   effect matrix defaults system/session/control and unproved child origins to
   internal no-send/no-effect. A child CLI MCP request reaches its handler only when
   the pre-handler connection field proves its exact segment and policy permits it;
   later stdout can corroborate but never authorize retroactively.
6. The durability engine transitions the receipt:
   - admitted text is split/planned before delivery, then all outbound operations,
     expected cardinalities, and receipt links are atomically sealed before any
     chunk is sent; every split chunk retains the receipt and plan identities;
   - pre-provider presence and every refresh/nested dynamic effect first creates a
     separately sealed, bounded `runtime_intent` child plan; recovery never re-emits it;
   - agent-owned MCP/runtime tool use carries an effect-admission token from API
     bridge or CLI socket through `SessionContext`; the parent tool intent is sealed
     before handler invocation and each nested outbound child is sealed before send;
   - provider-managed tool activity is recorded as effect evidence and vetoes
     replay without any runtime re-execution;
   - admitted intermediate result closes only its request segment; obligation-close
     only decrements registered work; a later causally final provider boundary
     authorizes logical-turn finalization only when zero obligations/segments remain;
   - admitted task/control activity is consumed as internal obligation evidence;
     only a proved inert reminder is quarantined then policy-tombstoned by a closed
     deterministic enum; no operator mutation endpoint exists in this PR;
   - ambiguous or invalid activity stays quarantined; and
   - correlated child output is linked as `internal_child_output` no-send, inert
     reminders alone are tombstone-eligible, and only top-level parent output egresses;
   - an echo/policy/suppression outcome is linked as no-send rather than dropped; and
   - exact-target presence is linked as one-shot non-replayable evidence; and
   - every plan is single-owner/single-target, defaults to the logical-turn target,
     and references a separate exact authorization before any redirect/cross-chat effect.
7. Any lifecycle write or summary/inspection read failure sets unsafe evidence
   before propagating error handling, blocks new owned effects/empty/fallback,
   leaves durable open evidence where possible, and escalates terminal plus health
   state. No caller converts a failed read into an empty summary.
8. Every terminal attempt boundary has receipt role `attempt_boundary`. Generic
   settlement cannot consume it. `finalizeAttemptBoundary` uses one caller-owned
   transaction to consume its receipt, close that attempt, and commit bookkeeping.
   It selects `closed_safe_empty` for proved silence,
   `closed_safe_rejected` for typed pre-execution rejection,
   `closed_with_evidence` for sealed provider-activity output/tool/no-send evidence,
   or `failed_uncertain` for crash/unknown/persistence ambiguity. Sealed runtime-
   terminal chrome (presence or fallback/no-response/error notice) retains separate
   delivery truth and may gate final publication/reply satisfaction but never
   rewrites safe-empty/safe-rejected as with-evidence. Fallback notices/presence do
   not gate atomic handoff. Required final chrome keeps the boundary admitted and
   attempt open; after settlement recovery re-enters this same finalizer. Concurrent late or
   duplicate closure loses CAS and becomes post-terminal quarantine without partial
   publication. When a proved fallback/retry is selected, that transaction inserts
   the unique immutable handoff, destination capacity reservation, and next reserved
   attempt under the same logical turn and increasing bounded ordinal;
   it performs no turn-terminal CAS or inbound disposition. Intermediate results and obligation-close events leave the attempt
   open; finalization requires a later causal final boundary plus zero open
   obligations/segments. If the provider was
   provably never invoked, the same closure transaction creates the typed runtime
   rejection boundary receipt, appends its observed/admitted/consumed transitions,
   and stores the invocation-gate proof before closing `closed_safe_rejected`.
   Only the final logical-turn boundary, with no retry/continuation owner and zero
   durable obligations/segments, performs terminal CAS and inbound disposition; non-turn
   owners never do so.
9. Empty policy requires `closed_safe_empty`; typed fallback may use
   `closed_safe_rejected` but does not increment empty counts. Logical-turn
   finalization records the existing single terminal result only after a causally
   final provider boundary with zero open obligations/segments and preserves
   lifecycle child records.

## Recovery Protocol

Startup reconciliation never reconstructs event content:

| Durable evidence | Recovery disposition |
|---|---|
| open `reserved` attempt | exact handoff/recovery owner may claim only within immutable pre-commit deadline while it already holds prompt/idempotency proof; otherwise the unique typed never-invoked/non-fallback boundary atomically fails the logical owner; never reconstruct content |
| open `invocation_claimed` attempt | reclaim only an expired pre-commit lease because provider execution was forbidden; reclaim versus owner-abandon boundary has one CAS winner |
| open `invocation_committed` attempt without terminal boundary | after positive generation-loss/crash/fence evidence starts the bounded recovery deadline, append the unique runtime-failure-abandonment boundary, abandon open children uncertain, close/finalize logical owner failed; no finality claim, replay, or reinvocation |
| immutable attempt handoff plus next attempt | validate exact owner, strictly increasing ordinal, acyclic/bounded chain, and destination capacity; preserve one retry owner without duplicate scheduling or prompt reconstruction; never terminalize the source attempt as the completed turn |
| open segment/obligation | preserve as finalization/recovery root; exact terminal error may append abandoned-uncertain, never successful close |
| invoked `closed_safe_empty` attempt and safe terminal receipts | eligible for existing empty threshold only after exact adapter causal-finality barrier |
| `closed_safe_rejected` with no-activity proof plus separately typed policy-allowed reason | eligible for existing typed fallback only after causal finality when provider was invoked; runtime pre-invocation rejection is exempt; never empty; conflated/unknown admission rejection cannot hand off |
| `closed_with_evidence` or `failed_uncertain` attempt | veto automatic replay |
| admitted `attempt_finality` | exclusive input to `finalizeAttemptBoundary`; validate against the attempt's immutable invocation epoch/context/proof manifest across restart; generic recovery cannot consume or quarantine it |
| `observed` without linked effect | quarantine as restart-ambiguous; veto replay |
| `admitted` without complete expected effect links | quarantine as restart-ambiguous; veto replay |
| non-boundary `admitted` with complete outbound links | existing outbound recovery owns each delivery truth; canonical durable `not_sent` retains exact op proof; migration-48 proof is single-op only, while migration-49 multi-op proof requires an immutable sealed expected set and every sibling not-sent; generic/missing/late/mixed/ambiguous states remain uncertain without clearing other replay vetoes |
| `admitted` with complete runtime-tool links | existing tool-call evidence owns reconciliation, then lifecycle CAS-settles consumed/quarantined |
| `admitted` with sealed no-send or presence links | settle from recorded terminal truth without egress/re-emission; absent or uncertain truth quarantines |
| `admitted` with provider-managed links | never delegate or re-execute; terminal already-effectful proof may settle consumed, otherwise quarantine and preserve failed uncertainty |
| `admitted` in mixed/shared sealed plan | settle receipt consumed only after every typed effect owner reports compatible terminal truth; otherwise quarantine and retain the plan as a recovery root |
| admitted `attempt_boundary` with unresolved required final publication | close/classify only through `finalizeAttemptBoundary`, atomically freezing the complete publication set and transferring exact unresolved operations to the bounded terminal recovery owner; generic settlement never consumes it |
| terminal/recovery owner is blocked, exhausted, expired, orphaned, or terminally non-echoed | within the five-minute scope-block bound, CAS to an audited fail-closed abandonment that preserves evidence/replay veto, fails the inbound without claiming delivery truth, and releases scope; race with echo has one winner |
| new inbound during valid recovery block | persist FIFO `deferred_by_recovery_scope` with no attempt; closure wakes/claims once, while bounded-capacity failure gets a sealed explicit notice rather than silent loss |
| open quarantine | preserve; no TTL resolution and no replay |
| tombstone | preserve `never` replay disposition until eligible retention |

Shutdown uses the same rules. A generation change is a hard ownership boundary.

## Rollout and Rollback

1. Merge this approved lifecycle spec as a documentation-only prerequisite so the
   schema PR's conformance marker resolves on canonical main.
2. Treat #1744 and #1749 as required terminal-recovery prerequisites; #1750 remains
   an open taxonomy issue. Merged PR #1748
   (`625b17f0`) proves governor sheds are local non-sends in the live finalizer, but
   persists the operation as `failed_permanent` and collapses terminal delivery to
   `none`; that is not restart-queryable canonical `not_sent`. Before lifecycle
   implementation can consume positive no-transmission truth, land and verify a
   prerequisite PR whose durable operation/terminal state distinguishes
   typed `not_sent` from generic `failed_permanent` in both lockstepped validators and
   recovery queries and whose bounded terminal-non-echoed/abandonment transaction
   closes the inbound and releases scope without claiming delivery truth. The same PR
   makes the resolver reachable/audited and proves no processing inbound is excluded
   from every terminal path. Otherwise lifecycle runtime activation remains blocked;
   absence or `failed_permanent` remains uncertain.
3. Inventory without mutation the installed unit/drop-ins, wrapper/symlink targets,
   accepted local shims, manifests, config/env modes, active XDG paths, database
   migration rows/fingerprints, provider versions/build hashes, source SHA, and private
   overrides using the bootstrap packet only as a historical baseline. Classify
   canonical source versus preserved local state and decoy/legacy paths; rollout proof
   comes from the fresh private content-addressed packet and newest chain-valid HMAC
   attestation for that exact target/merge.
4. Treat schema-history canonicalization through migration 43 as merged through PR
   #1768 (`cf1fc6e3e2d3faa3cae80737466f52d40e34b9bf`) and canonical base
   `482b707d716aee5641db25d40c2a954caee5d78f` as containing migrations through
   46. Exact-head verify and publish the current branch's migration-47
   recovery-receipt chronology, then fleet-verify schema compatibility before any
   schema-48 writer.
5. Treat PR #1770 (`84ba01a04941d29becbaa4ffac274e604ee89820`, merged as
   `56e232223132d33c347cd2d2521620f911d4f4b6`) as recovery-health evidence only;
   land and verify the remaining terminal no-send/recovery-owner prerequisite as
   migration 48.
6. Rebase the lifecycle branch onto that canonical main and implement migration 49.
7. Run fresh, v40, deployed-v42, repaired-v43, current-v47, recovery-v48, and
   lifecycle-v49 migration fixtures,
   crash-boundary tests, adapter-version gates, and high-fragment-count budgets.
8. Merge only after focused, full release, test-integrity, repository, manifest,
   privacy, and independent review gates pass.
9. Before each target activation, gracefully drain/quiesce the instance, capture and
   HMAC-attest the exact target/merge/quiescence evidence, validate <=5-minute freshness
   and chain continuity, prove the effective configured routing set has a safe finality
   path for every eligible provider/context, atomically consume the attestation, then create a
   fresh SQLite `.backup`, run source/backup `PRAGMA integrity_check`, open a scratch
   restore and verify schema/row-count fingerprint, and record the rollback
   checkpoint. Before inbound/provider activation and only with no activation marker,
   zero rows across the other nine lifecycle data tables, zero nonterminal inbound
   rows, zero active agent sessions, and runtime proof of no provider process/request,
   coordinated restore of that exact backup is the sole state-replacement exception;
   it returns schema history to the backup's exact schema-48 fingerprint, so removal of a
   source v49 marker occurs only as part of that whole-database restore and never by
   manual/in-place migration-history deletion or rewrite;
   reverify source/restore integrity/fingerprints.
   Any failure aborts without migration or restart.
10. Use the existing targeted source update after merge. Restart only affected
   instances in coordinated batches and verify receipt/turn health between batches.

Before activation, code rollback is permitted only with proof that the activation
table and all nine lifecycle data tables are empty, no nonterminal inbound or active
agent session exists, and runtime drain reports no provider process/request. The
immutable migration-49 schema marker may exist in the pre-restore source; the exact
verified schema-48 (pre-v49) whole-database backup restore returns schema history to 48 and is the
sole data-rollback/migration-row-removal path. Manual or in-place schema-history deletion
or rewrite is prohibited. After the first lifecycle activation
row, any lifecycle data row, or activated request, deployment is roll-forward-only. A downgrade requires a
fully v49 write-compatible backport or a drain/read-only binary that rejects every
new provider turn; merely reading or ignoring the tables is unsafe. After activation,
data rollback/restore is prohibited and never deletes unresolved receipts or migration history.

## Explicit Non-Goals

- Automatic replay of background continuations after process restart.
- Storing provider content for later reconstruction.
- A new operator UI or manual content-replay endpoint.
- Operator admission, tombstone mutation, or content recovery; deterministic
  policy tombstoning is the only tombstone path in this change set.
- Queue/session cancellation behavior.
- Replacing terminal ownership or delivery reconciliation.
- Raw reinstall, state replacement, or uncoordinated fleet restart.
