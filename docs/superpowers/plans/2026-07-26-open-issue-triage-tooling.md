# Open-Issue Triage Tooling Implementation Plan

**Status:** active

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, fail-closed tool that validates the open-issue registry, renders managed issue-body reviews, plans exact live deltas, applies precondition-safe mutations, re-reads the result, and appends mutation receipts without storing complete issue bodies.

**Architecture:** Pure TypeScript modules own schema validation, managed-block rendering, and mutation planning. A narrow GitHub client adapter owns `gh api` reads and writes, while the CLI defaults to dry-run and requires an explicit expected main revision for apply mode. Tests inject an in-memory client so every mutation and concurrency path is exercised without network or GitHub writes.

**Tech Stack:** TypeScript on the repository-pinned Node 24 runtime, Node built-ins, `gh api`, Vitest, tracked JSON/Markdown/JSONL artifacts.

## Global Constraints

- Repository: `LucasQuiles/WhatSoup`.
- Accept the exact live 36-label catalogue as current state; newly added labels are limited to `bug`, `enhancement`, `refactor`, `documentation`, `alerts`, `chat`, `config`, `console`, `fleet`, `mcp`, `ops`, `scheduler`, `transport`, `audit`, `reliability`, `security`, `portability`, `tech-debt`, `type-safety`, `DRY`, `SOC`, `SSOT`, `dead-code`, `duplicate`, and `invalid`.
- Preserve an existing live-but-non-addable label; never infer or newly add one.
- Dry-run is the default and performs no GitHub or ledger mutation.
- Apply mode requires the exact expected `origin/main` object ID and unchanged issue `updatedAt` plus body SHA-256.
- Body SHA-256 is computed over the exact UTF-8 body returned by GitHub with no newline normalization.
- The managed body section is bounded by `<!-- triage-review:start -->` and `<!-- triage-review:end -->`.
- The managed block embeds `<!-- triage-review:intent-sha256=<64hex> -->` for idempotence and ambiguous-response recovery.
- Repeat runs replace only the managed section and must converge to a no-op.
- Public output contains no private host, account, path, message, chat, event, or operator identifiers.
- The ledger never stores complete issue bodies.
- docs/triage/README.md, the canonical registry, generated view, and receipt ledger are `PUBLIC`; they may contain only public GitHub metadata, repository-relative paths, hashes, and sanitized analysis.
- The offline guard performs no network or credential access; live snapshot, plan, apply, and verify commands are operator-only.
- GitHub exposes no issue-version precondition for PATCH. The tool documents the irreducible GET/PATCH race, uses an identity-checked local process lock, sends title/body/complete labels in one PATCH, never blindly retries, and re-reads before classifying an ambiguous response.
- Dry-run plan artifacts live on a tracked, publication-audited repository surface; apply refuses an untracked, dirty, overwritten, or digest-mismatched plan.
- PR #2442 remains design and planning only. Tooling implementation is published from a separate substantive branch and draft PR.
- A skipped, missing, masked, or environment-blocked check is inconclusive.
- No empty implementation-cohort pull requests are created.

---

### Task 1: Registry and ledger schema validation

**Files:**
- Create: `scripts/lib/open-issue-triage/model.ts`
- Test: `tests/scripts/open-issue-triage-model.test.ts`

**Interfaces:**
- Consumes: parsed JSON values and JSONL lines.
- Produces: `parseRegistry(value: unknown): OpenIssueRegistry`, `parseLedger(text: string): MutationReceipt[]`, `sha256(text: string): string`, `receiptSha256(receiptWithoutHash): string`, and `validateRegistry(registry: OpenIssueRegistry): ValidationIssue[]`.

- [ ] **Step 1: Write the failing schema tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  parseLedger,
  parseRegistry,
  receiptSha256,
  sha256,
  validateRegistry,
} from '../../scripts/lib/open-issue-triage/model.ts';

const issue = {
  issue_number: 101,
  issue_node_id: 'I_kwDOExample',
  title: 'Example finding',
  recommended_title: null,
  url: 'https://github.com/LucasQuiles/WhatSoup/issues/101',
  updated_at: '2026-07-26T12:00:00Z',
  pre_review_body_sha256: 'a'.repeat(64),
  current_labels: ['bug'],
  recommended_labels: ['bug', 'reliability'],
  classification: 'leaf',
  evidence_state: 'verified',
  pinned_revision: 'b'.repeat(40),
  decisive_source_paths: ['src/example.ts'],
  decisive_test_paths: ['tests/example.test.ts'],
  evidence_summary: 'The production caller does not preserve ownership.',
  falsifier_or_remaining_gap: 'Run the focused example test.',
  partial_findings: [],
  suggested_remediation: 'Give the operation one durable owner.',
  impact: 'Accepted work can be lost.',
  blast_radius: 'One runtime path.',
  affected_paths: ['src/example.ts'],
  owner_boundary: 'runtime-owner',
  acceptance_criteria: ['The focused ownership test passes.'],
  dependency_issue_numbers: [],
  duplicate_of_issue_number: null,
  implementation_after_issue_numbers: [],
  pull_request_overlaps: [],
  proposed_cohort_id: 'runtime-owner',
  pull_request_owner_pr_number: null,
  review_confidence: 'high',
  lead_verification_obligations: ['Re-read the decisive source before mutation.'],
};

const registry = {
  schema_version: 1,
  repository: 'LucasQuiles/WhatSoup',
  generated_at: '2026-07-26T12:30:00Z',
  pinned_main_revision: 'b'.repeat(40),
  inventory: {
    captured_at: '2026-07-26T12:30:00Z',
    open_issue_count: 1,
    open_pull_request_count: 2,
    draft_pull_request_count: 1,
    label_count: 2,
    labels: ['bug', 'reliability'],
  },
  issues: [issue],
};

describe('open issue registry schema', () => {
  it('accepts a complete registry and computes stable hashes', () => {
    expect(parseRegistry(registry)).toEqual(registry);
    expect(validateRegistry(parseRegistry(registry))).toEqual([]);
    expect(sha256('same')).toBe(sha256('same'));
  });

  it('rejects duplicate issue numbers, unknown labels, and dangling relationships', () => {
    const invalid = structuredClone(registry);
    invalid.issues.push({
      ...issue,
      recommended_labels: ['not-a-live-label'],
      dependency_issue_numbers: [101],
    });

    const codes = validateRegistry(parseRegistry(invalid)).map((finding) => finding.code);
    expect(codes).toHaveLength(4);
    expect(codes).toEqual(expect.arrayContaining([
      'duplicate-issue-number',
      'unknown-recommended-label',
      'self-dependency',
      'baseline-count-mismatch',
    ]));
  });

  it('parses JSONL receipts and refuses complete body fields', () => {
    const receiptWithoutHash = {
      schema_version: 1,
      receipt_type: 'target_verified',
      operation_id: 'op-101',
      batch_id: 'e'.repeat(64),
      sequence: 2,
      issue_number: 101,
      issue_node_id: 'I_kwDOExample',
      pinned_main_revision: 'b'.repeat(40),
      planned_at: '2026-07-26T13:00:00Z',
      applied_at: null,
      verified_at: null,
      before: {
        updated_at: '2026-07-26T12:00:00Z',
        body_sha256: 'a'.repeat(64),
        title_sha256: 'f'.repeat(64),
        labels: ['bug'],
      },
      expected_after: {
        body_sha256: 'c'.repeat(64),
        title_sha256: 'f'.repeat(64),
        labels: ['bug', 'reliability'],
      },
      previous_receipt_sha256: null,
      title_delta: {
        before_sha256: 'f'.repeat(64),
        after_sha256: 'f'.repeat(64),
        changed: false,
      },
      label_delta: { add: ['reliability'], remove: [] },
      operation_result: 'planned',
      diagnostic_code: null,
    };
    const receipt = {
      ...receiptWithoutHash,
      receipt_sha256: receiptSha256(receiptWithoutHash),
    };

    expect(parseLedger(`${JSON.stringify(receipt)}\n`)).toEqual([receipt]);
    expect(() => parseLedger(`${JSON.stringify({ ...receipt, body: 'forbidden' })}\n`))
      .toThrow(/body/i);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/scripts/open-issue-triage-model.test.ts --pool=forks`

Expected: FAIL because `scripts/lib/open-issue-triage/model.ts` does not exist.

- [ ] **Step 3: Implement the minimal model**

Create discriminated string unions for:

```ts
export type IssueClassification =
  | 'leaf'
  | 'tracker'
  | 'duplicate'
  | 'stale'
  | 'measurement-only';

export type EvidenceState =
  | 'verified'
  | 'partial'
  | 'measurement-required'
  | 'contradicted'
  | 'live-revalidation-required'
  | 'inconclusive';

export type ReviewConfidence = 'high' | 'medium' | 'low';
export type MutationResult =
  | 'planned'
  | 'no-op'
  | 'applied-verified'
  | 'applied-verified-after-ambiguous-response'
  | 'refused-concurrent-update'
  | 'failed-before-write'
  | 'write-outcome-unknown'
  | 'post-write-verification-failed';
```

Implement strict Zod schemas with inferred TypeScript types, following the repository's existing strict-schema conventions. Reject unknown top-level and receipt fields, unsafe URLs, unsafe repository paths, invalid RFC 3339 UTC timestamps, non-40-character revisions, non-64-character hashes, unsorted or duplicate label/relationship lists, self-references, cycles among open implementation-order relationships, broken receipt hash chains, and inventory count drift. Require every current label to remain recommended, permit all 36 live names as current state, and permit additions only from the first-pass addable set. Closed dependency references may be absent from the open registry; the live snapshot command verifies that they are valid same-repository issues. Return validation findings sorted by issue number, code, then field so repeated runs are byte-stable.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- tests/scripts/open-issue-triage-model.test.ts --pool=forks`

Expected: 1 test file passed with 3 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/open-issue-triage/model.ts tests/scripts/open-issue-triage-model.test.ts
git commit -m "feat(triage): validate issue registry receipts"
```

### Task 2: Managed review block and public-safety rendering

**Files:**
- Create: `scripts/lib/open-issue-triage/body.ts`
- Test: `tests/scripts/open-issue-triage-body.test.ts`

**Interfaces:**
- Consumes: one validated registry record plus a live issue body.
- Produces: `renderReviewBlock(record): string` and `mergeReviewBlock(body, block): ManagedBodyResult`.
- Uses: `scanTextForPrivateLiterals()` from `scripts/publication-guard.ts`.

- [ ] **Step 1: Write the failing rendering tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  mergeReviewBlock,
  renderReviewBlock,
} from '../../scripts/lib/open-issue-triage/body.ts';

describe('managed triage review body', () => {
  it('renders complete evidence without closing references', () => {
    const block = renderReviewBlock({
      issue_number: 101,
      evidence_state: 'verified',
      pinned_revision: 'b'.repeat(40),
      decisive_source_paths: ['src/example.ts'],
      decisive_test_paths: ['tests/example.test.ts'],
      evidence_summary: 'The production caller does not preserve ownership.',
      falsifier_or_remaining_gap: 'Run the focused example test.',
      partial_findings: [],
      suggested_remediation: 'Give the operation one durable owner.',
      impact: 'Accepted work can be lost.',
      blast_radius: 'One runtime path.',
      dependency_issue_numbers: [99],
      duplicate_of_issue_number: null,
      pull_request_overlaps: [{
        number: 88,
        title: 'Existing runtime ownership work',
        url: 'https://github.com/LucasQuiles/WhatSoup/pull/88',
        updated_at: '2026-07-26T12:00:00Z',
        disposition: 'open',
        is_draft: true,
        head_ref: 'feat/runtime-owner',
        base_ref: 'main',
        matched_by: ['touched-path'],
        overlapping_paths: ['src/example.ts'],
        assessment: 'partial',
      }],
      proposed_cohort_id: 'runtime-owner',
      review_confidence: 'high',
      lead_verification_obligations: ['Re-read source before apply.'],
    });

    expect(block).toContain('<!-- triage-review:start -->');
    expect(block).toMatch(/<!-- triage-review:intent-sha256=[0-9a-f]{64} -->/);
    expect(block).toContain('## Triage review');
    expect(block).toContain('Suggested remediation');
    expect(block).toContain('Impact and blast radius');
    expect(block).toContain('Depends on #99');
    expect(block).toContain('Open PR overlap: #88');
    expect(block).not.toMatch(/\b(?:close[sd]?|fixe[sd]?|resolve[sd]?)\s+#/i);
  });

  it('appends once and replaces only the existing managed block', () => {
    const first = mergeReviewBlock('Owner-authored body.\n', '<!-- triage-review:start -->\nA\n<!-- triage-review:end -->');
    const second = mergeReviewBlock(first.body, '<!-- triage-review:start -->\nB\n<!-- triage-review:end -->');

    expect(first.changed).toBe(true);
    expect(second.body).toBe('Owner-authored body.\n\n<!-- triage-review:start -->\nB\n<!-- triage-review:end -->\n');
    expect(second.body).not.toContain('\nA\n');
  });

  it('preserves CRLF bytes outside the managed marker span', () => {
    const original = 'Owner line one.\r\nOwner line two.\r\n';
    const block = '<!-- triage-review:start -->\nA\n<!-- triage-review:end -->';
    const first = mergeReviewBlock(original, block);
    const second = mergeReviewBlock(first.body, block.replace('\nA\n', '\nB\n'));

    expect(second.body.startsWith(original)).toBe(true);
    expect(second.body.slice(0, original.length)).toBe(original);
  });

  it('refuses malformed markers and private public text', () => {
    expect(() => mergeReviewBlock(
      '<!-- triage-review:start -->\nmissing end',
      '<!-- triage-review:start -->\nA\n<!-- triage-review:end -->',
    )).toThrow(/marker/i);

    expect(() => mergeReviewBlock(
      'Owner body.',
      ['<!-- triage-review:start -->\nOperator path:', '/Users', 'privateuser', 'project\n<!-- triage-review:end -->'].join('/'),
    )).toThrow(/public/i);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/scripts/open-issue-triage-body.test.ts --pool=forks`

Expected: FAIL because the body module does not exist.

- [ ] **Step 3: Implement the minimal renderer**

Render these fixed headings in this order:

```md
<!-- triage-review:start -->
<!-- triage-review:intent-sha256=<64hex> -->
## Triage review

**Evidence state:** ...
**Pinned revision:** `...`

### Evidence
...

### Suggested remediation
...

### Impact and blast radius
...

### Dependencies and overlap
...

### Verification obligations
...
<!-- triage-review:end -->
```

Accept zero or exactly one ordered standalone marker pair. Reject orphan, duplicate, nested, reversed, or malformed markers. Preserve every existing prefix and suffix byte, including newline style; on first insertion append exactly one deterministic separator and the managed block. Compute the intent digest over the canonical review payload without its own digest. Scan the proposed title, rendered block, and full expected body with the repository-hygiene, publication, and secret-like scanners before returning a body.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- tests/scripts/open-issue-triage-body.test.ts --pool=forks`

Expected: 1 test file passed with 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/open-issue-triage/body.ts tests/scripts/open-issue-triage-body.test.ts
git commit -m "feat(triage): render managed issue reviews"
```

### Task 3: Live read adapter and deterministic dry-run plans

**Files:**
- Create: `scripts/lib/open-issue-triage/github.ts`
- Create: `scripts/lib/open-issue-triage/planner.ts`
- Test: `tests/scripts/open-issue-triage-planner.test.ts`

**Interfaces:**
- Consumes: validated registry records and a `GitHubIssueClient`.
- Produces: `GhCliIssueClient`, `planIssueBatch(input): Promise<IssueMutationPlan[]>`, and exit-safe typed errors.

```ts
export interface GitHubIssueClient {
  readMainSha(): Promise<string>;
  readInventory(): Promise<LiveInventory>;
  readIssue(number: number): Promise<{ issue: LiveIssue; etag: string | null }>;
  updateIssue(number: number, patch: IssuePatch): Promise<GitHubWriteResult>;
}
```

- [ ] **Step 1: Write failing dry-run tests**

Create an in-memory client whose `updateIssue` records calls. Assert:

```ts
it('plans exact title, label, and body deltas without writing', async () => {
  const plans = await planIssueBatch({
    expectedMainSha: 'b'.repeat(40),
    records: [record],
    client,
  });

  expect(plans).toEqual([expect.objectContaining({
    issue_number: 101,
    title_delta: null,
    label_delta: { add: ['reliability'], remove: [] },
    changed: true,
  })]);
  expect(client.updates).toEqual([]);
});

it('refuses the entire batch before mutation when main, timestamp, or body hash drifts', async () => {
  client.mainSha = 'c'.repeat(40);
  await expect(planIssueBatch({
    expectedMainSha: 'b'.repeat(40),
    records: [record],
    client,
  })).rejects.toMatchObject({ code: 'main-sha-drift' });
  expect(client.updates).toEqual([]);
});

it('converges to an unchanged no-op plan', async () => {
  client.issues.set(101, expectedAfter);
  const plans = await planIssueBatch({
    expectedMainSha: 'b'.repeat(40),
    records: [recordWithExpectedAfterPreconditions],
    client,
  });
  expect(plans[0]?.changed).toBe(false);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/scripts/open-issue-triage-planner.test.ts --pool=forks`

Expected: FAIL because the GitHub adapter and planner do not exist.

- [ ] **Step 3: Implement preflight and planning**

The planner must:

1. read and compare main once;
2. read the complete paginated issue, pull-request, and label inventory once and reconcile its counts and open issue set with the registry;
3. read every requested issue with diagnostic ETag;
4. reject the whole batch if any target is closed, is a pull-request-shaped issue, has a different immutable node ID, `updatedAt`, title, sorted complete label set, exact raw-body hash, URL, or repository;
5. reject unknown labels, case-ambiguous labels, and newly added labels outside the first-pass addable set while preserving existing live labels;
6. render and public-safety scan every proposed title, managed block, and full expected body;
7. include expected-before and desired snapshots, ETag, intent SHA-256, registry SHA-256, and canonical plan SHA-256;
8. sort title, label, and body plans by issue number; and
9. return JSON-serializable plans without calling `updateIssue`.

Implement `GhCliIssueClient` with `spawnSync('gh', ['api', ...])`, explicit `--method`, a pinned tested API-version header, request payloads through stdin, a bounded output buffer, explicit JSON parsing, and no shell. Treat incomplete pagination, missing `gh`, authentication failure, malformed JSON, HTTP failure, or empty output as inconclusive typed errors rather than an empty successful inventory.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- tests/scripts/open-issue-triage-planner.test.ts --pool=forks`

Expected: 1 test file passed with the dry-run, drift, and no-op cases.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/open-issue-triage/github.ts scripts/lib/open-issue-triage/planner.ts tests/scripts/open-issue-triage-planner.test.ts
git commit -m "feat(triage): plan fail-closed issue batches"
```

### Task 4: Apply, re-read verification, and append-only receipts

**Files:**
- Create: `scripts/lib/open-issue-triage/apply.ts`
- Test: `tests/scripts/open-issue-triage-apply.test.ts`

**Interfaces:**
- Consumes: a canonical tracked batch plan, confirmed plan SHA-256, idempotency key, expected main SHA, ledger path, clock, delay function, and client.
- Produces: `applyIssueBatch(input): Promise<MutationReceipt[]>`.

- [ ] **Step 1: Write failing apply tests**

Use the in-memory client and a temporary ledger path. Assert:

```ts
it('applies in issue order, re-reads exact state, and appends receipts without bodies', async () => {
  const receipts = await applyIssueBatch({
    expectedMainSha: 'b'.repeat(40),
    plans,
    client,
    ledgerPath,
    now: () => '2026-07-26T14:00:00Z',
    delay: async () => undefined,
    confirmedPlanSha256: plan.plan_sha256,
    idempotencyKey: 'review-batch-101-102-v1',
  });

  expect(client.updates.map((entry) => entry.number)).toEqual([101, 102]);
  expect(receipts.filter((receipt) => receipt.receipt_type === 'target_verified')
    .every((receipt) => receipt.operation_result === 'applied-verified')).toBe(true);
  const ledger = readFileSync(ledgerPath, 'utf8');
  expect(ledger.split('\n').filter(Boolean)).toHaveLength(4);
  expect(ledger).not.toContain('Owner-authored body');
  expect(ledger).not.toContain('expected_body');
  expect(ledger).not.toContain('Example finding');
});

it('records and throws on a post-write verification mismatch', async () => {
  client.afterUpdate = (issue) => ({ ...issue, labels: [] });
  await expect(applyIssueBatch(input)).rejects.toMatchObject({
    code: 'post-write-verification-failed',
  });
  expect(parseLedger(readFileSync(ledgerPath, 'utf8')).at(-1)?.operation_result)
    .toBe('post-write-verification-failed');
});

it('does not call update for no-op plans', async () => {
  const receipts = await applyIssueBatch({ ...input, plans: [noOpPlan] });
  expect(client.updates).toEqual([]);
  expect(receipts.find((receipt) => receipt.receipt_type === 'target_verified')?.operation_result)
    .toBe('no-op');
});

it('re-reads an ambiguous write and never retries PATCH automatically', async () => {
  client.writeResult = { kind: 'ambiguous', diagnosticCode: 'transport-timeout' };
  client.afterAmbiguousWrite = desiredIssue;

  const receipts = await applyIssueBatch(input);

  expect(client.updates).toHaveLength(1);
  expect(receipts.find((receipt) => receipt.receipt_type === 'target_verified')?.operation_result)
    .toBe('applied-verified-after-ambiguous-response');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/scripts/open-issue-triage-apply.test.ts --pool=forks`

Expected: FAIL because the apply module does not exist.

- [ ] **Step 3: Implement minimal fail-closed apply**

Require a clean tracked plan whose canonical digest matches both the explicit confirmation and registry. Acquire the repository's identity-checked process lock. Validate the complete ledger chain and reject a conflicting reuse of the idempotency key. Re-read main and every issue precondition immediately before the first write, then durably append `batch_started`.

Apply plans in issue-number order. For each changed target, recompute the desired body from the last live body and issue one PATCH containing title, body, and the complete sorted replacement label set. Never blindly retry PATCH. Wait at least one second between mutation requests through the injected delay function. After each response, re-read the issue and compare immutable node ID, exact title hash, sorted labels, raw-body SHA-256, and intent marker. If the response is ambiguous, classify it as verified only when the re-read equals the complete desired state; exact before state is retryable but not retried, and any third state is `write-outcome-unknown` and stops the batch.

Append newline-terminated `batch_started`, `target_verified` or `target_unknown`, and `batch_completed` receipts using a single-owner lock, no-follow regular-file open, `O_APPEND`, and `fsync` for both file and containing directory. Hash each canonical receipt without `receipt_sha256`, store the prior record hash in `previous_receipt_sha256`, and reject a broken chain before applying. Store title hashes, never title or body content. A failed append after a verified GitHub change is exit-class 5 and stops the batch; it is never masked as successful verification.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- tests/scripts/open-issue-triage-apply.test.ts --pool=forks`

Expected: 1 test file passed with apply, mismatch, no-op, ambiguous-response, idempotency, delay, and ledger-confinement cases.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/open-issue-triage/apply.ts tests/scripts/open-issue-triage-apply.test.ts
git commit -m "feat(triage): verify issue mutations and receipts"
```

### Task 5: CLI, generated view, and repository documentation

**Files:**
- Create: `scripts/open-issue-triage.ts`
- Create: docs/triage/README.md
- Create: `docs/triage/open-issue-review-ledger.jsonl`
- Modify: `package.json`
- Modify: `docs/public-surface.md`
- Modify: `docs/publication-audit.md`
- Modify: `docs/work-index.json`
- Modify: `docs/work-index.md`
- Test: `tests/scripts/open-issue-triage-cli.test.ts`

**Interfaces:**
- Consumes: an explicit `--registry` path. The canonical registry is added by the follow-on population plan.
- Produces commands:
  - `npm run triage:issues -- schema [command]`
  - `npm run triage:issues -- check`
  - `npm run triage:issues -- render --check`
  - `npm run triage:issues -- render --write`
  - `npm run triage:issues -- snapshot --output docs/triage/snapshots/<snapshot-id>.json`
  - `npm run triage:issues -- issue dry-run --issue-number 101 --expected-main-oid <40-hex-sha> --output docs/triage/plans/<batch-id>.json`
  - `npm run triage:issues -- issue apply --plan docs/triage/plans/<batch-id>.json --confirm-plan-sha256 <64-hex-sha> --confirm-issues 101 --idempotency-key <stable-key>`
  - `npm run triage:issues -- issue re-read --plan docs/triage/plans/<batch-id>.json`

- [ ] **Step 1: Write failing CLI and guard tests**

Assert that:

```ts
expect(run(['check'], fixtureRoot, fakeClient)).toBe(0);
expect(run(['render', '--check'], driftedFixtureRoot, fakeClient)).toBe(1);
expect(run([
  'issue', 'dry-run',
  '--issue-number', '101',
  '--expected-main-oid', 'b'.repeat(40),
  '--output', 'docs/triage/plans/batch-101.json',
], fixtureRoot, fakeClient)).toBe(0);
expect(fakeClient.updates).toEqual([]);
expect(() => parseArgs(['issue', 'apply', '--plan', 'docs/triage/plans/batch-101.json']))
  .toThrow(/confirm-plan-sha256/);
expect(() => parseArgs(['issue', 'dry-run', '--issue-number', '101', '--unknown']))
  .toThrow(/unknown/i);
```

Also assert that `schema` works with no network/authentication, JSON output does not vary with TTY allocation, every command declares machine-readable effect metadata, dry-run creates its explicitly named repository-confined plan with exclusive/no-follow semantics, apply refuses an untracked or dirty plan, large inventory output supports `--fields` projection, and structured errors contain stable `kind`, `message`, `hint`, and `retryable` fields. `check`, `render`, snapshot, and issue commands require `--registry`; they fail closed when it is absent or incomplete. Do not add a permissive missing-registry bypass.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- tests/scripts/open-issue-triage-cli.test.ts --pool=forks
```

Expected: FAIL because the CLI command is absent.

- [ ] **Step 3: Implement the CLI and guard chain**

Add these package scripts:

```json
{
  "triage:issues": "bash scripts/run-with-pinned-node.sh scripts/open-issue-triage.ts"
}
```

Make `schema` and `check` entirely offline. `schema` declares compact per-command input/output schemas, effect metadata (`read_only`, `destructive`, `idempotent`, `open_world`, `supports_dry_run`), confirmation requirements, and retry semantics. `check` validates the checked-in registry and ledger, verifies the receipt hash chain, and compares the generated Markdown view byte-for-byte. Make `snapshot`, issue dry-run, apply, and re-read the only commands that use the GitHub adapter.

Machine output is TTY-independent JSON by default and contains one root object with `schema_version`, `ok`, `command`, `effects`, `summary`, and `warnings`; `--format text` is explicit. Success stdout never contains spinners, ANSI, logs, or full issue bodies. Failure leaves stdout empty and emits one JSON error on stderr with `kind`, `message`, `hint`, `retryable`, and bounded `details`. Dry-run returns only an artifact path, canonical SHA-256, issue-number summary, and warnings. Apply prints body-free receipt summaries.

Use these exits: `0` verified success/no-op; `1` unexpected internal invariant; `2` invocation/JSON/schema invalid; `3` stale plan/precondition/ownership conflict; `4` public-safety/workflow-policy rejection; `5` unknown mutation result/post-write mismatch/ledger durability failure; `6` authentication/API/transport/rate-limit failure before mutation.

Do not wire the command into pre-commit, pre-push, or CI in this tooling PR. The follow-on registry-population plan creates the canonical 168-record registry and generated view, proves complete live coverage, then adds `guard:issue-triage` to hook and CI chains in the same commit. This sequencing is fail-closed: there is no absent-registry skip and no partial-registry green state.

Create the ledger as an empty tracked file. Classify every `docs/triage/*` artifact as `PUBLIC` in `docs/publication-audit.md`, with rationale that complete issue bodies and private runtime identifiers are forbidden. Do not add `docs/triage` to the work-index scanner because these are generated operational artifacts rather than plans/specs; regenerate the work index only for this implementation plan. Expose only the public-safe operator commands in `docs/public-surface.md`.

- [ ] **Step 4: Run focused verification**

Run:

```bash
npm test -- tests/scripts/open-issue-triage-model.test.ts tests/scripts/open-issue-triage-body.test.ts tests/scripts/open-issue-triage-planner.test.ts tests/scripts/open-issue-triage-apply.test.ts tests/scripts/open-issue-triage-cli.test.ts --pool=forks
npm run triage:issues -- schema
npm run guard:work-index
npm run guard:publication:staged
npm run guard:repo:staged
```

Expected: all focused tests and guards pass with no masked command.

- [ ] **Step 5: Commit**

```bash
git add scripts/open-issue-triage.ts package.json docs/triage/README.md docs/triage/open-issue-review-ledger.jsonl docs/public-surface.md docs/publication-audit.md docs/work-index.json docs/work-index.md tests/scripts/open-issue-triage-cli.test.ts
git commit -m "feat(triage): enforce deterministic issue review"
```

## Self-Review

- Spec coverage: schema and unique coverage, managed body idempotence, existing-label enforcement, main/timestamp/hash concurrency, public-safety scanning, dry-run default, re-read verification, and body-free receipts each have a task and focused test.
- Deliberate separate plan: populating all 168 evidence records and executing external mutation batches comes after this tooling plan, so reviewed issue content does not share a commit with mutation-engine behavior.
- Instruction-completeness scan: every task names exact files, interfaces, commands, expected failures, expected passes, and commit boundaries.
- Type consistency: `GitHubIssueClient`, `IssueMutationPlan`, `OpenIssueRegistry`, and `MutationReceipt` are introduced before their downstream consumers and retain the same names.
- Completion boundary: this plan is not complete until the focused tests observe RED before implementation, then pass; the schema and CLI contracts are verified; commits are pushed from a separate tooling branch; the tooling draft PR points to the tested commit; and the isolated worktree is cleanly retired.
