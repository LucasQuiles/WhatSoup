import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { balanceCoverageFiles, validateCoverageShards } from '../../scripts/lib/coverage-shards.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('coverage-shards-');
const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

function fixture() {
  const directory = tmp.make('reports');
  const identity = {
    executionId: '658f8ce8-ad34-49c7-8915-891d668760ad',
    sourceCommit: 'a'.repeat(40), inputDigest: 'b'.repeat(64),
    dependencyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
    root: '/fixture/repository', node: 'v24.15.0', vitest: '4.1.11',
    platform: 'darwin', arch: 'arm64', workers: 2,
  };
  const plan = { schemaVersion: 1 as const, identity, shards: [['tests/a.test.ts'], ['tests/b.test.ts']] };
  const planDigest = hash(JSON.stringify(plan));
  const receipts = plan.shards.map((files, index) => {
    const blobPath = join(directory, `blob-${index + 1}.json`);
    const reportPath = join(directory, `report-${index + 1}.json`);
    writeFileSync(blobPath, `native-blob-${index + 1}`);
    const path = '/fixture/repository/src/main.ts';
    writeFileSync(reportPath, JSON.stringify({
      success: true, numTotalTests: 2, numPassedTests: 1, numFailedTests: 0,
      numPendingTests: 1, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
      testResults: files.map((name) => ({ name: `/fixture/repository/${name}`, status: 'passed',
        assertionResults: [{ status: 'passed' }, { status: 'skipped' }] })),
      coverageMap: { [path]: { path, statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } } },
        fnMap: {}, branchMap: {}, s: { 0: index }, f: {}, b: {} } },
    }));
    return { schemaVersion: 1 as const, planDigest, identity: { ...identity }, index: index + 1,
      outcome: 'passed', exitCode: 0, blobPath, reportPath,
      blobSha256: hash(readFileSync(blobPath)), reportSha256: hash(readFileSync(reportPath)) };
  });
  return { plan, receipts };
}

describe('coverage shard admission', () => {
  it('balances long files first with stable ties and each file exactly once', () => {
    const files = ['tests/d.test.ts', 'tests/c.test.ts', 'tests/b.test.ts', 'tests/a.test.ts'];
    expect(balanceCoverageFiles(files, { 'tests/a.test.ts': 9, 'tests/b.test.ts': 8, 'tests/c.test.ts': 2, 'tests/d.test.ts': 1 }))
      .toEqual([['tests/a.test.ts', 'tests/d.test.ts'], ['tests/b.test.ts', 'tests/c.test.ts']]);
  });

  it('uses deterministic equal estimates for unknown durations without dropping new files', () => {
    expect(balanceCoverageFiles(['tests/c.test.ts', 'tests/a.test.ts', 'tests/b.test.ts'], {}))
      .toEqual([['tests/a.test.ts', 'tests/c.test.ts'], ['tests/b.test.ts']]);
  });

  it.each([[], ['tests/a.test.ts'], ['tests/a.test.ts', 'tests/a.test.ts'], ['../a.test.ts', 'tests/b.test.ts'], ['tests/../a.test.ts', 'tests/b.test.ts']].map((files) => ({ files })))(
    'rejects an empty, duplicate or unsafe selection: $files', ({ files }) => {
      expect(() => balanceCoverageFiles(files, {})).toThrow(/selection|path|duplicate/i);
    },
  );

  it('admits a complete matching collection and exposes documented skips', () => {
    const { plan, receipts } = fixture();
    expect(validateCoverageShards(plan, receipts)).toEqual({
      blobPaths: receipts.map((receipt) => receipt.blobPath),
      coverageFiles: ['/fixture/repository/src/main.ts'],
      tests: { total: 4, passed: 2, failed: 0, pending: 2, todo: 0 },
    });
  });

  it('preserves native negative branch counts for the native coverage merger', () => {
    const { plan, receipts } = fixture();
    const receipt = receipts[0]!;
    const report = JSON.parse(readFileSync(receipt.reportPath, 'utf8'));
    const coverage = report.coverageMap['/fixture/repository/src/main.ts'];
    coverage.branchMap = { 0: { type: 'if', locations: [{ start: {}, end: {} }, { start: {}, end: {} }] } };
    coverage.b = { 0: [18, -18] };
    writeFileSync(receipt.reportPath, JSON.stringify(report));
    receipt.reportSha256 = hash(readFileSync(receipt.reportPath));

    expect(validateCoverageShards(plan, receipts).coverageFiles).toEqual(['/fixture/repository/src/main.ts']);
    expect(JSON.parse(readFileSync(receipt.reportPath, 'utf8')).coverageMap['/fixture/repository/src/main.ts'].b)
      .toEqual({ 0: [18, -18] });
  });

  it.each([
    ['s', -1], ['f', -1], ['s', 0.5], ['f', null], ['b', 1], ['b', [0, 0.5]], ['b', [0, null]],
  ])('rejects malformed %s counters: %j', (kind, value) => {
    const { plan, receipts } = fixture();
    const receipt = receipts[0]!;
    const report = JSON.parse(readFileSync(receipt.reportPath, 'utf8'));
    const coverage = report.coverageMap['/fixture/repository/src/main.ts'];
    const mapKey = kind === 's' ? 'statementMap' : kind === 'f' ? 'fnMap' : 'branchMap';
    coverage[mapKey] = { 0: {} };
    coverage[kind as string] = { 0: value };
    writeFileSync(receipt.reportPath, JSON.stringify(report));
    receipt.reportSha256 = hash(readFileSync(receipt.reportPath));

    expect(() => validateCoverageShards(plan, receipts)).toThrow(/invalid coverage counters/);
  });

  it('rejects a missing shard instead of producing a partial merge', () => {
    const { plan, receipts } = fixture();
    expect(() => validateCoverageShards(plan, receipts.slice(0, 1))).toThrow(/expected.*2.*shards/i);
  });

  it('rejects duplicate shard identities even when the count is correct', () => {
    const { plan, receipts } = fixture();
    expect(() => validateCoverageShards(plan, [receipts[0], receipts[0]])).toThrow(/duplicate.*shard/i);
  });

  it.each(['sourceCommit', 'inputDigest', 'dependencyDigest', 'configDigest', 'executionId', 'root', 'node', 'vitest', 'platform', 'arch', 'workers'])(
    'rejects different observed %s', (field) => {
      const { plan, receipts } = fixture();
      Object.assign(receipts[1]!.identity, { [field]: field === 'workers' ? 4 : 'different' });
      expect(() => validateCoverageShards(plan, receipts)).toThrow(/identity/i);
    },
  );

  it.each(['failed', 'cancelled', 'timedOut', 'inconclusive', 'skipped', 'busy'])(
    'rejects a %s shard before merging', (outcome) => {
      const { plan, receipts } = fixture();
      receipts[1]!.outcome = outcome;
      expect(() => validateCoverageShards(plan, receipts)).toThrow(/successful/i);
    },
  );

  it('rejects a native failure even if the outcome claims success', () => {
    const { plan, receipts } = fixture();
    receipts[1]!.exitCode = 7;
    expect(() => validateCoverageShards(plan, receipts)).toThrow(/successful/i);
  });

  it.each(['skipped', 'failed'])('rejects a nominally successful report with only %s tests', (status) => {
    const { plan, receipts } = fixture();
    const receipt = receipts[1]!;
    const report = JSON.parse(readFileSync(receipt.reportPath, 'utf8'));
    report.numPassedTests = 0;
    report.numFailedTests = status === 'failed' ? 2 : 0;
    report.numPendingTests = status === 'skipped' ? 2 : 0;
    report.testResults[0].assertionResults = [{ status }, { status }];
    writeFileSync(receipt.reportPath, JSON.stringify(report));
    receipt.reportSha256 = hash(readFileSync(receipt.reportPath));

    expect(() => validateCoverageShards(plan, receipts)).toThrow(/executed.*passing|failed tests/i);
  });

  it.each(['blobPath', 'reportPath'] as const)('rejects corrupted %s bytes', (field) => {
    const { plan, receipts } = fixture();
    writeFileSync(receipts[1]![field], 'corrupt');
    expect(() => validateCoverageShards(plan, receipts)).toThrow(/hash/i);
  });

  it.each(['omitted test', 'duplicate test', 'failed test', 'missing coverage', 'partial coverage', 'foreign coverage'])(
    'rejects %s even with a matching artifact hash', (scenario) => {
      const { plan, receipts } = fixture();
      const receipt = receipts[1]!;
      const report = JSON.parse(readFileSync(receipt.reportPath, 'utf8'));
      if (scenario === 'omitted test') report.testResults[0].name = '/fixture/repository/tests/unrelated.test.ts';
      if (scenario === 'duplicate test') report.testResults.push(report.testResults[0]);
      if (scenario === 'failed test') report.success = false;
      if (scenario === 'missing coverage') delete report.coverageMap;
      if (scenario === 'partial coverage') report.coverageMap = {};
      if (scenario === 'foreign coverage') {
        report.coverageMap['/other/src/main.ts'] = report.coverageMap['/fixture/repository/src/main.ts'];
      }
      writeFileSync(receipt.reportPath, JSON.stringify(report));
      receipt.reportSha256 = hash(readFileSync(receipt.reportPath));
      expect(() => validateCoverageShards(plan, receipts)).toThrow();
    },
  );

  it('rejects coverage omitted from just one shard', () => {
    const { plan, receipts } = fixture();
    const receipt = receipts[0]!;
    const report = JSON.parse(readFileSync(receipt.reportPath, 'utf8'));
    const path = '/fixture/repository/src/other.ts';
    report.coverageMap[path] = { ...report.coverageMap['/fixture/repository/src/main.ts'], path };
    writeFileSync(receipt.reportPath, JSON.stringify(report));
    receipt.reportSha256 = hash(readFileSync(receipt.reportPath));
    expect(() => validateCoverageShards(plan, receipts)).toThrow(/coverage.*scope/i);
  });

  it('unions console sources covered by different shards without dropping root coverage', () => {
    const { plan, receipts } = fixture();
    for (const receipt of receipts) {
      const report = JSON.parse(readFileSync(receipt.reportPath, 'utf8'));
      const path = `/fixture/repository/console/src/side-${receipt.index}.ts`;
      report.coverageMap[path] = { ...report.coverageMap['/fixture/repository/src/main.ts'], path };
      writeFileSync(receipt.reportPath, JSON.stringify(report));
      receipt.reportSha256 = hash(readFileSync(receipt.reportPath));
    }
    expect(validateCoverageShards(plan, receipts).coverageFiles).toEqual([
      '/fixture/repository/console/src/side-1.ts',
      '/fixture/repository/console/src/side-2.ts',
      '/fixture/repository/src/main.ts',
    ]);
  });

  it.each(['scripts/tool.ts', 'tests/fixture.ts', 'console/other.ts'])(
    'rejects unrelated repository coverage at %s', (name) => {
      const { plan, receipts } = fixture();
      const receipt = receipts[0]!;
      const report = JSON.parse(readFileSync(receipt.reportPath, 'utf8'));
      const path = `/fixture/repository/${name}`;
      report.coverageMap[path] = { ...report.coverageMap['/fixture/repository/src/main.ts'], path };
      writeFileSync(receipt.reportPath, JSON.stringify(report));
      receipt.reportSha256 = hash(readFileSync(receipt.reportPath));
      expect(() => validateCoverageShards(plan, receipts)).toThrow(/foreign.*coverage/i);
    },
  );
});
