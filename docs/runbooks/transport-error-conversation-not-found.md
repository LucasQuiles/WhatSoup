# Runbook: `transport.conversation_not_found`

> Operator reference for `transport.conversation_not_found` — the
> `ConversationNotFoundError` transport error.
>
> Registry: `src/core/transport-error-taxonomy.ts` · Contract:
> `src/transport/contract/errors.ts` · Disposition:
> `src/core/outbound-failure-disposition.ts`

## Error class

The destination conversation does not exist on the provider — the JID/LID or
conversation identity cannot be resolved to a deliverable chat. Unlike the
size/capability classes, here **the destination itself is the defect**: the
channel may be perfectly healthy, but there is nowhere valid to deliver.

Structured payload (`TransportErrorPayload`):

| Field | Value for this class |
|---|---|
| `code` | `transport.conversation_not_found` |
| `retryable` | `false` |
| `scope` | varies |
| `phase` | optional (`not_started` when raised before any provider call) |

## When it fires

An adapter throws `ConversationNotFoundError` when a send targets a
conversation identity the provider reports as absent/unknown — a closed/expired
chat, a wrong-format identifier, or a conversation the account can no longer
address. Raised before any provider mutation, the default disposition is
`stage: admission`, `mutation_state: not_started`.

## Retry policy

Authoritative (from `outbound-failure-disposition.ts` `classifyOutboundFailure`):

| Dimension | Outcome |
|---|---|
| `retryable` | `false` |
| `retry_decision` | `stop` |
| `retry_owner` | `none` |
| `attempt_budget_disposition` | `stop` |

**Never retried automatically.** The destination's absence is a proven
negative, not a transient state; an identical send would hit the identical wall.

## Containment

- Settles as a terminal failure for this attempt (`retry_decision: stop`).
- `mutation_state: not_started` and `provider_submission_count: 0` prove no
  provider call happened — the record is never treated as maybe-sent.
- No further retry budget is consumed (`budget: stop`).

## Duplicate-delivery risk

**None for automatic paths.** Raised before any provider mutation and never
retried. Note the deliberate asymmetry vs. the size/capability classes: even a
user-facing notice is **not** sent for this class, because a notice addressed
to the same broken destination would hit the identical wall (see Authority).

## Operator diagnosis steps

1. Read `payload.message` for the rejected identity and the provider's reason.
2. Verify the destination identity against the conversation registry — confirm
   alias resolution (`conversation_key` vs. raw `chat_jid`) did not produce a
   stale or malformed target.
3. Confirm `payload.phase` is `not_started`.
4. Check whether the conversation was recently closed/expired on the provider
   side (group dissolved, account left, number deactivated).

## Remediation actions

1. **Resolve the destination**: refresh the conversation identity, re-derive it
   from a current roster/group membership, or correct the alias.
2. If the conversation is genuinely gone, do not retry the send; surface the
   outcome to the originating context.
3. If a JID↔LID alias drift caused a bad target, re-anchor on the canonical
   `conversation_key` and re-send once the identity is corrected.

## Escalation criteria

- Escalate if **known-good** conversations suddenly report not-found in volume
  (provider-side incident or an alias-resolution regression).
- Escalate if the same `conversation_key` resolves to different raw identities
  across reads (alias instability).

## Authority and safe operator action

- **Authority:** the runtime's disposition (`stop`) is authoritative; do not
  override it with a blind retry.
- **Safe operator action:** correct the destination identity, then re-send —
  never replay against the same unresolved target.
- This class is **notice-INeligible** (`outboundFailureWarrantsUserNotice` is
  `false` for `conversation_not_found`): a notice to the same broken
  destination is a proven no-op, so the runtime stays silent and records
  durable evidence only.
