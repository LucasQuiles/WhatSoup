import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildChildEnv,
  buildWorkerPlans,
  collectSourceFiles,
  computeRegisterHash,
  acquireRunLock,
  healthAllowsDispatch,
  parseRegister,
  prepareWorkerStaging,
  redactForWorker,
  resolveCheckerPath,
  shouldDispatch,
} from '../../scripts/qregistry-loop.ts';

function entry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    id: 'QR-900',
    source_ref: 'test',
    kind: 'debt',
    title: 'Investigate durable memory trace gap',
    severity: 'medium',
    canonical_owner: 'me',
    disposition: 'deferred',
    files: ['src/mcp/registry.ts'],
    unresolved_unknowns: ['whether candidate ids are traced'],
    ...overrides,
  });
}

describe('qregistry loop helpers', () => {
  it('parses actionable register entries and ignores closed dispositions for worker dispatch', () => {
    const parsed = parseRegister([
      entry({ id: 'QR-001', disposition: 'implemented' }),
      entry({ id: 'QR-002', severity: 'high', disposition: 'under-review' }),
      entry({ id: 'QR-003', disposition: 'superseded', superseded_by: 'QR-004' }),
    ].join('\n'));

    expect(parsed.map((item) => item.id)).toEqual(['QR-001', 'QR-002', 'QR-003']);
    const plans = buildWorkerPlans(parsed, {
      repoRoot: '/repo',
      registerPath: '/repo/qregistry.ndjson',
      auditPath: '/repo/docs/audits/2026-06-27-memory-harness-gap-analysis.md',
      sourceFiles: ['/repo/src/mcp/registry.ts'],
      maxWorkers: 2,
      maxItems: 4,
    });

    expect(plans).toHaveLength(2);
    expect(plans[0].role).toBe('review');
    expect(plans[0].prompt).toContain('QR-002');
    expect(plans[0].prompt).not.toContain('QR-001');
    expect(plans[0].prompt).not.toContain('QR-003');
    expect(plans[1].role).toBe('research');
  });

  it('limits worker prompts to the highest-priority actionable items', () => {
    const parsed = parseRegister([
      entry({ id: 'QR-001', severity: 'low', disposition: 'observed' }),
      entry({ id: 'QR-002', severity: 'medium', disposition: 'observed' }),
      entry({ id: 'QR-003', severity: 'high', disposition: 'observed' }),
      entry({ id: 'QR-004', severity: 'high', disposition: 'observed' }),
      entry({ id: 'QR-005', severity: 'medium', disposition: 'observed' }),
      entry({ id: 'QR-006', severity: 'medium', disposition: 'observed' }),
    ].join('\n'));

    const [plan] = buildWorkerPlans(parsed, {
      repoRoot: '/repo',
      registerPath: '/repo/qregistry.ndjson',
      auditPath: '/repo/docs/audits/2026-06-27-memory-harness-gap-analysis.md',
      sourceFiles: [],
      maxWorkers: 1,
      maxItems: 4,
    });

    expect(plan!.prompt).toContain('QR-003');
    expect(plan!.prompt).toContain('QR-004');
    expect(plan!.prompt).toContain('QR-002');
    expect(plan!.prompt).toContain('QR-005');
    expect(plan!.prompt).not.toContain('QR-006');
    expect(plan!.prompt).not.toContain('QR-001');
  });

  it('dispatches on first run, register hash change, or explicit force only', () => {
    const current = computeRegisterHash('a\n');
    expect(shouldDispatch({ currentHash: current, previousHash: null, force: false })).toBe(true);
    expect(shouldDispatch({ currentHash: current, previousHash: current, force: false })).toBe(false);
    expect(shouldDispatch({ currentHash: current, previousHash: computeRegisterHash('b\n'), force: false })).toBe(true);
    expect(shouldDispatch({ currentHash: current, previousHash: current, force: true })).toBe(true);
  });

  it('stages only existing repo-local source files, capped by count and size', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qregistry-loop-'));
    const repoFile = path.join(dir, 'src', 'mcp');
    writeFileSync(path.join(dir, 'qregistry.ndjson'), '', 'utf8');
    // mkdirSync is intentionally avoided here; writeFileSync to a missing dir would
    // make the test fail for the wrong reason if the helper changes.
    expect(() => collectSourceFiles(dir, [], { maxFiles: 4, maxBytes: 100 })).not.toThrow();

    mkdirSync(repoFile, { recursive: true });
    writeFileSync(path.join(repoFile, 'registry.ts'), 'export const registry = true;\n', 'utf8');
    writeFileSync(path.join(dir, 'large.ts'), 'x'.repeat(101), 'utf8');

    const parsed = parseRegister(entry({
      files: [
        'src/mcp/registry.ts',
        'large.ts',
        '../outside.ts',
        '/etc/passwd',
        'memory.db',
      ],
    }));

    expect(collectSourceFiles(dir, parsed, { maxFiles: 4, maxBytes: 100 })).toEqual([
      path.join(dir, 'src/mcp/registry.ts'),
    ]);
  });

  it('redacts secret-looking fixture text before staging files for workers', () => {
    const bearer = `Bearer ${'token'}123456789`;

    expect(redactForWorker(`const jwt = "abc.def.ghi";\nAuthorization: ${bearer}\n`)).toBe(
      'const jwt = "<redacted>";\nAuthorization: Bearer <redacted>\n',
    );

    const dir = mkdtempSync(path.join(tmpdir(), 'qregistry-stage-'));
    mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
    const source = path.join(dir, 'fixtures', 'canary.ts');
    writeFileSync(source, 'const jwt = "abc.def.ghi";\n', 'utf8');

    const staged = prepareWorkerStaging({
      repoRoot: dir,
      runDir: path.join(dir, 'raw', 'run'),
      files: [source],
    });

    expect(staged).toHaveLength(1);
    expect(readFileSync(staged[0]!, 'utf8')).toContain('jwt = "<redacted>"');
  });

  it('allows degraded health when the pinned GLM worker lane is healthy', () => {
    expect(healthAllowsDispatch(0, '')).toBe(true);
    expect(healthAllowsDispatch(1, 'healthy    glm/glm-5.2                  glm         13s  ok\nunhealthy  minimax/MiniMax-M3')).toBe(true);
    expect(healthAllowsDispatch(1, 'healthy    deepseek/deepseek-v4-pro     deepseek     9s  ok')).toBe(false);
  });

  it('recovers a stale lock directory with no live pid', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qregistry-lock-'));
    const lockDir = path.join(dir, 'lock');
    mkdirSync(lockDir);

    const lock = acquireRunLock(lockDir);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it('exposes the documented npm command surface', () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['qregistry:loop']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/qregistry-loop.ts',
    );
  });

  it('resolves the shared checker without hard-coding a local home path', () => {
    expect(resolveCheckerPath('/repo/WhatSoup', { QREGISTRY_CHECKER: '/opt/q/check.py' }, () => false)).toBe(
      '/opt/q/check.py',
    );

    const worktreeRoot = '/lab/WhatSoup/.worktrees/qregistry-loop-surface';
    const resolved = resolveCheckerPath(worktreeRoot, {}, (candidate) => candidate === '/lab/qRegistry/scripts/qregistry-check.py');

    expect(resolved).toBe('/lab/qRegistry/scripts/qregistry-check.py');
    expect(resolved).not.toContain('/Users/');
  });

  it('uses an explicit child-process environment allowlist', () => {
    const childEnv = buildChildEnv(
      {
        HOME: '/home/q',
        PATH: '/usr/bin',
        SECRET_TOKEN: 'must-not-leak',
      },
      { OCW_TIMEOUT_SECS: '1200' },
    );

    expect(childEnv).toEqual({
      HOME: '/home/q',
      PATH: '/usr/bin',
      OCW_TIMEOUT_SECS: '1200',
    });
  });
});
