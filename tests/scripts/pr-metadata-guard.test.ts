import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import { runPrMetadataGuard } from '../../scripts/pr-metadata-guard.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('');
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

function git(repo: string, args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.email=guard-test@users.noreply.github.com',
    '-c', 'user.name=Guard Test',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRangeRepo(candidateMessage = 'candidate'): { repo: string; baseOid: string; headOid: string } {
  const repo = tmp.make('pr-metadata-guard');

  git(repo, ['init']);
  writeFileSync(path.join(repo, 'note.txt'), 'base\n');
  git(repo, ['add', 'note.txt']);
  git(repo, ['commit', '-m', 'base']);
  const baseOid = git(repo, ['rev-parse', 'HEAD']);

  writeFileSync(path.join(repo, 'note.txt'), 'candidate\n');
  git(repo, ['add', 'note.txt']);
  git(repo, ['commit', '-m', candidateMessage]);
  return { repo, baseOid, headOid: git(repo, ['rev-parse', 'HEAD']) };
}

function makeAdvancedBaseRepo(candidateMessage = 'candidate', advanceMessage = 'advance'): {
  repo: string;
  headOid: string;
  advancedBaseOid: string;
} {
  const { repo, baseOid, headOid } = makeRangeRepo(candidateMessage);

  git(repo, ['checkout', '-b', 'base-advance', baseOid]);
  writeFileSync(path.join(repo, 'base.txt'), 'advance\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', advanceMessage]);
  return { repo, headOid, advancedBaseOid: git(repo, ['rev-parse', 'HEAD']) };
}

function makeUnrelatedRootOid(repo: string): string {
  git(repo, ['checkout', '--orphan', 'unrelated']);
  writeFileSync(path.join(repo, 'lonely.txt'), 'lonely\n');
  git(repo, ['add', 'lonely.txt']);
  git(repo, ['commit', '-m', 'unrelated root']);
  return git(repo, ['rev-parse', 'HEAD']);
}

function makeTamperedMetadataWorkflowRepo(): {
  repo: string;
  baseOid: string;
  headOid: string;
  eventPath: string;
} {
  const repo = tmp.make('pr-metadata-workflow-trust');
  const scriptsDir = path.join(repo, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  git(repo, ['init']);

  writeFileSync(
    path.join(scriptsDir, 'pr-metadata-guard.ts'),
    [
      "import { readFileSync } from 'node:fs';",
      '',
      "const eventIndex = process.argv.indexOf('--github-event');",
      'const eventPath = eventIndex >= 0 ? process.argv[eventIndex + 1] : undefined;',
      'if (eventPath === undefined) {',
      '  process.exitCode = 2;',
      '} else {',
      "  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as { pull_request: { body: string } };",
      "  process.exitCode = event.pull_request.body.includes('Closes #991') ? 1 : 0;",
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ scripts: { 'guard:pr-metadata': 'node --experimental-strip-types scripts/pr-metadata-guard.ts' } }),
    'utf8',
  );
  git(repo, ['add', 'package.json', 'scripts/pr-metadata-guard.ts']);
  git(repo, ['commit', '-m', 'trusted base guard']);
  const baseOid = git(repo, ['rev-parse', 'HEAD']);

  writeFileSync(
    path.join(scriptsDir, 'pr-metadata-guard.ts'),
    "process.stdout.write('CANDIDATE_GUARD_RAN\\n');\nprocess.exitCode = 0;\n",
    'utf8',
  );
  writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ scripts: { 'guard:pr-metadata': "node -e \"process.stdout.write('CANDIDATE_PACKAGE_RAN\\\\n')\" --" } }),
    'utf8',
  );
  git(repo, ['add', 'package.json', 'scripts/pr-metadata-guard.ts']);
  git(repo, ['commit', '-m', 'candidate disables metadata guard']);
  const headOid = git(repo, ['rev-parse', 'HEAD']);

  const eventPath = path.join(repo, 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({
      number: 991,
      repository: { default_branch: 'main' },
      pull_request: {
        body: 'Closes #991',
        base: { ref: 'main', sha: baseOid },
        head: { sha: headOid },
      },
    }),
    'utf8',
  );
  return { repo, baseOid, headOid, eventPath };
}

function runMetadataWorkflowGuard(
  repo: string,
  baseOid: string,
  headOid: string,
  eventPath: string,
): ReturnType<typeof spawnSync> {
  const workflow = parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/pr-metadata.yml'), 'utf8'));
  const steps = workflow.jobs.metadata.steps as Array<Record<string, unknown>>;
  const checkout = steps.find((step) => step.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
  const guard = steps.find((step) => step.name === 'PR metadata guard');
  if (checkout === undefined || guard === undefined || typeof guard.run !== 'string') {
    throw new Error('PR metadata workflow must define checkout and guard steps');
  }

  const checkoutWith = checkout.with as Record<string, unknown> | undefined;
  const checkoutRef = checkoutWith?.ref;
  const trustedBaseSelected = checkoutRef === '${{ github.event_name == \'pull_request\' && github.event.pull_request.base.sha || github.sha }}';
  git(repo, ['checkout', '--detach', trustedBaseSelected ? baseOid : headOid]);

  return spawnSync('bash', ['-c', guard.run], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...cleanGitEnv(), PR_METADATA_EVENT: eventPath },
    timeout: 30_000,
  });
}

describe('PR metadata guard', () => {
  it('receives fresh PR metadata after edits without stalling merge-group required checks', () => {
    const metadataWorkflow = parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/pr-metadata.yml'), 'utf8'));
    const qualityWorkflow = parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/quality.yml'), 'utf8'));
    const activities = metadataWorkflow.on.pull_request?.types ?? ['opened', 'synchronize', 'reopened'];

    for (const activity of ['opened', 'synchronize', 'reopened', 'edited']) {
      expect(activities, `metadata must receive ${activity} PR events`).toContain(activity);
    }
    expect(metadataWorkflow.on).toHaveProperty('pull_request');
    expect(metadataWorkflow.on).toHaveProperty('merge_group');
    expect(qualityWorkflow.on.pull_request?.types).toEqual(['opened', 'synchronize', 'reopened']);
    expect(JSON.stringify(qualityWorkflow.jobs)).not.toContain('pr-metadata');
    const guard = metadataWorkflow.jobs.metadata.steps.find((step: { name: string }) => step.name === 'PR metadata guard');
    expect(guard).toMatchObject({
      if: "github.event_name == 'pull_request'",
      env: { PR_METADATA_EVENT: '${{ github.event_path }}' },
    });
  });

  it('uses trusted base code when candidate guard and package scripts attempt to approve invalid metadata', () => {
    const { repo, baseOid, headOid, eventPath } = makeTamperedMetadataWorkflowRepo();

    const violating = runMetadataWorkflowGuard(repo, baseOid, headOid, eventPath);

    expect(violating.status, `${violating.stderr}\n${violating.stdout}`).toBe(1);
    expect(violating.stdout).not.toContain('CANDIDATE_GUARD_RAN');
    expect(violating.stdout).not.toContain('CANDIDATE_PACKAGE_RAN');

    writeFileSync(
      eventPath,
      JSON.stringify({
        number: 991,
        repository: { default_branch: 'main' },
        pull_request: {
          body: 'Refs #991',
          base: { ref: 'main', sha: baseOid },
          head: { sha: headOid },
        },
      }),
      'utf8',
    );
    const valid = runMetadataWorkflowGuard(repo, baseOid, headOid, eventPath);

    expect(valid.status).toBe(0);
    expect(valid.stdout).not.toContain('CANDIDATE_GUARD_RAN');
    expect(valid.stdout).not.toContain('CANDIDATE_PACKAGE_RAN');
  });

  it('refuses to substitute the candidate when the trusted validator is missing', () => {
    const { repo, baseOid, headOid, eventPath } = makeTamperedMetadataWorkflowRepo();
    git(repo, ['checkout', '--detach', baseOid]);
    git(repo, ['rm', 'scripts/pr-metadata-guard.ts']);
    git(repo, ['commit', '-m', 'base without metadata validator']);
    const missingBase = git(repo, ['rev-parse', 'HEAD']);
    const result = runMetadataWorkflowGuard(repo, missingBase, headOid, eventPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MODULE_NOT_FOUND');
    expect(result.stdout).not.toContain('CANDIDATE_');
  });

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

  it.each(['opened', 'edited'])('reads the current body from a complete %s PR event without querying GitHub', (action) => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const eventPath = path.join(repo, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({
        action,
        changes: { body: { from: 'Closes owner/repo#132' } },
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

  it('scans only the PR commits when the base branch advanced past the fork point', () => {
    const { repo, headOid, advancedBaseOid } = makeAdvancedBaseRepo('candidate', 'advance: fixes #900');

    const result = runPrMetadataGuard(
      [
        '--stdin',
        '--base', advancedBaseOid,
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
      'Refs #146.\n',
    );

    expect(result).toMatchObject({
      exitCode: 0,
      receipt: { decision: 'pass', findings: [] },
    });
  });

  it('still rejects closing directives in the PR commits when the base branch advanced', () => {
    const { repo, headOid, advancedBaseOid } = makeAdvancedBaseRepo('This does not fix #147');

    const result = runPrMetadataGuard(
      [
        '--stdin',
        '--base', advancedBaseOid,
        '--head', headOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
      'Refs #147.\n',
    );

    expect(result).toMatchObject({ exitCode: 1, receipt: { decision: 'fail' } });
    expect(result.receipt.findings).toContainEqual({
      code: 'pr-metadata.commit-closing-directive',
      issueNumbers: [147],
    });
  });

  it('treats a head already contained in the base as an empty commit range', () => {
    const { repo, baseOid, headOid } = makeRangeRepo('This does not fix #148');

    const result = runPrMetadataGuard(
      [
        '--stdin',
        '--base', headOid,
        '--head', baseOid,
        '--target', 'main',
        '--default-branch', 'main',
      ],
      repo,
      'Refs #148.\n',
    );

    expect(result).toMatchObject({
      exitCode: 0,
      receipt: { decision: 'pass', findings: [] },
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

  it('fails closed for incomplete sources and unrelated commit histories', () => {
    const { repo, baseOid, headOid } = makeRangeRepo();
    const unrelatedOid = makeUnrelatedRootOid(repo);
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
    const unrelatedHistories = runPrMetadataGuard(
      [
        '--stdin',
        '--base', unrelatedOid,
        '--head', headOid,
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
    expect(unrelatedHistories).toMatchObject({
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
