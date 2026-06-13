import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import {
  checkSafeguards,
  formatReport,
  parseArgs,
  run,
} from '../../scripts/safeguard-diagnostics.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempRepos: string[] = [];

const requiredPackageScripts = {
  'guard:publication': 'node scripts/publication-guard.ts',
  'guard:publication:all': 'npm run guard:publication -- --all',
  'guard:publication:release': 'npm run guard:publication -- --release',
  'guard:publication:staged': 'npm run guard:publication -- --staged',
  'guard:repo:staged': 'npm run guard:repo -- --staged',
  'guard:repo:commit-authors': 'npm run guard:repo -- --commit-authors',
  'guard:repo:release-hygiene': 'npm run guard:repo -- --release-hygiene',
  'guard:test-integrity': 'bash scripts/test-integrity-ci.sh',
  'guard:lint:src': 'node scripts/eslint-fitness-check.ts',
  'guard:claude-settings': 'node scripts/claude-settings-guard.ts --check',
  'guard:agent-decision-polls': 'node scripts/agent-decision-polls-guard.ts',
  'guard:safeguard-diagnostics': 'node scripts/safeguard-diagnostics.ts',
  'verify:push:branch': [
    'npm run guard:repo:staged',
    'npm run guard:repo:commit-authors',
    'npm run guard:publication:staged',
    'npm run guard:doc-drift',
    'npm run guard:public-surface-drift',
    'npm run guard:work-index',
    'npm run guard:node-pin-consistency',
    'npm run guard:claude-settings',
    'npm run guard:agent-decision-polls',
    'npm run guard:safeguard-diagnostics',
    'npm run guard:test-integrity',
    'npm run guard:lint:src',
    'npm run typecheck:all',
    'npm test',
  ].join(' && '),
  'verify:release': [
    'npm run guard:repo:release-hygiene',
    'npm run guard:repo:commit-authors',
    'npm run guard:publication:all',
    'npm run guard:doc-drift',
    'npm run guard:public-surface-drift',
    'npm run guard:work-index',
    'npm run guard:node-pin-consistency',
    'npm run guard:claude-settings',
    'npm run guard:agent-decision-polls',
    'npm run guard:safeguard-diagnostics',
    'npm run guard:test-integrity',
    'npm run guard:lint:src',
    'npm run typecheck:all',
    'npm test',
    'npm run coverage:check',
    'npm --prefix console run build',
  ].join(' && '),
  'verify:publish': [
    'npm run guard:claude-settings',
    'npm run guard:agent-decision-polls',
    'npm run guard:safeguard-diagnostics',
    'npm run guard:publication:release',
    'npm run verify:release',
  ].join(' && '),
};

const requiredFiles: Record<string, string> = {
  'scripts/repo-hygiene-guard.ts': [
    'model-attribution',
    'private-instance-label',
    'whatsapp-group-jid',
    'whatsapp-user-jid',
    'github-token',
    'openai-key',
    'pinecone-key',
    'private-key',
    'Co-Authored-By:',
    '--commit-authors',
    'scanCommitMessage(commit.message',
  ].join('\n'),
  'scripts/publication-guard.ts': [
    'scanTextForPrivateLiterals',
    'local-home-path',
    'whatsapp-group-jid',
    'whatsapp-user-jid',
    'github-token',
    'openai-key',
    'pinecone-key',
    'private-key',
    'staged-internal-doc-unclassified',
    'release-internal-doc-still-tracked',
  ].join('\n'),
  'src/fleet/bind-guard.ts': [
    'assertSafeFleetBind',
    'non-loopback',
    'WHATSOUP_FLEET_UNSAFE_REMOTE_CONSOLE',
    'root token',
    'refusing non-loopback fleet bind',
  ].join('\n'),
  'src/fleet/update-checker.ts': [
    'shouldRetryWithPublicHttps',
    'githubPublicHttpsUrlFromRemote',
    'publicFetchArgs',
    'git SSH fetch failed',
  ].join('\n'),
  'tests/runtimes/agent/provider-fallback.test.ts': [
    'does NOT activate fallback on a usage-limit assistant_text event',
    'does not silently replay a turn after tool activity started',
    'keeps auth-required fallback armed until a primary recovery probe succeeds',
    'does NOT block activation when the fallback key is absent (warn-only)',
    'uses providerConfig.apiKeyService for same-provider API fallback key presence',
  ].join('\n'),
  'tests/fleet/routes/provider-status.test.ts': [
    'not.toContain',
    'keyPresent',
    'recoveryProbeRequired',
    'uses providerConfig.apiKeyService',
  ].join('\n'),
  'scripts/agent-decision-polls-guard.ts': [
    'AskUserQuestion',
    'send_poll',
    'multiSelect',
    'guard:agent-decision-polls',
  ].join('\n'),
  'scripts/test-integrity-ci.sh': [
    'WHATSOUP_REQUIRE_TEST_INTEGRITY',
    'CI=true',
    'GITHUB_ACTIONS=true',
    'baseline --check --ci',
  ].join('\n'),
};

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: cleanGitEnv() });
}

function writeRepoFile(repo: string, relativePath: string, text: string): void {
  mkdirSync(path.dirname(path.join(repo, relativePath)), { recursive: true });
  writeFileSync(path.join(repo, relativePath), text);
}

function makeRepo(options: {
  scripts?: Record<string, string | undefined>;
  files?: Record<string, string | undefined>;
  trackedExtras?: Record<string, string>;
} = {}): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'safeguard-diagnostics-'));
  tempRepos.push(repo);
  const scripts = { ...requiredPackageScripts, ...(options.scripts ?? {}) };
  for (const [name, value] of Object.entries(scripts)) {
    if (value === undefined) delete scripts[name as keyof typeof scripts];
  }
  writeRepoFile(repo, 'package.json', JSON.stringify({ scripts }, null, 2));

  const files = { ...requiredFiles, ...(options.files ?? {}) };
  for (const [filePath, text] of Object.entries(files)) {
    if (text !== undefined) writeRepoFile(repo, filePath, `${text}\n`);
  }
  for (const [filePath, text] of Object.entries(options.trackedExtras ?? {})) {
    writeRepoFile(repo, filePath, text);
  }

  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'WhatSoup Test']);
  git(repo, ['config', 'user.email', 'whatsoup-test@users.noreply.github.com']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  return repo;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const repo of tempRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe('safeguard diagnostics', () => {
  it('passes the current repository without requiring a clean working tree', () => {
    const result = checkSafeguards(repoRoot);

    expect(result.ok).toBe(true);
    expect(result.summary.fail).toBe(0);
    expect(result.checks.map((check) => check.id)).toContain('no-tracked-instance-health-profiles');
  });

  it('fails when a required guard script is missing', () => {
    const fixture = makeRepo({ scripts: { 'guard:test-integrity': undefined } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'required-package-scripts')).toMatchObject({
      status: 'fail',
      evidence: expect.arrayContaining(['guard:test-integrity']),
    });
  });

  it('fails when a verify chain omits the diagnostic guard', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:push:branch': requiredPackageScripts['verify:push:branch']
          .replace(' && npm run guard:safeguard-diagnostics', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'branch-push-chain')?.evidence)
      .toContain('missing npm run guard:safeguard-diagnostics');
  });

  it('fails when a sensitive-surface anchor is removed', () => {
    const fixture = makeRepo({
      files: {
        'scripts/repo-hygiene-guard.ts': requiredFiles['scripts/repo-hygiene-guard.ts']
          .replace('private-instance-label\n', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'repo-hygiene-sensitive-patterns'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['private-instance-label']) });
  });

  it('fails when tracked health profiles contain unsafe credential paths or generated artifacts are tracked', () => {
    const fixture = makeRepo({
      trackedExtras: {
        'deploy/health-profiles/mwlab.json': '{"role":"bot-host","requiredCredentialFiles":["/var/lib/whatsoup/private/tokens.env"]}\n',
        'coverage-target/index.html': '<html></html>\n',
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'no-tracked-instance-health-profiles')?.evidence)
      .toEqual(['deploy/health-profiles/mwlab.json:unsafe-credential-path']);
    expect(result.checks.find((check) => check.id === 'no-tracked-generated-artifacts')?.evidence)
      .toEqual(['coverage-target/index.html']);
  });

  it('strict mode fails on repo-state warnings', () => {
    const fixture = makeRepo();
    const result = checkSafeguards(fixture, true);

    expect(result.ok).toBe(false);
    expect(result.summary.warn).toBeGreaterThan(0);
  });

  it('prints deterministic text and JSON readouts', () => {
    const fixture = makeRepo();
    const text = formatReport(checkSafeguards(fixture));

    expect(text).toContain('safeguard diagnostics: PASS');
    expect(text).toContain('guard-chain/branch-push-chain');
    expect(parseArgs(['--json', '--strict'])).toEqual({ json: true, strict: true, help: false });
  });

  it('sets exitCode on failed CLI runs', () => {
    const fixture = makeRepo({ scripts: { 'verify:release': 'npm run guard:test-integrity' } });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = run([], fixture);

    expect(result.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(output).toHaveBeenCalled();
  });
});
