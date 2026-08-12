# Runbook: `transport.auth_required`

> Operator reference for `transport.auth_required` — the `AuthRequiredError`
> transport error.
>
> Registry: `src/core/transport-error-taxonomy.ts` · Contract:
> `src/transport/contract/errors.ts` · Disposition:
> `src/core/outbound-failure-disposition.ts`

## Error class

The transport rejected the send because the account's authentication is missing,
expired, or revoked — a session/credential problem, not a defect in this
message. The provider returned an auth-gate refusal after the request reached
it.

Structured payload (`TransportErrorPayload`):

| Field | Value for this class |
|---|---|
| `code` | `transport.auth_required` |
| `retryable` | `false` |
| `scope` | varies |
| `phase` | optional |

## When it fires

An adapter throws `AuthRequiredError` at the provider-response stage when the
provider demands re-authentication — a revoked session, an expired token, or a
freshly required login. Because the provider saw the request, the default
disposition is `stage: provider_response`, `mutation_state: rejected` (the
provider explicitly refused, so the message was definitively not accepted).

## Retry policy

Authoritative (from `outbound-failure-disposition.ts` `classifyOutboundFailure`):

| Dimension | Outcome |
|---|---|
| `retryable` | `false` |
| `retry_decision` | `stop` |
| `retry_owner` | `none` |
| `attempt_budget_disposition` | `stop` |

**Never retried automatically.** Re-sending without restoring auth would hit
the identical auth gate. Retry is only meaningful **after** the credential /
session is restored (see Remediation).

## Containment

- Settles as a terminal failure for this attempt (`retry_decision: stop`).
- `mutation_state: rejected` — the provider's refusal is definitive, so the
  record is treated as rejected (not maybe-sent, not submitted).
- No further retry budget is consumed (`budget: stop`).
- An auth failure is a strong signal for fallback selection: same-provider
  fallback entries are skipped because a broken login breaks every entry on
  that provider.

## Duplicate-delivery risk

**None for automatic paths.** The message was rejected (not accepted) and the
failure is never retried. Restoring auth and re-sending later is safe from a
duplicate standpoint because the provider's prior response was an explicit
rejection — the original was never accepted for delivery.

## Operator diagnosis steps

1. Read `payload.message` / `payload.hint` for the provider's auth reason.
2. Run the account-auth diagnostic (`account-auth-status` probe) to distinguish
   `confirmed` (clean verdict: key/session gone) from `suspected` (inconclusive).
3. Check `payload.phase` — a `provider_response`-stage auth error confirms the
   provider itself returned the gate.
4. Correlate with `payload.correlationId` and recent auth events (key rotation,
   session expiry, forced logout).

## Remediation actions

1. **Restore the credential/session**: re-link the account, refresh the token,
   or re-run the auth flow for this transport.
2. After auth is confirmed restored (re-run the auth probe), re-send the
   original message — the prior rejection means no duplicate risk.
3. If the account cannot be re-authenticated, surface the outcome and let
   fallback selection move to an independent provider.

## Escalation criteria

- Escalate if auth errors appear for an account whose credentials were just
  confirmed valid (provider-side auth incident or a session-store regression).
- Escalate if the auth probe and the live send disagree (probe says `confirmed`
  but sends still fail auth — the probe's key-presence heuristic may be stale).
- Escalate on a fleet-wide auth storm across unrelated accounts (provider
  platform incident, not per-account).

## Authority and safe operator action

- **Authority:** the runtime's disposition (`stop`) is authoritative; do not
  override it with a blind retry.
- **Safe operator action:** restore auth, confirm via the auth probe, then
  re-send. Never replay while the auth state is still broken.
- This class is **notice-INeligible** (`outboundFailureWarrantsUserNotice` is
  `false` for `auth_required`): an auth problem is about the session, not this
  message, and the same channel cannot deliver a notice either.
