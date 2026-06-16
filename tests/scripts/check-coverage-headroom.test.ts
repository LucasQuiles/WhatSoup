import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkCoverageHeadroom } from '../../scripts/check-coverage-headroom.ts';

const roots: string[] = [];

function makeSummary(total: Record<string, { pct: number }>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'coverage-headroom-'));
  roots.push(root);
  mkdirSync(path.join(root, 'coverage'), { recursive: true });
  writeFileSync(path.join(root, 'coverage', 'coverage-summary.json'), JSON.stringify({ total }, null, 2));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('coverage headroom guard', () => {
  it('passes when every enforced metric has at least two points of headroom', () => {
    const root = makeSummary({
      lines: { pct: 90.1 },
      branches: { pct: 82.1 },
      functions: { pct: 89.1 },
    });

    expect(checkCoverageHeadroom(root)).toEqual([]);
  });

  it('fails when any enforced metric is too close to its threshold', () => {
    const root = makeSummary({
      lines: { pct: 89.9 },
      branches: { pct: 82.1 },
      functions: { pct: 89.1 },
    });

    expect(checkCoverageHeadroom(root)).toEqual([
      'lines: pct=89.90 threshold=88 headroom=1.90 < 2',
    ]);
  });
});
