import { describe, expect, it } from 'vitest';
import {
  mergeReviewBlock,
  renderReviewBlock,
} from '../../scripts/lib/open-issue-triage/body.ts';
import type { OpenIssueRegistry } from '../../scripts/lib/open-issue-triage/model.ts';

type ReviewRecord = OpenIssueRegistry['issues'][number];

const overlap: ReviewRecord['pull_request_overlaps'][number] = {
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

function reviewRecord(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
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
    dependency_issue_numbers: [99],
    duplicate_of_issue_number: null,
    implementation_after_issue_numbers: [100],
    pull_request_overlaps: [overlap],
    proposed_cohort_id: 'runtime-owner',
    pull_request_owner_pr_number: null,
    review_confidence: 'high',
    lead_verification_obligations: ['Re-read source before apply.'],
    ...overrides,
  };
}

describe('managed triage review body', () => {
  it('renders complete deterministic evidence without closing references', () => {
    const block = renderReviewBlock(reviewRecord());

    expect(block).toContain('<!-- triage-review:start -->');
    expect(block).toMatch(/<!-- triage-review:intent-sha256=[0-9a-f]{64} -->/);
    expect(block).toContain('## Triage review');
    expect(block).toContain('**Evidence state:** verified');
    expect(block).toContain(`**Pinned revision:** \`${'b'.repeat(40)}\``);
    expect(block).toContain('`src/example.ts`');
    expect(block).toContain('`tests/example.test.ts`');
    expect(block).toContain('### Suggested remediation');
    expect(block).toContain('### Impact and blast radius');
    expect(block).toContain('Depends on #99');
    expect(block).toContain('Implement after #100');
    expect(block).toContain('Open PR overlap: #88');
    expect(block).toContain('### Verification obligations');
    expect(block).toContain('<!-- triage-review:end -->');
    expect(block).not.toMatch(/\b(?:close[sd]?|fixe[sd]?|resolve[sd]?)\s+#/i);
    expect(renderReviewBlock(reviewRecord())).toBe(block);
    expect(renderReviewBlock(reviewRecord({
      impact: 'Accepted work can be delayed.',
    }))).not.toBe(block);
  });

  it('appends once, replaces only the managed span, and detects a no-op', () => {
    const first = mergeReviewBlock(
      'Owner-authored body.\n',
      '<!-- triage-review:start -->\nA\n<!-- triage-review:end -->',
    );
    const second = mergeReviewBlock(
      first.body,
      '<!-- triage-review:start -->\nB\n<!-- triage-review:end -->',
    );
    const unchanged = mergeReviewBlock(second.body, '<!-- triage-review:start -->\nB\n<!-- triage-review:end -->');

    expect(first.changed).toBe(true);
    expect(second).toEqual({
      body: 'Owner-authored body.\n\n<!-- triage-review:start -->\nB\n<!-- triage-review:end -->\n',
      changed: true,
    });
    expect(second.body).not.toContain('\nA\n');
    expect(unchanged).toEqual({ body: second.body, changed: false });
  });

  it('preserves CRLF prefix and suffix bytes outside the managed marker span', () => {
    const original = 'Owner line one.\r\nOwner line two.\r\n';
    const block = '<!-- triage-review:start -->\nA\n<!-- triage-review:end -->';
    const first = mergeReviewBlock(original, block);
    const wrapped = `${first.body}Owner suffix.\r\n`;
    const second = mergeReviewBlock(wrapped, block.replace('\nA\n', '\nB\n'));

    expect(second.body.startsWith(original)).toBe(true);
    expect(second.body.slice(0, original.length)).toBe(original);
    expect(second.body.endsWith('Owner suffix.\r\n')).toBe(true);
  });

  it.each([
    ['orphan start', '<!-- triage-review:start -->\nmissing end'],
    ['orphan end', 'missing start\n<!-- triage-review:end -->'],
    ['duplicate', '<!-- triage-review:start -->\nA\n<!-- triage-review:end -->\n<!-- triage-review:start -->\nB\n<!-- triage-review:end -->'],
    ['nested', '<!-- triage-review:start -->\n<!-- triage-review:start -->\n<!-- triage-review:end -->\n<!-- triage-review:end -->'],
    ['reversed', '<!-- triage-review:end -->\nA\n<!-- triage-review:start -->'],
    ['non-standalone', 'prefix <!-- triage-review:start -->\nA\n<!-- triage-review:end -->'],
  ])('refuses %s markers', (_name, body) => {
    expect(() => mergeReviewBlock(
      body,
      '<!-- triage-review:start -->\nA\n<!-- triage-review:end -->',
    )).toThrow(/marker/i);
  });

  it('fails closed on unsafe proposed titles, blocks, and expected bodies', () => {
    const privatePath = ['', 'Users', 'privateuser', 'project'].join('/');
    const secretLike = ['Bearer', 'abcdefghijkl'].join(' ');

    expect(() => renderReviewBlock(reviewRecord({
      recommended_title: `Unsafe ${privatePath}`,
    }))).toThrow(/public/i);
    expect(() => renderReviewBlock(reviewRecord({
      evidence_summary: 'Fixes #99.',
    }))).toThrow(/closing reference/i);
    expect(() => renderReviewBlock(reviewRecord({
      evidence_summary: '<!-- triage-review:end -->',
    }))).toThrow(/marker/i);
    expect(() => mergeReviewBlock(
      'Owner body.',
      `<!-- triage-review:start -->\n${privatePath}\n<!-- triage-review:end -->`,
    )).toThrow(/public/i);
    expect(() => mergeReviewBlock(
      `Owner body with ${privatePath}.`,
      '<!-- triage-review:start -->\nA\n<!-- triage-review:end -->',
    )).toThrow(/public/i);
    expect(() => mergeReviewBlock(
      'Owner body.',
      `<!-- triage-review:start -->\n${secretLike}\n<!-- triage-review:end -->`,
    )).toThrow(/secret-like/i);
  });
});
