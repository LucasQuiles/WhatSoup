# Runbook: `transport.payload_too_large`

> Operator reference for `transport.payload_too_large` — the
> `PayloadTooLargeError` transport error.
>
> Registry: `src/core/transport-error-taxonomy.ts` · Contract:
> `src/transport/contract/errors.ts` · Disposition:
> `src/core/outbound-failure-disposition.ts`

## Error class

The outbound message body exceeds a size limit enforced by the transport — the
message is too large for the provider to accept. As with
`unsupported_capability`, the defect is in **this message** (its size), not the
channel's health.

Structured payload (`TransportErrorPayload`):

| Field | Value for this class |
|---|---|
| `code` | `transport.payload_too_large` |
| `retryable` | `false` |
| `scope` | varies |
| `phase` | optional (`not_started` when raised before any provider call) |

## When it fires

An adapter throws `PayloadTooLargeError` during admission or early in the send
path when the assembled payload (text + attachments + envelope) breaches the
transport's documented size ceiling. Raised before the provider is asked to
mutate state, the default disposition is `stage: admission`,
`mutation_state: not_started`.

## Retry policy

Authoritative (from `outbound-failure-disposition.ts` `classifyOutboundFailure`):

| Dimension | Outcome |
|---|---|
| `retryable` | `false` |
| `retry_decision` | `stop` |
| `retry_owner` | `none` |
| `attempt_budget_disposition` | `stop` |

**Never retried automatically.** An identical payload would breach the same
limit. Retry is only meaningful after the payload is shrunk (see Remediation).

## Containment

- Settles as a terminal failure for this attempt (`retry_decision: stop`).
- `mutation_state: not_started` and `provider_submission_count: 0` prove no
  provider call happened — the record is never treated as maybe-sent.
- No further retry budget is consumed (`budget: stop`).

## Duplicate-delivery risk

**None for automatic paths.** Raised before any provider mutation and never
retried, so no duplicate can arise from this code. A duplicate is only possible
if an operator manually re-sends **after** shrinking the payload — and only the
shrunk payload goes out.

## Operator diagnosis steps

1. Read `payload.message` / `payload.hint` for the limit value and which
   component (text vs. attachment) breached it.
2. Inspect the originating turn's attachments/media sizes
   (`payload.correlationId`).
3. Confirm `payload.phase` is `not_started` (nothing was sent).
4. Rule out a transient provider mis-report (some providers return a size error
   for unrelated quota conditions — cross-check against provider status).

## Remediation actions

1. **Shrink the payload**: transcode/downscale media, drop or split oversized
   attachments, or trim the text body, then re-send.
2. If the limit is configurable on the transport, confirm it matches the
   provider's real ceiling before retrying.
3. If the payload genuinely cannot be shrunk, deliver the user-facing notice
   (this class is notice-eligible) and stop.

## Escalation criteria

- Escalate if payloads well under the documented limit are being rejected
  (provider limit change or a size-mapping regression in the adapter).
- Escalate if a single attachment repeatedly triggers the limit across
  unrelated conversations (a media-handling defect, not a one-off).

## Authority and safe operator action

- **Authority:** the runtime's disposition (`stop`) is authoritative; do not
  override it with a blind retry.
- **Safe operator action:** shrink the payload, then re-send the **shrunk**
  payload — never replay the original.
- This class is **notice-eligible** (`outboundFailureWarrantsUserNotice`):
  channel health is proven and only the message size is the defect, so a short
  fixed notice to the same destination is likely to land.
