# Runbook: `transport.transient_provider`

> Operator reference for `transport.transient_provider` — the
> `TransientProviderError` transport error.
>
> Registry: `src/core/transport-error-taxonomy.ts` · Contract:
> `src/transport/contract/errors.ts` · Disposition:
> `src/core/outbound-failure-disposition.ts`

## Error class

A transient, retryable provider-side condition interrupted the send — a
connectivity blip, a transient 5xx, a timeout mid-call, or an overloaded
response. The failure is not permanent and not a deliberate provider refusal;
it may resolve on the next attempt. Crucially, because the error can surface
**after** the request has left, the runtime treats the outcome as ambiguous
unless proven otherwise.

Structured payload (`TransportErrorPayload`):

| Field | Value for this class |
|---|---|
| `code` | `transport.transient_provider` |
| `retryable` | `true` |
| `scope` | varies |
| `phase` | optional (`provider_call_started` / `ack_received` affect mutation state) |

## When it fires

An adapter throws `TransientProviderError` mid-request when the provider is
unreachable, returns a transient error, or times out after the call started.
Default disposition: `stage: provider_request`, `mutation_state: ambiguous` —
because the call was in flight, the runtime cannot prove the message did not
reach the provider.

## Retry policy

Authoritative (from `outbound-failure-disposition.ts` `classifyOutboundFailure`):

| Condition | `retry_decision` | `retry_owner` | `budget` |
|---|---|---|---|
| attempts remaining | `retry_now` | runtime's `retryOwner` | `consume` |
| attempts exhausted | `stop` | `none` | `stop` |

**Retried automatically, bounded.** This class carries no `retryAfterMs`, so it
retries immediately while attempts remain, consuming budget. Once the budget is
exhausted the disposition hardens to `stop`.

## Containment

- `mutation_state: ambiguous` (default) — the runtime deliberately does **not**
  treat the send as definitively failed; it is quarantined as maybe-sent.
- The evidence validator enforces coherence: a deferred retry
  (`retry_not_before`) is **forbidden** when `mutation_state` is `ambiguous`,
  so this class can only ever `retry_now` or `stop`, never defer.
- A transient failure can still land on `stop` once attempts are exhausted;
  that exhaustion says nothing about whether the message landed, so no
  user-facing notice is sent.

## Duplicate-delivery risk

**Material — this is the class that motivates the ambiguity discipline.**
Because the call was in flight when the error surfaced, the provider may have
accepted the message before the connection broke. A blind immediate retry
could therefore double-deliver. The runtime contains this by:
- treating the outcome as `ambiguous` (never as `not_started`),
- preserving message identity (`idempotencyKey`) where the transport supports
  it, and
- never issuing a user-facing "your message wasn't delivered" notice (a notice
  assumes the message did not land, which is unproven here).

## Operator diagnosis steps

1. Read `payload.message` and `payload.phase` — `provider_call_started` or
   `ack_received` confirms the call was in flight (ambiguity is real).
2. Check `mutation_state` — `ambiguous` means do not assume non-delivery.
3. Inspect provider status / recent error rate to judge whether the condition
   is still transient.
4. If the same message idempotency key has prior successful evidence, treat the
   message as delivered; do not replay.

## Remediation actions

1. **Prefer the runtime's bounded retry** — it consumes the attempt budget and
   preserves identity. Do not issue a parallel manual replay.
2. If the transient condition persists (sustained 5xx/overload), pause dispatch
   for the provider until its status recovers, then let the runtime retry.
3. If the message must be reconciled manually, first prove delivery state
   (provider message-status lookup via the idempotency key) **before** deciding
   to replay or suppress.

## Escalation criteria

- Escalate if transient errors become sustained on a single provider (provider
  outage — switch fallback priority, do not keep hammering).
- Escalate if a retried `transient_provider` ever produces a confirmed
  duplicate (an idempotency-key / dedup gap to fix).
- Escalate if the ambiguity is being downgraded to `not_started` anywhere
  (a disposition regression — this class must stay `ambiguous`).

## Authority and safe operator action

- **Authority:** the runtime's bounded-retry (`retry_now` until exhausted) is
  authoritative; do not compete with it.
- **Safe operator action:** before any manual replay, **prove the delivery
  state** from the provider side (idempotency-key lookup). If undelivered,
  replay once; if delivered or unknown, suppress.
- This class is **notice-INeligible** (`outboundFailureWarrantsUserNotice` is
  `false` for `transient_provider`): the original may have landed, so a "not
  delivered" notice would be misleading.
