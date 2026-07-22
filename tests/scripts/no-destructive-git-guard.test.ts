import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DESTRUCTIVE_GIT_PATTERNS,
  scanForDestructiveGit,
  type Finding,
} from '../../scripts/no-destructive-git-guard.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/**
 * Real temp trees (mktemp) only — NEVER a committed fixture under the scan surface
 * (scripts/deploy/tools/.husky), which would break the guard's green-on-arrival.
 */
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'no-destructive-git-guard-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeShell(relPath: string, body: string): void {
  const abs = join(scratch, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

describe('no-destructive-git guard', () => {
  it('RED: flags a shell script containing `git reset --hard`', () => {
    writeShell('scripts/recover.sh', '#!/usr/bin/env bash\ngit reset --hard origin/main\n');
    const findings = scanForDestructiveGit(scratch);
    expect(findings.some((f) => f.command.includes('reset --hard'))).toBe(true);
  });

  it('RED: reports a non-empty finding set (name-independent failure proof)', () => {
    writeShell('scripts/recover.sh', '#!/usr/bin/env bash\ngit reset --hard origin/main\n');
    // Direct-subject form: proves failure regardless of any result-variable name.
    expect(scanForDestructiveGit(scratch)).not.toHaveLength(0);
  });

  it('RED: flags each declared banned command family via a representative call', () => {
    const lines = [
      '#!/usr/bin/env bash',
      'git clean -fdx',
      'git reset --hard HEAD',
      'git checkout --force main',
      'git switch --discard-changes topic',
      'git push --force origin main',
      'git branch -D stale',
      'git update-ref -d refs/heads/x',
      'git stash clear',
      'git reflog expire --expire=now --all',
      'git gc --prune=now',
      'git filter-branch --tree-filter true HEAD',
      'git filter-repo --path secret --invert-paths',
      '',
    ].join('\n');
    writeShell('deploy/danger.sh', lines);
    const findings = scanForDestructiveGit(scratch);
    // Every declared pattern must fire at least once against its representative line.
    for (const pattern of DESTRUCTIVE_GIT_PATTERNS) {
      expect(findings.some((f) => f.command === pattern.command)).toBe(true);
    }
  });

  it('RED: exercised via the exported patterns — every pattern has a distinct command label', () => {
    const labels = DESTRUCTIVE_GIT_PATTERNS.map((p) => p.command);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('detects a destructive call in a shebang-classified extensionless shell script', () => {
    writeShell('tools/reset-tool', '#!/bin/sh\ngit reset --hard\n');
    const findings = scanForDestructiveGit(scratch);
    expect(findings.some((f) => f.file === 'tools/reset-tool')).toBe(true);
  });

  it('detects a destructive call in a .husky hook', () => {
    writeShell('.husky/pre-commit', '#!/usr/bin/env sh\ngit clean -fd\n');
    const findings = scanForDestructiveGit(scratch);
    expect(findings.some((f) => f.file === '.husky/pre-commit')).toBe(true);
  });

  it('does NOT cross a shell command separator (no false positive from a following `-f`)', () => {
    // `git checkout` here is safe; the `-f` belongs to a separate `rm -f`.
    writeShell('scripts/safe.sh', '#!/usr/bin/env bash\ngit checkout main && rm -f /tmp/x\n');
    const findings = scanForDestructiveGit(scratch);
    expect(findings).toEqual([]);
  });

  it('does NOT flag non-destructive git usage', () => {
    writeShell(
      'scripts/ok.sh',
      [
        '#!/usr/bin/env bash',
        'git status',
        'git checkout main',
        'git checkout -- path/to/file',
        'git reset --soft HEAD~1',
        'git clean -n',
        'git push origin main',
        'git pull --ff-only',
        '',
      ].join('\n'),
    );
    const findings = scanForDestructiveGit(scratch);
    expect(findings).toEqual([]);
  });

  it('does NOT read non-shell files (.py / .ts / .json) in the scan surface', () => {
    writeShell('scripts/tool.py', '#!/usr/bin/env python3\nsubprocess.run(["git", "reset", "--hard"])\n');
    writeShell('scripts/data.json', '{ "cmd": "git reset --hard" }');
    const findings = scanForDestructiveGit(scratch);
    expect(findings).toEqual([]);
  });

  it('ALLOWLIST: an inline `# no-destructive-git:allow` on the same line suppresses the finding', () => {
    writeShell(
      'scripts/recovery.sh',
      '#!/usr/bin/env bash\ngit reset --hard origin/main  # no-destructive-git:allow documented disaster-recovery step\n',
    );
    const findings = scanForDestructiveGit(scratch);
    expect(findings).toEqual([]);
  });

  it('ALLOWLIST: an allow comment on the immediately-preceding line suppresses the finding', () => {
    writeShell(
      'scripts/recovery.sh',
      '#!/usr/bin/env bash\n# no-destructive-git:allow documented disaster-recovery step\ngit reset --hard origin/main\n',
    );
    const findings = scanForDestructiveGit(scratch);
    expect(findings).toEqual([]);
  });

  it('ALLOWLIST: the escape hatch suppresses ONLY the annotated line, not a sibling destructive call', () => {
    writeShell(
      'scripts/recovery.sh',
      [
        '#!/usr/bin/env bash',
        'git reset --hard origin/main  # no-destructive-git:allow recovery',
        'git clean -fdx',
        '',
      ].join('\n'),
    );
    const findings = scanForDestructiveGit(scratch);
    expect(findings.map((f) => f.command)).toEqual(['git clean']);
  });

  it('GREEN: scanning the real repository yields 0 violations', () => {
    const findings: Finding[] = scanForDestructiveGit(repoRoot);
    expect(findings).toEqual([]);
  });

  it('FAIL-CLOSED: throws on a nonexistent root rather than returning a clean result', () => {
    expect(() => scanForDestructiveGit(join(scratch, '__definitely_not_a_real_dir__'))).toThrow();
  });
});
