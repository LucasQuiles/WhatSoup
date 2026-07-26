import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  acquireProcessLock,
  isProcessLockError,
  releaseProcessLock,
  type ProcessLockHandle,
} from '../../../src/lib/process-lock.ts';
import { mergeReviewBlock, renderReviewBlock } from './body.ts';
import type {
  GitHubIssueClient,
  GitHubWriteResult,
  LiveIssue,
} from './github.ts';
import {
  parseLedger,
  parseRegistry,
  receiptSha256,
  registrySha256,
  sha256,
  validateRegistry,
  type MutationReceipt,
  type MutationReceiptWithoutHash,
  type OpenIssueRegistry,
} from './model.ts';
import type { IssueMutationPlan } from './planner.ts';

const REPOSITORY = 'LucasQuiles/WhatSoup';
const MINIMUM_MUTATION_DELAY_MS = 1_000;
const INTENT_MARKER = /^<!-- triage-review:intent-sha256=([0-9a-f]{64}) -->$/gm;

export type ApplyIssueBatchErrorCode =
  | 'invalid-apply-input'
  | 'plan-digest-mismatch'
  | 'plan-registry-mismatch'
  | 'registry-digest-mismatch'
  | 'main-sha-drift'
  | 'precondition-drift'
  | 'apply-lock-unavailable'
  | 'apply-lock-release-failed'
  | 'ledger-path-unsafe'
  | 'ledger-invalid'
  | 'ledger-durability-failed'
  | 'idempotency-key-reused'
  | 'write-failed-before-response'
  | 'write-outcome-unknown'
  | 'post-write-verification-failed';

export class ApplyIssueBatchError extends Error {
  readonly code: ApplyIssueBatchErrorCode;
  readonly exitClass: 3 | 5;
  readonly issueNumber: number | null;
  readonly retryable: boolean;

  constructor(
    code: ApplyIssueBatchErrorCode,
    message: string,
    options: {
      exitClass: 3 | 5;
      issueNumber?: number;
      cause?: unknown;
      retryable?: boolean;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApplyIssueBatchError';
    this.code = code;
    this.exitClass = options.exitClass;
    this.issueNumber = options.issueNumber ?? null;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      exitClass: this.exitClass,
      issueNumber: this.issueNumber,
      retryable: this.retryable,
    };
  }
}

export interface ApplyIssueBatchInput {
  expectedMainSha: string;
  plans: unknown;
  registry: unknown;
  client: GitHubIssueClient;
  ledgerPath: string;
  now: () => string;
  delay: (milliseconds: number) => Promise<void>;
  confirmedPlanSha256: string;
  idempotencyKey: string;
}

interface PreparedTarget {
  plan: IssueMutationPlan;
  before: LiveIssue;
  desiredBody: string;
}

function fail(
  code: ApplyIssueBatchErrorCode,
  message: string,
  exitClass: 3 | 5,
  issueNumber?: number,
  cause?: unknown,
  retryable = false,
): ApplyIssueBatchError {
  return new ApplyIssueBatchError(code, message, {
    exitClass,
    issueNumber,
    cause,
    retryable,
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compareUtf8);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
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

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function planDigest(plans: readonly IssueMutationPlan[]): string {
  return sha256(canonicalJson(
    plans.map(({ plan_sha256: _planSha256, ...plan }) => plan),
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw fail('plan-registry-mismatch', `${label} must be an object`, 3);
  }
  const observed = Object.keys(value).sort(compareUtf8);
  const expected = [...expectedKeys].sort(compareUtf8);
  if (!sameStrings(observed, expected)) {
    throw fail('plan-registry-mismatch', `${label} has unknown or missing fields`, 3);
  }
}

function parsePlanBatch(value: unknown): IssueMutationPlan[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail('invalid-apply-input', 'the complete plan batch must be nonempty', 3);
  }
  for (const [index, plan] of value.entries()) {
    const label = `plans[${index}]`;
    assertExactKeys(plan, [
      'schema_version', 'repository', 'issue_number', 'issue_node_id',
      'expected_main_sha', 'etag', 'expected_before', 'managed_block', 'desired',
      'title_delta', 'label_delta', 'body_delta', 'intent_sha256',
      'registry_sha256', 'plan_sha256', 'changed',
    ], label);
    assertExactKeys(plan.expected_before, [
      'updated_at', 'body_sha256', 'title_sha256', 'labels',
    ], `${label}.expected_before`);
    assertExactKeys(plan.desired, [
      'title', 'labels', 'title_sha256', 'body_sha256',
    ], `${label}.desired`);
    assertExactKeys(plan.label_delta, ['add', 'remove'], `${label}.label_delta`);
    if (plan.title_delta !== null) {
      assertExactKeys(plan.title_delta, [
        'before', 'after', 'before_sha256', 'after_sha256',
      ], `${label}.title_delta`);
    }
    if (plan.body_delta !== null) {
      assertExactKeys(plan.body_delta, [
        'before_sha256', 'after_sha256',
      ], `${label}.body_delta`);
    }
    if (
      plan.schema_version !== 1
      || typeof plan.repository !== 'string'
      || !Number.isSafeInteger(plan.issue_number)
      || typeof plan.issue_node_id !== 'string'
      || typeof plan.expected_main_sha !== 'string'
      || !(plan.etag === null || typeof plan.etag === 'string')
      || typeof plan.managed_block !== 'string'
      || typeof plan.intent_sha256 !== 'string'
      || typeof plan.registry_sha256 !== 'string'
      || typeof plan.plan_sha256 !== 'string'
      || typeof plan.changed !== 'boolean'
      || typeof plan.expected_before.updated_at !== 'string'
      || typeof plan.expected_before.body_sha256 !== 'string'
      || typeof plan.expected_before.title_sha256 !== 'string'
      || !Array.isArray(plan.expected_before.labels)
      || plan.expected_before.labels.some((entry) => typeof entry !== 'string')
      || typeof plan.desired.title !== 'string'
      || !Array.isArray(plan.desired.labels)
      || plan.desired.labels.some((entry) => typeof entry !== 'string')
      || typeof plan.desired.title_sha256 !== 'string'
      || typeof plan.desired.body_sha256 !== 'string'
      || !Array.isArray(plan.label_delta.add)
      || plan.label_delta.add.some((entry) => typeof entry !== 'string')
      || !Array.isArray(plan.label_delta.remove)
      || plan.label_delta.remove.some((entry) => typeof entry !== 'string')
      || (plan.title_delta !== null && (
        typeof plan.title_delta.before !== 'string'
        || typeof plan.title_delta.after !== 'string'
        || typeof plan.title_delta.before_sha256 !== 'string'
        || typeof plan.title_delta.after_sha256 !== 'string'
      ))
      || (plan.body_delta !== null && (
        typeof plan.body_delta.before_sha256 !== 'string'
        || typeof plan.body_delta.after_sha256 !== 'string'
      ))
    ) {
      throw fail('plan-registry-mismatch', `${label} has invalid runtime types`, 3);
    }
  }
  return value as IssueMutationPlan[];
}

function extractIntentSha256(text: string): string | null {
  const matches = [...text.matchAll(INTENT_MARKER)];
  return matches.length === 1 ? matches[0]?.[1] ?? null : null;
}

function bindRegistry(
  input: ApplyIssueBatchInput,
  plans: readonly IssueMutationPlan[],
): { registry: OpenIssueRegistry; digest: string } {
  let registry: OpenIssueRegistry;
  try {
    registry = parseRegistry(input.registry);
  } catch (error) {
    throw fail('plan-registry-mismatch', 'registry parsing or public-safety validation failed', 3, undefined, error);
  }
  const validationIssues = validateRegistry(registry);
  if (validationIssues.length > 0) {
    throw fail('plan-registry-mismatch', 'registry semantic validation failed', 3);
  }
  const digest = registrySha256(registry);
  const records = new Map(registry.issues.map((record) => [record.issue_number, record]));
  for (const plan of plans) {
    const record = records.get(plan.issue_number);
    if (record === undefined) {
      throw fail('plan-registry-mismatch', `Issue #${plan.issue_number} is absent from registry`, 3, plan.issue_number);
    }
    let rendered: string;
    try {
      rendered = renderReviewBlock(record);
    } catch (error) {
      throw fail('plan-registry-mismatch', `Issue #${plan.issue_number} registry rendering failed`, 3, plan.issue_number, error);
    }
    const desiredTitle = record.recommended_title ?? record.title;
    if (
      registry.repository !== REPOSITORY
      || registry.pinned_main_revision !== input.expectedMainSha
      || record.pinned_revision !== input.expectedMainSha
      || plan.repository !== registry.repository
      || plan.expected_main_sha !== registry.pinned_main_revision
      || plan.issue_node_id !== record.issue_node_id
      || plan.expected_before.updated_at !== record.updated_at
      || plan.expected_before.body_sha256 !== record.pre_review_body_sha256
      || plan.expected_before.title_sha256 !== sha256(record.title)
      || !sameStrings(plan.expected_before.labels, record.current_labels)
      || plan.desired.title !== desiredTitle
      || plan.desired.title_sha256 !== sha256(desiredTitle)
      || !sameStrings(plan.desired.labels, record.recommended_labels)
      || plan.managed_block !== rendered
      || plan.intent_sha256 !== extractIntentSha256(rendered)
      || plan.registry_sha256 !== digest
    ) {
      throw fail(
        'plan-registry-mismatch',
        `Issue #${plan.issue_number} plan is not exactly derived from the registry`,
        3,
        plan.issue_number,
      );
    }
  }
  return { registry, digest };
}

function assertInput(
  input: ApplyIssueBatchInput,
): { plans: IssueMutationPlan[]; registryDigest: string } {
  const plans = parsePlanBatch(input.plans);
  if (!/^[0-9a-f]{40}$/.test(input.expectedMainSha)) {
    throw fail('invalid-apply-input', 'expectedMainSha must be a 40-character object ID', 3);
  }
  if (!/^[0-9a-f]{64}$/.test(input.confirmedPlanSha256)) {
    throw fail('invalid-apply-input', 'confirmedPlanSha256 must be a SHA-256 digest', 3);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.idempotencyKey)) {
    throw fail('invalid-apply-input', 'idempotencyKey must be a nonempty lowercase slug', 3);
  }
  if (typeof input.ledgerPath !== 'string' || input.ledgerPath.length === 0) {
    throw fail('invalid-apply-input', 'ledgerPath must be nonempty', 3);
  }
  const registryBinding = bindRegistry(input, plans);
  for (const [index, plan] of plans.entries()) {
    if (
      plan.schema_version !== 1
      || plan.repository !== REPOSITORY
      || !Number.isSafeInteger(plan.issue_number)
      || plan.issue_number <= 0
      || (index > 0 && plans[index - 1]!.issue_number >= plan.issue_number)
    ) {
      throw fail(
        'invalid-apply-input',
        'plans must be the complete sorted unique repository batch',
        3,
      );
    }
    if (
      plan.expected_main_sha !== input.expectedMainSha
      || plan.registry_sha256 !== registryBinding.digest
    ) {
      throw fail(
        'registry-digest-mismatch',
        `Issue #${plan.issue_number} plan does not match the confirmed main and registry`,
        3,
        plan.issue_number,
      );
    }
    if (
      !sameStrings(plan.expected_before.labels, sortedStrings(plan.expected_before.labels))
      || !sameStrings(plan.desired.labels, sortedStrings(plan.desired.labels))
      || !sameStrings(plan.label_delta.add, sortedStrings(plan.label_delta.add))
      || !sameStrings(plan.label_delta.remove, sortedStrings(plan.label_delta.remove))
    ) {
      throw fail(
        'invalid-apply-input',
        `Issue #${plan.issue_number} plan contains a non-canonical label set`,
        3,
        plan.issue_number,
      );
    }
    const expectedAdds = plan.desired.labels.filter(
      (label) => !plan.expected_before.labels.includes(label),
    );
    const expectedRemoves = plan.expected_before.labels.filter(
      (label) => !plan.desired.labels.includes(label),
    );
    const titleChanged = plan.expected_before.title_sha256 !== plan.desired.title_sha256;
    const bodyChanged = plan.expected_before.body_sha256 !== plan.desired.body_sha256;
    const labelsChanged = expectedAdds.length > 0 || expectedRemoves.length > 0;
    const coherentTitleDelta = titleChanged
      ? plan.title_delta !== null
        && plan.title_delta.before_sha256 === plan.expected_before.title_sha256
        && plan.title_delta.after_sha256 === plan.desired.title_sha256
        && sha256(plan.title_delta.before) === plan.expected_before.title_sha256
        && plan.title_delta.after === plan.desired.title
      : plan.title_delta === null;
    const coherentBodyDelta = bodyChanged
      ? plan.body_delta?.before_sha256 === plan.expected_before.body_sha256
        && plan.body_delta.after_sha256 === plan.desired.body_sha256
      : plan.body_delta === null;
    if (
      sha256(plan.desired.title) !== plan.desired.title_sha256
      || !coherentTitleDelta
      || !coherentBodyDelta
      || !sameStrings(plan.label_delta.add, expectedAdds)
      || !sameStrings(plan.label_delta.remove, expectedRemoves)
      || plan.changed !== (titleChanged || bodyChanged || labelsChanged)
    ) {
      throw fail(
        'invalid-apply-input',
        `Issue #${plan.issue_number} plan deltas are internally inconsistent`,
        3,
        plan.issue_number,
      );
    }
    if (extractIntentSha256(plan.managed_block) !== plan.intent_sha256) {
      throw fail(
        'plan-digest-mismatch',
        `Issue #${plan.issue_number} plan intent marker does not match`,
        3,
        plan.issue_number,
      );
    }
  }

  const observedPlanSha256 = planDigest(plans);
  if (observedPlanSha256 !== input.confirmedPlanSha256) {
    throw fail('plan-digest-mismatch', 'canonical plan digest does not match confirmation', 3);
  }
  if (plans.some((plan) => plan.plan_sha256 !== observedPlanSha256)) {
    throw fail('plan-digest-mismatch', 'one or more plan records have a stale batch digest', 3);
  }
  return { plans, registryDigest: registryBinding.digest };
}

interface FileIdentity {
  dev: string;
  ino: string;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identityOf(stat: Stats): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function inspectLedgerPath(ledgerPath: string): FileIdentity | null {
  const parent = dirname(ledgerPath);
  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch (error) {
    throw fail('ledger-path-unsafe', 'ledger parent directory is unavailable', 5, undefined, error);
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw fail('ledger-path-unsafe', 'ledger parent must be a real directory', 5);
  }
  if (!existsSync(ledgerPath)) return null;
  let ledgerStat;
  try {
    ledgerStat = lstatSync(ledgerPath);
  } catch (error) {
    throw fail('ledger-path-unsafe', 'ledger path could not be inspected', 5, undefined, error);
  }
  if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink() || ledgerStat.nlink !== 1) {
    throw fail('ledger-path-unsafe', 'ledger must be a no-follow regular file', 5);
  }
  return identityOf(ledgerStat);
}

class DurableLedger {
  readonly #path: string;
  #text: string;
  #receipts: MutationReceipt[];
  #identity: FileIdentity | null;

  constructor(path: string, inspectedIdentity: FileIdentity | null) {
    this.#path = path;
    this.#identity = inspectedIdentity;
    try {
      this.#text = readLedgerNoFollow(path, inspectedIdentity);
      this.#receipts = parseLedger(this.#text);
    } catch (error) {
      if (error instanceof ApplyIssueBatchError) throw error;
      throw fail('ledger-invalid', 'existing receipt ledger is invalid', 5, undefined, error);
    }
  }

  get receipts(): readonly MutationReceipt[] {
    return this.#receipts;
  }

  append(
    payload: Omit<MutationReceiptWithoutHash, 'sequence' | 'previous_receipt_sha256'>,
  ): MutationReceipt {
    const previous = this.#receipts.at(-1);
    const withoutHash = {
      ...payload,
      sequence: this.#receipts.length + 1,
      previous_receipt_sha256: previous?.receipt_sha256 ?? null,
    } as MutationReceiptWithoutHash;
    const receipt = {
      ...withoutHash,
      receipt_sha256: receiptSha256(withoutHash),
    } as MutationReceipt;
    const line = `${JSON.stringify(receipt)}\n`;
    let validated: MutationReceipt[];
    try {
      validated = parseLedger(`${this.#text}${line}`);
    } catch (error) {
      throw fail(
        'ledger-invalid',
        'new receipt would violate the append-only ledger contract',
        5,
        'issue_number' in receipt ? receipt.issue_number : undefined,
        error,
      );
    }
    try {
      this.#identity = appendDurably(this.#path, line, this.#identity);
    } catch (error) {
      throw fail(
        'ledger-durability-failed',
        'receipt append could not be durably committed',
        5,
        'issue_number' in receipt ? receipt.issue_number : undefined,
        error,
      );
    }
    this.#text += line;
    this.#receipts = validated;
    return receipt;
  }
}

function readLedgerNoFollow(path: string, expectedIdentity: FileIdentity | null): string {
  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  try {
    const descriptorStat = fstatSync(fileDescriptor);
    if (!descriptorStat.isFile() || descriptorStat.nlink !== 1) {
      throw new Error('opened ledger is not a regular file');
    }
    const descriptorIdentity = identityOf(descriptorStat);
    if (expectedIdentity === null || !sameIdentity(descriptorIdentity, expectedIdentity)) {
      throw new Error('opened ledger identity differs from inspected path');
    }
    const pathStat = lstatSync(path);
    if (
      !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1
      || !sameIdentity(identityOf(pathStat), descriptorIdentity)
    ) {
      throw new Error('ledger path identity changed before read');
    }
    const text = readFileSync(fileDescriptor, 'utf8');
    const afterRead = lstatSync(path);
    if (
      afterRead.nlink !== 1
      || !sameIdentity(identityOf(afterRead), descriptorIdentity)
    ) {
      throw new Error('ledger path identity changed during read');
    }
    return text;
  } finally {
    closeSync(fileDescriptor);
  }
}

function appendDurably(
  path: string,
  text: string,
  expectedIdentity: FileIdentity | null,
): FileIdentity {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fileDescriptor = openSync(
    path,
    constants.O_WRONLY
      | constants.O_APPEND
      | constants.O_CREAT
      | noFollow
      | (expectedIdentity === null ? constants.O_EXCL : 0),
    0o644,
  );
  try {
    const descriptorStat = fstatSync(fileDescriptor);
    if (!descriptorStat.isFile() || descriptorStat.nlink !== 1) {
      throw new Error('opened ledger is not a regular file');
    }
    const descriptorIdentity = identityOf(descriptorStat);
    if (expectedIdentity !== null && !sameIdentity(descriptorIdentity, expectedIdentity)) {
      throw new Error('opened ledger identity differs from prior append');
    }
    const pathStat = lstatSync(path);
    if (
      !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1
      || !sameIdentity(identityOf(pathStat), descriptorIdentity)
    ) {
      throw new Error('ledger path identity changed before append');
    }
    const beforeWriteStat = fstatSync(fileDescriptor);
    if (
      beforeWriteStat.nlink !== 1
      || !sameIdentity(identityOf(beforeWriteStat), descriptorIdentity)
    ) {
      throw new Error('ledger descriptor identity changed before append');
    }
    const bytes = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fileDescriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('ledger append made no progress');
      offset += written;
    }
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }

  const directoryDescriptor = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
  const durablePathStat = lstatSync(path);
  if (
    durablePathStat.nlink !== 1
    || (expectedIdentity !== null
      && !sameIdentity(identityOf(durablePathStat), expectedIdentity))
  ) {
    throw new Error('ledger path identity changed after durable append');
  }
  return identityOf(durablePathStat);
}

function beforeSnapshotMatches(issue: LiveIssue, plan: IssueMutationPlan): boolean {
  return issue.number === plan.issue_number
    && issue.nodeId === plan.issue_node_id
    && issue.repository === REPOSITORY
    && issue.state === 'open'
    && issue.isPullRequest === false
    && issue.updatedAt === plan.expected_before.updated_at
    && sha256(issue.title) === plan.expected_before.title_sha256
    && sha256(issue.body) === plan.expected_before.body_sha256
    && sameStrings(sortedStrings(issue.labels), plan.expected_before.labels);
}

function desiredSnapshotMatches(issue: LiveIssue, target: PreparedTarget): boolean {
  const { plan } = target;
  return issue.number === plan.issue_number
    && issue.nodeId === plan.issue_node_id
    && issue.repository === REPOSITORY
    && issue.state === 'open'
    && issue.isPullRequest === false
    && sha256(issue.title) === plan.desired.title_sha256
    && sha256(issue.body) === plan.desired.body_sha256
    && extractIntentSha256(issue.body) === plan.intent_sha256
    && sameStrings(sortedStrings(issue.labels), plan.desired.labels);
}

function targetReceiptPayload(
  target: PreparedTarget,
  envelope: {
    operationId: string;
    batchId: string;
    plannedAt: string;
    pinnedMainRevision: string;
  },
  outcome: {
    receiptType: 'target_verified' | 'target_unknown';
    operationResult:
      | 'no-op'
      | 'applied-verified'
      | 'applied-verified-after-ambiguous-response'
      | 'refused-concurrent-update'
      | 'failed-before-write'
      | 'write-outcome-unknown'
      | 'post-write-verification-failed';
    appliedAt: string | null;
    verifiedAt: string | null;
    diagnosticCode: string | null;
  },
): Omit<MutationReceiptWithoutHash, 'sequence' | 'previous_receipt_sha256'> {
  const { plan } = target;
  return {
    schema_version: 1,
    receipt_type: outcome.receiptType,
    operation_id: envelope.operationId,
    batch_id: envelope.batchId,
    pinned_main_revision: envelope.pinnedMainRevision,
    issue_number: plan.issue_number,
    issue_node_id: plan.issue_node_id,
    planned_at: envelope.plannedAt,
    applied_at: outcome.appliedAt,
    verified_at: outcome.verifiedAt,
    before: plan.expected_before,
    expected_after: {
      body_sha256: plan.desired.body_sha256,
      title_sha256: plan.desired.title_sha256,
      labels: plan.desired.labels,
    },
    title_delta: {
      before_sha256: plan.expected_before.title_sha256,
      after_sha256: plan.desired.title_sha256,
      changed: plan.expected_before.title_sha256 !== plan.desired.title_sha256,
    },
    label_delta: plan.label_delta,
    operation_result: outcome.operationResult,
    diagnostic_code: outcome.diagnosticCode,
  } as Omit<MutationReceiptWithoutHash, 'sequence' | 'previous_receipt_sha256'>;
}

async function preflight(
  plans: readonly IssueMutationPlan[],
  input: ApplyIssueBatchInput,
): Promise<PreparedTarget[]> {
  const observedMainSha = await input.client.readMainSha();
  if (observedMainSha !== input.expectedMainSha) {
    throw fail('main-sha-drift', 'live main differs from the confirmed object ID', 3);
  }

  const reads = await Promise.all(plans.map((plan) => input.client.readIssue(plan.issue_number)));
  return plans.map((plan, index) => {
    const before = reads[index]?.issue;
    if (before === undefined || !beforeSnapshotMatches(before, plan)) {
      throw fail(
        'precondition-drift',
        `Issue #${plan.issue_number} no longer matches the planned precondition`,
        3,
        plan.issue_number,
      );
    }
    let desiredBody: string;
    try {
      desiredBody = mergeReviewBlock(before.body, plan.managed_block).body;
    } catch (error) {
      throw fail(
        'plan-digest-mismatch',
        `Issue #${plan.issue_number} managed body cannot be safely recomputed`,
        3,
        plan.issue_number,
        error,
      );
    }
    if (
      sha256(desiredBody) !== plan.desired.body_sha256
      || sha256(plan.desired.title) !== plan.desired.title_sha256
      || extractIntentSha256(desiredBody) !== plan.intent_sha256
    ) {
      throw fail(
        'plan-digest-mismatch',
        `Issue #${plan.issue_number} desired state does not match the canonical plan`,
        3,
        plan.issue_number,
      );
    }
    return { plan, before, desiredBody };
  });
}

function acquireApplyLock(ledgerPath: string): ProcessLockHandle {
  const lockPath = `${ledgerPath}.lock`;
  try {
    if (existsSync(lockPath)) {
      const lockStat = lstatSync(lockPath);
      if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.nlink !== 1) {
        throw new Error('apply lock rendezvous is not a single-link regular file');
      }
    }
    return acquireProcessLock(lockPath);
  } catch (error) {
    if (isProcessLockError(error)) {
      throw fail('apply-lock-unavailable', 'another apply owner holds the receipt lock', 3, undefined, error);
    }
    throw fail('apply-lock-unavailable', 'the receipt lock could not be acquired', 3, undefined, error);
  }
}

function assertIdempotencyAvailable(
  receipts: readonly MutationReceipt[],
  idempotencyKey: string,
): void {
  if (receipts.some((receipt) => receipt.operation_id === idempotencyKey)) {
    throw fail(
      'idempotency-key-reused',
      'the idempotency key already exists in the append-only ledger',
      3,
    );
  }
  const last = receipts.at(-1);
  if (last !== undefined && last.receipt_type !== 'batch_completed') {
    throw fail(
      'idempotency-key-reused',
      'the receipt ledger contains an unfinished batch requiring explicit recovery',
      3,
    );
  }
}

function updateDiagnostic(result: GitHubWriteResult): string | null {
  return result.kind === 'ambiguous' ? result.diagnosticCode : null;
}

export async function applyIssueBatch(
  input: ApplyIssueBatchInput,
): Promise<MutationReceipt[]> {
  const { plans, registryDigest } = assertInput(input);
  const ledgerIdentity = inspectLedgerPath(input.ledgerPath);
  const lock = acquireApplyLock(input.ledgerPath);
  let normalReturn = false;
  let primaryError: unknown;
  try {
    const ledger = new DurableLedger(input.ledgerPath, ledgerIdentity);
    assertIdempotencyAvailable(ledger.receipts, input.idempotencyKey);
    const prepared = await preflight(plans, input);
    const plannedAt = input.now();
    const batchId = sha256([
      input.idempotencyKey,
      input.confirmedPlanSha256,
      registryDigest,
      input.expectedMainSha,
    ].join('\n'));
    const envelope = {
      operationId: input.idempotencyKey,
      batchId,
      plannedAt,
      pinnedMainRevision: input.expectedMainSha,
    };
    const batchReceipts: MutationReceipt[] = [];
    batchReceipts.push(ledger.append({
      schema_version: 1,
      receipt_type: 'batch_started',
      operation_id: envelope.operationId,
      batch_id: envelope.batchId,
      pinned_main_revision: envelope.pinnedMainRevision,
      planned_at: envelope.plannedAt,
      plan_sha256: input.confirmedPlanSha256,
      registry_sha256: registryDigest,
      issue_numbers: plans.map((plan) => plan.issue_number),
      operation_result: 'planned',
      diagnostic_code: null,
    } as Omit<MutationReceiptWithoutHash, 'sequence' | 'previous_receipt_sha256'>));

    let mutationRequests = 0;
    let appliedCount = 0;
    for (const target of prepared) {
      if (!target.plan.changed) {
        const verifiedAt = input.now();
        if (!desiredSnapshotMatches(target.before, target)) {
          throw fail(
            'precondition-drift',
            `Issue #${target.plan.issue_number} no-op plan is not exact`,
            3,
            target.plan.issue_number,
          );
        }
        batchReceipts.push(ledger.append(targetReceiptPayload(target, envelope, {
          receiptType: 'target_verified',
          operationResult: 'no-op',
          appliedAt: null,
          verifiedAt,
          diagnosticCode: null,
        })));
        continue;
      }

      if (mutationRequests > 0) {
        await input.delay(MINIMUM_MUTATION_DELAY_MS);
      }
      mutationRequests += 1;
      const appliedAt = input.now();
      let writeResult: GitHubWriteResult;
      try {
        writeResult = await input.client.updateIssue(target.plan.issue_number, {
          title: target.plan.desired.title,
          body: target.desiredBody,
          labels: [...target.plan.desired.labels],
        });
      } catch (error) {
        const diagnosticCode = 'write-failed-before-response';
        batchReceipts.push(ledger.append(targetReceiptPayload(target, envelope, {
          receiptType: 'target_unknown',
          operationResult: 'failed-before-write',
          appliedAt: null,
          verifiedAt: null,
          diagnosticCode,
        })));
        throw fail(
          'write-failed-before-response',
          `Issue #${target.plan.issue_number} write failed before a response`,
          5,
          target.plan.issue_number,
          error,
        );
      }
      appliedCount += 1;

      let reread: LiveIssue;
      try {
        reread = (await input.client.readIssue(target.plan.issue_number)).issue;
      } catch (error) {
        const diagnosticCode = writeResult.kind === 'ambiguous'
          ? 'verification-read-failed-after-ambiguous'
          : 'verification-read-failed-after-success';
        batchReceipts.push(ledger.append(targetReceiptPayload(target, envelope, {
          receiptType: 'target_unknown',
          operationResult: 'write-outcome-unknown',
          appliedAt,
          verifiedAt: null,
          diagnosticCode,
        })));
        throw fail(
          'write-outcome-unknown',
          `Issue #${target.plan.issue_number} verification read failed after one PATCH`,
          5,
          target.plan.issue_number,
          error,
        );
      }
      const desired = desiredSnapshotMatches(reread, target);
      const diagnosticCode = updateDiagnostic(writeResult);
      if (desired) {
        batchReceipts.push(ledger.append(targetReceiptPayload(target, envelope, {
          receiptType: 'target_verified',
          operationResult: writeResult.kind === 'ambiguous'
            ? 'applied-verified-after-ambiguous-response'
            : 'applied-verified',
          appliedAt,
          verifiedAt: input.now(),
          diagnosticCode,
        })));
        continue;
      }

      const operationResult = writeResult.kind === 'ambiguous'
        ? 'write-outcome-unknown'
        : 'post-write-verification-failed';
      const exactBefore = writeResult.kind === 'ambiguous'
        && beforeSnapshotMatches(reread, target.plan);
      const outcomeDiagnostic = writeResult.kind === 'ambiguous'
        ? exactBefore
          ? 'ambiguous-write-not-applied'
          : 'ambiguous-write-third-state'
        : 'post-write-verification-failed';
      batchReceipts.push(ledger.append(targetReceiptPayload(target, envelope, {
        receiptType: 'target_unknown',
        operationResult,
        appliedAt,
        verifiedAt: null,
        diagnosticCode: outcomeDiagnostic,
      })));
      throw fail(
        operationResult,
        `Issue #${target.plan.issue_number} could not be verified after one PATCH`,
        5,
        target.plan.issue_number,
        undefined,
        exactBefore,
      );
    }

    batchReceipts.push(ledger.append({
      schema_version: 1,
      receipt_type: 'batch_completed',
      operation_id: envelope.operationId,
      batch_id: envelope.batchId,
      pinned_main_revision: envelope.pinnedMainRevision,
      planned_at: envelope.plannedAt,
      completed_at: input.now(),
      target_count: prepared.length,
      verified_count: prepared.length,
      unknown_count: 0,
      operation_result: appliedCount > 0 ? 'applied-verified' : 'no-op',
      diagnostic_code: null,
    } as Omit<MutationReceiptWithoutHash, 'sequence' | 'previous_receipt_sha256'>));
    normalReturn = true;
    return batchReceipts;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let released = false;
    try {
      released = releaseProcessLock(lock);
    } catch (releaseError) {
      if (primaryError === undefined) {
        throw fail(
          'apply-lock-release-failed',
          'the apply lock could not be identity-released',
          5,
          undefined,
          releaseError,
        );
      }
    }
    if (!released && normalReturn && primaryError === undefined) {
      throw fail(
        'apply-lock-release-failed',
        'the apply lock was replaced before identity-checked release',
        5,
      );
    }
  }
}
