import { createHash } from 'node:crypto';

import { z } from 'zod';

import { assertNoSecretLike } from '../../artifact-redaction.ts';
import { scanTextForPrivateLiterals } from '../../publication-guard.ts';
import { scanContentLines } from '../../repo-hygiene-guard.ts';

export const LIVE_LABELS = [
  'bug',
  'documentation',
  'duplicate',
  'enhancement',
  'good first issue',
  'help wanted',
  'invalid',
  'question',
  'wontfix',
  'reliability',
  'ops',
  'P0',
  'transport',
  'alerts',
  'launchd',
  'dependencies',
  'javascript',
  'audit',
  'security',
  'accessibility',
  'console',
  'chat',
  'config',
  'media',
  'scheduler',
  'mcp',
  'fleet',
  'refactor',
  'DRY',
  'SSOT',
  'tech-debt',
  'type-safety',
  'dead-code',
  'SOC',
  'portability',
  'linux',
] as const;

export const ADDABLE_LABELS = [
  'bug',
  'enhancement',
  'refactor',
  'documentation',
  'alerts',
  'chat',
  'config',
  'console',
  'fleet',
  'mcp',
  'ops',
  'scheduler',
  'transport',
  'audit',
  'reliability',
  'security',
  'portability',
  'tech-debt',
  'type-safety',
  'DRY',
  'SOC',
  'SSOT',
  'dead-code',
  'duplicate',
  'invalid',
] as const;

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

const liveLabelSet = new Set<string>(LIVE_LABELS);
const addableLabelSet = new Set<string>(ADDABLE_LABELS);

const nonEmptyTextSchema = z.string().min(1).max(16_384).refine(
  (value) => /\S/u.test(value),
  'text must contain a non-whitespace character',
);
const boundedTextSchema = z.string().max(16_384);
const shortTextSchema = z.string().min(1).max(1_024).refine(
  (value) => /\S/u.test(value),
  'text must contain a non-whitespace character',
);
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/);
const timestampSchema = z.string().datetime({ offset: false });
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function isSortedUnique<T>(values: readonly T[], compare: (left: T, right: T) => number): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1], value) < 0);
}

function sortedUniqueStringArray(schema: z.ZodType<string> = shortTextSchema) {
  return z.array(schema).superRefine((values, context) => {
    if (!isSortedUnique(values, compareUtf8)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'list must be sorted by UTF-8 byte order without duplicates',
      });
    }
  });
}

function sortedUniqueIntegerArray() {
  return z.array(positiveIntegerSchema).superRefine((values, context) => {
    if (!isSortedUnique(values, (left, right) => left - right)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'list must be numerically sorted without duplicates',
      });
    }
  });
}

const repositoryPathSchema = z.string().min(1).max(1_024).refine((value) => {
  if (
    !/\S/u.test(value)
    || value.startsWith('/')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}, 'repository path must be a safe relative POSIX path');

const issueUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
      && /^\/LucasQuiles\/WhatSoup\/issues\/[1-9]\d*$/.test(url.pathname);
  } catch {
    return false;
  }
}, 'URL must identify an issue in LucasQuiles/WhatSoup over HTTPS');

const pullRequestUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
      && /^\/LucasQuiles\/WhatSoup\/pull\/[1-9]\d*$/.test(url.pathname);
  } catch {
    return false;
  }
}, 'URL must identify a pull request in LucasQuiles/WhatSoup over HTTPS');

const gitRefSchema = z.string().min(1).max(255).refine((value) => {
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(value)) return false;
  if (value === '@' || value.startsWith('-')) return false;
  if (value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  if (value.includes('..') || value.includes('@{') || value.includes('//')) return false;
  return value.split('/').every((part) =>
    part !== ''
    && !part.startsWith('.')
    && !part.endsWith('.lock'));
}, 'ref must be a safe Git reference name');

const labelListSchema = sortedUniqueStringArray(shortTextSchema);
const liveLabelListSchema = labelListSchema.refine(
  (labels) => labels.every((label) => liveLabelSet.has(label)),
  'list contains a label outside the live repository catalogue',
);
const addableLabelListSchema = labelListSchema.refine(
  (labels) => labels.every((label) => addableLabelSet.has(label)),
  'list contains a label that the triage tool cannot add',
);
const pathListSchema = sortedUniqueStringArray(repositoryPathSchema);
const issueNumberListSchema = sortedUniqueIntegerArray();
const textListSchema = z.array(nonEmptyTextSchema).max(1_000);

const matchedBySchema = sortedUniqueStringArray(z.enum([
  'issue-reference',
  'closing-reference',
  'touched-path',
  'acceptance-criteria',
])).refine((values) => values.length > 0, 'matched_by must be nonempty');

const pullRequestOverlapSchema = z.object({
  number: positiveIntegerSchema,
  title: nonEmptyTextSchema,
  url: pullRequestUrlSchema,
  updated_at: timestampSchema,
  disposition: z.enum(['open', 'merged', 'closed-unmerged']),
  is_draft: z.boolean(),
  head_ref: gitRefSchema,
  base_ref: gitRefSchema,
  matched_by: matchedBySchema,
  overlapping_paths: pathListSchema,
  assessment: z.enum(['owns', 'partial', 'collision-only', 'historical-attempt']),
}).strict().superRefine((overlap, context) => {
  if (overlap.url !== `https://github.com/LucasQuiles/WhatSoup/pull/${overlap.number}`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: 'pull request URL must match overlap number exactly',
    });
  }
});

const pullRequestOverlapListSchema = z.array(pullRequestOverlapSchema).superRefine((values, context) => {
  if (!isSortedUnique(values, (left, right) => left.number - right.number)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'pull request overlaps must be sorted by number without duplicates',
    });
  }
});

const partialFindingSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
  summary: nonEmptyTextSchema,
  disposition: z.enum([
    'survives',
    'fixed',
    'stale',
    'duplicate',
    'separately-owned',
    'measurement-required',
    'live-revalidation-required',
  ]),
  related_issue_number: positiveIntegerSchema.nullable(),
}).strict();

const partialFindingListSchema = z.array(partialFindingSchema).superRefine((values, context) => {
  if (!isSortedUnique(values, (left, right) => compareUtf8(left.key, right.key))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'partial findings must be sorted by key without duplicates',
    });
  }
});

const issueSchema = z.object({
  issue_number: positiveIntegerSchema,
  issue_node_id: shortTextSchema,
  title: nonEmptyTextSchema,
  recommended_title: nonEmptyTextSchema.nullable(),
  url: issueUrlSchema,
  updated_at: timestampSchema,
  pre_review_body_sha256: sha256Schema,
  current_labels: labelListSchema,
  recommended_labels: labelListSchema,
  classification: z.enum(['leaf', 'tracker', 'duplicate', 'stale', 'measurement-only']),
  evidence_state: z.enum([
    'verified',
    'partial',
    'measurement-required',
    'contradicted',
    'live-revalidation-required',
    'inconclusive',
  ]),
  pinned_revision: revisionSchema,
  decisive_source_paths: pathListSchema,
  decisive_test_paths: pathListSchema,
  evidence_summary: nonEmptyTextSchema,
  falsifier_or_remaining_gap: boundedTextSchema,
  partial_findings: partialFindingListSchema,
  suggested_remediation: nonEmptyTextSchema,
  impact: nonEmptyTextSchema,
  blast_radius: nonEmptyTextSchema,
  affected_paths: pathListSchema,
  owner_boundary: shortTextSchema.nullable(),
  acceptance_criteria: textListSchema,
  dependency_issue_numbers: issueNumberListSchema,
  duplicate_of_issue_number: positiveIntegerSchema.nullable(),
  implementation_after_issue_numbers: issueNumberListSchema,
  pull_request_overlaps: pullRequestOverlapListSchema,
  proposed_cohort_id: slugSchema.nullable(),
  pull_request_owner_pr_number: positiveIntegerSchema.nullable(),
  review_confidence: z.enum(['high', 'medium', 'low']),
  lead_verification_obligations: textListSchema,
}).strict();

const inventorySchema = z.object({
  captured_at: timestampSchema,
  open_issue_count: nonNegativeIntegerSchema,
  open_pull_request_count: nonNegativeIntegerSchema,
  draft_pull_request_count: nonNegativeIntegerSchema,
  label_count: nonNegativeIntegerSchema,
  labels: labelListSchema,
}).strict();

const registrySchema = z.object({
  schema_version: z.literal(1),
  repository: z.literal('LucasQuiles/WhatSoup'),
  generated_at: timestampSchema,
  pinned_main_revision: revisionSchema,
  inventory: inventorySchema,
  issues: z.array(issueSchema),
}).strict();

export type OpenIssueRegistry = z.infer<typeof registrySchema>;
export type PullRequestOverlap = z.infer<typeof pullRequestOverlapSchema>;
export type PartialFinding = z.infer<typeof partialFindingSchema>;

const receiptSnapshotSchema = z.object({
  updated_at: timestampSchema,
  body_sha256: sha256Schema,
  title_sha256: sha256Schema,
  labels: liveLabelListSchema,
}).strict();

const expectedReceiptSnapshotSchema = receiptSnapshotSchema.omit({ updated_at: true }).strict();

const titleDeltaSchema = z.object({
  before_sha256: sha256Schema,
  after_sha256: sha256Schema,
  changed: z.boolean(),
}).strict();

const labelDeltaSchema = z.object({
  add: addableLabelListSchema,
  remove: liveLabelListSchema,
}).strict();

const receiptEnvelopeShape = {
  schema_version: z.literal(1),
  operation_id: slugSchema,
  batch_id: sha256Schema,
  sequence: positiveIntegerSchema,
  pinned_main_revision: revisionSchema,
  previous_receipt_sha256: sha256Schema.nullable(),
};

const targetReceiptShape = {
  ...receiptEnvelopeShape,
  issue_number: positiveIntegerSchema,
  issue_node_id: shortTextSchema,
  planned_at: timestampSchema,
  applied_at: timestampSchema.nullable(),
  verified_at: timestampSchema.nullable(),
  before: receiptSnapshotSchema,
  expected_after: expectedReceiptSnapshotSchema,
  title_delta: titleDeltaSchema,
  label_delta: labelDeltaSchema,
  diagnostic_code: slugSchema.nullable(),
};

const batchStartedWithoutHashSchema = z.object({
  ...receiptEnvelopeShape,
  receipt_type: z.literal('batch_started'),
  planned_at: timestampSchema,
  plan_sha256: sha256Schema,
  registry_sha256: sha256Schema,
  issue_numbers: issueNumberListSchema.refine((values) => values.length > 0, 'issue_numbers must be nonempty'),
  operation_result: z.literal('planned'),
  diagnostic_code: z.null(),
}).strict();

const targetVerifiedWithoutHashSchema = z.object({
  ...targetReceiptShape,
  receipt_type: z.literal('target_verified'),
  operation_result: z.enum([
    'planned',
    'no-op',
    'applied-verified',
    'applied-verified-after-ambiguous-response',
  ]),
}).strict();

const targetUnknownWithoutHashSchema = z.object({
  ...targetReceiptShape,
  receipt_type: z.literal('target_unknown'),
  operation_result: z.enum([
    'refused-concurrent-update',
    'failed-before-write',
    'write-outcome-unknown',
    'post-write-verification-failed',
  ]),
}).strict();

const batchCompletedWithoutHashSchema = z.object({
  ...receiptEnvelopeShape,
  receipt_type: z.literal('batch_completed'),
  planned_at: timestampSchema,
  completed_at: timestampSchema,
  target_count: positiveIntegerSchema,
  verified_count: nonNegativeIntegerSchema,
  unknown_count: nonNegativeIntegerSchema,
  operation_result: z.enum(['no-op', 'applied-verified']),
  diagnostic_code: z.null(),
}).strict();

const receiptWithoutHashUnion = z.discriminatedUnion('receipt_type', [
  batchStartedWithoutHashSchema,
  targetVerifiedWithoutHashSchema,
  targetUnknownWithoutHashSchema,
  batchCompletedWithoutHashSchema,
]);

type ParsedReceiptWithoutHash = z.infer<typeof receiptWithoutHashUnion>;
type ParsedTargetReceiptWithoutHash = Extract<
  ParsedReceiptWithoutHash,
  { receipt_type: 'target_verified' | 'target_unknown' }
>;

function isStrictNoOp(receipt: ParsedTargetReceiptWithoutHash): boolean {
  return receipt.before.body_sha256 === receipt.expected_after.body_sha256
    && receipt.before.title_sha256 === receipt.expected_after.title_sha256
    && JSON.stringify(receipt.before.labels) === JSON.stringify(receipt.expected_after.labels)
    && receipt.title_delta.before_sha256 === receipt.title_delta.after_sha256
    && receipt.title_delta.changed === false
    && receipt.label_delta.add.length === 0
    && receipt.label_delta.remove.length === 0;
}

function validateReceiptSemantics(
  receipt: ParsedReceiptWithoutHash,
  context: z.RefinementCtx,
): void {
  const addIssue = (message: string, path: string): void => {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };

  if (receipt.receipt_type === 'batch_completed') {
    if (receipt.verified_count + receipt.unknown_count !== receipt.target_count) {
      addIssue('verified_count plus unknown_count must equal target_count', 'target_count');
    }
    if (receipt.unknown_count !== 0) {
      addIssue('a completed batch cannot contain unknown targets', 'unknown_count');
    }
    return;
  }
  if (receipt.receipt_type === 'batch_started') return;

  const applied = receipt.applied_at !== null;
  const verified = receipt.verified_at !== null;
  const diagnosed = receipt.diagnostic_code !== null;
  const coherent = (() => {
    switch (receipt.operation_result) {
      case 'planned':
        return !applied && !verified && !diagnosed;
      case 'no-op':
        return !applied && verified && !diagnosed;
      case 'applied-verified':
        return applied && verified && !diagnosed;
      case 'applied-verified-after-ambiguous-response':
        return applied && verified && diagnosed;
      case 'refused-concurrent-update':
      case 'failed-before-write':
        return !applied && !verified && diagnosed;
      case 'write-outcome-unknown':
      case 'post-write-verification-failed':
        return applied && !verified && diagnosed;
    }
  })();
  if (!coherent) {
    addIssue(
      `timestamps and diagnostic_code are inconsistent with ${receipt.operation_result}`,
      'operation_result',
    );
  }
  if (receipt.operation_result === 'no-op' && !isStrictNoOp(receipt)) {
    addIssue('no-op requires exact before/after snapshots and empty deltas', 'operation_result');
  }
}

const receiptWithoutHashSchema = receiptWithoutHashUnion.superRefine(validateReceiptSemantics);

const batchStartedSchema = batchStartedWithoutHashSchema.extend({ receipt_sha256: sha256Schema }).strict();
const targetVerifiedSchema = targetVerifiedWithoutHashSchema.extend({ receipt_sha256: sha256Schema }).strict();
const targetUnknownSchema = targetUnknownWithoutHashSchema.extend({ receipt_sha256: sha256Schema }).strict();
const batchCompletedSchema = batchCompletedWithoutHashSchema.extend({ receipt_sha256: sha256Schema }).strict();

const mutationReceiptSchema = z.discriminatedUnion('receipt_type', [
  batchStartedSchema,
  targetVerifiedSchema,
  targetUnknownSchema,
  batchCompletedSchema,
]).superRefine(validateReceiptSemantics);

export type MutationReceiptWithoutHash = z.infer<typeof receiptWithoutHashSchema>;
export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;

export interface ValidationIssue {
  issue_number: number | null;
  code: string;
  field: string;
  message: string;
}

export function parseRegistry(value: unknown): OpenIssueRegistry {
  const registry = registrySchema.parse(value);
  const text = canonicalRegistryJson(registry);
  const filePath = 'docs/triage/open-issue-registry.json';
  const publicationIssues = scanTextForPrivateLiterals(filePath, text);
  const hygieneIssues = scanContentLines(
    text.split('\n').map((line, index) => ({ filePath, line: index + 1, text: line })),
  );
  const issues = [...publicationIssues, ...hygieneIssues];
  if (issues.length > 0) {
    throw new Error(
      `PUBLIC registry rejected: ${issues.map((issue) => `${issue.code}@${issue.line ?? 1}`).join(', ')}`,
    );
  }
  assertNoSecretLike(text, 'open issue registry');
  return registry;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function canonicalRegistryJson(registry: OpenIssueRegistry): string {
  return `${JSON.stringify(canonicalize(registry))}\n`;
}

export function registrySha256(registry: OpenIssueRegistry): string {
  return sha256(canonicalRegistryJson(registry));
}

export function receiptSha256(receiptWithoutHash: unknown): string {
  const parsed = receiptWithoutHashSchema.parse(receiptWithoutHash);
  return sha256(`${JSON.stringify(canonicalize(parsed))}\n`);
}

export function parseLedger(text: string): MutationReceipt[] {
  if (text !== '' && !text.endsWith('\n')) {
    throw new Error('a nonempty ledger must end with LF');
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.some((line) => line.length === 0)) {
    throw new Error('ledger contains a blank JSONL line');
  }

  const receipts = lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`ledger line ${index + 1} is not valid JSON`, { cause: error });
    }

    try {
      return mutationReceiptSchema.parse(parsed);
    } catch (error) {
      throw new Error(`ledger line ${index + 1} violates the receipt schema: ${String(error)}`, {
        cause: error,
      });
    }
  });

  for (const [index, receipt] of receipts.entries()) {
    const { receipt_sha256: observedHash, ...withoutHash } = receipt;
    const expectedHash = receiptSha256(withoutHash);
    if (observedHash !== expectedHash) {
      throw new Error(`ledger line ${index + 1} has an invalid receipt_sha256`);
    }
    const previous = receipts[index - 1];
    const expectedSequence = index + 1;
    const expectedPreviousHash = previous?.receipt_sha256 ?? null;
    if (receipt.sequence !== expectedSequence) {
      throw new Error(`ledger line ${index + 1} has a non-consecutive global sequence`);
    }
    if (receipt.previous_receipt_sha256 !== expectedPreviousHash) {
      throw new Error(`ledger line ${index + 1} has a broken previous_receipt_sha256 chain`);
    }
  }

  interface ActiveBatch {
    batchId: string;
    operationId: string;
    pinnedMainRevision: string;
    plannedAt: string;
    issueNumbers: number[];
    targetIndex: number;
    pendingRecovery: Extract<MutationReceipt, { receipt_type: 'target_unknown' }> | null;
    verifiedResults: Array<
      Extract<MutationReceipt, { receipt_type: 'target_verified' }>['operation_result']
    >;
  }

  let active: ActiveBatch | null = null;
  let priorCompletedBatchId: string | null = null;

  for (const [index, receipt] of receipts.entries()) {
    const lineNumber = index + 1;
    if (receipt.receipt_type === 'batch_started') {
      if (active !== null) {
        throw new Error(`ledger line ${lineNumber} starts a batch after an unfinished batch`);
      }
      if (priorCompletedBatchId !== null && receipt.batch_id === priorCompletedBatchId) {
        throw new Error(`ledger line ${lineNumber} reuses the prior completed batch_id`);
      }
      active = {
        batchId: receipt.batch_id,
        operationId: receipt.operation_id,
        pinnedMainRevision: receipt.pinned_main_revision,
        plannedAt: receipt.planned_at,
        issueNumbers: receipt.issue_numbers,
        targetIndex: 0,
        pendingRecovery: null,
        verifiedResults: [],
      };
      continue;
    }

    if (active === null) {
      throw new Error(`ledger line ${lineNumber} appears outside an active batch`);
    }
    if (receipt.batch_id !== active.batchId) {
      throw new Error(`ledger line ${lineNumber} changes batch_id inside an active batch`);
    }
    if (receipt.operation_id !== active.operationId) {
      throw new Error(`ledger line ${lineNumber} changes operation_id inside an active batch`);
    }
    if (receipt.pinned_main_revision !== active.pinnedMainRevision) {
      throw new Error(`ledger line ${lineNumber} changes pinned_main_revision inside an active batch`);
    }
    if (receipt.planned_at !== active.plannedAt) {
      throw new Error(`ledger line ${lineNumber} changes planned_at inside an active batch`);
    }

    if (active.pendingRecovery !== null) {
      if (receipt.receipt_type !== 'target_verified') {
        throw new Error(`ledger line ${lineNumber} must exactly recover the pending target_unknown`);
      }
      validateTargetDelta(receipt, lineNumber);
      validateTargetRecovery(active.pendingRecovery, receipt, lineNumber);
      active.pendingRecovery = null;
      active.targetIndex += 1;
      active.verifiedResults.push(receipt.operation_result);
      continue;
    }

    if (receipt.receipt_type === 'batch_completed') {
      if (active.targetIndex !== active.issueNumbers.length) {
        throw new Error(`ledger line ${lineNumber} completes before all declared targets`);
      }
      if (receipt.target_count !== active.issueNumbers.length
        || receipt.verified_count !== active.targetIndex
        || receipt.unknown_count !== 0) {
        throw new Error(`ledger line ${lineNumber} has completion counts inconsistent with the batch`);
      }
      if (active.verifiedResults.includes('planned')) {
        throw new Error(`ledger line ${lineNumber} completes a batch containing a planned target`);
      }
      const expectedResult = active.verifiedResults.some(
        (result) => result === 'applied-verified'
          || result === 'applied-verified-after-ambiguous-response',
      )
        ? 'applied-verified'
        : 'no-op';
      if (receipt.operation_result !== expectedResult) {
        throw new Error(
          `ledger line ${lineNumber} has completion result ${receipt.operation_result}; expected ${expectedResult}`,
        );
      }
      priorCompletedBatchId = active.batchId;
      active = null;
      continue;
    }

    const expectedIssueNumber = active.issueNumbers[active.targetIndex];
    if (receipt.issue_number !== expectedIssueNumber) {
      throw new Error(
        `ledger line ${lineNumber} has target ${receipt.issue_number}; expected ${expectedIssueNumber ?? 'none'}`,
      );
    }
    validateTargetDelta(receipt, lineNumber);
    if (receipt.receipt_type === 'target_unknown') {
      active.pendingRecovery = receipt;
    } else {
      active.targetIndex += 1;
      active.verifiedResults.push(receipt.operation_result);
    }
  }

  return receipts;
}

function validateTargetDelta(
  receipt: Extract<MutationReceipt, { receipt_type: 'target_verified' | 'target_unknown' }>,
  lineNumber: number,
): void {
  if (receipt.title_delta.before_sha256 !== receipt.before.title_sha256
    || receipt.title_delta.after_sha256 !== receipt.expected_after.title_sha256
    || receipt.title_delta.changed
      !== (receipt.title_delta.before_sha256 !== receipt.title_delta.after_sha256)) {
    throw new Error(`ledger line ${lineNumber} has an inconsistent title_delta`);
  }

  const beforeLabels = new Set(receipt.before.labels);
  const expectedLabels = new Set(receipt.expected_after.labels);
  const expectedAdds = receipt.expected_after.labels.filter((label) => !beforeLabels.has(label));
  const expectedRemoves = receipt.before.labels.filter((label) => !expectedLabels.has(label));
  if (JSON.stringify(receipt.label_delta.add) !== JSON.stringify(expectedAdds)
    || JSON.stringify(receipt.label_delta.remove) !== JSON.stringify(expectedRemoves)) {
    throw new Error(`ledger line ${lineNumber} has an inconsistent label_delta`);
  }
}

function validateTargetRecovery(
  unknown: Extract<MutationReceipt, { receipt_type: 'target_unknown' }>,
  verified: Extract<MutationReceipt, { receipt_type: 'target_verified' }>,
  lineNumber: number,
): void {
  const exactRecovery = unknown.issue_number === verified.issue_number
    && unknown.issue_node_id === verified.issue_node_id
    && JSON.stringify(canonicalize(unknown.before)) === JSON.stringify(canonicalize(verified.before))
    && JSON.stringify(canonicalize(unknown.expected_after))
      === JSON.stringify(canonicalize(verified.expected_after))
    && JSON.stringify(canonicalize(unknown.title_delta))
      === JSON.stringify(canonicalize(verified.title_delta))
    && JSON.stringify(canonicalize(unknown.label_delta))
      === JSON.stringify(canonicalize(verified.label_delta));
  if (!exactRecovery) {
    throw new Error(`ledger line ${lineNumber} does not exactly recover the pending target snapshot and deltas`);
  }

  const expectedResult = (() => {
    switch (unknown.operation_result) {
      case 'write-outcome-unknown':
      case 'post-write-verification-failed':
        return 'applied-verified-after-ambiguous-response';
      case 'failed-before-write':
        return 'applied-verified';
      case 'refused-concurrent-update':
        return 'no-op';
    }
  })();
  if (verified.operation_result !== expectedResult) {
    throw new Error(
      `ledger line ${lineNumber} has recovery result ${verified.operation_result}; expected ${expectedResult}`,
    );
  }
  if (unknown.operation_result === 'refused-concurrent-update' && !isStrictNoOp(verified)) {
    throw new Error(`ledger line ${lineNumber} must recover refused-concurrent-update as a strict no-op`);
  }
}

function finding(
  issueNumber: number | null,
  code: string,
  field: string,
  message: string,
): ValidationIssue {
  return { issue_number: issueNumber, code, field, message };
}

function compareFindings(left: ValidationIssue, right: ValidationIssue): number {
  const issueComparison = (left.issue_number ?? -1) - (right.issue_number ?? -1);
  if (issueComparison !== 0) return issueComparison;
  const codeComparison = compareUtf8(left.code, right.code);
  return codeComparison !== 0 ? codeComparison : compareUtf8(left.field, right.field);
}

function findImplementationCycles(registry: OpenIssueRegistry): number[] {
  const openIssueNumbers = new Set(registry.issues.map((issue) => issue.issue_number));
  const edges = new Map<number, number[]>();
  for (const issue of registry.issues) {
    edges.set(
      issue.issue_number,
      issue.implementation_after_issue_numbers.filter(
        (number) => number !== issue.issue_number && openIssueNumbers.has(number),
      ),
    );
  }

  const state = new Map<number, 'visiting' | 'visited'>();
  const stack: number[] = [];
  const cyclic = new Set<number>();

  const visit = (issueNumber: number): void => {
    const currentState = state.get(issueNumber);
    if (currentState === 'visited') return;
    if (currentState === 'visiting') {
      const cycleStart = stack.lastIndexOf(issueNumber);
      for (const member of stack.slice(cycleStart)) cyclic.add(member);
      return;
    }

    state.set(issueNumber, 'visiting');
    stack.push(issueNumber);
    for (const dependency of edges.get(issueNumber) ?? []) visit(dependency);
    stack.pop();
    state.set(issueNumber, 'visited');
  };

  for (const issueNumber of [...openIssueNumbers].sort((left, right) => left - right)) {
    visit(issueNumber);
  }
  return [...cyclic].sort((left, right) => left - right);
}

export function validateRegistry(registry: OpenIssueRegistry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (registry.inventory.open_issue_count !== registry.issues.length) {
    issues.push(finding(
      null,
      'baseline-count-mismatch',
      'inventory.open_issue_count',
      'inventory.open_issue_count must equal the number of registry issues',
    ));
  }
  if (registry.inventory.label_count !== registry.inventory.labels.length) {
    issues.push(finding(
      null,
      'label-count-mismatch',
      'inventory.label_count',
      'inventory.label_count must equal the number of inventory labels',
    ));
  }
  if (registry.inventory.draft_pull_request_count > registry.inventory.open_pull_request_count) {
    issues.push(finding(
      null,
      'draft-pull-request-count-mismatch',
      'inventory.draft_pull_request_count',
      'draft pull request count cannot exceed open pull request count',
    ));
  }
  for (const label of registry.inventory.labels) {
    if (!liveLabelSet.has(label)) {
      issues.push(finding(null, 'unknown-inventory-label', 'inventory.labels', `unknown live label: ${label}`));
    }
  }

  const issueCounts = new Map<number, number>();
  for (const issue of registry.issues) {
    issueCounts.set(issue.issue_number, (issueCounts.get(issue.issue_number) ?? 0) + 1);
  }
  for (const [issueNumber, count] of issueCounts) {
    if (count > 1) {
      issues.push(finding(
        issueNumber,
        'duplicate-issue-number',
        'issue_number',
        `issue number ${issueNumber} occurs ${count} times`,
      ));
    }
  }

  for (const issue of registry.issues) {
    const currentLabels = new Set(issue.current_labels);
    const recommendedLabels = new Set(issue.recommended_labels);
    const recommendedLabelsAreKnown = issue.recommended_labels.every((label) => liveLabelSet.has(label));
    const addIssueFinding = (code: string, field: string, message: string): void => {
      issues.push(finding(issue.issue_number, code, field, message));
    };

    for (const label of issue.current_labels) {
      if (!liveLabelSet.has(label)) {
        issues.push(finding(issue.issue_number, 'unknown-current-label', 'current_labels', `unknown live label: ${label}`));
      }
      if (recommendedLabelsAreKnown && !recommendedLabels.has(label)) {
        issues.push(finding(
          issue.issue_number,
          'current-label-not-recommended',
          'recommended_labels',
          `current label must remain recommended: ${label}`,
        ));
      }
    }
    for (const label of issue.recommended_labels) {
      if (!liveLabelSet.has(label)) {
        issues.push(finding(
          issue.issue_number,
          'unknown-recommended-label',
          'recommended_labels',
          `unknown live label: ${label}`,
        ));
      } else if (!currentLabels.has(label) && !addableLabelSet.has(label)) {
        issues.push(finding(
          issue.issue_number,
          'non-addable-recommended-label',
          'recommended_labels',
          `live label is preserved but cannot be newly added: ${label}`,
        ));
      }
    }

    if (issue.url !== `https://github.com/LucasQuiles/WhatSoup/issues/${issue.issue_number}`) {
      issues.push(finding(
        issue.issue_number,
        'issue-url-mismatch',
        'url',
        'issue URL must match issue_number exactly',
      ));
    }
    if (issue.pinned_revision !== registry.pinned_main_revision) {
      issues.push(finding(
        issue.issue_number,
        'pinned-revision-mismatch',
        'pinned_revision',
        'issue pinned_revision must match registry pinned_main_revision',
      ));
    }

    if (issue.classification === 'leaf') {
      if (issue.owner_boundary === null || issue.owner_boundary.length === 0) {
        addIssueFinding('leaf-owner-boundary-required', 'owner_boundary', 'leaf issues require one owner boundary');
      }
      if (issue.affected_paths.length === 0) {
        addIssueFinding('leaf-affected-paths-required', 'affected_paths', 'leaf issues require affected paths');
      }
      if (issue.acceptance_criteria.length === 0) {
        addIssueFinding(
          'leaf-acceptance-criteria-required',
          'acceptance_criteria',
          'leaf issues require acceptance criteria',
        );
      }
      if (issue.falsifier_or_remaining_gap.length === 0) {
        addIssueFinding(
          'leaf-falsifier-or-remaining-gap-required',
          'falsifier_or_remaining_gap',
          'leaf issues require a falsifier or remaining evidence gap',
        );
      }
    }

    if (issue.classification === 'duplicate') {
      if (issue.duplicate_of_issue_number === null) {
        addIssueFinding(
          'duplicate-target-required',
          'duplicate_of_issue_number',
          'duplicate issues require a duplicate target',
        );
      }
    } else if (issue.duplicate_of_issue_number !== null) {
      addIssueFinding(
        'duplicate-target-forbidden',
        'duplicate_of_issue_number',
        'only duplicate issues may name a duplicate target',
      );
    }

    if (issue.classification === 'stale' && issue.evidence_state !== 'contradicted') {
      addIssueFinding(
        'stale-evidence-state',
        'evidence_state',
        'stale issues require contradicted evidence',
      );
    }

    const measurementEvidenceStates: ReadonlySet<EvidenceState> = new Set([
      'measurement-required',
      'live-revalidation-required',
      'inconclusive',
    ]);
    if (issue.classification === 'measurement-only'
      && !measurementEvidenceStates.has(issue.evidence_state)) {
      addIssueFinding(
        'measurement-only-evidence-state',
        'evidence_state',
        'measurement-only issues require measurement, live revalidation, or inconclusive evidence',
      );
    }

    if (issue.evidence_state === 'partial') {
      if (issue.partial_findings.length === 0) {
        addIssueFinding(
          'partial-findings-required',
          'partial_findings',
          'partial evidence requires at least one partial finding',
        );
      }
    } else if (issue.partial_findings.length > 0) {
      addIssueFinding(
        'partial-findings-forbidden',
        'partial_findings',
        'partial findings are allowed only for partial evidence',
      );
    }

    if (issue.classification !== 'leaf') {
      if (issue.proposed_cohort_id !== null) {
        addIssueFinding(
          `${issue.classification}-cohort-forbidden`,
          'proposed_cohort_id',
          `${issue.classification} issues cannot own an implementation cohort`,
        );
      }
      if (issue.pull_request_owner_pr_number !== null) {
        addIssueFinding(
          `${issue.classification}-pr-owner-forbidden`,
          'pull_request_owner_pr_number',
          `${issue.classification} issues cannot own an implementation pull request`,
        );
      }
    }

    if (issue.proposed_cohort_id !== null) {
      if (issue.pull_request_owner_pr_number === null) {
        addIssueFinding(
          'cohort-pr-owner-required',
          'pull_request_owner_pr_number',
          'a proposed cohort requires a pull request owner',
        );
      }
      if (issue.pull_request_overlaps.some(
        (overlap) => overlap.disposition === 'open' && overlap.assessment === 'owns',
      )) {
        addIssueFinding(
          'cohort-open-owner-overlap',
          'pull_request_overlaps',
          'a new cohort cannot be proposed while an open overlap owns the work',
        );
      }
    } else if (issue.pull_request_owner_pr_number !== null) {
      addIssueFinding(
        'pr-owner-without-cohort',
        'pull_request_owner_pr_number',
        'a pull request owner requires a proposed cohort',
      );
    }

    if (issue.dependency_issue_numbers.includes(issue.issue_number)) {
      issues.push(finding(
        issue.issue_number,
        'self-dependency',
        'dependency_issue_numbers',
        'an issue cannot depend on itself',
      ));
    }
    if (issue.duplicate_of_issue_number === issue.issue_number) {
      issues.push(finding(
        issue.issue_number,
        'self-duplicate',
        'duplicate_of_issue_number',
        'an issue cannot be a duplicate of itself',
      ));
    }
    if (issue.implementation_after_issue_numbers.includes(issue.issue_number)) {
      issues.push(finding(
        issue.issue_number,
        'self-implementation-order',
        'implementation_after_issue_numbers',
        'an issue cannot be ordered after itself',
      ));
    }
    for (const partialFinding of issue.partial_findings) {
      if (partialFinding.related_issue_number === issue.issue_number) {
        addIssueFinding(
          'self-partial-finding-reference',
          'partial_findings',
          'a partial finding cannot reference its own issue',
        );
      }
    }
    if (issue.pull_request_owner_pr_number !== null
      && issue.pull_request_overlaps.some(
        (overlap) => overlap.number === issue.pull_request_owner_pr_number,
      )) {
      issues.push(finding(
        issue.issue_number,
        'owner-pr-listed-as-overlap',
        'pull_request_overlaps',
        'the owner pull request cannot also be listed as an overlap',
      ));
    }
  }

  for (const issueNumber of findImplementationCycles(registry)) {
    issues.push(finding(
      issueNumber,
      'implementation-order-cycle',
      'implementation_after_issue_numbers',
      'open implementation-order relationships must be acyclic',
    ));
  }

  return issues.sort(compareFindings);
}
