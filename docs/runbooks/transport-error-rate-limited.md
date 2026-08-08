# Runbook: `transport.rate_limited`

> Operator reference for `transport.rate_limited` — the `RateLimitedError`
> transport error.
>
> Registry: `src/core/transport-error-taxonomy.ts` · Contract:
> `src/transport/contract/errors.ts` · Disposition:
> `src/core/outbound-failure-disposition.ts`

## Error class

The provider throttled the send because the account has exceeded a rate or
quota window. Unlike a permanent/usage limit, this is a **transient, timed**
gate: the send is expected to succeed once the window elapses. This is the only
transport code that carries a structured `retryAfterMs`.

Structured payload (`TransportErrorPayload`):

| Field | Value for this class |
|---|---|
| `code` | `transport.rate_limited` |
| `retryable` | `true` |
| `retryAfterMs` | provider-supplied delay (ms), preserved structurally |
| `scope` | varies |
| `phase` | optional |

## When it fires

An adapter throws `RateLimitedError` at the provider-response stage when the
provider returns a throttle signal (e.g. HTTP 429 with a `retry-after`). The
class deliberately surfaces `retryAfterMs` as a structured field so downstream
retry logic never has to regex-parse a `hint` string. Default disposition:
`stage: provider_response`, `mutation_state: rejected` — the provider saw and
refused the request for now, so it is definitively not yet accepted.

## Retry policy

Authoritative (from `outbound-failure-disposition.ts` `classifyOutboundFailure`).
Two branches, both retryable:

| Condition | `retry_decision` | `retry_owner` | `budget` |
|---|---|---|---|
| `retryAfterMs` present (validated positive) | `retry_not_before` | `pending_drainer` | `preserve` |
| `retryAfterMs` absent, attempts remaining | `retry_now` | runtime's `retryOwner` | `consume` |
| attempts exhausted | `stop` | `none` | `stop` |

**Retried automatically, bounded.** When `retryAfterMs` is set, the runtime
defers to an absolute `retry_not_before` deadline and hands ownership to the
`pending_drainer`; the attempt budget is **preserved** (not consumed) because
the deferred attempt is the same logical send. Without a delay, it retries
immediately, consuming budget.

## Containment

- `retry_not_before` is stored as an absolute ISO timestamp (monotonic-guarded
  against clock regressions), never a bare delay.
- The deferred retry is coherent: `retryable: true`, owner `pending_drainer`,
  budget `preserve`, and `mutation_state` is `rejected` (never `ambiguous` or
  `submitted` — the evidence validator rejects incoherent deferred retries).
- Attempts are bounded; once exhausted the disposition hardens to `stop`.

## Duplicate-delivery risk

**Low but nonzero — by design, the runtime does not treat a rate-limited send as
delivered.** `mutation_state: rejected` means the provider refused the message,
so replaying it after the window elapses is safe from a duplicate standpoint.
The risk would only materialize if the provider actually accepted the message
*and* returned a rate-limit signal — a contract violation by the provider. The
deferred retry preserves message identity (`idempotencyKey`) where the transport
supports it.

## Operator diagnosis steps

1. Read `payload.retryAfterMs` (structured) — prefer it over the `hint` string.
2. Confirm `payload.phase` / `stage: provider_response` — a true provider
   throttle, not a local governor shed.
3. Distinguish a **rate-limit** (`rate_limit_exceeded`-class) from a
   **usage-limit** / **billing_error** — the latter is an account action that
   belongs to the agent failure taxonomy, not this transport code. Cross-check
   `payload.providerCode`.
4. Check for a rate-limit storm across many conversations (a single hot account
   vs. a fleet-wide throttle).

## Remediation actions

1. **Wait out the window** — the runtime already does this via the pending
   drainer when `retryAfterMs` is present; do not manually replay sooner.
2. If rate limits recur, reduce send cadence for the account (backpressure,
   coalescing, or a slower dispatch queue).
3. If the limit is a hard usage/billing cap mis-classified as rate-limited,
   re-route to the account-action path (usage-limit), not this retry path.

## Escalation criteria

- Escalate if `retryAfterMs` is absent on a clear 429 (adapter failed to parse
  `retry-after` → falls back to `retry_now` and can hammer the provider).
- Escalate if rate limits persist past the stated window (provider quota model
  changed, or the limit is actually a usage/billing cap).
- Escalate on a fleet-wide throttle across unrelated accounts (provider
  platform incident).

## Authority and safe operator action

- **Authority:** the runtime's deferred-retry machinery (`pending_drainer`) is
  authoritative when `retryAfterMs` is present; do not issue a competing manual
  replay that could double-send.
- **Safe operator action:** let the deferred retry drain; only intervene to
  reduce cadence or correct a mis-classified usage limit.
- This class is **notice-INeligible** (`outboundFailureWarrantsUserNotice` is
  `false` for `rate_limited`): it is retryable, not a stop-worthy rejection, so
  no user-facing failure notice is warranted.
