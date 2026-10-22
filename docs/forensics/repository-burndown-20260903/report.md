# Forensic Reconstruction

Observation: 2026-09-04T10:04:18Z

## Harness coverage

| family | passes | failed sources | saturation |
|---|---:|---:|---|
| claude | 2 | 0 | unproven (insufficient-passes) |
| codex | 2 | 0 | unproven (insufficient-passes) |
| opencode | 2 | 0 | unproven (insufficient-passes) |

## Conclusions

- C01 [high]: The process-ownership commit kept service-cgroup membership observational and required every current process-group member to match a confirmed provider-session identity before group signaling.
- C02 [high]: The process-lifecycle diagnostics commit added typed termination error codes, retry classes, canonical diagnostic sources, and a dedicated guard for caller adoption.
- C03 [high]: The source-inventory work centralized traversal and represented scan loss as a typed inconclusive outcome instead of silently dropping subtrees.
- C04 [medium]: The six retained search receipts declare two hash-bound passes per harness that ran to completion and zero source failures. Their retained record hashes reproduce second-pass new-record counts of 3, 229 and 1. Source completeness, independent evidential value of those records, and saturation remain unverified.
- C05 [medium]: The retained query assessments classify two distinct retrieved records as false positives, demonstrating that recorded candidate retrieval and recorded promotion decisions are separate. Their underlying relevance was not independently re-adjudicated in this review.

## Chronology

- 2026-09-03T21:19:31Z N01: The process-ownership revision kept service-cgroup membership observational and added a confirmed-ownership check for process-group signaling.
- 2026-09-04T02:23:58Z N02: The phase inventory recorded separate process-diagnostics, source-inventory, and repository-state workstreams rather than treating them as one implementation.
- 2026-09-04T09:30:39Z N03: The first deterministic retrieval pass began over frozen session sources.
- 2026-09-04T09:44:16Z N04: The second pass over the third harness snapshot ran to completion, declaring one distinct new record and no source failure; completeness of that snapshot is unverified.
- 2026-09-04T09:53:00Z N05: The retained query assessments record that selected original records were reopened by hash-bound byte range and that useful and false-positive candidates were separated before publication; that context inspection was not independently re-adjudicated.

## Findings

### lifecycle anomalies

- A01: Historical summaries report focused and hosted checks; their timing, terminal local release status, and merge readiness remain unverified against original validation receipts.

### contradictions

- X01: Two candidates matched the query vocabulary; the recorded assessment classified their source context as unrelated guidance or another project and rejected both. Their underlying relevance was not independently re-adjudicated.

### negative space

- Z01: The retained branch narrative reports no terminal release result, but the cited evidence does not establish whether a result existed at that observation or in a later run.

### copied forward claims

- D01: The repeated verification prose is retained as one narrative lineage. The cited Git object supports the code change; it does not independently establish publication or validation chronology.

## Unknowns

- U01: Diminishing returns for the second harness are not established: its second pass found 229 distinct records, and their independent evidential value is unadjudicated.
- U02: The content relevance of the two second-pass third-harness candidates remains unreviewed.
- U03: Publication timing and terminal local release status for the process-ownership revision remain unknown without original remote and validation receipts tied to that revision.

## Next searches

- S01: Inspect the two retained second-pass third-harness candidates at their immutable row hashes before promoting their content.
- S02: Run a third bounded pass over the second harness because its second pass added 229 distinct records; whether that yield is material independent evidence is unverified.
- S03: Locate the original publication and terminal local release receipts for the process-ownership revision, bind their timestamps and revision identifiers, and resolve the corresponding unknowns before promoting those claims.

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
