import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadRuleSpecs, scanRule } from '../../scripts/platform-pattern-check.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('platform-patterns-');

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
});
