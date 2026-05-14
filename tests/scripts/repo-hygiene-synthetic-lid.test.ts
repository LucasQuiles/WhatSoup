import { describe, expect, it } from 'vitest';

import { scanAddedLines } from '../../scripts/repo-hygiene-guard.ts';

describe('repo hygiene synthetic LID fixtures', () => {
  it('allows shape-preserving synthetic LID fixtures while blocking other real-shaped LIDs', () => {
    const blockedLid = ['1929790', '5323@lid'].join('');
    const issues = scanAddedLines([
      { filePath: 'tests/example.test.ts', line: 1, text: 'const syntheticLid = "81536414179000@lid";' },
      { filePath: 'tests/example.test.ts', line: 2, text: `const realShapedLid = "${blockedLid}";` },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['whatsapp-user-jid']);
    expect(issues.map((issue) => `${issue.filePath}:${issue.line}`)).toEqual(['tests/example.test.ts:2']);
  });
});
