# Fleet Bot Hardening Standard

Status: draft standard. Updated: 2026-06-15.

This standard records the fleet requirement created by the reference
provider-failure fix. It is a documentation and verification contract only: it
does not approve a release re-cut, plist edit, restart, WhatsApp pairing,
credential change, or host mutation.

## Scope

Applies to every WhatSoup agent bot that is expected to answer user turns,
including the reference incident bot and each peer agent bot in the current
fleet inventory. Passive lines, chat-only lines, and disconnected recovery
targets are out of scope except for status visibility and explicit exception
tracking.

`sandbox-agent` remains the preferred destructive-test harness for provider
degrade/recover acceptance. Production lines must not be used to prove
intentional primary-model failure unless that live mutation is separately named
and approved.

## Operating Rules

- Green `/health` is not the same as a proven user turn. The evidence must show
  either a successful turn after startup or an explicit no-turn state.
- One hardened bot does not complete fleet hardening. Every agent bot needs its
  own row.
- A source merge proves source durability only. It does not update a live
  release directory, launchd plist, service, keychain, auth bond, or WhatsApp
  session.
- Runtime proof must name the host, instance, source or release, time, state,
  confidence, and next operator action.
- Provider diagnostics may classify failures, but raw provider stderr/stdout,
  raw prompt text, and credential values must not be surfaced to users or BOT
  ERRORS alerts.

## Hardening Signature

An agent bot is hardened only when all four capabilities below are present,
observable, and backed by source plus runtime evidence.

### A. Turn-Capability Health

The instance `/health` response must include top-level `turn_capability`:

| Field | Required meaning |
|---|---|
| `model_usable` | `true` after successful primary model usability proof, `false` after a configured primary usability failure, `null` before definitive proof |
| `model_usability_status` | One of the normalized usability classes, such as `usable`, `model-unavailable`, `credential-unavailable`, `provider-unavailable`, `timeout`, or `unknown` |
| `last_successful_turn_at` | Timestamp of the latest successful user turn, or `null` |
| `last_turn_error_class` | Normalized failure class only; no raw provider text |
| `last_turn_error_at` | Timestamp of the latest failed user turn, or `null` |

The top-level `/health.status` must degrade when the runtime is degraded,
`model_usable=false`, or a user-turn error has no later successful turn.
A later successful user turn must clear the last-turn error fields.

Runtime proof must include the full `turn_capability` block and one of:

- a successful outbound/reply turn after the latest startup or restart;
- a deliberate no-turn baseline that says no successful turn has happened yet;
- a degraded-turn proof where `last_turn_error_class` is populated and no raw
  provider text leaked.

### B. Primary Model Usability Probe

The configured primary conversation model must be probed on startup without
blocking the runtime indefinitely. The health instance block must expose
`primaryModelUsability` with provider, model, status, checked time, in-flight
state, and safe reason or suggestion fields.

The probe must classify at least these operator-actionable states:

- `model-unavailable`
- `credential-unavailable`
- `provider-unavailable`
- `timeout`
- `unknown`

A configured primary usability failure must emit a `primary_model_unusable`
operator alert with safe metadata only. A bot whose primary provider is merely
authenticated, but whose selected model cannot complete a turn, is not hardened.

### C. Release Drift-Check Job

Each live bot must have source/live drift visibility for the release snapshot it
is actually running. The check must compare a release manifest or explicit
release path to source and report drift or checker failure without mutating the
host.

The drift job is compliant only when:

- it is read-only;
- it uses the active launchd plist `WorkingDirectory` or a separately reviewed
  release path;
- it queues BOT ERRORS only on drift or checker failure;
- a clean check is quiet unless a deliberate clear-on-ok recovery proof is being
  captured;
- any install, load, re-cut, restart, or alerting schedule change has separate
  named approval.

Drift findings are evidence. They are not approval to overwrite, delete, or
replace a release.

### D. Fallback Chain

The bot must have either an ordered `agentOptions.fallbacks` chain or the legacy
single `fallbackProvider` / `fallbackModel` pair. New fleet hardening should use
the chain form. An unchanged legacy pair can satisfy this capability only when
it provides an independent fallback target and the parity row records why chain
migration is deferred.

The fallback target must be independent enough to survive the primary failure:
auth-required primary failures require an independent provider, not another tier
on the same failed auth surface. The chain must reject duplicate entries, the
primary provider/model pair, and more than eight entries, matching the config
validator limit documented in `docs/configuration.md`.

Arm time means activation of a fallback window after a terminal primary-provider
failure or an explicit admin canary such as `FALLBACK ON`. Persisted-window
restore means startup recovery of an already-active fallback window from the
runtime fallback-state database. At arm time and on persisted-window restore,
the runtime must:

- select the first eligible keyed entry;
- record per-entry `eligible` state in `/health` and provider-status;
- preflight fallback binary availability where a CLI provider is used;
- preflight credential presence and, where supported, credential validity;
- preflight model catalog availability where supported;
- emit operator alerts for missing binary, missing/invalid credential, unknown
  model, fallback activation, restore, revert, replay, stalled recovery, and
  empty fallback turns.

Fallback state must be observable in `/health` and
`GET /api/lines/:name/provider-status`, including effective provider, fallback
reason/model/reset, recovery-probe requirement, active entry, chain eligibility,
turn counters, empty-turn counters, last fallback turn, probe attempts, last
probe time, transition counters, and fallback window cost where available.

Manual canary proof uses a short `FALLBACK ON` window and must show the reply is
served by the fallback provider, then show the window ends or reverts. It does
not substitute for a real primary-failure degrade/recover test.

## Outbound Client-Safety Guard

Mechanically enforces the Operating Rule that raw provider/runtime diagnostics
and internal artifacts must never reach a user (see the diagnostics rule above
and `docs/runbooks/release-deployment.md` live-acceptance item "no raw provider
diagnostic text is sent to a user"). The guard is a content filter on the
outbound send path, not a model behavior — it holds even while a bot runs on a
degraded fallback model.

Source of truth: `src/core/outbound-message-safety.ts` (pure, transport-free).
Two concerns:

- **Redact** — `redactInternalArtifacts` masks operator-local home paths,
  internal runtime identifiers (sandbox hook/policy filenames, `.claude/`,
  settings, hook events), tailnet/CGNAT addresses, and provider tokens/emails
  (the last via the shared `sanitizeProviderPreviewText`).
- **Divert** — `classifyInfraStatusClaim` detects a false self-infra-failure
  claim ("tools are blocked", "failing closed", "sandbox policy missing"). On a
  client-bound divert the user receives only a generic retry message; the
  original sanitized diagnostic is routed to BOT ERRORS so ops learns the agent
  malfunctioned. The classifier is deliberately high-precision (it ignores
  legitimate single-tool/vendor limitations); it is not a general hallucination
  detector.

Audience: a send addressed to the configured `BOT_ERRORS_JID` is `ops`
(verbatim diagnostics required there); every other send defaults to `client`
(the conservative direction — a false-positive redaction on an operator message
is low-harm, a leak to a client is high-harm).

Coverage — every agent free-text path to a client must pass through the guard,
or it is a bypass:

- MCP tools (`src/mcp/tools/messaging.ts`, `media.ts`): `send_message`,
  `reply_message`, `edit_message` (redact + divert); `send_poll` question/
  options and `send_media` caption (redaction-only — no sensible divert for a
  structured poll or a media send).
- Chat-bot runtime (`src/runtimes/chat/runtime.ts`): the reply text is redacted
  before the durability op and send (redaction-only — the chat bot has no agent
  tooling/sandbox to make a false infra-block claim about).

Out of scope by design: internal ops/alert paths (`emit-alert`,
`bot-errors-outbox`, reply-guarantee, `/health/send`) are `ops` audience and
keep verbatim diagnostics.

## Fleet Parity Row

Every agent bot needs one current parity row before the class can be called
closed.

| Field | Required evidence |
|---|---|
| Host | Machine name and access path used for evidence capture |
| Instance | WhatSoup instance name and service label |
| Source/live | source commit, release snapshot path, and live `WorkingDirectory` |
| Health URL | bound host/port and authentication posture |
| Primary | configured provider, model, and `primaryModelUsability` state |
| Turn capability | full `turn_capability` block and latest successful-turn evidence |
| Fallback chain | configured entries, active entry if any, and per-entry eligibility |
| Provider status | `GET /api/lines/:name/provider-status` snapshot or reason unreachable |
| Drift check | installed job or explicit exception, last check time, and result |
| Alerts | relevant BOT ERRORS state, including fallback or primary-model alerts |
| Approval | `none` for read-only evidence, or the named approval record for any live mutation used while collecting the row |
| Operator action | clear next action: none, re-cut, restart, pair, fix key, fix model, or defer |

Rows expire after a release re-cut, config change, credential rotation, auth
re-pair, provider change, or service restart that could affect provider state.
Refreshing an expired row by reading existing `/health`, provider-status, logs,
or drift-check output is read-only evidence collection. Any config edit,
credential change, restart, pairing flow, re-cut, plist edit, or forced fallback
window used during refresh is a live mutation and needs named approval.

## Recurring Parity Check

Until an automated guard exists, the recurring parity check is a reviewer-owned
evidence pass over every agent bot:

1. Inventory the current agent-bot cohort from the fleet source of truth.
2. Pull `/health` and provider-status for each reachable bot.
3. Confirm capabilities A through D or record a named exception.
4. Confirm source/live drift status for the release actually running.
5. Fail the pass if any agent bot lacks `turn_capability`,
   `primaryModelUsability`, fallback chain/status visibility, or drift-check
   evidence.
6. Fail the pass if any bot reports `model_usable=null` while claiming a recent
   successful turn without turn evidence.
7. Fail the pass if any bot has `model_usable=false`, a logged-out/401 auth
   state, fallback credential failure, missing fallback binary, unknown fallback
   model, or drift-check failure without an assigned operator action.

The source-side recurring gate is `npm run guard:fleet-bot-hardening-parity`.
It validates the redacted parity manifest at
`docs/reliability-runner/fleet-bot-hardening-parity.json`, confirms every row
has A-D capability state, and keeps the standard, provider-status tests,
fallback-chain tests, public surfaces, configuration docs, release boundaries,
and BOT ERRORS matrix anchored. The runtime side must still collect the parity
row above and fail closed on missing fields rather than treating absence as
healthy.

## Rollout Gates

- Drafting this standard is approval-free.
- Landing it through GitHub needs the normal branch, commit, push, and PR
  approval path.
- Named approval means explicit operator/user authorization in the active work
  session or deployment record for the specific host, instance, and action.
- Re-cutting a release is a separate live operation.
- Installing or loading a drift-alert launchd job is a separate live alerting
  change.
- Editing bot configs, credentials, launchd plists, keychains, auth state, or
  service processes requires named host/instance approval.
- Re-pairing a logged-out WhatsApp line is a separate human QR/auth task; the
  provider hardening standard does not bypass it.
- The RR-016 live degrade/recover acceptance test remains deferred until an
  isolated sandbox instance is approved and paired through that same named
  approval path.

## Done Definition

The fleet may be reported as hardened only when:

- the reference incident bot and every peer agent bot have non-expired parity
  rows;
- all rows prove capabilities A through D;
- source/live drift is reconciled or blocked with evidence;
- the sandbox degrade/recover test has either passed or remains explicitly
  deferred with the production-safety reason;
- no row relies on a source merge as proof of live protection;
- BOT ERRORS has actionable next steps for every unhealthy or unproven bot.

If any row carries an accepted exception, report the outcome as closed with
exceptions, not fleet hardened. The exception must name the missing capability,
the reason it is accepted, the owner of the next action, and the review date.

## Source Anchors

- Provider configuration and runtime fields: `docs/configuration.md`
- Public health and provider-status surfaces: `docs/public-surface.md`
- Reliability runner gates: `docs/reliability-runner/README.md`
- RR-004 and RR-016 status: `docs/reliability-runner/feature-matrix.md`
- Release and drift boundaries: `docs/runbooks/release-deployment.md`
- Provider-status route tests: `tests/fleet/routes/provider-status.test.ts`
- Turn-capability health tests: `tests/core/health.test.ts`
- Fallback chain selection tests: `tests/runtimes/agent/fallback-chain-selection.test.ts`
- Provider fallback state-machine tests: `tests/runtimes/agent/provider-fallback.test.ts`
- BOT ERRORS matrix guard: `scripts/bot-errors-simulation-matrix.ts`
