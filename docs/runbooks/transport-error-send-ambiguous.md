# Runbook: `transport.send_ambiguous`

> Operator reference for `transport.send_ambiguous` — the `SendAmbiguousError`
> transport error.
>
> Registry: `src/core/transport-error-taxonomy.ts` · Contract:
> `src/transport/contract/errors.ts` · Disposition:
> `src/core/outbound-failure-disposition.ts`

## Error class

The send reached an indeterminate state: the runtime cannot prove whether the
provider accepted the message or not. This is the highest-duplicate-risk class
in the taxonomy, and the runtime's response is deliberately conservative — it
**forbids blind retry without delivery-state proof**. Unlike the other codes,
`phase` is **required** on this error (the constructor rejects an input without
it).

Structured payload (`TransportErrorPayload`):

| Field | Value for this class |
|---|---|
| `code` | `transport.send_ambiguous` |
| `retryable` | `false` |
| `phase` | **required** — `not_started` / `provider_call_started` / `ack_received` |
| `scope` | varies |

## When it fires

An adapter throws `SendAmbiguousError` when a send's outcome is unknowable at
the point of failure — e.g. a connection dropped after the request was
transmitted but before an acknowledgement, a crash in flight, or an
acknowledge-then-disconnect. The `phase` records how far the send progressed,
which drives the disposition:

| `phase` | `stage` | `mutation_state` |
|---|---|---|
| `not_started` | `admission` | `not_started` |
| `provider_call_started` | `provider_request` | `ambiguous` |
| `ack_received` | `acknowledgement` | `ambiguous` |

## Retry policy

Authoritative (from `outbound-failure-disposition.ts` `classifyOutboundFailure`):

| Dimension | Outcome |
|---|---|
| `retryable` | `false` |
| `retry_decision` | `stop` |
| `retry_owner` | `none` |
| `attempt_budget_disposition` | `stop` |

**Never retried automatically — and must not be retried manually without
delivery-state proof.** This is the contract's central safety rule for this
code: because the provider may already have accepted the message, any replay
risks a duplicate. The runtime stops and quarantines the outcome for human /
reconciliation review. (Note: even when `phase: not_started`, the class still
sets `retryable: false`; the runtime stops regardless of phase.)

## Containment

- Settles as a terminal failure for this attempt (`retry_decision: stop`).
- When `phase` is `provider_call_started` or `ack_received`,
  `mutation_state: ambiguous` — the runtime deliberately refuses to treat the
  send as failed or as not-started.
- The evidence validator enforces that an `ambiguous` mutation state can never
  carry a deferred retry (`retry_not_before`) — so this code is structurally
  barred from any automatic replay path.
- A stopped ambiguous outcome is routed to the `delivery_ambiguous_unsafe`
  quarantine disposition when it carries unsafe-delivery-unconfirmed evidence,
  which demands `delivery-risk-reviewed` acknowledgement before retirement.

## Duplicate-delivery risk

**Highest in the taxonomy — this is the defining risk for this code.** A blind
retry could double-deliver because the provider may have accepted the original.
The runtime contains the risk on every axis:
- `retryable: false` → no automatic retry.
- `mutation_state: ambiguous` (for in-flight phases) → never treated as
  not-started, so never auto-replayed as if never-sent.
- notice-INeligible → no "your message wasn't delivered" notice (such a notice
  assumes non-delivery, which is unproven and itself could mislead the user).
- quarantine + acknowledgement → a human must review delivery risk before the
  record is retired.

## Operator diagnosis steps

1. Read `payload.phase` first — it determines how much risk exists:
   `provider_call_started` / `ack_received` mean the message may have landed;
   `not_started` means it provably did not.
2. Look up the message's delivery state from the provider **directly** using its
   idempotency key / stable message identity — this is the decisive input.
3. Check `payload.correlationId` to trace the originating turn.
4. Inspect the quarantine record and its disposition
   (`delivery_ambiguous_unsafe` requires `delivery-risk-reviewed`).

## Remediation actions

1. **Prove delivery state before any replay.** Query the provider for the
   message id. If delivered → suppress the replay. If undelivered → replay
   once. If unknowable → default to **suppress** (a missed message is safer
   than a duplicate).
2. If the ambiguity was caused by a known transient (connection drop after
   transmit), improve the adapter's acknowledgement handling so future sends
   resolve to `ack_received` rather than ambiguous.
3. Record the resolution in the quarantine acknowledgement so the incident
   closes with provenance.

## Escalation criteria

- Escalate every `delivery_ambiguous_unsafe` quarantine that cannot be resolved
  by a provider delivery-state lookup — these are the records that need human
  judgement.
- Escalate if ambiguous sends recur on one adapter (a connection/ack robustness
  defect to fix at the adapter, not at the disposition layer).
- Escalate if a duplicate is ever confirmed from a `send_ambiguous` replay —
  the idempotency / dedup contract has a gap.

## Authority and safe operator action

- **Authority:** the runtime's disposition (`stop`, never retry) is
  authoritative and exists specifically to prevent duplicates. **Do not override
  it with a blind retry.**
- **Safe operator action:** the *only* safe replay is one preceded by a
  provider delivery-state proof showing the original was not delivered. Absent
  that proof, suppress. "Send ambiguous forbids blind retry without
  delivery-state proof" is the load-bearing rule for this code.
- This class is **notice-INeligible** (`outboundFailureWarrantsUserNotice` is
  `false` for `send_ambiguous`): the original may have landed, so any "not
  delivered" notice would be false for a subset of cases.
