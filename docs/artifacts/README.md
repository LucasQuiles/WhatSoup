# docs/artifacts/

Historical analysis receipts and archived ledgers, retained for traceability.
This directory holds **non-current** material — it is not a readiness or verdict
source.

## Archived ledgers

The four fixed global ledgers originally written during the April 2026 PR 0a
transport hardening closeout were byte-frozen at their PR 0a commits and claimed
a current readiness verdict without current provenance. Per #2552 they have been
relocated here under a namespaced, dated subdirectory so the top-level
collision-prone fixed paths no longer exist:

- `pr-0a-2026-04-25/error_catalog.md`
- `pr-0a-2026-04-25/error_model.md`
- `pr-0a-2026-04-25/readiness.json`
- `pr-0a-2026-04-25/documentation_devops_readiness.md`

These are **historical PR 0a receipts**, not a statement of current readiness.
The guard at `tests/scripts/artifact-ledger-paths.test.ts` fails closed if any of
them regress to their original top-level `artifacts/` fixed paths.

## Note on this directory

`docs/artifacts/` is a tracked archive surface. The broader `artifacts/` tree at
the repository root is gitignored for runtime output; these historical receipts
are deliberate tracked exceptions, force-added for traceability (matching the
pre-existing tracked status they carried at their original `artifacts/` location).
