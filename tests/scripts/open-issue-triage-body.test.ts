import { describe, expect, it } from 'vitest';
import {
  mergeReviewBlock,
  renderReviewBlock,
} from '../../scripts/lib/open-issue-triage/body.ts';
import {
  sha256,
  type OpenIssueRegistry,
} from '../../scripts/lib/open-issue-triage/model.ts';

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

  it('hashes exactly the canonical payload without its intent comment', () => {
    const block = renderReviewBlock(reviewRecord());
    const intentComments = block.match(
      /^<!-- triage-review:intent-sha256=([0-9a-f]{64}) -->$/gm,
    ) ?? [];
    const match = /^<!-- triage-review:intent-sha256=([0-9a-f]{64}) -->$/m.exec(block);

    expect(intentComments).toHaveLength(1);
    if (match === null) throw new Error('intent comment missing');

    const canonicalPayload = block.replace(`${match[0]}\n`, '');
    expect(canonicalPayload).not.toContain('triage-review:intent-sha256=');
    expect(sha256(canonicalPayload)).toBe(match[1]);
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
    ['uppercase', '<!-- TRIAGE-REVIEW:START -->\nA\n<!-- TRIAGE-REVIEW:END -->'],
    ['mixed case', '<!-- Triage-Review:Start -->\nA\n<!-- triage-review:end -->'],
    ['colon spacing', '<!-- triage-review : start -->\nA\n<!-- triage-review : end -->'],
    ['compact comment', '<!--triage-review:start-->\nA\n<!--triage-review:end-->'],
    ['extra comment spacing', '<!--  triage-review:start  -->\nA\n<!--  triage-review:end  -->'],
    ['mixed canonical pair', '<!-- triage-review:start -->\nA\n<!-- TRIAGE-REVIEW:END -->'],
    ['multiline kind', '<!-- triage-review:\nstart -->\nA\n<!-- triage-review:\nend -->'],
    ['multiline CRLF', '<!-- triage-review\r\n:\r\nstart -->\nA\n<!-- triage-review\r\n:\r\nend -->'],
    ['trailing word payload', '<!-- triage-review:start extra -->\nA\n<!-- triage-review:end extra -->'],
    ['trailing punctuation payload', '<!-- triage-review:start! -->\nA\n<!-- triage-review:end! -->'],
    ['trailing slash payload', '<!-- triage-review:start/foo -->\nA\n<!-- triage-review:end/foo -->'],
    ['trailing Unicode dash payload', '<!-- triage-review:start—foo -->\nA\n<!-- triage-review:end—foo -->'],
    ['incomplete comment', '<!-- triage-review:start extra'],
    [
      'malformed plus canonical',
      [
        '<!-- triage-review:start extra -->',
        'stale',
        '<!-- triage-review:end extra -->',
        '<!-- triage-review:start -->',
        'canonical',
        '<!-- triage-review:end -->',
      ].join('\n'),
    ],
  ])('refuses %s markers', (_name, body) => {
    expect(() => mergeReviewBlock(
      body,
      '<!-- triage-review:start -->\nA\n<!-- triage-review:end -->',
    )).toThrow(/marker/i);
  });

  it('allows harmless bare marker prose and fenced examples', () => {
    expect(() => renderReviewBlock(reviewRecord({
      evidence_summary: [
        'The literal triage-review:start appears in parser docs.',
        'The unrelated token triage-review:startling remains ordinary prose.',
        '<!-- docs mention triage-review:start as text -->',
        '<!-- triage-review:startling -->',
      ].join(' '),
    }))).not.toThrow();

    expect(() => mergeReviewBlock(
      'Owner example:\n```\ntriage-review:start\n```\n',
      '<!-- triage-review:start -->\nA\n<!-- triage-review:end -->',
    )).not.toThrow();
  });

  it.each([
    ['ASCII letters', 'startling'],
    ['ASCII digit', 'start2'],
    ['underscore', 'start_extra'],
    ['non-ASCII Latin letter', 'starté'],
    ['non-ASCII Greek letter', 'startα'],
    ['combining mark', `start\u0301`],
    ['connector punctuation', 'start‿'],
    ['ZWNJ', `start\u200Cfoo`],
    ['ZWJ', `start\u200Dfoo`],
  ])('allows harmless sentinel-like identifier continuation: %s', (_name, identifier) => {
    expect(() => mergeReviewBlock(
      `Owner comment:\n<!-- triage-review:${identifier} -->\n`,
      '<!-- triage-review:start -->\nA\n<!-- triage-review:end -->',
    )).not.toThrow();
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

  it.each([
    ['close', '#99'],
    ['Closes', 'LucasQuiles/WhatSoup#99'],
    ['CLOSED', 'https://github.com/LucasQuiles/WhatSoup/issues/99'],
    ['fix', '#99'],
    ['Fixes', 'LucasQuiles/WhatSoup#99'],
    ['FIXED', 'https://github.com/LucasQuiles/WhatSoup/issues/99'],
    ['resolve', '#99'],
    ['Resolves', 'LucasQuiles/WhatSoup#99'],
    ['RESOLVED', 'https://github.com/LucasQuiles/WhatSoup/issues/99'],
  ])('rejects the closing keyword %s with same-repository reference %s', (keyword, reference) => {
    expect(() => renderReviewBlock(reviewRecord({
      evidence_summary: `Evidence. **${keyword}:** [${reference}]`,
    }))).toThrow(/closing reference/i);
  });

  it('allows ordinary non-closing references', () => {
    expect(() => renderReviewBlock(reviewRecord({
      evidence_summary: [
        'Related to #99.',
        'See LucasQuiles/WhatSoup#100.',
        'Evidence at https://github.com/LucasQuiles/WhatSoup/issues/101.',
      ].join(' '),
    }))).not.toThrow();
  });

  it.each([
    ['straight double quotes', '"#99"'],
    ['straight single quotes', "'#99'"],
    ['curly quotes', '“#99”'],
    ['slash wrapper', '/#99/'],
    ['Unicode brackets', '【#99】'],
    ['backticks', '`LucasQuiles/WhatSoup#99`'],
    ['Markdown punctuation', '**[https://github.com/LucasQuiles/WhatSoup/issues/99]**'],
    ['symbol boundary', '→ #99'],
  ])('rejects closing references through %s', (_name, wrappedReference) => {
    expect(() => renderReviewBlock(reviewRecord({
      evidence_summary: `Fixes ${wrappedReference}`,
    }))).toThrow(/closing reference/i);
  });

  it('does not treat intervening prose as a closing-reference wrapper', () => {
    expect(() => renderReviewBlock(reviewRecord({
      evidence_summary: 'Fixes the display behavior discussed in #99.',
    }))).not.toThrow();
  });

  it('renders multiline registry prose as plain text without spoofed Markdown structure', () => {
    const block = renderReviewBlock(reviewRecord({
      evidence_summary: [
        'Evidence.',
        '',
        '### Suggested remediation',
        '- forged item',
        '> forged quote',
        '```ts',
        'forged fence',
        '```',
        '<!-- hidden -->',
      ].join('\n'),
      falsifier_or_remaining_gap: 'Gap.\n### Verification obligations',
      partial_findings: [{
        key: 'surviving-finding',
        summary: 'Finding.\n- forged finding item',
        disposition: 'survives',
        related_issue_number: null,
      }],
      suggested_remediation: 'Remediation.\n> forged remediation',
      acceptance_criteria: ['Criterion.\n- forged criterion'],
      impact: 'Impact.\n### Dependencies and overlap',
      blast_radius: 'Radius.\n1. forged ordered item',
      owner_boundary: 'owner\n### Evidence',
      pull_request_overlaps: [{
        ...overlap,
        title: 'Overlap title\n- forged overlap item',
      }],
      lead_verification_obligations: ['Verify.\n> forged obligation'],
    }));

    expect(block.match(/^### Evidence$/gm)).toHaveLength(1);
    expect(block.match(/^### Suggested remediation$/gm)).toHaveLength(1);
    expect(block.match(/^### Impact and blast radius$/gm)).toHaveLength(1);
    expect(block.match(/^### Dependencies and overlap$/gm)).toHaveLength(1);
    expect(block.match(/^### Verification obligations$/gm)).toHaveLength(1);
    expect(block).not.toMatch(/^> forged/gm);
    expect(block).not.toMatch(/^- forged/gm);
    expect(block).not.toMatch(/^\d+\. forged/gm);
    expect(block).not.toContain('```');
    expect(block).not.toContain('<!-- hidden -->');
    expect(block).toContain('&lt;!\\-\\- hidden \\-\\-&gt;');
  });

  it('uses CommonMark-safe inline-code fences for embedded and boundary backticks', () => {
    const block = renderReviewBlock(reviewRecord({
      decisive_source_paths: ['src/a`b``c.ts'],
      decisive_test_paths: ['tests/`edge``.test.ts'],
      affected_paths: ['src/a`b``c.ts'],
      owner_boundary: '`owner``boundary`',
    }));

    expect(block).toContain('```src/a`b``c.ts```');
    expect(block).toContain('```tests/`edge``.test.ts```');
    expect(block).toContain('``` `owner``boundary` ```');
    expect(block).not.toContain('a\\`b');
  });

  it.each([
    ['proposed title', reviewRecord({ recommended_title: ' \n\t ' })],
    ['evidence summary', reviewRecord({ evidence_summary: ' \n\t ' })],
    ['remediation', reviewRecord({ suggested_remediation: ' \n\t ' })],
    ['impact', reviewRecord({ impact: ' \n\t ' })],
    ['blast radius', reviewRecord({ blast_radius: ' \n\t ' })],
    ['partial-finding summary', reviewRecord({
      partial_findings: [{
        key: 'blank-summary',
        summary: ' \n\t ',
        disposition: 'survives',
        related_issue_number: null,
      }],
    })],
    ['PR overlap title', reviewRecord({
      pull_request_overlaps: [{ ...overlap, title: ' \n\t ' }],
    })],
    ['acceptance-criteria item', reviewRecord({ acceptance_criteria: [' \n\t '] })],
    ['verification-obligation item', reviewRecord({
      lead_verification_obligations: [' \n\t '],
    })],
    ['owner boundary', reviewRecord({ owner_boundary: ' \n\t ' })],
    ['decisive source path', reviewRecord({ decisive_source_paths: [' \t '] })],
    ['decisive test path', reviewRecord({ decisive_test_paths: [' \t '] })],
    ['affected path', reviewRecord({ affected_paths: [' \t '] })],
    ['overlap path', reviewRecord({
      pull_request_overlaps: [{ ...overlap, overlapping_paths: [' \t '] }],
    })],
  ])('rejects whitespace-empty required rendered %s', (_name, record) => {
    expect(() => renderReviewBlock(record)).toThrow(/empty|blank|required/i);
  });

  it('preserves the optional empty falsifier or remaining gap behavior', () => {
    const block = renderReviewBlock(reviewRecord({
      falsifier_or_remaining_gap: ' \n\t ',
    }));

    expect(block).toContain('**Falsifier or remaining gap:**\nNone recorded.');
  });
});
