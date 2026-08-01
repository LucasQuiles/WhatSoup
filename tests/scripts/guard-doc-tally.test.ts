import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  countTally,
  runDocTallyGuard,
  tallyDocs,
  validateDocTally,
  validateTallyDoc,
  type TallyDoc,
} from '../../scripts/guard-doc-tally.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const REPO_ROOT = join(__dirname, '..', '..');

const tmp = trackTmpDirs('');

function makeRepo(files: Record<string, string>): string {
  const repo = tmp.make('doc-tally');
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return repo;
}

const sampleDoc: TallyDoc = {
  docPath: 'docs/sample-tally.md',
  headerCountPattern: /\((\d+) items total\)/,
  rowPattern: /^\| \d+ \| /,
  label: 'sample rows',
};

function docBody(declared: number, rows: number): string {
  const rowLines = Array.from({ length: rows }, (_, i) => `| ${i + 1} | value${i + 1} |`);
  return `# Sample\n\n**Source:** stuff (${declared} items total).\n\n| # | v |\n|---|---|\n${rowLines.join('\n')}\n`;
}

describe('countTally', () => {
  it('reports declared, declaredMatches, and actual counts', () => {
    const result = countTally(docBody(3, 3), sampleDoc);
    expect(result).toEqual({ declared: 3, declaredMatches: 1, actual: 3 });
  });

  it('does not count table separator or non-numbered lines as rows', () => {
    const result = countTally(docBody(2, 2), sampleDoc);
    expect(result.actual).toBe(2);
  });
});

describe('validateTallyDoc', () => {
  it('passes when declared equals actual', () => {
    expect(validateTallyDoc(docBody(5, 5), sampleDoc)).toEqual([]);
  });

  it('flags count-mismatch when declared > actual', () => {
    const issues = validateTallyDoc(docBody(5, 4), sampleDoc);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('count-mismatch');
    expect(issues[0].message).toContain('declares 5');
    expect(issues[0].message).toContain('has 4');
  });

  it('flags count-mismatch when declared < actual (the #1524 off-by-one class)', () => {
    const issues = validateTallyDoc(docBody(4, 5), sampleDoc);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('count-mismatch');
  });

  it('reports doc-missing for null content', () => {
    const issues = validateTallyDoc(null, sampleDoc);
    expect(issues[0].code).toBe('doc-missing');
  });

  it('reports header-count-missing when no declared count line is present', () => {
    const issues = validateTallyDoc('# Sample\n\n| 1 | a |\n', sampleDoc);
    expect(issues[0].code).toBe('header-count-missing');
  });

  it('reports header-count-ambiguous when the pattern matches multiple lines', () => {
    const body = `(2 items total)\n(2 items total)\n| 1 | a |\n| 2 | b |\n`;
    const issues = validateTallyDoc(body, sampleDoc);
    expect(issues[0].code).toBe('header-count-ambiguous');
  });

  it('reports row-count-zero when the row pattern matches nothing (stale pattern)', () => {
    const issues = validateTallyDoc('(3 items total)\nno rows here\n', sampleDoc);
    expect(issues[0].code).toBe('row-count-zero');
  });
});

describe('validateDocTally against a synthetic repo', () => {
  it('passes a consistent doc and fails a corrupted one', () => {
    const good = makeRepo({ 'docs/sample-tally.md': docBody(3, 3) });
    expect(validateDocTally(good, [sampleDoc])).toEqual([]);

    const bad = makeRepo({ 'docs/sample-tally.md': docBody(3, 4) });
    const issues = validateDocTally(bad, [sampleDoc]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('count-mismatch');
  });
});

describe('registry on real repo (main)', () => {
  it('every registered tally doc is consistent on the current tree', () => {
    const issues = validateDocTally(REPO_ROOT, tallyDocs);
    expect(issues).toEqual([]);
  });

  it('runDocTallyGuard returns 0 on the current tree', () => {
    expect(runDocTallyGuard([], REPO_ROOT)).toBe(0);
  });

  it('ships at least one registered tally doc', () => {
    expect(tallyDocs.length).toBeGreaterThan(0);
  });
});
