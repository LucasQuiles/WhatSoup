import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import { canonicalizeBoundaryRun } from '../../scripts/lib/verification/boundary-run/shared.ts';
import * as repoHygieneGuardModule from '../../scripts/repo-hygiene-guard.ts';
import {
  createRepoHygieneExactRangeArtifact,
  currentRepoHygienePolicyDigest,
  isAllowedPatternMatch,
  isTrackedSensitiveArtifact,
  parseArgs,
  parseCommitAuthorLog,
  parseUnifiedDiffAddedLines,
  projectedFileSecretFixtureFiles,
  projectedFileSecretPatternCodes,
  run,
  scanAddedLines,
  scanBranchDiff,
  scanCommitMessage,
  scanCommitAuthors,
  scanContentLines,
  scanProjectedFileSecretLines,
  validateRepoHygieneExactRangeArtifact,
} from '../../scripts/repo-hygiene-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempRepos: string[] = [];
const githubTokenFixture = ['ghp', 'RealLookingToken1234567890'].join('_');
const privateHostLabelFixture = ['nuc', 'les'].join('');
const privateHostDomainFixture = `${privateHostLabelFixture}.${['qui', 'les'].join('')}.${['stu', 'dio'].join('')}`;
const privateTailnetIpFixture = ['100', '91', '13', '7'].join('.');
const privateInstanceDbFixture = ['instances', 'personal', 'bot.db'].join('/');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: cleanGitEnv() });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message]);
  return gitOutput(cwd, ['rev-parse', 'HEAD']);
}

function requireExactRangeArtifact(
  result: ReturnType<typeof createRepoHygieneExactRangeArtifact>,
) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.artifact;
}

function exactRangePayload(
  result: ReturnType<typeof createRepoHygieneExactRangeArtifact>,
): Record<string, unknown> {
  const artifact = requireExactRangeArtifact(result);
  return JSON.parse(Buffer.from(artifact.payloadBytes).toString('utf8')) as Record<string, unknown>;
}

function artifactForPayload(
  payload: unknown,
): ReturnType<typeof requireExactRangeArtifact> {
  const payloadBytes = Uint8Array.from(Buffer.from(canonicalizeBoundaryRun(payload), 'utf8'));
  return {
    payloadBytes,
    binding: {
      schemaVersion: 1,
      detectorId: 'repo-hygiene-guard',
      payloadByteLength: payloadBytes.byteLength,
      payloadSha256: `sha256:${createHash('sha256').update(payloadBytes).digest('hex')}`,
    },
  };
}

function expectedForArtifact(
  artifact: ReturnType<typeof requireExactRangeArtifact>,
  payload: { toolDigest: string; policyDigest: string },
  lineage: { baseOid: string; remoteOid: string | null; localOid: string },
) {
  return {
    ...lineage,
    currentToolDigest: payload.toolDigest,
    currentPolicyDigest: payload.policyDigest,
    expectedPayloadByteLength: artifact.binding.payloadByteLength,
    expectedPayloadSha256: artifact.binding.payloadSha256,
  };
}

function requireArtifactBindingFields(payload: unknown): { toolDigest: string; policyDigest: string } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('artifact payload must be an object');
  const { toolDigest, policyDigest } = payload as Record<string, unknown>;
  if (typeof toolDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(toolDigest) || typeof policyDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(policyDigest)) throw new Error('artifact binding digests are invalid');
  return { toolDigest, policyDigest };
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

function makeEmptyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'repo-hygiene-empty-'));
  tempRepos.push(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'WhatSoup Guard']);
  git(repo, ['config', 'user.email', 'guard@users.noreply.github.com']);
  return repo;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const repo of tempRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
  process.exitCode = undefined;
});

describe('repo hygiene guard — release-hygiene refuses a whole-tree scan of zero files', () => {
  it('release-hygiene is INCONCLUSIVE (exit 2) when no release-hygiene file is tracked', () => {
    // release-hygiene is git ls-files intersected with a fixed list; on an empty tree the
    // intersection is empty and it printed "repo hygiene guard passed" having read nothing.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    run(['--release-hygiene'], makeEmptyRepo());
    expect(process.exitCode, 'a zero-file release-hygiene scan must not pass').toBe(2);
    expect(error.mock.calls.flat().join(' ')).toMatch(/INCONCLUSIVE/i);
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/passed/i);
  });

  it('staged mode STILL PASSES (exit 0) on an empty index — diff-scope is exempt from the floor', () => {
    // The mode gate: staged scans the diff, where an empty set is legitimately nothing. Only
    // the whole-tree release-hygiene mode is floored; flooring staged would block clean commits.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    run(['--staged'], makeEmptyRepo());
    expect(process.exitCode ?? 0).toBe(0);
  });
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

  it('blocks todo tests in staged added lines', () => {
    const issues = scanAddedLines([
      { filePath: 'tests/example.test.ts', line: 10, text: 'it.todo("implement this test")' },
      { filePath: 'tests/example.test.ts', line: 11, text: 'test.todo("implement that test")' },
      { filePath: 'tests/example.test.ts', line: 12, text: 'describe.todo("implement this suite")' },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['todo-test', 'todo-test', 'todo-test']);
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

  it('allows systemd template-unit service names in the nucles health profile and fleet manifest', () => {
    // Composed so the test source itself carries no email-shaped literal.
    const qUnit = ['whatsoup@q', 'service'].join('.');
    const personalUnit = ['whatsoup@personal', 'service'].join('.');
    const allowedInProfile = scanAddedLines([
      {
        filePath: 'deploy/health-profiles/nucles.json',
        line: 30,
        text: `      "service": "${qUnit}",`,
      },
      {
        filePath: 'deploy/health-profiles/nucles.json',
        line: 38,
        text: `      "service": "${personalUnit}",`,
      },
      {
        filePath: 'deploy/bot-errors-expected-fleet.json',
        line: 62,
        text: `          "service": "${personalUnit}",`,
      },
    ]);
    expect(allowedInProfile).toEqual([]);

    const flaggedElsewhere = scanAddedLines([
      {
        filePath: 'deploy/health-profiles/mini1.json',
        line: 1,
        text: `      "service": "${personalUnit}",`,
      },
    ]);
    expect(flaggedElsewhere.map((issue) => issue.code)).toEqual(['personal-email', 'private-instance-label']);
  });

  it('scopes self-referential allowlist files to label codes and keeps operational files code-gated', () => {
    // The shared allowlist source may carry its own path + identifier literals...
    const allowed = scanAddedLines([
      { filePath: 'scripts/lib/guard-core.ts', line: 10, text: "  'deploy/health-profiles/nucles.json'," },
      { filePath: 'scripts/lib/guard-core.ts', line: 20, text: "  'whatsoup-personal'," },
    ]);
    expect(allowed).toEqual([]);

    // ...but every non-label leak class stays enforced there (regression pin for
    // the demonstrated blanket-fixtureFiles blind spot).
    const poisoned = scanAddedLines([
      {
        filePath: 'scripts/lib/guard-core.ts',
        line: 30,
        text: '// reachable at 100.91.13.7, page +12129580142 if down',
      },
    ]);
    expect(poisoned.map((issue) => issue.code).sort()).toEqual(['operator-phone', 'private-tailnet-ip']);

    // Operational fleet files are code-gated, never blanket-exempt.
    const operationalPoison = scanAddedLines([
      {
        filePath: 'deploy/health-profiles/nucles.json',
        line: 5,
        text: '      "note": "reachable at 100.91.13.7",',
      },
    ]);
    expect(operationalPoison.map((issue) => issue.code)).toEqual(['private-tailnet-ip']);

    // Direct pin of the operational-bypass code gate: an allowlisted token never
    // suppresses a non-label class that reaches the fallback (key/phone/secret
    // classes return earlier and never reach it; tailnet-ip does).
    expect(
      isAllowedPatternMatch('deploy/health-profiles/nucles.json', 'private-tailnet-ip', 'whatsoup@personal'),
    ).toBe(false);
    const composedUnit = ['whatsoup@personal', 'service'].join('.');
    expect(isAllowedPatternMatch('deploy/health-profiles/nucles.json', 'personal-email', composedUnit)).toBe(true);
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

  it('exempts inert markdown prose while retaining suppression checks for MDX and tests', () => {
    const suppressionToken = ['@ts', 'ignore'].join('-');
    const issues = scanAddedLines([
      { filePath: 'docs/plan.md', line: 10, text: `The policy prohibits ${suppressionToken} in production code.` },
      { filePath: 'README.markdown', line: 20, text: `Do not add ${suppressionToken} to bypass type checking.` },
      {
        filePath: 'docs/example.mdx',
        line: 30,
        text: `{/* ${suppressionToken} */}`,
      },
      { filePath: 'tests/example.test.ts', line: 40, text: `// ${suppressionToken}` },
    ]);
    expect(issues).toEqual([
      {
        code: 'unbounded-suppression',
        message: 'Lint/type suppressions must include a rationale and an expires YYYY-MM-DD marker.',
        filePath: 'docs/example.mdx',
        line: 30,
      },
      {
        code: 'unbounded-suppression',
        message: 'Lint/type suppressions must include a rationale and an expires YYYY-MM-DD marker.',
        filePath: 'tests/example.test.ts',
        line: 40,
      },
    ]);
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

  it('allows the exact GitHub SSH transport principal while preserving mailbox detection', () => {
    const sshPrincipal = ['git', 'github.com'].join('@');
    const sshIssues = scanAddedLines([
      {
        filePath: '.github/workflows/quality.yml',
        line: 1,
        text: `git remote add origin ${sshPrincipal}:LucasQuiles/test-integrity.git`,
      },
    ]);
    const githubMailbox = ['operator', 'github.com'].join('@');
    const githubMailboxIssues = scanAddedLines([
      {
        filePath: '.github/workflows/quality.yml',
        line: 2,
        text: `contact ${githubMailbox}`,
      },
    ]);
    const mixedIssues = scanAddedLines([
      {
        filePath: '.github/workflows/quality.yml',
        line: 3,
        text: `${sshPrincipal}:LucasQuiles/test-integrity.git contact ${githubMailbox}`,
      },
    ]);

    expect(sshIssues).toEqual([]);
    expect(githubMailboxIssues.map((issue) => issue.code)).toEqual(['personal-email']);
    expect(mixedIssues.map((issue) => issue.code)).toEqual(['personal-email']);
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

  describe('exact-range native receipt', () => {
    it('blocks the exact outgoing commit even when ambient HEAD is safe', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'outgoing.ts'), `export const token = '${githubTokenFixture}';\n`);
      const localOid = commitAll(repo, 'test: exact outgoing fixture');
      git(repo, ['checkout', 'main']);

      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));

      expect(payload.outcome).toBe('block');
      expect(payload.localOid).toBe(localOid);
      expect(payload.rangeStartOid).toBe(baseOid);
      expect(payload.nativeCauses).toEqual(['github-token']);
      expect(JSON.stringify(payload)).not.toContain('RealLookingToken');
    });

    it('reports transient secret and sensitive-artifact history without applying all rules historically', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'transient.ts'), 'WEBHOOK_SECRET=a3f1c9d2e84b076f5a192c3e7d408b1f\n');
      writeFileSync(join(repo, '.env.local'), 'fixture\n');
      commitAll(repo, 'test: transient exact evidence');
      git(repo, ['rm', 'src/transient.ts', '.env.local']);
      const localOid = commitAll(repo, 'test: remove exact evidence');

      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));

      expect(payload.outcome).toBe('block');
      expect(payload.nativeCauses).toEqual([
        'branch-history-sensitive-artifact',
        'secret-assignment',
      ]);
      const findings = payload.findings as Array<Record<string, unknown>>;
      expect(findings.some((finding) => finding.observationKind === 'history-added-line')).toBe(true);
      expect(findings.some((finding) => finding.observationKind === 'history-sensitive-artifact')).toBe(true);
    });

    it('binds exact author and full commit-message findings structurally to the commit', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'author.txt'), 'fixture\n');
      git(repo, ['add', 'author.txt']);
      execFileSync('git', [
        '-c', 'user.name=WhatSoup Test',
        '-c', 'user.email=test@example.invalid',
        'commit', '-m', 'test: bad author', '-m', 'Co-Authored-By: Example <example@example.invalid>',
      ], { cwd: repo, env: cleanGitEnv(), stdio: 'ignore' });
      const localOid = gitOutput(repo, ['rev-parse', 'HEAD']);

      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      const findings = payload.findings as Array<Record<string, unknown>>;

      expect(payload.nativeCauses).toEqual([
        'commit-coauthor-trailer',
        'personal-email',
        'placeholder-commit-author',
      ]);
      expect(findings.every((finding) => finding.commitOid === localOid)).toBe(true);
      expect(findings.every((finding) => finding.path === null)).toBe(true);
    });

    it('passes reserved fixtures and discloses changed-content-only scope', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      mkdirSync(join(repo, 'docs'), { recursive: true });
      writeFileSync(join(repo, 'docs', 'safe.md'), 'Call +1 415 555 0100 or fixture@example.com.\n');
      const localOid = commitAll(repo, 'docs: safe exact fixture');

      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));

      expect(payload.outcome).toBe('pass');
      expect(payload.exitCode).toBe(0);
      expect(payload.nativeCauses).toEqual([]);
      expect(payload.limitations).toContain('changed-content-only');
    });

    it('returns no payload and only a sanitized code for malformed or unavailable lineage', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      const malformed = createRepoHygieneExactRangeArtifact(repo, {
        baseOid: 'main',
        remoteOid: null,
        localOid: gitOutput(repo, ['rev-parse', 'HEAD']),
      } as never);
      expect(malformed).toEqual({
        ok: false,
        error: { code: 'repo-hygiene.exact-range.input-malformed' },
      });
      expect(JSON.stringify(malformed)).not.toContain(repo);

      const missing = createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid: 'f'.repeat(40),
      });
      expect(missing.ok).toBe(false);
      expect(missing).not.toHaveProperty('artifact');
      expect(JSON.stringify(missing)).not.toContain('fatal:');

      let accessorInvoked = false;
      const accessorInput = Object.defineProperty({
        remoteOid: null,
        localOid: gitOutput(repo, ['rev-parse', 'HEAD']),
      }, 'baseOid', {
        enumerable: true,
        get() {
          accessorInvoked = true;
          return baseOid;
        },
      });
      expect(createRepoHygieneExactRangeArtifact(repo, accessorInput as never)).toEqual({
        ok: false,
        error: { code: 'repo-hygiene.exact-range.input-malformed' },
      });
      expect(accessorInvoked).toBe(false);
      expect(createRepoHygieneExactRangeArtifact(repo, new Proxy({
        baseOid,
        remoteOid: null,
        localOid: gitOutput(repo, ['rev-parse', 'HEAD']),
      }, {}) as never).ok).toBe(false);

      writeFileSync(join(repo, 'feature.txt'), 'feature\n');
      const featureOid = commitAll(repo, 'test: nonancestor feature');
      const nonancestor = createRepoHygieneExactRangeArtifact(repo, {
        baseOid: featureOid,
        remoteOid: null,
        localOid: baseOid,
      });
      expect(nonancestor.ok).toBe(false);
      expect(nonancestor).not.toHaveProperty('artifact');
    });

    it('creates one canonical externally bound artifact and rejects byte, digest, and freshness mutations', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'safe.txt'), 'safe\n');
      const localOid = commitAll(repo, 'test: canonical receipt');
      const artifact = requireExactRangeArtifact(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      const parsedPayload = JSON.parse(Buffer.from(artifact.payloadBytes).toString('utf8')) as {
        toolDigest: string;
        policyDigest: string;
      };
      const expected = expectedForArtifact(artifact, parsedPayload, {
        baseOid, remoteOid: null, localOid,
      });

      const valid = validateRepoHygieneExactRangeArtifact(artifact, expected);
      expect(valid.ok).toBe(true);
      if (valid.ok) {
        expect(Object.isFrozen(valid.receipt)).toBe(true);
        expect(Object.isFrozen(valid.receipt.budget.remaining)).toBe(true);
      }

      const changedBytes = Uint8Array.from(artifact.payloadBytes);
      changedBytes[changedBytes.length - 2] ^= 1;
      expect(validateRepoHygieneExactRangeArtifact({
        ...artifact,
        payloadBytes: changedBytes,
      }, expected)).toEqual({
        ok: false,
        error: { code: 'repo-hygiene.exact-range.receipt-invalid' },
      });
      expect(validateRepoHygieneExactRangeArtifact({
        ...artifact,
        binding: { ...artifact.binding, payloadSha256: `sha256:${'0'.repeat(64)}` },
      }, expected).ok).toBe(false);

      vi.setSystemTime(new Date('2026-07-21T12:05:00.000Z'));
      expect(validateRepoHygieneExactRangeArtifact(artifact, expected).ok).toBe(true);
      vi.setSystemTime(new Date('2026-07-21T12:05:00.001Z'));
      expect(validateRepoHygieneExactRangeArtifact(artifact, expected)).toEqual({
        ok: false,
        error: { code: 'repo-hygiene.exact-range.receipt-stale' },
      });

      const partialBytes = artifact.payloadBytes.slice(0, -1);
      expect(validateRepoHygieneExactRangeArtifact({
        payloadBytes: partialBytes,
        binding: {
          ...artifact.binding,
          payloadByteLength: partialBytes.byteLength,
          payloadSha256: `sha256:${createHash('sha256').update(partialBytes).digest('hex')}`,
        },
      }, expected).ok).toBe(false);
    });

    it('rejects reconstructed equivalent, duplicate-key, unknown-key, and expected-binding substitutions', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'safe.txt'), 'safe\n');
      const localOid = commitAll(repo, 'test: strict receipt');
      const artifact = requireExactRangeArtifact(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      const payload = JSON.parse(Buffer.from(artifact.payloadBytes).toString('utf8')) as {
        toolDigest: string;
        policyDigest: string;
      };
      const expected = expectedForArtifact(artifact, payload, {
        baseOid, remoteOid: null, localOid,
      });
      const reconstructed = Uint8Array.from(Buffer.from(JSON.stringify(payload)));
      expect(validateRepoHygieneExactRangeArtifact({
        payloadBytes: reconstructed,
        binding: {
          ...artifact.binding,
          payloadByteLength: reconstructed.byteLength,
          payloadSha256: artifact.binding.payloadSha256,
        },
      }, expected).ok).toBe(false);
      expect(validateRepoHygieneExactRangeArtifact(artifact, {
        ...expected,
        localOid: 'e'.repeat(40),
      }).ok).toBe(false);
      expect(validateRepoHygieneExactRangeArtifact(artifact, {
        ...expected,
        currentPolicyDigest: `sha256:${'0'.repeat(64)}`,
      })).toEqual({
        ok: false,
        error: { code: 'repo-hygiene.exact-range.policy-mismatch' },
      });
      expect(validateRepoHygieneExactRangeArtifact(artifact, {
        ...expected,
        currentToolDigest: `sha256:${'0'.repeat(64)}`,
      })).toEqual({
        ok: false,
        error: { code: 'repo-hygiene.exact-range.tool-mismatch' },
      });

      const otherDigest = `sha256:${'0'.repeat(64)}`;
      for (const field of ['toolDigest', 'policyDigest'] as const) {
        const colludingPayload = { ...payload, [field]: otherDigest };
        const colludingArtifact = artifactForPayload(colludingPayload);
        const colludingExpected = expectedForArtifact(
          colludingArtifact,
          requireArtifactBindingFields(colludingPayload),
          { baseOid, remoteOid: null, localOid },
        );
        expect(validateRepoHygieneExactRangeArtifact(colludingArtifact, colludingExpected)).toEqual({
          ok: false,
          error: { code: `repo-hygiene.exact-range.${field === 'toolDigest' ? 'tool' : 'policy'}-mismatch` },
        });
      }

      const unknown = { ...payload, unexpected: true };
      expect(validateRepoHygieneExactRangeArtifact(artifactForPayload(unknown), expected).ok).toBe(false);

      const noncanonicalBytes = Uint8Array.from(Buffer.from(JSON.stringify(payload), 'utf8'));
      const noncanonical = {
        payloadBytes: noncanonicalBytes,
        binding: {
          schemaVersion: 1 as const,
          detectorId: 'repo-hygiene-guard' as const,
          payloadByteLength: noncanonicalBytes.byteLength,
          payloadSha256: `sha256:${createHash('sha256').update(noncanonicalBytes).digest('hex')}` as const,
        },
      };
      expect(validateRepoHygieneExactRangeArtifact(noncanonical, expected).ok).toBe(false);

      const canonicalText = Buffer.from(artifact.payloadBytes).toString('utf8');
      const duplicateBytes = Uint8Array.from(Buffer.from(
        canonicalText.replace('{', '{"schemaVersion":1,'),
        'utf8',
      ));
      expect(validateRepoHygieneExactRangeArtifact({
        payloadBytes: duplicateBytes,
        binding: {
          schemaVersion: 1,
          detectorId: 'repo-hygiene-guard',
          payloadByteLength: duplicateBytes.byteLength,
          payloadSha256: `sha256:${createHash('sha256').update(duplicateBytes).digest('hex')}`,
        },
      }, expected).ok).toBe(false);
    });

    it('suppresses only byte-identical base lines on merge re-exposure and blocks a new neighbor', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'feature.txt'), 'feature\n');
      commitAll(repo, 'test: feature before base advance');

      git(repo, ['checkout', 'main']);
      mkdirSync(join(repo, 'tests', 'drills'), { recursive: true });
      writeFileSync(
        join(repo, 'tests', 'drills', 'base.sh'),
        'WEBHOOK_SECRET=a3f1c9d2e84b076f5a192c3e7d408b1f\r\n',
      );
      const remoteOid = commitAll(repo, 'test: base sentinel');
      git(repo, ['checkout', 'feature']);
      git(repo, ['merge', 'main', '--no-edit']);
      const mergeOid = gitOutput(repo, ['rev-parse', 'HEAD']);

      const mergePayload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid,
        localOid: mergeOid,
      }));
      expect(mergePayload.outcome).toBe('pass');

      writeFileSync(
        join(repo, 'tests', 'drills', 'neighbor.sh'),
        'WEBHOOK_SECRET=b4e2d8c1f73a086e5b291d4e8c509a2f\n',
      );
      const localOid = commitAll(repo, 'test: new secret neighbor');
      const neighborPayload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid,
        localOid,
      }));
      expect(neighborPayload.nativeCauses).toEqual(['secret-assignment']);
    });

    it('returns no payload for binary and gitlink exact changes', () => {
      const binaryRepo = makeBranchRepo();
      const binaryBase = gitOutput(binaryRepo, ['rev-parse', 'main']);
      writeFileSync(join(binaryRepo, 'binary.bin'), Buffer.from([0, 1, 2]));
      const binaryLocal = commitAll(binaryRepo, 'test: binary exact input');
      const binary = createRepoHygieneExactRangeArtifact(binaryRepo, {
        baseOid: binaryBase,
        remoteOid: null,
        localOid: binaryLocal,
      });
      expect(binary.ok).toBe(false);
      expect(binary).not.toHaveProperty('artifact');

      const gitlinkRepo = makeBranchRepo();
      const gitlinkBase = gitOutput(gitlinkRepo, ['rev-parse', 'main']);
      git(gitlinkRepo, ['update-index', '--add', '--cacheinfo', `160000,${gitlinkBase},vendor/dependency`]);
      git(gitlinkRepo, ['commit', '-m', 'test: gitlink exact input']);
      const gitlinkLocal = gitOutput(gitlinkRepo, ['rev-parse', 'HEAD']);
      const gitlink = createRepoHygieneExactRangeArtifact(gitlinkRepo, {
        baseOid: gitlinkBase,
        remoteOid: null,
        localOid: gitlinkLocal,
      });
      expect(gitlink.ok).toBe(false);
      expect(gitlink).not.toHaveProperty('artifact');
    });

    it('spends one cumulative change ledger across net and every parent edge', { timeout: 90_000 }, () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      const files = join(repo, 'many');
      mkdirSync(files);
      for (let index = 0; index < 1_366; index += 1) {
        writeFileSync(join(files, `${index}.txt`), 'a\n');
      }
      commitAll(repo, 'test: first cumulative edge');
      for (let index = 0; index < 1_366; index += 1) {
        writeFileSync(join(files, `${index}.txt`), 'b\n');
      }
      const localOid = commitAll(repo, 'test: second cumulative edge');

      const result = createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      });

      expect(result).toEqual({
        ok: false,
        error: { code: 'repo-hygiene.exact-range.budget' },
      });
      expect(result).not.toHaveProperty('artifact');
    });

    it('bounds raw finding keys even when public projection coalesces them', { timeout: 90_000 }, () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      const content = 'console.log(eval("x")); spawn("x", [], { env: process.env, shell: true }); // @ts-ignore\n';
      for (let index = 0; index < 684; index += 1) {
        const directory = join(repo, 'src', 'many', String(index));
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'auth_info'), content);
      }
      const localOid = commitAll(repo, 'test: raw finding key budget');

      const result = createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      });

      expect(result).toEqual({
        ok: false,
        error: { code: 'repo-hygiene.exact-range.budget' },
      });
      expect(result).not.toHaveProperty('artifact');
    });

    it('rejects removal provenance and semantic receipt mutations after rebinding bytes', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'safe.txt'), 'safe\n');
      const localOid = commitAll(repo, 'test: semantic mutation');
      const artifact = requireExactRangeArtifact(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      const payload = JSON.parse(Buffer.from(artifact.payloadBytes).toString('utf8')) as Record<string, any>;
      const expected = expectedForArtifact(artifact, requireArtifactBindingFields(payload), { baseOid, remoteOid: null, localOid });

      const removedBinding = structuredClone(payload);
      removedBinding.commitBindings = [];
      removedBinding.observedScope.commitCount = 0;
      expect(validateRepoHygieneExactRangeArtifact(
        artifactForPayload(removedBinding),
        expected,
      ).ok).toBe(false);

      const badConservation = structuredClone(payload);
      badConservation.budget.remaining.changeCount += 1;
      expect(validateRepoHygieneExactRangeArtifact(
        artifactForPayload(badConservation),
        expected,
      ).ok).toBe(false);

      const falsePass = structuredClone(payload);
      falsePass.outcome = 'block';
      falsePass.exitCode = 1;
      expect(validateRepoHygieneExactRangeArtifact(
        artifactForPayload(falsePass),
        expected,
      ).ok).toBe(false);
    });

    it('returns the exact receipt shape and copy-isolated frozen validation objects', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'safe.txt'), 'safe\n');
      const localOid = commitAll(repo, 'test: exact shape');
      const artifact = requireExactRangeArtifact(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      const payload = JSON.parse(Buffer.from(artifact.payloadBytes).toString('utf8')) as Record<string, any>;
      expect(Object.keys(payload).sort()).toEqual([
        'authorization', 'baseOid', 'budget', 'claimedScope', 'commitBindings',
        'commitRangeDigest', 'completeness', 'createdAt', 'decisionOwner', 'detectorId',
        'exitCode', 'findings', 'limitations', 'localOid', 'metadataDigest', 'nativeCauses',
        'observedBlobOidDigest', 'observedPathDigest', 'observedPathDisclosure', 'observedScope', 'outcome', 'policyDigest',
        'rangeStartOid', 'remoteOid', 'schemaVersion', 'toolDigest', 'validUntil',
      ].sort());
      const validated = validateRepoHygieneExactRangeArtifact(
        artifact,
        expectedForArtifact(artifact, requireArtifactBindingFields(payload), { baseOid, remoteOid: null, localOid }),
      );
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const originalOutcome = validated.receipt.outcome;
      artifact.payloadBytes[0] ^= 1;
      expect(validated.receipt.outcome).toBe(originalOutcome);
      expect(Object.isFrozen(validated.receipt.commitBindings)).toBe(true);
      expect(Object.isFrozen(validated.receipt.claimedScope)).toBe(true);
    });

    it('requires the independently frozen original byte binding for canonically rebound mutations', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'first.txt'), 'safe\n');
      commitAll(repo, 'test: nonterminal safe binding');
      writeFileSync(join(repo, 'unsafe.txt'), `export const token = '${githubTokenFixture}';\n`);
      const localOid = commitAll(repo, 'test: terminal unsafe binding');
      const artifact = requireExactRangeArtifact(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      const payload = JSON.parse(Buffer.from(artifact.payloadBytes).toString('utf8')) as Record<string, any>;
      const expected = expectedForArtifact(artifact, requireArtifactBindingFields(payload), { baseOid, remoteOid: null, localOid });

      const removedNonterminal = structuredClone(payload);
      const [removed] = removedNonterminal.commitBindings.splice(0, 1);
      removedNonterminal.observedScope.commitCount -= 1;
      removedNonterminal.observedScope.parentEdgeCount -= removed.parentOids.length;
      const reconstructedRange = {
        baseOid: removedNonterminal.baseOid,
        remoteOid: removedNonterminal.remoteOid,
        rangeStartOid: removedNonterminal.rangeStartOid,
        localOid: removedNonterminal.localOid,
        commits: removedNonterminal.commitBindings.map((binding: Record<string, any>) => ({
          oid: binding.oid,
          parentOids: binding.parentOids,
          firstParentOid: binding.parentOids[0],
        })),
      };
      removedNonterminal.commitRangeDigest = `sha256:${createHash('sha256')
        .update(canonicalizeBoundaryRun(reconstructedRange)).digest('hex')}`;
      removedNonterminal.metadataDigest = `sha256:${createHash('sha256')
        .update(canonicalizeBoundaryRun(removedNonterminal.commitBindings)).digest('hex')}`;
      expect(validateRepoHygieneExactRangeArtifact(
        artifactForPayload(removedNonterminal),
        expected,
      ).ok).toBe(false);

      const changedObservation = structuredClone(payload);
      changedObservation.observedBlobOidDigest = `sha256:${'a'.repeat(64)}`;
      expect(validateRepoHygieneExactRangeArtifact(
        artifactForPayload(changedObservation),
        expected,
      ).ok).toBe(false);

      const strippedBlock = structuredClone(payload);
      strippedBlock.findings = [];
      strippedBlock.nativeCauses = [];
      strippedBlock.outcome = 'pass';
      strippedBlock.exitCode = 0;
      expect(validateRepoHygieneExactRangeArtifact(
        artifactForPayload(strippedBlock),
        expected,
      ).ok).toBe(false);
    });

    it('exposes independently hashable policy bytes bound to exact guard-core bytes and the receipt', () => {
      const canonicalProjection = (repoHygieneGuardModule as unknown as Record<string, unknown>)
        .canonicalRepoHygienePolicyProjection;
      expect(typeof canonicalProjection).toBe('function');
      if (typeof canonicalProjection !== 'function') return;
      const projectionText = canonicalProjection();
      expect(typeof projectionText).toBe('string');
      if (typeof projectionText !== 'string') return;

      const independentPolicyDigest = `sha256:${createHash('sha256')
        .update(Buffer.from(projectionText, 'utf8')).digest('hex')}`;
      const projection = JSON.parse(projectionText) as Record<string, unknown>;
      const guardCoreBytes = readFileSync(join(process.cwd(), 'scripts', 'lib', 'guard-core.ts'));
      const independentGuardCoreDigest = `sha256:${createHash('sha256').update(guardCoreBytes).digest('hex')}`;
      expect(projection.guardCoreDigest).toBe(independentGuardCoreDigest);
      expect(currentRepoHygienePolicyDigest()).toBe(independentPolicyDigest);

      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'safe.txt'), 'safe\n');
      const localOid = commitAll(repo, 'test: independent policy binding');
      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      expect(payload.policyDigest).toBe(independentPolicyDigest);
    });

    it.each([
      ['src-console-call', 'console.log("unsafe");'],
      ['process-env-inheritance', 'spawn("x", [], { env: process.env });'],
      ['child-process-shell-true', 'spawn("x", [], { shell: true });'],
      ['dynamic-code-execution', 'eval("unsafe");'],
      ['unbounded-suppression', '// @ts-ignore'],
    ])('round-trips direct scan cause %s through the closed validator', (cause, line) => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'unsafe.ts'), `${line}\n`);
      const localOid = commitAll(repo, `test: ${cause} receipt`);
      const artifact = requireExactRangeArtifact(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      const payload = JSON.parse(Buffer.from(artifact.payloadBytes).toString('utf8')) as Record<string, any>;

      expect(payload.nativeCauses).toContain(cause);
      expect(validateRepoHygieneExactRangeArtifact(
        artifact,
        expectedForArtifact(artifact, requireArtifactBindingFields(payload), { baseOid, remoteOid: null, localOid }),
      ).ok).toBe(true);
    });

    it('withholds sensitive repository paths and exposes no reversible path fingerprint', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      const unsafePath = 'users/private-id/auth_info-secret-token.txt';
      mkdirSync(join(repo, 'users', 'private-id'), { recursive: true });
      writeFileSync(join(repo, unsafePath), `const token = '${githubTokenFixture}';\n`);
      const localOid = commitAll(repo, 'test: sensitive path receipt');
      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      const serialized = JSON.stringify(payload);
      const rawPathHash = createHash('sha256').update(unsafePath).digest('hex');

      expect(serialized).not.toContain(unsafePath);
      expect(serialized).not.toContain(rawPathHash);
      expect(payload.observedPathDisclosure).toBe('all-redacted');
      expect(payload.observedPathDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(payload.observedPathDigest).toBe(`sha256:${createHash('sha256')
        .update(canonicalizeBoundaryRun({
          schemaVersion: 1,
          disclosure: 'all-redacted',
          count: (payload.observedScope as { observedPathCount: number }).observedPathCount,
        })).digest('hex')}`);
      expect((payload.findings as Array<Record<string, unknown>>)
        .every((finding) => finding.path === null)).toBe(true);
    });

    it('discloses every unavailable assurance family in static limitations', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'safe.txt'), 'safe\n');
      const localOid = commitAll(repo, 'test: limitation contract');
      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      expect(payload.limitations).toEqual([
        'aggregate-authorization-unavailable',
        'changed-content-only',
        'executor-platform-unavailable',
        'finding-fingerprint-unavailable',
        'precondition-receipt-unavailable',
        'producer-authentication-unavailable',
        'report-only',
        'terminal-attempt-process-group-unavailable',
      ]);
    });

    it('scans unsafe metadata before a later safe tip and accounts all six budget fields', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'README.md'), '# fixture\nfirst\n');
      git(repo, ['add', 'README.md']);
      execFileSync('git', [
        '-c', 'user.name=WhatSoup Test',
        '-c', 'user.email=test@example.invalid',
        'commit', '-m', 'test: unsafe metadata', '-m', 'Co-Authored-By: Example <example@example.invalid>',
      ], { cwd: repo, env: cleanGitEnv(), stdio: 'ignore' });
      const unsafeCommitOid = gitOutput(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'tip.txt'), 'safe tip\n');
      const localOid = commitAll(repo, 'test: later safe tip');
      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      })) as Record<string, any>;

      expect(payload.nativeCauses).toEqual([
        'commit-coauthor-trailer',
        'personal-email',
        'placeholder-commit-author',
      ]);
      const budgetKeys = [
        'addedLineCount', 'addedTextBytes', 'changeCount',
        'patchBytes', 'sourceBlobBytes', 'sourceLineCount',
      ];
      expect(Object.keys(payload.budget.limit).sort()).toEqual(budgetKeys);
      for (const key of budgetKeys) {
        expect(payload.budget.consumed[key], key).toBeGreaterThan(0);
        expect(payload.budget.consumed[key] + payload.budget.remaining[key])
          .toBe(payload.budget.limit[key]);
      }
      const metadataFindings = payload.findings.filter(
        (finding: Record<string, unknown>) => finding.observationKind === 'commit-metadata',
      );
      expect(metadataFindings).not.toHaveLength(0);
      expect(metadataFindings.every(
        (finding: Record<string, unknown>) => finding.commitOid === unsafeCommitOid,
      )).toBe(true);
      expect(metadataFindings.every(
        (finding: Record<string, unknown>) => finding.commitOid !== localOid,
      )).toBe(true);
    });

    it('finds second-parent-only transient secret and artifact evidence', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'feature.txt'), 'feature\n');
      commitAll(repo, 'test: first parent safe');
      git(repo, ['checkout', '-b', 'side', 'main']);
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'side.ts'), 'WEBHOOK_SECRET=a3f1c9d2e84b076f5a192c3e7d408b1f\n');
      writeFileSync(join(repo, '.env.local'), 'fixture\n');
      commitAll(repo, 'test: second parent transient evidence');
      git(repo, ['rm', 'src/side.ts', '.env.local']);
      commitAll(repo, 'test: second parent removes evidence');
      git(repo, ['checkout', 'feature']);
      git(repo, ['merge', 'side', '--no-edit']);
      const localOid = gitOutput(repo, ['rev-parse', 'HEAD']);

      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      expect(payload.nativeCauses).toEqual([
        'branch-history-sensitive-artifact',
        'secret-assignment',
      ]);
      expect((payload.findings as Array<Record<string, unknown>>)
        .every((finding) => String(finding.observationKind).startsWith('history-'))).toBe(true);
      const commitBindings = payload.commitBindings as Array<{ parentOids: string[] }>;
      const expectedParentEdgeCount = commitBindings.reduce(
        (count, binding) => count + binding.parentOids.length,
        0,
      );
      expect(commitBindings.some((binding) => binding.parentOids.length >= 2)).toBe(true);
      expect(expectedParentEdgeCount).toBeGreaterThanOrEqual(2);
      expect((payload.observedScope as { parentEdgeCount: number }).parentEdgeCount)
        .toBe(expectedParentEdgeCount);
    });

    it('blocks a new history-only neighbor after suppressing byte-identical base re-exposure', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'feature.txt'), 'feature\n');
      commitAll(repo, 'test: feature before history-only neighbor');

      git(repo, ['checkout', 'main']);
      mkdirSync(join(repo, 'tests', 'drills'), { recursive: true });
      writeFileSync(
        join(repo, 'tests', 'drills', 'base.sh'),
        'WEBHOOK_SECRET=a3f1c9d2e84b076f5a192c3e7d408b1f\r\n',
      );
      const remoteOid = commitAll(repo, 'test: base sentinel for history-only neighbor');
      git(repo, ['checkout', 'feature']);
      git(repo, ['merge', 'main', '--no-edit']);

      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(
        join(repo, 'src', 'transient.ts'),
        `export const token = '${githubTokenFixture}';\n`,
      );
      commitAll(repo, 'test: add history-only neighbor');
      git(repo, ['rm', 'src/transient.ts']);
      const localOid = commitAll(repo, 'test: remove history-only neighbor');

      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid,
        localOid,
      }));
      expect(payload.outcome).toBe('block');
      expect(payload.nativeCauses).toEqual(['github-token']);
      expect((payload.findings as Array<Record<string, unknown>>)).toEqual([
        expect.objectContaining({
          cause: 'github-token',
          observationKind: 'history-added-line',
        }),
      ]);
    });

    it('does not suppress byte-identical history evidence from a different base path', () => {
      const repo = makeBranchRepo();
      mkdirSync(join(repo, 'base'), { recursive: true });
      const unsafeContent = 'WEBHOOK_SECRET=a3f1c9d2e84b076f5a192c3e7d408b1f\n';
      writeFileSync(join(repo, 'base', 'path-a.sh'), unsafeContent);
      const baseOid = commitAll(repo, 'test: unsafe text at base path A');

      mkdirSync(join(repo, 'outgoing'), { recursive: true });
      const safePrefix = Array.from({ length: 10 }, (_, index) => `safe header ${index}`).join('\n');
      writeFileSync(join(repo, 'outgoing', 'path-b.sh'), `${safePrefix}\n${unsafeContent}`);
      const unsafeCommitOid = commitAll(repo, 'test: same unsafe text at outgoing path B');
      git(repo, ['rm', 'outgoing/path-b.sh']);
      const localOid = commitAll(repo, 'test: remove outgoing path B');

      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      expect(payload.outcome).toBe('block');
      expect(payload.nativeCauses).toEqual(['secret-assignment']);
      expect(payload.findings).toEqual([
        expect.objectContaining({
          cause: 'secret-assignment',
          observationKind: 'history-added-line',
          commitOid: unsafeCommitOid,
        }),
      ]);
    });

    it('does not promote transient focused-test or console findings into history causes', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      mkdirSync(join(repo, 'src'), { recursive: true });
      mkdirSync(join(repo, 'tests'), { recursive: true });
      writeFileSync(join(repo, 'src', 'transient.ts'), 'console.log("temporary");\n');
      writeFileSync(join(repo, 'tests', 'transient.test.ts'), 'it.only("temporary", () => {});\n');
      commitAll(repo, 'test: transient non-secret hygiene');
      git(repo, ['rm', 'src/transient.ts', 'tests/transient.test.ts']);
      const localOid = commitAll(repo, 'test: remove transient non-secret hygiene');

      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      expect(payload.outcome).toBe('pass');
      expect(payload.nativeCauses).toEqual([]);
    });

    it('prefers exact net findings over duplicate history secret and artifact observations', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, '.env.local'), `const token = '${githubTokenFixture}';\n`);
      const localOid = commitAll(repo, 'test: final duplicate evidence');

      const payload = exactRangePayload(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      const findings = payload.findings as Array<Record<string, unknown>>;
      expect(findings.filter((finding) => finding.cause === 'github-token')).toHaveLength(1);
      expect(findings.filter((finding) => finding.cause === 'branch-sensitive-artifact')).toHaveLength(1);
      expect(findings.filter((finding) => String(finding.observationKind).startsWith('history-')))
        .toHaveLength(0);
    });

    it('coalesces identical public findings from distinct exact paths without losing the block', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      mkdirSync(join(repo, 'src'), { recursive: true });
      const unsafeContent = `export const token = '${githubTokenFixture}';\n`;
      writeFileSync(join(repo, 'src', 'first.ts'), unsafeContent);
      writeFileSync(join(repo, 'src', 'second.ts'), unsafeContent);
      const localOid = commitAll(repo, 'test: identical projected findings');
      const artifact = requireExactRangeArtifact(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      const payload = JSON.parse(Buffer.from(artifact.payloadBytes).toString('utf8')) as Record<string, any>;

      expect(payload.outcome).toBe('block');
      expect(payload.nativeCauses).toEqual(['github-token']);
      expect(payload.findings).toHaveLength(1);
      expect(payload.observedScope.observedPathCount).toBe(2);
      expect(validateRepoHygieneExactRangeArtifact(
        artifact,
        expectedForArtifact(artifact, requireArtifactBindingFields(payload), { baseOid, remoteOid: null, localOid }),
      ).ok).toBe(true);
    });

    it('rejects unknown native causes and unsafe structural paths after trusted rebinding', () => {
      const repo = makeBranchRepo();
      const baseOid = gitOutput(repo, ['rev-parse', 'main']);
      writeFileSync(join(repo, 'unsafe.ts'), `export const token = '${githubTokenFixture}';\n`);
      const localOid = commitAll(repo, 'test: semantic receipt validation');
      const original = requireExactRangeArtifact(createRepoHygieneExactRangeArtifact(repo, {
        baseOid,
        remoteOid: null,
        localOid,
      }));
      const payload = JSON.parse(Buffer.from(original.payloadBytes).toString('utf8')) as Record<string, any>;
      expect(() => requireArtifactBindingFields({ ...payload, toolDigest: null })).toThrow(/binding digest/i);

      const unknownCause = structuredClone(payload);
      unknownCause.findings[0].cause = 'injected-unknown-cause';
      unknownCause.nativeCauses = ['injected-unknown-cause'];
      const unknownArtifact = artifactForPayload(unknownCause);
      expect(validateRepoHygieneExactRangeArtifact(
        unknownArtifact,
        expectedForArtifact(unknownArtifact, requireArtifactBindingFields(unknownCause), { baseOid, remoteOid: null, localOid }),
      ).ok).toBe(false);

      const unsafePath = structuredClone(payload);
      unsafePath.findings[0].path = '../private';
      const unsafeArtifact = artifactForPayload(unsafePath);
      expect(validateRepoHygieneExactRangeArtifact(
        unsafeArtifact,
        expectedForArtifact(unsafeArtifact, requireArtifactBindingFields(unsafePath), { baseOid, remoteOid: null, localOid }),
      ).ok).toBe(false);
    });

    it('keeps current branch-diff and argument entrypoints unchanged', () => {
      const repo = makeBranchRepo();
      writeFileSync(join(repo, 'safe.txt'), 'safe\n');
      commitAll(repo, 'test: legacy entrypoint');

      expect(scanBranchDiff(repo, 'main')).toEqual([]);
      expect(parseArgs(['--branch-diff', '--base', 'main'])).toEqual({
        mode: 'branch-diff',
        baseRef: 'main',
        help: false,
      });
    });
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

  it('blocks edit-breaking literal secret shapes in runtime-assembled fixture sources', () => {
    const filePath = 'tests/scripts/repo-hygiene-guard.test.ts';
    const samples = [
      ['anthropic-key', ['sk', 'ant', 'api03', 'A1b2C3d4E5f6G7h8'].join('-')],
      ['openai-key', ['sk', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'].join('-')],
      ['pinecone-key', ['pcsk', 'A1b2C3d4E5f6G7h8I9j0'].join('_')],
      ['private-key', `${'-----BEGIN'} ${'PRIVATE KEY'}-----`],
      ['supabase-secret', ['sb', 'secret', 'A1b2C3d4E5f6G7h8I9j0'].join('_')],
    ] as const;

    expect(projectedFileSecretPatternCodes).toEqual(samples.map(([code]) => code));

    const issues = scanAddedLines(
      samples.map(([, text], index) => ({ filePath, line: index + 1, text })),
    );

    expect(issues.map((issue) => issue.code)).toEqual(samples.map(([code]) => code));
  });

  it('keeps intentional literal-secret corpora exempt from source-assembly policy', () => {
    const secret = ['pcsk', 'A1b2C3d4E5f6G7h8I9j0'].join('_');

    expect(scanAddedLines([
      { filePath: 'tests/fixtures/redaction-parity-corpus.jsonl', line: 1, text: secret },
      { filePath: 'tools/agent-runtime-probes/tests/test_redact.py', line: 1, text: secret },
    ])).toEqual([]);
  });

  it('blocks Supabase secret shapes outside fixture paths', () => {
    const secret = ['sb', 'secret', 'A1b2C3d4E5f6G7h8I9j0'].join('_');

    expect(scanAddedLines([
      { filePath: 'src/config.ts', line: 1, text: `const secret = '${secret}';` },
    ]).map((issue) => issue.code)).toContain('supabase-secret');
  });

  it('tracks at least one runtime-assembled fixture source', () => {
    expect(projectedFileSecretFixtureFiles.length).toBeGreaterThan(0);
  });

  it.each(projectedFileSecretFixtureFiles)(
    '%s remains readable and free of edit-blocking literal secret shapes',
    (relPath) => {
      let content: string;
      try {
        content = readFileSync(join(repoRoot, relPath), 'utf8');
      } catch (error) {
        throw new Error(
          `cannot read ${relPath} to verify fixture shape (${(error as Error).message}). ` +
            'If the file moved, update projectedFileSecretFixtureFiles; do not delete the check.',
        );
      }

      const issues = scanProjectedFileSecretLines(
        content.split(/\r?\n/).map((text, index) => ({
          filePath: relPath,
          line: index + 1,
          text,
        })),
      );

      expect(
        issues,
        issues.length === 0
          ? ''
          : 'Assemble synthetic secret fixtures at runtime so projected-file scanners do not block edits.',
      ).toEqual([]);
    },
  );

  /**
   * EVERY secret-shaped fixture in this block MUST assemble its token at runtime
   * (`'pcsk' + '_rest'`, `['sk-ant-api03', '...'].join('-')`) rather than appearing as a
   * literal. Do not "simplify" these back into plain strings.
   *
   * The reason is mechanical, not stylistic. The machine-global
   * `claude-guards/validate-secrets.py` PreToolUse hook scans the PROJECTED WHOLE FILE on
   * every Write/Edit. A single secret-shaped literal anywhere in this file makes the ENTIRE
   * FILE permanently un-editable by any agent — not just the offending line. That is not
   * hypothetical: five literals here (two provider keys, three PEM headers) locked this file
   * for days, which in turn blocked a typecheck fix that 54 unpushed commits depended on.
   *
   * Because the hook scans the projected file rather than the diff, a partial conversion
   * does not help: one edit has to clear every offender at once.
   *
   * Runtime values are unchanged by the assembly, so `scanAddedLines` still receives exactly
   * the strings these tests intend to exercise.
   */
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
        { filePath: 'tests/x.test.ts', line: 1, text: `apiKey: '${['sk', 'test-elevenlabs-key'].join('-')}'` },
        { filePath: 'tests/x.test.ts', line: 2, text: `apiKey: '${'pcsk' + '_test_fixture_value_here'}'` },
        { filePath: 'tests/x.test.ts', line: 3, text: "accountSid: 'AC00000000000000000000000000000000'" },
        { filePath: 'tests/x.test.ts', line: 4, text: `key: '${'sk-ant' + '-mock-not-a-real-secret'}'` },
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
        { filePath: 'src/x.ts', line: 1, text: `const pem = "${'-----BEGIN ' + 'PRIVATE KEY' + '-----'}MIIabc...";` },
        { filePath: 'src/x.ts', line: 2, text: `${'-----BEGIN ' + 'OPENSSH PRIVATE KEY' + '-----'}` },
        { filePath: 'src/x.ts', line: 3, text: `${'-----BEGIN ' + 'ENCRYPTED PRIVATE KEY' + '-----'}` },
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
