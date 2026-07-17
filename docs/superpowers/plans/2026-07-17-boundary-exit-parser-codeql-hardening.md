# Boundary Exit Parser CodeQL Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all three CodeQL blockers on PR #1899 without changing the accepted expected-exit language or boundary-run failure behavior.

**Architecture:** Export one linear expected-exit parser from the boundary-run manifest module and reuse it in manifest validation, watchdog evaluation, and the CLI generic-reproduction path. Replace the test fixture's first-only newline conversion with an all-newline CRLF conversion, then require local gates and fresh GitHub security analysis before merge.

**Tech Stack:** TypeScript 5.9, Node.js 24.15.0, Vitest 4.1.8, GitHub CodeQL, repository commit/pre-push hooks.

## Global Constraints

- Accept only `nonzero`, or a strictly increasing comma-separated list of unique decimal integers in `0..255` with no leading zeroes.
- Keep existing issue codes, CLI flags, manifest fields, schemas, evidence layouts, and fail-closed outcomes unchanged.
- Do not dismiss, suppress, or reclassify a CodeQL alert.
- Preserve `experiment-results.tsv` byte-for-byte and never stage or commit it.
- Do not bypass commit, pre-push, publication, security, or required-status gates.
- Run every npm command through `scripts/run-with-pinned-npm.sh`; ambient npm currently resolves Node 26.4.0 while this repository pins Node 24.15.0.
- Use the existing `origin` SSH remote; do not change it to HTTPS.
- Execute inline in this session; no worker delegation is authorized by the current runtime receipts.

---

### Task 1: Add a failing shared-parser regression

**Files:**
- Modify: `tests/scripts/verify-boundary-run.test.ts:1168-1410`

**Interfaces:**
- Consumes: the existing namespace import `boundaryRun` from `scripts/lib/verification/boundary-run-manifest.ts`.
- Produces: a test contract for `parseBoundaryExpectedExit(value: string): Set<number> | 'nonzero' | null` and an all-newline CRLF fixture.

- [ ] **Step 1: Add the direct parser contract test**

Insert this test near the start of `describe('boundary run validator', ...)`:

```typescript
  it('[BCF00-S01] parses expected exits in linear bounded form', () => {
    const api = boundaryRun as unknown as {
      parseBoundaryExpectedExit?: (value: string) => Set<number> | 'nonzero' | null;
    };
    expect(typeof api.parseBoundaryExpectedExit).toBe('function');
    if (!api.parseBoundaryExpectedExit) return;

    expect(api.parseBoundaryExpectedExit('nonzero')).toBe('nonzero');
    expect(api.parseBoundaryExpectedExit('0')).toEqual(new Set([0]));
    expect(api.parseBoundaryExpectedExit('0,1,255')).toEqual(new Set([0, 1, 255]));

    for (const value of [
      '', '00', '01', '256', '1,1', '2,1', '0,', '1,,2',
      ' 1', '1 ', '+1', '1.0', '1\n2',
    ]) {
      expect(api.parseBoundaryExpectedExit(value), value).toBeNull();
    }

    const adversarial = `${Array.from({ length: 10_000 }, () => '0,1').join(',')},x`;
    expect(api.parseBoundaryExpectedExit(adversarial)).toBeNull();
  });
```

- [ ] **Step 2: Make the CRLF negative fixture prove all newlines change**

Immediately before the `rawCases` array, add:

```typescript
    const canonicalWithCrLf = canonical.replaceAll('\n', '\r\n');
```

Replace the flagged raw case with:

```typescript
      { bytes: Buffer.from(canonicalWithCrLf), code: 'invalid-json-byte' },
```

- [ ] **Step 3: Run the new parser test and verify RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/verify-boundary-run.test.ts \
  -t "parses expected exits in linear bounded form" \
  --pool=forks --fileParallelism=false
```

Expected: FAIL because `parseBoundaryExpectedExit` is absent and the assertion receives `undefined` instead of `function`.

---

### Task 2: Implement and reuse the linear parser

**Files:**
- Modify: `scripts/lib/verification/boundary-run-manifest.ts:2187-2197,2219,3344,4009`
- Modify: `scripts/verify-boundary-run.ts:10-55,1047-1060`
- Test: `tests/scripts/verify-boundary-run.test.ts`

**Interfaces:**
- Consumes: the failing Task 1 contract.
- Produces: `parseBoundaryExpectedExit(value: string): Set<number> | 'nonzero' | null`, reused by every expected-exit consumer.

- [ ] **Step 1: Replace the private ambiguous parser with the exported linear parser**

Replace `parseExpectedExit` with:

```typescript
export function parseBoundaryExpectedExit(value: string): Set<number> | 'nonzero' | null {
  if (value === 'nonzero') return 'nonzero';
  const tokens = value.split(',');
  if (tokens.some((token) => {
    if (token === '0') return false;
    if (token.length === 0 || token.length > 3) return true;
    const first = token.charCodeAt(0);
    if (first < 49 || first > 57) return true;
    return [...token].some((character) => {
      const code = character.charCodeAt(0);
      return code < 48 || code > 57;
    });
  })) return null;
  const statuses = tokens.map(Number);
  if (
    statuses.some((status) => status > 255)
    || new Set(statuses).size !== statuses.length
    || statuses.some((status, index) => index > 0 && status <= statuses[index - 1]!)
  ) return null;
  return new Set(statuses);
}
```

Replace every remaining `parseExpectedExit(...)` call in this module with
`parseBoundaryExpectedExit(...)`.

- [ ] **Step 2: Reuse the parser in the CLI**

Add `parseBoundaryExpectedExit` to the existing import list from
`./lib/verification/boundary-run-manifest.ts`.

Replace the duplicated `statuses` and `normalizedExit` calculation in the generic
reproduction branch with:

```typescript
    const normalizedExit = parseBoundaryExpectedExit(expectedExit) !== null;
```

- [ ] **Step 3: Run the focused parser test and verify GREEN**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/verify-boundary-run.test.ts \
  -t "parses expected exits in linear bounded form" \
  --pool=forks --fileParallelism=false
```

Expected: one matching test passes with exit 0.

- [ ] **Step 4: Run the complete boundary-run test file**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/verify-boundary-run.test.ts --pool=forks --fileParallelism=false
```

Expected: every test passes with exit 0; the canonical CRLF case still reports the
expected `invalid-json-byte` issue inside its assertion.

- [ ] **Step 5: Run TypeScript and diff checks**

Run:

```bash
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run typecheck:all
git diff --check
shasum -a 256 experiment-results.tsv
```

Expected: both typechecks and `git diff --check` exit 0; the owner artifact remains
`f93e0c1b42bc10fc8f8a2488d0efe7a12f671088e00f31bf772161d8bd15e9a3`.

- [ ] **Step 6: Stage only the remediation and run staged guards**

Run:

```bash
git add scripts/lib/verification/boundary-run-manifest.ts \
  scripts/verify-boundary-run.ts \
  tests/scripts/verify-boundary-run.test.ts
git diff --cached --check
bash scripts/run-with-pinned-npm.sh run guard:repo:staged
bash scripts/run-with-pinned-npm.sh run guard:publication:staged
```

Expected: the three named paths are staged, the owner artifact is not staged, and all
commands exit 0.

- [ ] **Step 7: Commit the remediation**

Run:

```bash
git commit -m "fix(quality): remove ambiguous exit validation"
```

Expected: commit hooks pass without bypass and create one commit containing only the three
remediation paths.

---

### Task 3: Verify, push, and clear the PR security gate

**Files:**
- Verify only: repository branch diff and PR #1899 checks.

**Interfaces:**
- Consumes: the Task 2 remediation commit and existing PR #1899.
- Produces: a pushed head for which repository gates and all GitHub required checks pass.

- [ ] **Step 1: Run the complete local branch gate**

Run:

```bash
bash scripts/run-with-pinned-npm.sh run verify:push:branch
```

Expected: exit 0 with no masked failure. Advisory baseline warnings must remain explicitly
reported as warnings rather than being described as clean.

- [ ] **Step 2: Reverify owner state and push through the hook**

Run:

```bash
test "$(shasum -a 256 experiment-results.tsv | awk '{print $1}')" = \
  "f93e0c1b42bc10fc8f8a2488d0efe7a12f671088e00f31bf772161d8bd15e9a3"
git status --short
git push origin experiment/jul16-boundary-core-history-recovery
```

Expected: the hash assertion and push succeed, the pre-push hook passes without bypass,
and only `experiment-results.tsv` remains untracked.

- [ ] **Step 3: Require fresh terminal PR checks**

Run:

```bash
gh pr checks 1899 --repo LucasQuiles/WhatSoup --watch --interval 15
gh pr view 1899 --repo LucasQuiles/WhatSoup \
  --json state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefOid,url
```

Expected: every required check, including the GitHub Advanced Security `CodeQL` check,
passes for the new exact head. A failure remains blocking and is diagnosed rather than
dismissed or rerun.

---

### Task 4: Merge and prove integration before mining

**Files:**
- Verify only: GitHub PR #1899 and local remote-tracking refs.

**Interfaces:**
- Consumes: a mergeable PR with all required checks passing.
- Produces: proof that the exact recovery head is reachable from `origin/main` and a clean
handoff to a separate post-merge mining lane.

- [ ] **Step 1: Merge without deleting preserved branches**

Run:

```bash
gh pr merge 1899 --repo LucasQuiles/WhatSoup --merge
```

Expected: GitHub creates a merge commit and reports PR #1899 merged. Do not pass
`--delete-branch`.

- [ ] **Step 2: Fetch and prove exact ancestry**

Run:

```bash
git fetch origin
RECOVERY_HEAD=$(git rev-parse HEAD)
git merge-base --is-ancestor "$RECOVERY_HEAD" origin/main
git rev-parse origin/main
git ls-remote origin refs/heads/main
gh pr view 1899 --repo LucasQuiles/WhatSoup \
  --json state,mergedAt,mergeCommit,headRefOid,baseRefOid,url
```

Expected: the ancestry check exits 0, local and remote main agree, and PR state is
`MERGED` with a non-null merge commit.

- [ ] **Step 3: Preserve the recovery lane and start mining separately**

Run:

```bash
git status --short
shasum -a 256 experiment-results.tsv
```

Expected: only the unchanged owner artifact is untracked. Keep this worktree and branch;
do not clean or delete them. Create the post-merge mining lane from the verified
`origin/main` only after this proof is recorded.
