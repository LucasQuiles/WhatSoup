# Cross-conversation guard: call-site matrix

Tracking artifact for issue 3457. It records, cell by cell, what the
cross-conversation guard does and which failure channel records a violation.

Issue 3457 combined the two former guards (the registry's pre-handler check and
`send_message`'s in-handler `assertConversationMatch`) into one guard. Owner
decision 27 fixed its terms: merge the guards, keep today's behaviour, and keep
a bound session whose conversation-key mirror disagrees with its binding
DENIED, with a loud log. No cell admits anything it denied before the change.
Three cells changed their failure SHAPE on purpose (M3, M4 and the diverged half
of M9d); the section "What issue 3457 changed" lists them.

Every cell is pinned by a named test in
`tests/integration/cross-conversation-guard-matrix.test.ts`; the guard's own
branches are pinned in `tests/mcp/cross-conversation-guard.test.ts`. Line
anchors below are against the commit that landed issue 3457; function names are
the stable anchors.

## The guard

`evaluateTargetConversation(session, targetJid, fold)` in
`src/mcp/cross-conversation-guard.ts` is the one guard. It is pure: it returns a
verdict, and the registry maps a deny verdict onto its failure channel and logs
it (`ToolRegistry.evaluateTargetConversation`, `src/mcp/registry.ts`).

| | |
| --- | --- |
| Owner | the registry; `send_message` only calls the callback it is handed |
| Fold | the resolver installed by `setCanonicalConversationKeyResolver` (armed in production by `registerMessagingTools`), else bare `toConversationKey` (cell M10) |
| Pre-handler point | the caller-supplied `chatJid`, in the global-and-unbound arm of the injected-target branch, when no alias `to` is present |
| Post-resolution point | the `assertTargetConversation` callback the registry passes every handler as its fourth argument; `send_message` calls it on `prepared.chatJid` at its dry-run and `beforeAudit` sites, after alias and `@lid` resolution |
| Denial transport | pre-handler: `reject(...)`. Post-resolution: the callback throws `CrossConversationDenied`, `send_message` re-throws it past its own catch blocks, and the registry's handler catch maps it |
| Denial shape | plain text at both points |
| Log | every denial logs one line: `warn` for an ordinary denial, `error` with both keys for a binding/mirror divergence |
| Missing callback | `send_message` throws before resolving or sending anything |

### Branches

Evaluated in this order.

| Branch | Verdict | Condition | Failure code / stage |
| --- | --- | --- | --- |
| `chat-scoped-injected-target` | admit | `tier !== 'global'`; the registry injects the target from the session, so nothing caller-controlled reaches the guard | none |
| `invalid-target-jid` | deny | a bound session's `binding.deliveryJid`, or the target, does not fold | `validation_rejected` / `validation` |
| `binding-mirror-divergence` | deny, logged at `error` | a bound session whose non-empty `conversationKey` mirror differs from the FOLD of `binding.deliveryJid` | `authorization_denied` / `authorization` |
| `unconfined-global-session` | admit | an unbound global session with an empty `conversationKey`. The #3435 L3 fail-open, kept on purpose as one named early return (cell M5) | none |
| `foreign-conversation` | deny | the target's fold differs from the enforced key: the fold of `binding.deliveryJid` for a bound session, else the mirror | `authorization_denied` / `authorization` |
| `target-matches-conversation` | admit | otherwise | none |

A bound session is compared by FOLD, not by stored string. The binding key is
stored raw (`toConversationKey`, in `perChatActorSession` and
`WhatSoupSocketServer.updateConversationBinding`) while the mirror the
executing-turn register supplies is phone-folded (`canonicalConversationKey`).
A mapped `@lid` binding therefore stores `<lid digits>` while its mirror is
`<phone>` for the SAME conversation. Cell M9e pins that this is admitted, as it
was before 3457. Why the stored forms differ is the drift the owner decision
leaves to a separate investigation.

Both points fail before any external effect and before the audit-intent write,
so no denial admits a send. A post-resolution denial still writes the S1 actor
receipt, because the handler has already started.

## Failure channels used by the matrix

| Channel | Failure code | Failure stage | Retry disposition | Operator action | Contract anchor |
| --- | --- | --- | --- | --- | --- |
| Authorization denial (both guard points) | `authorization_denied` | `authorization` | `not_retryable` | `recover` | `src/core/durability-evidence-contract.ts:50` |
| Target validation (both guard points; the bound arm) | `validation_rejected` | `validation` | `not_retryable` | `none` | `src/core/durability-evidence-contract.ts:49` |
| Handler-returned error (M8 only) | `returned_error` | `handler` | `unknown` | `inspect` | `src/core/durability-evidence-contract.ts:57` |
| No failure | none, `status = complete` | | | | |

## What issue 3457 changed

Before 3457 the in-handler guard threw a plain `Error`, and two catch blocks in
`send_message` matched its message PREFIX (`chatJid "` and `Invalid chatJid "`)
to turn the throw into a JSON `{ "error": ... }` envelope, which the registry
recorded as `returned_error` / `handler`. Those catch blocks are gone. The
guard's denial now travels as the typed `CrossConversationDenied`, so its
channel no longer depends on message text.

| Cell | Before 3457 | After 3457 |
| --- | --- | --- |
| M3, M4 | denied, JSON envelope, `returned_error` / `handler` | denied, plain text, `authorization_denied` / `authorization` |
| M9d, diverged mirror | denied, JSON envelope, `returned_error` / `handler`, text "does not match session conversation" | denied, plain text, `authorization_denied` / `authorization`, text "does not match the conversation binding", `error`-level log |
| An alias that resolves to an invalid JID (not a matrix cell; `tests/mcp/tools/messaging.test.ts`) | JSON envelope, `returned_error` / `handler` | plain text, `validation_rejected` / `validation` |

No other cell moved. The denial text for a foreign target is byte-identical at
both points and unchanged from the old pre-handler text, so text matchers such
as the fleet proxy's `VALIDATION_RE` (`src/fleet/routes/mcp-proxy.ts`) still
classify it as 422. What changes for a fleet caller of M3 or M4 is the proxy's
`error` field, which now carries the denial text instead of the generic
`MCP tool reported an error`. No consumer in `src/`, `deploy/`, `console/`,
`scripts/` or `tools/` parses the old JSON envelope; the send-acceptance
parsers key on `isError`.

## The matrix

Axes: session tier, alias target `to` present or absent, session
`conversationKey` mirror present or absent.

`SessionTier` admits only `global` and `chat-scoped` (`src/mcp/types.ts:14`), so
a conversation-bound session is NOT a third tier value. It appears in the Tier
column as `global + binding`, which is what the tests construct.

| Cell | Tier | `to` | `conversationKey` | Guard point and branch | Outcome | Failure channel |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | global, unbound | absent | present | pre-handler, `foreign-conversation` | denied, plain text, no dispatch | `authorization_denied` / `authorization` |
| M2 | global, unbound | absent | present, addressed by its own mapped `@lid` | pre-handler and post-resolution, `target-matches-conversation` through the armed fold | admitted, dispatched to the `@lid` conversation | none |
| M3 | global, unbound | present | present | pre-handler skipped (alias not resolved yet); post-resolution at `beforeAudit`, `foreign-conversation` | denied, plain text, no dispatch | `authorization_denied` / `authorization` |
| M4 | global, unbound | present | present, `dryRun` | post-resolution at the dry-run site, `foreign-conversation` | denied, plain text, no dispatch | `authorization_denied` / `authorization` |
| M5 | global, unbound | absent | absent | both points, `unconfined-global-session` | admitted, fail open | none, evidence filed under `__global__` |
| M6 | chat-scoped | absent | present | chat-scoped arm injects `deliveryJid`; post-resolution `chat-scoped-injected-target` | admitted, target replaced by `deliveryJid` | none |
| M7 | chat-scoped | present | present | `to` stripped by the chat-scoped arm; post-resolution `chat-scoped-injected-target` | admitted, target is `deliveryJid`, alias never resolves | none |
| M8 | global, unbound | present **and** `chatJid` present | present | pre-handler skipped by the caller-supplied `to`; the handler's target-exclusivity fault fires before the post-resolution point | denied as a target-exclusivity fault, not a conversation fault | `returned_error` / `handler` |
| M9a | global + binding | absent, `chatJid` supplied | present | the bound arm rejects any caller target before the handler; neither guard point is reached | denied, plain text | `validation_rejected` / `validation` |
| M9b | global + binding | absent, `chatJid` supplied | absent | same bound arm | denied, plain text | `validation_rejected` / `validation`, filed under `__global__` |
| M9c | global + binding | absent, no caller target | absent | bound arm fills the target from the binding; post-resolution `target-matches-conversation` | admitted, dispatched to the binding | none, filed under `__global__` |
| M9d | global + binding | absent, no caller target | present | bound arm fills the target from the binding; post-resolution adjudicates it | mirror agrees: admitted, dispatched to the binding. Mirror diverged: `binding-mirror-divergence`, denied, plain text, `error` log, no dispatch | agreeing: none. Diverged: `authorization_denied` / `authorization`, filed under the diverged MIRROR key |
| M9e | global + binding keyed by raw `@lid` digits | absent, no caller target | present, phone-folded, same conversation | post-resolution compares folds, `target-matches-conversation` | admitted, dispatched to the `@lid` binding | none |
| M10 | global, unbound, no fold armed | absent | present, addressed by its own mapped `@lid` | pre-handler on the bare `toConversationKey` fallback, `foreign-conversation` | denied, plain text, the session's OWN conversation | `authorization_denied` / `authorization` |

Notes the rows above do not carry in a column:

- M9a and M9b supply `chatJid`. The bound arm rejects a `to` target the same
  way; `M9a variant` in the test file pins it.
- M10 and its control run against `probe_injected_send`, a fixture
  injected-target tool built by `probeInjectedTool` in the test file, not
  against `send_message`. `registerMessagingTools` is the sole production arming
  site for the canonical fold, so a registry holding a real `send_message`
  always has the fold armed and the un-armed cell is unreachable with a
  production tool.
- The test file also pins, beyond the cells: M1 and M3 answer the same foreign
  target with identical text and an identical evidence row, and `send_message`
  run without the guard callback throws before sending.

### Cell index to tests

| Cell | Test title in `tests/integration/cross-conversation-guard-matrix.test.ts` |
| --- | --- |
| M1 | `M1 global pinned session, foreign chatJid, no alias: registry guard denies as authorization_denied/authorization` |
| M2 | `M2 global pinned session, own conversation addressed by a mapped @lid: registry guard admits through the armed fold` |
| M3 | `M3 global pinned session, foreign alias target, live send: the post-resolution guard denies as authorization_denied/authorization` |
| M4 | `M4 global pinned session, foreign alias target, dryRun: the post-resolution guard denies as authorization_denied/authorization` |
| M5 | `M5 global session with no conversationKey: both guards are skipped and the send is admitted` |
| M6 | `M6 chat-scoped session with a caller-supplied chatJid: target is replaced by deliveryJid and neither guard runs` |
| M7 | `M7 chat-scoped session with an alias target: the alias is stripped and the send goes to deliveryJid` |
| M8 | `M8 global pinned session supplying both chatJid and to: the registry guard is suppressed and a target-exclusivity fault answers instead` |
| M9a | `M9a conversation-bound session with the conversationKey mirror present: a caller-supplied target is rejected as validation_rejected/validation` |
| M9b | `M9b conversation-bound session with no conversationKey mirror: a caller-supplied target is rejected as validation_rejected/validation` |
| M9c | `M9c conversation-bound session with no conversationKey mirror and no caller target: the binding supplies the target` |
| M9d | `M9d conversation-bound session with the conversationKey mirror present and no caller target: an agreeing mirror is admitted and a diverged mirror is denied as authorization_denied/authorization` |
| M9e | `M9e conversation-bound session keyed by raw @lid digits with a phone-folded mirror of the same conversation: admitted` |
| M10 | `M10 registry guard with no fold armed: a pinned session addressing its OWN conversation by a mapped @lid is denied as authorization_denied/authorization` |
| M10 control | `M10 control: the SAME call is admitted once the canonical fold is armed` |

The titles of M5, M6 and M8 predate issue 3457 and still say "both guards",
"neither guard" and "the registry guard"; they are kept verbatim because those
cells did not move. Read them as the guard's two points.

### How the cells map to the intake enumeration

The intake for issue 3457 counts nine cells, six pinned at the pre-3457 base and
three unpinned. That count folds variants that this document keeps separate.

| Intake cell | Status at base per the intake | Cells here |
| --- | --- | --- |
| global, key, foreign `chatJid`, deny | pinned | M1 |
| global, key, own `chatJid` through the fold, admit | pinned | M2 |
| global, key, alias target, deny | pinned | M3 and M4, the live send and the dry-run variant |
| global, no key | pinned, by a conditional assertion | M5 |
| chat-scoped, `chatJid` and alias | pinned | M6 and M7 |
| conversation-bound, any caller target | pinned | M9a |
| (a) both `chatJid` and `to` on a pinned session | not pinned | M8 |
| (b) bound session, mirror absent or diverged | not pinned | M9b and M9c cover the absent half; M9d covers the mirror-present half, both sub-cases; M9e covers a mirror that differs in stored form but not in conversation |
| (c) registry guard with an un-armed fold | not pinned | M10, with its armed control |

## Corrections to the issue table

The issue's anchor table has two inaccurate cells. Both describe the pre-3457
registry guard and were inaccurate when the issue was filed. The corrections
live here; the issue body is not edited.

**Correction 1. The registry guard was not "any tier". It was global-and-unbound
only.** It sat in the final `else` arm of the injected-target branch, behind the
bound arm and the chat-scoped arm. The combined guard's pre-handler point keeps
that position. The post-resolution point is reachable from any session whose
handler calls the callback; the guard admits chat-scoped sessions there by its
first branch.

**Correction 2. The installed-resolver anchor pointed at an unrelated resolver.**
The issue cites the resolver installed around `registry.ts:490-497`, which is
`setTurnCorrelationResolver`, a durability turn-correlation resolver with no
part in the guard. The fold the guard consults is installed by
`setCanonicalConversationKeyResolver`. Cell M10 and its control pin the
difference the two anchors make.

## Out-of-scope context

None of the following is pinned by this matrix.

- **Other confinement mechanisms exist on the same surface.**
  `validateMessageOwnership` (`src/mcp/tools/messaging.ts`) triggers on any
  tier with a `conversationKey`, resolves through a SQL predicate with no fold,
  and reports a "Message not found" result deliberately indistinguishable from a
  miss. `assertConversationAccess` (`src/mcp/types.ts`) prefers the binding over
  the mirror, compares raw strings with no fold, and throws an error classified
  `handler_failed` / `handler`. `forward_message` runs its own check
  (`src/mcp/tools/chat-management.ts`). Issue 3457 left all three unchanged.
- **Target mode is an axis this matrix does not carry.** The pre-handler point
  is gated on `tool.targetMode === 'injected'`, so it never runs for a
  caller-supplied tool such as `forward_message`.
- **The post-resolution point runs only for `send_message`.** Other injected
  tools on a bound session (`react_message`, `send_poll` and the rest) receive
  the binding's target and do not call the callback, so a diverged mirror is not
  adjudicated for them. That is unchanged from before 3457, when only
  `send_message` carried the in-handler guard.
- **An outbound suppression can mask a cross-conversation violation.** On the
  live send path `transformPrepared` runs before `beforeAudit`
  (`src/core/send-pipeline.ts`), so a cross-conversation send whose text also
  trips the outbound suppressor returns a suppression and records no
  cross-conversation evidence. This is an ordering property of the send
  pipeline, unchanged by 3457, and deliberately not a cell here.
- **Every cell runs on a resolution-forced registry.** The tests import
  `ToolRegistry` from `tests/helpers/resolved-tool-registry.ts`, which passes
  `resolved: true` unconditionally, so the unresolved / empty-context turn shape
  is deliberately NOT an axis of this matrix. No cell outcome depends on it:
  `executingResolution` has one reader in `src/`, `scheduledAgentJobMaySee`,
  reachable only for the tools in `SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS`, and
  neither `send_message` nor `probe_injected_send` is in that set. That axis
  belongs to sibling issue 3435.
- **One line in the chat-scoped arm is behaviourally dead.**
  `delete effectiveParams['chatJid']` in the registry's chat-scoped arm is
  immediately followed by an unconditional assignment, so removing the delete
  changes nothing observable. Cell M6 observes the assignment, not the delete.

## Deferred obligations

- The unbound-global cell was once pinned by a conditional assertion in
  `tests/integration/scope-injection.test.ts`. That case was replaced on main by
  `unbound global session reaches the caller-supplied chatJid — pins the fail-open cross-conversation guard at base`,
  whose assertions are unconditional. Cell M5 pins the same behaviour here.
- Why a bound session's mirror can diverge from its binding (the binding keyed
  raw, the executing-turn mirror keyed phone-folded, and any other source) is
  the separate investigation owner decision 27 calls for. Until it lands, a
  divergence is denied and logged at `error`.
- Closing the M5 fail-open is a one-branch owner decision: the
  `unconfined-global-session` early return in `evaluateTargetConversation`.
