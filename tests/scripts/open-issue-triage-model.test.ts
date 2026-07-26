import { describe, expect, it } from 'vitest';
import {
  ADDABLE_LABELS,
  LIVE_LABELS,
  parseLedger,
  parseRegistry,
  receiptSha256,
  sha256,
  validateRegistry,
} from '../../scripts/lib/open-issue-triage/model.ts';

const HASH_A = 'a'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);
const MAIN_REVISION = 'b'.repeat(40);
const PLANNED_AT = '2026-07-26T13:00:00Z';
const APPLIED_AT = '2026-07-26T13:01:00Z';
const VERIFIED_AT = '2026-07-26T13:02:00Z';

const overlap = {
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
};

const issue = {
  issue_number: 101,
  issue_node_id: 'I_kwDOExample',
  title: 'Example finding',
  recommended_title: null as string | null,
  url: 'https://github.com/LucasQuiles/WhatSoup/issues/101',
  updated_at: '2026-07-26T12:00:00Z',
  pre_review_body_sha256: HASH_A,
  current_labels: ['bug'] as string[],
  recommended_labels: ['bug', 'reliability'] as string[],
  classification: 'leaf',
  evidence_state: 'verified',
  pinned_revision: MAIN_REVISION,
  decisive_source_paths: ['src/example.ts'] as string[],
  decisive_test_paths: ['tests/example.test.ts'] as string[],
  evidence_summary: 'The production caller does not preserve ownership.',
  falsifier_or_remaining_gap: 'Run the focused example test.',
  partial_findings: [] as unknown[],
  suggested_remediation: 'Give the operation one durable owner.',
  impact: 'Accepted work can be lost.',
  blast_radius: 'One runtime path.',
  affected_paths: ['src/example.ts'] as string[],
  owner_boundary: 'runtime-owner' as string | null,
  acceptance_criteria: ['The focused ownership test passes.'] as string[],
  dependency_issue_numbers: [] as number[],
  duplicate_of_issue_number: null as number | null,
  implementation_after_issue_numbers: [] as number[],
  pull_request_overlaps: [] as unknown[],
  proposed_cohort_id: null as string | null,
  pull_request_owner_pr_number: null as number | null,
  review_confidence: 'high',
  lead_verification_obligations: ['Re-read the decisive source before mutation.'] as string[],
};

const registry = {
  schema_version: 1,
  repository: 'LucasQuiles/WhatSoup',
  generated_at: '2026-07-26T12:30:00Z',
  pinned_main_revision: MAIN_REVISION,
  inventory: {
    captured_at: '2026-07-26T12:30:00Z',
    open_issue_count: 1,
    open_pull_request_count: 2,
    draft_pull_request_count: 1,
    label_count: 2,
    labels: ['bug', 'reliability'] as string[],
  },
  issues: [issue],
};

function cloneRegistry(): typeof registry {
  return structuredClone(registry);
}

function batchStarted(
  batchId: string,
  operationId: string,
  issueNumbers: number[],
): Record<string, unknown> {
  return {
    schema_version: 1,
    receipt_type: 'batch_started',
    operation_id: operationId,
    batch_id: batchId,
    pinned_main_revision: MAIN_REVISION,
    planned_at: PLANNED_AT,
    plan_sha256: HASH_C,
    registry_sha256: HASH_E,
    issue_numbers: issueNumbers,
    operation_result: 'planned',
    diagnostic_code: null,
  };
}

function targetReceipt(
  receiptType: 'target_verified' | 'target_unknown',
  batchId: string,
  operationId: string,
  issueNumber: number,
  operationResult: string,
  appliedAt: string | null,
  verifiedAt: string | null,
  diagnosticCode: string | null,
  snapshotMode: 'changed' | 'no-op' = operationResult === 'no-op' ? 'no-op' : 'changed',
): Record<string, unknown> {
  const noOp = snapshotMode === 'no-op';
  return {
    schema_version: 1,
    receipt_type: receiptType,
    operation_id: operationId,
    batch_id: batchId,
    pinned_main_revision: MAIN_REVISION,
    issue_number: issueNumber,
    issue_node_id: `I_kwDOExample${issueNumber}`,
    planned_at: PLANNED_AT,
    applied_at: appliedAt,
    verified_at: verifiedAt,
    before: {
      updated_at: '2026-07-26T12:00:00Z',
      body_sha256: HASH_A,
      title_sha256: HASH_F,
      labels: ['bug'],
    },
    expected_after: {
      body_sha256: noOp ? HASH_A : HASH_C,
      title_sha256: HASH_F,
      labels: noOp ? ['bug'] : ['bug', 'reliability'],
    },
    title_delta: {
      before_sha256: HASH_F,
      after_sha256: HASH_F,
      changed: false,
    },
    label_delta: { add: noOp ? [] : ['reliability'], remove: [] },
    operation_result: operationResult,
    diagnostic_code: diagnosticCode,
  };
}

function completed(
  batchId: string,
  operationId: string,
  targetCount: number,
  operationResult: 'no-op' | 'applied-verified' = 'no-op',
): Record<string, unknown> {
  return {
    schema_version: 1,
    receipt_type: 'batch_completed',
    operation_id: operationId,
    batch_id: batchId,
    pinned_main_revision: MAIN_REVISION,
    planned_at: PLANNED_AT,
    completed_at: '2026-07-26T13:03:00Z',
    target_count: targetCount,
    verified_count: targetCount,
    unknown_count: 0,
    operation_result: operationResult,
    diagnostic_code: null,
  };
}

function chainRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  let previousReceiptSha256: string | null = null;
  return rows.map((row, index) => {
    const withoutHash = {
      ...row,
      sequence: index + 1,
      previous_receipt_sha256: previousReceiptSha256,
    };
    const receipt = {
      ...withoutHash,
      receipt_sha256: receiptSha256(withoutHash),
    };
    previousReceiptSha256 = receipt.receipt_sha256;
    return receipt;
  });
}

function ledgerText(rows: Array<Record<string, unknown>>): string {
  return `${chainRows(rows).map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function oneTargetRows(target: Record<string, unknown>): Array<Record<string, unknown>> {
  const batchId = String(target.batch_id);
  const operationId = String(target.operation_id);
  const rows = [batchStarted(batchId, operationId, [Number(target.issue_number)]), target];
  if (target.receipt_type === 'target_verified' && target.operation_result !== 'planned') {
    rows.push(completed(
      batchId,
      operationId,
      1,
      target.operation_result === 'no-op' ? 'no-op' : 'applied-verified',
    ));
  }
  return rows;
}

describe('open issue registry schema', () => {
  it('pins the exact live and addable label catalogues', () => {
    expect(LIVE_LABELS).toHaveLength(36);
    expect(LIVE_LABELS).toEqual([
      'bug', 'documentation', 'duplicate', 'enhancement', 'good first issue', 'help wanted',
      'invalid', 'question', 'wontfix', 'reliability', 'ops', 'P0', 'transport', 'alerts',
      'launchd', 'dependencies', 'javascript', 'audit', 'security', 'accessibility', 'console',
      'chat', 'config', 'media', 'scheduler', 'mcp', 'fleet', 'refactor', 'DRY', 'SSOT',
      'tech-debt', 'type-safety', 'dead-code', 'SOC', 'portability', 'linux',
    ]);
    expect(ADDABLE_LABELS).toHaveLength(25);
    expect(ADDABLE_LABELS).toEqual([
      'bug', 'enhancement', 'refactor', 'documentation', 'alerts', 'chat', 'config', 'console',
      'fleet', 'mcp', 'ops', 'scheduler', 'transport', 'audit', 'reliability', 'security',
      'portability', 'tech-debt', 'type-safety', 'DRY', 'SOC', 'SSOT', 'dead-code',
      'duplicate', 'invalid',
    ]);
  });

  it('accepts a complete registry and computes exact raw UTF-8 hashes', () => {
    expect(parseRegistry(registry)).toEqual(registry);
    expect(validateRegistry(parseRegistry(registry))).toEqual([]);
    expect(sha256('same')).toBe(sha256('same'));
    expect(sha256('same\n')).not.toBe(sha256('same'));
  });

  it('accepts the exact Task 2 structured overlap and refuses number-only overlap', () => {
    const structured = cloneRegistry();
    structured.issues[0].pull_request_overlaps = [overlap];
    expect(parseRegistry(structured)).toEqual(structured);

    const numberOnly = cloneRegistry();
    numberOnly.issues[0].pull_request_overlaps = [88];
    expect(() => parseRegistry(numberOnly)).toThrow();
  });

  it('rejects malformed, unsorted, and duplicate pull request overlap evidence', () => {
    const unsafeRef = cloneRegistry();
    unsafeRef.issues[0].pull_request_overlaps = [{ ...overlap, head_ref: '../private' }];
    expect(() => parseRegistry(unsafeRef)).toThrow(/ref/i);

    const atRef = cloneRegistry();
    atRef.issues[0].pull_request_overlaps = [{ ...overlap, head_ref: '@' }];
    expect(() => parseRegistry(atRef)).toThrow(/ref/i);

    const wrongUrl = cloneRegistry();
    wrongUrl.issues[0].pull_request_overlaps = [{
      ...overlap,
      url: 'https://github.com/LucasQuiles/WhatSoup/pull/89',
    }];
    expect(() => parseRegistry(wrongUrl)).toThrow(/url/i);

    const unknownField = cloneRegistry();
    unknownField.issues[0].pull_request_overlaps = [{ ...overlap, body: 'forbidden' }];
    expect(() => parseRegistry(unknownField)).toThrow(/body|unrecognized/i);

    for (const changes of [
      { disposition: 'unknown' },
      { assessment: 'unknown' },
      { matched_by: [] },
      { matched_by: ['touched-path', 'touched-path'] },
      { overlapping_paths: ['src/z.ts', 'src/a.ts'] },
      { overlapping_paths: [['', 'Users', 'operator', 'project'].join('/')] },
    ]) {
      const invalid = cloneRegistry();
      invalid.issues[0].pull_request_overlaps = [{ ...overlap, ...changes }];
      expect(() => parseRegistry(invalid)).toThrow();
    }

    const unsorted = cloneRegistry();
    unsorted.issues[0].pull_request_overlaps = [
      { ...overlap, number: 89, url: 'https://github.com/LucasQuiles/WhatSoup/pull/89' },
      overlap,
    ];
    expect(() => parseRegistry(unsorted)).toThrow(/sorted/i);

    const duplicate = cloneRegistry();
    duplicate.issues[0].pull_request_overlaps = [overlap, overlap];
    expect(() => parseRegistry(duplicate)).toThrow(/sorted|unique/i);
  });

  it('rejects unsafe issue URLs, repository paths, and unsorted or duplicate lists', () => {
    const unsafeUrl = cloneRegistry();
    unsafeUrl.issues[0].url = 'https://example.com/LucasQuiles/WhatSoup/issues/101';
    expect(() => parseRegistry(unsafeUrl)).toThrow(/URL/i);

    const unsafePath = cloneRegistry();
    unsafePath.issues[0].affected_paths = [['', 'Users', 'operator', 'project', 'file.ts'].join('/')];
    expect(() => parseRegistry(unsafePath)).toThrow(/path/i);

    const duplicateLabels = cloneRegistry();
    duplicateLabels.issues[0].recommended_labels = ['bug', 'bug'];
    expect(() => parseRegistry(duplicateLabels)).toThrow(/sorted|duplicates/i);

    const unsortedRelationships = cloneRegistry();
    unsortedRelationships.issues[0].dependency_issue_numbers = [102, 99];
    expect(() => parseRegistry(unsortedRelationships)).toThrow(/sorted/i);
  });

  it.each([0x01, 0x1f, 0x7f])('rejects repository paths containing control U+%s', (codePoint) => {
    const invalid = cloneRegistry();
    invalid.issues[0].affected_paths = [`src/${String.fromCharCode(codePoint)}file.ts`];
    expect(() => parseRegistry(invalid)).toThrow(/path/i);
  });

  it('rejects duplicate issues, self-references, URL drift, and inventory drift deterministically', () => {
    const invalid = cloneRegistry();
    invalid.issues.push({
      ...structuredClone(issue),
      recommended_labels: ['not-a-live-label'],
      dependency_issue_numbers: [101],
    });

    const findings = validateRegistry(parseRegistry(invalid));
    expect(findings.map((finding) => finding.code)).toEqual([
      'baseline-count-mismatch',
      'duplicate-issue-number',
      'self-dependency',
      'unknown-recommended-label',
    ]);

    const urlDrift = cloneRegistry();
    urlDrift.issues[0].url = 'https://github.com/LucasQuiles/WhatSoup/issues/102';
    expect(validateRegistry(parseRegistry(urlDrift)).map((finding) => finding.code))
      .toContain('issue-url-mismatch');
  });

  it('preserves current labels and refuses new live-but-non-addable labels', () => {
    const missingCurrent = cloneRegistry();
    missingCurrent.issues[0].recommended_labels = ['reliability'];
    expect(validateRegistry(parseRegistry(missingCurrent)).map((finding) => finding.code))
      .toContain('current-label-not-recommended');

    const nonAddable = cloneRegistry();
    nonAddable.issues[0].recommended_labels = ['bug', 'good first issue', 'reliability'];
    expect(validateRegistry(parseRegistry(nonAddable)).map((finding) => finding.code))
      .toContain('non-addable-recommended-label');

    const preserved = cloneRegistry();
    preserved.issues[0].current_labels = ['good first issue'];
    preserved.issues[0].recommended_labels = ['good first issue'];
    expect(validateRegistry(parseRegistry(preserved))).toEqual([]);
  });

  it('detects cycles among open implementation-order relationships', () => {
    const cyclic = cloneRegistry();
    const second = structuredClone(issue);
    second.issue_number = 102;
    second.issue_node_id = 'I_kwDOExample102';
    second.url = 'https://github.com/LucasQuiles/WhatSoup/issues/102';
    second.implementation_after_issue_numbers = [101];
    cyclic.issues[0].implementation_after_issue_numbers = [102];
    cyclic.issues.push(second);
    cyclic.inventory.open_issue_count = 2;

    expect(validateRegistry(parseRegistry(cyclic)).map((finding) => finding.code))
      .toEqual(['implementation-order-cycle', 'implementation-order-cycle']);
  });

  it('rejects every direct self-reference', () => {
    const selfDependency = cloneRegistry();
    selfDependency.issues[0].dependency_issue_numbers = [101];
    expect(validateRegistry(parseRegistry(selfDependency)).map((finding) => finding.code))
      .toContain('self-dependency');

    const selfDuplicate = cloneRegistry();
    selfDuplicate.issues[0].classification = 'duplicate';
    selfDuplicate.issues[0].duplicate_of_issue_number = 101;
    expect(validateRegistry(parseRegistry(selfDuplicate)).map((finding) => finding.code))
      .toContain('self-duplicate');

    const selfOrder = cloneRegistry();
    selfOrder.issues[0].implementation_after_issue_numbers = [101];
    expect(validateRegistry(parseRegistry(selfOrder)).map((finding) => finding.code))
      .toContain('self-implementation-order');

    const selfPartial = cloneRegistry();
    selfPartial.issues[0].evidence_state = 'partial';
    selfPartial.issues[0].partial_findings = [{
      key: 'ownership-gap',
      summary: 'Finding.',
      disposition: 'survives',
      related_issue_number: 101,
    }];
    expect(validateRegistry(parseRegistry(selfPartial)).map((finding) => finding.code))
      .toContain('self-partial-finding-reference');
  });
});

describe('registry classification and cohort semantics', () => {
  it('requires actionable leaf boundaries, paths, falsifier, and acceptance criteria', () => {
    for (const field of [
      'owner_boundary',
      'affected_paths',
      'falsifier_or_remaining_gap',
      'acceptance_criteria',
    ] as const) {
      const invalid = cloneRegistry();
      if (field === 'owner_boundary') invalid.issues[0][field] = null;
      else if (field === 'falsifier_or_remaining_gap') invalid.issues[0][field] = '';
      else invalid.issues[0][field] = [];
      expect(validateRegistry(parseRegistry(invalid)).map((finding) => finding.code))
        .toContain(`leaf-${field.replaceAll('_', '-')}-required`);
    }
  });

  it('requires duplicate classification and target consistency without requiring an open target', () => {
    const valid = cloneRegistry();
    valid.issues[0].classification = 'duplicate';
    valid.issues[0].duplicate_of_issue_number = 999;
    valid.issues[0].owner_boundary = null;
    expect(validateRegistry(parseRegistry(valid))).toEqual([]);

    const missing = structuredClone(valid);
    missing.issues[0].duplicate_of_issue_number = null;
    expect(validateRegistry(parseRegistry(missing)).map((finding) => finding.code))
      .toContain('duplicate-target-required');

    const contradictory = cloneRegistry();
    contradictory.issues[0].duplicate_of_issue_number = 999;
    expect(validateRegistry(parseRegistry(contradictory)).map((finding) => finding.code))
      .toContain('duplicate-target-forbidden');
  });

  it('enforces stale, measurement-only, and partial evidence coherence', () => {
    const stale = cloneRegistry();
    stale.issues[0].classification = 'stale';
    stale.issues[0].evidence_state = 'contradicted';
    stale.issues[0].owner_boundary = null;
    expect(validateRegistry(parseRegistry(stale))).toEqual([]);

    stale.issues[0].evidence_state = 'verified';
    expect(validateRegistry(parseRegistry(stale)).map((finding) => finding.code))
      .toContain('stale-evidence-state');

    for (const evidenceState of [
      'measurement-required',
      'live-revalidation-required',
      'inconclusive',
    ]) {
      const measurement = cloneRegistry();
      measurement.issues[0].classification = 'measurement-only';
      measurement.issues[0].evidence_state = evidenceState;
      measurement.issues[0].owner_boundary = null;
      expect(validateRegistry(parseRegistry(measurement))).toEqual([]);
    }

    const wrongMeasurement = cloneRegistry();
    wrongMeasurement.issues[0].classification = 'measurement-only';
    wrongMeasurement.issues[0].evidence_state = 'verified';
    wrongMeasurement.issues[0].owner_boundary = null;
    expect(validateRegistry(parseRegistry(wrongMeasurement)).map((finding) => finding.code))
      .toContain('measurement-only-evidence-state');

    const partial = cloneRegistry();
    partial.issues[0].evidence_state = 'partial';
    partial.issues[0].partial_findings = [{
      key: 'ownership-gap',
      summary: 'The durable owner remains missing.',
      disposition: 'survives',
      related_issue_number: null,
    }];
    expect(validateRegistry(parseRegistry(partial))).toEqual([]);

    partial.issues[0].partial_findings = [];
    expect(validateRegistry(parseRegistry(partial)).map((finding) => finding.code))
      .toContain('partial-findings-required');

    const unexpected = cloneRegistry();
    unexpected.issues[0].partial_findings = [{
      key: 'ownership-gap',
      summary: 'The durable owner remains missing.',
      disposition: 'survives',
      related_issue_number: null,
    }];
    expect(validateRegistry(parseRegistry(unexpected)).map((finding) => finding.code))
      .toContain('partial-findings-forbidden');
  });

  it('requires partial findings to be strict, sorted, and unique by stable key', () => {
    const invalid = cloneRegistry();
    invalid.issues[0].evidence_state = 'partial';
    invalid.issues[0].partial_findings = [
      {
        key: 'z-gap',
        summary: 'Later finding.',
        disposition: 'survives',
        related_issue_number: null,
      },
      {
        key: 'a-gap',
        summary: 'Earlier finding.',
        disposition: 'fixed',
        related_issue_number: 99,
      },
    ];
    expect(() => parseRegistry(invalid)).toThrow(/sorted/i);

    invalid.issues[0].partial_findings = [{
      key: 'ownership-gap',
      summary: 'Finding.',
      disposition: 'survives',
      related_issue_number: null,
      body: 'forbidden',
    }];
    expect(() => parseRegistry(invalid)).toThrow(/unrecognized|body/i);
  });

  it('keeps trackers out of cohorts and requires leaf cohorts to have an owner', () => {
    const tracker = cloneRegistry();
    tracker.issues[0].classification = 'tracker';
    tracker.issues[0].owner_boundary = null;
    expect(validateRegistry(parseRegistry(tracker))).toEqual([]);

    tracker.issues[0].proposed_cohort_id = 'runtime-owner';
    tracker.issues[0].pull_request_owner_pr_number = 77;
    expect(validateRegistry(parseRegistry(tracker)).map((finding) => finding.code))
      .toEqual(expect.arrayContaining(['tracker-cohort-forbidden', 'tracker-pr-owner-forbidden']));

    const missingOwner = cloneRegistry();
    missingOwner.issues[0].proposed_cohort_id = 'runtime-owner';
    expect(validateRegistry(parseRegistry(missingOwner)).map((finding) => finding.code))
      .toContain('cohort-pr-owner-required');

    const validLeafCohort = cloneRegistry();
    validLeafCohort.issues[0].proposed_cohort_id = 'runtime-owner';
    validLeafCohort.issues[0].pull_request_owner_pr_number = 77;
    expect(validateRegistry(parseRegistry(validLeafCohort))).toEqual([]);
  });

  it('rejects cohorts for duplicate, stale, and measurement-only records', () => {
    for (const [classification, evidenceState] of [
      ['duplicate', 'verified'],
      ['stale', 'contradicted'],
      ['measurement-only', 'measurement-required'],
    ]) {
      const invalid = cloneRegistry();
      invalid.issues[0].classification = classification;
      invalid.issues[0].evidence_state = evidenceState;
      invalid.issues[0].owner_boundary = null;
      invalid.issues[0].proposed_cohort_id = 'runtime-owner';
      invalid.issues[0].pull_request_owner_pr_number = 77;
      if (classification === 'duplicate') invalid.issues[0].duplicate_of_issue_number = 999;
      expect(validateRegistry(parseRegistry(invalid)).map((finding) => finding.code))
        .toContain(`${classification}-cohort-forbidden`);
    }
  });

  it('rejects a cohort with an open owning overlap and compares owner against overlap.number', () => {
    const owningOverlap = cloneRegistry();
    owningOverlap.issues[0].proposed_cohort_id = 'runtime-owner';
    owningOverlap.issues[0].pull_request_owner_pr_number = 77;
    owningOverlap.issues[0].pull_request_overlaps = [{ ...overlap, assessment: 'owns' }];
    expect(validateRegistry(parseRegistry(owningOverlap)).map((finding) => finding.code))
      .toContain('cohort-open-owner-overlap');

    const ownerOverlap = cloneRegistry();
    ownerOverlap.issues[0].proposed_cohort_id = 'runtime-owner';
    ownerOverlap.issues[0].pull_request_owner_pr_number = 88;
    ownerOverlap.issues[0].pull_request_overlaps = [overlap];
    expect(validateRegistry(parseRegistry(ownerOverlap)).map((finding) => finding.code))
      .toContain('owner-pr-listed-as-overlap');
  });
});

describe('PUBLIC registry safety', () => {
  it.each([
    [[['', 'Users', 'privateoperator', 'project'].join('/')], /public|private|path/i],
    [[['operator', 'real-company.com'].join('@')], /public|private|email/i],
    [[['120363123456789', 'g.us'].join('@')], /public|private|secret|redaction/i],
    [[['15551234567', 's.whatsapp.net'].join('@')], /public|private|secret|redaction/i],
  ])('refuses private literal %s', (privateText, expected) => {
    const invalid = cloneRegistry();
    invalid.issues[0].evidence_summary = privateText[0];
    expect(() => parseRegistry(invalid)).toThrow(expected);
  });

  it('refuses secret-like values and forbidden attribution assembled at runtime', () => {
    const secret = cloneRegistry();
    secret.issues[0].evidence_summary = ['ghp', 'AbCdEf0123456789AbCdEf'].join('_');
    expect(() => parseRegistry(secret)).toThrow(/public|secret|redaction/i);

    const attribution = cloneRegistry();
    attribution.issues[0].evidence_summary = ['Generated', 'by', 'Codex'].join(' ');
    expect(() => parseRegistry(attribution)).toThrow(/public|attribution/i);
  });

  it('allows public GitHub URLs, repository paths, and GitHub noreply addresses', () => {
    const publicRegistry = cloneRegistry();
    publicRegistry.issues[0].evidence_summary =
      'See https://github.com/LucasQuiles/WhatSoup/issues/101 and src/example.ts; SoupBot <soupbot@users.noreply.github.com>.';
    expect(parseRegistry(publicRegistry)).toEqual(publicRegistry);
  });
});

describe('mutation receipt schema and ledger lifecycle', () => {
  it('hashes and parses all four strict receipt variants without body or title text', () => {
    const batchId = HASH_E;
    const operationId = 'op-101';
    const rows = [
      batchStarted(batchId, operationId, [101, 102]),
      targetReceipt(
        'target_verified',
        batchId,
        operationId,
        101,
        'applied-verified',
        APPLIED_AT,
        VERIFIED_AT,
        null,
      ),
      targetReceipt(
        'target_verified',
        batchId,
        operationId,
        102,
        'no-op',
        null,
        VERIFIED_AT,
        null,
      ),
      completed(batchId, operationId, 2, 'applied-verified'),
    ];
    const receipts = parseLedger(ledgerText(rows));

    expect(receipts.map((receipt) => receipt.receipt_type)).toEqual([
      'batch_started',
      'target_verified',
      'target_verified',
      'batch_completed',
    ]);
    expect(receipts.every((receipt) => /^[0-9a-f]{64}$/.test(receipt.receipt_sha256))).toBe(true);

    const unknownRows = [
      batchStarted(batchId, operationId, [101]),
      targetReceipt(
        'target_unknown',
        batchId,
        operationId,
        101,
        'write-outcome-unknown',
        APPLIED_AT,
        null,
        'transport-timeout',
      ),
    ];
    expect(parseLedger(ledgerText(unknownRows)).at(-1)?.receipt_type).toBe('target_unknown');
  });

  it('parses a complete two-target batch followed by a second complete batch', () => {
    const rows = [
      batchStarted(HASH_E, 'op-first', [101, 102]),
      targetReceipt('target_verified', HASH_E, 'op-first', 101, 'no-op', null, VERIFIED_AT, null),
      targetReceipt('target_verified', HASH_E, 'op-first', 102, 'no-op', null, VERIFIED_AT, null),
      completed(HASH_E, 'op-first', 2, 'no-op'),
      batchStarted(HASH_F, 'op-second', [103]),
      targetReceipt('target_verified', HASH_F, 'op-second', 103, 'no-op', null, VERIFIED_AT, null),
      completed(HASH_F, 'op-second', 1, 'no-op'),
    ];

    expect(parseLedger(ledgerText(rows))).toHaveLength(7);
  });

  it('accepts an empty ledger and an interrupted terminal-unknown batch', () => {
    expect(parseLedger('')).toEqual([]);
    const interrupted = [
      batchStarted(HASH_E, 'op-101', [101, 102]),
      targetReceipt(
        'target_unknown',
        HASH_E,
        'op-101',
        101,
        'write-outcome-unknown',
        APPLIED_AT,
        null,
        'transport-timeout',
      ),
    ];
    expect(parseLedger(ledgerText(interrupted))).toHaveLength(2);
  });

  it('requires a final LF for every nonempty ledger', () => {
    const withFinalLf = ledgerText([batchStarted(HASH_E, 'op-101', [101])]);
    expect(() => parseLedger(withFinalLf.slice(0, -1))).toThrow(/LF|newline/i);
  });

  it.each([
    [
      'write-outcome-unknown',
      APPLIED_AT,
      'transport-timeout',
      'applied-verified-after-ambiguous-response',
      APPLIED_AT,
      'transport-timeout',
      'changed',
    ],
    [
      'post-write-verification-failed',
      APPLIED_AT,
      'label-mismatch',
      'applied-verified-after-ambiguous-response',
      APPLIED_AT,
      'label-mismatch',
      'changed',
    ],
    [
      'failed-before-write',
      null,
      'api-unavailable',
      'applied-verified',
      APPLIED_AT,
      null,
      'changed',
    ],
    [
      'refused-concurrent-update',
      null,
      'updated-at-drift',
      'no-op',
      null,
      null,
      'no-op',
    ],
  ] as const)(
    'recovers %s with the required exact target verification',
    (
      unknownResult,
      unknownAppliedAt,
      unknownDiagnostic,
      verifiedResult,
      verifiedAppliedAt,
      verifiedDiagnostic,
      snapshotMode,
    ) => {
      const rows = [
        batchStarted(HASH_E, `op-${unknownResult}`, [101]),
        targetReceipt(
          'target_unknown',
          HASH_E,
          `op-${unknownResult}`,
          101,
          unknownResult,
          unknownAppliedAt,
          null,
          unknownDiagnostic,
          snapshotMode,
        ),
        targetReceipt(
          'target_verified',
          HASH_E,
          `op-${unknownResult}`,
          101,
          verifiedResult,
          verifiedAppliedAt,
          VERIFIED_AT,
          verifiedDiagnostic,
          snapshotMode,
        ),
        completed(
          HASH_E,
          `op-${unknownResult}`,
          1,
          verifiedResult === 'no-op' ? 'no-op' : 'applied-verified',
        ),
      ];
      expect(parseLedger(ledgerText(rows))).toHaveLength(4);
    },
  );

  it('advances only after exact recovery and continues the batch', () => {
    const rows = [
      batchStarted(HASH_E, 'op-recovery', [101, 102]),
      targetReceipt(
        'target_unknown',
        HASH_E,
        'op-recovery',
        101,
        'write-outcome-unknown',
        APPLIED_AT,
        null,
        'transport-timeout',
      ),
      targetReceipt(
        'target_verified',
        HASH_E,
        'op-recovery',
        101,
        'applied-verified-after-ambiguous-response',
        APPLIED_AT,
        VERIFIED_AT,
        'transport-timeout',
      ),
      targetReceipt('target_verified', HASH_E, 'op-recovery', 102, 'no-op', null, VERIFIED_AT, null),
      completed(HASH_E, 'op-recovery', 2, 'applied-verified'),
    ];
    expect(parseLedger(ledgerText(rows))).toHaveLength(5);
  });

  it('rejects recovery drift in result, identity, snapshots, or deltas', () => {
    const mutations: Array<[string, (receipt: Record<string, unknown>) => void]> = [
      ['result', (receipt) => {
        receipt.operation_result = 'applied-verified';
        receipt.diagnostic_code = null;
      }],
      ['node', (receipt) => {
        receipt.issue_node_id = 'I_kwDODifferent';
      }],
      ['before snapshot', (receipt) => {
        (receipt.before as Record<string, unknown>).body_sha256 = HASH_E;
      }],
      ['expected snapshot', (receipt) => {
        (receipt.expected_after as Record<string, unknown>).body_sha256 = HASH_E;
      }],
      ['title delta', (receipt) => {
        (receipt.expected_after as Record<string, unknown>).title_sha256 = HASH_A;
        receipt.title_delta = {
          before_sha256: HASH_F,
          after_sha256: HASH_A,
          changed: true,
        };
      }],
      ['label delta', (receipt) => {
        (receipt.expected_after as Record<string, unknown>).labels = ['bug'];
        receipt.label_delta = { add: [], remove: [] };
      }],
    ];

    for (const [name, mutate] of mutations) {
      const unknown = targetReceipt(
        'target_unknown',
        HASH_E,
        'op-recovery-drift',
        101,
        'write-outcome-unknown',
        APPLIED_AT,
        null,
        'transport-timeout',
      );
      const recovery = targetReceipt(
        'target_verified',
        HASH_E,
        'op-recovery-drift',
        101,
        'applied-verified-after-ambiguous-response',
        APPLIED_AT,
        VERIFIED_AT,
        'transport-timeout',
      );
      mutate(recovery);
      expect(
        () => parseLedger(ledgerText([
          batchStarted(HASH_E, 'op-recovery-drift', [101]),
          unknown,
          recovery,
        ])),
        name,
      ).toThrow(/recovery|delta|snapshot|title/i);
    }
  });

  it('requires refused-concurrent-update recovery to preserve a strict no-op snapshot', () => {
    const rows = [
      batchStarted(HASH_E, 'op-refused-drift', [101]),
      targetReceipt(
        'target_unknown',
        HASH_E,
        'op-refused-drift',
        101,
        'refused-concurrent-update',
        null,
        null,
        'updated-at-drift',
      ),
      targetReceipt(
        'target_verified',
        HASH_E,
        'op-refused-drift',
        101,
        'no-op',
        null,
        VERIFIED_AT,
        null,
        'no-op',
      ),
    ];
    expect(() => parseLedger(ledgerText(rows))).toThrow(/recover|no-op/i);
  });

  it.each([
    ['wrong transition', [
      batchStarted(HASH_E, 'op-101', [101]),
      completed(HASH_E, 'op-101', 1),
    ]],
    ['wrong batch ID', [
      batchStarted(HASH_E, 'op-101', [101]),
      targetReceipt('target_verified', HASH_F, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
    ]],
    ['wrong operation ID', [
      batchStarted(HASH_E, 'op-101', [101]),
      targetReceipt('target_verified', HASH_E, 'op-other', 101, 'no-op', null, VERIFIED_AT, null),
    ]],
    ['wrong target order', [
      batchStarted(HASH_E, 'op-101', [101, 102]),
      targetReceipt('target_verified', HASH_E, 'op-101', 102, 'no-op', null, VERIFIED_AT, null),
      targetReceipt('target_verified', HASH_E, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
    ]],
    ['target absent from start', [
      batchStarted(HASH_E, 'op-101', [101]),
      targetReceipt('target_verified', HASH_E, 'op-101', 102, 'no-op', null, VERIFIED_AT, null),
    ]],
    ['repeated target', [
      batchStarted(HASH_E, 'op-101', [101, 102]),
      targetReceipt('target_verified', HASH_E, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
      targetReceipt('target_verified', HASH_E, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
    ]],
    ['wrong completion count', [
      batchStarted(HASH_E, 'op-101', [101]),
      targetReceipt('target_verified', HASH_E, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
      completed(HASH_E, 'op-101', 2),
    ]],
    ['post-unknown target', [
      batchStarted(HASH_E, 'op-101', [101, 102]),
      targetReceipt(
        'target_unknown',
        HASH_E,
        'op-101',
        101,
        'write-outcome-unknown',
        APPLIED_AT,
        null,
        'transport-timeout',
      ),
      targetReceipt('target_verified', HASH_E, 'op-101', 102, 'no-op', null, VERIFIED_AT, null),
    ]],
    ['new batch after unknown', [
      batchStarted(HASH_E, 'op-101', [101]),
      targetReceipt(
        'target_unknown',
        HASH_E,
        'op-101',
        101,
        'write-outcome-unknown',
        APPLIED_AT,
        null,
        'transport-timeout',
      ),
      batchStarted(HASH_F, 'op-102', [102]),
    ]],
    ['reused batch ID', [
      batchStarted(HASH_E, 'op-101', [101]),
      targetReceipt('target_verified', HASH_E, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
      completed(HASH_E, 'op-101', 1),
      batchStarted(HASH_E, 'op-102', [102]),
    ]],
    ['changed pinned main revision', [
      batchStarted(HASH_E, 'op-101', [101]),
      {
        ...targetReceipt('target_verified', HASH_E, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
        pinned_main_revision: 'd'.repeat(40),
      },
    ]],
    ['changed planned time', [
      batchStarted(HASH_E, 'op-101', [101]),
      {
        ...targetReceipt('target_verified', HASH_E, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
        planned_at: '2026-07-26T13:00:01Z',
      },
    ]],
    ['completed batch with unknown count', [
      batchStarted(HASH_E, 'op-101', [101]),
      targetReceipt('target_verified', HASH_E, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
      {
        ...completed(HASH_E, 'op-101', 1),
        verified_count: 0,
        unknown_count: 1,
      },
    ]],
  ] as const)('rejects %s', (_name, rows) => {
    expect(() => parseLedger(ledgerText([...rows]))).toThrow();
  });

  it('rejects a non-start first row and an empty or unsorted start target list', () => {
    expect(() => parseLedger(ledgerText([
      targetReceipt('target_verified', HASH_E, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
    ]))).toThrow(/active batch/i);
    expect(() => ledgerText([batchStarted(HASH_E, 'op-101', [])])).toThrow(/nonempty/i);
    expect(() => ledgerText([batchStarted(HASH_E, 'op-101', [102, 101])])).toThrow(/sorted/i);
  });

  it('rejects wrong global sequence and previous hash linkage', () => {
    const rows = chainRows([
      batchStarted(HASH_E, 'op-101', [101]),
      targetReceipt('target_verified', HASH_E, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
    ]);

    const wrongSequence = structuredClone(rows);
    wrongSequence[1].sequence = 3;
    const { receipt_sha256: _sequenceHash, ...sequenceWithoutHash } = wrongSequence[1];
    wrongSequence[1] = {
      ...sequenceWithoutHash,
      receipt_sha256: receiptSha256(sequenceWithoutHash),
    };
    expect(() => parseLedger(`${wrongSequence.map((row) => JSON.stringify(row)).join('\n')}\n`))
      .toThrow(/sequence/i);

    const wrongPrevious = structuredClone(rows);
    wrongPrevious[1].previous_receipt_sha256 = HASH_F;
    const { receipt_sha256: _previousHash, ...previousWithoutHash } = wrongPrevious[1];
    wrongPrevious[1] = {
      ...previousWithoutHash,
      receipt_sha256: receiptSha256(previousWithoutHash),
    };
    expect(() => parseLedger(`${wrongPrevious.map((row) => JSON.stringify(row)).join('\n')}\n`))
      .toThrow(/previous|chain/i);
  });

  it('rejects receipt hash tampering and complete body or title text fields', () => {
    const receipts = chainRows([
      batchStarted(HASH_E, 'op-101', [101]),
      targetReceipt('target_verified', HASH_E, 'op-101', 101, 'no-op', null, VERIFIED_AT, null),
      completed(HASH_E, 'op-101', 1, 'no-op'),
    ]);

    const tampered = structuredClone(receipts);
    tampered[1].receipt_sha256 = HASH_A;
    expect(() => parseLedger(`${tampered.map((row) => JSON.stringify(row)).join('\n')}\n`))
      .toThrow(/receipt_sha256/i);

    for (const field of ['body', 'title']) {
      const forbidden = structuredClone(receipts);
      forbidden[1][field] = 'complete unsafe text';
      expect(() => parseLedger(`${forbidden.map((row) => JSON.stringify(row)).join('\n')}\n`))
        .toThrow(new RegExp(field, 'i'));
    }
  });
});

describe('mutation result timestamp and diagnostic coherence', () => {
  const validCases = [
    targetReceipt('target_verified', HASH_E, 'op-planned', 101, 'planned', null, null, null),
    targetReceipt('target_verified', HASH_E, 'op-no-op', 101, 'no-op', null, VERIFIED_AT, null),
    targetReceipt(
      'target_verified',
      HASH_E,
      'op-applied',
      101,
      'applied-verified',
      APPLIED_AT,
      VERIFIED_AT,
      null,
    ),
    targetReceipt(
      'target_verified',
      HASH_E,
      'op-ambiguous',
      101,
      'applied-verified-after-ambiguous-response',
      APPLIED_AT,
      VERIFIED_AT,
      'transport-timeout',
    ),
    targetReceipt(
      'target_unknown',
      HASH_E,
      'op-refused',
      101,
      'refused-concurrent-update',
      null,
      null,
      'updated-at-drift',
    ),
    targetReceipt(
      'target_unknown',
      HASH_E,
      'op-failed',
      101,
      'failed-before-write',
      null,
      null,
      'api-unavailable',
    ),
    targetReceipt(
      'target_unknown',
      HASH_E,
      'op-unknown',
      101,
      'write-outcome-unknown',
      APPLIED_AT,
      null,
      'transport-timeout',
    ),
    targetReceipt(
      'target_unknown',
      HASH_E,
      'op-post-write',
      101,
      'post-write-verification-failed',
      APPLIED_AT,
      null,
      'label-mismatch',
    ),
  ];

  it.each(validCases)('accepts coherent $operation_result receipts', (target) => {
    expect(() => parseLedger(ledgerText(oneTargetRows(target)))).not.toThrow();
  });

  it('requires no-op snapshots and deltas to be exact equality', () => {
    const mutations: Array<(receipt: Record<string, unknown>) => void> = [
      (receipt) => {
        (receipt.expected_after as Record<string, unknown>).body_sha256 = HASH_C;
      },
      (receipt) => {
        (receipt.expected_after as Record<string, unknown>).title_sha256 = HASH_A;
        receipt.title_delta = {
          before_sha256: HASH_F,
          after_sha256: HASH_A,
          changed: true,
        };
      },
      (receipt) => {
        (receipt.expected_after as Record<string, unknown>).labels = ['bug', 'reliability'];
        receipt.label_delta = { add: ['reliability'], remove: [] };
      },
    ];

    for (const mutate of mutations) {
      const invalid = targetReceipt(
        'target_verified',
        HASH_E,
        'op-no-op-drift',
        101,
        'no-op',
        null,
        VERIFIED_AT,
        null,
      );
      mutate(invalid);
      expect(() => parseLedger(ledgerText(oneTargetRows(invalid)))).toThrow(/no-op/i);
    }
  });

  it('rejects planned targets and incoherent aggregate results in completed batches', () => {
    const planned = [
      batchStarted(HASH_E, 'op-planned-complete', [101]),
      targetReceipt('target_verified', HASH_E, 'op-planned-complete', 101, 'planned', null, null, null),
      completed(HASH_E, 'op-planned-complete', 1, 'no-op'),
    ];
    expect(() => parseLedger(ledgerText(planned))).toThrow(/planned|completion/i);

    const allNoOpClaimedApplied = [
      batchStarted(HASH_E, 'op-all-no-op', [101]),
      targetReceipt('target_verified', HASH_E, 'op-all-no-op', 101, 'no-op', null, VERIFIED_AT, null),
      completed(HASH_E, 'op-all-no-op', 1, 'applied-verified'),
    ];
    expect(() => parseLedger(ledgerText(allNoOpClaimedApplied))).toThrow(/result|no-op/i);

    const appliedClaimedNoOp = [
      batchStarted(HASH_E, 'op-applied', [101]),
      targetReceipt(
        'target_verified',
        HASH_E,
        'op-applied',
        101,
        'applied-verified',
        APPLIED_AT,
        VERIFIED_AT,
        null,
      ),
      completed(HASH_E, 'op-applied', 1, 'no-op'),
    ];
    expect(() => parseLedger(ledgerText(appliedClaimedNoOp))).toThrow(/result|no-op/i);
  });

  it('completes a mixed verified batch as applied-verified', () => {
    const rows = [
      batchStarted(HASH_E, 'op-mixed', [101, 102]),
      targetReceipt('target_verified', HASH_E, 'op-mixed', 101, 'no-op', null, VERIFIED_AT, null),
      targetReceipt(
        'target_verified',
        HASH_E,
        'op-mixed',
        102,
        'applied-verified-after-ambiguous-response',
        APPLIED_AT,
        VERIFIED_AT,
        'transport-timeout',
      ),
      completed(HASH_E, 'op-mixed', 2, 'applied-verified'),
    ];
    expect(parseLedger(ledgerText(rows))).toHaveLength(4);
  });

  it.each([
    ['planned with applied timestamp', validCases[0], { applied_at: APPLIED_AT }],
    ['no-op without verification', validCases[1], { verified_at: null }],
    ['applied-verified without application', validCases[2], { applied_at: null }],
    ['ambiguous verification without diagnostic', validCases[3], { diagnostic_code: null }],
    ['refused update without diagnostic', validCases[4], { diagnostic_code: null }],
    ['failed-before-write with application timestamp', validCases[5], { applied_at: APPLIED_AT }],
    ['unknown write without application timestamp', validCases[6], { applied_at: null }],
    ['post-write mismatch with verification timestamp', validCases[7], { verified_at: VERIFIED_AT }],
  ] as const)('rejects %s', (_name, target, changes) => {
    const invalid = { ...target, ...changes };
    expect(() => parseLedger(ledgerText(oneTargetRows(invalid)))).toThrow();
  });

  it('rejects applied-verified with both timestamps null', () => {
    const invalid = targetReceipt(
      'target_verified',
      HASH_E,
      'op-applied',
      101,
      'applied-verified',
      null,
      null,
      null,
    );
    expect(() => parseLedger(ledgerText(oneTargetRows(invalid)))).toThrow();
  });
});
