---
type: Spec
status: active
---

# Completed-turn identity across transports

Tracking: #3844. This slice extends the existing terminal/checkpoint identity
contract to SMS, Signal and direct iMessage addresses. It does not introduce a
delivery status or authorize a deployment.

## Demonstrated problem

At base `26e44cc8bd72e7c1b209edbada6291e07ed77f03`, transport bridges and ingest
preserve non-WhatsApp delivery JIDs, but terminal finalization and checkpoint resume
use a WhatsApp-only parser. A real Signal bridge, ingest, agent runtime, outbound
queue and SQLite witness reaches provider execution and then cannot persist its
terminal. Shutdown retains an unresolved finalization. The provider process and I/O
port are controlled test boundaries, not live service measurements.

Late-echo promotion also extracted the namespace after the first `@`, which cannot
represent an AppleID email followed by `@imessage`.

## Existing ownership and scope

Reuse the [transport foundation](2026-04-25-transport-layer-design.md), canonical
builders and address validators in `src/core/jid-constants.ts` and
`src/core/transport-refs.ts`, and the [durability contract](../../durability.md).
The historical foundation describes ambitions beyond current implementation; it is
not deployment evidence. Preserve #3803's late-echo witness conditions and #3826's
queued-finalization ownership. #3843 separately owns ambiguous-send correlation;
#3841 owns provider evidence/recovery qualification; #3842 owns deadline measurement.

Group lifecycle is separately tracked in #3666, including the retained work from
#3530 and the lazy-adoption behavior landed by #3646. This slice preserves today's
Signal group startup exclusion and checkpoint ending. It does not implement the
different retention policy proposed in #3666. Contact-approval group routing in
#3566 is another adjacent owner, not a reason to widen authorization here.

## Contract

- Keep WhatsApp PN/LID/group acceptance unchanged.
- Validate canonical E.164 SMS addresses; Signal E.164, service UUID and group
  addresses; iMessage E.164 and canonical AppleID emails. Reject unknown suffixes,
  malformed addresses, hidden control characters and normalization-dependent input.
- Parse the final transport suffix without changing the existing conversation key.
  Never infer transport/account identity for old rows or normalize them in place.
- Terminal and resume readers use one parser. Resume still requires an exact
  conversation-key round trip and a complete owner tuple.
- Late-echo checkpoint promotion binds the namespace derived from its exact recovery
  witness, inside the existing transaction. Wrong chat, conflicting op, changed
  session, active/newer turn and incomplete proof must retain their existing behavior.
- Provider acceptance remains distinct from stored echo and turn completion.
- Migration 67 only advances the supported data contract in the migration ledger.
  Existing future-schema rejection prevents ceiling-66 writers from opening it.
  The changed schema version also invalidates D5 capability attestation bindings;
  rollout must requalify them through the existing attestation procedure.

Account identity remains an instance/database boundary. This does not add a channel
column or enable several accounts to share a database. A configuration/account
change against an existing database requires separate provenance and recovery
qualification. No host or provider backend is attested by local fixtures.

## Deferred chat GUIDs

Current `isGroupJid` recognizes WhatsApp and Signal groups, but not iMessage groups.
The iMessage adapter recognizes `iMessage;+;` groups; some port/recipient comments
describe `iMessage;-;` as a group form while the runbook and adapter describe a DM
form. A broadened parser experiment allowed a `;+;` fixture to resume proactively,
bypassing the intended group exclusion. That experiment is not a deployed incident.

Keep both chat-GUID forms outside this slice. Before enabling them, reconcile the
provider-specific envelope semantics, shared group classification, proactive/lazy
resume, membership and sender-policy consumers. A fixture must prove no unsolicited
startup turn and correct next-inbound admission. Reuse #3666 where its ownership
overlaps; do not create a competing group-lifecycle controller.

## Qualification and alternatives

The composed suite covers policy silence and delayed echo across six address classes,
then runtime shutdown/start: direct identities resume their exact saved session;
Signal groups retain the existing exclusion. SQLite, ingestion, adapters, bridges,
queues and finalization are real; access/configuration, external process/I/O and
filesystem services use the existing test harness doubles. Runtime reconstruction
on the same test database is not a process-kill test. SMS polling echo fixtures do
not qualify webhook-only completion; backend echo availability remains #3841.

Malformed and cross-namespace resume cases, existing terminal hardening, exact
late-echo witnesses and schema rejection must pass. A compatible old reader must
refuse the migrated file without modifying it. Restoring the WhatsApp-only parser
must make the composed transport test fail again.

Doing nothing preserves blocked completion. Relaxing only a suffix check leaves
resume and email late-echo inconsistent. A new identity graph or historical rewrite
adds unnecessary migration and ownership costs. Adapting the existing contract is
the smallest useful slice, with the cost of a forward compatibility fence and
transport-specific qualification. Merge and rollout remain separate decisions.

Rollback uses a reviewed pre-migration snapshot and compatible binary, accounting
for later external effects. Removing the migration marker is not a rollback route.
