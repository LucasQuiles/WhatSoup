/**
 * gitleaks wiring.
 *
 * - `.gitleaks.toml` allowlists exactly the tracked paths the repository hygiene check exempts
 *   from secret shapes, judged path by path, because gitleaks reads its config from the tree it
 *   scans and a change can edit it.
 * - The Quality workflow's `gitleaks` job keeps its supply-chain and output contract.
 * - The pre-push step (scripts/pre-push-guard.ts) runs only the pinned release, scans exactly
 *   the pushed commits and prints counts and rule ids only.
 *
 * No test runs a real gitleaks: the suite setup points WHATSOUP_GITLEAKS at an absent path and
 * these tests point it at a fake script.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { isFixtureFile } from '../../scripts/lib/repo-hygiene-policy.ts';
import { GITLEAKS_VERSION, runGitleaksStep, runPrePushGuard, ZERO_SHA } from '../../scripts/pre-push-guard.ts';
import { isolatedGitEnv } from '../helpers/isolated-git-env.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PINNED_ARCHIVE_SHA256 = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function captureErrors(fn: () => void): string[] {
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    errors.push(String(message));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return errors;
}

describe('.gitleaks.toml', () => {
  const config = readFileSync(resolve(repoRoot, '.gitleaks.toml'), 'utf8');
  const allowlisted = [...config.matchAll(/^ {2}'''(.+)''',$/gm)].map((match) => new RegExp(match[1]!));

  it('extends the default rule set with one path-only allowlist table', () => {
    expect(config).toMatch(/^\[extend\]\nuseDefault = true$/m);
    expect(config.match(/^\[\[allowlists\]\]$/gm)).toEqual(['[[allowlists]]']);
    expect(config).not.toMatch(/^\[allowlist\]$/m);
    expect(config).not.toMatch(/^(?:regexes|stopwords|commits|targetRules|regexTarget|condition|disabledRules)\s*=/m);
    expect(allowlisted).toHaveLength(8);
  });

  it('allowlists exactly the tracked paths the hygiene check exempts from secret shapes', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      env: isolatedGitEnv(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter((path) => path !== '');
    expect(tracked.length).toBeGreaterThan(100);

    const disagreements = tracked.filter(
      (path) => allowlisted.some((pattern) => pattern.test(path)) !== isFixtureFile(path),
    );
    expect(disagreements).toEqual([]);
    const unused = allowlisted
      .filter((pattern) => !tracked.some((path) => pattern.test(path)))
      .map((pattern) => pattern.source);
    expect(unused).toEqual([]);
  });
});

describe('Quality workflow gitleaks job', () => {
  const workflow = parse(readFileSync(resolve(repoRoot, '.github/workflows/quality.yml'), 'utf8')) as {
    jobs: Record<string, Record<string, unknown>>;
  };
  const job = workflow.jobs['gitleaks']!;
  const steps = job['steps'] as Array<Record<string, unknown>>;
  const step = (name: string): Record<string, unknown> | undefined => steps.find((entry) => entry['name'] === name);

  it('is a blocking job named gitleaks with read-only, bounded settings', () => {
    expect(job['name']).toBe('gitleaks');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(10);
    expect(job['permissions']).toEqual({ contents: 'read' });
    for (const key of ['if', 'needs', 'env', 'defaults', 'continue-on-error', 'strategy']) {
      expect(Object.keys(job), key).not.toContain(key);
    }
  });

  it('checks out the full history without persisting credentials', () => {
    expect(step('Checkout')).toEqual({
      name: 'Checkout',
      uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      with: { 'fetch-depth': 0, 'persist-credentials': false },
    });
  });

  it('verifies the pinned archive against its sha256 before extracting it', () => {
    const install = step('Install gitleaks 8.30.1');
    expect(install?.['env']).toEqual({
      GITLEAKS_VERSION: GITLEAKS_VERSION,
      GITLEAKS_ARCHIVE_SHA256: PINNED_ARCHIVE_SHA256,
    });
    const run = String(install?.['run']);
    expect(run.split('\n')[0]).toBe('set -euo pipefail');
    expect(run).toContain('archive="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"');
    expect(run).toContain('"https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}"');
    expect(run.indexOf('sha256sum -c -')).toBeGreaterThan(run.indexOf('curl --fail'));
    expect(run.indexOf('tar -xzf')).toBeGreaterThan(run.indexOf('sha256sum -c -'));
  });

  it('scans each event range redacted, prints counts per rule id and publishes nothing', () => {
    const run = String(step('Scan the change range')?.['run']);
    for (const fragment of [
      'set -euo pipefail',
      'pull_request) base="$PR_BASE_SHA"; head="$PR_HEAD_SHA"',
      'merge_group) base="$MERGE_GROUP_BASE_SHA"; head="$MERGE_GROUP_HEAD_SHA"',
      'push) base="$PUSH_BEFORE_SHA"; head="$PUSH_AFTER_SHA"',
      '--log-opts="${base}..${head}" --config .gitleaks.toml --redact --no-banner',
      '--report-format json --report-path "$report" --exit-code 42',
      'group_by(.RuleID)',
    ]) {
      expect(run, fragment).toContain(fragment);
    }
    // Event values reach the shell through env only, never as expressions inside run:.
    expect(steps.filter((entry) => /\$\{\{/.test(String(entry['run'] ?? ''))).map((entry) => entry['name'])).toEqual([]);
    const jobText = JSON.stringify(job);
    for (const forbidden of ['upload-artifact', 'upload-sarif', 'sarif', 'gh pr comment', '--verbose']) {
      expect(jobText, forbidden).not.toContain(forbidden);
    }
  });
});

interface FakeGitleaks {
  bin: string;
  calls: string;
}

/** A stand-in for gitleaks: prints a version, logs its arguments, may copy a report, exits as told. */
function writeFakeGitleaks(dir: string, options: { version: string; exit?: number; report?: unknown }): FakeGitleaks {
  const bin = join(dir, 'fake-gitleaks');
  const calls = join(dir, 'fake-gitleaks-calls.log');
  const reportSource = join(dir, 'fake-gitleaks-report.json');
  if (options.report !== undefined) writeFileSync(reportSource, JSON.stringify(options.report));
  writeFileSync(bin, [
    '#!/bin/sh',
    `if [ "$1" = "version" ]; then printf '%s\\n' '${options.version}'; exit 0; fi`,
    `printf '%s\\n' "$*" >> '${calls}'`,
    'report=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--report-path" ]; then report="$2"; fi',
    '  shift',
    'done',
    options.report === undefined ? ':' : `cp '${reportSource}' "$report"`,
    `exit ${options.exit ?? 0}`,
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return { bin, calls };
}

describe('pre-push gitleaks step', () => {
  let root: string;
  let repo: string;
  let first: string;
  let second: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'whatsoup-gitleaks-step-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]): string => execFileSync('git', args, {
      cwd: repo,
      env: isolatedGitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Guard Test');
    git('config', 'user.email', 'guard@users.noreply.github.com');
    writeFileSync(join(repo, 'notes.txt'), 'one\n');
    git('add', 'notes.txt');
    git('commit', '-q', '-m', 'first');
    first = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'notes.txt'), 'two\n');
    git('commit', '-q', '-am', 'second');
    second = git('rev-parse', 'HEAD');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const envFor = (bin: string, required = ''): NodeJS.ProcessEnv =>
    isolatedGitEnv({ WHATSOUP_GITLEAKS: bin, WHATSOUP_REQUIRE_GITLEAKS: required });
  const update = (local: string, remote: string): string => `refs/heads/topic ${local} refs/heads/topic ${remote}`;
  const logOptionsOf = (calls: string): Array<string | undefined> =>
    readFileSync(calls, 'utf8').trim().split('\n').map((line) => /--log-opts (.+?) --config /.exec(line)?.[1]);

  it('skips with one line when no gitleaks runs, and refuses under WHATSOUP_REQUIRE_GITLEAKS=1', () => {
    const absent = join(root, 'no-such-gitleaks');
    expect(captureErrors(() => runGitleaksStep(update(second, first), repo, 'origin', envFor(absent)))).toEqual([
      'pre-push guard: secret scan skipped: gitleaks is not on PATH (or at WHATSOUP_GITLEAKS) or does not run '
        + '(WHATSOUP_REQUIRE_GITLEAKS=1 makes this a failure)',
    ]);
    expect(() => runGitleaksStep(update(second, first), repo, 'origin', envFor(absent, '1'))).toThrow(new Error(
      'pre-push guard: gitleaks is not on PATH (or at WHATSOUP_GITLEAKS) or does not run; '
        + 'WHATSOUP_REQUIRE_GITLEAKS=1 refuses the push',
    ));
  });

  it.each([
    ['8.29.0', 'gitleaks 8.29.0 is not the pinned 8.30.1'],
    ['zorblab-build', 'gitleaks of an unrecognised version is not the pinned 8.30.1'],
  ])('treats version %s as a different binary: skipped, or refused when required', (version, problem) => {
    const fake = writeFakeGitleaks(root, { version });
    expect(captureErrors(() => runGitleaksStep(update(second, first), repo, 'origin', envFor(fake.bin)))).toEqual([
      `pre-push guard: secret scan skipped: ${problem} (WHATSOUP_REQUIRE_GITLEAKS=1 makes this a failure)`,
    ]);
    expect(() => runGitleaksStep(update(second, first), repo, 'origin', envFor(fake.bin, '1'))).toThrow(
      new Error(`pre-push guard: ${problem}; WHATSOUP_REQUIRE_GITLEAKS=1 refuses the push`),
    );
    expect(existsSync(fake.calls)).toBe(false);
  });

  it.each(['8.30.1', 'v8.30.1'])('scans exactly old..new with the pinned release (reported as %s)', (version) => {
    const fake = writeFakeGitleaks(root, { version });
    expect(captureErrors(() => runGitleaksStep(update(second, first), repo, 'origin', envFor(fake.bin)))).toEqual([
      `pre-push guard: gitleaks ${GITLEAKS_VERSION} found no leaks in 1 pushed range(s)`,
    ]);
    const calls = readFileSync(fake.calls, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(new RegExp(
      `^git --log-opts ${first}\\.\\.${second} --config ${escapeRegex(join(repo, '.gitleaks.toml'))} `
        + '--redact --no-banner --log-level error --report-format json --report-path \\S+report-0\\.json '
        + '--exit-code 42 \\.$',
    ));
  });

  it('scans a new ref, or an old tip this clone lacks, against the remote tracking refs only', () => {
    const fake = writeFakeGitleaks(root, { version: GITLEAKS_VERSION });
    captureErrors(() => {
      runGitleaksStep(update(second, ZERO_SHA), repo, 'origin', envFor(fake.bin));
      runGitleaksStep(update(second, 'c'.repeat(40)), repo, 'origin', envFor(fake.bin));
      runGitleaksStep(update(second, ZERO_SHA), repo, 'https://example.invalid/repo.git', envFor(fake.bin));
      runGitleaksStep('', repo, 'origin', envFor(fake.bin));
    });
    expect(logOptionsOf(fake.calls)).toEqual([
      `${second} --not --remotes=origin`,
      `${second} --not --remotes=origin`,
      `${second} --not --remotes`,
      'HEAD --not --remotes=origin',
    ]);
  });

  it('refuses leaks with counts per rule id and never prints what the report holds', () => {
    const finding = { File: 'conf/zorblab.env', Secret: 'REDACTED', Match: 'value zqline', Commit: second, Author: 'quorpine' };
    const fake = writeFakeGitleaks(root, {
      version: GITLEAKS_VERSION,
      exit: 42,
      report: [
        { ...finding, RuleID: 'generic-api-key' },
        { ...finding, RuleID: 'generic-api-key' },
        { ...finding, RuleID: 'zorblab rule/../x' },
      ],
    });
    let message = '';
    const errors = captureErrors(() => {
      try {
        runGitleaksStep(update(second, first), repo, 'origin', envFor(fake.bin));
      } catch (error) {
        message = (error as Error).message;
      }
    });
    expect(message).toBe(
      'pre-push guard: gitleaks found 3 leak(s) in the pushed commits (generic-api-key 2, unnamed-rule 1); push refused',
    );
    expect(errors).toEqual([]);
    for (const leaked of ['zorblab', 'zqline', 'quorpine', 'conf/', 'REDACTED', first, second]) {
      expect(message, leaked).not.toContain(leaked);
    }
  });

  it.each([
    [1, undefined],
    [42, undefined],
    [42, []],
  ])('refuses with fixed text when gitleaks exits %s without listing a finding', (exit, report) => {
    const fake = writeFakeGitleaks(root, { version: GITLEAKS_VERSION, exit, ...(report === undefined ? {} : { report }) });
    expect(() => captureErrors(() => runGitleaksStep(update(second, first), repo, 'origin', envFor(fake.bin)))).toThrow(
      new Error(`pre-push guard: gitleaks did not complete (exit ${exit}); push refused`),
    );
  });

  it('runs inside runPrePushGuard after the console check and before the composite', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const npmCalls = join(root, 'npm-calls.log');
    writeFileSync(join(bin, 'npm'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${npmCalls}'`, 'exit 0', ''].join('\n'));
    chmodSync(join(bin, 'npm'), 0o755);
    const savedPath = process.env['PATH'];
    const savedRequire = process.env['WHATSOUP_REQUIRE_GITLEAKS'];
    const events: string[] = [];
    process.env['PATH'] = `${bin}:${savedPath ?? ''}`;
    // The suite setup points WHATSOUP_GITLEAKS at an absent path, so the required step refuses.
    process.env['WHATSOUP_REQUIRE_GITLEAKS'] = '1';
    try {
      expect(() => captureErrors(() => runPrePushGuard(
        `refs/heads/feature/example ${'a'.repeat(40)} refs/heads/feature/example ${ZERO_SHA}`,
        repoRoot,
        { assertConsoleDependencies: () => { events.push('console'); } },
      ))).toThrow('WHATSOUP_REQUIRE_GITLEAKS=1 refuses the push');
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
      if (savedRequire === undefined) delete process.env['WHATSOUP_REQUIRE_GITLEAKS'];
      else process.env['WHATSOUP_REQUIRE_GITLEAKS'] = savedRequire;
    }
    expect(events).toEqual(['console']);
    expect(readFileSync(npmCalls, 'utf8').trim().split('\n')).toEqual([
      'run guard:git-estate -- guard --phase pre-push --push-local-ref refs/heads/feature/example',
    ]);
  });
});
