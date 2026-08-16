# ADR: Memory-consolidation source lifecycle SSOT (QR-004)

- **Status: PROPOSED — owner sign-off required before any schema lands.**
- Resolves: the QR-003/QR-004 design gate inherited from epic #1445, re-raised by #2569.
- Deciders: repository owner (this document proposes; it does not decide).
- Related: #2569 (source lifecycle/lineage), #2567 (opaque fact identifiers), #2568 (run receipts — landed), #2447 (shared taxonomy).

## Context

Automated memory consolidation is promote-only. The scheduler's Pinecone
dependency (`ConsolidationPinecone` in `src/memory/consolidation-cron.ts`)
exposes only `searchDetailed` and `upsert`: it cannot claim sources, record
dispositions, supersede or retire records, or prove a promotion is new.
Durable identity is a hash of scope plus model-generated claim wording, so
wording drift mints a new durable record for the same sources while identical
wording silently overwrites. Discarded sources carry no durable disposition and
are re-sent to the model every run.

QR-004 requires choosing where the source lifecycle state machine lives before
implementing it. Two branches were named:

1. **Substrate-owned lifecycle** — extend `src/core/substrate/` (SQLite
   `entities` / `entity_observations` / `beads`) to model consolidation
   sources and promotion edges as substrate observations.
2. **Dedicated consolidation ledger** — new SQLite tables owned by the memory
   consolidation domain (following the `database-migration-NN.ts` pattern),
   holding source state, leases/fences, dispositions, and promotion edges.

Both branches converge on the same structural fact: **SQLite must be the
source of truth and Pinecone a derived index**, because Pinecone's write
surface is upsert-by-id only — it cannot express compare-and-set transitions,
leases, or atomic dispositions, which contract items 2 and 9 of #2569 require.

## Proposal (pending owner decision)

Adopt branch 2, the **dedicated consolidation ledger**:

- `memory_consolidation_sources` — source_id (opaque), scope, typed state
  (`eligible | claimed | deferred | promoted | discarded | superseded |
  expired | quarantined | legacy`), policy_version, lease owner/fence/expiry,
  disposition, lineage_id.
- `memory_consolidation_promotions` — promotion edges: lineage_id (derived
  from canonical source-set identity + policy/schema version, never claim
  wording), derivation variant, per-source edges.

Rationale for the ledger over substrate ownership:

- The proven in-repo template is `src/core/turn-recovery-store.ts` — typed
  job states (`blocked_unsafe | pending | claimed | completed | exhausted`),
  claim and assignment fences with epochs, and CAS transitions via
  `WHERE state = …` guards. (`quarantined` there is an outbound delivery
  status, not a job state; the consolidation ledger proposes it as a true
  lifecycle state.) The ledger reuses this pattern directly; substrate tables
  would need reshaping to express leases/fences.
- Substrate entities model *observed conversational facts*; consolidation
  sources are *pipeline work items* with lifecycle semantics closer to the
  turn-recovery queue than to entities. Coupling the two mixes domains.
- A dedicated ledger keeps the #2567 opaque-identifier migration a
  consolidation-domain concern instead of a substrate schema change.

Consequences if adopted:

- Pinecone remains write-behind: every durable write is derived from ledger
  state; ledger reconciliation (saga phases, crash windows) is testable
  entirely through the existing `ConsolidationPinecone` fake seam with no
  live credentials.
- Existing `durable:` records and `consolidated`-qualified records are
  classified `legacy`: never source-eligible by default, migrated only under
  an explicit versioned policy (acceptance n of #2569).
- The slice plan in #2569 proceeds: schema car, paged eligibility reader,
  lease + lineage identity, promotion/disposition saga.

## What this ADR deliberately does not do

No schema, migration, or behavior change lands with this document. The store
choice is the owner's; this ADR exists so the decision has a concrete,
evidence-grounded artifact to approve, amend, or reject.
