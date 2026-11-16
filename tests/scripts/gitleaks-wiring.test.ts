/**
 * gitleaks wiring.
 *
 * - `.gitleaks.toml` holds only the default rules and one path allowlist (a strict parse of the
 *   whole file refuses any other table, key or string form, at any indent), and that allowlist
 *   names exactly the tracked paths the repository hygiene check exempts from secret shapes,
 *   judged path by path.
 * - The Quality workflow's `gitleaks` job keeps its supply-chain and output contract: its scan
 *   step prints the finding count only and keeps the scanner's own output in RUNNER_TEMP (the
 *   step's script runs here under bash with a fake gitleaks).
 * - The pre-push step (scripts/pre-push-guard.ts) runs only the pinned release, scans exactly
 *   the pushed commits and prints counts, and only rule ids of a neutral shape that no term or
 *   fallback rule matches.
 *
 * No test runs a real gitleaks: the suite setup points WHATSOUP_GITLEAKS at an absent path and
 * these tests point it, or PATH, at a fake script.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { isFixtureFile, privateHostLabels } from '../../scripts/lib/repo-hygiene-policy.ts';
import { GITLEAKS_VERSION, runGitleaksStep, runPrePushGuard, ZERO_SHA } from '../../scripts/pre-push-guard.ts';
import { isolatedGitEnv } from '../helpers/isolated-git-env.ts';
import { SYNTHETIC_PRIVATE_TERMS_FILE } from '../helpers/private-terms-env.ts';

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

interface GitleaksAllowlist {
  readonly description: string | null;
  readonly paths: readonly string[];
}

/**
 * Parses .gitleaks.toml strictly. The file may hold only comments, an [extend] table whose one key
 * is `useDefault = true`, and one [[allowlists]] table whose only keys are `description` (one plain
 * double-quoted string) and `paths` (one '''…''' literal per line). Any other line, at any indent,
 * throws: another table, another key, `useDefault = false`, an [extend] `path`, or a path in any
 * other string form.
 */
function parseGitleaksConfig(text: string): { readonly allowlists: readonly GitleaksAllowlist[] } {
  let section: 'top' | 'extend' | 'allowlists' | 'paths' = 'top';
  let extendSeen = false;
  let useDefault = false;
  const allowlists: Array<{ description: string | null; paths: string[] | null }> = [];
  const blankOrComment = /^\s*(?:#.*)?$/;
  for (const [index, line] of text.split('\n').entries()) {
    const refusal = new Error(`.gitleaks.toml line ${index + 1} is not allowed`);
    const current = allowlists[allowlists.length - 1];
    if (section === 'paths') {
      if (line === ']') {
        section = 'allowlists';
        continue;
      }
      const entry = /^ {2}'''([^']+)''',$/.exec(line);
      if (entry !== null && current !== undefined && current.paths !== null) {
        current.paths.push(entry[1]!);
        continue;
      }
      if (blankOrComment.test(line)) continue;
      throw refusal;
    }
    if (blankOrComment.test(line)) continue;
    if (line === '[extend]' && !extendSeen) {
      extendSeen = true;
      section = 'extend';
      continue;
    }
    if (line === '[[allowlists]]' && allowlists.length === 0) {
      allowlists.push({ description: null, paths: null });
      section = 'allowlists';
      continue;
    }
    if (section === 'extend' && line === 'useDefault = true' && !useDefault) {
      useDefault = true;
      continue;
    }
    if (section === 'allowlists' && current !== undefined) {
      const description = /^description = "([^"\\]*)"$/.exec(line);
      if (description !== null && current.description === null) {
        current.description = description[1]!;
        continue;
      }
      if (line === 'paths = [' && current.paths === null) {
        current.paths = [];
        section = 'paths';
        continue;
      }
    }
    throw refusal;
  }
  if (section === 'paths' || !useDefault || allowlists.some((table) => table.paths === null || table.paths.length === 0)) {
    throw new Error('.gitleaks.toml is incomplete');
  }
  return { allowlists: allowlists.map((table) => ({ description: table.description, paths: table.paths! })) };
}

describe('.gitleaks.toml', () => {
  const config = readFileSync(resolve(repoRoot, '.gitleaks.toml'), 'utf8');
  const parsed = parseGitleaksConfig(config);
  const allowlisted = parsed.allowlists.flatMap((table) => table.paths).map((source) => new RegExp(source));

  it('extends the default rule set with one path-only allowlist table', () => {
    expect(config).toMatch(/^\[extend\]\nuseDefault = true$/m);
    expect(config.match(/^\[\[allowlists\]\]$/gm)).toEqual(['[[allowlists]]']);
    expect(config).not.toMatch(/^\[allowlist\]$/m);
    expect(config).not.toMatch(/^(?:regexes|stopwords|commits|targetRules|regexTarget|condition|disabledRules)\s*=/m);
    expect(parsed.allowlists).toHaveLength(1);
    expect(allowlisted).toHaveLength(8);
  });

  // Each change would add a rule, drop the default rules or widen the allowlist past the fixture
  // paths. The strict parse refuses every one, at the start of a line and indented.
  const insertAfter = (anchor: string, line: string): string => {
    if (!config.includes(`${anchor}\n`)) throw new Error(`.gitleaks.toml lacks the line ${anchor}`);
    return config.replace(`${anchor}\n`, `${anchor}\n${line}\n`);
  };
  type Mutation = (indent: string) => string;
  const FORBIDDEN: ReadonlyArray<readonly [string, Mutation]> = [
    ['a [[rules]] table', (indent) => `${config}\n${indent}[[rules]]\n${indent}id = "custom"\n${indent}regex = '''x'''\n`],
    ['an [allowlist] table', (indent) => `${config}\n${indent}[allowlist]\n${indent}paths = ['''.*''']\n`],
    ['a second [[allowlists]] table', (indent) => `${config}\n${indent}[[allowlists]]\n${indent}paths = ['''.*''']\n`],
    ['a top-level key', (indent) => `${indent}title = "custom"\n${config}`],
    ['an allowlist regexes key', (indent) => insertAfter('[[allowlists]]', `${indent}regexes = ['''zorblab''']`)],
    ['an allowlist stopwords key', (indent) => insertAfter('[[allowlists]]', `${indent}stopwords = ['''key''']`)],
    ['an allowlist commits key', (indent) => insertAfter('[[allowlists]]', `${indent}commits = ['''0123456789abcdef''']`)],
    ['an allowlist targetRules key', (indent) => insertAfter('[[allowlists]]', `${indent}targetRules = ['''generic-api-key''']`)],
    ['an allowlist condition key', (indent) => insertAfter('[[allowlists]]', `${indent}condition = "AND"`)],
    ['an allowlist regexTarget key', (indent) => insertAfter('[[allowlists]]', `${indent}regexTarget = "line"`)],
    ['an [extend] disabledRules key', (indent) => insertAfter('[extend]', `${indent}disabledRules = ['''generic-api-key''']`)],
    ['an [extend] path key', (indent) => insertAfter('[extend]', `${indent}path = '''other.toml'''`)],
    ['useDefault = false', (indent) => config.replace('useDefault = true\n', `${indent}useDefault = false\n`)],
    ['a double-quoted path entry', (indent) => insertAfter('paths = [', `${indent}".*",`)],
    ['a single-quoted path entry', (indent) => insertAfter('paths = [', `${indent}'.*',`)],
    ['a multi-line basic string path entry', (indent) => insertAfter('paths = [', `${indent}""".*""",`)],
  ];
  const CASES: Array<[string, Mutation, string]> = FORBIDDEN.flatMap(([label, mutate]): Array<[string, Mutation, string]> => [
    [label, mutate, ''],
    [`${label}, indented`, mutate, '  '],
  ]);

  it.each(CASES)('refuses %s', (_label, mutate, indent) => {
    const mutated = mutate(indent);
    expect(mutated).not.toBe(config);
    expect(() => parseGitleaksConfig(mutated)).toThrow(/\.gitleaks\.toml/);
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
    // An absent fragment's index is -1, which the order checks below would pass, so each must be present first.
    for (const fragment of ['curl --fail', 'sha256sum -c -', 'tar -xzf']) expect(run, fragment).toContain(fragment);
    expect(run.indexOf('sha256sum -c -')).toBeGreaterThan(run.indexOf('curl --fail'));
    expect(run.indexOf('tar -xzf')).toBeGreaterThan(run.indexOf('sha256sum -c -'));
  });

  it('scans each event range redacted, prints the finding count only and publishes nothing', () => {
    const run = String(step('Scan the change range')?.['run']);
    for (const fragment of [
      'set -euo pipefail',
      'pull_request) base="$PR_BASE_SHA"; head="$PR_HEAD_SHA"',
      'merge_group) base="$MERGE_GROUP_BASE_SHA"; head="$MERGE_GROUP_HEAD_SHA"',
      'push) base="$PUSH_BEFORE_SHA"; head="$PUSH_AFTER_SHA"',
      '--log-opts="${base}..${head}" --config "$config" --ignore-gitleaks-allow',
      '--gitleaks-ignore-path "$ignore_dir" --redact --no-banner',
      'ignore_dir="$(mktemp -d "$RUNNER_TEMP/gitleaks-ignore.XXXXXX")"',
      // A pull request or merge group is judged by the base commit's configuration, failing closed.
      'if [ "$EVENT_NAME" = "pull_request" ] || [ "$EVENT_NAME" = "merge_group" ]; then',
      'if git cat-file -e "${base}^{commit}" 2>/dev/null && ! git cat-file -e "${base}:.gitleaks.toml" 2>/dev/null; then',
      'config="$RUNNER_TEMP/gitleaks-base.toml"',
      'if ! git show "${base}:.gitleaks.toml" > "$config" 2>/dev/null; then',
      'if [ -e .gitleaksignore ] || [ -L .gitleaksignore ]; then',
      '--report-format json --report-path "$report" --exit-code 42 . > "$scan_log" 2>&1',
      `count="$(jq 'length' "$report" 2>/dev/null)"`,
      'echo "gitleaks: the pre-push secret scan shows the rule ids on a local push"',
    ]) {
      expect(run, fragment).toContain(fragment);
    }
    // No rule id reaches the log (a custom rule's id can itself be a secret or a private name),
    // and the scanner runs only once, with its output captured.
    expect(run).not.toContain('RuleID');
    expect(run.match(/^[ \t]*gitleaks /gm)).toHaveLength(1);
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
  /** What the folder named by --gitleaks-ignore-path held (`missing` when it was no folder). */
  ignoreListing: string;
}

/**
 * A stand-in for gitleaks: prints a version, logs its arguments, may copy a report, may print
 * `noise` on stdout and stderr (as a scanner error would), exits as told.
 */
function writeFakeGitleaks(
  dir: string,
  options: { version: string; exit?: number; report?: unknown; noise?: string; name?: string },
): FakeGitleaks {
  const bin = join(dir, options.name ?? 'fake-gitleaks');
  const calls = join(dir, 'fake-gitleaks-calls.log');
  const ignoreListing = join(dir, 'fake-gitleaks-ignore-listing.txt');
  const reportSource = join(dir, 'fake-gitleaks-report.json');
  if (options.report !== undefined) writeFileSync(reportSource, JSON.stringify(options.report));
  writeFileSync(bin, [
    '#!/bin/sh',
    `if [ "$1" = "version" ]; then printf '%s\\n' '${options.version}'; exit 0; fi`,
    `printf '%s\\n' "$*" >> '${calls}'`,
    'report=""',
    'ignore=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--report-path" ]; then report="$2"; fi',
    '  if [ "$1" = "--gitleaks-ignore-path" ]; then ignore="$2"; fi',
    '  shift',
    'done',
    `if [ -n "$ignore" ]; then if [ -d "$ignore" ]; then ls -A "$ignore"; else echo missing; fi > '${ignoreListing}'; fi`,
    options.report === undefined ? ':' : `cp '${reportSource}' "$report"`,
    options.noise === undefined ? ':' : `printf '%s\\n' '${options.noise}'; printf '%s\\n' '${options.noise}' >&2`,
    `exit ${options.exit ?? 0}`,
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return { bin, calls, ignoreListing };
}

describe('Quality workflow scan step, run under bash with a fake gitleaks on PATH', () => {
  const workflow = parse(readFileSync(resolve(repoRoot, '.github/workflows/quality.yml'), 'utf8')) as {
    jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
  };
  const scanScript = String(workflow.jobs['gitleaks']!.steps.find((entry) => entry['name'] === 'Scan the change range')?.['run']);
  let root: string;
  let repo: string;
  let bin: string;
  let runnerTemp: string;
  const commits: Record<'plain' | 'base' | 'head', string> = { plain: '', base: '', head: '' };

  // Three commits: `plain` has no .gitleaks.toml, `base` adds one, `head` changes it.
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'whatsoup-gitleaks-ci-'));
    repo = join(root, 'repo');
    bin = join(root, 'bin');
    runnerTemp = join(root, 'runner-temp');
    for (const dir of [repo, bin, runnerTemp]) mkdirSync(dir);
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
    git('commit', '-q', '-m', 'plain');
    commits.plain = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, '.gitleaks.toml'), '# base config\n');
    git('add', '.gitleaks.toml');
    git('commit', '-q', '-m', 'base');
    commits.base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, '.gitleaks.toml'), '# head config\n');
    git('commit', '-q', '-am', 'head');
    commits.head = git('rev-parse', 'HEAD');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Runs the step's script as the job does: bash, the step's env values, RUNNER_TEMP, PATH. */
  const runScan = (event: Record<string, string>): { status: number | null; lines: string[] } => {
    const result = spawnSync('bash', ['-c', scanScript], {
      cwd: repo,
      env: {
        ...isolatedGitEnv(),
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        RUNNER_TEMP: runnerTemp,
        PR_BASE_SHA: '',
        PR_HEAD_SHA: '',
        MERGE_GROUP_BASE_SHA: '',
        MERGE_GROUP_HEAD_SHA: '',
        PUSH_BEFORE_SHA: '',
        PUSH_AFTER_SHA: '',
        ...event,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, lines: `${result.stdout}${result.stderr}`.split('\n').filter((line) => line !== '') };
  };
  const pushEvent = (): Record<string, string> => ({ EVENT_NAME: 'push', PUSH_BEFORE_SHA: commits.base, PUSH_AFTER_SHA: commits.head });

  it('prints one fixed line with the exit code on a scanner error, never the scanner\'s own output', () => {
    writeFakeGitleaks(bin, { name: 'gitleaks', version: GITLEAKS_VERSION, exit: 1, noise: 'config error in zorblab.toml near zqline' });
    const result = runScan(pushEvent());
    expect(result.status).toBe(1);
    expect(result.lines).toEqual(['gitleaks: the scan did not complete (exit 1)']);
  });

  it('prints the finding count only: no rule id, no report text and no scanner output', () => {
    const finding = { File: 'conf/zorblab.env', Secret: 'REDACTED', Match: 'value zqline', Commit: commits.head, Author: 'quorpine' };
    writeFakeGitleaks(bin, {
      name: 'gitleaks',
      version: GITLEAKS_VERSION,
      exit: 42,
      noise: 'leak in zorblab',
      report: [{ ...finding, RuleID: 'zorblab-token' }, { ...finding, RuleID: 'generic-api-key' }],
    });
    const result = runScan(pushEvent());
    expect(result.status).toBe(1);
    // The count comes from jq, as in the job; it reads '?' where no jq can read the report.
    expect(result.lines).toEqual([
      expect.stringMatching(new RegExp(`^gitleaks: (?:2|\\?) finding\\(s\\) in ${commits.base}\\.\\.${commits.head}; rule ids and matched text withheld$`)),
      'gitleaks: the pre-push secret scan shows the rule ids on a local push',
    ]);
    const output = result.lines.join('\n');
    for (const leaked of ['zorblab', 'zqline', 'quorpine', 'generic-api-key', 'conf/', 'REDACTED']) {
      expect(output, leaked).not.toContain(leaked);
    }
  });

  /** The value the scanner got for `flag`, from the fake's call log. */
  const argOf = (fake: FakeGitleaks, flag: string): string | undefined =>
    new RegExp(`(?:^| )${escapeRegex(flag)} (\\S+)`).exec(readFileSync(fake.calls, 'utf8'))?.[1];

  it.each([
    ['pull_request', 'PR'],
    ['merge_group', 'MERGE_GROUP'],
  ])('judges a %s with the base commit\'s .gitleaks.toml, and lets no allow comment or ignore file suppress a finding', (eventName, prefix) => {
    const fake = writeFakeGitleaks(bin, { name: 'gitleaks', version: GITLEAKS_VERSION });
    const result = runScan({ EVENT_NAME: eventName, [`${prefix}_BASE_SHA`]: commits.base, [`${prefix}_HEAD_SHA`]: commits.head });
    expect(result).toEqual({ status: 0, lines: [`gitleaks: no findings in ${commits.base}..${commits.head}`] });
    const config = argOf(fake, '--config')!;
    expect(config).toBe(join(runnerTemp, 'gitleaks-base.toml'));
    expect(readFileSync(config, 'utf8')).toBe('# base config\n');
    expect(readFileSync(fake.calls, 'utf8')).toContain(' --ignore-gitleaks-allow --gitleaks-ignore-path ');
    expect(argOf(fake, '--gitleaks-ignore-path')!.startsWith(join(runnerTemp, 'gitleaks-ignore.'))).toBe(true);
    expect(readFileSync(fake.ignoreListing, 'utf8')).toBe('');
  });

  it('uses the change\'s own .gitleaks.toml only when the base commit has none, and says so', () => {
    const fake = writeFakeGitleaks(bin, { name: 'gitleaks', version: GITLEAKS_VERSION });
    const result = runScan({ EVENT_NAME: 'pull_request', PR_BASE_SHA: commits.plain, PR_HEAD_SHA: commits.base });
    expect(result).toEqual({
      status: 0,
      lines: [
        'gitleaks: the base commit has no .gitleaks.toml, so the change\'s own copy is used (true only for the change that adds it)',
        `gitleaks: no findings in ${commits.plain}..${commits.base}`,
      ],
    });
    expect(argOf(fake, '--config')).toBe('.gitleaks.toml');
  });

  it.each([
    ['a base commit missing from the checkout', 'c'.repeat(40)],
    ['a base that names no commit', 'not-a-commit'],
  ])('fails closed with one fixed line on %s, before any scan', (_label, base) => {
    const fake = writeFakeGitleaks(bin, { name: 'gitleaks', version: GITLEAKS_VERSION });
    const result = runScan({ EVENT_NAME: 'pull_request', PR_BASE_SHA: base, PR_HEAD_SHA: commits.head });
    expect(result).toEqual({
      status: 1,
      lines: ['gitleaks: cannot read .gitleaks.toml from the base commit; the scan fails closed'],
    });
    expect(existsSync(fake.calls)).toBe(false);
  });

  // Events are built when each case runs: the commits exist only after beforeEach.
  it.each<[string, () => Record<string, string>]>([
    ['a pull_request with an empty base', () => ({ EVENT_NAME: 'pull_request', PR_BASE_SHA: '', PR_HEAD_SHA: commits.head })],
    ['a merge_group with an empty head', () => ({ EVENT_NAME: 'merge_group', MERGE_GROUP_BASE_SHA: commits.base, MERGE_GROUP_HEAD_SHA: '' })],
    ['a pull_request with an all-zero base', () => ({ EVENT_NAME: 'pull_request', PR_BASE_SHA: ZERO_SHA, PR_HEAD_SHA: commits.head })],
  ])('fails closed with one fixed line on %s, before any scan', (_label, event) => {
    const fake = writeFakeGitleaks(bin, { name: 'gitleaks', version: GITLEAKS_VERSION });
    expect(runScan(event())).toEqual({
      status: 1,
      lines: ['gitleaks: the event gives no complete change range (an empty base or head, or an all-zero base); the scan fails closed'],
    });
    expect(existsSync(fake.calls)).toBe(false);
  });

  it('still lets a push with an all-zero before pass with the nothing-to-scan line', () => {
    const fake = writeFakeGitleaks(bin, { name: 'gitleaks', version: GITLEAKS_VERSION });
    expect(runScan({ EVENT_NAME: 'push', PUSH_BEFORE_SHA: ZERO_SHA, PUSH_AFTER_SHA: commits.head })).toEqual({
      status: 0,
      lines: ['gitleaks: the push event names no change range; nothing to scan'],
    });
    expect(existsSync(fake.calls)).toBe(false);
  });

  it('scans a push with the pushed commit\'s own .gitleaks.toml and an empty ignore folder', () => {
    const fake = writeFakeGitleaks(bin, { name: 'gitleaks', version: GITLEAKS_VERSION });
    expect(runScan(pushEvent())).toEqual({ status: 0, lines: [`gitleaks: no findings in ${commits.base}..${commits.head}`] });
    expect(argOf(fake, '--config')).toBe('.gitleaks.toml');
    expect(readFileSync(fake.ignoreListing, 'utf8')).toBe('');
  });

  it('refuses a checkout that holds a .gitleaksignore, which gitleaks reads from the scanned folder whatever -i names', () => {
    const fake = writeFakeGitleaks(bin, { name: 'gitleaks', version: GITLEAKS_VERSION });
    writeFileSync(join(repo, '.gitleaksignore'), 'notes.txt:generic-api-key:1\n');
    for (const event of [pushEvent(), { EVENT_NAME: 'pull_request', PR_BASE_SHA: commits.base, PR_HEAD_SHA: commits.head }]) {
      expect(runScan(event)).toEqual({
        status: 1,
        lines: ['gitleaks: the checkout holds a .gitleaksignore, which would suppress findings; the scan fails closed'],
      });
    }
    expect(existsSync(fake.calls)).toBe(false);
  });
});

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
        + '--ignore-gitleaks-allow --gitleaks-ignore-path \\S+ '
        + '--redact --no-banner --log-level error --report-format json --report-path \\S+report-0\\.json '
        + '--exit-code 42 \\.$',
    ));
  });

  it('lets no allow comment or ignore file suppress a finding, as the Quality job does', () => {
    const fake = writeFakeGitleaks(root, { version: GITLEAKS_VERSION });
    captureErrors(() => runGitleaksStep(update(second, first), repo, 'origin', envFor(fake.bin)));
    const call = readFileSync(fake.calls, 'utf8');
    expect(call).toContain(' --ignore-gitleaks-allow --gitleaks-ignore-path ');
    // Its own empty folder, removed with the step's temporary folder.
    const ignorePath = /--gitleaks-ignore-path (\S+) /.exec(call)?.[1];
    expect(ignorePath).toBeDefined();
    expect(readFileSync(fake.ignoreListing, 'utf8')).toBe('');
    expect(existsSync(ignorePath!)).toBe(false);

    // gitleaks reads .gitleaksignore from the folder it scans whatever -i names, so the step refuses one.
    rmSync(fake.calls);
    writeFileSync(join(repo, '.gitleaksignore'), 'notes.txt:generic-api-key:1\n');
    expect(() => captureErrors(() => runGitleaksStep(update(second, first), repo, 'origin', envFor(fake.bin)))).toThrow(new Error(
      'pre-push guard: a .gitleaksignore at the top of the working tree would suppress gitleaks findings; push refused',
    ));
    expect(existsSync(fake.calls)).toBe(false);
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

  it('prints a rule id only in a neutral shape that no term or fallback rule matches, and never the scanner\'s output', () => {
    // A fallback label read from the inline list at runtime, never spelled in this file.
    const fallbackLabel = privateHostLabels[0]!;
    const finding = { File: 'notes.txt', Secret: 'REDACTED', Commit: second };
    const fake = writeFakeGitleaks(root, {
      version: GITLEAKS_VERSION,
      exit: 42,
      noise: 'leak in zorblab',
      report: [
        { ...finding, RuleID: 'generic-api-key' },
        { ...finding, RuleID: 'zorblab-token' },
        { ...finding, RuleID: `${fallbackLabel}-token` },
        { ...finding, RuleID: 'Generic-Api-Key' },
        { ...finding, RuleID: 'generic--key' },
        { ...finding, RuleID: 'generic.key' },
        { ...finding, RuleID: 'k'.repeat(65) },
        { ...finding, RuleID: 7 },
        { ...finding, RuleID: 'zorblab' },
        { ...finding, RuleID: 'Zorblab' },
        { ...finding, RuleID: '' },
      ],
    });
    const env = isolatedGitEnv({
      WHATSOUP_GITLEAKS: fake.bin,
      WHATSOUP_REQUIRE_GITLEAKS: '',
      WHATSOUP_PRIVATE_TERMS_FILE: SYNTHETIC_PRIVATE_TERMS_FILE,
    });
    const refusal = (stepEnv: NodeJS.ProcessEnv): { message: string; errors: string[] } => {
      let message = '';
      const errors = captureErrors(() => {
        try {
          runGitleaksStep(update(second, first), repo, 'origin', stepEnv);
        } catch (error) {
          message = (error as Error).message;
        }
      });
      return { message, errors };
    };

    const leaks = refusal(env);
    expect(leaks).toEqual({
      message: 'pre-push guard: gitleaks found 11 leak(s) in the pushed commits (generic-api-key 1, unnamed-rule 10); push refused',
      errors: [],
    });
    // Neither a term, in any case, nor a fallback label reaches the output.
    for (const leaked of ['zorblab', fallbackLabel]) expect(leaks.message.toLowerCase()).not.toContain(leaked.toLowerCase());

    // A term file that cannot be loaded leaves no way to check an id, so none is printed.
    const brokenTerms = join(root, 'broken-terms.json');
    writeFileSync(brokenTerms, '{');
    expect(refusal({ ...env, WHATSOUP_PRIVATE_TERMS_FILE: brokenTerms })).toEqual({
      message: 'pre-push guard: gitleaks found 11 leak(s) in the pushed commits (unnamed-rule 11); push refused',
      errors: [],
    });
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

  it('runs inside runPrePushGuard after the console check and the ref-name scan, before the composite', () => {
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
    // Order: the estate gate, the ref-name scan (through its temporary file), then the refused
    // secret scan; the composite never starts.
    expect(readFileSync(npmCalls, 'utf8').trim().split('\n')).toEqual([
      'run guard:git-estate -- guard --phase pre-push --push-local-ref refs/heads/feature/example',
      expect.stringMatching(/^run guard:repo:refs -- \S+\/refs\.txt$/),
    ]);
  });
});
