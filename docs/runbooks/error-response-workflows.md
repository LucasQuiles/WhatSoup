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
| `WHATSOUP_DIAGNOSTIC_BUNDLE` | off | On an arming failure (usage-limit / rate-limit / auth-required / model-unavailable) via the dispatcher, run the best-effort diagnostic bundle and emit a findings digest to the alert outbox. Requires the dispatcher flag on (it rides the new path). Fire-and-forget — never blocks or alters the fallback path. |

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

These are derived and read-only — observability only, no behaviour change.

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

## Built but not yet wired

The following components exist and are unit-tested but are not yet integrated
into the live turn path; this section will move into the live sections as each
is wired (per the runbook-and-PR co-update rule):

- **Cross-harness context handoff** — `handoff-prelude.ts` (composer),
  `handoff-artifact.ts` (the `agent_handoff_artifacts` store), and
  `handoff-distill-gate.ts` (the per-conversation token/call budget + global
  concurrency + circuit-breaker gate for the warm distiller). The distiller
  loop, the `buildSystemPrompt`/`replayTurnOnFallback` injection seams, and
  schema-ensure at init are pending.
- **One consolidated message** — `response-templates.ts` (deterministic
  per-template renderers) and `standby-notice.ts` (the crash-safe SQLite latch,
  table `standby_notice`, atomic consume-once) for collapsing the fallback
  notice and the stand-in's reply into a single message. The
  stash-on-activate / consume-on-first-reply wiring is pending.
