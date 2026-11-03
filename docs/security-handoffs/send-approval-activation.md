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

## Open activation requirements

1. Deploy and independently verify the protected authority service contract,
   including immutable operation snapshots, account pause generation, review
   decisions from authenticated human ingress, dispatch receipts, and inbound
   lease close semantics. The Agent365 service is a required dependency.
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
5. Keep authority activation refused until all requirements above have
   independently demonstrated the desired behavior. The refusal is intentional
   and must not be weakened to make a pilot appear available.

## Acceptance evidence

Use an isolated lockfile-compatible dependency installation, the pinned Node
runtime, injected fake authority clients, and fake provider sockets. The
acceptance suite must show both that approved capability paths work and that
unapproved, malformed, replayed, paused, raw, and missing-dependency paths
produce zero provider submissions.

No acceptance test may send a real message, contact a third party, read a real
credential, or deploy a service. A production activation requires a separate
owner decision after the protected authority dependency and host-specific
isolation evidence are complete.
