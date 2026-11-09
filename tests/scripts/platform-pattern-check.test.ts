import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENFORCED_RULE_IDS,
  loadRuleSpecs,
  run,
  scanRule,
  type PlatformRuleParams,
} from '../../scripts/platform-pattern-check.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

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

const tmp = trackTmpDirs('platform-patterns-');

type CompactFinding = { line: number; pattern: string };

function scanFixture(
  source: string,
  ruleId = 'portability.platform-paths-guarded',
): CompactFinding[] {
  const root = tmp.make(`fixture-${ruleId.replace(/[^a-z]+/g, '-')}`);
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'fixture.ts'), source);
  const [rule] = loadRuleSpecs([ruleId]);
  if (!rule) throw new Error(`missing ${ruleId} rule`);
  return scanRule(root, rule).map(({ line, pattern }) => ({ line, pattern }));
}

describe('platform-pattern-check', () => {
  // The Vitest credential shims work through PATH, so an absolute path to
  // either command would reach the real OS credential store from a test.
  it('flags absolute paths to the OS credential commands in every quote style', () => {
    const root = tmp.make('fixture');
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'credential-commands.ts'), [
      "execFileSync('/usr/bin/security', ['find-generic-password']);",
      'execFileSync("/usr/bin/security", ["find-generic-password"]);',
      'execFileSync(`/usr/bin/security`, [`find-generic-password`]);',
      "execFileSync('/usr/bin/secret-tool', ['lookup']);",
      'execFileSync("/usr/bin/secret-tool", ["lookup"]);',
      'execFileSync(`/usr/bin/secret-tool`, [`lookup`]);',
      "execFileSync('security', ['find-generic-password']);",
      '',
    ].join('\n'));

    const [rule] = loadRuleSpecs(['portability.no-hardcoded-platform-binaries']);

    expect(scanRule(root, rule!).map(({ line, pattern }) => ({ line, pattern }))).toEqual([
      { line: 1, pattern: "'/usr/bin/security" },
      { line: 2, pattern: '"/usr/bin/security' },
      { line: 3, pattern: '`/usr/bin/security' },
      { line: 4, pattern: "'/usr/bin/secret-tool" },
      { line: 5, pattern: '"/usr/bin/secret-tool' },
      { line: 6, pattern: '`/usr/bin/secret-tool' },
    ]);
  });

  it('allows the documented Darwin identity source while retaining a sibling finding', () => {
    const root = tmp.make('fixed-candidate-identity');
    const identity = path.join(root, 'src', 'runtimes', 'agent', 'providers');
    mkdirSync(identity, { recursive: true });
    writeFileSync(path.join(identity, 'claude-refresh-process-identity.ts'), "const candidate = '/usr/bin/python3';\n");
    writeFileSync(path.join(root, 'src', 'sibling.ts'), "const candidate = '/usr/bin/python3';\n");

    const [rule] = loadRuleSpecs(['portability.no-hardcoded-platform-binaries']);

    expect(scanRule(root, rule!).map(({ line, pattern }) => ({ line, pattern }))).toEqual([
      { line: 1, pattern: "'/usr/bin/python" },
    ]);
  });

  it('does not flag direct Linux if consequents for platform paths', () => {
    expect(scanFixture([
      "if (process.platform === 'linux') {",
      "  read('/proc/direct');",
      "  read('/sys/direct');",
      '}',
    ].join('\n'))).toEqual([]);
  });

  it('does not flag an immutable process.platform alias in its declaring block', () => {
    expect(scanFixture([
      'const platform = process.platform;',
      "if (platform === 'linux') {",
      "  read('/proc/alias');",
      '}',
    ].join('\n'))).toEqual([]);
  });

  it('does not flag the injected platform fallback in a nested Linux else-if consequent', () => {
    expect(scanFixture([
      'const platform = deps.platform ?? process.platform;',
      "if (platform === 'darwin') {",
      "  command('/usr/sbin/sysctl');",
      "} else if (platform === 'linux') {",
      "  read('/proc/fallback');",
      "  read('/sys/fallback');",
      '} else {',
      "  return 'unknown';",
      '}',
    ].join('\n'))).toEqual([]);
  });

  it('keeps an unguarded same-line occurrence after a Linux consequent', () => {
    expect(scanFixture(
      "if (process.platform === 'linux') read('/proc/guarded'); read('/proc/unguarded');",
    )).toEqual([{ line: 1, pattern: '/proc/' }]);
  });

  const untrustedGuards: ReadonlyArray<{
    name: string;
    source: string;
    expected: CompactFinding[];
  }> = [
    {
      name: 'unknown aliases',
      source: "const platform = resolvePlatform();\nif (platform === 'linux') read('/proc/unknown');",
      expected: [{ line: 2, pattern: '/proc/' }],
    },
    {
      name: 'mutable aliases',
      source: "let platform = process.platform;\nif (platform === 'linux') read('/proc/mutable');",
      expected: [{ line: 2, pattern: '/proc/' }],
    },
    {
      name: 'shadowed aliases',
      source: "const platform = process.platform;\n{ const platform = 'linux'; if (platform === 'linux') read('/proc/shadowed'); }",
      expected: [{ line: 2, pattern: '/proc/' }],
    },
    {
      name: 'shadowed process parameters',
      source: "function probe(process: { platform: string }) {\n  if (process.platform === 'linux') read('/proc/process-parameter');\n}",
      expected: [{ line: 2, pattern: '/proc/' }],
    },
    {
      name: 'else branches',
      source: "if (process.platform === 'linux') {\n  noop();\n} else {\n  read('/proc/else');\n}",
      expected: [{ line: 4, pattern: '/proc/' }],
    },
    {
      name: 'or conditions',
      source: "if (process.platform === 'linux' || allowTest) read('/proc/or');",
      expected: [{ line: 1, pattern: '/proc/' }],
    },
    {
      name: 'non-Linux guards',
      source: "if (process.platform === 'darwin') read('/proc/darwin');",
      expected: [{ line: 1, pattern: '/proc/' }],
    },
    {
      name: 'access outside a valid guard',
      source: "if (process.platform === 'linux') {\n  read('/proc/inside');\n}\nread('/proc/outside');",
      expected: [{ line: 4, pattern: '/proc/' }],
    },
    {
      name: 'nested callbacks',
      source: "const platform = process.platform;\nif (platform === 'linux') {\n  later(() => read('/proc/callback'));\n}",
      expected: [{ line: 3, pattern: '/proc/' }],
    },
    {
      name: 'parse errors',
      source: "if (process.platform === 'linux') {\n  read('/proc/parse-error');",
      expected: [{ line: 2, pattern: '/proc/' }],
    },
  ];

  it.each(untrustedGuards)('continues to flag $name', ({ source, expected }) => {
    expect(scanFixture(source)).toEqual(expected);
  });

  it('does not exempt credential paths under a Linux guard', () => {
    expect(scanFixture(
      "if (process.platform === 'linux') execFileSync('/usr/bin/security', ['find-generic-password']);",
      'portability.no-hardcoded-platform-binaries',
    )).toEqual([{ line: 1, pattern: "'/usr/bin/security" }]);
  });
});
