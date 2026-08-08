# Runbook: `transport.unsupported_capability`

> Operator reference for `transport.unsupported_capability` — the
> `UnsupportedCapabilityError` transport error.
>
> Registry: `src/core/transport-error-taxonomy.ts` · Contract:
> `src/transport/contract/errors.ts` · Disposition:
> `src/core/outbound-failure-disposition.ts`

## Error class

The destination transport cannot perform an operation the runtime asked for —
a requested capability (e.g. a media type, a send flag, or a per-operation
feature) is not implemented by the adapter for this channel. The defect is in
**this message's request shape**, not the channel's health.

Structured payload (`TransportErrorPayload`):

| Field | Value for this class |
|---|---|
| `code` | `transport.unsupported_capability` |
| `retryable` | `false` |
| `scope` | varies (`request` / `conversation` / …) |
| `phase` | optional (`not_started` when raised before any provider call) |

## When it fires

An adapter throws `UnsupportedCapabilityError` during admission or early in the
send path, when the operation requests something the transport does not
support. Because it is raised before the provider is asked to mutate state, the
default disposition is `stage: admission`, `mutation_state: not_started` — no
external side effect has occurred.

## Retry policy

Authoritative (from `outbound-failure-disposition.ts` `classifyOutboundFailure`):

| Dimension | Outcome |
|---|---|
| `retryable` | `false` |
| `retry_decision` | `stop` |
| `retry_owner` | `none` |
| `attempt_budget_disposition` | `stop` |

**Never retried automatically.** Retrying an identical request would hit the
identical capability wall, so the runtime stops immediately and surfaces the
failure. Retrying is only meaningful after the request is changed (see
Remediation).

## Containment

- Settles as a terminal failure for this attempt (`retry_decision: stop`).
- `mutation_state: not_started` and `provider_submission_count: 0` prove no
  provider call happened — the record is never treated as maybe-sent.
- The failed attempt consumes no further retry budget (`budget: stop`).

## Duplicate-delivery risk

**None for automatic paths.** Because the error is raised before any provider
mutation and is never retried, there is no path by which this code can produce
a duplicate delivery. A duplicate is only possible if an operator manually
re-sends **after** changing the request — and then only the changed request
goes out, never the original.

## Operator diagnosis steps

1. Read the structured `payload.message` and `payload.hint` — they name the
   unsupported capability and the operation that requested it.
2. Confirm the operation/capability is genuinely unsupported on this channel
   (check the adapter's capability declaration), not a transient mapping bug.
3. Check `payload.phase` — `not_started` confirms nothing was sent.
4. Correlate with `payload.correlationId` to find the originating user turn.

## Remediation actions

1. **Change the request** so it no longer asks for the unsupported capability
   (e.g. transcode media, drop the unsupported flag, or pick a supported
   operation), then re-send.
2. If the capability should be supported, file an adapter gap — do not patch
   the request around it silently.
3. If no supported alternative exists, deliver the user-facing notice (this
   class is notice-eligible — see below) and stop.

## Escalation criteria

- Escalate to the channel adapter owner if a capability the product claims to
  support is being rejected (adapter vs. product contract mismatch).
- Escalate if the same request shape was accepted recently and now is rejected
  (regression in the adapter's capability map).

## Authority and safe operator action

- **Authority:** the runtime's disposition (`stop`) is authoritative; do not
  override it with a blind retry.
- **Safe operator action:** inspect the payload, change the request shape, then
  re-send the **changed** request — never replay the original verbatim.
- This class is **notice-eligible** (`outboundFailureWarrantsUserNotice`):
  because the channel is healthy and only the message's request was the defect,
  a short fixed notice to the same destination is likely to land.
