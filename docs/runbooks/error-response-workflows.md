# Provider Error → Response Workflows

How WhatSoup maps a provider/harness failure to a differentiated response —
diagnostics, fallback, and the user-facing message. This runbook documents what
is live by default versus what is available behind opt-in flags, plus the
operational signals.

## Architecture

A terminal provider result is classified by the SSOT in
`src/runtimes/agent/failure-taxonomy.ts` (`classifyProviderFailure` → 6-kind
`ProviderFailureKind`; `classifyAgentFailure` → 18-class `AgentFailureClass`).
The behaviour for each class — which diagnostics to run, the fallback policy,
the retry policy, and the user-message template — is declared once in the
registry SSOT `src/runtimes/agent/response-registry.ts` (`ResponseWorkflow`),
not hand-rolled at call-sites. A boot-time guard asserts the registry stays
consistent with the taxonomy's eligibility functions.

## Feature flags

| Env var | Default | Effect |
|---|---|---|
| `WHATSOUP_RESPONSE_REGISTRY_DISPATCH` | off (`!= '1'`) | Route terminal provider failures through the registry dispatcher (`handleProviderFailureResult`) instead of the legacy per-chat / singleton branch ladders. Behaviour-preserving — equivalence-locked against the `provider-fallback` and `fallback-usage-limit-cascade` suites. |
| `WHATSOUP_DIAGNOSTIC_BUNDLE` | off | On an arming failure (usage-limit / rate-limit / auth-required / model-unavailable) via the dispatcher, run the best-effort diagnostic bundle and emit a findings digest to the alert outbox. Requires the dispatcher flag on (it rides the new path). Fire-and-forget — never blocks or alters the fallback path. Throttled to once per primary per 60s so a fallback storm cannot fan out probe spawns. |
| `WHATSOUP_ONE_MESSAGE_HANDOFF` | off | Collapse the fallback notice and the stand-in's reply into one message: when a replay is scheduled, stash the notice in the crash-safe `standby_notice` latch and prepend it to the stand-in's first visible reply, instead of sending a separate notice. Off → the notice is enqueued standalone exactly as before. |

Rollout: enable `WHATSOUP_RESPONSE_REGISTRY_DISPATCH` first and confirm the
equivalence suites are green in production, then enable
`WHATSOUP_DIAGNOSTIC_BUNDLE` for diagnostics observability.

## Diagnostics

When enabled, the bundle (`src/runtimes/agent/diagnostic-bundle.ts`) runs the
diagnostics named by the failure's workflow, in parallel and best-effort, each
under a per-probe deadline (a slow probe is abandoned, never awaited). Every
failure mode — rejection, throw, timeout, or an unregistered probe — degrades to
a low-confidence `ok:false` finding; a fully-failed bundle is still valid.

Probes (built by `src/runtimes/agent/diagnostic-probes.ts`):
`health-snapshot`, `usage-limit-reset-parse`, `primary-model-usability`,
`primary-recovery-probe`, and `account-auth-status`
(`src/runtimes/agent/providers/account-auth-status.ts` — key-presence is
`probable`, an absent key `confirmed`; the CLI `auth status` path is `confirmed`
on a clean verdict, `suspected` when inconclusive). Probe summaries are
pre-redacted and never include raw probe output. The CLI auth probe is handed an
explicit `HOME`/`PATH`/`USER` allowlist, never the full process env.

Alert: `provider_failure_diagnostics`, title
`Diagnostics for <kind> on <provider>`, evidence a per-finding digest
(`id:ok|flagged/confidence ...`) plus the parsed reset time when known.

## Health signals

`GET /health` (it spreads `getFallbackState()` verbatim) exposes, in addition to
the existing fallback-window fields:

- `fallbackChainExhausted` — true when every configured fallback entry has failed
  during the current window (the terminal "nothing left to fall back to"
  condition);
- `failedEntryCount` — how many entries have failed this window.
- `turnErrorCounts` — cumulative process-lifetime count of user-turn failures by
  class (`rate-limit`, `usage-limit`, `auth-required`, `model-unavailable`,
  `policy-block`, `context-overflow`, `unknown-terminal`, `empty-output`), so you
  can see which provider-failure classes fire most. Captured on both the legacy
  and dispatcher paths.

These are derived and read-only — observability only, no behaviour change.

## One consolidated message (flag-gated)

With `WHATSOUP_ONE_MESSAGE_HANDOFF` on, a fallback that schedules a stand-in
replay does not send its notice separately. The notice is stashed in the
crash-safe `standby_notice` latch (`src/runtimes/agent/standby-notice.ts`) and
prepended to the stand-in's first visible reply — the user sees one message. The
latch survives a restart and is consumed exactly once (atomic select-and-delete
under `BEGIN IMMEDIATE`). When there is no continuation (resend / blocked by tool
activity / missing backup credentials) the notice is sent standalone as before,
and a stash failure also falls back to standalone — the notice is never lost.

Empty/tool-only turns are handled: at turn end the runtime flushes any
still-pending notice standalone, so a stand-in turn with no visible reply still
surfaces the notice in the same turn rather than deferring it. Consume-once means
the flush is a no-op when a reply already prepended the notice — the notice is
emitted exactly once per turn (prepended, or flushed).

## Canonical error taxonomy

The matchers recognise canonical structured error tokens from the Anthropic and
OpenAI references, not only legacy English phrasing. The load-bearing split: a
429 is not uniformly transient —

- `insufficient_quota` (OpenAI) / `billing_error` (Anthropic) → **usage-limit**
  (account action, long fallback window);
- `rate_limit_exceeded` / `rate_limit_error` → **rate-limit** (transient).

Also mapped: `authentication_error` / `invalid_api_key` → auth-required;
`not_found_error` / `model_not_found` → model-unavailable; `request_too_large`
(413) and the `model_context_window_exceeded` stop reason → context-overflow.
The chat `api-error-classifier` maps HTTP 400/413 → bad_request and 5xx incl. 529
overloaded → server (retryable).

## Empty-output fallback trigger (textless primary failure)

A broken primary auth/session (e.g. `claude-cli` after a silent CLI auto-update
invalidated its keychain login) exits cleanly with **no text** — there is no
failure *message* to classify, so none of the token matchers above fire. To stop
the bot pinning itself to a dead primary and looping on `status:degraded`, the
runtime arms the fallback **deterministically** on empty PRIMARY output
(`maybeArmFallbackAfterEmptyPrimaryTurn`):

- immediately on the **first** empty turn when the independent usability probe
  (`primaryModelUsability`) already flags the primary unusable, or
- after **2 consecutive** empty primary turns (`EMPTY_OUTPUT_FALLBACK_THRESHOLD`)
  — a healthy primary never returns two pure-empty user turns in a row.

The trigger (probe state + consecutive-empty count) is fully deterministic; only
the user-facing message is templated. It arms with the **`auth-required`** reason
so fallback selection skips same-provider entries (a broken `claude-cli` login
breaks every `claude-cli` fallback too → jump to the independent provider) and
revert is gated on a fresh primary probe — so it self-heals once the primary auth
is restored. The counter resets on any successful turn; the path is a no-op while
already on a fallback window or when no fallback is configured.

**Startup grace (`EMPTY_OUTPUT_ARM_STARTUP_GRACE_MS`, 60s).** The boot/recovery
sequence (proactive per-chat resume → resume-fail → context-recovery / replayed
turns) emits empty results while the usability probe is still transiently
`unknown`. That transient `unknown` is what `primaryModelUsabilityRequiresAlert`
reads as unusable, so the **single-empty probe fast-path** would arm on the very
first empty turn and flap the instance onto the backup on *every* restart (seen in
production: the spurious startup activations were all single-empty
`probe-unusable`, none from the threshold). So before the instance has served a
turn (`lastSuccessfulTurnAt === null`) and within the grace window, **only the
probe fast-path is suppressed** — the empty is still **counted**, and the
consecutive-empty threshold still arms. This is deliberately narrow: a genuinely
dead primary taking *real* inbound traffic in the first 60s still fails over via
the threshold (at most one extra turn of latency — no silent blind spot), and the
per-chat empty-output replay that arms through the threshold is preserved. The
counter resets on any successful turn, after which the probe fast-path is live
again immediately.

The grace's elapsed measurement uses `performance.now()` (monotonic), not
`Date.now()`, so wall-clock steps (NTP corrections, host sleep/wake, VM
migration) cannot prematurely end or over-extend the window on any host/platform.
The probe fast-path is additionally gated on `!probeInFlight` (mirroring
`getTurnCapability`) so an unresolved startup probe never reads as
confirmed-unusable.

### Chain advance past a structurally-empty fallback entry

The same textless-failure blind spot exists one layer down: a fallback *entry*
can connect but emit no assistant text (observed 2026-06-17 — the opencode
minimax provider integration returns a session id + `step_start` events with
zero message text, while deepseek through the identical opencode path replies
normally and direct minimax completion works, so the key/model are valid and the
defect is in opencode's minimax adapter). Such a turn produces no terminal
failure *message*, so the text-driven advance path
(`activateProviderFallbackAfterTerminalResult` on a classified failure) never
fires. Without intervention the bot pins to the dead entry and emits
`_The backup model returned no reply — please resend…_` every turn while a
working entry sits behind it in the chain.

`recordFallbackTurnOutcome` closes this symmetrically with the primary trigger:
after `EMPTY_OUTPUT_FALLBACK_THRESHOLD` (2) consecutive empty turns on the
*active* fallback entry, it routes the entry through the SAME advance path
terminal failures use — marking it failed and re-selecting the next eligible
entry. The window's original arm reason is preserved, so an `auth-required`
window keeps skipping same-as-primary entries (it must not advance back onto a
dead primary provider) and lands on the next independent entry. An
attempted-key guard prevents re-advancing (and re-alerting) the same entry every
threshold-hit when no alternate exists; in that terminal case the existing
single-fallback preservation keeps the current entry rather than reverting to a
known-bad primary. The counter resets on any non-empty fallback turn. A
successful advance emits `fallback_provider_failed` (for the dead entry) plus a
structured `advanced fallback chain past structurally-empty entry` log.

## Warm handoff distiller (flag-gated)

The cross-harness context handoff is now fully wired behind three opt-in flags
(default-off — byte-identical when unset):

- **`WHATSOUP_HANDOFF_DISTILLER`** (`1` to enable) — arms the background
  production sweep that periodically asks the `HandoffDistillRunner` to distill
  each active conversation. The runner owns the per-conversation token+call
  budget and the global concurrency + circuit-breaker gate; the timer only sets
  the sweep cadence. Inert (sweep not armed, one warn log) when set but no model
  key resolves.
- **`WHATSOUP_HANDOFF_CONTEXT`** (`1` to enable) — when a fresh or stand-in
  session is spawned, injects the most recent distilled summary into the session
  system prompt (`system` seam for all providers per the 2026-06-16 experiment).
  The callback yields `null` (SessionManager omits it) when no fresh artifact
  exists, so there is no behaviour change when the distiller has not yet run.
- **`WHATSOUP_HANDOFF_DISTILL_MODEL`** — the cheap summarizer model id used for
  distillation. Accepted values: `deepseek-chat`, `MiniMax-M2.7`, `glm-5.2`.
  When unset (or set to an unrecognised id with no matching API key) the
  distiller is inert and the sweep is not armed.

The implementation is best-effort and fail-safe: every error at tick or sweep
level is caught and logged at warn, never propagated to the turn path or the
process. A structured info-level log (`handoff distill sweep complete` with
`ticked` count) is emitted on each successful sweep. The `handoffDistiller`
block in `GET /health` (`instance.handoffDistiller`) reports the live flag+config
state as read-only telemetry:

```json
"handoffDistiller": { "enabled": true, "contextInjection": false, "model": "deepseek-chat" }
```

The verbatim half (last N messages as `[Recent chat context]` on every fresh
session) ships unconditionally and is unaffected by these flags.

## Deterministic message templates (wired)

The fallback-activation notice (`notifyProviderFallbackActivated` in
`src/runtimes/agent/runtime.ts`) now renders its user-facing copy through
`renderUserMessage` in `response-templates.ts` — the renderer is the single
source of truth for that copy, replacing the previous inline string. The
activation reason maps 1:1 to a template id (`usage-limit`, `rate-limit`,
`auth-required`, `model-unavailable`), overridden to `credentials-missing` when
the backup key is absent; `hasContinuation` carries the continue-vs-resend
decision and the resolved model card is passed as `backupCard`. The notice
routing (one-message handoff stash vs standalone enqueue) is unchanged.

- **`tool-activity-blocked`** — when a replay is blocked because the first
  attempt already started an action, the copy now lives in `response-templates.ts`
  rather than being composed at the call site. Two render paths share one source
  of truth: the reason templates (`usage-limit`, `rate-limit`, …) render the
  blocked directive in place of their continue/resend clause when the
  `blockedByToolActivity` render flag is set, and a dedicated
  `tool-activity-blocked` template id renders the directive standalone (with the
  backup/digest context clauses). The directive — "The first attempt already
  started an action, so I will not replay it automatically. Please confirm or
  resend the next step." — is emitted once, never doubled with a resend clause.
  `notifyProviderFallbackActivated` in `src/runtimes/agent/runtime.ts` passes the
  flag through; the output is byte-for-byte identical to the previous inline
  composition.
