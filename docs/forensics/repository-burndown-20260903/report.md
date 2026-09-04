# Forensic Reconstruction

Observation: 2026-09-04T10:04:18Z

## Harness coverage

| family | passes | failed sources | saturation |
|---|---:|---:|---|
| claude | 2 | 0 | unproven (insufficient-passes) |
| codex | 2 | 0 | unproven (insufficient-passes) |
| opencode | 2 | 0 | unproven (insufficient-passes) |

## Conclusions

- C01 [high]: The process-ownership branch was recorded at the exact published revision while its terminal local release proof was still unresolved.
- C02 [high]: The process-lifecycle diagnostics work introduced typed termination outcomes and a dedicated caller-adoption guard.
- C03 [high]: The source-inventory work centralized traversal and represented scan loss as a typed inconclusive outcome instead of silently dropping subtrees.
- C04 [medium]: All three harness adapters completed two hash-bound passes without source failures; marginal new evidence was three, two hundred twenty-nine, and one respectively.
- C05 [medium]: Source inspection rejected at least two lexical candidates as unrelated, demonstrating that candidate retrieval alone is not evidence promotion.

## Chronology

- 2026-09-03T21:19:31Z N01: The process-ownership revision was recorded with a focused green result and a missing terminal full-release result.
- 2026-09-04T02:23:58Z N02: The phase inventory recorded separate process-diagnostics, source-inventory, and repository-state workstreams rather than treating them as one implementation.
- 2026-09-04T09:30:39Z N03: The first complete deterministic retrieval pass began over frozen session sources.
- 2026-09-04T09:44:16Z N04: The second pass over the third harness snapshot completed with one distinct new evidence record and no source failure.
- 2026-09-04T09:53:00Z N05: Selected original records were reopened by hash-bound byte range; useful and false-positive candidates were separated before publication.

## Findings

### lifecycle anomalies

- A01: A focused green result and hosted checks existed before a terminal local release result, so merge readiness remained incomplete at the source observation.

### contradictions

- X01: Two candidates matched the query vocabulary but source context belonged to unrelated guidance or another project; both were rejected.

### negative space

- Z01: No terminal release result was present in the inspected branch summary; this is a bounded retrieval result, not proof that no later run exists.

### copied forward claims

- D01: Repeated verification prose was treated as one narrative lineage until an independent Git object or test receipt corroborated it.

## Unknowns

- U01: The second harness has not reached diminishing returns because its second pass found two hundred twenty-nine distinct records.
- U02: The content relevance of the two second-pass third-harness candidates remains unreviewed.
- U03: The terminal local release outcome was outside the frozen source window.

## Next searches

- S01: Inspect the two retained second-pass third-harness candidates at their immutable row hashes before promoting their content.
- S02: Run a third bounded pass over the second harness because its second-pass marginal yield remains material.
- S03: Attach the terminal local release receipt to the process-ownership conclusion when that run completes.

## Recommendations

- R01: Keep deterministic source adapters, package projection, and privacy enforcement in one shared implementation with a thin command interface.
- R02: Treat retrieved records as candidates until source context and an independent enforcing source support the claim.
- R03: Publish only referenced metadata and aggregate counts; keep raw conversation records in the private hash-bound run.

## Reproduction

The public projection intentionally omits private source locations and query text.
Recreate the hash-bound search receipts from the private source manifest, build into a new directory, then verify the closed manifest:

```text
npm run forensic:reconstruct -- build --spec <private-spec.json> --output <new-directory> --forbidden-terms <private-forbidden-terms.json>
npm run forensic:reconstruct -- verify --package <new-directory> --expected-manifest-sha256 <manifest-sha256> --forbidden-terms <private-forbidden-terms.json>
```
