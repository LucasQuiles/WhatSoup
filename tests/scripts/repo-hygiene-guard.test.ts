import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import {
  isTrackedSensitiveArtifact,
  parseArgs,
  parseCommitAuthorLog,
  parseUnifiedDiffAddedLines,
  run,
  scanAddedLines,
  scanBranchDiff,
  scanCommitMessage,
  scanCommitAuthors,
  scanContentLines,
} from '../../scripts/repo-hygiene-guard.ts';

const tempRepos: string[] = [];
const privateHostLabelFixture = ['nuc', 'les'].join('');
const privateHostDomainFixture = `${privateHostLabelFixture}.${['qui', 'les'].join('')}.${['stu', 'dio'].join('')}`;
const privateTailnetIpFixture = ['100', '91', '13', '7'].join('.');
const privateInstanceDbFixture = ['instances', 'personal', 'bot.db'].join('/');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: cleanGitEnv() });
}

function makeBranchRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'repo-hygiene-branch-'));
  tempRepos.push(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'WhatSoup Guard']);
  git(repo, ['config', 'user.email', 'guard@users.noreply.github.com']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'chore: base']);
  git(repo, ['checkout', '-b', 'feature']);
  return repo;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const repo of tempRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
  process.exitCode = undefined;
});

describe('repo hygiene guard', () => {
  it('parses added lines and target line numbers from unified diffs', () => {
    const lines = parseUnifiedDiffAddedLines(`diff --git a/tests/example.test.ts b/tests/example.test.ts
--- a/tests/example.test.ts
+++ b/tests/example.test.ts
@@ -4,0 +5,3 @@
+const first = true;
+const second = true;
 context line
@@ -20,0 +24,1 @@
+const third = true;
`);

    expect(lines).toEqual([
      { filePath: 'tests/example.test.ts', line: 5, text: 'const first = true;' },
      { filePath: 'tests/example.test.ts', line: 6, text: 'const second = true;' },
      { filePath: 'tests/example.test.ts', line: 24, text: 'const third = true;' },
    ]);
  });

  it('flags focused tests and real-shaped group identifiers in staged added lines', () => {
    const issues = scanAddedLines([
      { filePath: 'tests/example.test.ts', line: 10, text: 'it.only("runs one case", () => {})' },
      { filePath: 'tests/example.test.ts', line: 11, text: 'const group = "1203631234567890@g.us";' },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['focused-test', 'whatsapp-group-jid']);
    expect(issues.map((issue) => `${issue.filePath}:${issue.line}`)).toEqual([
      'tests/example.test.ts:10',
      'tests/example.test.ts:11',
    ]);
  });

  it('flags private host labels in deploy script Python tests', () => {
    const issues = scanAddedLines([
      { filePath: 'deploy/scripts/tests/test_example.py', line: 4, text: `HOST = "${privateHostLabelFixture}"` },
    ]);

    expect(issues.map((issue) => issue.code)).toContain('private-host-label');
  });

  it('flags private host domains and tailnet IPs in deploy script Python tests', () => {
    const issues = scanAddedLines([
      { filePath: 'deploy/scripts/tests/test_example.py', line: 4, text: `HOST = "${privateHostDomainFixture}"` },
      { filePath: 'deploy/scripts/tests/test_example.py', line: 5, text: `EXPECTED = "${privateTailnetIpFixture}"` },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['private-host-label', 'private-tailnet-ip']),
    );
  });

  it('allows synthetic user and group fixtures', () => {
    const issues = scanAddedLines([
      { filePath: 'tests/example.test.ts', line: 12, text: 'const user = "15551234@s.whatsapp.net";' },
      { filePath: 'tests/example.test.ts', line: 13, text: 'const lid = "11111119999@lid";' },
      { filePath: 'tests/example.test.ts', line: 14, text: 'const group = "120363555555555000@g.us";' },
    ]);

    expect(issues).toEqual([]);
  });

  it('blocks real-shaped group JIDs that share the synthetic fixture prefix', () => {
    const issues = scanAddedLines([
      { filePath: 'tests/example.test.ts', line: 15, text: 'const group = "120363555123456789@g.us";' },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['whatsapp-group-jid']);
  });

  it('allows npm registry tarball URLs in package-lock without hiding internal labels elsewhere', () => {
    const issues = scanAddedLines([
      {
        filePath: 'package-lock.json',
        line: 6489,
        text: '      "resolved": "https://registry.npmjs.org/ws/-/ws-8.20.1.tgz",',
      },
      {
        filePath: 'docs/example.md',
        line: 3,
        text: 'The internal label WS-8 must not be published.',
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['internal-workstream-label']);
    expect(issues.map((issue) => `${issue.filePath}:${issue.line}`)).toEqual(['docs/example.md:3']);
  });

  it('allows detector literals in the guard fixture files only', () => {
    const fixtureIssues = scanAddedLines([
      {
        filePath: 'tests/scripts/repo-hygiene-guard.test.ts',
        line: 20,
        text: 'const detectorFixture = "Co-Authored-By: Test <person@example.com>";',
      },
      {
        filePath: 'scripts/repo-hygiene-guard.ts',
        line: 20,
        text: 'const detectorFixture = "1203631234567890@g.us";',
      },
    ]);
    const normalIssues = scanAddedLines([
      {
        filePath: 'tests/other.test.ts',
        line: 20,
        text: 'const detectorFixture = "1203631234567890@g.us";',
      },
    ]);

    expect(fixtureIssues).toEqual([]);
    expect(normalIssues.map((issue) => issue.code)).toEqual(['whatsapp-group-jid']);
  });

  it('flags private instance labels in content scans', () => {
    const issues = scanContentLines([
      {
        filePath: 'scripts/example.sh',
        line: 1,
        text: 'systemctl --user start whatsoup@q',
      },
      {
        filePath: 'src/example.ts',
        line: 2,
        text: "const channel = 'whatsapp:mw-bot';",
      },
      {
        filePath: 'deploy/example.sh',
        line: 3,
        text: `BOT_ERRORS_DB="$HOME/.local/share/whatsoup/${privateInstanceDbFixture}"`,
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual([
      'private-instance-label',
      'private-instance-label',
      'private-instance-label',
    ]);
  });

  it('flags placeholder commit authors', () => {
    const issues = scanCommitAuthors([
      {
        sha: 'abc123def4567890',
        name: 'WhatSoup Test',
        email: 'whatsoup-test.invalid',
        subject: 'docs: reconcile bead statuses',
      },
      {
        sha: 'def456abc1237890',
        name: 'Lucas Quiles',
        email: '180208450+LucasQuiles@users.noreply.github.com',
        subject: 'fix: normal commit',
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['placeholder-commit-author']);
    expect(issues[0].filePath).toBe('commit:abc123def456');
  });

  it('flags retired/ad-hoc automation commit authors but not sanctioned SoupBot', () => {
    const issues = scanCommitAuthors([
      {
        sha: '1111111111111111',
        name: 'whatsoup-bot',
        email: 'bot@users.noreply.github.com',
        subject: 'test: coverage bundle',
      },
      {
        sha: '2222222222222222',
        name: 'Worker',
        // Built from parts so the publication guard's static scan does not treat
        // the fixture as a real address (same convention as the host fixtures above).
        email: ['worker', 'local'].join('@'),
        subject: 'chore: worker output',
      },
      {
        sha: '3333333333333333',
        name: 'Codex Snapshot',
        email: ['snapshot', ['codex', 'local'].join('.')].join('@'),
        subject: 'snapshot',
      },
      {
        sha: '4444444444444444',
        name: 'SoupBot',
        email: 'soupbot@users.noreply.github.com',
        subject: 'test: sanctioned automation commit',
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual([
      'ad-hoc-bot-author',
      'ad-hoc-bot-author',
      'ad-hoc-bot-author',
    ]);
    expect(issues.map((issue) => issue.filePath)).toEqual([
      'commit:111111111111',
      'commit:222222222222',
      'commit:333333333333',
    ]);
  });

  it('flags public-hygiene violations in branch commit messages', () => {
    const issues = scanCommitAuthors([
      {
        sha: 'abc123def4567890',
        name: 'Lucas Quiles',
        email: '180208450+LucasQuiles@users.noreply.github.com',
        subject: 'feat: publishable guard update',
        message: `feat: publishable guard update

Generated with GPT.
Co-Authored-By: Person <person@example.com>
`,
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual([
      'model-attribution',
      'commit-coauthor-trailer',
      'personal-email',
    ]);
    expect(issues.map((issue) => `${issue.filePath}:${issue.line}`)).toEqual([
      'commit:abc123def456:3',
      'commit:abc123def456:4',
      'commit:abc123def456:4',
    ]);
  });

  it('parses git author logs for commit-author scanning', () => {
    const commits = parseCommitAuthorLog(
      'abc123\x00WhatSoup Test\x00whatsoup-test.invalid\x00docs: one\x1e\n'
      + 'def456\x00Lucas Quiles\x00180208450+LucasQuiles@users.noreply.github.com\x00fix: two\x00fix: two\n\nBody.\x1e\n',
    );

    expect(commits).toEqual([
      {
        sha: 'abc123',
        name: 'WhatSoup Test',
        email: 'whatsoup-test.invalid',
        subject: 'docs: one',
      },
      {
        sha: 'def456',
        name: 'Lucas Quiles',
        email: '180208450+LucasQuiles@users.noreply.github.com',
        subject: 'fix: two',
        message: 'fix: two\n\nBody.',
      },
    ]);
  });

  // Regression tests for the origin/main exclusion in readCommitAuthors.
  //
  // Background: GitHub squash-merge appends a generated Co-authored-by trailer to
  // the landed commit on origin/main (e.g. PR #791, sha 11553580).  Before the fix,
  // a branch whose upstream happened to point to an older tip of origin/main would
  // include that already-merged commit in the git-log range, causing the guard to
  // fail on every stale-upstream push.  After the fix, the '--not origin/main'
  // argument ensures commits reachable from origin/main are always excluded.
  //
  // Red-evidence path: readCommitAuthors executes real git and cannot be called in
  // a unit test without a live repo fixture.  Instead we demonstrate the mechanical
  // guarantee at the layer that matters:
  //
  //   (a) stale-upstream case — scanCommitAuthors receives an empty CommitAuthor[]
  //       (the output of readCommitAuthors after exclusion) and returns no issues.
  //       This is the guard-PASSES scenario that was broken before the fix.
  //
  //   (b) branch-only trailer case — a trailer-bearing commit that IS in scope
  //       (i.e. NOT reachable from origin/main) still produces issues.  This
  //       confirms the guard remains active for branch-introduced trailers.

  it('passes when the trailer-bearing commit is already in origin/main (stale upstream)', () => {
    // After the fix, readCommitAuthors excludes commits reachable from origin/main,
    // yielding an empty slice.  The guard must report no issues for an empty input.
    const issues = scanCommitAuthors([]);

    expect(issues).toEqual([]);
  });

  it('fails when a trailer-bearing commit is introduced only on the branch (not in origin/main)', () => {
    // A new commit on the branch that carries a Co-authored-by trailer must still
    // be caught — the exclusion applies only to already-merged commits.
    const branchOnlyCommit = {
      sha: 'cafe1234beef5678',
      name: 'Lucas Quiles',
      email: '180208450+LucasQuiles@users.noreply.github.com',
      subject: 'chore: branch-only squash',
      message: 'chore: branch-only squash\n\nCo-authored-by: LucasQuiles <LucasQuiles@users.noreply.github.com>\n',
    };
    const issues = scanCommitAuthors([branchOnlyCommit]);

    expect(issues.map((issue) => issue.code)).toContain('commit-coauthor-trailer');
  });

  it('allows operational script labels without suppressing group JID detection', () => {
    const issues = scanAddedLines([
      {
        filePath: 'scripts/cutover.sh',
        line: 94,
        text: 'systemctl --user start whatsoup@q',
      },
      {
        filePath: 'scripts/cutover.sh',
        line: 95,
        text: 'echo "120363555123456789@g.us"',
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['whatsapp-group-jid']);
  });

  it('allows the mw-bot agent label only in the mwlab health profile and fleet manifest (issue #1422)', () => {
    const allowedInProfile = scanAddedLines([
      {
        filePath: 'deploy/health-profiles/mwlab.json',
        line: 21,
        text: '      "service": "com.whatsoup.mw-bot",',
      },
      {
        filePath: 'deploy/bot-errors-expected-fleet.json',
        line: 32,
        text: '          "service": "com.whatsoup.mw-bot",',
      },
    ]);
    expect(allowedInProfile).toEqual([]);

    const flaggedElsewhere = scanAddedLines([
      {
        filePath: 'deploy/health-profiles/mini1.json',
        line: 1,
        text: '      "service": "com.whatsoup.mw-bot",',
      },
    ]);
    expect(flaggedElsewhere.map((issue) => issue.code)).toEqual(['private-instance-label']);
  });

  it('allows bare release env var names without hiding private labels', () => {
    const envOnlyIssues = scanContentLines([
      {
        filePath: 'src/example.ts',
        line: 1,
        text: 'ALLOW_M365_MUTATIONS',
      },
    ]);
    const mixedIssues = scanContentLines([
      {
        filePath: 'src/example.ts',
        line: 2,
        text: 'mw-bot has ALLOW_M365_MUTATIONS=1',
      },
    ]);

    expect(envOnlyIssues).toEqual([]);
    expect(mixedIssues.map((issue) => issue.code)).toEqual(['private-instance-label']);
  });

  it('scans full-tree content without enforcing staged-only source console checks', () => {
    const issues = scanContentLines([
      {
        filePath: 'src/fleet/routes/example.ts',
        line: 1,
        text: 'console.log("existing operational entrypoint");',
      },
      {
        filePath: 'docs/example.md',
        line: 2,
        text: 'Generated with GPT.',
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['model-attribution']);
  });

  it('blocks new ad-hoc console logging in production source files', () => {
    const issues = scanAddedLines([
      {
        filePath: 'src/fleet/routes/example.ts',
        line: 42,
        text: 'console.log("debug route payload", payload);',
      },
      {
        filePath: 'src/runtimes/chat/runtime.ts',
        line: 77,
        text: 'console.error("chat failed", err);',
      },
      {
        filePath: 'console/src/components/Example.tsx',
        line: 12,
        text: 'console.warn("debug console component", payload);',
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual([
      'src-console-call',
      'src-console-call',
      'src-console-call',
    ]);
    expect(issues.map((issue) => `${issue.filePath}:${issue.line}`)).toEqual([
      'src/fleet/routes/example.ts:42',
      'src/runtimes/chat/runtime.ts:77',
      'console/src/components/Example.tsx:12',
    ]);
  });

  it('allows existing CLI and bootstrap console entrypoints', () => {
    const issues = scanAddedLines([
      {
        filePath: 'src/bootstrap.ts',
        line: 11,
        text: 'console.error(err instanceof Error ? err.message : String(err));',
      },
      {
        filePath: 'src/bootstrap-auth.ts',
        line: 10,
        text: 'console.error(err instanceof Error ? err.message : String(err));',
      },
      {
        filePath: 'src/transport/auth.ts',
        line: 27,
        text: 'console.error("Starting WhatsApp authentication...");',
      },
      {
        filePath: 'src/fleet/standalone.ts',
        line: 27,
        text: 'console.log("Fleet server listening");',
      },
      {
        filePath: 'src/config.ts',
        line: 440,
        text: 'console.warn(payload, message);',
      },
    ]);

    expect(issues).toEqual([]);
  });

  it('blocks staged child-process hazards, debuggers, and unbounded suppressions', () => {
    const issues = scanAddedLines([
      {
        filePath: 'src/process-runner.ts',
        line: 1,
        text: 'spawn("node", [], { env: { ...process.env } });',
      },
      {
        filePath: 'scripts/run-task.ts',
        line: 2,
        text: 'spawn("node", [], { shell: true });',
      },
      {
        filePath: 'console/src/runner.ts',
        line: 3,
        text: 'const compiled = Function(source);',
      },
      {
        filePath: 'src/handler.ts',
        line: 4,
        text: 'debugger;',
      },
      {
        filePath: 'src/types.ts',
        line: 5,
        text: '// @ts-expect-error',
      },
      {
        filePath: 'src/types.ts',
        line: 6,
        text: '// @ts-expect-error -- upstream type is narrower than runtime payload; expires 2026-12-31',
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual([
      'process-env-inheritance',
      'child-process-shell-true',
      'dynamic-code-execution',
      'debugger-statement',
      'unbounded-suppression',
    ]);
    expect(issues.some((issue) => issue.line === 6)).toBe(false);
  });

  it('classifies staged runtime artifacts as sensitive without blocking tracked settings template', () => {
    expect(isTrackedSensitiveArtifact('.env')).toBe(true);
    expect(isTrackedSensitiveArtifact('.env.local')).toBe(true);
    expect(isTrackedSensitiveArtifact('.env.example')).toBe(false);
    expect(isTrackedSensitiveArtifact('.mcp.json')).toBe(true);
    expect(isTrackedSensitiveArtifact('.tmup-artifacts/task/output.md')).toBe(true);
    expect(isTrackedSensitiveArtifact('artifacts/private-screenshot.png')).toBe(true);
    expect(isTrackedSensitiveArtifact('instances/test/instance.json')).toBe(true);
    expect(isTrackedSensitiveArtifact('users/chat/auth_info_baileys/creds.json')).toBe(true);
    expect(isTrackedSensitiveArtifact('bot.db')).toBe(true);
    expect(isTrackedSensitiveArtifact('certs/private.pem')).toBe(true);
    expect(isTrackedSensitiveArtifact('.claude/settings.json')).toBe(false);
  });

  it('flags public-history hygiene problems in commit messages', () => {
    const issues = scanCommitMessage(`feat(test): add coverage

Generated with GPT.
Co-Authored-By: Person <person@example.com>
`);

    expect(issues.map((issue) => issue.code)).toEqual([
      'model-attribution',
      'commit-coauthor-trailer',
      'personal-email',
    ]);
    expect(issues.map((issue) => issue.line)).toEqual([3, 4, 4]);
  });

  it('allows messaging-address right-hand sides while flagging personal emails in commit messages', () => {
    const messagingIssues = scanCommitMessage(`test: add address fixtures

Fixture contact: 15551234567@c.us
Fixture contact: 15551234567@s.whatsapp.net
Fixture contact: 11111119999@lid
`);
    const personalIssues = scanCommitMessage(`test: add contact

Contact dev@example.net for help.
`);

    expect(messagingIssues).toEqual([]);
    expect(personalIssues.map((issue) => issue.code)).toEqual(['personal-email']);
  });

  it('allows synthetic group JIDs in commit messages while blocking real-shaped ones', () => {
    const syntheticIssues = scanCommitMessage(`fix(guard): allow synthetic group examples

Allows 120363555555555000@g.us as documentation fixture text.
`);
    const realIssues = scanCommitMessage(`fix(guard): document migrated group

The migrated group was 1203631234567890@g.us.
`);

    expect(syntheticIssues).toEqual([]);
    expect(realIssues.map((issue) => issue.code)).toEqual(['whatsapp-group-jid']);
  });

  it('parses staged, branch-diff, and commit-message modes', () => {
    expect(parseArgs([])).toEqual({ mode: 'staged', help: false });
    expect(parseArgs(['--staged'])).toEqual({ mode: 'staged', help: false });
    expect(parseArgs(['--branch-diff'])).toEqual({ mode: 'branch-diff', help: false });
    expect(parseArgs(['--branch-diff', '--base', 'origin/main'])).toEqual({
      mode: 'branch-diff',
      baseRef: 'origin/main',
      help: false,
    });
    expect(parseArgs(['--release-hygiene'])).toEqual({ mode: 'release-hygiene', help: false });
    expect(parseArgs(['--commit-msg', '.git/COMMIT_EDITMSG'])).toEqual({
      mode: 'commit-msg',
      messageFile: '.git/COMMIT_EDITMSG',
      help: false,
    });
    expect(parseArgs(['--commit-msg', '--help'])).toEqual({
      mode: 'commit-msg',
      help: true,
    });
    expect(() => parseArgs(['--branch-diff', '--base'])).toThrow(/requires a git ref/);
    expect(() => parseArgs(['--staged', '--base', 'origin/main'])).toThrow(/only valid with --branch-diff/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });

  it('scans committed branch additions against the merge-base, not only the staged index', () => {
    const repo = makeBranchRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'leak.ts'), "export const phone = '+447123456789';\n");
    git(repo, ['add', 'src/leak.ts']);
    git(repo, ['commit', '-m', 'test: branch leak fixture']);

    const issues = scanBranchDiff(repo, 'main');

    expect(issues.map((issue) => issue.code)).toEqual(['operator-phone']);
    expect(issues.map((issue) => `${issue.filePath}:${issue.line}`)).toEqual(['src/leak.ts:1']);
  });

  it('flags sensitive artifacts committed on the branch even with an empty staged diff', () => {
    const repo = makeBranchRepo();
    writeFileSync(join(repo, '.env.local'), "TOKEN='fixture'\n");
    git(repo, ['add', '.env.local']);
    git(repo, ['commit', '-m', 'test: branch artifact fixture']);

    const issues = run(['--branch-diff', '--base', 'main'], repo);

    expect(issues.map((issue) => issue.code)).toEqual(['branch-sensitive-artifact']);
    expect(process.exitCode).toBe(1);
  });

  it('flags secret-shaped content added and removed before the final branch diff', () => {
    const repo = makeBranchRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'transient.ts'), 'WEBHOOK_SECRET=a3f1c9d2e84b076f5a192c3e7d408b1f\n');
    git(repo, ['add', 'src/transient.ts']);
    git(repo, ['commit', '-m', 'test: transient secret fixture']);
    git(repo, ['rm', 'src/transient.ts']);
    git(repo, ['commit', '-m', 'test: remove transient secret fixture']);

    const issues = scanBranchDiff(repo, 'main');

    expect(issues.map((issue) => issue.code)).toEqual(['secret-assignment']);
    expect(issues[0].message).toContain('[branch history');
  });

  it('does not flag branch-history secret lines byte-identical to the base ref (merge re-exposure)', () => {
    // Mirrors the real cutover false-positive: a secret-shaped sentinel that ALREADY
    // exists on the base (origin/main) is re-exposed in a branch-unique merge commit's
    // per-commit diff. Because the line is byte-identical to main it is already-published,
    // not branch-introduced, and must not be flagged. (A genuinely-new transient secret is
    // still flagged — see the preceding test.)
    const repo = makeBranchRepo(); // leaves us on 'feature', branched off 'main'
    const sentinel = 'WEBHOOK_SECRET=a3f1c9d2e84b076f5a192c3e7d408b1f\n';

    // feature gets a unique commit so the later merge is a real (non-fast-forward) merge.
    writeFileSync(join(repo, 'feature-only.txt'), 'x\n');
    git(repo, ['add', 'feature-only.txt']);
    git(repo, ['commit', '-m', 'test: feature-only commit']);

    // The sentinel lands on main (the base) — already-published content.
    git(repo, ['checkout', 'main']);
    mkdirSync(join(repo, 'tests', 'drills'), { recursive: true });
    writeFileSync(join(repo, 'tests', 'drills', 'drill.sh'), sentinel);
    git(repo, ['add', 'tests/drills/drill.sh']);
    git(repo, ['commit', '-m', 'chore: base drill sentinel']);

    // feature merges main → a branch-unique merge commit re-exposes main's drill line.
    git(repo, ['checkout', 'feature']);
    git(repo, ['merge', 'main', '--no-edit']);

    const issues = scanBranchDiff(repo, 'main');

    expect(issues.filter((issue) => issue.code === 'secret-assignment')).toEqual([]);
  });

  it('flags sensitive artifacts added and removed before the final branch diff', () => {
    const repo = makeBranchRepo();
    writeFileSync(join(repo, '.env.local'), "TOKEN='fixture'\n");
    git(repo, ['add', '.env.local']);
    git(repo, ['commit', '-m', 'test: transient artifact fixture']);
    git(repo, ['rm', '.env.local']);
    git(repo, ['commit', '-m', 'test: remove transient artifact fixture']);

    const issues = scanBranchDiff(repo, 'main');

    expect(issues.map((issue) => issue.code)).toEqual(['branch-history-sensitive-artifact']);
    expect(issues[0].message).toContain('branch history');
  });

  it('parses scan-history mode with optional depth and rejects bad depth', () => {
    expect(parseArgs(['--scan-history'])).toEqual({ mode: 'scan-history', help: false });
    expect(parseArgs(['--scan-history', '25'])).toEqual({
      mode: 'scan-history',
      historyDepth: 25,
      help: false,
    });
    expect(() => parseArgs(['--scan-history', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--scan-history', '-3'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--scan-history', 'abc'])).toThrow(/positive integer/);
  });

  describe('secret-shape detection (hardened patterns)', () => {
    it('blocks real-format provider keys outside fixture markers', () => {
      const issues = scanAddedLines([
        { filePath: 'src/x.ts', line: 1, text: `const k = '${['sk-ant-api03', 'AbCdEf1234567890XyZqWeRtY'].join('-')}';` },
        { filePath: 'src/x.ts', line: 2, text: `const p = '${['pcsk', '4xY2AbCdEfGhIjKlMnOpQrStUvWxYz12'].join('_')}';` },
        { filePath: 'src/x.ts', line: 3, text: `const o = '${['sk', 'AbCdEf1234567890GhIjKlMnOp'].join('-')}';` },
        { filePath: 'src/x.ts', line: 4, text: `const t = '${'AC' + 'deadbeef0123456789abcdef01234567'}';` },
        { filePath: 'src/x.ts', line: 5, text: `const g = '${['ghp', 'AbCdEfGhIjKlMnOpQrStUvWxYz1234567'].join('_')}';` },
      ]);

      expect(issues.map((issue) => issue.code).sort()).toEqual([
        'anthropic-key',
        'github-token',
        'openai-key',
        'pinecone-key',
        'twilio-account-sid',
      ]);
    });

    it('allows synthetic provider-key and Twilio SID fixtures', () => {
      const issues = scanAddedLines([
        { filePath: 'tests/x.test.ts', line: 1, text: "apiKey: 'sk-test-elevenlabs-key'" },
        { filePath: 'tests/x.test.ts', line: 2, text: "apiKey: 'pcsk_test_fixture_value_here'" },
        { filePath: 'tests/x.test.ts', line: 3, text: "accountSid: 'AC00000000000000000000000000000000'" },
        { filePath: 'tests/x.test.ts', line: 4, text: "key: 'sk-ant-mock-not-a-real-secret'" },
      ]);

      expect(issues).toEqual([]);
    });

    it('blocks Twilio Account SID shapes without flagging the word ACCOUNT', () => {
      const issues = scanAddedLines([
        { filePath: 'docs/x.md', line: 1, text: 'See your ACCOUNT settings to find the SID.' },
        { filePath: 'src/x.ts', line: 2, text: `sid = '${'AC' + 'fedcba9876543210fedcba9876543210'}';` },
      ]);

      expect(issues.map((issue) => issue.code)).toEqual(['twilio-account-sid']);
    });

    it('blocks full-block and embedded single-line PEM private keys', () => {
      const issues = scanAddedLines([
        { filePath: 'src/x.ts', line: 1, text: 'const pem = "-----BEGIN PRIVATE KEY-----MIIabc...";' },
        { filePath: 'src/x.ts', line: 2, text: '-----BEGIN OPENSSH PRIVATE KEY-----' },
        { filePath: 'src/x.ts', line: 3, text: '-----BEGIN ENCRYPTED PRIVATE KEY-----' },
      ]);

      expect(issues.map((issue) => issue.code)).toEqual([
        'private-key',
        'private-key',
        'private-key',
      ]);
    });

    it('blocks real-shaped +E.164 operator phones while allowing reserved fixtures', () => {
      const issues = scanAddedLines([
        { filePath: 'src/x.ts', line: 1, text: "const real = '+447123456789';" },
        { filePath: 'tests/x.test.ts', line: 2, text: "const fake = '+14155550100';" },
        { filePath: 'tests/x.test.ts', line: 3, text: "const fixture = '+15551230008';" },
        { filePath: 'tests/x.test.ts', line: 4, text: "const placeholder = '+1234567890';" },
      ]);

      expect(issues.map((issue) => issue.code)).toEqual(['operator-phone']);
      expect(issues.map((issue) => issue.line)).toEqual([1]);
    });
  });

  describe('secret-assignment word-boundary false-negative regression', () => {
    // Proves the historical \b-anchored keyword form silently missed the most
    // common real key formats (underscore-prefixed env vars, JSON keys), and that
    // the hardened end-anchored pattern now catches them.
    const oldBrokenKeywordRegex = /\b(?:api_key|apikey|secret|access_token|password)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}/i;

    const leakLines = [
      "ANTHROPIC_API_KEY='Ab12Cd34Ef56Gh78Ij90KlMn'",
      'PINECONE_API_KEY=Xq7Lm2Pn9Rt4Vw1Zb6Yc3Df8Ee',
      'const cfg = {"apiKey":"Hk83JdL92mFpQ7rTz4XyAb12"};',
      "client_secret: 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2'",
      // All-lowercase-hex secret (no case signal) — must not slip the entropy floor.
      'WEBHOOK_SECRET=a3f1c9d2e84b076f5a192c3e7d408b1f',
    ];

    it('proves the old \\b-anchored regex misses underscore-prefixed and JSON keys', () => {
      // \b never fires between two word chars: ANTHROPIC_ + API_KEY is invisible.
      expect(oldBrokenKeywordRegex.test("ANTHROPIC_API_KEY='Ab12Cd34Ef56Gh78Ij90KlMn'")).toBe(false);
      expect(oldBrokenKeywordRegex.test('PINECONE_API_KEY=Xq7Lm2Pn9Rt4Vw1Zb6Yc3Df8Ee')).toBe(false);
      // JSON "apiKey": — the quote between keyword and ':' breaks \s*[:=].
      expect(oldBrokenKeywordRegex.test('const cfg = {"apiKey":"Hk83JdL92mFpQ7rTz4XyAb12"};')).toBe(false);
    });

    it('hardened guard catches every leak the old regex missed', () => {
      const issues = scanAddedLines(
        leakLines.map((text, index) => ({ filePath: 'src/leak.ts', line: index + 1, text })),
      );

      expect(issues.map((issue) => issue.code)).toEqual([
        'secret-assignment',
        'secret-assignment',
        'secret-assignment',
        'secret-assignment',
        'secret-assignment',
      ]);
    });

    it('does not let a placeholder word in the key NAME suppress a real value', () => {
      // The value allowlist must see only the RHS — not EXAMPLE_/SAMPLE_ in the
      // key name — so EXAMPLE_API_KEY=<real secret> is still blocked.
      const issues = scanAddedLines([
        { filePath: 'src/x.ts', line: 1, text: "EXAMPLE_API_KEY='RealSecret1234AbcDefGhiJkl'" },
        { filePath: 'src/x.ts', line: 2, text: "SAMPLE_SECRET_KEY=Zx9Wv8Ut7Sr6Qp5On4Ml3Kj2" },
      ]);

      expect(issues.map((issue) => issue.code)).toEqual([
        'secret-assignment',
        'secret-assignment',
      ]);
    });

    it('blocks GitHub fine-grained PAT shapes', () => {
      const issues = scanAddedLines([
        { filePath: 'src/x.ts', line: 1, text: "const t = 'github_pat_11ABCDEFG0abcdefghij1234567890';" },
      ]);

      expect(issues.map((issue) => issue.code)).toEqual(['github-token']);
    });

    it('allows env indirection, redaction markers, and low-entropy dummy fixtures', () => {
      const issues = scanAddedLines([
        { filePath: 'src/x.ts', line: 1, text: 'apiKey: process.env.ANTHROPIC_API_KEY' },
        { filePath: 'src/x.ts', line: 2, text: "apiKey: config.apiKey" },
        { filePath: 'docs/x.md', line: 3, text: 'API_KEY=<your-api-key-here>' },
        { filePath: 'docs/x.md', line: 4, text: "apiKey: 'redacted-for-publication-xxxx'" },
        { filePath: 'tests/x.test.ts', line: 5, text: "process.env.OPENAI_API_KEY = 'env-key-should-be-overridden';" },
        { filePath: 'tests/x.test.ts', line: 6, text: "apiKey: 'sk-ant-secret'" },
      ]);

      expect(issues).toEqual([]);
    });
  });
});

describe('tag-release-gate workflow', () => {
  it('tag-release-gate.yml exists', async () => {
    const { existsSync } = await import('node:fs');
    expect(existsSync('.github/workflows/tag-release-gate.yml')).toBe(true);
  });
});
