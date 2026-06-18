import { describe, expect, it } from 'vitest';

import {
  parseArgs,
  sectionBody,
  validateAgentIterationReview,
} from '../../scripts/agent-iteration-review-check.ts';

const validReview = `# Agent Iteration Review

## Summary
Moved console update calls behind the API client.

## Intended Invariants
Preserve API auth-ticket handling and response parsing.

## Checks
- PASS npm test -- tests/eslint-rules/approved-api-client.test.ts
- FAIL npm run guard:lint:src produced pre-existing warnings only.

## Failures
No new blocking failures.

## Remaining Risks
Known legacy direct fetches still need cleanup.

## Decision
Decision: continue
`;

describe('agent iteration review guard', () => {
  it('extracts section bodies', () => {
    expect(sectionBody(validReview, 'Summary')).toBe('Moved console update calls behind the API client.');
  });

  it('accepts a concrete self-review artifact with a bounded decision', () => {
    const result = validateAgentIterationReview(validReview);

    expect(result.ok).toBe(true);
    expect(result.decision).toBe('continue');
    expect(result.issues).toEqual([]);
  });

  it('rejects missing sections, placeholders, and absent decisions', () => {
    const result = validateAgentIterationReview(`## Summary\nTODO\n\n## Decision\nmaybe later`);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'missing-section',
      'placeholder',
      'missing-decision',
    ]));
  });

  it('requires checks to declare pass/fail/skip/blocked status', () => {
    const result = validateAgentIterationReview(validReview.replace(/- PASS .+\n- FAIL .+\n/, '- npm test\n'));

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: 'checks-no-status',
      message: 'Checks section must state which checks passed, failed, skipped, or blocked the iteration.',
    });
  });

  it('accepts artifact path from env and lets argv override it', () => {
    expect(parseArgs([], { WHATSOUP_AGENT_ITERATION_REVIEW: 'env.md' }).artifactPath).toBe('env.md');
    expect(parseArgs(['--artifact', 'argv.md'], { WHATSOUP_AGENT_ITERATION_REVIEW: 'env.md' }).artifactPath).toBe('argv.md');
  });
});
