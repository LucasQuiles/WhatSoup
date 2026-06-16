# Provider Error → Response Workflows

How WhatSoup maps a provider/harness failure to a differentiated response —
diagnostics, fallback, and the user-facing message. This runbook documents what
is live (and how to enable it) versus what is built but not yet wired, plus the
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

## Built but not yet wired

The following components exist and are unit-tested but are not yet integrated
into the live turn path; this section will move into the live sections as each
is wired (per the runbook-and-PR co-update rule):

- **Deterministic message templates** — `response-templates.ts` (one renderer
  per user-template id) are built and unit-tested but not yet used by the live
  notice path, which still composes its string inline; unifying the two is a
  follow-up.
