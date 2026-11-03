---
type: Spec
status: active
---

# Correlation after ambiguous outbound exhaustion

Issue: [#3840](https://github.com/LucasQuiles/WhatSoup/issues/3840).

The agent queue keeps a stable requested message ID across retries but omits it
when ordinary ambiguous retries exhaust. A later echo cannot match that operation
unless a provider receipt was already recorded. Shutdown currently stores the
requested ID even on transports that ignore it.

## Scope and approach

Add an optional, read-only `Messenger.requestedIdIsProviderId` declaration. Only
the current WhatsApp connection declares `true`: it passes the requested ID through to
Baileys as the message key. Absence or `false` means unknown equivalence. This is
an identity declaration, not a receiver-deduplication or delivery guarantee.

The queue contract applies to every transport. SMS, iMessage and Signal use their
existing adapters and retain their actual provider IDs on successful sends;
ambiguous failure must not substitute a generated client ID for an unknown
provider ID. A future transport may opt in after proving equivalence. No queue
branch selects a provider by name. These transports are near-term qualification
targets, not deferred product scope.

After an ambiguous exhaustion or shutdown, retain the requested ID only when
that declaration is exactly `true`. Reuse `markMaybeSent` and the existing echo
and stored-message reconciliation paths. Successful sends continue to store the
actual returned provider ID. Deterministic non-sends retain their current state.

Alternatives considered:

- Persist every requested ID: rejected because three bridges ignore the option.
- Persist at claim time: deferred; it expands crash-time semantics and the
  meaning of an ID on a never-submitted operation.
- Keep the current behavior: avoids a new declaration but loses a known matching
  key and retains misleading shutdown keys on other transports.

The selected approach is a narrow correction to post-failure evidence. No schema,
retry policy, deadline, recovery timer or historical-row migration changes.
Generic scoped echo identity is tracked separately in #3841; queue deadline
measurement is tracked in #3842. Existing no-ID-only operator actions remain
inapplicable when a valid correlation ID exists; retaining identity does not
waive their preconditions or permit automatic resend.

## Acceptance

Use the real outbound queue and SQLite durability engine with a controlled
external send boundary. Before the repair, late echo after exhaustion must fail
to match. After it, a transport declaring ID equivalence retains the key and
settles on a matching echo without another send. Also cover an earlier stored
echo, unknown/false declarations, shutdown, provider-returned ID, deterministic
non-send, and post-quarantine echo. Keep ambiguous replay unsafe.

Exercise the real SMS, iMessage and Signal bridges and adapters through the
same queue and database, with only their external provider ports controlled.
For each, check exhaustion, shutdown and actual successful receipts. This
matrix establishes local contract behavior; operational qualification still
needs each backend's authentication, ingress, recovery and delivery evidence.

The WhatsApp connection must pass a supplied key to its socket and return the
socket's actual receipt. The test does not prove server deduplication. A crash
before the post-failure write remains an explicit limitation. Rollback removes
the declaration and queue change without deleting any retained delivery evidence.

## Existing work and dependencies

This specification adapts the current queue; it does not replace the transport
contract or reopen completed implementation plans. Source at
`26e44cc8bd72e7c1b209edbada6291e07ed77f03` is the implementation baseline.

| Existing record | Relationship and evidence boundary |
| --- | --- |
| [Transport-layer design](2026-04-25-transport-layer-design.md) and [contract foundation plan](../plans/2026-04-25-pr-0a-transport-contract-foundation.md) | Historical design and shipped contract reference. Reuse `MessageRef`, capability declarations and provider ports. The broader design's proposed schema and migration are not proof that those changes shipped. |
| [SMS plan](../plans/2026-06-10-twilio-sms-transport.md) and [voice/webhook plan](../plans/2026-06-11-twilio-voice-webhook.md) | Existing implementation history; do not create replacement adapters. Current operation belongs to the runbooks below. |
| [SMS runbook](../../runbooks/twilio-transport.md), [iMessage runbook](../../runbooks/imessage-transport.md), [Signal runbook](../../runbooks/signal-transport.md) | Backend prerequisites, supported operations and qualification constraints. Local correlation tests do not attest credentials, provider versions or live delivery. |
| [Durability](../../durability.md) and [ambiguous-send runbook](../../runbooks/transport-error-send-ambiguous.md) | Existing recovery and operator restrictions remain authoritative. Receipt, echo and delivery are separate evidence. |
| [Governor plan](../plans/2026-07-09-outbound-governor-and-flood-observability.md), #3842 and #2646 | Total queue-residence deadlines were already specified. Reconcile actual caller/adapter paths before implementing that requirement; reservation bounds alone do not close it. |
| [Quiescence design](2026-08-14-outbound-queue-quiescence-containment-design.md) and #3826 | Adjacent shutdown, admission and finalization work. Preserve its invariants and review overlap; this patch adds no teardown or finalization policy. |
| #3841 | Next scoped-identity investigation, including the single-pending-operation/wrong-conversation echo counterexample. Broader support requires evidence for old IDs, provider-native reply/reaction targets and rollback. |

The [current program](../../current-program.md) and generated
[work index](../../work-index.md) provide navigation; GitHub owns current issue
and PR status. Historical completion labels do not establish deployment.
