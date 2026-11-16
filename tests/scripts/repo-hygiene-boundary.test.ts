import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseBoundaryBaseline, refNamesByLine } from '../../scripts/lib/repo-hygiene-boundary.ts';
import {
  canonicalRepoHygienePolicyProjection,
  createRepoHygieneExactRangeArtifact,
  currentRepoHygienePolicyDigest,
  currentRepoHygieneToolDigest,
  main,
  privateHostLabels,
  run,
  scanCommitAuthors,
  validateRepoHygieneExactRangeArtifact,
} from '../../scripts/repo-hygiene-guard.ts';
import { loadPrivateTerms, requirePrivateTermsUsable } from '../../scripts/lib/private-terms.ts';
import { adaptRepoHygieneExactRangeReportOnly } from '../../scripts/lib/ci-control/native-adapter.ts';
import { isolatedGitEnv } from '../helpers/isolated-git-env.ts';
import { ABSENT_PRIVATE_TERMS_FILE, SYNTHETIC_PRIVATE_TERMS_FILE } from '../helpers/private-terms-env.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('repo-hygiene-boundary-');

// Every synthetic term id and value: no output line of any mode may contain one.
const SYNTHETIC_IDS = ['M001', 'F001', 'B001', 'C001', 'P001', 'D001', 'A001', 'N001'];
const SYNTHETIC_VALUES = ['zorblab', 'zmini12', 'qx-bot', 'qxbot', 'zqline', 'quorpine', 'corp-zz.example', 'acct-zq-4471', '100.1.2.3'];
// A generic hit, assembled at runtime so this file never carries a home-folder path literally.
const HOME_PATH = ['', 'Users', 'zzhomeuser', 'notes'].join('/');
const ABSENT_NOTICE = 'private term file absent';

const TERM_LINES = [
  'ssh zorblab and zmini12',
  'restart qxbot now',
  'see whatsoup@zqline',
  'ask Quorpine',
  'mail corp-zz.example',
  'account acct-zq-4471',
  'host 100.1.2.3',
].join('\n');

function useTerms(file: string = SYNTHETIC_PRIVATE_TERMS_FILE): void {
  vi.stubEnv('WHATSOUP_PRIVATE_TERMS_FILE', file);
}

function git(cwd: string, args: string[], extra: Readonly<Record<string, string>> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: isolatedGitEnv(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// Committer dates far from any term-list epoch, so commit-text tests never depend on the clock.
const BEFORE_EPOCH = { GIT_COMMITTER_DATE: '2001-01-01 00:00:00 +0000' };
const AFTER_EPOCH = { GIT_COMMITTER_DATE: '2099-01-01 00:00:00 +0000' };

function makeRepo(): string {
  const repo = tmp.make('repo');
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'WhatSoup Guard']);
  git(repo, ['config', 'user.email', 'guard@users.noreply.github.com']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  return repo;
}

function writeFiles(repo: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
  }
}

function commit(
  repo: string,
  files: Record<string, string>,
  message = 'test: fixture',
  extra: Readonly<Record<string, string>> = {},
): string {
  writeFiles(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message], extra);
  return git(repo, ['rev-parse', 'HEAD']);
}

interface Captured {
  readonly lines: string[];
  readonly exitCode: number;
  readonly codes: string[];
}

function capture(argv: string[], cwd: string): Captured {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'error').mockImplementation(record);
  vi.spyOn(console, 'log').mockImplementation(record);
  process.exitCode = undefined;
  const issues = run(argv, cwd);
  const exitCode = Number(process.exitCode ?? 0);
  vi.restoreAllMocks();
  return { lines, exitCode, codes: issues.map((issue) => issue.code).sort() };
}

// Ids are checked case-sensitively (lower-case hex digests in the output could hold a
// lower-cased id by chance); values are checked case-insensitively.
function expectNoTermText(lines: readonly string[]): void {
  const output = lines.join('\n');
  for (const id of SYNTHETIC_IDS) {
    expect(output, `output must not contain a term id (${id.length} chars)`).not.toContain(id);
  }
  for (const value of SYNTHETIC_VALUES) {
    expect(output.toLowerCase(), `output must not contain a term value (${value.length} chars)`)
      .not.toContain(value.toLowerCase());
  }
}

const ALL_TERM_CODES = [
  'private-account-id',
  'private-domain',
  'private-host-label',
  'private-instance-label',
  'private-person',
  'private-tailnet-ip',
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('repo hygiene guard with a private term file', () => {
  it('adds the term rules to --staged and prints locations and codes only', () => {
    useTerms();
    const repo = makeRepo();
    commit(repo, { 'README.md': '# fixture\n' });
    writeFiles(repo, { 'src/leak.ts': `${TERM_LINES}\nconst clean = 1;\n` });
    git(repo, ['add', '-A']);

    const result = capture(['--staged'], repo);

    expect(result.exitCode).toBe(1);
    expect([...new Set(result.codes)]).toEqual(ALL_TERM_CODES);
    expect(result.lines.some((line) => line.startsWith('src/leak.ts:1 private-host-label:'))).toBe(true);
    expect(result.lines.some((line) => line.includes(':8 '))).toBe(false);
    expect(result.lines.join('\n')).not.toContain(ABSENT_NOTICE);
    expectNoTermText(result.lines);
  });

  it('adds the term rules to --branch-diff, including history lines removed again', () => {
    useTerms();
    const repo = makeRepo();
    commit(repo, { 'README.md': '# fixture\n' });
    git(repo, ['checkout', '-b', 'feature']);
    commit(repo, { 'src/transient.ts': 'ssh zorblab\n' });
    commit(repo, { 'src/transient.ts': 'ssh host-a\n', 'docs/note.md': 'ask Quorpine\n' });

    const result = capture(['--branch-diff', '--base', 'main'], repo);

    expect(result.exitCode).toBe(1);
    expect(result.codes).toEqual(['private-host-label', 'private-person']);
    expectNoTermText(result.lines);
  });

  it('prints the commit of a history finding, as main does (--branch-diff and --scan-history)', () => {
    useTerms();
    const repo = makeRepo();
    commit(repo, { 'README.md': '# fixture\n' });
    git(repo, ['checkout', '-b', 'feature']);
    const added = commit(repo, { 'src/transient.ts': 'ssh zorblab\n' });
    commit(repo, { 'src/transient.ts': 'ssh host-a\n' });
    const message = 'Public repo text must not include private host labels.';

    const branch = capture(['--branch-diff', '--base', 'main'], repo);
    expect(branch.exitCode).toBe(1);
    expect(branch.lines).toContain(`src/transient.ts:1 private-host-label: [branch history ${added.slice(0, 12)}] ${message}`);

    const history = capture(['--scan-history', '5'], repo);
    expect(history.exitCode).toBe(0);
    expect(history.lines).toContain(`src/transient.ts:1 private-host-label: [history ${added.slice(0, 12)}] ${message}`);
    expectNoTermText([...branch.lines, ...history.lines]);
  });

  it('adds the term rules to --commit-msg', () => {
    useTerms();
    const cwd = tmp.make('msg');
    const messageFile = join(cwd, 'COMMIT_EDITMSG');
    writeFileSync(messageFile, `fix: deploy\n\n${TERM_LINES}\n`);

    const result = capture(['--commit-msg', messageFile], cwd);

    expect(result.exitCode).toBe(1);
    expect([...new Set(result.codes)]).toEqual(ALL_TERM_CODES);
    expect(result.lines.some((line) => line.startsWith('commit-msg:3 private-host-label:'))).toBe(true);
    expectNoTermText(result.lines);
  });

  it('adds the term rules to --commit-authors messages, never to the subject in output', () => {
    useTerms();
    const repo = makeRepo();
    commit(repo, { 'README.md': '# fixture\n' });
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    commit(repo, { 'a.txt': 'a\n' }, 'fix: restart zorblab\n\nasked Quorpine', AFTER_EPOCH);

    const result = capture(['--commit-authors'], repo);

    expect(result.exitCode).toBe(1);
    expect(result.codes).toEqual(['private-host-label', 'private-person']);
    expect(result.lines.every((line) => !line.includes('restart'))).toBe(true);
    expectNoTermText(result.lines);
  });

  it('scans a text file with the generic and term rules (--text)', () => {
    useTerms();
    const cwd = tmp.make('text');
    const file = join(cwd, 'pr-body.md');
    writeFileSync(file, `Title line\n${HOME_PATH}\nclean line\nssh zorblab\n`);

    const result = capture(['--text', file], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.codes).toEqual(['local-home-path', 'private-host-label']);
    expect(result.lines).toContain('text:2 local-home-path: Public repo text must not include operator-local home paths.');
    expect(result.lines).toContain('text:4 private-host-label: Public repo text must not include private host labels.');
    expectNoTermText(result.lines);
  });

  it('scans ref names, one per line or as pre-push hook lines (--refs)', () => {
    useTerms();
    const cwd = tmp.make('refs');
    const oid = 'a'.repeat(40);
    const zero = '0'.repeat(40);
    const file = join(cwd, 'refs.txt');
    writeFileSync(file, [
      'refs/heads/feature-ok',
      'refs/heads/zorblab-fix',
      `refs/heads/topic ${oid} refs/heads/qx-bot-topic ${zero}`,
      `(delete) ${zero} refs/heads/quorpine-old ${oid}`,
      '',
    ].join('\n'));

    const result = capture(['--refs', file], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain('refs:2 private-host-label: Public repo text must not include private host labels.');
    expect(result.lines).toContain('refs:3 private-instance-label: Public repo text must not include private instance labels.');
    expect(result.lines.some((line) => line.startsWith('refs:4 '))).toBe(false);
    expectNoTermText(result.lines);
  });

  it('reads git pre-push stdin exactly: a new branch, an update, a deletion (parsed, not scanned), CRLF', () => {
    useTerms();
    const cwd = tmp.make('pre-push');
    const zero = '0'.repeat(40);
    const [one, two, three] = ['1', '2', '3'].map((digit) => digit.repeat(40));
    // git push writes `<local ref> SP <local oid> SP <remote ref> SP <remote oid> LF` per ref. A new
    // branch has a zero remote oid; a deletion has the local ref `(delete)` and a zero local oid.
    const stdin = [
      `refs/heads/zorblab-new ${one} refs/heads/zorblab-new ${zero}`,
      `refs/heads/main ${two} refs/heads/main ${three}`,
      `refs/heads/topic ${two} refs/heads/qx-bot-topic ${three}`,
      `(delete) ${zero} refs/heads/quorpine-old ${three}`,
      '',
    ].join('\r\n');
    expect(refNamesByLine(stdin)).toEqual([
      { line: 1, names: ['refs/heads/zorblab-new', 'refs/heads/zorblab-new'] },
      { line: 2, names: ['refs/heads/main', 'refs/heads/main'] },
      { line: 3, names: ['refs/heads/topic', 'refs/heads/qx-bot-topic'] },
    ]);
    const file = join(cwd, 'pre-push-stdin');
    writeFileSync(file, stdin);

    const result = capture(['--refs', file], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.lines.filter((line) => line.startsWith('refs:'))).toEqual([
      'refs:1 private-host-label: Public repo text must not include private host labels.',
      'refs:3 private-instance-label: Public repo text must not include private instance labels.',
    ]);
    expectNoTermText(result.lines);
  });

  it('passes clean text and clean ref names', () => {
    useTerms();
    const cwd = tmp.make('clean');
    writeFileSync(join(cwd, 'body.md'), 'host-a and bot-a only\n');
    writeFileSync(join(cwd, 'refs.txt'), 'refs/heads/feature-ok\n');
    expect(capture(['--text', join(cwd, 'body.md')], cwd).exitCode).toBe(0);
    expect(capture(['--refs', join(cwd, 'refs.txt')], cwd).exitCode).toBe(0);
  });
});

describe('repo hygiene guard without a private term file', () => {
  it('runs only the generic rules and says so in one line', () => {
    useTerms(ABSENT_PRIVATE_TERMS_FILE);
    const repo = makeRepo();
    commit(repo, { 'README.md': '# fixture\n' });
    writeFiles(repo, { 'src/leak.ts': `const p = '${HOME_PATH}';\nssh zorblab\n` });
    git(repo, ['add', '-A']);

    const result = capture(['--staged'], repo);

    expect(result.exitCode).toBe(1);
    expect(result.codes).toEqual(['local-home-path']);
    expect(result.lines.filter((line) => line.includes(ABSENT_NOTICE))).toHaveLength(1);
  });

  it('fails with exit 2 under WHATSOUP_REQUIRE_PRIVATE_TERMS=1 in every mode', () => {
    useTerms(ABSENT_PRIVATE_TERMS_FILE);
    vi.stubEnv('WHATSOUP_REQUIRE_PRIVATE_TERMS', '1');
    const repo = makeRepo();
    commit(repo, { 'README.md': '# fixture\n' });
    const messageFile = join(repo, 'msg.txt');
    writeFileSync(messageFile, 'fix: clean\n');
    for (const argv of [['--staged'], ['--commit-msg', messageFile], ['--tree'], ['--text', messageFile], ['--refs', messageFile]]) {
      const result = capture(argv, repo);
      expect(result.exitCode, argv.join(' ')).toBe(2);
      expect(result.lines.join('\n')).toContain('WHATSOUP_REQUIRE_PRIVATE_TERMS=1');
    }
  });

  it('fails with exit 2 for an invalid term file even without the require switch', () => {
    const file = join(tmp.make('bad'), 'private-terms.json');
    writeFileSync(file, '{"schema": "whatsoup-private-terms", "terms": [zorblab');
    useTerms(file);
    const result = capture(['--refs', file], tmp.make('cwd'));
    expect(result.exitCode).toBe(2);
    expectNoTermText(result.lines);
  });
});

describe('no output line of any mode or failure path carries a term', () => {
  // The command-line entry, in process: its error mapping is part of every mode's output.
  function captureMain(argv: string[], cwd: string): Captured {
    const lines: string[] = [];
    const record = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(console, 'log').mockImplementation(record);
    process.exitCode = undefined;
    main(argv, cwd);
    const exitCode = Number(process.exitCode ?? 0);
    vi.restoreAllMocks();
    return { lines, exitCode, codes: [] };
  }

  // A folder named after a synthetic term: every path below it holds that term.
  function privateFolder(): string {
    const folder = join(tmp.make('named'), 'zorblab');
    mkdirSync(folder);
    return folder;
  }

  it('withholds paths, refs and arguments on input, usage and unexpected-error paths', () => {
    useTerms();
    const folder = privateFolder();
    const missing = join(folder, 'zorblab.txt');
    const repo = makeRepo();
    commit(repo, { 'README.md': '# fixture\n' });
    const cases: Array<{ argv: string[]; cwd: string; exitCode: number }> = [
      { argv: ['--text', missing], cwd: folder, exitCode: 1 },
      { argv: ['--refs', missing], cwd: folder, exitCode: 1 },
      { argv: ['--commit-msg', missing], cwd: folder, exitCode: 1 },
      { argv: ['--branch-diff', '--base', 'zorblab'], cwd: repo, exitCode: 1 },
      { argv: ['--scan-history', 'zorblab'], cwd: repo, exitCode: 2 },
      { argv: ['--zorblab'], cwd: repo, exitCode: 2 },
      // Not a repository: git fails, and its error text names the folder.
      { argv: ['--staged'], cwd: folder, exitCode: 1 },
    ];
    for (const { argv, cwd, exitCode } of cases) {
      const result = captureMain(argv, cwd);
      expect(result.exitCode, argv[0]).toBe(exitCode);
      expect(result.lines.length, argv[0]).toBeGreaterThan(0);
      expectNoTermText(result.lines);
    }
    expect(captureMain(['--staged'], folder).lines.join('\n')).toContain('its text is withheld');
  });

  it('names no folder when the release-hygiene scope is empty', () => {
    useTerms();
    const repo = join(privateFolder(), 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    const result = captureMain(['--release-hygiene'], repo);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('INCONCLUSIVE');
    expectNoTermText(result.lines);
  });

  it('masks a term inside a path even where no detection rule matches the path', () => {
    useTerms();
    const repo = makeRepo();
    commit(repo, { 'README.md': '# fixture\n' });
    writeFiles(repo, { 'docs/zqline.md': 'see whatsoup@zqline\n', 'docs/myzorblab.md': 'ssh zorblab\n' });
    git(repo, ['add', '-A']);
    const result = capture(['--staged'], repo);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain('docs/<private>.md:1 private-instance-label: Public repo text must not include private instance labels.');
    expect(result.lines).toContain('docs/my<private>.md:1 private-host-label: Public repo text must not include private host labels.');
    expectNoTermText(result.lines);
  });

  it('reports a term file JSON error by position, never by its text', () => {
    const file = join(tmp.make('bad-json'), 'private-terms.json');
    writeFileSync(file, '{"schema": "whatsoup-private-terms", "terms": [zorblab]}');
    useTerms(file);
    const result = captureMain(['--refs', file], tmp.make('cwd'));
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('not valid JSON (the file named by WHATSOUP_PRIVATE_TERMS_FILE, position 47, line 1, column 48)');
    expectNoTermText(result.lines);
  });

  it('reports a term regex that does not compile by its index only', () => {
    const file = join(tmp.make('bad-regex'), 'private-terms.json');
    writeFileSync(file, JSON.stringify({
      schema: 'whatsoup-private-terms',
      version: 1,
      terms: [{ id: 'M001', class: 'machine', regex: 'zorblab(', match: 'word', case: 'sensitive' }],
    }));
    useTerms(file);
    const result = captureMain(['--text', file], tmp.make('cwd'));
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('terms[0]: regex does not compile');
    expectNoTermText(result.lines);
  });
});

describe('repo hygiene --tree and its private baseline', () => {
  // The private baseline lives outside the repository; each test names its own file.
  function useBaseline(): string {
    const file = join(tmp.make('baseline'), 'whatsoup', 'boundary-baseline.json');
    vi.stubEnv('WHATSOUP_BOUNDARY_BASELINE_FILE', file);
    return file;
  }

  function treeRepo(): string {
    const repo = makeRepo();
    commit(repo, {
      'src/a.ts': 'ssh zorblab\nssh zorblab again\nconst clean = 1;\n',
      'docs/home.md': `${HOME_PATH}\n`,
      'notes/zorblab.md': 'clean content\n',
    });
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    return repo;
  }

  const counts = (file: string): Record<string, Record<string, number>> => Object.fromEntries(
    [...parseBoundaryBaseline(readFileSync(file, 'utf8')).files].map(([key, codes]) => [key, Object.fromEntries(codes)]),
  );

  function firstBaseline(repo: string): void {
    expect(capture(['--tree', '--write-baseline', '--allow-increase'], repo).exitCode).toBe(0);
  }

  it('is skipped in one line without a term file, and fails under the require switch', () => {
    useTerms(ABSENT_PRIVATE_TERMS_FILE);
    useBaseline();
    const repo = treeRepo();
    const skipped = capture(['--tree'], repo);
    expect(skipped.exitCode).toBe(0);
    expect(skipped.lines).toHaveLength(1);
    expect(skipped.lines[0]).toContain('skipped');
    expect(capture(['--tree', '--write-baseline'], repo).exitCode).toBe(2);
    vi.stubEnv('WHATSOUP_REQUIRE_PRIVATE_TERMS', '1');
    expect(capture(['--tree'], repo).exitCode).toBe(2);
  });

  it('refuses an empty repository as INCONCLUSIVE (exit 2)', () => {
    useTerms();
    useBaseline();
    const result = capture(['--tree'], makeRepo());
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toMatch(/INCONCLUSIVE/);
  });

  it('fails every file with hits when no baseline exists, and names the first-baseline command', () => {
    useTerms();
    useBaseline();
    const repo = treeRepo();
    const result = capture(['--tree'], repo);

    expect(result.exitCode).toBe(1);
    const output = result.lines.join('\n');
    expect(output).toContain('build the first one with npm run guard:repo:tree:write-baseline -- --allow-increase');
    expect(output).toContain('src/a.ts private-host-label: Public repo text must not include private host labels. (term rules: 2 hit(s) in a file with no baseline entry)');
    expect(output).toContain('  src/a.ts:1 private-host-label:');
    expect(output).toContain('notes/<private>.md private-host-label:');
    // Generic shapes (a home path) stay with the diff modes.
    expect(output).not.toContain('docs/home.md');
    expectNoTermText(result.lines);
  });

  it('writes the first baseline only with --allow-increase: plain paths, 0600, in a new 0700 folder', () => {
    useTerms();
    const file = useBaseline();
    const repo = treeRepo();

    const refused = capture(['--tree', '--write-baseline'], repo);
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.join('\n')).toContain('refusing to raise src/a.ts term:private-host-label from 0 to 2');
    expect(existsSync(file)).toBe(false);

    const written = capture(['--tree', '--write-baseline', '--allow-increase'], repo);
    expect(written.exitCode).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(counts(file)).toEqual({
      'notes/zorblab.md': { 'term:private-host-label': 1 },
      'src/a.ts': { 'term:private-host-label': 2 },
    });
    const baseline = parseBoundaryBaseline(readFileSync(file, 'utf8'));
    expect(baseline.termsSha256).toBe(createHash('sha256').update(readFileSync(SYNTHETIC_PRIVATE_TERMS_FILE)).digest('hex'));
    expect(baseline.commit).toBe(git(repo, ['rev-parse', 'HEAD']));
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expectNoTermText([...refused.lines, ...written.lines]);
    expect(capture(['--tree'], repo).exitCode).toBe(0);
  });

  it('fails a rise and a new file, passes a fall with one advisory line, and lets the writer only lower', () => {
    useTerms();
    const file = useBaseline();
    const repo = treeRepo();
    firstBaseline(repo);

    commit(repo, { 'src/a.ts': 'ssh zorblab\nssh zorblab again\nssh zorblab thrice\n' });
    const rise = capture(['--tree'], repo);
    expect(rise.exitCode).toBe(1);
    expect(rise.lines.join('\n')).toContain('src/a.ts private-host-label: Public repo text must not include private host labels. (term rules: count rose from 2 to 3)');
    const raise = capture(['--tree', '--write-baseline'], repo);
    expect(raise.exitCode).toBe(1);
    expect(raise.lines.join('\n')).toContain('refusing to raise src/a.ts term:private-host-label from 2 to 3');

    commit(repo, { 'src/a.ts': 'ssh zorblab\nconst clean = 1;\n', 'src/b.ts': 'ask Quorpine\n' });
    const added = capture(['--tree'], repo);
    expect(added.exitCode).toBe(1);
    expect(added.lines.join('\n')).toContain('src/b.ts private-person:');

    commit(repo, { 'src/b.ts': 'ask user-a\n' });
    const fall = capture(['--tree'], repo);
    expect(fall.exitCode).toBe(0);
    expect(fall.lines.filter((line) => line.includes('fell below the private baseline'))).toHaveLength(1);
    expect(capture(['--tree', '--write-baseline'], repo).exitCode).toBe(0);
    expect(counts(file)['src/a.ts']).toEqual({ 'term:private-host-label': 1 });
    const lowered = capture(['--tree'], repo);
    expect(lowered.exitCode).toBe(0);
    expect(lowered.lines.join('\n')).not.toContain('fell below');
    expectNoTermText([...rise.lines, ...raise.lines, ...added.lines, ...fall.lines, ...lowered.lines]);
  });

  it('keeps term and fallback counts apart: a fallback rise fails while term hits fall', () => {
    useTerms();
    useBaseline();
    const repo = treeRepo();
    firstBaseline(repo);
    // A fallback label read from the inline list at runtime, never spelled in this file.
    const fallbackLabel = privateHostLabels[0]!;
    commit(repo, { 'src/a.ts': `ssh zorblab\ndeploy to ${fallbackLabel}\n` });
    const result = capture(['--tree'], repo);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('(fallback rules: count rose from 0 to 1)');
    expect(result.lines.join('\n').toLowerCase()).not.toContain(fallbackLabel.toLowerCase());
  });

  it('compares only the fallback counts when the term file differs; the require switch and the writer refuse', () => {
    useTerms();
    useBaseline();
    const repo = treeRepo();
    firstBaseline(repo);

    const revised = JSON.parse(readFileSync(SYNTHETIC_PRIVATE_TERMS_FILE, 'utf8')) as { terms: unknown[] };
    revised.terms.push({ id: 'M002', class: 'machine', value: 'zarnlab', match: 'word', case: 'sensitive', replace: 'host-b' });
    const revisedFile = join(tmp.make('revised'), 'private-terms.json');
    writeFileSync(revisedFile, JSON.stringify(revised));
    useTerms(revisedFile);
    commit(repo, { 'src/c.ts': 'ssh zorblab\n' });

    const degraded = capture(['--tree'], repo);
    expect(degraded.exitCode).toBe(0);
    expect(degraded.lines.join('\n')).toContain('differs from the one the private baseline was built from');
    expect(capture(['--tree', '--write-baseline'], repo).exitCode).toBe(1);
    expect(capture(['--tree', '--write-baseline', '--allow-increase'], repo).exitCode).toBe(0);
    expect(capture(['--tree'], repo).exitCode).toBe(0);

    useTerms();
    vi.stubEnv('WHATSOUP_REQUIRE_PRIVATE_TERMS', '1');
    expect(capture(['--tree'], repo).exitCode).toBe(2);
  });

  it('refuses to write unless origin/main is an ancestor of HEAD, and keeps entries a branch behind lacks', () => {
    useTerms();
    const file = useBaseline();
    const repo = treeRepo();
    firstBaseline(repo);
    const fork = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-b', 'ahead']);
    commit(repo, { 'src/d.ts': 'ssh zorblab\n' });
    expect(capture(['--tree', '--write-baseline', '--allow-increase'], repo).exitCode).toBe(0);
    expect(counts(file)['src/d.ts']).toEqual({ 'term:private-host-label': 1 });

    // A branch from the fork point lacks src/d.ts only because it is behind the baseline's commit.
    git(repo, ['checkout', '-b', 'behind', fork]);
    commit(repo, { 'src/e.ts': 'const clean = 1;\n' });
    expect(capture(['--tree', '--write-baseline'], repo).exitCode).toBe(0);
    expect(counts(file)['src/d.ts']).toEqual({ 'term:private-host-label': 1 });

    git(repo, ['update-ref', 'refs/remotes/origin/main', 'ahead']);
    const refused = capture(['--tree', '--write-baseline'], repo);
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.join('\n')).toContain('origin/main is missing or is not an ancestor of HEAD');
  });

  it('scans a gitlink path name, and a whole-blob prefilter never hides a line match', () => {
    const termsFile = join(tmp.make('lookahead'), 'private-terms.json');
    writeFileSync(termsFile, JSON.stringify({
      schema: 'whatsoup-private-terms',
      version: 1,
      terms: [{ id: 'M001', class: 'machine', regex: 'zorblab(?![\\s\\S]*public)', match: 'word', case: 'sensitive' }],
    }));
    useTerms(termsFile);
    useBaseline();
    const repo = makeRepo();
    commit(repo, { 'src/p.ts': 'zorblab\npublic\n' });
    git(repo, ['update-index', '--add', '--cacheinfo', `160000,${git(repo, ['rev-parse', 'HEAD'])},vendor/zorblab`]);
    git(repo, ['commit', '-m', 'test: gitlink']);

    const result = capture(['--tree'], repo);
    expect(result.exitCode).toBe(1);
    const output = result.lines.join('\n');
    expect(output).toContain('  src/p.ts:1 private-host-label:');
    expect(output).toContain('vendor/<private> private-host-label:');
    expectNoTermText(result.lines);
  });
});

describe('exact-range receipts carry term-rule causes without term text', () => {
  it('reports a term-only cause that validates, and the policy projection holds no term text', () => {
    useTerms();
    const repo = makeRepo();
    const baseOid = commit(repo, { 'README.md': '# fixture\n' });
    const localOid = commit(repo, { 'src/x.ts': 'ssh zorblab\nask Quorpine\n' });

    const result = createRepoHygieneExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payloadText = Buffer.from(result.artifact.payloadBytes).toString('utf8');
    const payload = JSON.parse(payloadText) as { nativeCauses: string[]; toolDigest: string; policyDigest: string };
    expect(payload.nativeCauses).toEqual(['private-host-label', 'private-person']);
    expectNoTermText([payloadText, canonicalRepoHygienePolicyProjection()]);

    const validation = validateRepoHygieneExactRangeArtifact(result.artifact, {
      baseOid,
      remoteOid: null,
      localOid,
      currentToolDigest: payload.toolDigest,
      currentPolicyDigest: payload.policyDigest,
      expectedPayloadByteLength: result.artifact.binding.payloadByteLength,
      expectedPayloadSha256: result.artifact.binding.payloadSha256,
    });
    expect(validation.ok).toBe(true);
  });

  it('keeps the term file out of the compared policy digest', () => {
    useTerms(ABSENT_PRIVATE_TERMS_FILE);
    const absent = canonicalRepoHygienePolicyProjection();
    useTerms();
    expect(canonicalRepoHygienePolicyProjection()).toBe(absent);
  });

  it('validates a receipt made with the term file where none exists, and the reverse', () => {
    const repo = makeRepo();
    const baseOid = commit(repo, { 'README.md': '# fixture\n' });
    const localOid = commit(repo, { 'src/x.ts': 'const clean = 1;\n' });
    const input = { baseOid, remoteOid: null, localOid };
    const termsDigest = `sha256:${createHash('sha256').update(readFileSync(SYNTHETIC_PRIVATE_TERMS_FILE)).digest('hex')}`;
    const directions = [
      { producer: SYNTHETIC_PRIVATE_TERMS_FILE, consumer: ABSENT_PRIVATE_TERMS_FILE, recorded: { status: 'loaded', termsSha256: termsDigest, preEpochTermHits: 0 } },
      { producer: ABSENT_PRIVATE_TERMS_FILE, consumer: SYNTHETIC_PRIVATE_TERMS_FILE, recorded: { status: 'absent', termsSha256: null, preEpochTermHits: 0 } },
    ];
    for (const { producer, consumer, recorded } of directions) {
      useTerms(producer);
      const built = createRepoHygieneExactRangeArtifact(repo, input);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const payload = JSON.parse(Buffer.from(built.artifact.payloadBytes).toString('utf8')) as { privateTerms: unknown };
      expect(payload.privateTerms).toEqual(recorded);
      useTerms(consumer);
      const expected = {
        ...input,
        currentToolDigest: currentRepoHygieneToolDigest(),
        currentPolicyDigest: currentRepoHygienePolicyDigest(),
        expectedPayloadByteLength: built.artifact.binding.payloadByteLength,
        expectedPayloadSha256: built.artifact.binding.payloadSha256,
      };
      expect(validateRepoHygieneExactRangeArtifact(built.artifact, expected).ok).toBe(true);
      expect(adaptRepoHygieneExactRangeReportOnly(built.artifact, expected).outcome).toBe('pass');
    }
  });
});

describe('commit identities and the commit-text epoch', () => {
  const syntheticRules = () => requirePrivateTermsUsable(loadPrivateTerms({ WHATSOUP_PRIVATE_TERMS_FILE: SYNTHETIC_PRIVATE_TERMS_FILE }));

  it('blocks term hits in commit text only from the epoch on, counts older ones, and keeps the other rules', () => {
    useTerms();
    const repo = makeRepo();
    commit(repo, { 'README.md': '# fixture\n' });
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    commit(repo, { 'a.txt': 'a\n' }, 'fix: restart zorblab\n\nCo-Authored-By: Pat <pat@example.com>', BEFORE_EPOCH);
    commit(repo, { 'b.txt': 'b\n' }, 'docs: ask Quorpine', AFTER_EPOCH);

    const result = capture(['--commit-authors'], repo);

    expect(result.exitCode).toBe(1);
    // The older commit's trailer and address still block; its term hit is counted only.
    expect(result.codes).toEqual(['commit-coauthor-trailer', 'personal-email', 'private-person']);
    expect(result.lines.some((line) => line.includes('1 private-term hit(s) in commits older than the term-list epoch'))).toBe(true);
    expectNoTermText(result.lines);
  });

  it('applies an explicit epoch: a commit one second before it is counted, one at it is blocked', () => {
    const at = (iso: string) => ({
      sha: 'a'.repeat(40),
      name: 'Pat',
      email: 'pat@users.noreply.github.com',
      subject: 'fix',
      message: 'fix: restart zorblab',
      committerTime: Date.parse(iso) / 1000,
    });
    const tally = { olderTermHits: 0 };
    expect(scanCommitAuthors([at('2026-11-15T23:59:59Z')], syntheticRules(), '2026-11-16T00:00:00Z', tally)).toEqual([]);
    expect(tally.olderTermHits).toBe(1);
    expect(scanCommitAuthors([at('2026-11-16T00:00:00Z')], syntheticRules(), '2026-11-16T00:00:00Z').map((issue) => issue.code))
      .toEqual(['private-host-label']);
    // No committer time: blocking, as before.
    const { committerTime: _unknown, ...undated } = at('2001-01-01T00:00:00Z');
    expect(scanCommitAuthors([undated], syntheticRules(), '2026-11-16T00:00:00Z').map((issue) => issue.code)).toEqual(['private-host-label']);
  });

  it('scans author and committer identities with every term code except person names', () => {
    useTerms();
    const repo = makeRepo();
    commit(repo, { 'README.md': '# fixture\n' });
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    commit(repo, { 'a.txt': 'a\n' }, 'fix: neutral change', {
      ...AFTER_EPOCH,
      GIT_AUTHOR_NAME: 'Quorpine Zed',
      // Addresses are assembled at runtime so this file never carries an address literally.
      GIT_AUTHOR_EMAIL: ['ops', 'corp-zz.example'].join('@'),
      GIT_COMMITTER_NAME: 'Build Agent',
      GIT_COMMITTER_EMAIL: ['agent', 'zorblab.local'].join('@'),
    });

    const result = capture(['--commit-authors'], repo);

    expect(result.exitCode).toBe(1);
    expect(result.codes).toEqual(['private-domain', 'private-host-label']);
    expectNoTermText(result.lines);
  });

  it('never lets the environment-token allowance pass an explicit term', () => {
    const cwd = tmp.make('env-token');
    const termsFile = join(cwd, 'private-terms.json');
    writeFileSync(termsFile, JSON.stringify({
      schema: 'whatsoup-private-terms',
      version: 1,
      terms: [{ id: 'A002', class: 'account-id', value: 'ZQ_ACCOUNT_KEY', match: 'literal', case: 'sensitive', replace: 'account-b' }],
    }));
    useTerms(termsFile);
    const file = join(cwd, 'body.md');
    writeFileSync(file, 'set ZQ_ACCOUNT_KEY first\n');

    const result = capture(['--text', file], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.codes).toEqual(['private-account-id']);
    expect(result.lines.join('\n')).not.toContain('ZQ_ACCOUNT_KEY');
  });

  it('counts an older commit\'s term hit in the receipt instead of blocking it', () => {
    useTerms();
    const repo = makeRepo();
    const baseOid = commit(repo, { 'README.md': '# fixture\n' });
    const olderOid = commit(repo, { 'src/x.ts': 'const clean = 1;\n' }, 'fix: restart zorblab', BEFORE_EPOCH);
    const newerOid = commit(repo, { 'src/y.ts': 'const clean = 2;\n' }, 'fix: restart zorblab', AFTER_EPOCH);

    const older = createRepoHygieneExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid: olderOid });
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    const olderPayload = JSON.parse(Buffer.from(older.artifact.payloadBytes).toString('utf8')) as {
      nativeCauses: string[];
      privateTerms: { preEpochTermHits: number };
    };
    expect(olderPayload.nativeCauses).toEqual([]);
    expect(olderPayload.privateTerms.preEpochTermHits).toBe(1);
    expect(validateRepoHygieneExactRangeArtifact(older.artifact, {
      baseOid,
      remoteOid: null,
      localOid: olderOid,
      currentToolDigest: currentRepoHygieneToolDigest(),
      currentPolicyDigest: currentRepoHygienePolicyDigest(),
      expectedPayloadByteLength: older.artifact.binding.payloadByteLength,
      expectedPayloadSha256: older.artifact.binding.payloadSha256,
    }).ok).toBe(true);

    const newer = createRepoHygieneExactRangeArtifact(repo, { baseOid: olderOid, remoteOid: null, localOid: newerOid });
    expect(newer.ok).toBe(true);
    if (!newer.ok) return;
    const newerPayload = JSON.parse(Buffer.from(newer.artifact.payloadBytes).toString('utf8')) as { nativeCauses: string[] };
    expect(newerPayload.nativeCauses).toEqual(['private-host-label']);
  });
});

describe('the git environment every test subprocess gets', () => {
  it('has a temporary HOME, no system or global configuration and an empty hooks folder', () => {
    const env = isolatedGitEnv();
    expect(env.HOME).not.toBe(homedir());
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.WHATSOUP_PRIVATE_TERMS_FILE).toBe(ABSENT_PRIVATE_TERMS_FILE);
    expect(env.WHATSOUP_REQUIRE_PRIVATE_TERMS).toBe('');
    const repo = makeRepo();
    const hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: repo, encoding: 'utf8', env }).trim();
    expect(readdirSync(hooksPath)).toEqual([]);
    const globalConfig = spawnSync('git', ['config', '--global', '--list'], { cwd: repo, encoding: 'utf8', env });
    expect(globalConfig.stdout.trim()).toBe('');
  });
});
