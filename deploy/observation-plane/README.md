# Observation plane — contract data (shadow v0)

Governed data for the federated observation plane — the shadow-only
convergence layer for fleet probe contracts. Everything here is **data, not code**, read by thin
lockstep readers (Python + TypeScript) and validated by
`scripts/observation-contract-guard.ts`.

| File | Contract |
| --- | --- |
| `envelope.schema.json` | ObservationEnvelope shadow v0 (JSON Schema 2020-12) |
| `claim-catalog.json` | Closed claim catalog: min projection, authority tier, generation binding, claim-specific staleness |
| `outcome-projections.json` | Per-legacy-surface projection tables (total over declared domains; per-row lossiness) |
| `authority-lattice.json` | Evidence ordering policy: authority → context equivalence → generation → freshness |
| `adapter-registry.json` | Closed allowlist of bounded adapters with can/cannot-establish claims |
| `fixtures/valid/*.json` | Golden envelopes that MUST validate |
| `fixtures/invalid/*.json` | Counterexamples that MUST be rejected (each encodes a named register defect) |

Ground rules (from the approved plan; not re-litigated here):

- **Shadow v0, additive-only** until the first pre-registered shadow window
  completes; v1 promotion requires the shadow exit gate approving the exact
  schema digest.
- **Missing evidence is never green and never red.** `public` projection
  supports transport liveness only. Configured values never satisfy observed
  claims. Freshness never outranks context-equal higher-tier evidence.
- **Canonical subject binding**: synthesis joins only on
  `subject.canonical_subject_id`; unresolved aliases never merge.
- **Privacy**: envelopes carry closed classes, bounded labels, and sha256
  digests — never message bodies, absolute paths, JIDs, or tokens.
- **Producers change nothing in shadow.** Projection tables are applied
  read-side; every projected envelope retains the verbatim legacy value.

The plan of record and the failure register live in the operator's private
project records, outside this repository.
