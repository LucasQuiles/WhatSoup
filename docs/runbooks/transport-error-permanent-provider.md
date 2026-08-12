# Runbook: `transport.permanent_provider`

> Operator reference for `transport.permanent_provider` — the
> `PermanentProviderError` transport error.
>
> Registry: `src/core/transport-error-taxonomy.ts` · Contract:
> `src/transport/contract/errors.ts` · Disposition:
> `src/core/outbound-failure-disposition.ts`

## Error class

The provider returned a **definitive, non-retryable** failure that is not
covered by a more specific transport code — a hard rejection that will not
resolve on retry. This is the catch-all for permanent provider-side conditions
that lack a dedicated class (auth, not-found, capability, and size all have
their own codes), so its meaning is narrower than it sounds: a terminal
provider refusal of *unspecified* kind.

Structured payload (`TransportErrorPayload`):

| Field | Value for this class |
|---|---|
| `code` | `transport.permanent_provider` |
| `retryable` | `false` |
| `scope` | varies |
| `phase` | optional |

## When it fires

An adapter throws `PermanentProviderError` (typically as the unmatched-error
fallback in port-error mapping) when the provider returns a definitive refusal
that does not match a known specific class. Default disposition:
`stage: provider_response`, `mutation_state: rejected` — the provider saw the
request and refused it permanently.

## Retry policy

Authoritative (from `outbound-failure-disposition.ts` `classifyOutboundFailure`):

| Dimension | Outcome |
|---|---|
| `retryable` | `false` |
| `retry_decision` | `stop` |
| `retry_owner` | `none` |
| `attempt_budget_disposition` | `stop` |

**Never retried automatically.** A permanent condition will not resolve on
retry; the runtime stops immediately.

## Containment

- Settles as a terminal failure for this attempt (`retry_decision: stop`).
- `mutation_state: rejected` — the provider definitively refused, so the
  record is treated as rejected (not maybe-sent).
- No further retry budget is consumed (`budget: stop`).
- Because this class is the unmatched-error fallback, **channel health is
  unproven** for whatever provider condition landed here — the runtime does not
  assume a notice would succeed either.

## Duplicate-delivery risk

**None for automatic paths.** The message was rejected (not accepted) and the
failure is never retried. A later manual re-send after the provider condition is
understood is safe from a duplicate standpoint because the prior response was an
explicit permanent rejection — the original was never accepted.

## Operator diagnosis steps

1. Read `payload.message`, `payload.hint`, and especially `payload.providerCode`
   — because this is the fallback class, the provider's own code is the primary
   clue to the *real* condition.
2. Reclassify if possible: many real permanent failures are actually auth
   (`auth_required`), capability, size, or not-found conditions that the adapter
   failed to map specifically. A high rate of `permanent_provider` usually means
   an adapter mapping gap, not a new failure mode.
3. Confirm `payload.phase` / `stage: provider_response`.
4. Check whether the condition is specific to one message/destination or
   channel-wide.

## Remediation actions

1. **Understand the provider condition** via `providerCode` before acting — do
   not treat "permanent" as actionable without knowing *what* is permanent.
2. If the condition is message-specific (content policy, format), change the
   message and re-send.
3. If the condition is channel-wide, restore the channel/provider before
   re-sending.
4. If the adapter should have mapped this to a specific class, fix the mapping
   so the runbook for the real class applies next time.

## Escalation criteria

- Escalate whenever `permanent_provider` fires at volume — its fallback nature
  means each occurrence is an unmapped provider code that deserves a specific
  class.
- Escalate if a known provider condition (auth, quota) is landing here instead
  of its dedicated code (adapter mapping regression).
- Escalate on channel-wide permanent refusals (provider account suspended).

## Authority and safe operator action

- **Authority:** the runtime's disposition (`stop`) is authoritative; do not
  override it with a blind retry.
- **Safe operator action:** diagnose the real condition via `providerCode`,
  remediate at that level, then re-send only if the condition is message-specific
  and the message has been changed.
- This class is **notice-INeligible** (`outboundFailureWarrantsUserNotice` is
  `false` for `permanent_provider`): channel health is unproven for an
  unmatched provider condition, so a notice send is not assumed safe.
