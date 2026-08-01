import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { cleanGitEnv } from '../../src/lib/git-env.ts';
import type { CandidateTree } from '../../scripts/lib/semantic-quality/git-tree.ts';
import type { SemanticPolicyFinding } from '../../scripts/lib/semantic-quality/policy.ts';
import {
  aggregateBoundaryDecision,
  buildBoundaryReceipt,
  buildSemanticReceipt,
  isBoundaryFindingComplete,
  renderSemanticReceipt,
  semanticExitCode,
  writeLocalReceipt,
  type BoundaryDecision,
  type BoundaryFinding,
  type BoundaryReceipt,
  type EnforcementMode,
} from '../../scripts/lib/semantic-quality/receipt.ts';
import type { BoundaryAction } from '../../scripts/lib/semantic-quality/boundary-types.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO_ROOT, 'scripts/semantic-quality-check.ts');
const tmp = trackTmpDirs('');

const TREE: CandidateTree = {
  headOid: '1111111111111111111111111111111111111111',
  baseOid: '2222222222222222222222222222222222222222',
  mergeBaseOid: '3333333333333333333333333333333333333333',
  sources: [],
  changedPaths: [],
  limitations: [],
};

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(repo: string, relativePath: string, contents: string): void {
  const absolute = path.join(repo, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}

function commit(repo: string, message: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function initRepo(): string {
  const repo = tmp.make('semantic-quality-check');
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.name', 'Semantic Quality Test']);
  git(repo, ['config', 'user.email', 'semantic-quality-test@users.noreply.github.com']);
  return repo;
}

function writePolicy(repo: string, allowlist: unknown[] = []): void {
  write(repo, 'config/semantic-quality.json', `${JSON.stringify({
    schemaVersion: 1,
    roots: ['src/main.ts'],
    sourcePrefixes: ['src/'],
    excludedSuffixes: ['.d.ts'],
    allowlist,
  }, null, 2)}\n`);
}

function makeHistory(): {
  repo: string;
  baseOid: string;
  disconnectedOid: string;
  integratedOid: string;
} {
  const repo = initRepo();
  writePolicy(repo);
  write(repo, 'src/main.ts', `console.log('main');\n`);
  const baseOid = commit(repo, 'baseline');

  write(repo, 'src/feature.ts', 'export function feature() { return true; }\n');
  const disconnectedOid = commit(repo, 'historical disconnected feature');

  write(repo, 'src/main.ts', `import { feature } from './feature.ts';\nfeature();\n`);
  const integratedOid = commit(repo, 'wire feature');
  return { repo, baseOid, disconnectedOid, integratedOid };
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(repo: string, args: string[], env: NodeJS.ProcessEnv = cleanGitEnv()): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', CLI, ...args],
    {
      cwd: repo,
      encoding: 'utf8',
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
      killSignal: 'SIGKILL',
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function expectOperationalFinding(
  parsed: BoundaryReceipt,
  ruleId: string,
  observedLabel: string,
  source: string | RegExp,
): BoundaryFinding {
  const finding = parsed.findings.find((item) => item.ruleId === ruleId);
  expect(finding).toMatchObject({
    ruleId,
    decision: 'inconclusive',
    summary: expect.any(String),
    why: expect.any(String),
    observed: expect.arrayContaining([
      expect.objectContaining({ label: observedLabel, value: expect.any(String) }),
    ]),
    correction: expect.arrayContaining([expect.any(String)]),
    rerun: 'npm run verify:semantic -- --base origin/main',
    sourceRefs: expect.any(Array),
  });
  if (typeof source === 'string') expect(finding?.sourceRefs).toContain(source);
  else expect(finding?.sourceRefs.join(' ')).toMatch(source);
  expect(finding?.summary.length).toBeGreaterThan(20);
  expect(finding?.why.length).toBeGreaterThan(20);
  return finding!;
}

function policyFinding(decision: Exclude<BoundaryDecision, 'pass'>): SemanticPolicyFinding {
  return {
    ruleId: 'semantic.production-reachability',
    decision,
    paths: ['src/feature.ts'],
    evidence: [
      { label: 'change_status', value: 'added' },
      { label: 'production_root', value: 'src/main.ts' },
    ],
  };
}

function receipt(
  decision: Exclude<BoundaryDecision, 'pass'>,
  enforcementMode: EnforcementMode = 'enforce',
): BoundaryReceipt {
  return buildSemanticReceipt({
    tree: TREE,
    policyFindings: [policyFinding(decision)],
    enforcementMode,
    evidenceSource: 'fixture:semantic-quality-check',
  });
}

function genericFinding(
  action: BoundaryAction,
  overrides: Partial<BoundaryFinding> = {},
): BoundaryFinding {
  return {
    ruleId: 'history.exact-closed-pr',
    decision: 'block',
    action,
    summary: 'Candidate content exactly matches a prior closed pull request.',
    why: 'The canonical path/blob identity is exact.',
    observed: [{ label: 'content_fingerprint_sha256', value: 'a'.repeat(64) }],
    matchedArtifacts: [
      {
        kind: 'pull-request',
        repository: 'LucasQuiles/WhatSoup',
        id: '1838',
        url: 'https://github.com/LucasQuiles/WhatSoup/pull/1838',
        state: 'closed-unmerged',
        fingerprintSha256: 'a'.repeat(64),
      },
    ],
    correction: ['Continue from the prior artifact or prove a material delta.'],
    rerun: 'npm run verify:boundary',
    sourceRefs: [
      'https://github.com/LucasQuiles/WhatSoup/pull/1838',
      'fixture:history',
      'fixture:history',
    ],
    ...overrides,
  };
}

describe('semantic quality receipt', () => {
  it('shares decision aggregation and feedback-completeness semantics with experiment adapters', () => {
    expect(aggregateBoundaryDecision([])).toBe('pass');
    expect(aggregateBoundaryDecision([{ decision: 'warn' }, { decision: 'inconclusive' }])).toBe('inconclusive');
    expect(aggregateBoundaryDecision([{ decision: 'block' }, { decision: 'inconclusive' }])).toBe('block');
    expect(isBoundaryFindingComplete(receipt('warn').findings[0]!)).toBe(true);
    expect(isBoundaryFindingComplete({
      ...receipt('warn').findings[0]!,
      correction: [],
    })).toBe(false);
  });

  it('aggregates block over inconclusive over warn over pass', () => {
    const build = (decisions: Array<Exclude<BoundaryDecision, 'pass'>>) =>
      buildSemanticReceipt({
        tree: TREE,
        policyFindings: decisions.map(policyFinding),
        enforcementMode: 'enforce',
        evidenceSource: 'fixture:aggregate',
      }).decision;

    expect(build([])).toBe('pass');
    expect(build(['warn'])).toBe('warn');
    expect(build(['warn', 'inconclusive'])).toBe('inconclusive');
    expect(build(['inconclusive', 'block'])).toBe('block');
  });

  it.each(['warn', 'block', 'inconclusive'] as const)(
    'renders %s feedback in decision/evidence/why/correction/rerun/source order',
    (decision) => {
      const built = receipt(decision);
      const output = renderSemanticReceipt(built);

      const decisionAt = output.indexOf(`${decision.toUpperCase()} [semantic.production-reachability] while push`);
      const observedAt = output.indexOf('Observed:');
      const whyAt = output.indexOf('Why:');
      const correctionAt = output.indexOf('Correction:');
      const rerunAt = output.indexOf('Rerun:');
      const sourcesAt = output.indexOf('Sources:');

      expect(decisionAt).toBeGreaterThanOrEqual(0);
      expect(observedAt).toBeGreaterThan(decisionAt);
      expect(whyAt).toBeGreaterThan(observedAt);
      expect(correctionAt).toBeGreaterThan(whyAt);
      expect(rerunAt).toBeGreaterThan(correctionAt);
      expect(sourcesAt).toBeGreaterThan(rerunAt);
      expect(output).toContain('change_status: added');
      expect(output).toContain('src/feature.ts');
      expect(output).toContain('npm run verify:semantic -- --base origin/main');
      expect(built.findings[0]).toMatchObject({
        action: 'push',
        matchedArtifacts: [],
        sourceRefs: expect.arrayContaining(['fixture:semantic-quality-check']),
      });
    },
  );

  it('renders a pass as one line containing the exact head OID', () => {
    const built = buildSemanticReceipt({
      tree: TREE,
      policyFindings: [],
      enforcementMode: 'shadow',
      evidenceSource: 'fixture:pass',
    });

    expect(renderSemanticReceipt(built).trim().split('\n')).toEqual([
      `PASS semantic quality head=${TREE.headOid}`,
    ]);
  });

  it('keeps shadow exits zero while preserving block and inconclusive decisions', () => {
    expect(receipt('block', 'shadow').decision).toBe('block');
    expect(semanticExitCode(receipt('block', 'shadow'))).toBe(0);
    expect(receipt('inconclusive', 'shadow').decision).toBe('inconclusive');
    expect(semanticExitCode(receipt('inconclusive', 'shadow'))).toBe(0);
  });

  it('uses distinct enforce exits for block and inconclusive', () => {
    expect(semanticExitCode(receipt('warn'))).toBe(0);
    expect(semanticExitCode(receipt('block'))).toBe(1);
    expect(semanticExitCode(receipt('inconclusive'))).toBe(2);
  });

  it('writes the local receipt under the Git metadata path atomically at mode 0600', () => {
    const { repo, baseOid } = makeHistory();
    const built = buildSemanticReceipt({
      tree: { ...TREE, headOid: baseOid },
      policyFindings: [],
      enforcementMode: 'shadow',
      evidenceSource: 'fixture:write',
    });

    const written = writeLocalReceipt(repo, built);
    const gitPath = git(repo, ['rev-parse', '--git-path', 'whatsoup/receipts/semantic-quality.json']);
    const expected = path.isAbsolute(gitPath) ? gitPath : path.resolve(repo, gitPath);

    expect(written).toBe(expected);
    expect(JSON.parse(readFileSync(written, 'utf8'))).toEqual(built);
    expect(statSync(written).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(written)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a symlinked local receipt destination without changing its target', () => {
    const { repo } = makeHistory();
    const gitPath = git(repo, ['rev-parse', '--git-path', 'whatsoup/receipts/semantic-quality.json']);
    const receiptPath = path.isAbsolute(gitPath) ? gitPath : path.resolve(repo, gitPath);
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    const decoy = path.join(repo, 'decoy.json');
    writeFileSync(decoy, 'unchanged\n', 'utf8');
    symlinkSync(decoy, receiptPath);

    expect(() => writeLocalReceipt(repo, receipt('warn', 'shadow'))).toThrow(/receipt.*symlink/i);
    expect(lstatSync(receiptPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(decoy, 'utf8')).toBe('unchanged\n');
  });
});

describe('generic boundary receipt', () => {
  const actions: BoundaryAction[] = ['commit', 'push', 'open-pr', 'reopen-pr', 'open-issue'];

  it.each(actions)('builds and renders complete matched-artifact feedback for %s', (action) => {
    const built = buildBoundaryReceipt({
      invocation: 'boundary-history',
      action,
      enforcementMode: 'enforce',
      base: {
        headOid: TREE.headOid,
        baseOid: TREE.baseOid,
        mergeBaseOid: TREE.mergeBaseOid,
        evidenceSource: 'fixture:generic-boundary',
      },
      fingerprints: { zeta: null, alpha: 'b'.repeat(64) },
      findings: [genericFinding(action)],
      limitations: ['second limitation', 'first limitation', 'first limitation'],
    });
    const output = renderSemanticReceipt(built);

    expect(built).toMatchObject({
      schemaVersion: 1,
      action,
      decision: 'block',
      correlationIdSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      fingerprints: { alpha: 'b'.repeat(64), zeta: null },
      limitations: ['first limitation', 'second limitation'],
    });
    expect(built.findings[0]?.sourceRefs).toEqual([
      'fixture:history',
      'https://github.com/LucasQuiles/WhatSoup/pull/1838',
    ]);
    expect(output).toContain(`while ${action}`);
    expect(output).toMatch(/Correlation: [0-9a-f]{12}/);
    expect(output.indexOf('Matched artifacts:')).toBeGreaterThan(output.indexOf('Observed:'));
    expect(output.indexOf('Why:')).toBeGreaterThan(output.indexOf('Matched artifacts:'));
    expect(output).toContain('pull-request LucasQuiles/WhatSoup#1838');
  });

  it('derives correlation only from the stable safe tuple', () => {
    const build = (input: {
      action?: BoundaryAction;
      headOid?: string;
      ruleId?: string;
      summary?: string;
      limitation?: string;
      evidenceSource?: string;
    }) =>
      buildBoundaryReceipt({
        invocation: 'boundary-history',
        action: input.action ?? 'open-pr',
        enforcementMode: 'enforce',
        base: {
          headOid: input.headOid ?? TREE.headOid,
          baseOid: TREE.baseOid,
          mergeBaseOid: TREE.mergeBaseOid,
          evidenceSource: input.evidenceSource ?? 'fixture:first-source',
        },
        findings: [
          genericFinding(input.action ?? 'open-pr', {
            ruleId: input.ruleId ?? 'history.exact-closed-pr',
            summary: input.summary ?? 'first summary',
          }),
        ],
        limitations: [input.limitation ?? 'first diagnostic'],
      }).correlationIdSha256;

    const stable = build({});
    expect(build({
      summary: 'different diagnostic prose',
      limitation: 'different error text',
      evidenceSource: '/different/local/path',
    })).toBe(stable);
    expect(build({ action: 'reopen-pr' })).not.toBe(stable);
    expect(build({ headOid: '9999999999999999999999999999999999999999' })).not.toBe(stable);
    expect(build({ ruleId: 'provenance.stale-overlap' })).not.toBe(stable);
  });

  it('rejects a finding whose action differs from the receipt boundary', () => {
    expect(() =>
      buildBoundaryReceipt({
        invocation: 'boundary-history',
        action: 'open-pr',
        enforcementMode: 'enforce',
        base: {
          headOid: TREE.headOid,
          baseOid: TREE.baseOid,
          mergeBaseOid: TREE.mergeBaseOid,
          evidenceSource: 'fixture:action-mismatch',
        },
        findings: [genericFinding('push')],
      }),
    ).toThrow(/action/i);
  });

  it('treats nonempty limitations without findings as inconclusive in enforce mode', () => {
    const built = buildBoundaryReceipt({
      invocation: 'boundary-history',
      action: 'open-pr',
      enforcementMode: 'enforce',
      base: {
        headOid: TREE.headOid,
        baseOid: TREE.baseOid,
        mergeBaseOid: TREE.mergeBaseOid,
        evidenceSource: 'fixture:truncated-history',
      },
      findings: [],
      limitations: ['history collection stopped before a terminal cursor'],
    });

    expect(built.decision).toBe('inconclusive');
    expect(semanticExitCode(built)).toBe(2);
    expect(renderSemanticReceipt(built)).toContain(
      'INCONCLUSIVE [boundary.evidence-incomplete] while open-pr',
    );
  });

  it('redacts secret-like values, credential references, queries, and absolute local paths', () => {
    const secret = ['token', 'abcdefghijklmnop'].join('=');
    const operatorPath = ['', 'Users', 'q', 'private', 'config.json'].join('/');
    const credentialReference = [
      'https://agent:',
      secret,
      '@',
      'github.com/LucasQuiles/WhatSoup/pull/1838?auth=present',
    ].join('');
    const built = buildBoundaryReceipt({
      invocation: 'boundary-history',
      action: 'open-pr',
      enforcementMode: 'enforce',
      base: {
        headOid: TREE.headOid,
        baseOid: TREE.baseOid,
        mergeBaseOid: TREE.mergeBaseOid,
        evidenceSource: `/private/tmp/${secret}`,
      },
      fingerprints: { candidate: secret },
      findings: [
        genericFinding('open-pr', {
          observed: [
            { label: 'provider_error', value: `remote failed with ${secret}` },
            { label: 'local_error', value: `cannot read ${operatorPath}` },
          ],
          sourceRefs: [credentialReference],
        }),
      ],
      limitations: [`provider failed with ${secret}`],
    });
    const receiptText = JSON.stringify(built);

    expect(receiptText).not.toContain('abcdefghijklmnop');
    expect(receiptText).not.toContain('?auth=');
    expect(receiptText).not.toContain('/private/tmp');
    expect(built.findings[0]?.observed[0]?.value).toBe('redacted-sensitive-value');
    expect(built.findings[0]?.observed[1]?.value).toBe('redacted-local-path');
    expect(built.findings[0]?.sourceRefs).toEqual(['boundary-reference:redacted']);
  });

  it('keeps the additive action and correlation fields optional for legacy receipt literals', () => {
    const legacy: BoundaryReceipt = {
      schemaVersion: 1,
      repository: 'LucasQuiles/WhatSoup',
      invocation: 'semantic-quality',
      enforcementMode: 'shadow',
      decision: 'pass',
      base: {
        headOid: TREE.headOid,
        baseOid: TREE.baseOid,
        mergeBaseOid: TREE.mergeBaseOid,
        evidenceSource: 'fixture:legacy',
      },
      fingerprints: {},
      findings: [],
      limitations: [],
    };

    expect({
      action: legacy.action ?? null,
      correlationIdSha256: legacy.correlationIdSha256 ?? null,
    }).toEqual({ action: null, correlationIdSha256: null });
    expect(renderSemanticReceipt(legacy)).toBe(`PASS semantic quality head=${TREE.headOid}\n`);
    expect(semanticExitCode(legacy)).toBe(0);
  });
});

describe('semantic quality CLI', () => {
  it('reports the delegation receipt export while its module remains production-reachable', () => {
    const repo = initRepo();
    writePolicy(repo);
    write(repo, 'src/main.ts', `
import { emitRouteEvent } from './runtimes/agent/route-events.ts';
emitRouteEvent();
`);
    write(repo, 'src/runtimes/agent/route-events.ts', `
export function emitRouteEvent(): void {}
export function emitDelegationReceipt(): void {}
`);
    const head = commit(repo, 'reachable route events with orphaned delegation receipt');

    const result = runCli(repo, [
      '--scope', 'tree',
      '--head', head,
      '--mode', 'shadow',
      '--format', 'json',
      '--no-receipt',
    ]);
    const parsed = JSON.parse(result.stdout) as BoundaryReceipt;
    const ownership = parsed.findings.find((finding) => finding.ruleId === 'semantic.export-ownership');

    expect(result.status).toBe(0);
    expect(parsed.decision).toBe('warn');
    expect(parsed.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'semantic.production-reachability' }),
    ]));
    expect(ownership?.observed).toContainEqual({
      label: 'unowned_export',
      value: 'src/runtimes/agent/route-events.ts#emitDelegationReceipt',
    });
  });

  it('passes the wired current shape and blocks its historical disconnected shape', () => {
    const { repo, baseOid, disconnectedOid, integratedOid } = makeHistory();

    const current = runCli(repo, [
      '--head', integratedOid,
      '--base', baseOid,
      '--mode', 'enforce',
      '--format', 'json',
      '--no-receipt',
    ]);
    const historical = runCli(repo, [
      '--head', disconnectedOid,
      '--base', baseOid,
      '--mode', 'enforce',
      '--format', 'json',
      '--no-receipt',
    ]);

    expect(current.status).toBe(0);
    expect(JSON.parse(current.stdout)).toMatchObject({ decision: 'pass', enforcementMode: 'enforce' });
    expect(current.stderr).toBe('');
    expect(historical.status).toBe(1);
    expect(JSON.parse(historical.stdout)).toMatchObject({
      decision: 'block',
      findings: [expect.objectContaining({ ruleId: 'semantic.production-reachability' })],
    });
    expect(historical.stderr).toBe('');
  });

  it('emits parseable JSON without human prose', () => {
    const { repo, baseOid, disconnectedOid } = makeHistory();

    const result = runCli(repo, [
      '--head', disconnectedOid,
      '--base', baseOid,
      '--mode', 'shadow',
      '--format', 'json',
      '--no-receipt',
    ]);

    const parsed = JSON.parse(result.stdout) as BoundaryReceipt;
    expect(result.status).toBe(0);
    expect(parsed.decision).toBe('block');
    expect(result.stdout.trim().startsWith('{')).toBe(true);
    expect(result.stderr).toBe('');
  });

  it('prints a one-line pass with the exact head and receipt path', () => {
    const { repo, baseOid, integratedOid } = makeHistory();
    const receiptPath = path.join(repo, 'receipts', 'result.json');

    const result = runCli(repo, [
      '--head', integratedOid,
      '--base', baseOid,
      '--mode', 'shadow',
      '--format', 'human',
      '--receipt', receiptPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toEqual([
      `PASS semantic quality head=${integratedOid} receipt=${receiptPath}`,
    ]);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({ decision: 'pass' });
  });

  it('requires an explicit receipt path in CI', () => {
    const { repo, baseOid, integratedOid } = makeHistory();

    const result = runCli(
      repo,
      [
        '--head', integratedOid,
        '--base', baseOid,
        '--mode', 'enforce',
        '--format', 'json',
      ],
      { ...cleanGitEnv(), CI: 'true' },
    );

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      decision: 'inconclusive',
      limitations: [expect.stringMatching(/CI requires.*--receipt/i)],
    });
  });

  it.each([
    ['block', 'shadow', 0],
    ['block', 'enforce', 1],
  ] as const)('keeps a %s receipt in %s mode with process status %i', (_decision, mode, status) => {
    const { repo, baseOid, disconnectedOid } = makeHistory();

    const result = runCli(repo, [
      '--head', disconnectedOid,
      '--base', baseOid,
      '--mode', mode,
      '--format', 'json',
      '--no-receipt',
    ]);

    expect(result.status).toBe(status);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block', enforcementMode: mode });
  });

  it.each([
    ['shadow', 0],
    ['enforce', 2],
  ] as const)('keeps missing-head evidence inconclusive in %s mode with status %i', (mode, status) => {
    const { repo, baseOid } = makeHistory();

    const result = runCli(repo, [
      '--head', 'refs/heads/absent',
      '--base', baseOid,
      '--mode', mode,
      '--format', 'json',
      '--no-receipt',
    ]);

    expect(result.status).toBe(status);
    const parsed = JSON.parse(result.stdout) as BoundaryReceipt;
    expect(parsed).toMatchObject({ decision: 'inconclusive' });
    const finding = expectOperationalFinding(
      parsed,
      'semantic.candidate-unavailable',
      'candidate_problem',
      'git:refs/heads/absent',
    );
    expect(finding.summary).toMatch(/candidate revision/i);
  });

  it('treats an unreadable policy as inconclusive', () => {
    const repo = initRepo();
    write(repo, 'src/main.ts', `console.log('main');\n`);
    const head = commit(repo, 'source without policy');

    const result = runCli(repo, [
      '--scope', 'tree',
      '--head', head,
      '--mode', 'enforce',
      '--format', 'json',
      '--no-receipt',
    ]);

    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout) as BoundaryReceipt;
    expect(parsed).toMatchObject({ decision: 'inconclusive' });
    const finding = expectOperationalFinding(
      parsed,
      'semantic.policy-unavailable',
      'policy_read_problem',
      'config/semantic-quality.json',
    );
    expect(finding.summary).toMatch(/policy.*read|policy.*parsed/i);
    expect(JSON.stringify(finding)).not.toMatch(/production module is not reachable/i);
  });

  it('identifies a missing configured root as source-tree evidence failure', () => {
    const repo = initRepo();
    write(repo, 'config/semantic-quality.json', `${JSON.stringify({
      schemaVersion: 1,
      roots: ['src/missing-root.ts'],
      sourcePrefixes: ['src/'],
      excludedSuffixes: ['.d.ts'],
      allowlist: [],
    })}\n`);
    write(repo, 'src/main.ts', `console.log('main');\n`);
    const head = commit(repo, 'source tree without configured root');

    const result = runCli(repo, [
      '--scope', 'tree',
      '--head', head,
      '--mode', 'enforce',
      '--format', 'json',
      '--no-receipt',
    ]);

    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout) as BoundaryReceipt;
    const finding = expectOperationalFinding(
      parsed,
      'semantic.source-tree-unavailable',
      'source_tree_problem',
      'config/semantic-quality.json',
    );
    expect(finding.observed.map((item) => item.value).join(' ')).toMatch(/missing-root/i);
  });

  it('identifies a source parse failure as analysis evidence failure', () => {
    const repo = initRepo();
    writePolicy(repo);
    write(repo, 'src/main.ts', `import { broken from './broken.ts';\n`);
    const head = commit(repo, 'malformed source tree');

    const result = runCli(repo, [
      '--scope', 'tree',
      '--head', head,
      '--mode', 'enforce',
      '--format', 'json',
      '--no-receipt',
    ]);

    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout) as BoundaryReceipt;
    const finding = expectOperationalFinding(
      parsed,
      'semantic.analysis-unavailable',
      'analysis_problem',
      'config/semantic-quality.json',
    );
    expect(finding.observed.map((item) => item.value).join(' ')).toMatch(/parse|syntax/i);
  });

  it('keeps an expired policy override blocking instead of converting it to unreadable', () => {
    const repo = initRepo();
    writePolicy(repo, [{
      path: 'src/main.ts',
      owner: 'runtime-maintainers',
      reason: 'Expired bridge',
      expiresOn: '2000-01-01',
      reentryCondition: 'Wire the owner',
    }]);
    write(repo, 'src/main.ts', `console.log('main');\n`);
    const head = commit(repo, 'expired policy');

    const result = runCli(repo, [
      '--scope', 'tree',
      '--head', head,
      '--mode', 'enforce',
      '--format', 'json',
      '--no-receipt',
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      decision: 'block',
      findings: [expect.objectContaining({ ruleId: 'semantic.invalid-allowlist' })],
    });
  });

  it('turns an unknown argument into an inconclusive receipt instead of uncaught success', () => {
    const { repo } = makeHistory();

    const result = runCli(repo, [
      '--mode', 'enforce',
      '--format', 'json',
      '--no-receipt',
      '--unknown-option',
    ]);

    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout) as BoundaryReceipt;
    expect(parsed).toMatchObject({
      decision: 'inconclusive',
      limitations: [expect.stringMatching(/unknown argument.*--unknown-option/i)],
    });
    const finding = expectOperationalFinding(
      parsed,
      'semantic.invocation-invalid',
      'invocation_problem',
      'semantic-quality-cli',
    );
    expect(finding.summary).toMatch(/invocation.*invalid/i);
  });

  it('adds a distinct finding when the receipt cannot be written durably', () => {
    const { repo, baseOid, integratedOid } = makeHistory();
    const directoryTarget = path.join(repo, 'receipt-target');
    mkdirSync(directoryTarget);

    const result = runCli(repo, [
      '--head', integratedOid,
      '--base', baseOid,
      '--mode', 'enforce',
      '--format', 'json',
      '--receipt', directoryTarget,
    ]);

    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout) as BoundaryReceipt;
    const finding = expectOperationalFinding(
      parsed,
      'semantic.receipt-write-failed',
      'receipt_write_problem',
      'local-receipt-writer',
    );
    expect(finding.summary).toMatch(/receipt.*written durably/i);
    expect(parsed.limitations.join(' ')).toMatch(/receipt write failed/i);
  });
});
