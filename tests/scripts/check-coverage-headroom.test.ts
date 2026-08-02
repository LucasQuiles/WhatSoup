import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { checkCoverageHeadroom } from '../../scripts/check-coverage-headroom.ts';

const tmp = trackTmpDirs('coverage-');

function makeSummary(total: Record<string, { pct: number }>): string {
  const root = tmp.make('headroom');
  mkdirSync(path.join(root, 'coverage'), { recursive: true });
  writeFileSync(path.join(root, 'coverage', 'coverage-summary.json'), JSON.stringify({ total }, null, 2));
  return root;
}

describe('coverage headroom guard', () => {
  // Floors are the hard gate (lines 95 / branches 90 / functions 93); the guard
  // warns within MIN_HEADROOM_POINTS (2) above each floor.
  it('passes when every enforced metric has at least two points of headroom', () => {
    const root = makeSummary({
      lines: { pct: 97.1 },
      branches: { pct: 92.1 },
      functions: { pct: 95.1 },
    });

    expect(checkCoverageHeadroom(root)).toEqual([]);
  });

  it('reports a finding when any enforced metric is too close to its threshold', () => {
    const root = makeSummary({
      lines: { pct: 96.9 },
      branches: { pct: 92.1 },
      functions: { pct: 95.1 },
    });

    expect(checkCoverageHeadroom(root)).toEqual([
      'lines: pct=96.90 threshold=95 headroom=1.90 < 2',
    ]);
  });
});
