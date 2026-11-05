# Send-approval activation handoff

Status: blocked pending platform-specific qualification.

`transportAuthority.enabled` is deliberately refused by the current shared
validator. The final transport seam and protected-operation client are
implemented for fake-provider verification, but that source state is not an
authorization to activate, deploy, or send a message.

## Current boundary

When configured, the final Baileys `sendMessage` seam uses the operation
authority after content redaction and attachment-byte freezing. It registers
trusted inbound events before conversational queueing, derives automatic reply
destinations from the active authenticated inbound turn, and stages unbound
outgoing work for review. Missing authority wiring, malformed authority data,
or an unavailable protected credential client blocks the provider call.

The authority service, not the agent, owns review challenges, human decisions,
pause state, dispatch transitions, and provider-effect receipts. Agents never
receive a reusable authority bearer or approval endpoint.

The enabled final seam gives pacing and admission one 30-second send budget.
Expired admission cannot start a provider call. A provider call already in
flight has an unknown outcome on timeout; its late result cannot automatically
overwrite that hold. Outbound echoes retain normal storage and correlation but
never establish human approval context. Direct startup configuration now uses
the same activation admission as the instance loader and fleet mutations.

The final seam accepts only the implemented text and frozen-media semantics.
Unsupported controls, raw structures, and audience-changing provider options
require a semantic adapter even when an explicit operation is present. An
ambiguous provider result cannot enter the media or status helper's local
retry loop. Failure to record the unknown receipt preserves that same hold.

Signal, iMessage, and SMS bridges report synchronous conversion/handler failures
and asynchronous handler rejections through their local structured logger.
They do not replay the inbound message after a handler failure.

Queued turns retain the inbound context captured at admission through processing,
error finalization, and settlement. Outbound chunks and buffered updates retain
their own immutable context. Batching separates different inbound events and
approved operations; an unbound item explicitly clears ambient authority. These
queue checks do not establish provider callback ownership or platform isolation.
Publishing queued work transfers completion ownership while retaining the ingest
slot until queue admission or local handling finishes. Single-session mode releases
that slot at the provider boundary, after publishing its exact turn-completion
owner; the serialized chain still waits for that turn. Followers waiting behind
it consume bounded ingest capacity. A dispatched turn retains its inbound lease
until the existing terminal finalizer settles, including single-session provider
failure. A rejected admission finalizer retains completion.
Single-session shutdown joins undispatched-turn finalization before releasing
the inbound completion when no provider boundary was reached.
If that finalization exhausts recovery, its context and inbound completion remain
owned by the coordinator; the outer handler cannot substitute a legacy failed-row
write or close the lease.
Admission rejection and shutdown finalize durable state before releasing inbound
authority. Detached turns retain their original queue ownership through finalization
or retained recovery; another queue cannot reuse them before settlement. Reentrant
settlement is rejected. A failed processor finalizer or thrown finalization retains
the inbound completion; the existing degraded-scope contract requires operator
recovery or restart.

This bounds waiting between ingest admission and runtime admission, not all
registered leases or provider work. Registration RPCs and approved automation
run before ingest; their capacity and ambiguous-close recovery remain unqualified.
Existing ingest overflow selection is unchanged: displaced messages are neither
stored nor dispatched. Protected control-message routing, overlapping duplicate
close ownership, and cancellation before the single-session provider boundary
still require separate end-to-end qualification. No fleet activation follows
from the controlled runtime tests.

Controlled single-session tests also cover rejection before the provider boundary,
including evidence-publication errors. The immutable turn context retains inbound
authority through durable finalization; a failed terminal write retains that
authority and reports unresolved shutdown. Successful finalization clears the
turn's activity state before another command can use the session.
After a provider rejection, the single-session turn chain also waits for that
turn's completion before admitting a following turn. A controlled interleaving
test holds evidence finalization and verifies that the follower cannot enter the
runtime until the predecessor settles; both inbound leases then close once.

Session-scoped provider events without verified turn identity remain unbound and
enter human review. Verified per-turn callbacks retain their admitted context;
stale callbacks cannot acquire a later turn's authority. Aggregated voice replies
also enter review because their text accumulator does not retain per-fragment
provenance. The complete frozen audio remains available for exact approval.

File reviews direct the human to the configured Agent365 Desk before rendering
any binary content. These cards contain no inline approval command. The client
accepts payload-free media projections only in review responses; dispatch still
requires the complete frozen payload. Older authority responses containing
binary data also take the Desk path. The client reads authority expiry times in
milliseconds and retains compatibility with existing string expiry values.

While the protected connection is open, a serial dispatcher collects at most
100 approved operation references, then reads one frozen payload at a time.
Desk approval therefore needs no second chat command. Discovery never claims an
operation: the existing final socket gate checks its exact payload, current
approval and account state immediately before submission. Competing consumers
cannot claim the same operation twice. Close, shutdown and every reconnect
cancel discovery and prevent late admission from starting a provider call.
Authority wiring is permitted only before connection startup, so discovery and
the socket gate cannot use different authority clients.
An unavailable authority holds work and logs the error; it never enables a
fallback send. Already submitted calls retain the existing unknown-outcome rules.
If error reporting itself throws, the dispatcher stops and emits the fixed
`TRANSPORT_DISPATCH_REPORTING_FAILED` process warning. Investigate the reporting
failure before reconnecting or restarting the dispatcher.

## Open activation requirements

1. Deploy and independently verify the protected authority service contract,
   including immutable operation snapshots, account pause generation, review
   decisions from authenticated human ingress, dispatch receipts, and inbound
   lease close semantics. The Agent365 service is a required dependency.
   Qualify overlapping duplicate deliveries: a duplicate callback must not close
   another delivery's active reply lease. Event deduplication and completion
   ownership require separate proof.
2. Prove that every production send route converges at an equivalent final
   authority seam, including provider options that affect audience. A raw route
   without a semantic adapter remains held instead of receiving an opaque
   approval.
3. Prove identity separation, protected credential ownership, descendant
   process control, and kernel-enforced egress limits for the actual pilot host.
   The agent process must not read, mint, or inherit the authority credential.
4. The current launcher prototype is Linux-specific. It does **not** qualify a
   macOS pilot. Before a macOS pilot, provide and test a supported macOS-native
   isolation and lifecycle mechanism with distinct service and worker
   identities, protected credential paths, process cleanup, and raw-egress
   confinement. Do not treat a Linux source review or Linux canary as macOS
   qualification.
   The Linux prototype policy is nonsecret configuration installed as root
   with the controller's primary group and mode `0640`. This permits the
   controller to verify its pinned digest without granting either runtime
   identity write access. The Linux CI fixture checks real ownership and
   group permissions in a network-disabled container; it does not qualify
   the setuid launcher, descendant cleanup, or a production host.
   The C launcher also checks the selected provider file and its ancestors for
   root ownership and safe modes before dropping identity. Its policy contains
   paths, not provider digests; TypeScript's normal launch path separately pins
   the digest. The fixture exercises the actual C validator without executing
   the privileged launcher or a provider.
5. Keep authority activation refused until all requirements above have
   independently demonstrated the desired behavior. The refusal is intentional
   and must not be weakened to make a pilot appear available.
6. Qualify large-media request and review parity on the installed packages.
   WhatSoup's existing media limit is 50 MiB. The matching authority must accept
   that frozen payload through its bounded request parser and provide exact
   downloads in Desk, while keeping binary data out of transport review cards.
   Verify the Desk decision through the installed transport dispatcher and final
   gate with a fake provider, not just a direct admission request.
   Source tests do not establish installed parity. Rejected operations must
   remain visible and must never be truncated or submitted without review.

## Acceptance evidence

Use an isolated lockfile-compatible dependency installation, the pinned Node
runtime, injected fake authority clients, and fake provider sockets. The
acceptance suite must show both that approved capability paths work and that
unapproved, malformed, replayed, paused, raw, and missing-dependency paths
produce zero provider submissions.

No acceptance test may send a real message, contact a third party, read a real
credential, or deploy a service. Production activation requires owner authority
and complete protected-service and host-specific isolation evidence. An existing
owner deployment instruction satisfies authorization, but cannot replace that
technical evidence.
