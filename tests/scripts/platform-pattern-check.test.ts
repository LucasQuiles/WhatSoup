import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadRuleSpecs, scanRule } from '../../scripts/platform-pattern-check.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

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

  // `sudo -n` must name exact binaries: a sudoers rule matches the absolute
  // path, and a PATH lookup would let a user-writable directory choose what
  // runs as root. Only the one constants module is exempt, not its callers.
  it('allows the root helper interpreter module while retaining a finding in the activation code', () => {
    const root = tmp.make('root-helper-interpreter');
    const activation = path.join(root, 'scripts', 'lib', 'release-activation');
    mkdirSync(activation, { recursive: true });
    writeFileSync(path.join(activation, 'root-helper-interpreter.ts'), "export const ROOT_HELPER_PYTHON = '/usr/bin/python3';\n");
    writeFileSync(path.join(activation, 'apply.ts'), "host.exec(SUDO, ['-n', '/usr/bin/python3']);\n");

    const [rule] = loadRuleSpecs(['portability.no-hardcoded-platform-binaries']);

    expect(scanRule(root, rule!).map(({ file, line, pattern }) => ({ file, line, pattern }))).toEqual([
      { file: 'scripts/lib/release-activation/apply.ts', line: 1, pattern: "'/usr/bin/python" },
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
