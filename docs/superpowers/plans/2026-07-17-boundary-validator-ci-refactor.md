# Boundary Validator CI Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR #1899 pass the unfiltered Node 24 and Node 25 quality matrices without weakening duplicate, file-size, coverage, security, or evidence-contract gates.

**Architecture:** Preserve `scripts/lib/verification/boundary-run-manifest.ts` and `scripts/verify-boundary-run.ts` as stable facades while extracting cohesive implementation modules below 1,900 lines. Preserve the single Vitest discovery path through registrar modules, reuse the canonical record predicate, and make merge-preview evidence explicit across Git 2.50 and Git 2.54.

**Tech Stack:** TypeScript, Node.js 24.15.0 and 25.x, Vitest 4, Git `merge-tree`, repository publication/work-index guards, GitHub Actions quality and CodeQL checks.

## Global Constraints

- Do not add any affected file to `.claude/fitness/baseline.json` or `EXPECTED_FILE_SIZE_WARNING_FILES`.
- Do not add any `isRecord` clone to `KNOWN_CLONES`; import `isRecord` from `src/lib/type-guards.ts`.
- Keep every newly extracted TypeScript file below 1,900 newline characters and every existing affected facade below 1,900.
- Preserve current public exports, CLI subcommands, issue codes, exit codes, manifest schemas, evidence paths, lifecycle precedence, and closeout behavior.
- The merge-preview argv is exactly `git merge-tree --write-tree --messages HEAD origin/main`.
- Only the holdout-oracle receipt test receives a local `30_000` millisecond timeout; do not raise global timeouts.
- Never stage, modify, delete, or commit `experiment-results.tsv`; its expected SHA-256 is `f93e0c1b42bc10fc8f8a2488d0efe7a12f671088e00f31bf772161d8bd15e9a3`.
- Use the repository-pinned Node wrappers for npm commands.
- Treat skipped, masked, stale-head, or partial checks as Inconclusive.
- Execute lead-only in this session because no verified live-catalog selector receipt is available for process or subagent lanes.

---

### Task 1: Canonical record predicate, explicit merge messages, and bounded test timeout

**Files:**
- Modify: `scripts/lib/semantic-quality/policy.ts`
- Modify: `scripts/lib/verification/boundary-run-manifest.ts`
- Modify: `tests/scripts/verify-boundary-run.test.ts`
- Modify: `docs/superpowers/plans/2026-07-16-boundary-contract-feedback-hardening.md`
- Regenerate: `docs/work-index.json`
- Regenerate: `docs/work-index.md`

**Interfaces:**
- Consumes: `isRecord(value: unknown): value is Record<string, unknown>` from `src/lib/type-guards.ts`.
- Produces: `RUN_ATTEMPT_CONTRACTS['merge-preview'].argv` equal to the exact six-element Git argv and a 30-second timeout owned only by the holdout receipt test.

- [ ] **Step 1: Add a failing exact-argv assertion**

Add this assertion beside the existing attempt-contract coverage in
`tests/scripts/verify-boundary-run.test.ts`:

```ts
expect(boundaryRun.RUN_ATTEMPT_CONTRACTS['merge-preview']?.argv).toEqual([
  'git',
  'merge-tree',
  '--write-tree',
  '--messages',
  'HEAD',
  'origin/main',
]);
```

- [ ] **Step 2: Run the portability assertion and verify RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/verify-boundary-run.test.ts --run
```

Expected: FAIL because the current argv omits `--messages`.

- [ ] **Step 3: Reuse the canonical record predicate**

Add this import in both implementation modules and delete their local `function
isRecord` declarations:

```ts
import { isRecord } from '../../../src/lib/type-guards.ts';
```

For `scripts/lib/semantic-quality/policy.ts`, use its correct relative path:

```ts
import { isRecord } from '../../../src/lib/type-guards.ts';
```

For `scripts/lib/verification/boundary-run-manifest.ts`, the same relative path resolves
from `scripts/lib/verification/` to `src/lib/type-guards.ts`.

- [ ] **Step 4: Make the merge-preview contract explicit**

Change the contract to:

```ts
['merge-preview', commandContract([
  'git',
  'merge-tree',
  '--write-tree',
  '--messages',
  'HEAD',
  'origin/main',
], {
  expectedExit: '0,1',
  stdoutPredicate: 'merge-preview',
})],
```

Change the pinned fixture's direct invocation to the same normalized arguments:

```ts
execFileSync(
  'git',
  ['merge-tree', '--write-tree', '--messages', beforeHead, pinnedParent],
  {
    cwd: clone,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
```

Update the displayed observation command in the hardening plan to include the literal
`--messages` flag.

- [ ] **Step 5: Bound the one measured slow test**

Terminate the `binds every candidate receipt to the exact holdout oracle and frozen
score` test with a local timeout:

```ts
  }, 30_000);
```

Do not modify Vitest's global timeout.

- [ ] **Step 6: Regenerate documentation metadata**

Run:

```bash
npm run work-index:regen
npm run guard:work-index
npm run guard:publication:all
npm run guard:doc-tally
```

Expected: all four commands exit zero; the work index remains internally consistent.

- [ ] **Step 7: Verify GREEN for portability and deduplication**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/dedup-reaccumulation-guard.test.ts \
  tests/scripts/verify-boundary-run.test.ts \
  --pool=forks --fileParallelism=false
npm run typecheck:scripts
npm run typecheck:all
git diff --check
```

Expected: the two focused test files, both typechecks, and diff validation pass. The
file-size identity test remains RED until Tasks 2-5 complete.

- [ ] **Step 8: Commit the independently reviewable fix**

```bash
git add scripts/lib/semantic-quality/policy.ts \
  scripts/lib/verification/boundary-run-manifest.ts \
  tests/scripts/verify-boundary-run.test.ts \
  docs/superpowers/plans/2026-07-16-boundary-contract-feedback-hardening.md \
  docs/work-index.json docs/work-index.md
git commit -m "fix(quality): make boundary merge evidence portable"
```

Expected: hooks pass and the commit contains no owner artifact.

---

### Task 2: Extract manifest contracts, types, and shared primitives

**Files:**
- Create: `scripts/lib/verification/boundary-run/contracts.ts`
- Create: `scripts/lib/verification/boundary-run/model.ts`
- Create: `scripts/lib/verification/boundary-run/shared.ts`
- Modify: `scripts/lib/verification/boundary-run-manifest.ts`
- Test: `tests/scripts/verify-boundary-run.test.ts`

**Interfaces:**
- Consumes: canonical `isRecord`, Node crypto/fs/path/process APIs, and the existing literal contract tables.
- Produces: all existing profile, attempt, child, review, test, evaluator, predecessor, wire-schema, manifest-model, and init-anchor exports through the original facade.

- [ ] **Step 1: Record the public export baseline**

Run:

```bash
rg -n '^export (const|type|interface|function|async function)' \
  scripts/lib/verification/boundary-run-manifest.ts
```

Save the command output in the task transcript. It is the public-surface oracle; every
listed name must still import from the original path after extraction.

- [ ] **Step 2: Create the model module**

Move the complete declarations for `BOUNDARY_RUN_SCHEMA`, every exported
`Boundary*` type/interface through `BoundaryRunManifest`, `BoundaryRunInitAnchor`, and
`createBoundaryRunInitAnchor` into `model.ts`. Keep declaration bodies unchanged. Start
the module with only the Node/type imports its moved declarations require.

The facade must re-export them with:

```ts
export * from './boundary-run/model.ts';
```

- [ ] **Step 3: Create the contracts module**

Move these complete constant families and their private builders into `contracts.ts`:

```text
RUN_CONTRACT_PROFILES
RUN_CHILD_CONTRACTS
RUN_SOURCE_REVIEW_CONTRACTS
RUN_ATTEMPT_CONTRACTS
RUN_TEST_CONTRACTS
RUN_VITEST_PREDICATES
RUN_EVAL_CONTRACTS
BOUNDARY_SUPPORTED_RESULT_PREDICATES
RUN_PREDECESSOR_CONTRACTS
RUN_WIRE_SCHEMAS
BOUNDARY_PINNED_GENERATED_INDEX_PARENT
```

Also move `boundaryTestFilesForProfile`. Export through the facade:

```ts
export * from './boundary-run/contracts.ts';
```

- [ ] **Step 4: Create shared primitives without expanding the public API**

Move these private helpers to `shared.ts` and export them only for sibling-module use:

```text
issue
isRecord
hasExactKeys
requireExactObject
requireExactRecord
requireRows
check
sha256Bytes
gitBytes
gitText
isSha256
isOid
isTimestamp
isSafePath
isOperationalId
isBoundedText
isVerdict
hasDirectStatus
durableExclusiveWrite
```

`shared.ts` imports canonical `isRecord` and re-exports that imported binding:

```ts
import { isRecord } from '../../../../src/lib/type-guards.ts';

export { isRecord };
```

- [ ] **Step 5: Redirect facade dependencies and delete moved declarations**

Import moved private helpers from sibling modules where the remaining facade body uses
them. Delete each old declaration only after its new module compiles. Do not create
wrapper functions.

- [ ] **Step 6: Verify behavior after extraction**

Run:

```bash
npm run typecheck:scripts
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/verify-boundary-run.test.ts --run
git diff --check
```

Expected: all pass with the same 58 boundary tests.

- [ ] **Step 7: Commit the extraction bead**

```bash
git add scripts/lib/verification/boundary-run-manifest.ts \
  scripts/lib/verification/boundary-run/contracts.ts \
  scripts/lib/verification/boundary-run/model.ts \
  scripts/lib/verification/boundary-run/shared.ts
git commit -m "refactor(quality): extract boundary run contracts"
```

---

### Task 3: Complete the manifest service extraction

**Files:**
- Create: `scripts/lib/verification/boundary-run/schema.ts`
- Create: `scripts/lib/verification/boundary-run/worktree.ts`
- Create: `scripts/lib/verification/boundary-run/attempts.ts`
- Create: `scripts/lib/verification/boundary-run/joins.ts`
- Create: `scripts/lib/verification/boundary-run/lifecycle.ts`
- Create: `scripts/lib/verification/boundary-run/process.ts`
- Modify: `scripts/lib/verification/boundary-run-manifest.ts`
- Test: `tests/scripts/verify-boundary-run.test.ts`

**Interfaces:**
- Consumes: `model.ts`, `contracts.ts`, and `shared.ts` only; no extracted service imports the facade.
- Produces: the complete prior runtime API re-exported through `boundary-run-manifest.ts`, with every implementation file below 1,900 lines.

- [ ] **Step 1: Extract schema and canonical JSON behavior**

Move complete bodies for these public functions and their private helper closure into
`schema.ts`:

```text
validateBoundaryStructuredRecord
parseBoundaryChildPins
validateBoundaryRun
canonicalizeBoundaryRun
parseBoundaryJsonBytes
validateBoundaryRunJson
```

Include `validateSnapshotShape`, `validateImportedFiles`, `sortCanonical`, and
`preflightBoundaryJson` in the same module. Re-export the six public functions from the
facade.

- [ ] **Step 2: Extract worktree and derived-root behavior**

Move complete bodies for:

```text
captureBoundaryWorktreeSnapshot
verifyBoundaryWorktreeSnapshot
reserveBoundaryDerivedRoot
createBoundaryDerivedRoot
```

Move their path-capture and derived-root private helpers to `worktree.ts`. Re-export the
four public functions from the facade.

- [ ] **Step 3: Extract attempt and predicate behavior**

Move complete bodies for:

```text
parseBoundaryExpectedExit
validateBoundaryAttemptStatus
admitBoundaryOutput
validateBoundaryOutputClosure
resolveBoundaryToolCapability
validateBoundaryProfileSelection
validateBoundaryAttemptInvocation
validateBoundaryStructuredTestResult
validateBoundaryVitestJsonReport
validateBoundaryStdoutPredicate
parseBoundaryMergePreviewStdout
```

Move the evaluator and ANSI helpers with these functions. Re-export every public symbol,
including `BoundaryToolCapability`, `BoundaryStructuredTestRow`, and
`BoundaryStructuredTestResult`.

- [ ] **Step 4: Extract join behavior**

Move complete bodies for:

```text
validateAndAppendBoundaryPredecessor
validateBoundaryChildImport
validateBoundaryReviewInput
aggregateBoundaryReviewFindingVerdict
validateBoundaryReviewJoins
```

Keep sorted-string and review-ID helpers private to `joins.ts`.

- [ ] **Step 5: Extract lifecycle and closeout behavior**

Move complete bodies for:

```text
deriveBoundaryUpstreamAndTransition
verifyBoundaryLifecycleState
publishBoundaryCloseoutBundle
validateBoundaryImmutableClosure
```

Keep durable publication and lifecycle helpers private to `lifecycle.ts`.

- [ ] **Step 6: Extract watchdog/process behavior**

Move `BoundaryWatchdogOutcome`, `runBoundaryWatchdogForTest`,
`runBoundaryAttemptProcess`, and `validateBoundaryOuterWatchdogRecord`, with their
private process-group helpers, into `process.ts`.

- [ ] **Step 7: Prove size and behavior**

Run:

```bash
wc -l scripts/lib/verification/boundary-run-manifest.ts \
  scripts/lib/verification/boundary-run/*.ts
npm run typecheck:scripts
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/verify-boundary-run.test.ts --run
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/dedup-reaccumulation-guard.test.ts --run
```

Expected: every listed TypeScript file is below 1,900 lines; 58 boundary tests and the
dedup guard pass.

- [ ] **Step 8: Commit the manifest decomposition**

```bash
git add scripts/lib/verification/boundary-run-manifest.ts \
  scripts/lib/verification/boundary-run/schema.ts \
  scripts/lib/verification/boundary-run/worktree.ts \
  scripts/lib/verification/boundary-run/attempts.ts \
  scripts/lib/verification/boundary-run/joins.ts \
  scripts/lib/verification/boundary-run/lifecycle.ts \
  scripts/lib/verification/boundary-run/process.ts
git commit -m "refactor(quality): split boundary manifest services"
```

---

### Task 4: Extract CLI command services behind the stable entrypoint

**Files:**
- Create: `scripts/lib/verification/boundary-run-cli/invocation.ts`
- Create: `scripts/lib/verification/boundary-run-cli/shared.ts`
- Create: `scripts/lib/verification/boundary-run-cli/init.ts`
- Create: `scripts/lib/verification/boundary-run-cli/attempts.ts`
- Create: `scripts/lib/verification/boundary-run-cli/joins.ts`
- Create: `scripts/lib/verification/boundary-run-cli/transitions.ts`
- Create: `scripts/lib/verification/boundary-run-cli/lifecycle.ts`
- Create: `scripts/lib/verification/boundary-run-cli/closeout.ts`
- Modify: `scripts/verify-boundary-run.ts`
- Test: `tests/scripts/verify-boundary-run.test.ts`

**Interfaces:**
- Consumes: the original manifest facade plus CLI-local `BoundaryRunInvocation` and run-store helpers.
- Produces: unchanged `BOUNDARY_RUN_COMMANDS`, `BoundaryRunCommand`, `BoundaryRunInvocation`, `parseBoundaryRunInvocation`, `BOUNDARY_IMPLEMENTED_INTERNAL_CHECKS`, `BoundaryCloseoutControlClosure`, `validateBoundaryCloseoutControlClosure`, and `runBoundaryRunCli` exports from `scripts/verify-boundary-run.ts`.

- [ ] **Step 1: Add a facade import characterization test**

Keep or add this exact public-surface assertion:

```ts
expect(typeof boundaryCli.parseBoundaryRunInvocation).toBe('function');
expect(typeof boundaryCli.validateBoundaryCloseoutControlClosure).toBe('function');
expect(typeof boundaryCli.runBoundaryRunCli).toBe('function');
expect(boundaryCli.BOUNDARY_RUN_COMMANDS).toContain('verify-closeout');
expect(boundaryCli.BOUNDARY_IMPLEMENTED_INTERNAL_CHECKS).toContain('worktree-scope');
```

- [ ] **Step 2: Extract invocation parsing**

Move `BOUNDARY_RUN_COMMANDS`, its public types, option schemas, and
`parseBoundaryRunInvocation` with all parsing helpers into `invocation.ts`. Re-export the
public names from the top-level facade.

- [ ] **Step 3: Extract shared run-store primitives**

Move hashing, Git text capture, document hashes, durable writes, init-anchor
verification, run loading, confined file reads, stream records, and child-closure reads
to `shared.ts`. Export them only to sibling CLI modules.

- [ ] **Step 4: Extract init and attempt commands**

Move `initializeRun` and predecessor preparation into `init.ts`. Move `recordCommand`,
`recordArtifact`, `evaluateInternalCheck`, `recordInternalCheck`, and
`BOUNDARY_IMPLEMENTED_INTERNAL_CHECKS` into `attempts.ts`.

- [ ] **Step 5: Extract joins and transitions**

Move review/parent-review validation plus `recordChildRun` to `joins.ts`. Move
`recordGitTransition` and its Git path/conflict helpers to `transitions.ts`.

- [ ] **Step 6: Extract lifecycle and closeout commands**

Move `setUpstream`, verdict aggregation, evidence verification, `setLifecycle`,
completion candidate construction, `finalizeRun`, and `verifyRun` to `lifecycle.ts`.
Move `BoundaryCloseoutControlClosure`, `validateBoundaryCloseoutControlClosure`, rejected
closeout publication, `closeoutRun`, accepted closeout verification, and
`verifyCloseout` to `closeout.ts`.

- [ ] **Step 7: Reduce the top-level file to dispatch**

Keep the executable entrypoint and implement dispatch with the same cases and return
values:

```ts
export async function runBoundaryRunCli(
  argv: readonly string[],
  cwd = process.cwd(),
): Promise<BoundaryValidationResult> {
  const invocation = parseBoundaryRunInvocation(argv);
  return dispatchBoundaryRunInvocation(invocation, cwd);
}
```

`dispatchBoundaryRunInvocation` may live in the top-level facade or a `dispatch.ts`
module, but the resulting file must remain below 1,900 lines.

- [ ] **Step 8: Prove CLI size and behavior**

Run:

```bash
wc -l scripts/verify-boundary-run.ts \
  scripts/lib/verification/boundary-run-cli/*.ts
npm run typecheck:scripts
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/verify-boundary-run.test.ts --run
git diff --check
```

Expected: every listed file is below 1,900 lines; the same 58 tests pass.

- [ ] **Step 9: Commit the CLI decomposition**

```bash
git add scripts/verify-boundary-run.ts \
  scripts/lib/verification/boundary-run-cli/
git commit -m "refactor(quality): split boundary CLI commands"
```

---

### Task 5: Split the boundary test suite without changing discovery or evidence rosters

**Files:**
- Create: `tests/scripts/verify-boundary-run/support.ts`
- Create: `tests/scripts/verify-boundary-run/schema-cases.ts`
- Create: `tests/scripts/verify-boundary-run/attempt-cases.ts`
- Create: `tests/scripts/verify-boundary-run/join-cases.ts`
- Create: `tests/scripts/verify-boundary-run/transition-cases.ts`
- Create: `tests/scripts/verify-boundary-run/closeout-cases.ts`
- Modify: `tests/scripts/verify-boundary-run.test.ts`

**Interfaces:**
- Consumes: the unchanged manifest and CLI facade imports.
- Produces: one discovered `tests/scripts/verify-boundary-run.test.ts` file registering the same 58 named tests through five registrar functions.

- [ ] **Step 1: Capture the exact test-name roster**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/verify-boundary-run.test.ts --run --reporter=json
```

Record the 58 test names from the JSON reporter. This is the no-loss oracle.

- [ ] **Step 2: Extract shared support**

Move constants, expected contract tables, Git/temp-repository helpers, synthetic-run
builders, valid manifest factories, file hashing, and `fixtureRoots` from the pre-describe
section into `support.ts`. Export each moved name used by a registrar. Keep cleanup owned
by the discovery file:

```ts
afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Create registrar modules**

Each registrar exports one function and declares tests only when invoked:

```ts
export function registerSchemaCases(): void {
  it('rejects a noncanonical JSON byte representation', () => {
    const bytes = Buffer.from('{\r\n"schemaVersion":1\r\n}', 'utf8');
    expect(boundaryRun.validateBoundaryRunJson(bytes).ok).toBe(false);
  });
}
```

Move complete existing tests without editing their assertions into these ownership
groups:

```text
schema-cases.ts      manifest shape, canonical JSON, profiles, contracts, predicates
attempt-cases.ts     command attempts, watchdogs, outputs, tools, internal checks
join-cases.ts        predecessor, child, review, reproduction, evaluator joins
transition-cases.ts  worktree snapshots, commit/merge transitions, upstream state
closeout-cases.ts    lifecycle, finalization, verification, closeout controls
```

- [ ] **Step 4: Make the original test file a thin registrar**

The discovery file retains the single outer suite and invokes every registrar:

```ts
describe('boundary run validator', () => {
  registerSchemaCases();
  registerAttemptCases();
  registerJoinCases();
  registerTransitionCases();
  registerCloseoutCases();
});
```

Registrar filenames intentionally omit `.test.ts`, so Vitest does not discover them a
second time and profile test rosters do not change.

- [ ] **Step 5: Prove exact roster and size**

Run:

```bash
wc -l tests/scripts/verify-boundary-run.test.ts \
  tests/scripts/verify-boundary-run/*.ts
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/verify-boundary-run.test.ts --run --reporter=json
```

Expected: every file is below 1,900 lines and the JSON reporter contains the same 58
test names with 58 passes.

- [ ] **Step 6: Prove all four original CI failures are GREEN**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/dedup-reaccumulation-guard.test.ts \
  tests/scripts/fitness-file-size-warning-budget.test.ts \
  tests/scripts/verify-boundary-run.test.ts \
  --pool=forks --fileParallelism=false
npm run typecheck:scripts
npm run typecheck:all
git diff --check
```

Expected: zero duplicate violations, no new file-size identities, all 58 validator tests
pass, and both typechecks pass.

- [ ] **Step 7: Commit the test decomposition**

```bash
git add tests/scripts/verify-boundary-run.test.ts \
  tests/scripts/verify-boundary-run/
git commit -m "refactor(test): split boundary validator cases"
```

---

### Task 6: Unfiltered local coverage and branch verification

**Files:**
- Verify only; do not modify baselines or masks in response to failures.

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: current-head local evidence equivalent to the GitHub quality workflow's decisive lanes.

- [ ] **Step 1: Run the unfiltered coverage gate**

```bash
npm run coverage:check -- --pool=forks --fileParallelism=false
```

Expected: all approximately 19,510 tests pass, coverage thresholds pass, and the bounded
holdout test completes without timeout.

- [ ] **Step 2: Run the complete branch gate**

```bash
npm run verify:push:branch
```

Expected: exit zero, including 790-or-more focused repository tests, 182 design tests,
87 tokenomics tests, console lint, and console build. Existing advisory debt remains
reported rather than relabeled clean.

- [ ] **Step 3: Re-check worktree and owner artifact**

```bash
git status --short
shasum -a 256 experiment-results.tsv
git diff --check
```

Expected: only `?? experiment-results.tsv`; its hash equals the Global Constraints value.

---

### Task 7: Push, current-head checks, merge, and integration proof

**Files:**
- Remote branch: `experiment/jul16-boundary-core-history-recovery`
- Pull request: `LucasQuiles/WhatSoup#1899`
- Base branch: `origin/main`

**Interfaces:**
- Consumes: a locally clean tracked tree and passing Task 6 evidence.
- Produces: a merge commit on `origin/main` containing the exact recovery head.

- [ ] **Step 1: Fetch and reconcile any new base movement**

```bash
git fetch origin
git rev-list --left-right --count origin/main...HEAD
git diff --name-status "$(git merge-base HEAD origin/main)"...origin/main
```

Expected: inspect every incoming path. If `main` advanced, merge it with an ordinary merge
commit, rerun Task 6, and do not push stale evidence.

- [ ] **Step 2: Push through the mandatory hook**

```bash
git push origin experiment/jul16-boundary-core-history-recovery
```

Expected: the pre-push `verify:push:branch` hook exits zero and the SSH remote advances to
the exact local `HEAD`.

- [ ] **Step 3: Pin the remote and PR head**

```bash
git ls-remote origin refs/heads/experiment/jul16-boundary-core-history-recovery
gh pr view 1899 --repo LucasQuiles/WhatSoup \
  --json headRefOid,mergeable,mergeStateStatus,state,statusCheckRollup
```

Expected: both remote and PR head OIDs equal local `HEAD`.

- [ ] **Step 4: Wait for every fresh check**

```bash
gh pr checks 1899 --repo LucasQuiles/WhatSoup --watch --interval 15
```

Expected: Node 24 quality, Node 25 quality, macOS bot health, CodeQL Actions,
CodeQL JavaScript/TypeScript, CodeQL Python, and the CodeQL aggregate are terminal and
green for the current head.

- [ ] **Step 5: Re-check freshness and mergeability**

```bash
gh pr view 1899 --repo LucasQuiles/WhatSoup \
  --json headRefOid,baseRefOid,mergeable,mergeStateStatus,state,statusCheckRollup
```

Expected: `MERGEABLE`, no behind-base state, and no pending, failing, cancelled, or stale
required check.

- [ ] **Step 6: Merge without deleting the branch**

```bash
gh pr merge 1899 --repo LucasQuiles/WhatSoup --merge
```

Expected: PR #1899 transitions to `MERGED`; no branch deletion or squash occurs.

- [ ] **Step 7: Mechanically prove integration**

```bash
git fetch origin
gh pr view 1899 --repo LucasQuiles/WhatSoup \
  --json state,mergedAt,mergeCommit,headRefOid
git merge-base --is-ancestor HEAD origin/main
git rev-parse origin/main
git ls-remote origin refs/heads/main
git show -s --format='%H%n%P%n%T%n%s' origin/main
shasum -a 256 experiment-results.tsv
git status --short
```

Expected: PR state is `MERGED`; the recovery head is an ancestor of `origin/main`; local
and remote main OIDs agree; the merge commit has the expected two parents; and the owner
artifact remains untracked with the expected hash.

---

### Task 8: Start the separate post-merge swarm-consistency mining lane

**Files:**
- Create a new worktree and branch from the verified `origin/main`; do not reuse or delete the recovery worktree.

**Interfaces:**
- Consumes: Task 7 integration proof.
- Produces: a ranked, evidence-backed audit of additional rules and hooks; implementation requires its own approved design.

- [ ] **Step 1: Verify the base and create an isolated lane**

Use the `using-git-worktrees` skill. Create the new worktree under `.worktrees/` from the
verified remote-main OID and preserve the recovery lane unchanged.

- [ ] **Step 2: Run the brainstorming and hypothesis-driven audit**

Rank at least these observed candidates by false-positive risk, runtime cost, ownership,
and enforceability:

```text
pinned Node/npm reconstruction
semantic export ownership
fitness delta ratchets
test-integrity location drift
ARC sibling comparison availability
owner-artifact diagnostic classification
design shadow and duplicate token aliases
stale PR/base and check-head authorization
local security analysis parity with CodeQL
documentation publication/index coupling
```

- [ ] **Step 3: Stop at a reviewed design boundary**

Produce a new spec and implementation plan for only the highest-value cohesive tranche.
Do not make additional guard behavior changes in the recovery branch.
