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

  // ── F1: string / heredoc literals are DATA, not commands ────────────────────
  it('F1: does NOT flag a destructive command name inside a double-quoted echo string', () => {
    writeShell('scripts/msg.sh', '#!/usr/bin/env bash\necho "never run git reset --hard on main"\n');
    expect(scanForDestructiveGit(scratch)).toEqual([]);
  });

  it('F1: does NOT flag a destructive command name inside a quoted log argument', () => {
    writeShell('scripts/msg.sh', '#!/usr/bin/env bash\nlog "recover with git checkout --force"\n');
    expect(scanForDestructiveGit(scratch)).toEqual([]);
  });

  it('F1: does NOT flag a destructive command name inside a variable-assignment string', () => {
    writeShell('scripts/msg.sh', '#!/usr/bin/env bash\nMSG="git push --force is banned in this repo"\n');
    expect(scanForDestructiveGit(scratch)).toEqual([]);
  });

  it('F1: does NOT flag destructive command names inside a heredoc body (DATA)', () => {
    writeShell(
      'scripts/help.sh',
      [
        '#!/usr/bin/env bash',
        'cat <<EOF',
        'Do not use git clean -fdx here.',
        'git reset --hard   # even a bare-looking line inside the heredoc body is DATA',
        'EOF',
        '',
      ].join('\n'),
    );
    expect(scanForDestructiveGit(scratch)).toEqual([]);
  });

  it('F1-GREEN: a real `git reset --hard` at command position is STILL flagged', () => {
    writeShell('scripts/recover.sh', '#!/usr/bin/env bash\ngit reset --hard origin/main\n');
    const findings = scanForDestructiveGit(scratch);
    expect(findings.some((f) => f.command === 'git reset --hard')).toBe(true);
  });

  it('F1-HARDENING: a destructive git after a shell keyword prefix (`if …; then`) IS flagged', () => {
    // Reserved-word prefixes must not create a false negative in a safety-critical guard.
    writeShell('scripts/branch.sh', '#!/usr/bin/env bash\nif git push --force origin main; then :; fi\n');
    const findings = scanForDestructiveGit(scratch);
    expect(findings.some((f) => f.command === 'git push --force')).toBe(true);
  });

  // ── F2: git global-option prefixes must not bypass detection ─────────────────
  it('F2: flags `git -C <dir> reset --hard` (global -C before the subcommand)', () => {
    writeShell('scripts/x.sh', '#!/usr/bin/env bash\ngit -C "$REPO" reset --hard origin/main\n');
    const findings = scanForDestructiveGit(scratch);
    expect(findings.some((f) => f.command === 'git reset --hard')).toBe(true);
  });

  it('F2: flags `git -c <cfg> push --force` (global -c with its argument)', () => {
    writeShell('scripts/x.sh', '#!/usr/bin/env bash\ngit -c user.name=x push --force origin main\n');
    const findings = scanForDestructiveGit(scratch);
    expect(findings.some((f) => f.command === 'git push --force')).toBe(true);
  });

  it('F2: flags `git --git-dir=… --work-tree=… checkout -f` (=-form global options)', () => {
    writeShell('scripts/x.sh', '#!/usr/bin/env bash\ngit --git-dir=/x --work-tree=/y checkout -f main\n');
    const findings = scanForDestructiveGit(scratch);
    expect(findings.some((f) => f.command === 'git checkout --force')).toBe(true);
  });

  // ── F3: dry-run `git clean` is non-destructive ──────────────────────────────
  it('F3: does NOT flag `git clean -nd` (dry-run combined short flag)', () => {
    writeShell('scripts/x.sh', '#!/usr/bin/env bash\ngit clean -nd\n');
    expect(scanForDestructiveGit(scratch)).toEqual([]);
  });

  it('F3: does NOT flag `git clean --dry-run -d`', () => {
    writeShell('scripts/x.sh', '#!/usr/bin/env bash\ngit clean --dry-run -d\n');
    expect(scanForDestructiveGit(scratch)).toEqual([]);
  });

  it('F3: does NOT flag `git clean -nx`', () => {
    writeShell('scripts/x.sh', '#!/usr/bin/env bash\ngit clean -nx\n');
    expect(scanForDestructiveGit(scratch)).toEqual([]);
  });

  it('F3-GREEN: still flags real destructive `git clean` forms (-fdx / -fd / --force)', () => {
    writeShell(
      'scripts/x.sh',
      ['#!/usr/bin/env bash', 'git clean -fdx', 'git clean -fd', 'git clean --force', ''].join('\n'),
    );
    const findings = scanForDestructiveGit(scratch);
    expect(findings.filter((f) => f.command === 'git clean')).toHaveLength(3);
  });

  // ── F4: --force-if-includes / --force-if-equal are not history-rewriting force ─
  it('F4: does NOT flag `git push --force-if-includes`', () => {
    writeShell('scripts/x.sh', '#!/usr/bin/env bash\ngit push --force-if-includes origin main\n');
    expect(scanForDestructiveGit(scratch)).toEqual([]);
  });

  it('F4-GREEN: still flags `git push --force`, `--force-with-lease`, and `-f`', () => {
    writeShell(
      'scripts/x.sh',
      [
        '#!/usr/bin/env bash',
        'git push --force origin main',
        'git push --force-with-lease origin main',
        'git push -f origin main',
        '',
      ].join('\n'),
    );
    const findings = scanForDestructiveGit(scratch);
    expect(findings.filter((f) => f.command === 'git push --force')).toHaveLength(3);
  });

  it('F1-ARITH: an arithmetic left-shift `$((1 << 10))` does NOT open a spurious heredoc that blinds later lines', () => {
    // Regression: without arithmetic-depth tracking, `<< 10` is misread as a heredoc opener,
    // skipping every following line to EOF — hiding the real `git push --force` below.
    writeShell('scripts/shift.sh', '#!/usr/bin/env bash\nn=$((1 << 10))\ngit push --force origin main\n');
    const findings = scanForDestructiveGit(scratch);
    expect(findings.some((f) => f.command === 'git push --force')).toBe(true);
  });

  it('GREEN: scanning the real repository yields 0 violations', () => {
    const findings: Finding[] = scanForDestructiveGit(repoRoot);
    expect(findings).toEqual([]);
  });

  it('FAIL-CLOSED: throws on a nonexistent root rather than returning a clean result', () => {
    expect(() => scanForDestructiveGit(join(scratch, '__definitely_not_a_real_dir__'))).toThrow();
  });
});
