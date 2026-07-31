import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import { runPrMetadataGuard } from '../../scripts/pr-metadata-guard.ts';

const repos: string[] = [];
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRangeRepo(candidateMessage = 'candidate'): { repo: string; baseOid: string; headOid: string } {
  const repo = mkdtempSync(path.join(tmpdir(), 'pr-metadata-guard-'));
  repos.push(repo);

  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'guard-test@users.noreply.github.com']);
  git(repo, ['config', 'user.name', 'Guard Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repo, 'note.txt'), 'base\n');
  git(repo, ['add', 'note.txt']);
  git(repo, ['commit', '-m', 'base']);
  const baseOid = git(repo, ['rev-parse', 'HEAD']);

  writeFileSync(path.join(repo, 'note.txt'), 'candidate\n');
  git(repo, ['add', 'note.txt']);
  git(repo, ['commit', '-m', candidateMessage]);
  return { repo, baseOid, headOid: git(repo, ['rev-parse', 'HEAD']) };
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe('PR metadata guard', () => {
  it('rejects the #2391 historical negated closing phrase outside the declared directive section', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();

    const result = runPrMetadataGuard(
      [
        '--stdin',
        '--base', baseOid,
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
      'This change does not close #2391.\n',
    );

    expect(result).toMatchObject({ exitCode: 1, receipt: { decision: 'fail' } });
    expect(result.receipt).toMatchObject({
      decision: 'fail',
      findings: [
        {
          code: 'pr-metadata.closing-directive-outside-section',
          issueNumbers: [2391],
        },
      ],
    });
  });

  it('accepts a canonical directive only inside the declared directive section', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();

    const result = runPrMetadataGuard(
      [
        '--stdin',
        '--base', baseOid,
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
      [
        '<!-- whatsoup:closing-directives:start -->',
        'Fixes #123',
        '<!-- whatsoup:closing-directives:end -->',
        '',
      ].join('\n'),
    );

    expect(result.exitCode).toBe(0);
    expect(result.receipt).toMatchObject({
      decision: 'pass',
      intentionalIssueNumbers: [123],
      findings: [],
    });
  });

  it('rejects every supported closing-keyword spelling outside the declared directive section', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const cases = [
      { body: 'close #101\n', issue: 101 },
      { body: 'CLOSES: #102\n', issue: 102 },
      { body: 'closed owner/repo#103\n', issue: 103 },
      { body: 'fix #104\n', issue: 104 },
      { body: 'FIXES: owner/repo#105\n', issue: 105 },
      { body: 'fixed #106\n', issue: 106 },
      { body: 'resolve #107\n', issue: 107 },
      { body: 'RESOLVES: owner/repo#108\n', issue: 108 },
      { body: 'resolved #109\n', issue: 109 },
    ];

    for (const entry of cases) {
      const result = runPrMetadataGuard(
        [
          '--stdin',
          '--base', baseOid,
          '--head', headOid,
          '--target', 'main',
          '--default-branch', 'main',
        ],
        repo,
        entry.body,
      );

      expect(result.exitCode).toBe(1);
      expect(result.receipt.findings).toContainEqual({
        code: 'pr-metadata.closing-directive-outside-section',
        issueNumbers: [entry.issue],
      });
    }
  });

  it('rejects disclaimer-shaped closing prose across Markdown and line breaks', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const cases = [
      { body: "This change doesn't fix #136.\n", issues: [136] },
      { body: 'This change does not, despite its title, resolve #137.\n', issues: [137] },
      { body: '**Fixes #138** is intentionally not a closure.\n', issues: [138] },
      { body: '`Fixes #139` is an example, not an instruction.\n', issues: [139] },
      { body: 'This change must not fix\n#140.\n', issues: [140] },
      { body: 'This change is not intended to resolve owner/repo#141.\n', issues: [141] },
      { body: 'This does not fix #142 or resolve owner/repo#143.\n', issues: [142, 143] },
    ];

    for (const entry of cases) {
      const result = runPrMetadataGuard(
        [
          '--stdin',
          '--base', baseOid,
          '--head', headOid,
          '--target', 'main',
          '--default-branch', 'main',
        ],
        repo,
        entry.body,
      );

      expect(result).toMatchObject({ exitCode: 1, receipt: { decision: 'fail' } });
      expect(result.receipt.findings).toContainEqual({
        code: 'pr-metadata.closing-directive-outside-section',
        issueNumbers: entry.issues,
      });
    }
  });

  it('allows neutral references that cannot instruct GitHub to close an issue', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const result = runPrMetadataGuard(
      [
        '--stdin',
        '--base', baseOid,
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
      'Refs #120. https://github.com/owner/repo/issues/121. The broader issue remains open.\n',
    );

    expect(result.exitCode).toBe(0);
    expect(result.receipt).toMatchObject({ decision: 'pass', findings: [] });
  });

  it('rejects malformed directive sections instead of overlooking their content', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const result = runPrMetadataGuard(
      [
        '--stdin',
        '--base', baseOid,
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
      [
        '<!-- whatsoup:closing-directives:start -->',
        'This change should not fix #122.',
        '<!-- whatsoup:closing-directives:end -->',
        '',
      ].join('\n'),
    );

    expect(result.exitCode).toBe(1);
    expect(result.receipt.findings).toContainEqual({
      code: 'pr-metadata.invalid-directive-section',
      issueNumbers: [122],
    });
  });

  it('warns for a complete non-default target instead of silently passing the hazard', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const result = runPrMetadataGuard(
      [
        '--stdin',
        '--base', baseOid,
        '--head', headOid,
        '--target', 'release-candidate',
        '--default-branch', 'main',
      ],
      repo,
      'This does not resolve #130.\n',
    );

    expect(result.exitCode).toBe(0);
    expect(result.receipt).toMatchObject({
      decision: 'warn',
      warnings: ['pr-metadata.nondefault-target'],
      findings: [
        {
          code: 'pr-metadata.closing-directive-outside-section',
          issueNumbers: [130],
        },
      ],
    });
  });

  it('warns for a complete clean non-default target', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const result = runPrMetadataGuard(
      [
        '--stdin',
        '--base', baseOid,
        '--head', headOid,
        '--target', 'release-candidate',
        '--default-branch', 'main',
      ],
      repo,
      'Refs #130.\n',
    );

    expect(result).toMatchObject({
      exitCode: 0,
      receipt: {
        decision: 'warn',
        warnings: ['pr-metadata.nondefault-target'],
        findings: [],
      },
    });
  });

  it('treats symbolic commit inputs as inconclusive instead of scanning an implicit range', () => {
    const { repo, headOid } = makeRangeRepo();
    const result = runPrMetadataGuard(
      [
        '--stdin',
        '--base', 'HEAD',
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
      'Refs #131.\n',
    );

    expect(result).toMatchObject({
      exitCode: 2,
      receipt: {
        decision: 'inconclusive',
        errors: ['pr-metadata.revision-invalid'],
      },
    });
  });

  it('reads a complete pull-request event payload without querying GitHub', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const eventPath = path.join(repo, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({
        number: 77,
        repository: { default_branch: 'main' },
        pull_request: {
          body: [
            '<!-- whatsoup:closing-directives:start -->',
            'Closes owner/repo#132',
            '<!-- whatsoup:closing-directives:end -->',
            '',
          ].join('\n'),
          base: { ref: 'main', sha: baseOid },
          head: { sha: headOid },
        },
      }),
      'utf8',
    );

    const result = runPrMetadataGuard(['--github-event', eventPath], repo);

    expect(result).toMatchObject({
      exitCode: 0,
      receipt: {
        decision: 'pass',
        pullRequestNumber: 77,
        intentionalIssueNumbers: [132],
        findings: [],
      },
    });
  });

  it('reads the same directive policy from a local body file', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const bodyPath = path.join(repo, 'body.md');
    writeFileSync(
      bodyPath,
      [
        '<!-- whatsoup:closing-directives:start -->',
        'Resolves #133',
        '<!-- whatsoup:closing-directives:end -->',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runPrMetadataGuard(
      [
        '--body-file', bodyPath,
        '--base', baseOid,
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
    );

    expect(result).toMatchObject({
      exitCode: 0,
      receipt: {
        decision: 'pass',
        intentionalIssueNumbers: [133],
        findings: [],
      },
    });
  });

  it('rejects closing-keyword prose in the exact candidate commit range', () => {
    const { repo, baseOid, headOid } = makeRangeRepo('This change does not fix #134');
    const result = runPrMetadataGuard(
      [
        '--stdin',
        '--base', baseOid,
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
      'Refs #134.\n',
    );

    expect(result).toMatchObject({ exitCode: 1, receipt: { decision: 'fail' } });
    expect(result.receipt.findings).toContainEqual({
      code: 'pr-metadata.commit-closing-directive',
      issueNumbers: [134],
    });
  });

  it('fails closed for unreadable or malformed pull-request event metadata', () => {
    const { repo } = makeRangeRepo();
    const malformedEventPath = path.join(repo, 'malformed-event.json');
    writeFileSync(malformedEventPath, '{', 'utf8');

    const unavailable = runPrMetadataGuard(['--github-event', path.join(repo, 'missing-event.json')], repo);
    const malformed = runPrMetadataGuard(['--github-event', malformedEventPath], repo);

    expect(unavailable).toMatchObject({
      exitCode: 2,
      receipt: { decision: 'inconclusive', errors: ['pr-metadata.event-unavailable'] },
    });
    expect(malformed).toMatchObject({
      exitCode: 2,
      receipt: { decision: 'inconclusive', errors: ['pr-metadata.event-invalid'] },
    });
  });

  it('fails closed for incomplete sources and non-ancestor commit ranges', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const incompleteEventPath = path.join(repo, 'incomplete-event.json');
    writeFileSync(incompleteEventPath, JSON.stringify({ number: 78 }), 'utf8');

    const incompleteEvent = runPrMetadataGuard(['--github-event', incompleteEventPath], repo);
    const missingBody = runPrMetadataGuard(
      [
        '--body-file', path.join(repo, 'missing-body.md'),
        '--base', baseOid,
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
    );
    const duplicateSource = runPrMetadataGuard(
      [
        '--stdin',
        '--stdin',
        '--base', baseOid,
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
      'Refs #144.\n',
    );
    const nonAncestor = runPrMetadataGuard(
      [
        '--stdin',
        '--base', headOid,
        '--head', baseOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
      'Refs #145.\n',
    );

    expect(incompleteEvent).toMatchObject({
      exitCode: 2,
      receipt: { decision: 'inconclusive', errors: ['pr-metadata.event-invalid'] },
    });
    expect(missingBody).toMatchObject({
      exitCode: 2,
      receipt: { decision: 'inconclusive', errors: ['pr-metadata.body-unavailable'] },
    });
    expect(duplicateSource).toMatchObject({
      exitCode: 2,
      receipt: { decision: 'inconclusive', errors: ['pr-metadata.input-invalid'] },
    });
    expect(nonAncestor).toMatchObject({
      exitCode: 2,
      receipt: { decision: 'inconclusive', errors: ['pr-metadata.commit-range-invalid'] },
    });
  });

  it('emits only bounded JSON receipts without echoing the PR body', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const canary = 'PRIVATE-BODY-CANARY';
    const result = spawnSync(
      'bash',
      [
        path.join(REPO_ROOT, 'scripts/run-with-pinned-node.sh'),
        path.join(REPO_ROOT, 'scripts/pr-metadata-guard.ts'),
        '--stdin',
        '--base', baseOid,
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
        '--json',
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: cleanGitEnv(),
        input: `This change does not fix #135. ${canary}\n`,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(canary);
    expect(result.stdout).not.toContain(canary);
    expect(JSON.parse(result.stdout)).toMatchObject({
      decision: 'fail',
      findings: [
        {
          code: 'pr-metadata.closing-directive-outside-section',
          issueNumbers: [135],
        },
      ],
    });
  });
});
