import { describe, expect, it } from 'vitest';

import {
  classifyPrePushInput,
  classifyPrePushLine,
  commandsForDecision,
  ZERO_SHA,
} from '../../scripts/pre-push-guard.ts';

describe('pre-push guard classifier', () => {
  it('classifies delete-only ref updates as metadata-only', () => {
    expect(classifyPrePushLine(
      `refs/heads/topic ${ZERO_SHA} refs/heads/topic 40d37275dcb1c43decfb12e522f2d4f1b5e95a0c`,
    )).toBe('delete');
  });

  it('classifies main branch updates as release verification', () => {
    expect(classifyPrePushLine(
      `refs/heads/main 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/main ec3ac431eb1811aeb7fa9851d658b27ae724cbb5`,
    )).toBe('release');
  });

  it('classifies release tag updates as release verification', () => {
    expect(classifyPrePushLine(
      `refs/tags/v1.2.3 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/tags/v1.2.3 ${ZERO_SHA}`,
    )).toBe('release');
  });

  it('classifies feature branch updates as branch verification', () => {
    expect(classifyPrePushLine(
      `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`,
    )).toBe('branch');
  });

  it('skips verification when every ref update is delete-only', () => {
    const decision = classifyPrePushInput([
      `refs/heads/old-a ${ZERO_SHA} refs/heads/old-a 1111111111111111111111111111111111111111`,
      `refs/heads/old-b ${ZERO_SHA} refs/heads/old-b 2222222222222222222222222222222222222222`,
    ].join('\n'));

    expect(decision).toBe('skip');
    expect(commandsForDecision(decision)).toEqual([]);
  });

  it('uses branch verification for feature branch pushes', () => {
    const decision = classifyPrePushInput(
      `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`,
    );

    expect(decision).toBe('branch');
    expect(commandsForDecision(decision)).toEqual(['verify:push:branch']);
  });

  it('uses release verification when any pushed ref needs release treatment', () => {
    const decision = classifyPrePushInput([
      `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`,
      `refs/heads/main 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/main ec3ac431eb1811aeb7fa9851d658b27ae724cbb5`,
    ].join('\n'));

    expect(decision).toBe('release');
    expect(commandsForDecision(decision)).toEqual(['verify:release']);
  });

  it('rejects malformed pre-push ref lines', () => {
    expect(() => classifyPrePushLine('refs/heads/main only-two-fields')).toThrow(/Invalid pre-push/);
  });
});
