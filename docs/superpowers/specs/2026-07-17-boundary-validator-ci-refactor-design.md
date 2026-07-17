# Boundary Validator CI Refactor Design

**Date:** 2026-07-17
**Status:** active
**Approval:** Architecture approved; written-spec review pending

## Context

PR #1899 passes its local branch gate and fresh CodeQL analysis, but GitHub Actions run
`29590367539` exposed four unmasked failures in the full coverage matrix. Both Node 24
and Node 25 reject two locally defined `isRecord` clones and three newly oversized
TypeScript files. Both versions also show that the pinned generated-index merge fixture
depends on implicit `git merge-tree` conflict messages that Git 2.54 no longer emits by
default. The Node 24 coverage lane additionally exceeds the default ten-second timeout
for one evaluator-receipt test.

The affected files are:

- `scripts/lib/verification/boundary-run-manifest.ts` at 4,642 lines.
- `scripts/verify-boundary-run.ts` at 4,716 lines.
- `tests/scripts/verify-boundary-run.test.ts` at 4,244 lines.

The existing `arch.file-size` identity test deliberately forbids new oversized files.
The repair must therefore reduce each affected TypeScript module below the 2,000-line
ceiling rather than add grandfathering entries or weaken the fitness ring.

## Goals and Invariants

The refactor must preserve the public imports, CLI subcommands, manifest schemas,
attempt IDs, exit codes, evidence layouts, lifecycle precedence, closeout behavior, and
test semantics already implemented on the branch. The original manifest and CLI paths
remain stable compatibility facades. Every extracted TypeScript file must remain below
1,900 lines to leave practical growth headroom beneath the 2,000-line guard.

The repair may change one external command contract: the required merge-preview command
must explicitly request conflict messages. The normalized argv becomes:

```text
git merge-tree --write-tree --messages HEAD origin/main
```

This is a portability correction, not a relaxation. A missing conflict message remains
an inconclusive or failed evidence condition; the helper does not guess paths or fall
back to an unverified merge preview.

No fitness baseline, duplicate-function allowlist, coverage threshold, required check,
or test-integrity requirement is weakened. The preserved owner artifact
`experiment-results.tsv` remains untracked and outside every commit.

## Architecture

### Manifest facade and focused modules

`scripts/lib/verification/boundary-run-manifest.ts` remains the import-compatible facade
for every currently exported constant, type, and function. Its implementation is split
by responsibility under `scripts/lib/verification/boundary-run/`:

- `contracts.ts` owns profile, attempt, child, review, test, evaluator, predecessor, and
  wire-contract constants.
- `model.ts` owns manifest, snapshot, evidence, lifecycle, tool, review, and closeout
  types plus run-init anchor construction.
- `schema.ts` owns exact-key validation, structured-record validation, canonical JSON,
  and final manifest validation.
- `evidence.ts` owns snapshot capture, output admission, tool capability resolution,
  attempt/test/evaluator predicates, child and review joins, and upstream derivation.
- `lifecycle.ts` owns lifecycle verification, immutable-closure verification, and
  closeout-bundle publication.
- `process.ts` owns watchdog and recorded-attempt process execution.

Small shared primitives such as hashing, Git byte capture, issue construction, and exact
record checks live in a single `shared.ts` module. They are internal to this package and
are not reimplemented in downstream modules. The existing facade re-exports the current
public surface so consumers need no import changes.

The exact partition may be subdivided further when a module approaches 1,900 lines, but
responsibilities must not be recombined merely to reduce file count. Circular imports
are prohibited; dependency flow is `shared/model -> contracts -> validators/services ->
facade`.

### CLI facade and command modules

`scripts/verify-boundary-run.ts` remains both the executable entrypoint and the source of
the existing exported CLI API. Command implementations move under
`scripts/lib/verification/boundary-run-cli/`:

- `invocation.ts` owns the command enum, option schemas, and argv parsing.
- `run-store.ts` owns durable run loading, init anchors, stream records, and confined
  file access.
- `attempts.ts` owns command attempts, internal checks, artifacts, and Git transitions.
- `joins.ts` owns review, child, predecessor, and reproduction joins.
- `lifecycle.ts` owns upstream assignment, verdict aggregation, lifecycle mutation,
  finalization, and verification.
- `closeout.ts` owns accepted and rejected closeout workflows and control-closure
  validation.

The top-level file becomes a thin dispatch facade that retains
`BOUNDARY_RUN_COMMANDS`, `BoundaryRunCommand`, `BoundaryRunInvocation`,
`parseBoundaryRunInvocation`, `BOUNDARY_IMPLEMENTED_INTERNAL_CHECKS`,
`BoundaryCloseoutControlClosure`, `validateBoundaryCloseoutControlClosure`, and
`runBoundaryRunCli`. Command modules return the same `BoundaryValidationResult` values
and never write outside their existing derived roots.

### Test registration modules

`tests/scripts/verify-boundary-run.test.ts` remains the single Vitest discovery and
profile-roster path. Shared fixture construction moves to
`tests/scripts/verify-boundary-run/support.ts`. Cohesive case registrars live beside it,
for example `schema-cases.ts`, `attempt-cases.ts`, `join-cases.ts`,
`transition-cases.ts`, and `closeout-cases.ts`.

The discovery file imports and invokes those registrars. Registrar files do not use the
`.test.ts` suffix, preventing duplicate discovery while keeping every existing test name
and assertion active. Shared setup is imported rather than copied. All resulting files
must remain below 1,900 lines.

## Canonical Type Guard

`scripts/lib/semantic-quality/policy.ts` and the extracted boundary modules import
`isRecord` from `src/lib/type-guards.ts`. They do not wrap it, alias a local implementation,
or add an allowlist entry. This satisfies the existing deduplication guard and gives
runtime and verification code the same record predicate.

## Git Merge-Preview Portability

The attempt contract, displayed hardening plan command, and pinned merge fixture all add
the literal `--messages` flag. The fixture continues to require both
`docs/work-index.json` and `docs/work-index.md` conflict identities before exercising the
profile-owned regeneration path. Tests run the exact normalized command and feed its
immutable stdout to the existing parser.

The test asserts semantic evidence—both generated-index conflict paths, a non-clean
preview status, successful profile-owned regeneration, the expected two-parent merge,
and preserved owner-path identity. It does not assert incidental wording beyond the
parser's already supported conflict-message grammar. Git 2.50 locally and Git 2.54 in
GitHub Actions must both satisfy the same contract.

## Timeout Ownership

Only the evaluator-receipt test that exceeded ten seconds under Node 24 coverage receives
a local 30-second Vitest timeout. The suite-wide timeout remains unchanged. Thirty
seconds is bounded, remains far below the workflow timeout, and is at least three times
the observed threshold without converting a hang into a pass. The test still executes
the full holdout-oracle and frozen-score assertions; no work is skipped or mocked.

## Error Handling and Safety

Extracted functions preserve existing issue codes, direct statuses, and fail-closed
behavior. Invalid command ownership, path confinement failures, malformed manifests,
unexpected Git output, missing evidence, child/review relation failures, watchdog
timeouts, and closeout substitution remain non-pass outcomes. Module boundaries do not
introduce catch-all fallbacks or ambient-environment inheritance.

Each extraction follows `extract -> redirect -> delete`. A compatibility re-export is
removed only after reference scans and typechecks prove that no consumer depends on the
old internal location. No branch history is rewritten, and the accepted recovery branch
or owner artifact is never deleted during this repair.

## Test Strategy

The existing failed CI assertions are the structural RED baseline. Additional focused
RED tests first pin the explicit `--messages` attempt argv and the single-test timeout
contract before production changes.

Each extraction bead must then pass:

1. `npm test -- tests/scripts/dedup-reaccumulation-guard.test.ts
   tests/scripts/fitness-file-size-warning-budget.test.ts
   tests/scripts/verify-boundary-run.test.ts --pool=forks`
2. `npm run typecheck:scripts`
3. `npm run typecheck:all`
4. `git diff --check`

After all beads, run the unfiltered coverage command used by CI, the complete branch
verification gate, and the non-bypassable pre-push hook. A fresh PR head must then pass
Node 24 quality, Node 25 quality, macOS bot health, all three CodeQL language analyses,
and the GitHub CodeQL aggregate before merge.

Masked failures, skipped required work, stale-head checks, or locally passing results
from an older commit are inconclusive. The PR remains unmergeable until every current-head
required result is terminal and green.

## Commit and Rollback Strategy

The work is committed in reviewable behavior-preserving beads: canonical type-guard
reuse, manifest extraction, CLI extraction, test extraction, Git portability, and bounded
timeout verification. If an extraction changes behavior or reduces the passing baseline,
that bead is corrected before the next one; later changes are not stacked on a broken
intermediate state.

The recovery branch is pushed only after the full local gate passes. If `origin/main`
advances again, the branch incorporates it through an ordinary merge commit, reruns the
complete gate, and obtains fresh PR checks. Integration uses a merge commit, keeps the
remote branch intact, and is followed by exact ancestor, parent, tree, and remote-main
verification.

## Alternatives Rejected

- Adding the three files to the grandfathered size identity set would weaken a guard
  specifically intended to reject this change shape.
- Adding `isRecord` exceptions would restore known duplicate implementations and defeat
  the existing SSOT contract.
- Raising global test timeouts would mask unrelated hangs.
- Relaxing conflict-message checks or accepting a tree OID alone would permit a merge
  preview without proof of the generated-index conflicts the special transition is
  authorized to resolve.
- Reverting the boundary validator would discard the recovered evidence and contract work
  instead of making it maintainable.

## Non-Goals

- General cleanup of the repository's 207 pre-existing fitness warnings.
- Promotion of semantic export-ownership warnings or design-system shadow findings.
- Changes to boundary receipt schemas, lifecycle precedence, or closeout semantics.
- Post-merge swarm-rule mining before PR #1899 is merged and verified on `origin/main`.
