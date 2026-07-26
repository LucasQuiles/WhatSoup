import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApplyIssueBatchError,
  applyIssueBatch,
  type ApplyIssueBatchInput,
} from '../../scripts/lib/open-issue-triage/apply.ts';
import type {
  GitHubIssueClient,
  GitHubWriteResult,
  IssuePatch,
  LiveInventory,
  LiveIssue,
} from '../../scripts/lib/open-issue-triage/github.ts';
import {
  LIVE_LABELS,
  parseLedger,
  registrySha256,
  sha256,
  type OpenIssueRegistry,
} from '../../scripts/lib/open-issue-triage/model.ts';
import {
  planIssueBatch,
  type IssueMutationPlan,
} from '../../scripts/lib/open-issue-triage/planner.ts';
import { acquireProcessLock, releaseProcessLock } from '../../src/lib/process-lock.ts';

const MAIN_SHA = 'b'.repeat(40);
const OWNER_BODY = 'Owner-authored body.\r\n';
const REPOSITORY = 'LucasQuiles/WhatSoup';
const NOW = '2026-07-26T14:00:00Z';

type ReviewRecord = OpenIssueRegistry['issues'][number];

function utf8Sort(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function rehashPlans(plans: IssueMutationPlan[]): IssueMutationPlan[] {
  const withoutHashes = plans.map(({ plan_sha256: _planSha256, ...plan }) => plan);
  const digest = sha256(`${JSON.stringify(canonicalize(withoutHashes))}\n`);
  return plans.map((plan) => ({ ...plan, plan_sha256: digest }));
}

function record(number: number, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    issue_number: number,
    issue_node_id: `I_kwDOExample${number}`,
    title: `Example finding ${number}`,
    recommended_title: null,
    url: `https://github.com/LucasQuiles/WhatSoup/issues/${number}`,
    updated_at: '2026-07-26T12:00:00Z',
    pre_review_body_sha256: sha256(OWNER_BODY),
    current_labels: ['bug'],
    recommended_labels: ['bug', 'reliability'],
    classification: 'leaf',
    evidence_state: 'verified',
    pinned_revision: MAIN_SHA,
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
    proposed_cohort_id: null,
    pull_request_owner_pr_number: null,
    review_confidence: 'high',
    lead_verification_obligations: ['Re-read the decisive source before mutation.'],
    ...overrides,
  };
}

function registry(records: ReviewRecord[]): OpenIssueRegistry {
  return {
    schema_version: 1,
    repository: REPOSITORY,
    generated_at: '2026-07-26T12:30:00Z',
    pinned_main_revision: MAIN_SHA,
    inventory: {
      captured_at: '2026-07-26T12:30:00Z',
      open_issue_count: records.length,
      open_pull_request_count: 0,
      draft_pull_request_count: 0,
      label_count: LIVE_LABELS.length,
      labels: utf8Sort(LIVE_LABELS),
    },
    issues: records,
  };
}

function liveIssue(number: number, overrides: Partial<LiveIssue> = {}): LiveIssue {
  return {
    number,
    nodeId: `I_kwDOExample${number}`,
    repository: REPOSITORY,
    url: `https://github.com/LucasQuiles/WhatSoup/issues/${number}`,
    title: `Example finding ${number}`,
    body: OWNER_BODY,
    labels: ['bug'],
    state: 'open',
    updatedAt: '2026-07-26T12:00:00Z',
    isPullRequest: false,
    ...overrides,
  };
}

class InMemoryClient implements GitHubIssueClient {
  mainSha = MAIN_SHA;
  readonly issues: Map<number, LiveIssue>;
  readonly updates: Array<{ number: number; patch: IssuePatch }> = [];
  readonly events: string[] = [];
  writeResult: GitHubWriteResult['kind'] = 'success';
  ambiguousDiagnostic: Extract<GitHubWriteResult, { kind: 'ambiguous' }>['diagnosticCode'] =
    'transport-timeout';
  ambiguousState: 'desired' | 'before' | 'third' = 'desired';
  afterUpdate?: (issue: LiveIssue) => LiveIssue;
  updateError: Error | null = null;

  constructor(issueNumbers: number[]) {
    this.issues = new Map(issueNumbers.map((number) => [number, liveIssue(number)]));
  }

  async readMainSha(): Promise<string> {
    this.events.push('main');
    return this.mainSha;
  }

  async readInventory(): Promise<LiveInventory> {
    this.events.push('inventory');
    return {
      repository: REPOSITORY,
      openIssueNumbers: [...this.issues.keys()].sort((left, right) => left - right),
      openPullRequests: [],
      labels: utf8Sort(LIVE_LABELS),
      counts: {
        openIssues: this.issues.size,
        openPullRequests: 0,
        draftPullRequests: 0,
        labels: LIVE_LABELS.length,
      },
      pagination: {
        issuesComplete: true,
        pullRequestsComplete: true,
        labelsComplete: true,
      },
    };
  }

  async readIssue(number: number): Promise<{ issue: LiveIssue; etag: string | null }> {
    this.events.push(`read:${number}`);
    const issue = this.issues.get(number);
    if (issue === undefined) throw new Error(`missing fixture issue ${number}`);
    return { issue: structuredClone(issue), etag: `"etag-${number}"` };
  }

  async updateIssue(number: number, patch: IssuePatch): Promise<GitHubWriteResult> {
    this.events.push(`update:${number}`);
    this.updates.push({ number, patch: structuredClone(patch) });
    if (this.updateError !== null) throw this.updateError;
    const before = this.issues.get(number);
    if (before === undefined) throw new Error(`missing fixture issue ${number}`);
    const desired = {
      ...before,
      title: patch.title,
      body: patch.body,
      labels: [...patch.labels],
    };
    if (this.writeResult === 'ambiguous') {
      if (this.ambiguousState === 'desired') this.issues.set(number, desired);
      if (this.ambiguousState === 'third') {
        this.issues.set(number, { ...desired, labels: [] });
      }
      return { kind: 'ambiguous', diagnosticCode: this.ambiguousDiagnostic };
    }
    const after = this.afterUpdate?.(desired) ?? desired;
    this.issues.set(number, after);
    return { kind: 'success', issue: structuredClone(after), etag: `"etag-${number}-after"` };
  }
}

let tempRoot: string;
let ledgerPath: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'whatsoup-triage-apply-'));
  ledgerPath = join(tempRoot, 'receipts.jsonl');
});

afterEach(() => {
  chmodSync(tempRoot, 0o700);
  rmSync(tempRoot, { recursive: true, force: true });
});

async function makePlans(
  client: InMemoryClient,
  records: ReviewRecord[],
): Promise<{ plans: IssueMutationPlan[]; inputRegistry: OpenIssueRegistry }> {
  const inputRegistry = registry(records);
  const plans = await planIssueBatch({
    expectedMainSha: MAIN_SHA,
    registry: inputRegistry,
    targetIssueNumbers: records.map((entry) => entry.issue_number),
    client,
  });
  client.events.length = 0;
  return { plans, inputRegistry };
}

function applyInput(
  client: InMemoryClient,
  plans: IssueMutationPlan[],
  inputRegistry: OpenIssueRegistry,
  overrides: Partial<ApplyIssueBatchInput> = {},
): ApplyIssueBatchInput {
  return {
    expectedMainSha: MAIN_SHA,
    plans,
    client,
    ledgerPath,
    now: () => NOW,
    delay: async () => undefined,
    confirmedPlanSha256: plans[0]!.plan_sha256,
    registrySha256: registrySha256(inputRegistry),
    idempotencyKey: 'review-batch-101-102-v1',
    ...overrides,
  };
}

function receiptFor(
  receipts: ReturnType<typeof parseLedger>,
  issueNumber: number,
) {
  return receipts.find((receipt) =>
    'issue_number' in receipt && receipt.issue_number === issueNumber);
}

describe('open issue batch apply', () => {
  it('applies in issue order, re-reads exact state, and appends body-free receipts', async () => {
    const client = new InMemoryClient([101, 102]);
    const { plans, inputRegistry } = await makePlans(client, [record(101), record(102)]);

    const receipts = await applyIssueBatch(applyInput(client, plans, inputRegistry));

    expect(client.updates.map((entry) => entry.number)).toEqual([101, 102]);
    expect(client.events.slice(0, 3)).toEqual(['main', 'read:101', 'read:102']);
    expect(client.events.indexOf('read:102')).toBeLessThan(client.events.indexOf('update:101'));
    expect(receipts.filter((receipt) => receipt.receipt_type === 'target_verified')
      .every((receipt) => receipt.operation_result === 'applied-verified')).toBe(true);
    const ledger = readFileSync(ledgerPath, 'utf8');
    expect(parseLedger(ledger)).toEqual(receipts);
    expect(ledger.split('\n').filter(Boolean)).toHaveLength(4);
    expect(ledger).not.toContain('Owner-authored body');
    expect(ledger).not.toContain('expected_body');
    expect(ledger).not.toContain('Example finding');
    expect(receipts.map((receipt) => receipt.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('does not PATCH an exact no-op plan', async () => {
    const client = new InMemoryClient([101]);
    const initial = await makePlans(client, [record(101)]);
    const desiredBody = client.issues.get(101)!.body;
    const plannedBody = initial.plans[0]!.managed_block;
    const { mergeReviewBlock } = await import('../../scripts/lib/open-issue-triage/body.ts');
    const merged = mergeReviewBlock(desiredBody, plannedBody).body;
    const noOpRecord = record(101, {
      pre_review_body_sha256: sha256(merged),
      current_labels: ['bug', 'reliability'],
      recommended_labels: ['bug', 'reliability'],
    });
    client.issues.set(101, liveIssue(101, { body: merged, labels: ['bug', 'reliability'] }));
    const { plans, inputRegistry } = await makePlans(client, [noOpRecord]);

    const receipts = await applyIssueBatch(applyInput(client, plans, inputRegistry));

    expect(client.updates).toEqual([]);
    expect(receiptFor(receipts, 101)).toMatchObject({
      receipt_type: 'target_verified',
      operation_result: 'no-op',
      applied_at: null,
      verified_at: NOW,
    });
    expect(receipts.at(-1)).toMatchObject({
      receipt_type: 'batch_completed',
      operation_result: 'no-op',
    });
  });

  it('uses a delay of at least one second between mutation requests', async () => {
    const client = new InMemoryClient([101, 102]);
    const { plans, inputRegistry } = await makePlans(client, [record(101), record(102)]);
    const delays: number[] = [];

    await applyIssueBatch(applyInput(client, plans, inputRegistry, {
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    }));

    expect(delays).toEqual([1000]);
  });

  it('fails the complete preflight before mutation on main or target drift', async () => {
    const client = new InMemoryClient([101, 102]);
    const { plans, inputRegistry } = await makePlans(client, [record(101), record(102)]);
    client.issues.set(102, liveIssue(102, { title: 'Concurrent retitle' }));

    await expect(applyIssueBatch(applyInput(client, plans, inputRegistry)))
      .rejects.toMatchObject({ code: 'precondition-drift', exitClass: 3 });
    expect(client.events).toEqual(['main', 'read:101', 'read:102']);
    expect(client.updates).toEqual([]);
    expect(() => readFileSync(ledgerPath, 'utf8')).toThrow();

    client.events.length = 0;
    client.mainSha = 'c'.repeat(40);
    await expect(applyIssueBatch(applyInput(client, plans, inputRegistry)))
      .rejects.toMatchObject({ code: 'main-sha-drift', exitClass: 3 });
    expect(client.events).toEqual(['main']);
    expect(client.updates).toEqual([]);
  });

  it('rejects plan, registry, confirmation, and idempotency mismatches before mutation', async () => {
    const client = new InMemoryClient([101]);
    const { plans, inputRegistry } = await makePlans(client, [record(101)]);
    const cases: Array<Partial<ApplyIssueBatchInput>> = [
      { confirmedPlanSha256: 'c'.repeat(64) },
      { registrySha256: 'd'.repeat(64) },
      { expectedMainSha: 'not-a-sha' },
      { idempotencyKey: 'contains spaces' },
      {
        plans: [{
          ...plans[0]!,
          desired: { ...plans[0]!.desired, body_sha256: 'e'.repeat(64) },
        }],
      },
    ];

    for (const changes of cases) {
      client.events.length = 0;
      await expect(applyIssueBatch(applyInput(client, plans, inputRegistry, changes)))
        .rejects.toBeInstanceOf(ApplyIssueBatchError);
      expect(client.events).toEqual([]);
      expect(client.updates).toEqual([]);
    }
  });

  it('rejects a self-consistently rehashed but internally incoherent plan before receipts', async () => {
    const client = new InMemoryClient([101]);
    const { plans, inputRegistry } = await makePlans(client, [record(101)]);
    const dishonest = rehashPlans([{ ...plans[0]!, changed: false }]);

    await expect(applyIssueBatch(applyInput(client, dishonest, inputRegistry, {
      confirmedPlanSha256: dishonest[0]!.plan_sha256,
    }))).rejects.toMatchObject({ code: 'invalid-apply-input', exitClass: 3 });

    expect(client.events).toEqual([]);
    expect(client.updates).toEqual([]);
    expect(() => readFileSync(ledgerPath, 'utf8')).toThrow();
  });

  it('records and throws on a post-write verification mismatch', async () => {
    const client = new InMemoryClient([101]);
    const { plans, inputRegistry } = await makePlans(client, [record(101)]);
    client.afterUpdate = (issue) => ({ ...issue, labels: [] });

    await expect(applyIssueBatch(applyInput(client, plans, inputRegistry)))
      .rejects.toMatchObject({
        code: 'post-write-verification-failed',
        exitClass: 5,
      });

    expect(client.updates).toHaveLength(1);
    expect(parseLedger(readFileSync(ledgerPath, 'utf8')).at(-1)).toMatchObject({
      receipt_type: 'target_unknown',
      operation_result: 'post-write-verification-failed',
    });
  });

  it('classifies an ambiguous desired state without retrying PATCH', async () => {
    const client = new InMemoryClient([101]);
    const { plans, inputRegistry } = await makePlans(client, [record(101)]);
    client.writeResult = 'ambiguous';
    client.ambiguousState = 'desired';

    const receipts = await applyIssueBatch(applyInput(client, plans, inputRegistry));

    expect(client.updates).toHaveLength(1);
    expect(receiptFor(receipts, 101)).toMatchObject({
      receipt_type: 'target_verified',
      operation_result: 'applied-verified-after-ambiguous-response',
      diagnostic_code: 'transport-timeout',
    });
  });

  it.each([
    ['exact before', 'before'],
    ['third state', 'third'],
  ] as const)('records ambiguous %s as unknown and never retries', async (_name, state) => {
    const client = new InMemoryClient([101]);
    const { plans, inputRegistry } = await makePlans(client, [record(101)]);
    client.writeResult = 'ambiguous';
    client.ambiguousState = state;

    await expect(applyIssueBatch(applyInput(client, plans, inputRegistry)))
      .rejects.toMatchObject({ code: 'write-outcome-unknown', exitClass: 5 });
    expect(client.updates).toHaveLength(1);
    expect(parseLedger(readFileSync(ledgerPath, 'utf8')).at(-1)).toMatchObject({
      receipt_type: 'target_unknown',
      operation_result: 'write-outcome-unknown',
      diagnostic_code: 'transport-timeout',
    });
  });

  it('rejects reused idempotency keys and an identity-locked concurrent writer', async () => {
    const client = new InMemoryClient([101]);
    const { plans, inputRegistry } = await makePlans(client, [record(101)]);
    await applyIssueBatch(applyInput(client, plans, inputRegistry));

    await expect(applyIssueBatch(applyInput(client, plans, inputRegistry)))
      .rejects.toMatchObject({ code: 'idempotency-key-reused', exitClass: 3 });
    expect(client.updates).toHaveLength(1);

    const otherLedger = join(tempRoot, 'other.jsonl');
    const handle = acquireProcessLock(`${otherLedger}.lock`, {
      token: 'test-lock-owner',
    });
    try {
      await expect(applyIssueBatch(applyInput(client, plans, inputRegistry, {
        ledgerPath: otherLedger,
        idempotencyKey: 'review-batch-101-v2',
      }))).rejects.toMatchObject({ code: 'apply-lock-unavailable', exitClass: 3 });
    } finally {
      releaseProcessLock(handle);
    }
  });

  it('rejects broken ledgers and symlink ledger paths before mutation', async () => {
    const client = new InMemoryClient([101]);
    const { plans, inputRegistry } = await makePlans(client, [record(101)]);
    writeFileSync(ledgerPath, '{"broken":true}\n');
    await expect(applyIssueBatch(applyInput(client, plans, inputRegistry)))
      .rejects.toMatchObject({ code: 'ledger-invalid' });
    expect(client.updates).toEqual([]);

    const realLedger = join(tempRoot, 'real.jsonl');
    writeFileSync(realLedger, '');
    const linkedLedger = join(tempRoot, 'linked.jsonl');
    symlinkSync(realLedger, linkedLedger);
    await expect(applyIssueBatch(applyInput(client, plans, inputRegistry, {
      ledgerPath: linkedLedger,
      idempotencyKey: 'review-batch-101-v2',
    }))).rejects.toMatchObject({ code: 'ledger-path-unsafe', exitClass: 5 });
    expect(client.updates).toEqual([]);
  });

  it('surfaces a receipt append failure after a verified mutation', async () => {
    const client = new InMemoryClient([101]);
    const { plans, inputRegistry } = await makePlans(client, [record(101)]);
    client.afterUpdate = (issue) => {
      chmodSync(ledgerPath, 0o400);
      chmodSync(tempRoot, 0o500);
      return issue;
    };

    await expect(applyIssueBatch(applyInput(client, plans, inputRegistry)))
      .rejects.toMatchObject({ code: 'ledger-durability-failed', exitClass: 5 });
    expect(client.updates).toHaveLength(1);
    chmodSync(tempRoot, 0o700);
    chmodSync(ledgerPath, 0o600);
    expect(parseLedger(readFileSync(ledgerPath, 'utf8'))).toHaveLength(1);
  });

  it('rejects a directory ledger target without creating mutation state', async () => {
    const client = new InMemoryClient([101]);
    const { plans, inputRegistry } = await makePlans(client, [record(101)]);
    const directoryTarget = join(tempRoot, 'directory-ledger');
    mkdirSync(directoryTarget);

    await expect(applyIssueBatch(applyInput(client, plans, inputRegistry, {
      ledgerPath: directoryTarget,
    }))).rejects.toMatchObject({ code: 'ledger-path-unsafe', exitClass: 5 });
    expect(client.updates).toEqual([]);
  });
});
