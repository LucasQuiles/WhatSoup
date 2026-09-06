# Cross-conversation guard: call-site matrix

Tracking artifact for issue 3457. It records, cell by cell, what each of the two
cross-conversation guards does today and which failure channel records a
violation. It pins current behaviour; it does not argue that the current
behaviour is correct.

Base for every anchor in this document: `15c05825ae7acae71d14efa2f0f50557bc32ce36`.
Every cell is pinned by a named test in
`tests/integration/cross-conversation-guard-matrix.test.ts`.

Read this before changing either guard. A consolidation that merges the two
triggers changes coverage on the alias and mirror axes by definition, and the
cells below are the map of what would move.

## The two guards

| | Registry guard | Messaging guard |
| --- | --- | --- |
| Anchor | `src/mcp/registry.ts:741` | `src/mcp/tools/messaging.ts:275` |
| Enclosing branch | injected-target branch `:688`, global-and-unbound arm `:718` | `assertConversationMatch` `:274` |
| Call sites | pre-handler, once per call | `:302` (dry run), `:375` (live send, via `beforeAudit`) |
| Runs relative to the handler | before schema validation `:767` and before the handler `:843` | inside the handler, after alias and LID resolution |
| Input compared | the caller-supplied raw `chatJid` | `prepared.chatJid`, after `prepareSend` |
| Fold | `canonicalConversationKeyResolver` if armed, else bare `toConversationKey` `:744-746` | `canonicalConversationKey(..., deps.dbWrapper)` `:278`, always |
| Fold arming | sole production site `src/mcp/tools/messaging.ts:221` | holds its own database handle |
| Rejects by | `reject(...)` `:756-760`, plain text | `throw new Error` `:283`, returned as a JSON error envelope |
| Failure code / stage | `authorization_denied` / `authorization` | `returned_error` / `handler` (`registry.ts:858-859` defaults) |
| Disposition | `not_retryable` / `recover` | `unknown` / `inspect` |
| Actor receipt written first | no, the call is dropped before `registry.ts:805-824` | yes, the handler already ran |

Both guards fail before any external effect and before the audit-intent write,
so neither divergence admits a send.

## Failure channels used by the matrix

| Channel | Failure code | Failure stage | Retry disposition | Operator action | Contract anchor |
| --- | --- | --- | --- | --- | --- |
| Registry authorization denial | `authorization_denied` | `authorization` | `not_retryable` | `recover` | `src/core/durability-evidence-contract.ts:50` |
| Registry target validation | `validation_rejected` | `validation` | `not_retryable` | `none` | `src/core/durability-evidence-contract.ts:49` |
| Handler-returned error | `returned_error` | `handler` | `unknown` | `inspect` | `src/core/durability-evidence-contract.ts:57` |
| No failure | none, `status = complete` | | | | |

## The matrix

Axes: session tier, alias target `to` present or absent, session
`conversationKey` mirror present or absent.

`SessionTier` admits only `global` and `chat-scoped` (`src/mcp/types.ts:14`,
Correction 1 below), so a conversation-bound session is NOT a third tier value.
It appears in the Tier column as `global + binding`, which is what the tests
construct and what makes the messaging guard live on the bound rows: the guard's
predicate (`messaging.ts:275`) early-returns on `tier !== 'global'`, and a bound
session does not satisfy that.

| Cell | Tier | `to` | `conversationKey` | Trigger | Resolver | Outcome | Failure channel |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1 | global, unbound | absent | present | registry guard `registry.ts:741` fires | armed fold on the raw caller `chatJid` | denied, plain text, no dispatch | `authorization_denied` / `authorization` |
| M2 | global, unbound | absent | present, addressed by its own mapped `@lid` | registry guard fires and admits | armed fold folds `@lid` to phone, matches | admitted, dispatched to the `@lid` conversation | none |
| M3 | global, unbound | present | present | registry guard suppressed by `to`; messaging guard `:275` fires at `:375` | database fold on `prepared.chatJid` | denied, JSON envelope, no dispatch | `returned_error` / `handler` |
| M4 | global, unbound | present | present, `dryRun` | registry guard suppressed by `to`; messaging guard fires at `:302` | same as M3 | denied, JSON envelope, no dispatch | `returned_error` / `handler` |
| M5 | global, unbound | absent | absent | neither guard fires, both require a truthy key | none | admitted, fail open | none, evidence filed under `__global__` |
| M6 | chat-scoped | absent | present | neither guard runs; chat-scoped arm `:705` injects | none | admitted, target replaced by `deliveryJid` | none |
| M7 | chat-scoped | present | present | neither guard runs; `to` stripped at `:716` | none | admitted, target is `deliveryJid`, alias never resolves | none |
| M8 | global, unbound | present **and** `chatJid` present | present | registry guard suppressed by the caller-supplied `to`; never adjudicates | none reached | denied as a target-exclusivity fault, not a conversation fault | `returned_error` / `handler` |
| M9a | global + binding | absent, `chatJid` supplied | present | bound arm `:691` rejects any caller target before the guard arm | none | denied, plain text | `validation_rejected` / `validation` |
| M9b | global + binding | absent, `chatJid` supplied | absent | same bound arm; confinement is the binding, not the mirror | none | denied, plain text | `validation_rejected` / `validation`, filed under `__global__` |
| M9c | global + binding | absent, no caller target | absent | bound arm fills the target from the binding `:704`; messaging guard `:275` early-returns on the absent mirror | none | admitted, dispatched to the binding | none, filed under `__global__` |
| M9d | global + binding | absent, no caller target | present | bound arm fills the target from the binding `:704`; messaging guard `:275` does NOT early-return and adjudicates that injected target | database fold on `prepared.chatJid` | mirror agrees with the binding: admitted, dispatched to the binding. mirror diverged: denied, JSON envelope, no dispatch | agreeing: none. diverged: `returned_error` / `handler`, filed under the diverged MIRROR key |
| M10 | global, unbound, no fold armed | absent | present, addressed by its own mapped `@lid` | registry guard fires on the bare fallback fold `:746` | `toConversationKey` yields the raw LID digits | denied, plain text, the session's OWN conversation | `authorization_denied` / `authorization` |

Two things the rows above do not carry in a column:

- M9a and M9b supply `chatJid`, not `to`. The bound arm at `registry.ts:696`
  reads both keys and rejects either, so a `to` target would be rejected by the
  same line; that variant is pinned by no test here.
- M10 and its control run against `probe_injected_send`, a fixture
  injected-target tool declared in the test file
  (`tests/integration/cross-conversation-guard-matrix.test.ts:143-155`), not
  against `send_message`. `registerMessagingTools` is the sole production arming
  site for the canonical fold (`src/mcp/tools/messaging.ts:221`), so a registry
  holding a real `send_message` always has the fold armed and the un-armed cell
  is unreachable with a production tool.

### Cell index to tests

| Cell | Test title in `tests/integration/cross-conversation-guard-matrix.test.ts` |
| --- | --- |
| M1 | `M1 global pinned session, foreign chatJid, no alias: registry guard denies as authorization_denied/authorization` |
| M2 | `M2 global pinned session, own conversation addressed by a mapped @lid: registry guard admits through the armed fold` |
| M3 | `M3 global pinned session, foreign alias target, live send: messaging guard denies as returned_error/handler` |
| M4 | `M4 global pinned session, foreign alias target, dryRun: messaging guard denies as returned_error/handler` |
| M5 | `M5 global session with no conversationKey: both guards are skipped and the send is admitted` |
| M6 | `M6 chat-scoped session with a caller-supplied chatJid: target is replaced by deliveryJid and neither guard runs` |
| M7 | `M7 chat-scoped session with an alias target: the alias is stripped and the send goes to deliveryJid` |
| M8 | `M8 global pinned session supplying both chatJid and to: the registry guard is suppressed and a target-exclusivity fault answers instead` |
| M9a | `M9a conversation-bound session with the conversationKey mirror present: a caller-supplied target is rejected as validation_rejected/validation` |
| M9b | `M9b conversation-bound session with no conversationKey mirror: a caller-supplied target is rejected as validation_rejected/validation` |
| M9c | `M9c conversation-bound session with no conversationKey mirror and no caller target: the binding supplies the target` |
| M9d | `M9d conversation-bound session with the conversationKey mirror present and no caller target: an agreeing mirror is admitted and a diverged mirror is denied by the messaging guard as returned_error/handler` |
| M10 | `M10 registry guard with no fold armed: a pinned session addressing its OWN conversation by a mapped @lid is denied as authorization_denied/authorization` |
| M10 control | `M10 control: the SAME call is admitted once the canonical fold is armed` |

### How the thirteen cells map to the intake enumeration

The intake for issue 3457 counts nine cells, six pinned at base and three
unpinned. That count folds two variants that this document keeps separate, so
the mapping is stated rather than assumed.

| Intake cell | Status at base per the intake | Cells here |
| --- | --- | --- |
| global, key, foreign `chatJid`, deny | pinned | M1 |
| global, key, own `chatJid` through the fold, admit | pinned | M2 |
| global, key, alias target, deny | pinned | M3 and M4, the live send and the dry-run variant |
| global, no key | pinned, by a conditional assertion | M5 |
| chat-scoped, `chatJid` and alias | pinned | M6 and M7 |
| conversation-bound, any caller target | pinned | M9a |
| (a) both `chatJid` and `to` on a pinned session | not pinned | M8 |
| (b) bound session, mirror absent or diverged | not pinned | M9b and M9c cover the absent half; M9d covers the mirror-present half, both the agreeing and the diverged sub-case |
| (c) registry guard with an un-armed fold | not pinned | M10, with its armed control |

## Corrections to the issue table

The issue's own anchor table has two inaccurate cells. Both were inaccurate when
the issue was filed, not drifted: no commit touches either guard file between
the issue anchor `b319d9ab` and base. The corrections live here; the issue body
is not edited.

**Correction 1. The registry guard is not "any tier". It is global-and-unbound
only.**

The guard at `src/mcp/registry.ts:741` sits in the final `else` arm of the
injected-target branch. Reaching it requires all three of:

- `tool.targetMode === 'injected'` (`registry.ts:688`);
- `conversationBoundKey(session)` undefined, since a defined binding takes the
  arm at `registry.ts:691` and returns at `:697` or fills the target at `:704`;
- `session.tier !== 'chat-scoped'`, since a chat-scoped session takes the arm at
  `registry.ts:705`.

`SessionTier` admits exactly two values (`src/mcp/types.ts:14`), so the
surviving arm at `registry.ts:718` is global-and-unbound. Two arms are therefore
closed to the guard, and the cells pin both: M6 and M7 pin the chat-scoped arm,
M9a, M9b, M9c and M9d pin the bound arm. The third reaching condition,
`tool.targetMode === 'injected'` (`registry.ts:688`), is pinned by no cell here
and appears only as out-of-scope context below.

**Correction 2. The installed-resolver anchor points at an unrelated resolver.**

The issue cites the resolver installed around `registry.ts:490-497`. That range
is `setTurnCorrelationResolver` (`registry.ts:489`), a durability
turn-correlation resolver with no part in either guard. The fold the registry
guard actually consults is installed by `setCanonicalConversationKeyResolver`,
`registry.ts:506-508`, signature at `:506`, and is armed in production from
`src/mcp/tools/messaging.ts:221`. Cell M10 and its control pin the difference
the two anchors make.

## Out-of-scope context

Recorded so that a later consolidation cannot be argued from an incomplete map.
None of the following is pinned by this matrix.

- **Two further confinement mechanisms exist on the same surface.**
  `validateMessageOwnership` (`src/mcp/tools/messaging.ts:171-205`) triggers on
  any tier with a `conversationKey`, resolves through a SQL predicate with no
  fold, and reports a "Message not found" result deliberately indistinguishable
  from a miss. `assertConversationAccess` (`src/mcp/types.ts:361-373`) triggers
  on any tier, prefers the binding over the mirror because the mirror can
  diverge, compares raw strings with no fold, and throws an error classified
  `handler_failed` / `handler`.
- **Target mode is a fourth axis this matrix does not carry.** The registry
  guard is gated on `tool.targetMode === 'injected'` (`registry.ts:688`), so it
  never runs for a caller-supplied tool such as `forward_message`
  (`src/mcp/tools/chat-management.ts:470`).
- **The mirror-versus-binding split is a latent divergence, and on a bound
  session it produces a false DENY rather than an escape.**
  `assertConversationAccess` enforces from the binding; both guards here read
  only the mirror. The REGISTRY guard never adjudicates a bound session: the
  bound arm at `registry.ts:691` returns at `:697` or fills the target from the
  binding at `:704`, so the guard arm at `:718` is unreachable. The MESSAGING
  guard does run. It lives inside the handler
  (`src/mcp/tools/messaging.ts:275`, reached after `registry.ts:843` invokes the
  handler), tests only `session.tier !== 'global'` and
  `!session.conversationKey`, never consults the binding, and a
  conversation-bound session carries `tier: 'global'`. So for a bound session
  whose mirror has DIVERGED from the binding, supplying no caller target, the
  messaging guard denies the target the registry itself injected from the
  binding: a false deny of the session's OWN bound conversation, on the
  `returned_error` / `handler` channel, with the evidence row filed under the
  diverged mirror key rather than the binding key. That is a
  confinement-availability property, the opposite failure direction from the
  escape this bullet otherwise concerns, and a consolidation would move it
  silently. Cell M9d pins it, together with the agreeing-mirror sub-case that
  shows the same call admitted. M9b and M9c do NOT pin it: both have the mirror
  absent, so `messaging.ts:275` early-returns and the messaging guard is not
  exercised on a bound session there at all. No cross-conversation send escapes
  on the bound path, but the reason is the registry's bound arm confining the
  target, not either guard.
- **An outbound suppression can mask a cross-conversation violation.** On the
  live send path `transformPrepared` (`src/mcp/tools/messaging.ts:361-373`) runs
  before `beforeAudit` (`src/core/send-pipeline.ts:100-103`), so a
  cross-conversation send whose text also trips the outbound suppressor returns
  a suppression and records no cross-conversation evidence. This is an ordering
  property of the send pipeline, not of either guard, and it is deliberately not
  a cell here.
- **Every cell runs on a resolution-forced registry.** The tests import
  `ToolRegistry` from `tests/helpers/resolved-tool-registry.ts`, which passes
  `resolved: true` unconditionally (line 27 of that file), so the unresolved /
  empty-context turn shape is deliberately NOT an axis of this matrix. No cell
  outcome depends on it: `executingResolution` has one reader in `src/`,
  `scheduledAgentJobMaySee` (`registry.ts:104`), reachable only for the tools in
  `SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS` (`registry.ts:75-82`), and neither
  `send_message` nor `probe_injected_send` is in that set. That axis belongs to
  sibling issue 3435.
- **One line in the chat-scoped arm is behaviourally dead.**
  `delete effectiveParams['chatJid']` (`registry.ts:715`) is immediately
  followed by an unconditional assignment at `registry.ts:717`, so removing the
  delete changes nothing observable. It is defensive, not load-bearing. Cell M6
  observes the assignment, not the delete.

## Deferred obligations

- The unbound-global cell is also pinned by a conditional assertion at
  `tests/integration/scope-injection.test.ts:439-455`, which wraps its only
  assertion in `if (result.isError)` and so passes whether the call succeeded or
  failed for an unrelated reason. Cell M5 pins that behaviour unconditionally
  here, but the weak assertion in the other file is untouched, because a
  concurrent change owns that file.
- No decision record yet states whether the two guards keep two failure channels
  or converge on one. Bead CQ-28
  (`docs/reviews/code-quality-dedup-simplify-20260619/`) still recommends
  consolidating the two sites and does not reference issue 3457.
