import { mergeReviewBlock, renderReviewBlock } from './body.ts';
import {
  ADDABLE_LABELS,
  LIVE_LABELS,
  registrySha256 as computeRegistrySha256,
  sha256,
  type OpenIssueRegistry,
} from './model.ts';
import type {
  GitHubIssueClient,
  LiveInventory,
  LiveIssue,
} from './github.ts';

const REPOSITORY = 'LucasQuiles/WhatSoup';

export interface IssueSnapshot {
  updated_at: string;
  body_sha256: string;
  title_sha256: string;
  labels: string[];
}

export interface DesiredIssueSnapshot {
  title: string;
  labels: string[];
  title_sha256: string;
  body_sha256: string;
}

export interface TitleDelta {
  before: string;
  after: string;
  before_sha256: string;
  after_sha256: string;
}

export interface BodyDelta {
  before_sha256: string;
  after_sha256: string;
}

export interface IssueMutationPlan {
  schema_version: 1;
  repository: typeof REPOSITORY;
  issue_number: number;
  issue_node_id: string;
  expected_main_sha: string;
  etag: string | null;
  expected_before: IssueSnapshot;
  managed_block: string;
  desired: DesiredIssueSnapshot;
  title_delta: TitleDelta | null;
  label_delta: {
    add: string[];
    remove: string[];
  };
  body_delta: BodyDelta | null;
  intent_sha256: string;
  registry_sha256: string;
  plan_sha256: string;
  changed: boolean;
}

export interface PlanIssueBatchInput {
  expectedMainSha: string;
  registry: OpenIssueRegistry;
  targetIssueNumbers: number[];
  client: GitHubIssueClient;
}

type IssuePlanningErrorCode =
  | 'invalid-main-sha'
  | 'main-sha-drift'
  | 'record-main-sha-drift'
  | 'duplicate-record'
  | 'invalid-target-selection'
  | 'target-not-in-registry'
  | 'inventory-repository-drift'
  | 'inventory-pagination-incomplete'
  | 'inventory-count-drift'
  | 'inventory-open-issue-set-drift'
  | 'inventory-label-catalogue-drift'
  | 'case-ambiguous-label'
  | 'unknown-label'
  | 'label-not-addable'
  | 'label-removal-refused'
  | 'issue-not-open'
  | 'issue-is-pull-request'
  | 'issue-number-drift'
  | 'issue-node-id-drift'
  | 'issue-repository-drift'
  | 'issue-url-drift'
  | 'issue-updated-at-drift'
  | 'issue-title-drift'
  | 'issue-labels-drift'
  | 'issue-body-drift'
  | 'intent-digest-missing'
  | 'render-failed';

interface IssuePlanningErrorDetails {
  issueNumber?: number | null;
  cause?: unknown;
}

export class IssuePlanningError extends Error {
  readonly code: IssuePlanningErrorCode;
  readonly issueNumber: number | null;
  readonly retryable = false;

  constructor(
    code: IssuePlanningErrorCode,
    message: string,
    details: IssuePlanningErrorDetails = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'IssuePlanningError';
    this.code = code;
    this.issueNumber = details.issueNumber ?? null;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      issueNumber: this.issueNumber,
      retryable: this.retryable,
    };
  }
}

type ReviewRecord = OpenIssueRegistry['issues'][number];

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

export function canonicalPlanJson(plans: readonly IssueMutationPlan[]): string {
  return canonicalJson([...plans].sort((left, right) => left.issue_number - right.issue_number));
}

function planningError(
  code: IssuePlanningErrorCode,
  message: string,
  issueNumber: number | null = null,
  cause?: unknown,
): IssuePlanningError {
  return new IssuePlanningError(code, message, { issueNumber, cause });
}

function assertUniqueSortedIntegers(
  values: readonly number[],
  code: IssuePlanningErrorCode,
  message: string,
): void {
  if (values.some((value, index) =>
    !Number.isSafeInteger(value)
    || value <= 0
    || (index > 0 && values[index - 1] >= value))) {
    throw planningError(code, message);
  }
}

function assertCompleteInventory(
  inventory: LiveInventory,
  registry: OpenIssueRegistry,
): void {
  if (inventory.repository !== REPOSITORY) {
    throw planningError(
      'inventory-repository-drift',
      `Live inventory repository is not ${REPOSITORY}`,
    );
  }
  if (
    inventory.pagination.issuesComplete !== true
    || inventory.pagination.pullRequestsComplete !== true
    || inventory.pagination.labelsComplete !== true
  ) {
    throw planningError(
      'inventory-pagination-incomplete',
      'Live inventory pagination is not proven complete',
    );
  }

  assertUniqueSortedIntegers(
    inventory.openIssueNumbers,
    'inventory-count-drift',
    'Live open issue numbers are not sorted and unique',
  );
  const pullRequestNumbers = inventory.openPullRequests.map((pullRequest) =>
    pullRequest.number);
  assertUniqueSortedIntegers(
    pullRequestNumbers,
    'inventory-count-drift',
    'Live pull request numbers are not sorted and unique',
  );
  if (
    inventory.counts.openIssues !== inventory.openIssueNumbers.length
    || inventory.counts.openPullRequests !== inventory.openPullRequests.length
    || inventory.counts.draftPullRequests
      !== inventory.openPullRequests.filter((pullRequest) => pullRequest.isDraft).length
    || inventory.counts.labels !== inventory.labels.length
  ) {
    throw planningError(
      'inventory-count-drift',
      'Live inventory counts do not match the complete item sets',
    );
  }
  const labelFolds = new Map<string, string>();
  for (const label of inventory.labels) {
    const fold = label.toLocaleLowerCase('en-US');
    const existing = labelFolds.get(fold);
    if (existing !== undefined && existing !== label) {
      throw planningError(
        'case-ambiguous-label',
        'Live label catalogue contains case-ambiguous names',
      );
    }
    labelFolds.set(fold, label);
  }
  const observedLabels = sortedStrings(inventory.labels);
  const registryLabels = sortedStrings(registry.inventory.labels);
  if (
    !sameStrings(observedLabels, sortedStrings(LIVE_LABELS))
    || !sameStrings(observedLabels, registryLabels)
  ) {
    throw planningError(
      'inventory-label-catalogue-drift',
      'Live label catalogue differs from the pinned catalogue',
    );
  }

  const recordNumbers = registry.issues.map((record) => record.issue_number)
    .sort((left, right) => left - right);
  if (
    inventory.counts.openIssues !== registry.issues.length
    || !sameStrings(
      inventory.openIssueNumbers.map(String),
      recordNumbers.map(String),
    )
  ) {
    throw planningError(
      'inventory-open-issue-set-drift',
      'Live open issue set differs from the validated registry records',
    );
  }
  if (
    inventory.counts.openIssues !== registry.inventory.open_issue_count
    || inventory.counts.openPullRequests !== registry.inventory.open_pull_request_count
    || inventory.counts.draftPullRequests !== registry.inventory.draft_pull_request_count
    || inventory.counts.labels !== registry.inventory.label_count
  ) {
    throw planningError(
      'inventory-count-drift',
      'Live inventory counts differ from the complete registry envelope',
    );
  }
}

function assertRecordLabels(record: ReviewRecord, inventory: LiveInventory): void {
  const catalogue = new Set(inventory.labels);
  const foldedCatalogue = new Map(
    inventory.labels.map((label) => [label.toLocaleLowerCase('en-US'), label]),
  );
  const current = new Set(record.current_labels);
  const addable = new Set<string>(ADDABLE_LABELS);

  for (const label of [...record.current_labels, ...record.recommended_labels]) {
    if (catalogue.has(label)) continue;
    if (foldedCatalogue.has(label.toLocaleLowerCase('en-US'))) {
      throw planningError(
        'case-ambiguous-label',
        `Issue #${record.issue_number} uses a case-mismatched label`,
        record.issue_number,
      );
    }
    throw planningError(
      'unknown-label',
      `Issue #${record.issue_number} uses a label outside the live catalogue`,
      record.issue_number,
    );
  }
  for (const label of record.current_labels) {
    if (!record.recommended_labels.includes(label)) {
      throw planningError(
        'label-removal-refused',
        `Issue #${record.issue_number} would remove an existing label`,
        record.issue_number,
      );
    }
  }
  for (const label of record.recommended_labels) {
    if (!current.has(label) && !addable.has(label)) {
      throw planningError(
        'label-not-addable',
        `Issue #${record.issue_number} would newly add a non-addable label`,
        record.issue_number,
      );
    }
  }
}

function assertLivePreconditions(record: ReviewRecord, live: LiveIssue): void {
  const issueNumber = record.issue_number;
  const fail = (code: IssuePlanningErrorCode, field: string): never => {
    throw planningError(
      code,
      `Issue #${issueNumber} ${field} differs from the validated registry`,
      issueNumber,
    );
  };
  if (live.number !== issueNumber) fail('issue-number-drift', 'number');
  if (live.state !== 'open') fail('issue-not-open', 'state');
  if (live.isPullRequest) fail('issue-is-pull-request', 'shape');
  if (live.nodeId !== record.issue_node_id) fail('issue-node-id-drift', 'node ID');
  if (live.repository !== REPOSITORY) fail('issue-repository-drift', 'repository');
  if (live.url !== record.url) fail('issue-url-drift', 'URL');
  if (live.updatedAt !== record.updated_at) fail('issue-updated-at-drift', 'updated_at');
  if (live.title !== record.title) fail('issue-title-drift', 'title');

  const liveLabels = sortedStrings(live.labels);
  const currentLabels = sortedStrings(record.current_labels);
  if (!sameStrings(liveLabels, currentLabels)) {
    fail('issue-labels-drift', 'complete label set');
  }
  if (sha256(live.body) !== record.pre_review_body_sha256) {
    fail('issue-body-drift', 'raw body hash');
  }
}

function extractIntentSha256(block: string, issueNumber: number): string {
  const matches = [
    ...block.matchAll(/^<!-- triage-review:intent-sha256=([0-9a-f]{64}) -->$/gm),
  ];
  const digest = matches[0]?.[1];
  if (matches.length !== 1 || digest === undefined) {
    throw planningError(
      'intent-digest-missing',
      `Issue #${issueNumber} rendered without one exact intent digest`,
      issueNumber,
    );
  }
  return digest;
}

function delta(before: readonly string[], after: readonly string[]): {
  add: string[];
  remove: string[];
} {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    add: sortedStrings(after.filter((label) => !beforeSet.has(label))),
    remove: sortedStrings(before.filter((label) => !afterSet.has(label))),
  };
}

export async function planIssueBatch(
  input: PlanIssueBatchInput,
): Promise<IssueMutationPlan[]> {
  if (!/^[0-9a-f]{40}$/.test(input.expectedMainSha)) {
    throw planningError('invalid-main-sha', 'Expected main SHA is not a 40-character object ID');
  }
  const observedMainSha = await input.client.readMainSha();
  if (observedMainSha !== input.expectedMainSha) {
    throw planningError('main-sha-drift', 'Live main differs from the expected object ID');
  }

  if (input.registry.repository !== REPOSITORY) {
    throw planningError(
      'inventory-repository-drift',
      `Registry repository is not ${REPOSITORY}`,
    );
  }
  if (input.registry.pinned_main_revision !== input.expectedMainSha) {
    throw planningError(
      'record-main-sha-drift',
      'Registry is pinned to a different main object ID',
    );
  }
  const records = [...input.registry.issues].sort((left, right) =>
    left.issue_number - right.issue_number);
  for (const [index, record] of records.entries()) {
    if (index > 0 && records[index - 1]?.issue_number === record.issue_number) {
      throw planningError(
        'duplicate-record',
        `Registry contains duplicate issue #${record.issue_number}`,
        record.issue_number,
      );
    }
    if (record.pinned_revision !== input.expectedMainSha) {
      throw planningError(
        'record-main-sha-drift',
        `Issue #${record.issue_number} is pinned to a different main object ID`,
        record.issue_number,
      );
    }
  }

  const inventory = await input.client.readInventory();
  assertCompleteInventory(inventory, input.registry);

  if (input.targetIssueNumbers.length === 0) {
    throw planningError(
      'invalid-target-selection',
      'Target issue selection must be nonempty',
    );
  }
  if (input.targetIssueNumbers.some((number, index) =>
    !Number.isSafeInteger(number)
    || number <= 0
    || (index > 0 && input.targetIssueNumbers[index - 1] >= number))) {
    throw planningError(
      'invalid-target-selection',
      'Target issue selection must be sorted, unique positive integers',
    );
  }
  const recordsByNumber = new Map(records.map((record) => [
    record.issue_number,
    record,
  ]));
  const selectedRecords = input.targetIssueNumbers.map((number) => {
    const record = recordsByNumber.get(number);
    if (record === undefined) {
      throw planningError(
        'target-not-in-registry',
        `Selected issue #${number} is absent from the complete registry`,
        number,
      );
    }
    return record;
  });
  selectedRecords.forEach((record) => assertRecordLabels(record, inventory));

  const liveTargets = new Map<
    number,
    { issue: LiveIssue; etag: string | null }
  >();
  for (const record of selectedRecords) {
    liveTargets.set(record.issue_number, await input.client.readIssue(record.issue_number));
  }
  for (const record of selectedRecords) {
    const live = liveTargets.get(record.issue_number);
    if (live === undefined) {
      throw planningError(
        'issue-number-drift',
        `Issue #${record.issue_number} was not returned by the client`,
        record.issue_number,
      );
    }
    assertLivePreconditions(record, live.issue);
  }

  const registrySha256 = computeRegistrySha256(input.registry);
  const plansWithoutHash: Array<Omit<IssueMutationPlan, 'plan_sha256'>> =
    selectedRecords.map((record) => {
    const live = liveTargets.get(record.issue_number);
    if (live === undefined) {
      throw planningError(
        'issue-number-drift',
        `Issue #${record.issue_number} was not returned by the client`,
        record.issue_number,
      );
    }
    try {
      const block = renderReviewBlock(record);
      const merged = mergeReviewBlock(live.issue.body, block);
      const desiredTitle = record.recommended_title ?? record.title;
      const desiredLabels = sortedStrings(record.recommended_labels);
      const titleChanged = desiredTitle !== live.issue.title;
      const titleBeforeSha256 = sha256(live.issue.title);
      const titleAfterSha256 = sha256(desiredTitle);
      const beforeBodySha256 = sha256(live.issue.body);
      const afterBodySha256 = sha256(merged.body);
      const labelDelta = delta(sortedStrings(live.issue.labels), desiredLabels);
      return {
        schema_version: 1,
        repository: REPOSITORY,
        issue_number: record.issue_number,
        issue_node_id: record.issue_node_id,
        expected_main_sha: input.expectedMainSha,
        etag: live.etag,
        expected_before: {
          updated_at: live.issue.updatedAt,
          body_sha256: beforeBodySha256,
          title_sha256: titleBeforeSha256,
          labels: sortedStrings(live.issue.labels),
        },
        managed_block: block,
        desired: {
          title: desiredTitle,
          labels: desiredLabels,
          title_sha256: titleAfterSha256,
          body_sha256: afterBodySha256,
        },
        title_delta: titleChanged
          ? {
            before: live.issue.title,
            after: desiredTitle,
            before_sha256: titleBeforeSha256,
            after_sha256: titleAfterSha256,
          }
          : null,
        label_delta: labelDelta,
        body_delta: merged.changed
          ? {
            before_sha256: beforeBodySha256,
            after_sha256: afterBodySha256,
          }
          : null,
        intent_sha256: extractIntentSha256(block, record.issue_number),
        registry_sha256: registrySha256,
        changed: titleChanged
          || merged.changed
          || labelDelta.add.length > 0
          || labelDelta.remove.length > 0,
      };
    } catch (error) {
      if (error instanceof IssuePlanningError) throw error;
      throw planningError(
        'render-failed',
        `Issue #${record.issue_number} could not be rendered safely`,
        record.issue_number,
        error,
      );
    }
    });
  const batchPlanSha256 = sha256(canonicalJson(plansWithoutHash));
  return plansWithoutHash.map((plan) => ({
    ...plan,
    plan_sha256: batchPlanSha256,
  }));
}
