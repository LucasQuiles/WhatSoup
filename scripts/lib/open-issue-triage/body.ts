import { assertNoSecretLike } from '../../artifact-redaction.ts';
import { scanTextForPrivateLiterals } from '../../publication-guard.ts';
import { scanContentLines } from '../../repo-hygiene-guard.ts';
import type { OpenIssueRegistry } from './model.ts';
import { sha256 } from './model.ts';

const START_MARKER = '<!-- triage-review:start -->';
const END_MARKER = '<!-- triage-review:end -->';
const SENTINEL_COMMENT_PREFIX =
  /<!--[ \t\r\n\f\v]{0,32}triage-review[ \t\r\n\f\v]{0,32}:[ \t\r\n\f\v]{0,32}(?:start|end)\b/giu;
const STANDALONE_MARKER =
  /(^|\n)(<!-- triage-review:(start|end) -->)(?=\r?(?:\n|$))/g;
const CLOSING_REFERENCE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\p{White_Space}\p{P}\p{S}]{0,32}(?:#\d+|LucasQuiles\/WhatSoup#\d+|https:\/\/github\.com\/LucasQuiles\/WhatSoup\/issues\/\d+)\b/iu;
const PUBLIC_BODY_PATH = 'docs/triage/open-issue-review.md';
const PUBLIC_TITLE_PATH = 'docs/triage/open-issue-title.md';

export type ReviewRecord = OpenIssueRegistry['issues'][number];

export interface ManagedBodyResult {
  body: string;
  changed: boolean;
}

interface ManagedSpan {
  start: number;
  end: number;
}

function assertRequiredValue(value: string, label: string): void {
  if (singleLine(value) === '') {
    throw new Error(`${label} is required and empty after whitespace normalization`);
  }
}

function code(value: string): string {
  assertRequiredValue(value, 'Inline code value');
  const backtickRuns = value.match(/`+/g) ?? [];
  const fence = '`'.repeat(
    1 + Math.max(0, ...backtickRuns.map((run) => run.length)),
  );
  const needsPadding = value.startsWith('`')
    || value.endsWith('`')
    || (value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '');
  const content = needsPadding ? ` ${value} ` : value;
  return `${fence}${content}${fence}`;
}

function singleLine(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function plainText(value: string): string {
  return singleLine(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]{}()#+.|~\-])/g, '\\$1');
}

function requiredPlainText(value: string, label: string): string {
  assertRequiredValue(value, label);
  return plainText(value);
}

function list(values: readonly string[], empty = 'None recorded.'): string {
  if (values.length === 0) return empty;
  return values.map((value) => `- ${value}`).join('\n');
}

function pathList(values: readonly string[]): string {
  return list(values.map(code));
}

function renderPartialFindings(record: ReviewRecord): string {
  return list(record.partial_findings.map((finding) => {
    const relatedIssue = finding.related_issue_number === null
      ? ''
      : `; related issue #${finding.related_issue_number}`;
    return `${code(finding.key)} — ${finding.disposition}: `
      + `${requiredPlainText(finding.summary, 'Partial-finding summary')}${relatedIssue}`;
  }));
}

function overlapPrefix(overlap: ReviewRecord['pull_request_overlaps'][number]): string {
  if (overlap.disposition === 'merged') return 'Merged PR overlap';
  if (overlap.disposition === 'closed-unmerged') return 'Closed PR overlap';
  return 'Open PR overlap';
}

function renderOverlap(overlap: ReviewRecord['pull_request_overlaps'][number]): string {
  const draft = overlap.is_draft ? ' (draft)' : '';
  const paths = overlap.overlapping_paths.length === 0
    ? ''
    : `; paths: ${overlap.overlapping_paths.map(code).join(', ')}`;
  return `${overlapPrefix(overlap)}: #${overlap.number}${draft} — `
    + `${requiredPlainText(overlap.title, 'PR overlap title')}`
    + ` — ${overlap.assessment}; matched by: ${overlap.matched_by.join(', ')}${paths}`
    + ` — ${overlap.url}`;
}

function renderDependencies(record: ReviewRecord): string {
  const entries = [
    ...record.dependency_issue_numbers.map((number) => `Depends on #${number}`),
    ...(record.duplicate_of_issue_number === null
      ? []
      : [`Duplicate of #${record.duplicate_of_issue_number}`]),
    ...record.implementation_after_issue_numbers.map((number) => `Implement after #${number}`),
    ...record.pull_request_overlaps.map(renderOverlap),
    ...(record.proposed_cohort_id === null
      ? []
      : [`Proposed cohort: ${code(record.proposed_cohort_id)}`]),
    ...(record.pull_request_owner_pr_number === null
      ? []
      : [`PR ownership: #${record.pull_request_owner_pr_number}`]),
  ];
  return list(entries);
}

function renderPayload(record: ReviewRecord): string {
  const remainingGap = plainText(record.falsifier_or_remaining_gap) === ''
    ? 'None recorded.'
    : plainText(record.falsifier_or_remaining_gap);
  const ownerBoundary = record.owner_boundary === null
    ? 'None recorded.'
    : code(singleLine(record.owner_boundary));

  return [
    START_MARKER,
    '## Triage review',
    '',
    `**Evidence state:** ${record.evidence_state}`,
    `**Classification:** ${record.classification}`,
    `**Review confidence:** ${record.review_confidence}`,
    `**Pinned revision:** ${code(record.pinned_revision)}`,
    '',
    '### Evidence',
    '',
    requiredPlainText(record.evidence_summary, 'Evidence summary'),
    '',
    '**Decisive source paths:**',
    pathList(record.decisive_source_paths),
    '',
    '**Decisive test paths:**',
    pathList(record.decisive_test_paths),
    '',
    '**Falsifier or remaining gap:**',
    remainingGap,
    '',
    '**Partial findings:**',
    renderPartialFindings(record),
    '',
    '### Suggested remediation',
    '',
    requiredPlainText(record.suggested_remediation, 'Suggested remediation'),
    '',
    '**Acceptance criteria:**',
    list(record.acceptance_criteria.map((value) =>
      requiredPlainText(value, 'Acceptance-criteria item'))),
    '',
    '### Impact and blast radius',
    '',
    `**Impact:** ${requiredPlainText(record.impact, 'Impact')}`,
    `**Blast radius:** ${requiredPlainText(record.blast_radius, 'Blast radius')}`,
    '',
    '**Affected paths:**',
    pathList(record.affected_paths),
    '',
    `**Owner boundary:** ${ownerBoundary}`,
    '',
    '### Dependencies and overlap',
    '',
    renderDependencies(record),
    '',
    '### Verification obligations',
    '',
    list(record.lead_verification_obligations.map((value) =>
      requiredPlainText(value, 'Verification-obligation item'))),
    END_MARKER,
  ].join('\n');
}

function assertPublicText(filePath: string, label: string, text: string): void {
  const publicationIssues = scanTextForPrivateLiterals(filePath, text);
  const hygieneIssues = scanContentLines(
    text.split(/\r?\n/).map((line, index) => ({
      filePath,
      line: index + 1,
      text: line,
    })),
  );
  const issues = [...publicationIssues, ...hygieneIssues];
  if (issues.length > 0) {
    throw new Error(
      `PUBLIC ${label} rejected: ${issues
        .map((issue) => `${issue.code}@${issue.line ?? 1}`)
        .join(', ')}`,
    );
  }
  assertNoSecretLike(text, label);
}

function assertNoClosingReference(label: string, text: string): void {
  if (CLOSING_REFERENCE.test(text)) {
    throw new Error(`${label} rejected: closing reference is not allowed`);
  }
}

function managedSpan(text: string, pairRequired: boolean): ManagedSpan | null {
  const sentinelCount = [...text.matchAll(SENTINEL_COMMENT_PREFIX)].length;
  const markers = [...text.matchAll(STANDALONE_MARKER)].map((match) => ({
    kind: match[3] as 'start' | 'end',
    start: match.index + match[1].length,
    end: match.index + match[1].length + match[2].length,
  }));

  if (sentinelCount !== markers.length) {
    throw new Error('Managed triage marker is malformed or is not standalone');
  }
  if (markers.length === 0) {
    if (pairRequired) throw new Error('Managed triage marker pair is required');
    return null;
  }
  if (
    markers.length !== 2
    || markers[0].kind !== 'start'
    || markers[1].kind !== 'end'
    || markers[0].end >= markers[1].start
  ) {
    throw new Error('Managed triage markers must be one ordered, non-nested pair');
  }
  return { start: markers[0].start, end: markers[1].end };
}

function visitStringValues(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => visitStringValues(entry, visit));
    return;
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((entry) => visitStringValues(entry, visit));
  }
}

function assertManagedBlock(block: string): void {
  const span = managedSpan(block, true);
  if (span === null || span.start !== 0 || span.end !== block.length) {
    throw new Error('Managed triage block may contain only one exact marker span');
  }
}

export function renderReviewBlock(record: ReviewRecord): string {
  const proposedTitle = record.recommended_title ?? record.title;
  assertRequiredValue(proposedTitle, 'Proposed issue title');
  assertPublicText(PUBLIC_TITLE_PATH, 'proposed issue title', proposedTitle);
  assertNoClosingReference('Proposed issue title', proposedTitle);

  visitStringValues(record, (text) => {
    const span = managedSpan(text, false);
    if (span !== null) {
      throw new Error('Registry review record rejected: managed marker comment is not allowed');
    }
    assertNoClosingReference('Registry review record', text);
  });

  const payload = renderPayload(record);
  assertManagedBlock(payload);
  assertNoClosingReference('Managed triage block', payload);

  const digest = sha256(payload);
  const block = payload.replace(
    START_MARKER,
    `${START_MARKER}\n<!-- triage-review:intent-sha256=${digest} -->`,
  );
  assertManagedBlock(block);
  assertPublicText(PUBLIC_BODY_PATH, 'managed triage block', block);
  return block;
}

export function mergeReviewBlock(body: string, block: string): ManagedBodyResult {
  assertManagedBlock(block);
  assertNoClosingReference('Managed triage block', block);
  assertPublicText(PUBLIC_BODY_PATH, 'managed triage block', block);

  const existing = managedSpan(body, false);
  const expectedBody = existing === null
    ? `${body}${body === '' ? '' : body.endsWith('\n') ? '\n' : '\n\n'}${block}\n`
    : `${body.slice(0, existing.start)}${block}${body.slice(existing.end)}`;

  assertPublicText(PUBLIC_BODY_PATH, 'expected issue body', expectedBody);
  return {
    body: expectedBody,
    changed: expectedBody !== body,
  };
}
