import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENFORCED_RULE_IDS,
  run,
  scanRule,
  type PlatformRuleParams,
} from '../../scripts/platform-pattern-check.ts';

let fixtureRoot: string;

const platformPathSpec = {
  id: 'portability.platform-paths-guarded',
  params: {
    globs: ['src'],
    extensions: ['.ts'],
    patterns: ['/proc/', '/sys/'],
    allowlistPaths: [],
  } satisfies PlatformRuleParams,
};

function scan(source: string) {
  const file = path.join(fixtureRoot, 'src', 'candidate.ts');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source, 'utf8');
  return scanRule(fixtureRoot, platformPathSpec);
}

describe('platform path guard recognition', () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-platform-pattern-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('blocks when a platform baseline count and its taxonomy twin disagree', async () => {
    const baselineDir = path.join(fixtureRoot, '.claude', 'fitness');
    const docsDir = path.join(fixtureRoot, 'docs', 'architecture');
    const sourceDir = path.join(fixtureRoot, 'src');
    mkdirSync(baselineDir, { recursive: true });
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(baselineDir, 'platform-baseline.json'), '[]\n', 'utf8');
    writeFileSync(path.join(sourceDir, 'candidate.ts'), 'export const portable = true;\n', 'utf8');
    writeFileSync(
      path.join(docsDir, 'fitness-taxonomy.md'),
      ENFORCED_RULE_IDS.map((ruleId) =>
        `| \`${ruleId}\` | ${ruleId === 'portability.platform-paths-guarded' ? 1 : 0} | guard |`)
        .join('\n'),
      'utf8',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run([], fixtureRoot)).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(
      'portability.platform-paths-guarded: twin-doc mismatch',
    ));
  });

  it('accepts matching platform baseline and taxonomy counts', async () => {
    const baselineDir = path.join(fixtureRoot, '.claude', 'fitness');
    const docsDir = path.join(fixtureRoot, 'docs', 'architecture');
    const sourceDir = path.join(fixtureRoot, 'src');
    mkdirSync(baselineDir, { recursive: true });
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(baselineDir, 'platform-baseline.json'), '[]\n', 'utf8');
    writeFileSync(path.join(sourceDir, 'candidate.ts'), 'export const portable = true;\n', 'utf8');
    writeFileSync(
      path.join(docsDir, 'fitness-taxonomy.md'),
      ENFORCED_RULE_IDS.map((ruleId) => `| \`${ruleId}\` | 0 | guard |`).join('\n'),
      'utf8',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(run([], fixtureRoot)).resolves.toBe(0);
    expect(error).not.toHaveBeenCalled();
  });

  it('fails closed when a platform rule has duplicate taxonomy rows', async () => {
    const baselineDir = path.join(fixtureRoot, '.claude', 'fitness');
    const docsDir = path.join(fixtureRoot, 'docs', 'architecture');
    const sourceDir = path.join(fixtureRoot, 'src');
    mkdirSync(baselineDir, { recursive: true });
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(baselineDir, 'platform-baseline.json'), '[]\n', 'utf8');
    writeFileSync(path.join(sourceDir, 'candidate.ts'), 'export const portable = true;\n', 'utf8');
    writeFileSync(
      path.join(docsDir, 'fitness-taxonomy.md'),
      [
        ...ENFORCED_RULE_IDS.map((ruleId) => `| \`${ruleId}\` | 0 | guard |`),
        '| `portability.platform-paths-guarded` | 1 | conflicting duplicate |',
      ].join('\n'),
      'utf8',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run([], fixtureRoot)).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(
      'expected exactly one taxonomy count row for portability.platform-paths-guarded; found 2',
    ));
  });

  it('accepts literal Linux paths dominated by a non-Linux early return', () => {
    expect(scan([
      'export function inspectCgroup() {',
      "  if (process.platform !== 'linux') return null;",
      '  try {',
      "    return ['/proc/self/cgroup', '/sys/fs/cgroup'];",
      '  } catch {',
      '    return null;',
      '  }',
      '}',
    ].join('\n'))).toEqual([]);
  });

  it('rejects an unguarded Linux path', () => {
    expect(scan([
      'export function inspectCgroup() {',
      "  return '/proc/self/cgroup';",
      '}',
    ].join('\n'))).toEqual([
      expect.objectContaining({
        ruleId: 'portability.platform-paths-guarded',
        file: 'src/candidate.ts',
        pattern: '/proc/',
      }),
    ]);
  });

  it('rejects a platform check that occurs after the path access', () => {
    expect(scan([
      'export function inspectCgroup() {',
      "  const target = '/proc/self/cgroup';",
      "  if (process.platform !== 'linux') return null;",
      '  return target;',
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it('rejects a non-terminating platform check', () => {
    expect(scan([
      'export function inspectCgroup() {',
      "  if (process.platform !== 'linux') console.warn('unsupported');",
      "  return '/proc/self/cgroup';",
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it('does not trust a shadowed process binding', () => {
    expect(scan([
      'export function inspectCgroup(process: { platform: string }) {',
      "  if (process.platform !== 'linux') return null;",
      "  return '/proc/self/cgroup';",
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it('does not trust a namespace named process', () => {
    expect(scan([
      "namespace process { export const platform = 'linux'; }",
      'export function inspectCgroup() {',
      "  if (process.platform !== 'linux') return null;",
      "  return '/proc/self/cgroup';",
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it('does not trust an import-equals binding named process', () => {
    expect(scan([
      "import process = require('./fake-process');",
      'export function inspectCgroup() {',
      "  if (process.platform !== 'linux') return null;",
      "  return '/proc/self/cgroup';",
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it.each([
    "const inspectCgroup = function process() { if (process.platform !== 'linux') return null; return '/proc/self/cgroup'; };",
    "const InspectCgroup = class process { read() { if (process.platform !== 'linux') return null; return '/proc/self/cgroup'; } };",
  ])('does not trust a named runtime expression binding: %s', (source) => {
    expect(scan(source)).toHaveLength(1);
  });

  it('does not inherit an outer guard across a nested function boundary', () => {
    expect(scan([
      'export function inspectCgroup() {',
      '  nested();',
      "  if (process.platform !== 'linux') return null;",
      "  function nested(target = '/proc/self/cgroup') {",
      '    return target;',
      '  }',
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it('does not let a guarded occurrence hide an unguarded occurrence on the same line', () => {
    expect(scan(
      "export function safe() { if (process.platform !== 'linux') return null; return '/proc/safe'; } "
      + "export function unsafe() { return '/proc/unsafe'; }",
    )).toHaveLength(1);
  });
});
