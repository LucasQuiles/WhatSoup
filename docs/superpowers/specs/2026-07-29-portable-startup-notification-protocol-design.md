# Portable Startup-Notification Protocol Design

**Status:** approved, amended after the #2674 hygiene review

**Observed source baseline:** `origin/main`
`4068b730a0ec87a64451cec175f4cb0acbb1e424`. #2667 (`4a3ffef8d`) is an
ancestor. This is a repository-wide process protocol, not a mini11-specific
repair.

## Already Merged: Preserve, Do Not Redo

#2674 is part of the baseline. This protocol work must retain, rather than
recreate, its bounded `startupNotificationStabilitySeconds` validation
(`0..86400`, fallback `600`), injected user-clock formatting for aggregate
copy, unwritable bootstrap journal fixtures, pure composition tests, shared
back-online expectation helper, and refreshed source-runtime manifest pin.
Any required test rewrite for the controller must preserve the failure-open
filesystem premise; a `/tmp` placeholder is not an equivalent substitute.

## Problem

#2667 made the generic agent back-online notice durable, stability-debounced,
and aggregating. The merged implementation has global lifecycle defects:

- Configured administrator JIDs default to WhatsApp except for Signal, while
  Twilio and iMessage bridges only strip their own suffixes.
- Readiness is optional on `RuntimeConnection` and startup treats an absent
  snapshot as connected, while health requires `connected` and
  `state === 'connected'`.
- Boot recording occurs late and inside the generic notification condition, so
  disabled, unlinked, and crashy boots are absent despite the “every boot”
  contract.
- Journal loading assigns `v: 1` regardless of input, silently interpreting a
  future journal as v1.
- `pendingStartupMessage` carries resume continuity, restart-loop alerts, and
  expired-session notices, but all are settled as if they were a resume.
- Generic send composes one state snapshot and re-reads another state to mark
  it, leaving the persist-before-send ordering only in a `main.ts` comment.
- A self-restart receipt does not settle its generic batch; startup state is
  absent from health and fleet observability.
- `startupNotifyPath` and `restartLoopGuardPath` are exact duplicate helpers.

The solution must be one transport-portable protocol for Baileys, Signal,
Twilio, and iMessage on every instance. Service managers launch the process;
they are not protocol inputs.

## Goals

1. Resolve configured administrators through the four existing JID builders.
2. Require and uniformly interpret connection readiness.
3. Record every applicable agent boot early and preserve deployed v1 journals.
4. Centralize typed startup policy, timers, and settlement in one controller.
5. Give an intentional restart receipt an explicit settlement rule.
6. Reuse existing health and fleet systems with a fail-closed release check.
7. Consolidate only demonstrated startup/restart journal mechanics.
8. Accept operational portability on launchd and systemd; Docker inherits the
   process protocol but remains untested.

## Scope Boundaries and Follow-ups

- No host-specific runtime branches, manager API, Docker matrix, bot.db
  correlation, second monitor, or second fleet poller.
- `sendTracked` completion is a tracked provider-submission attempt, never an
  end-to-end delivery receipt.
- Provider-bridge base extraction is a separate follow-up: repeated bridge
  methods are real duplication, but require their own contract and regression
  matrix.
- The health boolean-helper consolidation is deferred to the next focused
  health-poller change.
- Remove the unused `STARTUP_NOTIFY_FILENAME` export only if Task 3's final
  repository search proves it has no callers.
- No live deployment, restart, message, or external mutation is authorized by
  this source plan.

## Existing-State Constraints

- `src/core/jid-constants.ts` is the JID-builder SSOT:
  `toPersonalJid`, `toSmsJid`, `toSignalJid`, and `toImessageJid` already
  exist.
- `canonicalizeImessageDirectIdentity` already owns AppleID/E.164
  canonicalization and must be reused by config.
- Each of the four production runtime connections already implements
  `getConnectionState`.
- Production v1 journal data is exactly
  `{v:1,boots:number[],lastNotifiedAt:number|null}`. It must read unchanged;
  no migration is needed.
- Fleet self-instance health storage is raw pass-through, so fleet work is
  tests-only unless a retention test proves otherwise.
- `stateRoot` is per-instance and manager-independent.

## Canonical Protocol

### Configured-admin addressing

Add one exhaustive configured-direct resolver beside the JID builders. It
accepts `TransportId` and a validated canonical identity, then delegates only
to existing builders:

| Transport | Canonical identity | Result |
| --- | --- | --- |
| `baileys` | phone digits | `toPersonalJid(identity)` |
| `signal` | lowercase UUID or E.164 wire | `toSignalJid(identity)` |
| `twilio` | phone digits | `toSmsJid(\`+${identity}\`)` |
| `imessage` | AppleID or E.164 wire | `toImessageJid(identity)` |

`resolveAdminIdentities` uses `canonicalizeImessageDirectIdentity`; no new
email or phone parser is permitted. Fleet PATCH gets regression coverage that
an AppleID and loader-compatible phone input survive. Its default-Baileys-only
create-line path is not an implied iMessage provisioning surface.

The resolver replaces main's local helper, fixing introduction and generic
startup sends. Final inventory disposition is mandatory:

| Surface | Disposition |
| --- | --- |
| Main introduction and generic startup target | adopt resolver |
| Restart-loop guard alert | adopt resolver |
| HEAL timeout admin DM | adopt resolver |
| `emit_heal_result` admin DM | injected resolver/JID dependency |
| `resolveAdminChatJid` fallback | transport history lookup then resolver |
| Access replay candidates | scope out: lookup/replay, not configured-admin send |
| Control peers, inbound parsing, fleet config normalization | scope out: separate contracts |

Approval history lookup searches only the active transport namespace before
fallback. Baileys alone retains LID mapping. A WhatsApp history row cannot
become an iMessage or Twilio administrator target.

### Strict readiness

`RuntimeConnection.getConnectionState(): ConnectionStateSnapshot` is required.
Export `isFullyConnected(snapshot)` beside that shared contract, true only when
`connected === true && state === 'connected'`. Startup eligibility and health
use this predicate. A review inventory permits raw `.connected` only for
documented non-readiness semantics.

Tests typecheck affected doubles and construct every registered production
adapter to assert a callable, bounded snapshot method. This prevents an
untyped future adapter from restoring the old connected-by-default path.

### Version-safe journal and early boot evidence

Extract only shared restart/startup journal mechanics: state-root filename
joining, bounded private JSON read/write, and typed version-result status.
Keep schema validation, pruning, counters, and transitions in their owners; do
not build a generic persistence framework.

Startup reading is explicit:

- missing journal enters the normal fresh-v1 record path;
- valid v1 loads and persists as v1;
- malformed, unreadable, or unknown versions do not throw, reinterpret, or
  overwrite the source record;
- service stays available, but health reports `journal_unreadable` and release
  acceptance is non-green.

Record a boot once after process ownership and `stateRoot` are established, but
before runtime start/connect/history recovery or notification/introduction
gates. This is unconditional for applicable agent processes: policy can disable
sends, not boot evidence.

Replace independent compose/mark calls with journal-owned
`settleStartupNotification`. It reads authoritative v1 state, chooses the
unnotified boots, composes existing copy, attempts the watermark write, and
returns a typed result. The controller attempts settlement before provider
submission. A persistence failure preserves service availability but never
justifies a successful durability or exactly-once claim.

### Typed startup policies and controller

Replace the overloaded pending slot with a discriminated runtime-to-controller
event:

- `resume`: prompt safe continuity send that settles the generic batch;
- `restart_loop_guard_alert`: prompt incident alert that does not consume the
  generic watermark or bypass stability;
- `expired_session_notice`: distinct user continuity/status behavior, never
  relabeled as resume or silently settled.

The controller owns boot record, timer, eligibility, connection re-arm, generic
settlement, receipt settlement, and health projection. `main.ts` constructs it
once and delegates all startup paths. It imports no service manager, database,
provider bridge, or JID formatter.

Generic notification waits for the configured window (preserving the
three-second minimum) and requires `isFullyConnected`; disconnect re-arms one
controller timer. The controller owns cancellation and cannot leave multiple
generic timers active.

### Intentional restart receipt

The self-restart receipt is a named policy. It settles its v1 boot batch before
the existing short send and suppresses the later generic aggregate. This
intentionally suppresses earlier unnotified flap history and sends no generic
administrator aggregate when requester and administrator differ. The generic
message means “back online”; health/watchdog own incident visibility.

### Health, fleet, and acceptance

`/health` always emits a privacy-safe additive `startupNotification` object:

```ts
interface StartupNotificationHealth {
  state: 'not_applicable' | 'disabled' | 'waiting_stability'
       | 'waiting_transport' | 'dispatching' | 'sent'
       | 'send_failed' | 'journal_unreadable';
  policy: 'generic' | 'resume' | 'restart_loop_guard_alert'
        | 'expired_session_notice' | 'intentional_restart' | 'disabled' | 'none';
  stabilitySeconds: number | null;
  bootCountSinceNotification: number | null;
  lastBootAt: number | null;
  lastNotifiedAt: number | null;
  nextEligibleAt: number | null;
  lastSendAt: number | null;
}
```

It contains no JIDs, identities, message text, paths, raw errors, or bot.db
data. Waiting or notification failure does not make normal service health
unhealthy; the existing poller retains the object without becoming a monitor.

Add a one-shot fail-closed release validator over health and v1 journal data.
Missing/malformed state, unknown enum, journal failure, send failure,
watermark/timestamp mismatch, command failure, and probe failure are non-green.
It has no bot.db lookup, daemon, or health-classification side effect. After
explicit approval, launchd and systemd each run the same accepted procedure;
Docker remains inherited and untested.

## Deterministic Evidence Matrix

| Contract | Validator |
| --- | --- |
| Per-transport route correctness | resolver table and bridge target tests |
| All configured-admin sends accounted for | final inventory with adopt/scope-out ledger |
| iMessage config portability | loader and fleet PATCH canonicalization tests |
| Readiness consistency | helper truth table, integration tests, adapter factory, static fallback search |
| Early every-boot record | bootstrap ordering tests across all notification/introduction gates |
| v1 compatibility and v2 safety | literal v1/v2/malformed fixtures with no-rewrite assertions |
| Typed policy isolation | fake-clock resume/alert/expired-session tests |
| Single settlement | fake-clock flap, zero-window, reconnect, receipt, stop, and send-failure tests |
| No duplicate journal mechanics | shared-primitive plus both owner suites and duplicate inventory |
| Bounded observability | health shape/forbidden-field and fleet retention tests |
| No false-green release check | success and each failure/inconclusive validator fixture |
| Global platform claim | approved launchd and systemd evidence receipts |

## Documentation

The implementation PR updates `docs/configuration.md`,
`docs/runbooks/personal-line-watch.md`, and
`docs/runbooks/release-deployment.md` together. The personal-line runbook must
replace the stale expected-burst wording with aggregate, typed prompt exception,
health, and fail-closed acceptance guidance without claiming provider delivery.
