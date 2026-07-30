# Provider-Event Lifecycle Requirements

**Status:** Active — refreshed against canonical base `482b707d716aee5641db25d40c2a954caee5d78f`; migrations 47 through 52 are already consumed, and the current branch advances the schema to migration 53 for outbound-quarantine disposition and retirement receipts. Provider-lifecycle implementation and activation remain unauthorized

**Schema allocation:** current canonical schema is migration 54; bounded terminal recovery/canonical `not_sent` is forward migration 55; the provider-event lifecycle ledger is migration 56. Migrations 50 and 51 are consumed by metadata-only durability evidence, migration 52 by outbound ambiguity-episode timing, migration 53 by outbound quarantine disposition/retirement receipts, and migration 54 by the completed-delivery identity-admission ledger, so the still-unpublished forward allocations move to migrations 55 and 56.

## Purpose

Define a fleet-wide protocol for provider events that arrive at, across, or after a
provider request boundary. The protocol must preserve causal ownership, durably
record every actionable disposition, prevent ambiguous activity from being called
empty output, and make replay fail closed.

An **actionable provider event** is any provider frame or logical output unit that
can affect session identity, compaction, usage accounting, turn completion,
outbound delivery, tool execution, fallback, or recovery. Contiguous text deltas
are coalesced into bounded egress batches; effect-bearing and boundary events are
never coalesced. Every adapter event variant must be exhaustively
classified as actionable or as a proved non-actionable kind with no state effect.

The historical canonical base recorded here is
`482b707d716aee5641db25d40c2a954caee5d78f`, which understood migrations
through 46. PR #1768 merged canonical migration-41-through-43 history at
`cf1fc6e3e2d3faa3cae80737466f52d40e34b9bf`; migration 44 is the
token-accounting separation introduced by
`f14a53f85c490811daa3fd5d4cb1673abdd84296` and merged in PR #1790 as
`e0cfc1e12c75caaa27bbc278528b5fd5ccbb0218`. Migrations 45 and 46 are now
consumed by recovery-run status and durable background work. The recovery-receipt
chronology consumed migration 47, later durable work consumed migrations 48 through
52, and the current branch adds migration 53 for outbound-quarantine disposition and
retirement receipts. Durable canonical `not_sent` plus bounded terminal closure is
therefore allocated to migration 54, and the provider-event lifecycle ledger plus
activation contract is allocated to migration 55. Historical migrations are never
rewritten.

A **CausalOwner** is a discriminated immutable owner union. A `logical_turn`
owner contains the complete existing `TurnIdentity`; a `system_request` owner
contains a runtime-generated system-request ID, scope, manager, and generation; a
`session_generation` owner contains the manager, runtime generation, a runtime-
generated opaque adapter-session token, and control-segment identity. The token is
not a provider-native session ID or a content-derived value. Session/control events
never fabricate an inbound sequence or logical turn. Only `logical_turn` owners can
satisfy an external-user reply obligation or participate in empty-output/fallback
policy. External effects additionally require an immutable effect target: it equals
the logical turn's destination by default, and any redirect requires a separate
durable authorization. `system_request`, `session_generation`, control, and
unproved child origins default to internal no-send/no-effect handling.

## Requirements

#### REQ-001: Normalize causal provider-event envelopes
- **Status:** active
- **Superseded-by:** —
- **Statement:** WHEN a provider adapter emits an actionable provider event THE
  SYSTEM SHALL normalize it into a causal envelope before the event can affect
  runtime state.
- **Acceptance criteria:**
  - **REQ-001.AC-01:** Every normalized envelope carries a runtime receipt ID, an
    immutable `CausalOwner`, a provider-attempt and request-segment identity, an
    event ordinal, a bounded event kind and origin, byte length, and
    nullable runtime-generated opaque correlation tokens. Token/delta fragments
    for one completed bounded egress batch share one receipt; effects and
    request/turn boundaries do not. A stream without item IDs flushes batches on
    bounded size/time and non-text/result boundaries before owned egress.
  - **REQ-001.AC-02:** When a provider does not supply a native session, message,
    parent, task, tool-use, or item identity, the envelope records that field as
    unavailable and does not fabricate provider evidence. Native identifiers are
    used only transiently to resolve opaque tokens and are never persisted or
    content-derived.
  - **REQ-001.AC-03:** Correlation rejects an otherwise matching event when any
    field required by its owner variant differs. Logical-turn correlation compares
    conversation, inbound sequence, logical turn, manager, and generation;
    system/session correlation compares its immutable request/control identity,
    manager, and generation.
  - **REQ-001.AC-04:** Parser failures and unknown actionable event shapes produce a
    bounded envelope that can be quarantined instead of being logged and discarded;
    exhaustive adapter-event coverage prevents a new variant from falling through
    without an explicit classification.
  - **REQ-001.AC-05:** Normalization and durable observation occur at the adapter
    callback boundary before superseded-generation, missing-session-key, missing-
    map, missing-queue, missing immutable runtime context, missing inbound sequence,
    unavailable durability, unowned-result flushing, shutdown, or route-admission
    guards can return. Such guards
    quarantine an actionable event against its original owner/generation; proved
    provider log noise is explicitly classified non-actionable. FIFO immutable
    system-request identities may replace unowned per-scope result counters only for
    an exact adapter version/build whose capability contract proves a strictly
    serialized, non-interleaving request lane. Every other missing native request
    binding quarantines.
    A FIFO identity capability additionally proves gap-free accounting: every accepted
    request produces exactly one native terminal or explicit abandonment marker before
    the next request starts. Missing/duplicate terminal, cancel, or crash poisons that
    lane; later unbound events quarantine until generation reset and are never shifted
    onto an earlier request speculatively.
- **Verified-by:** {acceptance, contract, property}
- **Traces-to:** DES-001, DES-002

#### REQ-002: Persist an auditable disposition lifecycle
- **Status:** active
- **Superseded-by:** —
- **Statement:** WHEN the runtime observes an actionable provider event THE SYSTEM
  SHALL durably record its receipt and every subsequent disposition through the
  existing durability engine.
- **Acceptance criteria:**
  - **REQ-002.AC-01:** Before WhatSoup can start or send a provider request, the
    runtime supplies the exact durable logical request-chain identity, reserves the
    provider attempt idempotently at its ordinal, obtains its invocation claim, and commits
    that claim through the durability API. It crosses the provider-execution boundary
    only after `invocation_committed`, and only the claim owner may invoke. An expired
    pre-commit claim can be reclaimed; a crash after commit is uncertain and never
    automatically invokes that attempt again. A null-safe unique owner/request-chain/
    ordinal key makes the initial reservation and every handoff destination insert-or-
    return the same exact attempt; a conflicting duplicate fails closed. Two coordinators
    can never reserve and invoke distinct initial rows for one logical request. Zero event
    receipts is never proof that an opened attempt was empty.
  - **REQ-002.AC-02:** An event is durably `observed` before assistant text, a tool,
    turn completion, empty-output accounting, fallback, or recovery can consume it.
  - **REQ-002.AC-03:** The only valid event-state edges are `observed -> admitted`,
    `observed -> quarantined`, `admitted -> consumed`, guarded `admitted ->
    quarantined`, `quarantined -> admitted`, and `quarantined -> tombstoned`;
    invalid, skipped, or reverse transitions are rejected without changing the
    current state. Each receipt has a strictly increasing transition ordinal, at most
    six transitions, and at most one guarded quarantine-to-admitted readmission epoch.
    A later readmission request leaves the receipt quarantined/replay-vetoed and emits
    bounded health evidence; it cannot grow another cycle. Database constraints and a
    state-path property test prove no valid receipt history exceeds these bounds.
  - **REQ-002.AC-04:** Provider attempts move only from `open` to
    `closed_safe_empty`, `closed_safe_rejected`, `closed_with_evidence`, or
    `failed_uncertain`.
    `closed_safe_empty` is committed in the same compare-and-swap transaction that
    consumes the final boundary receipt and proves no open/unsafe provider-activity
    receipt, obligation, or effect; racing later events become post-terminal
    quarantine. Attempt state classifies provider/model execution, not runtime chrome.
    Sealed fallback/no-response/error notices and terminal presence effects retain
    their own delivery truth but do not convert proved empty/rejected attempts to
    `closed_with_evidence`. Their unresolved delivery may delay terminal publication
    or reply satisfaction without falsifying provider activity.
  - **REQ-002.AC-05:** Before WhatSoup attempts an outbound delivery or
    runtime-managed tool effect, consumption atomically creates every owned downstream
    operation/link/authorization, verifies bounded cardinalities, and inserts the
    immutable already-sealed effect-plan row last under deferred exact foreign-key
    checks. No unsealed plan state commits and plan sealing uses no UPDATE. The plan
    contains immutable per-effect-kind, attempt-activity-class, and total receipt/
    effect/link cardinalities, links every planned operation, or records a durable no-send
    outcome before an owned path returns. Shared plans are complete only when every
    contributing receipt and every typed effect is present. A receipt belongs to at
    most one effect plan for its lifetime; it may link to many effects inside that plan
    and many receipts may share the plan. Child/dynamic work uses a new
    `runtime_intent` receipt rather than a second plan. Triggers reject cross-plan
    membership. Each link is classified
    `provider_activity` or `runtime_terminal_chrome`; provider output/tool/internal-
    child/policy-no-send evidence uses the former, while automatic presence and
    fallback/no-response/error notices use the latter. Pre-provider and runtime-
    generated effects are owned by explicit `runtime_intent` receipts under the
    attempt; each periodic or nested effect receives its own sealed bounded child
    plan before execution.
    Independently, every effect link carries schema-checked reply-obligation role
    `origin_reply_candidate | terminal_failure_notice | intentional_silence |
    supplementary_nonreply | redirected_nonreply | internal_no_egress`, with immutable
    per-role plan counts and an exhaustive owner/target/effect-kind matrix. Only
    compatible terminal truth for an exact origin-target reply candidate or terminal
    failure notice satisfies by delivery; typed intentional silence satisfies only by
    its reviewed policy proof. Presence, control, child, redirect/ops, and supplementary
    roles never satisfy. New effect kinds fail closed until mapped.
    Agent-runtime downstream tables are structurally fenced: one non-exported,
    transaction-scoped producer capability permits an agent-origin operation only when
    its complete sealed plan/link set is created in that same transaction. A distinct
    enumerated non-agent producer capability preserves existing system/operator owners;
    default/raw downstream writes are denied. Agent code cannot select non-agent
    provenance, and static import/call-site guards plus database-authorizer/trigger tests
    reject an omitted or newly added direct effect seam.
    Plan admission bounds every known input/payload before execution and reserves a
    fixed content-free terminal-settlement row/byte allowance for every effect. Unknown
    post-effect results, transport IDs, and errors have typed byte limits. An oversized
    or unpersistable value records terminal `executed_result_unavailable` or
    `delivery_uncertain_after_execution` without raw content; it never retries the effect
    or defaults to complete/not-sent. The live bounded result may continue to its current
    owner, but lifecycle truth never depends on storing it. Normal settlement consumes
    the reservation; failure uses only the attempt's leased emergency CAS, and CAS
    failure leaves the already-durable executing operation/attempt as a replay veto for
    startup recovery.
  - **REQ-002.AC-06:** Provider-managed tool activity that cannot be interposed is
    recorded as already-effectful or uncertain as soon as observed, permanently
    vetoes automatic replay, and is never re-executed by recovery.
  - **REQ-002.AC-07:** If opening, observing, transitioning, linking, lifecycle
    summary reads, or recovery inspection fails, the runtime admits no new
    WhatSoup-owned effect, empty classification, or fallback; it latches in-memory
    unsafe evidence and surfaces terminal/health escalation. Callers cannot
    catch-and-default a failed read or post-effect write to no receipts, complete, or
    not-sent. An open attempt or already-durable executing operation preserves
    uncertainty about provider-managed effects across restart and is never re-executed.
  - **REQ-002.AC-08:** Re-observing an event with the same proven identity is
    idempotent and cannot duplicate an outbound operation, a tool invocation, or a
    terminal disposition.
  - **REQ-002.AC-09:** Every actionable event ends with a queryable current state,
    append-only transition history, bounded disposition or no-send reason, and its
    exact immutable `CausalOwner` variant. Normalization, silent compact, route hold/buffer,
    provider-failure/auto-switch, empty normalization, outbound echo/policy,
    generation/session-key/map/queue rejection, minimal-result suppression,
    terminal dedupe, `AskUserQuestion` suppression, and every other adapter-to-
    effect exit either records that disposition or fails closed; none may silently
    discard activity.
  - **REQ-002.AC-10:** Every terminal provider-attempt boundary has receipt role
    `attempt_boundary` and an immutable kind `provider_final |
    runtime_pre_execution_rejection | runtime_failure_abandonment`. Only the idempotent
    `finalizeAttemptBoundary` operation may
    consume it; generic receipt recovery cannot. One caller-owned database
    transaction consumes the boundary receipt, closes that attempt, and commits
    attempt bookkeeping. Attempt closure does not itself terminalize a
    `logical_turn`. If a proved fallback/retry is selected, the same transaction
    compare-and-swaps a single immutable `provider_attempt_handoff` and creates the
    next `open` attempt under the same turn/recovery owner before any new provider
    invocation; no turn-terminal CAS or inbound disposition occurs. Automatic
    fallback notices and presence never delay this atomic handoff: their sealed
    runtime-chrome plans settle independently. Only when there is no continuation/
    retry owner and zero open obligations/request segments may the final logical-turn
    transaction perform the existing terminal CAS and inbound disposition. A
    `system_request` or `session_generation` owner closes without fabricating either
    turn-terminal or inbound state. The attempt closure matrix is: proved no
    provider/model activity `closed_safe_empty`; proved pre-execution rejection
    `closed_safe_rejected`; sealed `provider_activity` output, tool, or no-send
    evidence `closed_with_evidence`; runtime-terminal chrome leaves the provider
    attempt classification unchanged; crash, unknown error, or persistence/ownership
    ambiguity `failed_uncertain`. Successful close/handoff/turn publication consumes an
    exact `attempt_finality` receipt; a typed failure-abandonment boundary may instead
    terminalize as failed-uncertain without asserting successful provider finality.
    Intermediate results leave the attempt open, and
    duplicate/late closure loses CAS without partial state. A causally terminal
    provider error/crash with open obligations first invalidates/aborts only the
    affected attempt/session generation, durably marks remaining segments and
    obligations abandoned-uncertain, then closes `failed_uncertain`; a logical-turn
    owner terminalizes as failure, while racing old-generation child output
    quarantines. This is not successful obligation closure and does not invoke broad
    queue/session cancellation. Unique handoff identity and attempt-open CAS prevent
    duplicate schedulers; a crash before the next provider invocation preserves the
    content-free handoff/open-attempt evidence and follows fail-closed recovery rather
    than terminalizing the prior attempt as the completed user turn. If invocation is
    committed but no provider boundary exists when exact crash/restart/shutdown/runtime-
    fence evidence proves that generation abandoned, the same unique boundary slot
    admits `runtime_failure_abandonment`; one transaction fences the generation,
    abandons open segments/obligations uncertain, consumes the boundary, closes
    `failed_uncertain`, and terminalizes only a logical-turn owner as failure. A reserved
    or claimed attempt whose exact prompt/idempotency owner is absent uses
    `runtime_pre_execution_rejection` with positive never-invoked/non-fallback proof.
    Duplicate recovery workers and a racing late native boundary have one CAS winner;
    rollback leaves the original open replay veto intact.
    Required final publication effects—including answer outbound operations and no-
    response/error chrome—never hold the provider boundary open indefinitely. The final
    transaction either consumes terminal delivery truth or atomically transfers every
    exact unresolved publication operation into the bounded terminal recovery owner;
    provider-activity classification remains independent. Migration-44 closure then
    reaches echo/not-sent/abandoned-uncertain without replay or false reply satisfaction.
    Crashes before publication settlement/transfer and before/after finalization are
    idempotent and never permit generic boundary consumption.
  - **REQ-002.AC-11:** Agent-provider MCP execution carries a cryptographically
    unguessable, non-loggable effect-admission token from provider adapter or CLI
    socket through a trusted, non-enumerable/out-of-band `SessionContext` field and
    `ToolRegistry`. It is never serialized into model/provider-visible content, MCP tool
    arguments, prompts, stream frames, provider transcripts, errors, or diagnostics;
    handlers receive only the internal consumed authorization result. The token is exact-bound to
    owner, generation, attempt, receipt/effect plan, tool intent, execution origin,
    and exact request segment, and is atomically consumed once. The runtime seals and links the parent
    tool intent before invoking a handler; missing, substituted, stale, or reused
    tokens and durability failure return a tool error without execution. Concurrent
    reuse reconciles the existing durable effect and never invokes twice. For CLI
    MCP, the socket request/receipt is authoritative execution evidence; later stdout
    is joined only by a version/build-gated native correlation field, never by name,
    arguments, timing, or FIFO. Unjoinable stdout is independently recorded as
    already-effectful or uncertain. Authenticated out-of-band operator recovery uses
    a distinct audited origin and cannot masquerade as an agent-owned call. A child-
    origin CLI MCP request may execute only when the exact child segment, obligation,
    and parent tool intent were durably registered before the socket request and a pre-
    handler socket/connection field proves those same identities under an exact build-
    gated registration-before-child-effect capability; the tool policy must explicitly
    permit that origin. A child request racing ahead of durable registration fails before
    handler execution and later stdout cannot authorize it. `system_request`,
    `session_generation`, control, missing-
    origin, stale-connection, and unproved child calls return a tool error and
    quarantine before handler execution; later stdout can corroborate but never
    retroactively authorize an effect.
  - **REQ-002.AC-12:** A checked effect-seam manifest covers text, chunked and
    aggregated text, media/voice, polls, reactions, presence/typing updates, direct
    notices, redirected tool status, nested tool-created outbound operations,
    runtime-managed tools, provider-managed uncertain effects, and no-send outcomes.
    Every plan has exactly one owner and one target. Its default target is the
    immutable logical-turn destination; non-turn owners have no external target.
    Redirected/cross-chat effects require a separate exact durable authorization issued
    only by the existing authenticated routing-policy owner through a distinct non-
    exported issuance capability; a plan creator may consume but never mint it. The
    authorization binds immutable issuer, policy decision/request, actor, source owner/
    generation/segment, exact target, issue/expiry time, and one-shot consumption. It
    cannot be self-authorized, substituted, replayed, or reused. Redirected effects
    never share an aggregate with the source target. Presence is exact-targeted,
    non-replayable, cannot satisfy a reply obligation,
    and records terminal sent/not-sent/uncertain truth without recovery re-emission.
    All three presence outcomes are terminal ephemeral evidence: they neither set
    replay-unsafe nor block `closed_safe_empty`, and cannot be counted as provider
    output, tool activity, or reply satisfaction.
    Hierarchical plans seal the parent tool intent first and each child effect before
    that child runs. Each presence refresh is a separately sealed `runtime_intent`
    child plan, bounded by configured count and duration, and is never re-emitted by
    recovery.
    The checked seam manifest includes every canonical `AssistantTextEgressDecision`
    suppression reason: `send_verification`, `ack_filler`, `noop`,
    `internal_narration`, and `progress_filler`. Each observes the provider text and
    seals a typed no-send plan; the text remains provider-activity/replay-veto evidence
    while reply satisfaction is independent. `send_verification` satisfies only from
    an exact same-`CausalOwner`, same immutable origin target, reply-bearing publication-
    set operation with compatible terminal delivery truth—never any timestamp-adjacent
    or cross-chat `fromMe` message. Reviewed `ack_filler`/`noop` alone may seal typed
    `intentional_silence` and satisfy without egress; delivery-asserting ack forms stay
    `send_verification`. Narration/progress/failure suppression never satisfies. Persist
    only bounded reason/evidence references, not suppressed text or previews.
    The manifest is exhaustive over every `OutboundMessageSafetyDecision` action/reason,
    including `allow`, `redact`, `divert`, `suppress`, `internal_artifact`, and
    `false_infra_block_claim`; a new union variant fails the source/manifest guard until
    classified. `allow` seals the normal origin operation. `redact` seals only the
    sanitized origin-target operation and may satisfy from its delivery truth; lifecycle
    persists neither original nor transformed content. `divert` requires the separate
    authenticated routing authorization and a distinct ops-target `redirected_nonreply`
    plan, never shares the source aggregate or satisfies/disarms it, and leaves the
    source under an explicit reviewed terminal-notice/no-send disposition even when the
    ops delivery fails.
  - **REQ-002.AC-13:** `DurabilityEngine` atomically persists every attempt first as
    `open`/`reserved` and exposes compare-and-swap storage primitives for
    `reserved -> invocation_claimed -> invocation_committed`. Schema constraints bind
    claim owner/epoch/lease coherently, prohibit reverse/skipped transitions, and
    make post-commit re-invocation impossible. The attempt-open transaction acquires
    its globally accounted emergency byte lease, materializes the durable open-attempt
    replay veto, and, on first use, inserts the activation marker. Its immutable request-
    chain identity comes from the caller's already-durable inbound/system/session request,
    never a coordinator-local random value. Reservation uses insert-or-return exact match
    under `UNIQUE(owner variant/token, request_chain_id, attempt_ordinal)`; provider,
    capability, budget, target, or owner mismatch on conflict is an integrity failure.
- **Verified-by:** {acceptance, contract, property}
- **Traces-to:** DES-002, DES-003

#### REQ-003: Preserve valid live continuations across request boundaries
- **Status:** active
- **Superseded-by:** —
- **Statement:** WHILE an active logical turn owns registered background work THE
  SYSTEM SHALL treat an intermediate provider result as a request boundary rather
  than conclusive proof that the logical turn has ended.
- **Acceptance criteria:**
  - **REQ-003.AC-01:** For runtime-managed tools and interposable API adapters,
    background-work registration durably opens a request-segment row and a
    continuation-obligation row before scheduling the work. An external CLI may
    schedule provider-managed work before WhatSoup observes its registration frame;
    at the adapter callback WhatSoup persists that frame and obligation before
    admitting any subsequent event or owned effect. That weaker ordering is enabled
    only for an exact version/build-gated CLI contract whose authoritative proof shows
    the native registration frame precedes every child MCP/effect request, completion,
    and final-boundary frame. Persistence
    failure after an un-interposable schedule records/latches already-effectful or
    uncertain evidence, aborts the provider transport, blocks subsequent owned
    effects, and vetoes replay. A race fixture blocks the registration durability call
    while the CLI schedules work and emits completion/final frames; no later frame,
    effect, successful obligation closure, fallback, or replay may escape the blocked
    durability boundary. A child socket request emitted while that registration write is
    blocked fails before handler execution and cannot be retroactively authorized.
    Closure or abandonment is an append-only, compare-and-swap disposition bound to
    the same owner, attempt, segment, task/tool, and generation; duplicate or out-of-
    order closure cannot decrement or erase another obligation. A fixture containing
    background-work registration, an
    intermediate request result, a correlated completion that reduces the open-
    obligation count, a parent answer, and a later causally final provider boundary
    admits and consumes the parent answer exactly once and commits terminal ownership
    exactly once under the original `TurnIdentity`. Obligation closure never
    independently finalizes; logical-turn finalization requires both the causally
    final provider boundary and zero durably open obligations/request segments.
  - **REQ-003.AC-02:** A continuation is admitted only when capability-specific
    provider-native event kind/origin and session, request, task, tool-use, or
    parent evidence prove ownership by the same live logical turn, generation, and
    tested adapter/provider version, exact launch-bound CLI executable/source/interpreter
    chain fingerprint, and content-free protocol-affecting capability-context fingerprint
    (or immutable loaded SDK/module, API contract-schema, and negotiated-feature
    fingerprint). XML-like content or identifier text alone is
    never ownership evidence.
  - **REQ-003.AC-03:** Admitted task/control frames append durable segment/obligation
    transitions without external egress. Completion closes only its exact open
    obligation; terminal error/crash abandons it uncertain rather than pretending it
    completed. Correlated child-assistant output with a
    non-null parent tool identity is consumed through a sealed `internal_child_output`
    no-send effect and cannot become WhatsApp text or tool activity. Child/control/
    presence evidence never satisfies or disarms the external-user reply guarantee;
    internal child output remains provider-activity/replay-veto evidence despite no
    egress. Only a proved inert reminder with no control/state effect is eligible for deterministic
    policy tombstoning. Fixtures prove only the null-parent top-level answer is
    delivered.
  - **REQ-003.AC-04:** A late, duplicate, out-of-order, cross-conversation,
    cross-generation, or insufficiently identified continuation is quarantined
    without output or tool execution.
  - **REQ-003.AC-05:** A sanitized provider-contract golden fixture for each
    continuation-capable adapter/version/build preserves real event kinds and synthetic
    session/request/task/tool/parent bindings. One-field perturbation negatives
    test every required binding. Capability activation additionally requires either an
    authoritative provider/API contract or audited exact-source control-flow proof tied
    to the launched fingerprint; repeated/stress fixtures alone are corroboration and
    cannot prove universal native-terminal or registration ordering. Where only empirical
    ordering exists, native-terminal/child-origin capabilities remain disabled, while a
    locally proved stream-EOF-plus-drained-queue finality path may remain available. The checked-in
    `provider-contract-claude-code-2.1.207.json` is explicitly a non-gating design
    specimen because its raw-source provenance was not retained. TSK-002 must replace
    it with reproducibly captured content-free evidence carrying capture mode, a
    prompt-omitting command template, exact executable/source/interpreter launch-chain
    identity, authoritative proof-manifest, content-free capability-context schema/
    fingerprint, projection/sanitizer version, and before/after event counts. Until then, and for
    any adapter/version/build lacking equivalent direct binding, continuation support
    remains disabled and events quarantine.
  - **REQ-003.AC-06:** Every successful invoked-attempt closure—including
    `closed_with_evidence`, safe-empty, and safe-rejected—every fallback handoff, and
    every successful logical-turn finalization/publication may occur only after an exact version/build/launch-
    context/API-contract
    `causal_finality` capability proves a serialized barrier. The barrier is either
    stream EOF with the decoder/callback queue drained, or a native terminal event
    contractually guaranteed to occur only after every provider-managed continuation
    registration and actionable frame for that request; a result event, zero currently
    known obligations, idle timeout, or empty callback queue alone is not finality.
    Streaming output and other admitted effects may execute before this barrier, but
    terminal CAS, logical-turn publication, queue cleanup, and fallback scheduling are
    serialized behind it. Missing/drifted capability closes an invoked attempt
    failed-uncertain with no fallback even when receipts/obligations are zero. An
    explicit transport crash/error or AC-07 typed recovery boundary may likewise close
    the attempt and logical turn failed-uncertain without reply satisfaction, delivery
    truth, or successful-finality claim. Known missing/drifted finality capability is rejected before
    provider invocation through a typed never-crossed, non-fallback boundary; only proof
    loss discovered after commit uses failed-uncertain recovery. Crossing the barrier
    appends an explicit-role `attempt_finality` receipt carrying
    bounded `finality_kind=stream_eof_drained|native_terminal`, exact capability-
    contract/context/proof-manifest fingerprint/version, owner/attempt/request-segment,
    barrier event ordinal, immutable invocation epoch/generation recorded on the attempt,
    and proof timestamp. The attempt-boundary close/handoff transaction
    foreign-key references and consumes that exact proof; it cannot infer finality from
    closed state after restart. Restart validates the historical proof against that
    attempt's invocation epoch, not the recovering process epoch; only a mismatch is stale.
    Generic settlement/recovery cannot transition or consume this role. A fixture emits
    result/zero obligations, then delayed background
    registration/text/tool frames—both with and without earlier visible output/tool
    evidence—while the barrier is held and proves no terminal closure, logical-turn
    finalization, or destination invocation crosses it. An invocation-gate
    `runtime_pre_execution_rejection` whose provider boundary provably never crossed
    is exempt because no provider stream exists.
- **Verified-by:** {acceptance, contract, property}
- **Traces-to:** DES-001, DES-004

#### REQ-004: Quarantine ambiguity and tombstone only proved dead events
- **Status:** active
- **Superseded-by:** —
- **Statement:** WHEN event ownership or safe consumption cannot be proved THE
  SYSTEM SHALL quarantine the event with no output, tool execution, empty-output
  classification, fallback replay, or automatic content recovery.
- **Acceptance criteria:**
  - **REQ-004.AC-01:** Each quarantine records a bounded reason code, receipt and
    exact `CausalOwner` reference, proof status, actor, and timestamp without
    retaining event content. Only a `logical_turn` reference contains inbound or
    turn identity; system-request and session-generation references contain only
    the fields of their own owner variants.
  - **REQ-004.AC-02:** A quarantined event can become admitted only when exact
    same-live-generation ownership evidence is added, its payload remains in the
    bounded readmittable in-memory cache, and its reason permits readmission. Cache
    eviction, oversize input, generation retirement, tombstoning, or loss of the
    owned bytes irreversibly disables readmission; the owned bytes are released and
    zeroized where the runtime representation permits.
  - **REQ-004.AC-03:** In this change set a quarantine can become tombstoned only
    after bounded deterministic policy proof (for example, exact duplicate or a
    version/build-gated non-user lifecycle kind) and expected-state compare-and-swap.
    There is no operator mutation endpoint, caller-supplied actor/proof text, or
    general tombstone command; a future operator control plane requires its own
    authenticated protocol and review.
  - **REQ-004.AC-04:** Time-to-live expiration alone cannot admit, tombstone, delete,
    or otherwise resolve an open quarantine.
  - **REQ-004.AC-05:** Tombstoned events carry `replay_policy=never` and cannot be
    delivered, executed, reattached to a later turn, or used as recovery content.
    For a quarantined event, `never` forbids automatic prompt/event replay or
    reconstruction but not first-time live consumption after a permitted
    same-generation readmission.
  - **REQ-004.AC-06:** Duplicate, policy-suppressed, ownership-ambiguous,
    parse-invalid, and restart-ambiguous events have distinguishable disposition
    reasons.
  - **REQ-004.AC-07:** Deterministic tombstone policy is a closed enum keyed by
    tested adapter/version/build and event kind. Unknown kinds/versions/builds and human-only
    judgments remain quarantined indefinitely until a separately reviewed policy
    or control-plane change exists.
- **Verified-by:** {acceptance, contract, property}
- **Traces-to:** DES-003, DES-005

#### REQ-005: Make replay safety monotonic and evidence based
- **Status:** active
- **Superseded-by:** —
- **Statement:** WHEN a turn observes provider activity that makes repeat execution
  uncertain THE SYSTEM SHALL irreversibly veto automatic prompt replay for that
  turn attempt.
- **Acceptance criteria:**
  - **REQ-005.AC-01:** Assistant output, tool use, tool result, parser error,
    unknown event, registered background work, quarantine, ambiguous ownership,
    uncertain non-ephemeral delivery, or a post-terminal event changes replay safety
    from true to false for the attempt. A sealed terminal presence outcome is the
    explicit exception because it is runtime chrome, not provider/model activity.
  - **REQ-005.AC-02:** No runtime, fallback, shutdown, or recovery path can change an
    attempt's replay safety from false back to true.
  - **REQ-005.AC-03:** An external-user turn is eligible for empty-output accounting
    only when its provider attempt has a positive `closed_safe_empty` disposition,
    all observed non-ephemeral events have safe terminal dispositions, and none
    supplied output, tool activity, background work, quarantine, or ambiguity.
    Terminal runtime-chrome evidence, including presence and an empty/fallback notice,
    is ignored for this provider-activity predicate. A missing receipt or
    open/failed attempt is unsafe, not empty.
  - **REQ-005.AC-04:** Provider fallback can replay an original prompt only when the
    immutable turn evidence remains replay-safe and the existing recovery owner
    carries the required idempotency proof. For every invoked attempt the exact
    adapter's causal-finality barrier from REQ-003.AC-06 must also be durably proved;
    provider-never-invoked runtime rejection is the sole exception. Attempt close, unique handoff reservation,
    and creation of the next open attempt are one transaction; only the handoff owner
    may invoke it, and no turn-terminal/inbound mutation occurs until the final attempt.
    The original turn stores an immutable bounded fallback-chain snapshot and retry
    budget. Handoffs advance a strictly increasing attempt ordinal, cannot self-link
    or form a cycle, reserve destination lifecycle capacity atomically, and cannot
    exceed eight total attempts or the captured lower policy limit. Configuration
    drift cannot alter an existing chain. The destination attempt follows AC-01's
    invocation claim protocol, so competing workers cannot invoke it twice.
  - **REQ-005.AC-05:** A genuinely empty external-user turn with no veto evidence
    continues to follow the existing consecutive-empty threshold and fallback
    policy.
  - **REQ-005.AC-06:** `closed_safe_rejected` permits existing typed fallback only
    when both (a) the provider was provably never invoked or a version/build-gated
    native pre-execution rejection proves no provider/model output, tool, background
    work, or provider-originated effect and (b) a separately typed, policy-allowed
    rejection reason authorizes that fallback. A conflated or unknown
    `admission_rejected` may close/terminalize safely but never creates a handoff,
    fallback, replay, or requeue. `queue_full`, `queue_halted`, `queue_closed`,
    `pre_dispatch_failure`, and `scope_blocked_recovery` are explicit negative cases
    until their individual policy says otherwise.
    It never increments empty-output counters. Rejection after any activity,
    text-pattern-only error classification, untested versions, network ambiguity,
    and ambiguous server errors close `failed_uncertain` and veto replay.
    When invocation provably never occurred, the runtime creates a typed
    `runtime_pre_execution_rejection` boundary receipt under the already-open
    attempt and exact owner; the caller-owned closure transaction records its
    observed/admitted/consumed transitions and the invocation-gate proof before
    closing `closed_safe_rejected`. Absence of a provider frame is not itself proof.
    Provider-native safe rejection is enabled per adapter/version/build only when a
    separate sanitized contract fixture and capability-registry bit prove native
    pre-execution/no-activity semantics and causal finality for the invoked provider
    request; otherwise the attempt is `failed_uncertain`. Runtime rejection before the
    provider boundary needs invocation-gate proof but no provider finality barrier.
- **Verified-by:** {acceptance, contract, property}
- **Traces-to:** DES-005, DES-006

#### REQ-006: Recover lifecycle state without reconstructing provider content
- **Status:** active
- **Superseded-by:** —
- **Statement:** WHEN the runtime starts or stops with nonterminal provider-event
  receipts THE SYSTEM SHALL reconcile durable evidence fail closed without
  reconstructing or blindly replaying discarded provider content.
- **Acceptance criteria:**
  - **REQ-006.AC-01:** Startup reconciles every open provider attempt by invocation
    phase. A `reserved` attempt may be claimed only by its exact durable handoff/
    recovery owner, within the immutable budget, while that owner already holds the
    prompt and idempotency proof; lifecycle storage never reconstructs it. An expired
    `invocation_claimed` lease may be reclaimed because provider execution is
    forbidden before commit. Every pre-commit attempt has an immutable execution-owner
    deadline no later than five minutes after reservation; progress/restart cannot extend
    it. Missing prompt/idempotency ownership, absent owner, expiry, or lost reclaim races
    a unique never-invoked non-fallback boundary. An `invocation_committed` attempt
    without a proved terminal boundary is fenced to its immutable invocation generation,
    closed through the typed failure-abandonment boundary, and never invoked again.
    Startup converts an `observed` event lacking proved durable
    downstream effects and an `admitted` event lacking its required complete
    effect links to restart-ambiguous quarantine, and vetoes replay. A reserved
    attempt handoff never makes the previous attempt a terminal user turn: startup
    reconciles its next-attempt invocation evidence through the existing recovery
    owner, never schedules it twice, and cannot reconstruct prompt content. Cyclic,
    over-budget, capacity-unreserved, or owner-mismatched handoffs fail closed.
  - **REQ-006.AC-02:** An admitted or consumed event with a sealed,
    cardinality-complete effect plan is not consumed a second time. Outbound and
    runtime-tool operations delegate to their existing durability owners. A sealed
    no-send or presence plan is never re-emitted and settles only from its recorded
    terminal truth. Provider-managed already-effectful/uncertain evidence is never
    delegated or re-executed; terminal already-effectful proof may settle consumed,
    while missing/nonterminal truth settles bounded quarantine and leaves the
    attempt failed-uncertain.
  - **REQ-006.AC-03:** A runtime-generation change prevents pre-restart events from
    attaching to a newly admitted logical turn even when provider-native IDs are
    reused.
  - **REQ-006.AC-04:** Shutdown, lifecycle-persistence failure, and terminal
    finalization preserve all available attempt, receipt, and transition evidence
    and cannot convert ambiguity into successful completion or replay safety.
  - **REQ-006.AC-05:** Generic lifecycle reconciliation compare-and-swaps an
    associated non-boundary `admitted` receipt to `consumed` only after every typed effect in every sealed
    shared plan reports compatible terminal truth; otherwise it records a bounded
    quarantine without repeating any effect. Outbound/tool owners report their
    existing terminal states; canonical `not_sent` is positive no-transmission
    evidence, while `failed_permanent` is not a no-send classification and remains
    uncertain. No-send/presence truth settles locally without re-emission, and
    provider-managed effects follow AC-02. Settlement is idempotent and is required
    before any receipt or shared plan becomes retention-eligible. It never consumes
    an `attempt_boundary` or `attempt_finality`. Once required terminal publication
    settles or is durably transferable to the bounded terminal owner, recovery invokes
    `finalizeAttemptBoundary`, which revalidates the causal-final boundary, durable
    zero-obligation/segment predicate, handoff choice, owner/target equality, and
    final terminal CAS in one transaction. Crash points before/after chrome
    settlement and before/after this transaction prove exactly-once closure.
  - **REQ-006.AC-06:** Every transferred terminal owner carries an immutable database-
    UTC block start/deadline no later than 300 seconds after terminal creation;
    migration 54 backfills legacy transfers. Progress, heartbeat, retry, operator
    action, or restart cannot extend it. Jobs persist a monotonic wall-clock high-water
    mark and the live process also tracks monotonic elapsed time. Database time before
    terminal/start, or more than the exported five-second tolerance below that high-
    water mark, makes the owner due for fail-closed abandonment or sticky alerted
    clock-integrity failure—never ordinary blocking. Before the deadline only exact pending or actively
    claimed, unexpired recovery may block provider admission, and lease/backoff cannot
    extend beyond it. A new inbound arriving during that valid block remains durably
    `deferred_by_recovery_scope` in original FIFO order with no provider attempt. Depth
    is capped by the durable equivalent of `agentMaxQueueDepth`; its latest possible
    deferral time is the immutable recovery block deadline, never a sliding TTL.
    Closure atomically changes the bounded FIFO set to durable `ready` state; it never
    directly starts provider work. Startup, the periodic supervisor, and the normal
    admission drainer CAS-claim ready rows oldest-first with owner/epoch until empty;
    an in-memory wake is only a hint. New ingress cannot overtake existing deferred/
    ready rows. Capacity failure terminalizes with a sealed explicit failure notice
    rather than silent loss. This is first-time admission, never prompt replay.
    At canonical no-send, fifth-attempt exhaustion, claim/owner expiry, or
    the deadline, startup, the periodic supervisor, admission, echo, and the audited
    operator resolver call one `BEGIN IMMEDIATE` exact-identity closure transaction.
    The resolver reuses the existing authenticated/authorized control surface and
    binds immutable actor ID, request ID, bounded reason enum, instance, conversation
    scope, and terminal owner. Exact replay returns the same witness; unauthenticated,
    cross-instance/scope, stale, substituted, conflicting-replay, or competing requests
    are denied and audited. This resolver cannot mutate provider quarantine.
    It revalidates terminal/job/inbound plus the selected representative operation and,
    for migration-55 turns, the final attempt's exact immutable publication-set seal/
    membership, plus assignment/claim epochs; inserts or
    returns an append-only unique `turn_recovery_terminal_closures` witness with
    closure `echoed | not_sent | abandoned_uncertain`, bounded
    trigger/resolver/proof fields, exact source identities, and replay policy `never`;
    compare-and-swaps the source inbound to complete/failed as appropriate; and
    releases scope and readies the bounded deferred FIFO in the same commit without rewriting the terminal record,
    consuming an attempt boundary, reconstructing content, or replaying work. Echo or
    canonical op-level no-send may claim only its exact truth; every other exhausted,
    expired, blocked, or terminal-non-echoed path becomes `abandoned_uncertain` and
    never asserts delivery. Aggregate truth is restart-rederived: an eligible member
    echo proves reply delivery only under the reviewed aggregate rule, every member
    canonical not-sent proves no-send, and mixed/pending/uncertain states remain
    uncertain; the selected op is representative, not the set. Abandonment also compare-
    and-swaps every referenced nonterminal publication-set operation to a terminal replay-never delivery-
    uncertain state; outbound claim/send/retry/recovery selectors exclude any operation
    rooted by the witness. A send claim, closure, and echo serialize under the same
    identity so no new send begins after abandonment. Echo/abandon/operator/startup/
    restart races have exactly one witness winner. If abandonment wins, an already in-
    flight transport may later report submitted/echoed only through the explicit late-
    truth conflict transaction; it never reopens, retries, or authorizes replay. A
    structurally valid orphan transfer uses the same transaction with no job; corrupt
    identity is a sticky integrity incident. No `processing` inbound may be excluded
    from every terminal path merely because a terminal/recovery record exists, and at
    or after the deadline admission must close the due owner or enter sticky alerted
    database/integrity failure rather than return an ordinary scope block.
  - **REQ-006.AC-07:** Attempt recovery is total before terminal transfer. Each pre-
    commit attempt has an immutable execution-owner deadline (maximum five minutes).
    Healthy live committed work has no new wall-time cutoff and remains governed by the
    existing watchdog policy. Only after positive invocation-owner/generation loss,
    crash, or fence evidence is durably recorded does an immutable recovery deadline
    begin, no later than five minutes after detection. The attempt null-to-set CAS binds
    bounded loss reason/proof/detector, fenced generation, database-UTC detection time,
    deadline, recovery epoch, and a due index. It uses AC-06's persisted wall-clock high-
    water/live-monotonic/five-second rollback discipline; progress/restart cannot extend
    it, and backward-clock uncertainty is due or sticky-alerted, never ordinary blocking.
    New inbounds during this preterminal recovery epoch use AC-06's same durable depth-
    capped FIFO bound to the exact attempt/recovery epoch and immutable deadline; they
    cannot start/overtake and become ready atomically when this recovery closes or
    transfers to the terminal owner. Startup,
    shutdown, the periodic supervisor, and exact admission call one idempotent
    `recoverAbandonedAttemptBoundary` transaction. When positive never-invoked owner-
    loss proof or a fenced committed-generation crash/expiry exists and no valid boundary
    won, it inserts the unique typed boundary and calls the same transaction-scoped
    `finalizeAttemptBoundary` primitive (no nested transaction), marks every open
    segment/obligation abandoned-uncertain, consumes only that boundary, closes safe-rejected with a non-
    fallback reason before commit or failed-uncertain after commit, and terminalizes a
    logical-turn/inbound as failed in the same commit. Non-turn owners fabricate no turn
    state. It never claims causal finality, delivery, reply satisfaction, or no provider
    activity after commit; never reconstructs content, hands off, replays, or reinvokes;
    and releases request-chain/capacity roots only after durable closure. Reclaim,
    provider-final, late-frame, duplicate-worker, restart, and rollback races have one
    exact boundary winner. Before a committed failure boundary, the recovery fence
    atomically revokes generation effect tokens/claims, closes its MCP connections,
    makes stdout quarantine-only, and targets only the exact provider process identity
    (PID plus start time, executable/session/generation proof) for abort. PID mismatch/
    reuse never kills. Conflicting replacement admission waits for proved exit; an
    unprovable/unkillable orphan raises a sticky incident and blocks only that provider/
    session, while late effects remain denied/quarantined. Already-launched provider-
    managed side effects remain failed-uncertain, never falsely cancelled.
    Required terminal publication operations are either terminal or captured in an
    immutable `failure_abandonment` publication fence after generation revocation. That
    fence enumerates all already-created reply-bearing operations, rejects/quarantines
    later plan/frame creation, transfers the exact set to AC-06's bounded recovery owner,
    and asserts only delivery-uncertain/replay-never—not successful finality, reply, or
    completeness of provider-managed effects. No unresolved effect may root scope indefinitely.
- **Verified-by:** {acceptance, contract, property}
- **Traces-to:** DES-003, DES-006

#### REQ-007: Expose bounded lifecycle observability
- **Status:** active
- **Superseded-by:** —
- **Statement:** WHEN provider-event lifecycle state changes THE SYSTEM SHALL emit
  content-free, correlation-safe diagnostics sufficient to distinguish admission,
  quarantine, tombstoning, consumption, and replay vetoes.
- **Acceptance criteria:**
  - **REQ-007.AC-01:** Structured logs include receipt ID, bounded event kind,
    bounded origin, disposition reason, state transition, owner discriminator, and
    approved redacted/hashed runtime correlation projection while excluding provider
    content, tool payloads, effect-admission tokens, raw conversation keys, chat/JID
    fields, and other exact-owner identifiers. Exact `CausalOwner` fields remain
    available only in authorized durability inspection. Only `logical_turn` owners
    emit the existing approved turn-identity projection; other variants never
    fabricate it. The same
    exclusion applies to existing result/tool/unknown/parse diagnostics, operations
    alerts, crash sidecars, and any other persisted diagnostic sink exercised by
    the lifecycle fixtures.
  - **REQ-007.AC-02:** Runtime health statistics expose counts of open observed,
    admitted, consumed, quarantined, and tombstoned receipts plus bounded reason
    totals.
  - **REQ-007.AC-03:** Durability inspection can retrieve a receipt's current state
    and transition history by receipt ID or exact `CausalOwner`.
  - **REQ-007.AC-04:** Suppression, empty-output rejection, and fallback replay veto
    diagnostics identify the governing receipt or exact causal-owner evidence rather than
    reporting a generic provider-empty condition.
  - **REQ-007.AC-05:** A checked diagnostic-sink manifest enumerates every
    WhatSoup-owned provider, parser, result, outbound, tool, terminal-dedupe,
    operations-alert, crash-sidecar, and health sink by source location. Targeted
    canary tests force each sink, and a static guard rejects prohibited preview,
    raw-value, and content/native-ID hash fields where mechanically detectable.
- **Verified-by:** {acceptance, contract, review}
- **Traces-to:** DES-007

## Constraints

#### CON-001: Content-minimizing persistence
- **Status:** active
- **Superseded-by:** —
- **Statement:** Provider-event lifecycle storage and every WhatSoup-owned
  diagnostic sink must not persist raw frames, assistant text, tool inputs, tool results,
  prompts, provider-native identifiers, content-derived identifiers, or
  bounded/redacted content previews.
- **Acceptance criteria:**
  - **CON-001.AC-01:** The schema stores only bounded enums, runtime identities,
    opaque randomly generated correlation tokens, byte lengths, timestamps,
    disposition evidence, and existing turn or operation references. It stores no
    unkeyed or keyed content/native-identifier digest.
  - **CON-001.AC-02:** Migration, unit, and log-capture tests prove that unique
    fixture content, its raw SHA-256, its test-keyed digest, and provider-native
    identifiers are absent from provider-event tables and WhatSoup-owned logs,
    alerts, and sidecars. Provider-owned transcripts and existing downstream
    outbound/tool stores retain their separate declared content/retention ownership;
    the lifecycle never duplicates them.
  - **CON-001.AC-03:** Persisted text fields have explicit byte limits and reject
    over-limit values rather than truncating identity or proof data silently. Runtime
    enforcement uses `Buffer.byteLength(canonicalValue, 'utf8')`; SQLite uses
    `typeof(column)='text'` plus `length(CAST(column AS BLOB))` and an explicit control/
    NUL policy, never character/code-unit length. Transaction accounting measures actual
    encoded bound parameters/blobs. Transient provider-native causal fields and live-map
    keys are subject to named per-field, per-attempt entry/byte, and global byte limits;
    oversize or exhausted identities become unavailable/ambiguous quarantine, never
    truncated into a match. Surrogate-invalid input is rejected before canonicalization.
- **Verified-by:** {acceptance, contract, property}
- **Traces-to:** DES-002, DES-007

#### CON-002: One durability and terminal-ownership model
- **Status:** active
- **Superseded-by:** —
- **Statement:** The lifecycle must extend `DurabilityEngine`; it must not create a
  parallel journal, terminal owner, fallback queue, or provider-content replay
  subsystem.
- **Acceptance criteria:**
  - **CON-002.AC-01:** `turn_terminal_records` remains the sole terminal compare-and-
    swap owner. A `logical_turn` receipt may link to, but does not replace or
    overload, its immutable turn identity. `system_request` and
    `session_generation` receipts never create or link a fabricated turn terminal.
  - **CON-002.AC-02:** `turn_recovery_jobs` remains limited to its existing
    proof-bearing delivery-reconciliation role and receives no raw provider event
    or generic continuation replay payload.
  - **CON-002.AC-03:** Receipt transitions and creation of linked outbound/tool
    evidence use the existing database connection and transaction boundary.
    Composite foreign keys and triggers enforce exact equality of lifecycle owner,
    manager/generation, attempt, segment, receipt, handoff, plan, and operation
    references. A non-null runtime owner token and variant discriminator prevent
    SQLite nullable-foreign-key bypass; variant checks require every applicable field
    and fixed non-null sentinels for nonapplicable fields, and triggers compare with
    null-safe `IS`/`IS NOT` semantics. Every aggregate is single-owner/single-target; its target equals the
    immutable logical-turn destination unless a separate exact
    `provider_effect_authorization` row—issued by the distinct authenticated routing-
    policy capability, never the plan creator—proves an allowed redirect. Raw SQL that
    mixes owners, attempts, segments, or targets fails.
  - **CON-002.AC-04:** Every attempt closure, boundary-receipt consumption, and
    lifecycle bookkeeping update uses one caller-owned transaction. When fallback/
    retry is selected, that transaction atomically inserts the unique handoff and
    next open attempt without turn-terminal or inbound mutation. Only the final
    logical-turn boundary, after no retry/continuation owner and zero obligations/
    segments remain, includes `turn_terminal_records` compare-and-swap and inbound
    terminal disposition. Non-turn owners perform neither operation; no path opens a
    nested transaction or publishes terminal state before its atomic commit succeeds.
    A boundary receipt is never eligible for generic reconciliation; delayed final
    publication re-enters this same caller-owned finalizer.
  - **CON-002.AC-05:** Each runtime outbound/tool/no-send/presence seam invokes the
    atomic durability plan/link API before execution and cannot construct, mutate, or
    settle lifecycle rows through a separate transaction. Effect-seam integration
    tests—not storage mocks—prove operation creation, owner/target equality, and plan
    sealing share the existing database transaction. The database connection denies
    agent-origin downstream INSERT/UPDATE outside the exact non-exported lifecycle-effect
    scope and validates its producer/plan/link manifest; separately scoped, enumerated
    non-agent owners preserve compatibility. Raw agent writes, generic-plan redirect
    issuance, prepared-statement escape, and false non-agent provenance fail.
  - **CON-002.AC-06:** Before lifecycle runtime activation, canonical terminal
    durability exposes positive restart-queryable `not_sent` evidence. Generic
    `failed_permanent`, quarantine, exhaustion, absence of echo, or owner timeout
    never proves no transmission.
    `not_sent` is a distinct outbound operation status emitted only by typed pre-send
    rejection, and terminal `deliveryKind=not_sent` retains exact operation/status and
    singleton-set proof. Migration 54 permits aggregate `not_sent` only for
    an immutable singleton answer-set seal created atomically with terminalization;
    database triggers reject a racing/later answer sibling. Without that seal, even one
    not-sent operation remains aggregate uncertain. No-send delivery evidence never clears provider/tool/
    lifecycle replay vetoes. Both lockstepped terminal validators, database triggers,
    recovery queries, and retention prove and preserve the referenced operation state.
  - **CON-002.AC-07:** Migration 55 replaces the singleton seal with immutable fields on
    the final attempt: publication-seal ID/kind, owner, invocation epoch, exact count,
    canonical membership fingerprint, and sealed time. Membership is restart-rederived
    from every reply-bearing/external outbound link across all sealed plans; terminal
    chrome is classified separately. A `successful_finality` seal requires the exact
    finality receipt, zero open segments/obligations, and no unplanned/admitted receipt.
    A `failure_abandonment` fence is allowed only after CON-002.AC-07 generation/effect fencing,
    enumerates already-created operations, and proves delivery-uncertain/replay-never,
    not successful completeness. Triggers reject later reply-bearing plan/link/operation
    creation for either sealed attempt and route late frames to quarantine. Aggregate
    `not_sent` is available only under `successful_finality` when every member is
    canonical not-sent; any echo/submitted/maybe-sent/pending/sending/quarantine/generic
    failure/missing link/late race/mixed target/uncertain child dominates. No selected op
    or single plan proves the aggregate. Terminal/job/closure ownership binds this seal
    while retaining `delivery_op_id` only as representative, and both validators rederive
    exact membership after restart.
- **Verified-by:** {contract, review}
- **Traces-to:** DES-003, DES-006

#### CON-003: Capability-aware provider compatibility
- **Status:** active
- **Superseded-by:** —
- **Statement:** The envelope and ledger are provider-neutral, while continuation
  admission requires adapter-specific capability evidence and must not assume that
  native IDs exist.
- **Acceptance criteria:**
  - **CON-003.AC-01:** Adapters without proved continuation identifiers preserve
    their existing externally visible behavior except that ambiguous post-boundary
    activity is durably quarantined and vetoes replay.
  - **CON-003.AC-02:** Adapter contract tests cover native identities present,
    partially present, absent, duplicated, and reused across generations.
  - **CON-003.AC-03:** A versioned capability registry has explicit entries and
    contract fixtures for all six canonical providers (`claude-cli`, `codex-cli`,
    `gemini-cli`, `opencode-cli`, `openai-api`, and `anthropic-api`). Direct API
    emitters and CLI parsers pass through the same lifecycle gate; absence or drift
    disables only the unproved capability and fails closed. A CLI entry matches both
    semantic version, exact launch-bound executable/source/wrapper/interpreter identity
    and SHA-256, plus a canonical content-free capability-context fingerprint covering
    protocol-affecting mode/flags, adapter options, relevant environment/config/plugin/
    hook posture, parser version, endpoint negotiation, and feature/schema set. Secret
    and volatile non-protocol values are excluded without weakening equality. The
    runtime opens, hashes, and pins every effective executable/script/wrapper/interpreter
    handle plus context before invocation commit, then executes only from those handles
    after commit and before any request write. A platform/chain lacking enforceable
    pinned-handle execution disables that provider capability rather than path-spawning.
    Pre-commit pin failure produces typed never-invoked rejection; post-commit exec/
    attestation failure is failed-uncertain recovery. Replacement, symlink, wrapper, or
    TOCTOU drift cannot substitute bytes. Same-version/
    different-hash/context and unavailable proof do not inherit capabilities. Direct
    APIs bind the immutable loaded SDK/module plus event-schema/negotiated-context
    fingerprint with equivalent drift behavior. Native-terminal and child-origin claims
    additionally cite an authoritative contract or audited source-control-flow proof;
    empirical fixtures alone cannot enable them. Continuation binding, native pre-execution rejection, FIFO request
    identity, child origin, and causal finality are independent capability bits; proof
    of one never enables another.
- **Verified-by:** {acceptance, contract, property}
- **Traces-to:** DES-001, DES-004

#### CON-004: Controlled storage and safe retention
- **Status:** active
- **Superseded-by:** —
- **Statement:** Provider-event evidence must remain bounded and queryable without
  allowing retention policy to erase unresolved safety state.
- **Acceptance criteria:**
  - **CON-004.AC-01:** Exact-owner and open-state inspection queries use declared
    indexes and do not require scanning stored message content.
  - **CON-004.AC-02:** An authorized atomic prune may remove a receipt aggregate only
    after the receipt is consumed or tombstoned, every linked effect is terminal,
    no receipt/attempt/effect is a recovery root, and the retention cutoff has
    passed. A shared plan is removed only when every linked receipt and effect
    independently passes those predicates. It removes transition/effect-link/
    receipt children in guarded order before existing downstream cleanup. A request
    segment or continuation obligation is not prunable until terminal, its owner
    attempt is terminal, and it is not a finalization or recovery root.
  - **CON-004.AC-03:** A terminal attempt is pruned only after every child receipt
    aggregate, segment, obligation, authorization, and runtime-intent plan is gone,
    its cutoff has passed, and it is not a recovery root. An
    attempt handoff remains a root until its destination attempt and logical turn are
    terminal, then is removed before either linked attempt; attempts are removed last.
  - **CON-004.AC-04:** Direct updates/deletes and pruning of open attempts or
    observed/admitted/quarantined receipts fail; unresolved lifecycle evidence roots
    every linked downstream effect against independent retention. The database
    connection installs a `setAuthorizer` callback with non-exported, synchronous,
    re-entrancy-guarded operation scopes. Each create/mutation method declares the
    exact protected-table INSERT manifest it may execute. Transition mode permits only the exact
    expected attempt/receipt CAS UPDATE and no DELETE; prune mode permits only the
    guarded ordered DELETE set and no unrelated UPDATE. Transition mode's complete
    UPDATE whitelist is exact attempt phase/state/lease CAS, receipt-state CAS, and
    single-use authorization-consume CAS; segment/obligation closure and receipt
    transitions are append-only inserts, while effect plans are immutable sealed
    inserts. A deny-by-default authorizer is installed outside either scope for INSERT,
    UPDATE, and DELETE on the ten lifecycle-protected tables only. Existing outbound/tool/inbound/session/
    terminal APIs remain usable under their existing constraints, and a lifecycle
    capability neither denies nor broadens them. Every permitted mutating statement is freshly
    prepared, fully executed with `.run()`, and discarded synchronously inside its
    exact scope; mutating `RETURNING`, iterator/cursor APIs, arbitrary callbacks, and
    partial stepping are forbidden. It is never cached, returned, captured, or reused
    across a scope/mode boundary. Scope entry and
    `finally` exit reinstall the applicable/deny authorizer so statement invalidation
    is not inferred from a mutable closure flag. All lifecycle INSERT/UPDATE/DELETE outside
    the exact mode is denied.
  - **CON-004.AC-05:** Receipt insertion and transition reuse the enclosing turn
    transaction where one exists and introduce no independent filesystem journal.
  - **CON-004.AC-06:** Raw/alternate prepared INSERT/UPDATE/DELETE, fabricated
    receipt/transition/plan/link history, transition/current-state skew, prepare-under-
    transition/run-after-scope, prepare-under-prune/run-after-scope, cross-mode run,
    cached-statement reuse, active `UPDATE/DELETE ... RETURNING` iterator after scope
    exit, nested maintenance/re-entry, failed-prune, shared-plan, and ordinary
    non-lifecycle outbound/tool/terminal write fixtures prove
    the authorizer and guarded prune cannot be bypassed, transition
    mode cannot delete, prune mode cannot mutate unrelated state, and failure cannot
    leave partial deletion; terminal attempts remain the last rows removed.
  - **CON-004.AC-07:** A `turn_recovery_terminal_closures` witness is a retention root
    until its source inbound, terminal record, recovery job (when present), selected
    operation, and every late-echo/conflict record are terminal, no live recovery owner
    or referenced root remains, and the canonical terminal retention cutoff has passed.
    A declared eligibility index supports deterministic oldest-first pruning without
    scanning message content. The witness is deleted last in the same guarded aggregate
    transaction (or immediately before an inseparable parent delete); unresolved,
    recent, owner-bearing, or conflict-pending witnesses never prune. These rows are
    included in migration-54 storage/retention accounting rather than growing outside
    the lifecycle governors.
- **Verified-by:** {acceptance, contract, review}
- **Traces-to:** DES-003, DES-007

#### CON-005: Canonical migration and deployment alignment
- **Status:** active
- **Superseded-by:** —
- **Statement:** Schema and runtime rollout must extend the canonical repository
  artifacts and manifests and must preserve existing configuration, state, and data
  directories.
- **Acceptance criteria:**
  - **CON-005.AC-01:** The implementation allocates the next unclaimed schema
    migration after reconciling all merged durability migrations and verifies both
    fresh-database and upgrade paths. Canonical base
    `482b707d716aee5641db25d40c2a954caee5d78f` understands migrations through
    46; migrations 47 through 52 are consumed by later durable work, and the current
    branch consumes migration 53 for outbound-quarantine disposition and retirement
    receipts.
    This lifecycle work therefore allocates bounded terminal recovery/canonical
    `not_sent` to migration 54 and the provider-event lifecycle ledger to migration
    55.
  - **CON-005.AC-02:** Changed deployed runtime entrypoints are represented in the
    repository's managed-component and runtime manifests, and manifest guards pass.
    Before lifecycle activation, the effective configured primary/fallback routing set
    and launch contexts are evaluated privately. Every provider eligible to receive a
    request has the minimum proved capability set, including causal finality. Unsupported
    registry entries stay disabled/excluded without silently changing configured routing;
    an unready primary keeps that target drained/unactivated on the compatible prior path
    with actionable health. Hot config/context drift withdraws admission before another
    invocation. Targeted subsets may activate only through coordinated rollout.
  - **CON-005.AC-03:** The rollout runbook compares installed artifacts to canonical
    source hashes and uses the existing targeted update mechanism; it forbids raw
    reinstallation, state-directory replacement, and uncoordinated fleet restart.
    Migration 55 may leave its immutable `schema_migrations(version=55)` marker.
    Runtime activation is the first insert into `provider_lifecycle_activation`,
    committed atomically with the first lifecycle-enabled attempt and before any
    provider invocation. Activation is roll-forward-only after that marker or any
    lifecycle/provider activity: rollback is allowed only before activation with
    proof of zero rows across the ten named lifecycle data tables and zero in-flight
    requests. A downgrade binary must either be
    fully v55 write-compatible or enter drain/read-only mode and reject every new
    provider turn; merely reading existing rows and vetoing replay is insufficient.
  - **CON-005.AC-04:** Before migration/activation, each target instance gracefully
    drains or quiesces and creates a fresh private content-addressed evidence packet.
    The repository tracks only its schema/trust policy. The canonical deployment owner
    appends a per-target HMAC-SHA-256 attestation using a 32-byte Secret Service key
    unavailable to the runtime: monotonic sequence, prior-record hash, exact private
    target, reviewed merge, capture hash/time, quiescence nonce/proof, comparison verdict,
    and single-use activation request. Root/file ownership and 0700/0600 modes are
    validated. Cutover accepts only the newest unconsumed, chain-valid attestation no
    older than five minutes and appends its consumption; missing key, chain gap, replay,
    stale/wrong target/merge, or mismatch stops. The tracked historical packet/hash is a
    bootstrap baseline, never the current rollout proof, and PR output remains boolean/
    delta-free. The quiesced target then creates a fresh application-consistent SQLite `.backup`,
    passes `PRAGMA integrity_check` on source and backup, opens a scratch restore and
    verifies its schema/row-count fingerprint, and records a pre-activation rollback
    checkpoint. While still quiesced and before any inbound/provider activation, the
    sole state-replacement exception is a coordinated restore of that exact verified
    schema-54 (pre-v55) backup after proving: no `provider_lifecycle_activation` row; zero rows
    in `provider_request_attempts`, `provider_attempt_handoffs`,
    `provider_request_segments`, `provider_continuation_obligations`,
    `provider_event_receipts`, `provider_event_transitions`,
    `provider_event_effect_plans`, `provider_event_effect_links`, and
    `provider_effect_authorizations`; zero `inbound_events` rows whose
    `processing_status NOT IN ('complete','failed')`; zero active agent sessions; and
    runtime drain proof that no provider process/request exists. The migration-55
    marker may exist in the pre-restore source and is excluded from the lifecycle-row
    predicate. The verified whole-database restore returns schema history to the exact
    backup schema-54 fingerprint; this is the sole permitted removal of that v55 row. Manual
    or in-place migration-history deletion or rewrite is prohibited.
    Source and backup fingerprints and zero in-flight/inbound mutations must agree;
    source/restore integrity and fingerprints must pass before restart. This does not
    otherwise rewrite an applied migration in place. After activation there is no restore/data
    rollback: leave v55 drained/read-only and roll forward. Any other failure aborts
    rollout without restart, migration, or state replacement.
  - **CON-005.AC-05:** Before deploying any schema-54/55 writer, the production
    schema-ceiling gate based on the canonical migration lineage applies to
    `Database.runPendingMigrations` and agent-turn
    admission. When `MAX(schema_migrations.version)` exceeds the binary's supported
    maximum, backup/inspection remain available but every new provider turn is
    rejected in drain/read-only mode. The implementation and marked CHK-071 proof are
    present in canonical base `482b707d716aee5641db25d40c2a954caee5d78f`.
    The guard must be verified fleet-wide before either forward writer; older
    pre-guard binary fingerprints are prohibited as rollback targets.
- **Verified-by:** {acceptance, contract, review}
- **Traces-to:** DES-008

#### CON-006: Focused first change set
- **Status:** active
- **Superseded-by:** —
- **Statement:** The first provider-event lifecycle change set excludes queue
  cancellation, automatic restart replay of continuations, operator mutation/user-
  interface work, and unrelated recovery migrations.
- **Acceptance criteria:**
  - **CON-006.AC-01:** Queue/session cancellation remains owned by already-merged PR
    #1747 (`5c52f571`, merge `77cd0718`) plus any new focused residual follow-up; the
    lifecycle diff does not absorb unpublished live-checkout shutdown commits.
  - **CON-006.AC-02:** The lifecycle change set adds no automatic provider-content
    reconstruction or replay path and performs no deployment before merge and
    release verification.
- **Verified-by:** {review}
- **Traces-to:** DES-009

#### CON-007: Explicit operational and performance bounds
- **Status:** active
- **Superseded-by:** —
- **Statement:** Lifecycle batching, persisted fields, capacity, and verification
  budgets must be named, configurable only within reviewed ranges, and testable.
- **Acceptance criteria:**
  - **CON-007.AC-01:** Exported constants define: text batch maximum 16,384 bytes;
    256 fragments per batch; 250 ms flush maximum; enum/label fields 64 UTF-8 bytes;
    reason fields 96 bytes; provider-version fields 64 bytes; readmittable payload
    maximum 1 MiB per event, 32 MiB and 1,024 entries per runtime; provider-native
    causal fields maximum 512 UTF-8 bytes, with 1,024 live-correlation entries/512 KiB
    per attempt and 32 MiB globally; presence refresh maximum 120 child plans and ten
    minutes per attempt; effect terminal-settlement proof maximum 1 KiB with a 16-MiB
    global unsettled-effect reserve; passive-checkpoint maxima 4,096 frames, 32 MiB
    projected aggregate growth, and 250 ms only through a proved cancellable primitive;
    fallback maximum eight
    attempts; recovery scope-block maximum five minutes; maximum 256 open provider
    attempts; a 64-KiB emergency byte lease per open attempt backed by one 16-MiB
    globally accounted emergency pool; total lifecycle-row soft/
    hard admission limits 400,000/500,000; at most one effect plan per receipt;
    effect-plan maxima 128 receipts, 256 typed
    effects, 1,024 links, and 256 redirect authorizations; receipt maximum six
    transitions and one readmission epoch; lifecycle
    transaction maximum 4,096 physical row mutations and 4 MiB of bounded encoded
    inputs; conservative projected SQLite allocation maximum 32 MiB; aggregate SQLite
    main-database plus WAL plus SHM on-disk soft/hard admission limits 1/2 GiB; a
    separate 64-MiB residual reserve below every hard byte/free-space threshold; and
    a minimum filesystem-free admission floor of 1 GiB.
    Configuration may
    lower batching/capacity values but may not raise hard maxima without a schema/
    protocol review; over-limit identity/proof values are rejected, never truncated.
    Lifecycle terminal evidence reuses the canonical `terminalDurabilityDays`
    retention window (default 30 days, enforced minimum 1 day); configuration may
    retain longer but never age-prunes open attempts or observed/admitted/quarantined
    receipts.
  - **CON-007.AC-02:** A 10,000-fragment fixture proves ordered bounded coalescing,
    no more than one observe transaction per completed batch, no more than one seal
    transaction per effect plan, and lifecycle p95 processing overhead at or below
    50 ms per completed batch in the pinned repository benchmark harness.
  - **CON-007.AC-03:** An unresolved capacity unit is one physical lifecycle row
    (attempt, attempt handoff, request segment, continuation
    obligation, receipt, transition, plan, link, or authorization) belonging to an
    open attempt or a nonterminal receipt/effect. The singleton activation marker is excluded from unresolved accounting but
    included in total lifecycle-row accounting. Per instance,
    40,000 units is the soft alert/new-attempt threshold, 50,000 is the hard ceiling,
    and 10,000 units are reserved for already-open attempts. At attempt open, the
    durable attempt row and its replay-veto semantics are materialized and a 64-KiB
    emergency byte lease is atomically acquired from the global 16-MiB pool; no more
    than 256 attempts may remain open. Invocation-committed attempts are already
    durable failed-uncertain/replay-veto evidence if a later abort CAS cannot commit.
    All other attempt/handoff/segment/obligation/receipt/plan/link/authorization
    cardinality and one fixed content-free terminal-settlement allowance per planned
    effect are reserved before adapter callback or owned effect. The global 16-MiB
    unsettled-effect pool is debited before execution and released only by terminal
    settlement.
    Destination attempt capacity is reserved in the handoff transaction.
    Configuration must satisfy `soft + reserve <= hard`,
    `max_open_attempts * emergency_bytes_per_attempt <= emergency_pool_bytes`,
    `emergency_pool_bytes + unsettled_effect_reserve_bytes <= residual_reserve_bytes`,
    emergency lease availability for every open attempt, and
    positive thresholds; no limit may exceed the named maxima. Every new-attempt,
    callback, effect, handoff, and prune transaction bounds all direct/triggered row
    cardinality and encoded inputs, then computes a conservative projected allocation
    before writer admission. The
    projection enumerates base-table, index, trigger, page-split, WAL-frame/header,
    and SHM-region growth at the live page size, applies a documented safety factor,
    rejects arithmetic/metadata uncertainty, and cannot exceed 32 MiB. It then obtains
    the canonical serialized writer/admission lock (`BEGIN IMMEDIATE` or the proved
    existing equivalent), remeasures main/WAL/SHM and free space under that lock
    immediately before the first mutation, and evaluates the projection there.
    Admission requires `current main+WAL+SHM + projection <= hard - 64 MiB` and
    `filesystem free - projection >= floor + 64 MiB`. A competing connection cannot
    reuse a pre-lock measurement. The 64 MiB is residual reserve,
    not transaction capacity. An unavailable, over-cardinality, over-encoded, or over-
    projection operation aborts before any write. Schema constants must prove the
    maximally populated valid plan/receipt aggregate—including all transition/link/
    receipt/plan/authorization rows and triggered mutations—fits within the 4,096-
    mutation/4-MiB/32-MiB atomic limits. Retention work is chunked only at invariant-
    safe aggregate boundaries, and that exact maximum aggregate prunes atomically.
    Before rejection, the authorized pruner removes only eligible terminal aggregates.
    A passive WAL checkpoint is optional and separately admitted under the same writer/
    checkpoint serialization: it first reads exact WAL/backfill/page-size state and
    projects aggregate main/WAL/SHM growth for at most 4,096 frames and 32 MiB. It runs
    only when that projection preserves the 64-MiB residual reserve and filesystem
    floor, and it is abandoned/health-alerted after a 250-ms budget where the runtime
    exposes a proved cancellable primitive. If the SQLite binding cannot bound or cancel
    the call, or a pinned reader/unknown metadata makes projection uncertain, the
    checkpoint is skipped before invocation and admission rejects/backpressures; it is
    never called optimistically under pressure. External disk loss or an unhealthy/
    skipped checkpoint never permits a forced/restart/truncating checkpoint. Every
    lifecycle-capable connection explicitly sets and verifies `wal_autocheckpoint=0`
    because the current SQLite call is not cancellable; implicit post-commit checkpoint
    work is forbidden. Database close/shutdown uses the same projected serialized
    PASSIVE-or-skip path after quiescence and never invokes FULL/RESTART/TRUNCATE; a
    retained WAL is recovered on next open. The engine
    remeasures after any checkpoint and every commit and latches backpressure before
    another reservation; it cannot retroactively authorize a crossed threshold. If a threshold remains crossed, a new attempt is rejected before
    invocation; an in-flight stream stops before parsing its next frame or executing
    its next effect/handoff, aborts transport, and uses the serialized emergency writer
    for one bounded CAS against only its leased byte pool. If that CAS cannot commit,
    the already-durable invocation-committed attempt remains open/failed-uncertain and
    startup never reinvokes or treats it empty. Terminal rows count toward total limits;
    age retention alone is not a disk bound. Capacity pressure never prunes unresolved evidence. Readmittable
    payload-cache pressure evicts owned bytes fail closed, disables readmission for
    those receipts, and zeroizes releasable buffers; it never spills content to disk.
  - **CON-007.AC-04:** Runtime integration checks prove the stream reader applies
    backpressure before parsing another frame when a row lease, byte reserve, or
    free-space reserve is unavailable, aborts the
    provider transport, and closes failed-uncertain; unread bytes are never
    interpreted or replayed. Provider start is likewise impossible until the durable
    attempt and emergency byte lease are reserved and invocation claim/commit succeeds. A pinned-
    reader fixture grows WAL without materially growing logical `page_count`, and an
    in-flight boundary-crossing fixture removes free space after provider start; both
    stop at the next reservation before parsing/effect/handoff and report main, WAL,
    SHM, and free-space signals. `SQLITE_FULL`, `ENOSPC`, or external consumption that
    races after projection rolls the transaction back atomically, aborts transport,
    and attempts only its leased emergency CAS. CAS failure leaves the committed
    attempt as durable replay-veto evidence for startup reconciliation; no further
    effect is admitted. Concurrent abort-storm and two-connection reservation tests
    prove global-pool accounting and locked remeasurement. Thus every event admitted to the adapter callback has bounded
    reserved/projected capacity without relying on mocked storage behavior; the
    protocol does not claim external disk races are impossible.
- **Verified-by:** {acceptance, contract, benchmark}
- **Traces-to:** DES-001, DES-003, DES-007

## Amendment Log

| AMD ID | Status | Type | Affected IDs | Summary | Rationale | Task Context | Approved By | Timestamp |
|--------|--------|------|--------------|---------|-----------|--------------|-------------|-----------|
| AMD-001 | applied | clarification | REQ-002, DES-003 | Clarified the external-effect interposition boundary | Provider-managed tools may execute before the stream observer can transact; fail-closed evidence and replay veto preserve the required external safety contract | TSK-003 | agent | 2026-07-13T19:09Z |
| AMD-002 | applied | design-refinement | REQ-002, REQ-004, REQ-006, DES-005, DES-006 | Added guarded admitted-to-quarantined recovery | Restart reconciliation and failed effect-linking require a fail-closed edge that the original valid-edge list omitted | TSK-006 | agent | 2026-07-13T19:14Z |
| AMD-003 | applied | design-refinement | REQ-001, CON-001, DES-001, DES-002 | Removed durable content/native-identifier digests | Low-entropy identifiers and content digests are dictionary-recoverable; runtime-generated opaque tokens preserve live correlation without creating a durable oracle | TSK-004 | agent | 2026-07-13T19:19Z |
| AMD-004 | applied | design-refinement | CON-004, DES-003, DES-007 | Defined guarded aggregate pruning | Terminal state alone does not prove that linked evidence is no longer a recovery root, while an unconditional no-delete rule contradicts retention | TSK-003 | agent | 2026-07-13T19:19Z |
| AMD-005 | applied | clarification | CON-005, DES-008 | Made lifecycle activation roll-forward-only | A pre-v45 runtime cannot interpret open lifecycle evidence and would re-enable unsafe suppression and replay | TSK-008 | agent | 2026-07-13T19:19Z |
| AMD-006 | applied | design-refinement | REQ-002, DES-003, DES-005 | Required durable outcomes at every suppression exit | Post-turn gating is not the only silent exit; queued output, echo/policy rejection, compaction, routing, provider switching, and empty normalization need the same disposition contract | TSK-005 | agent | 2026-07-13T19:19Z |
| AMD-007 | applied | design-refinement | REQ-002, REQ-005, REQ-006, DES-003, DES-006 | Added pre-provider attempt evidence and fail-closed write behavior | A crash or database failure after provider-side activity but before event observation otherwise looks vacuously empty and can arm replay | TSK-003 | agent | 2026-07-13T19:19Z |
| AMD-008 | applied | clarification | REQ-003, DES-004 | Separated provider request boundaries from logical-turn finalization | The first result currently ends queues and terminal bookkeeping even while a registered background obligation remains open | TSK-004 | agent | 2026-07-13T19:19Z |
| AMD-009 | applied | design-refinement | REQ-007, CON-001, DES-007 | Extended privacy enforcement to legacy diagnostic sinks | A content-free ledger is insufficient if existing result, tool, parser, alert, or sidecar diagnostics persist the same frame | TSK-007 | agent | 2026-07-13T19:19Z |
| AMD-010 | applied | design-refinement | REQ-001, REQ-002, CON-004, DES-001, DES-003 | Defined logical-event coalescing and capacity behavior | Per-token synchronous receipts would impose unbounded latency and storage on fragment-emitting adapters | TSK-004 | agent | 2026-07-13T19:19Z |
| AMD-011 | applied | design-refinement | REQ-001, REQ-002, DES-001, DES-006 | Separated attempt completeness from unsafe evidence and made safe closure atomic | An open attempt must block decisions without irreversibly vetoing a later proved-empty result, and safe closure must not race a late event | TSK-006 | agent | 2026-07-13T19:31Z |
| AMD-012 | applied | design-refinement | REQ-001, CON-004, DES-001, DES-003 | Defined bounded egress-batch coalescing and terminal attempt pruning | Mutable per-item receipts and immortal attempt rows would violate append-only and storage-control contracts | TSK-003 | agent | 2026-07-13T19:31Z |
| AMD-013 | applied | clarification | REQ-007, CON-001, DES-007 | Scoped privacy assertions to WhatSoup-owned lifecycle and diagnostic sinks | Provider-owned transcripts and existing outbound/tool stores have separate intentional content ownership and cannot be erased by this protocol | TSK-007 | agent | 2026-07-13T19:31Z |
| AMD-014 | applied | design-refinement | REQ-002, REQ-006, DES-003 | Added atomically sealed effect plans | Link count alone cannot prove completeness after a crash when one event fans out to multiple chunks or multiple events aggregate | TSK-003 | agent | 2026-07-13T19:31Z |
| AMD-015 | applied | design-refinement | REQ-001, DES-001 | Replaced universal TurnIdentity with a causal-owner union | Session init and system requests exist before an inbound logical turn and must not fabricate ownership | TSK-004 | independent review | 2026-07-13T20:35Z |
| AMD-016 | applied | design-refinement | REQ-002, REQ-005, DES-003, DES-006 | Added typed safe-rejection closure | Existing pre-execution provider fallback must remain distinct from genuine empty output and uncertain failure | TSK-006 | independent review | 2026-07-13T20:35Z |
| AMD-017 | applied | design-refinement | REQ-002, CON-002, DES-003 | Added MCP effect-admission tokens and atomic finalization | Agent-owned tools and terminal publication must not execute outside durable ownership | TSK-005, TSK-006 | independent review | 2026-07-13T20:35Z |
| AMD-018 | applied | gap-closure | REQ-001, REQ-002, DES-001, DES-005 | Moved lifecycle handling ahead of generation/map/queue exits | Several current callbacks discard actionable events before the original suppression inventory begins | TSK-004, TSK-005 | independent review | 2026-07-13T20:35Z |
| AMD-019 | applied | evidence | REQ-003, CON-003, DES-004 | Added sanitized provider-contract golden evidence | Target CLI 2.1.207 exposes native task/tool/parent bindings; other versions remain gated | TSK-002, TSK-004 | independent review | 2026-07-13T20:35Z |
| AMD-020 | applied | design-refinement | REQ-002, REQ-006, CON-002, DES-006 | Defined every attempt closure and recovery settlement | Ordinary successful attempts otherwise remain open and downstream reconciliation never settles lifecycle receipts | TSK-006 | independent review | 2026-07-13T20:35Z |
| AMD-021 | applied | safety | CON-004, DES-003 | Specified authorizer enforcement and shared-plan pruning | SQL constraints alone cannot distinguish authorized retention, and a shared plan cannot be pruned per receipt | TSK-003 | independent review | 2026-07-13T20:35Z |
| AMD-022 | applied | scope | REQ-004, CON-006, DES-005 | Removed underspecified operator mutation | The focused lifecycle PR has deterministic tombstoning only; operator mutation requires a separate authenticated protocol | TSK-005 | independent review | 2026-07-13T20:35Z |
| AMD-023 | applied | safety | CON-005, DES-008 | Hardened downgrade and activation preflight | A read-only v45 compatibility shim could still accept unsafe new turns; activation also needs a proved restore checkpoint | TSK-008 | independent review | 2026-07-13T20:35Z |
| AMD-024 | applied | testability | CON-007, DES-001, DES-003, DES-007 | Named batching, field, capacity, reserve, write, and latency bounds | Unquantified boundedness cannot drive schema checks, backpressure, or release tests | TSK-003, TSK-004, TSK-007 | independent review | 2026-07-13T20:35Z |
| AMD-025 | applied | consistency | REQ-001, REQ-002, REQ-004, REQ-007, CON-002, DES-001, DES-006, DES-007 | Propagated the full causal-owner union through closure and diagnostics | System/session owners must not fabricate inbound, turn-terminal, or raw diagnostic identity | TSK-004, TSK-006, TSK-007 | independent review | 2026-07-13T21:18Z |
| AMD-026 | applied | safety | REQ-002, REQ-003, DES-004, DES-006 | Required causal final boundary plus zero obligations and defined failed abandonment | Task completion precedes the parent answer in the observed ordering, while terminal crash must not deadlock open work | TSK-004, TSK-006 | independent review | 2026-07-13T21:18Z |
| AMD-027 | applied | security | REQ-002, CON-001, DES-002, DES-007 | Made MCP tokens exact-bound single-use secrets and socket receipt authoritative | Immutable alone did not prevent substitution/reuse, and concurrent CLI stdout lacks a proved safe join | TSK-005, TSK-007 | independent review | 2026-07-13T21:18Z |
| AMD-028 | applied | evidence | REQ-002, REQ-005, CON-003, DES-006 | Added runtime rejection receipts and per-version native rejection evidence | Provider-never-invoked has no native boundary, while synthetic prose cannot prove native pre-execution rejection | TSK-004, TSK-006 | independent review | 2026-07-13T21:18Z |
| AMD-029 | applied | operability | CON-004, CON-007, DES-003, DES-007 | Defined physical capacity units, emergency leases, operation-scoped authorizer modes, and canonical retention | Open streams must preserve every callback without unbounded growth, and transition permission must never authorize deletion | TSK-003 | independent review | 2026-07-13T21:18Z |
| AMD-030 | applied | recovery | REQ-006, CON-002, DES-006 | Defined typed settlement and canonical not-sent prerequisite | No-send, presence, provider-managed, and mixed plans lacked recovery truth; failed-permanent is not proof of no transmission | TSK-010, TSK-006 | independent review | 2026-07-13T21:18Z |
| AMD-031 | applied | semantics | REQ-002, REQ-003, REQ-005, DES-002, DES-004 | Added presence and separated provider activity from runtime terminal chrome | Typing/notices are external effects but must not turn genuine provider-empty/rejected attempts into output | TSK-005, TSK-006 | independent review | 2026-07-13T21:18Z |
| AMD-032 | applied | privacy | REQ-007, CON-001, DES-007 | Restricted diagnostics to approved redacted identity projections | Exact TurnIdentity contains raw conversation/JID fields and effect-admission tokens must never reach sinks | TSK-007 | independent review | 2026-07-13T21:18Z |
| AMD-033 | applied | testability | all active criteria | Moved marked RED checks to their owning production slices | A broad ownerless RED suite prevents per-task causality and review | TSK-002 through TSK-008 | independent review | 2026-07-13T21:18Z |
| AMD-034 | applied | deployment-safety | CON-005, DES-008 | Added migration-43 schema ceiling and exact pre-activation restore action | Older binaries otherwise accept newer schema silently; rollback required one proved bounded action | TSK-001, TSK-008 | independent review | 2026-07-13T21:18Z |
| AMD-035 | applied | evidence-correction | REQ-003, CON-003, DES-004 | Downgraded the 2.1.207 projection to a non-gating design specimen | The successful raw source/command/count/hash were not retained and the observed bounded command failed budget; this supersedes AMD-019's proof claim | TSK-002, TSK-004 | independent review | 2026-07-13T21:18Z |
| AMD-036 | applied | gap-closure | REQ-001, REQ-002, DES-004, DES-005 | Expanded unowned-result, accounting, lifecycle, and presence seam inventories | Missing context/durability exits and result-side effects could otherwise bypass disposition or execute twice | TSK-002, TSK-004, TSK-005 | independent review | 2026-07-13T21:18Z |
| AMD-037 | applied | lifecycle-correction | REQ-002, REQ-005, REQ-006, CON-002, CON-004, CON-007, DES-002, DES-006 | Separated provider-attempt closure from logical-turn finalization with immutable handoffs | A safe primary attempt may transfer to fallback under the same turn; early terminal CAS recreates suppression and crash/double-schedule gaps | TSK-003, TSK-006 | independent review | 2026-07-13T21:18Z |
| AMD-038 | applied | blocker-closure | REQ-001 through REQ-006, CON-002 through CON-005, CON-007, DES-001 through DES-008 | Added durable segment/obligation ledgers, invocation claims, boundary-only finalization, pre-handler child-effect ownership, relational targets, bounded cache/storage, exact build capabilities, exact rollback evidence, and corrected prerequisite state | Final independent review proved that uniqueness without executable claims, in-memory obligations, generic boundary recovery, version-only gates, and summary-only preflight could still duplicate effects, lose continuations, or authorize wrong-audience output | TSK-002 through TSK-010 | Tera and Luna independent review | 2026-07-13T21:43Z |
| AMD-039 | applied | implementability-and-storage | REQ-003, CON-007, DES-003, DES-004, DES-007 | Split interposable versus provider-managed CLI obligation registration and expanded disk accounting to main/WAL/SHM with passive-checkpoint health | External CLIs may schedule work before stdout can be durably observed, and `page_count * page_size` alone does not bound WAL growth behind a pinned reader | TSK-003, TSK-004, TSK-007 | Luna independent review | 2026-07-13T21:54Z |
| AMD-040 | applied | recovery-and-capacity | CON-002, CON-007, DES-003, DES-006, DES-007 | Made terminal-non-echoed scope release a required prerequisite and applied byte/free-space admission headroom at every live reservation | A terminal recovery owner must have a bounded fail-closed disposition, while row leases alone do not stop WAL growth or external disk loss during an in-flight attempt | TSK-003, TSK-004, TSK-006, TSK-010 | Tera independent review | 2026-07-13T22:03Z |
| AMD-041 | applied | enforcement | CON-004, DES-003 | Prohibited prepared-statement capability escape across authorizer scopes | SQLite authorizer decisions occur at prepare/reprepare time, so changing a closure mode alone does not revoke a statement prepared while privileged | TSK-003 | Tera independent review | 2026-07-13T22:06Z |
| AMD-042 | applied | fallback-safety | REQ-005, DES-006 | Required an independently typed policy-allowed rejection reason for fallback | Proving that a provider never ran establishes no activity but does not make a conflated admission rejection retryable or fallback-eligible | TSK-006 | Tera independent review | 2026-07-13T22:09Z |
| AMD-043 | applied | schema-sequencing | CON-002, CON-005, DES-003, DES-008, DES-009 | Allocated recovery closure to forward migration 44 and the provider lifecycle ledger to 45 | Current recovery-job constraints cannot represent safe abandonment without a forward migration, and deployed 41/42 history must be canonicalized through 43 first | TSK-001, TSK-003, TSK-010 | Luna independent review | 2026-07-13T22:12Z |
| AMD-044 | applied | storage-proof | CON-007, DES-003, DES-007 | Bounded every lifecycle transaction and required conservative projected SQLite/WAL/SHM allocation before writes | Pre-write remeasurement alone cannot preserve an admission ceiling when the next multi-row transaction has unbounded page/index/trigger/WAL amplification | TSK-003, TSK-004, TSK-005 | Tera independent review | 2026-07-13T22:16Z |
| AMD-045 | applied | delivery-truth | CON-002, DES-006 | Made `not_sent` a typed durable operation proof with conservative aggregate precedence | Generic `failed_permanent` and one failed chunk among mixed delivery siblings do not prove that an answer was never transmitted | TSK-006, TSK-010 | Luna independent review | 2026-07-13T22:19Z |
| AMD-046 | applied | causal-finality | REQ-003, REQ-005, CON-003, DES-004, DES-006 | Gated every successful invoked-attempt closure, logical-turn finalization, and handoff on an exact durable adapter causal-finality receipt | A result with zero currently known obligations can still precede late registration or actionable frames; earlier visible output vetoes replay but does not prevent late valid output loss | TSK-004, TSK-006 | Tera independent review | 2026-07-13T22:25Z |
| AMD-047 | applied | retention | CON-004, DES-006, DES-007 | Added guarded terminal-recovery witness retention | Permanent closure witnesses otherwise grow without bound outside lifecycle row governors | TSK-010 | Tera independent review | 2026-07-13T22:31Z |
| AMD-048 | applied | storage-proof | CON-007, DES-003, DES-007 | Bounded or skipped passive checkpoint work under the physical capacity projection | A passive checkpoint can move pages into the main file while a pinned reader retains WAL, increasing aggregate bytes outside the admitted transaction projection | TSK-003 | Tera independent review | 2026-07-13T22:31Z |
| AMD-049 | applied | rollback-clarification | CON-005, DES-008 | Distinguished verified whole-database preactivation restore from migration-history mutation | Restoring the exact v44 backup necessarily removes the source v45 marker, contradicting an absolute no-deletion statement | TSK-008 | Tera independent review | 2026-07-13T22:31Z |
| AMD-050 | applied | clarification | CON-002, CON-005, DES-008, DES-009 | Refreshed canonical prerequisite evidence and assigned CON-002.AC-07 to TSK-003/CHK-080 | Canonical main now contains PR #1768 and PR #1770 at schema 43, while the schema-ceiling guard and migration 44 remain blocking; this changes status and traceability evidence, not behavior | TSK-001, TSK-003, TSK-010 | coordinator | 2026-07-14T06:14Z |
| AMD-051 | applied | schema-allocation-correction | CON-002, CON-005, DES-003, DES-008, DES-009 | Corrected the canonical ceiling to 44, terminal recovery allocation to 45, lifecycle ledger/activation marker to 46, and preactivation restore baseline to verified schema 45, superseding the allocation portions of AMD-043/049/050 | PR #1790 consumed migration 44 for token-accounting separation; shifting the still-unpublished forward allocations preserves immutable history and is behavior-neutral for the Q partition incident bridge, which neither implements nor activates provider lifecycle | TSK-001, TSK-003, TSK-008, TSK-010 | coordinator | 2026-07-14T20:39Z |
| AMD-052 | applied | schema-allocation-correction | CON-002, CON-005, DES-003, DES-008, DES-009 | Shifted the canonical ceiling to 46, bounded terminal recovery/canonical `not_sent` to forward migration 47, and the provider-event lifecycle ledger/activation marker to 48, superseding the allocation portions of AMD-051 | The durable background-work ledger (`background_work` + `work_results`) consumed migration 46; shifting the still-unpublished forward allocations preserves immutable migration history and is behavior-neutral for this spec, which neither implements nor activates provider lifecycle. Same precedent and rationale as AMD-051's shift after PR #1790 consumed migration 44 | TSK-001, TSK-003, TSK-008, TSK-010 | coordinator | 2026-07-24T19:4xZ |
| AMD-053 | applied | schema-allocation-correction | CON-002, CON-005, DES-003, DES-008, DES-009 | Shifted the current canonical schema to 47, bounded terminal recovery/canonical `not_sent` to forward migration 48, and the provider-event lifecycle ledger/activation marker to 49, superseding the allocation portions of AMD-052 | Recovery-receipt chronology consumed migration 47; shifting the still-unpublished forward allocations preserves immutable migration history and keeps provider lifecycle inactive until its dedicated migration 49 | TSK-001, TSK-003, TSK-008, TSK-010 | coordinator | 2026-07-25T15:43Z |
| AMD-054 | applied | schema-allocation-correction | CON-002, CON-005, DES-003, DES-008, DES-009 | Shifted the current canonical schema to 49, bounded terminal recovery/canonical `not_sent` to forward migration 50, and the provider-event lifecycle ledger/activation marker to 51, superseding the allocation portions of AMD-053 | Recovery-run failure context consumed migration 48 and durable memory-consolidation run receipts consume migration 49; shifting the still-unpublished forward allocations preserves immutable migration history and keeps provider lifecycle inactive until its dedicated migration 51 | TSK-001, TSK-003, TSK-008, TSK-010 | coordinator | 2026-07-28T10:03Z |
| AMD-055 | applied | schema-allocation-correction | CON-002, CON-005, DES-003, DES-008, DES-009 | Shifted the current canonical schema to 51, bounded terminal recovery/canonical `not_sent` to forward migration 52, and the provider-event lifecycle ledger/activation marker to 53, superseding the allocation portions of AMD-054 | Metadata-only tool-call evidence and outbound-send audit receipts consumed migrations 50 and 51; shifting the still-unpublished forward allocations preserves immutable migration history and keeps provider lifecycle inactive until its dedicated migration 53 | TSK-001, TSK-003, TSK-008, TSK-010 | coordinator | 2026-07-28T22:39Z |
| AMD-056 | applied | schema-allocation-correction | CON-002, CON-005, DES-003, DES-008, DES-009 | Shifted the current canonical schema to 52, bounded terminal recovery/canonical `not_sent` to forward migration 53, and the provider-event lifecycle ledger/activation marker to 54, superseding the allocation portions of AMD-055 | Outbound ambiguity-episode timing consumed migration 52; shifting the still-unpublished forward allocations preserves immutable migration history and keeps provider lifecycle inactive until its dedicated migration 54 | TSK-001, TSK-003, TSK-008, TSK-010 | coordinator | 2026-07-29T00:00Z |
| AMD-057 | applied | schema-allocation-correction | CON-002, CON-005, DES-003, DES-008, DES-009 | Shifted the current canonical schema to 53, bounded terminal recovery/canonical `not_sent` to forward migration 54, and the provider-event lifecycle ledger/activation marker to 55, superseding the allocation portions of AMD-056 | Outbound quarantine disposition and retirement receipts consumed migration 53; shifting the still-unpublished forward allocations preserves immutable migration history and keeps provider lifecycle inactive until its dedicated migration 55 | TSK-001, TSK-003, TSK-008, TSK-010 | coordinator | 2026-07-30T00:00Z |
| AMD-058 | applied | schema-allocation-correction | CON-002, CON-005, DES-003, DES-008, DES-009 | Shifted the current canonical schema to 54, bounded terminal recovery/canonical `not_sent` to forward migration 55, and the provider-event lifecycle ledger/activation marker to 56, superseding the allocation portions of AMD-057 | Completed-delivery identity-admission ledger consumed migration 54; shifting the still-unpublished forward allocations preserves immutable migration history and keeps provider lifecycle inactive until its dedicated migration 56 | TSK-001, TSK-003, TSK-008, TSK-010 | coordinator | 2026-07-31T00:00Z |
