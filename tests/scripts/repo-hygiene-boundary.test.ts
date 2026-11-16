import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import { pathKey, parseBoundaryBaseline } from '../../scripts/lib/repo-hygiene-boundary.ts';
import {
  canonicalRepoHygienePolicyProjection,
  createRepoHygieneExactRangeArtifact,
  privateHostLabels,
  run,
  validateRepoHygieneExactRangeArtifact,
} from '../../scripts/repo-hygiene-guard.ts';
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

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

function commit(repo: string, files: Record<string, string>, message = 'test: fixture'): string {
  writeFiles(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message]);
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
    commit(repo, { 'a.txt': 'a\n' }, 'fix: restart zorblab\n\nasked Quorpine');

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

describe('repo hygiene --tree and its baseline', () => {
  const baselinePath = (repo: string) => join(repo, 'scripts', 'boundary-baseline.json');

  function treeRepo(): string {
    const repo = makeRepo();
    commit(repo, {
      'src/a.ts': 'ssh zorblab\nssh zorblab again\nconst clean = 1;\n',
      'docs/home.md': `${HOME_PATH}\n`,
      'notes/zorblab.md': 'clean content\n',
    });
    return repo;
  }

  function commitBaselineAsMain(repo: string): void {
    git(repo, ['add', 'scripts/boundary-baseline.json']);
    git(repo, ['commit', '-m', 'chore: boundary baseline']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  }

  it('refuses an empty repository as INCONCLUSIVE (exit 2)', () => {
    useTerms();
    const result = capture(['--tree'], makeRepo());
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toMatch(/INCONCLUSIVE/);
  });

  it('fails every file with hits when no baseline exists, masking a private path name', () => {
    useTerms();
    const repo = treeRepo();
    const result = capture(['--tree'], repo);

    expect(result.exitCode).toBe(1);
    const output = result.lines.join('\n');
    expect(output).toContain('src/a.ts private-host-label: Public repo text must not include private host labels. (2 hit(s) in a file with no baseline entry)');
    expect(output).toContain('  src/a.ts:1 private-host-label:');
    expect(output).toContain('docs/home.md local-home-path:');
    expect(output).toContain(`#${pathKey('notes/zorblab.md')} private-host-label:`);
    expectNoTermText(result.lines);
  });

  it('writes the first baseline only with --allow-increase, with hashed keys and the term digest', () => {
    useTerms();
    const repo = treeRepo();

    const refused = capture(['--tree', '--write-baseline'], repo);
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.join('\n')).toContain(`refusing to raise #${pathKey('src/a.ts')} private-host-label from 0 to 2`);
    expect(existsSync(baselinePath(repo))).toBe(false);

    const written = capture(['--tree', '--write-baseline', '--allow-increase'], repo);
    expect(written.exitCode).toBe(0);
    const text = readFileSync(baselinePath(repo), 'utf8');
    for (const tracked of ['src/a.ts', 'docs/home.md', 'notes/zorblab.md']) expect(text).not.toContain(tracked);
    expectNoTermText([text]);
    const baseline = parseBoundaryBaseline(text);
    expect(baseline.termsSha256).toBe(
      createHash('sha256').update(readFileSync(SYNTHETIC_PRIVATE_TERMS_FILE)).digest('hex'),
    );
    expect(Object.fromEntries([...baseline.files].map(([key, codes]) => [key, Object.fromEntries(codes)]))).toEqual({
      [pathKey('src/a.ts')]: { 'private-host-label': 2 },
      [pathKey('docs/home.md')]: { 'local-home-path': 1 },
      [pathKey('notes/zorblab.md')]: { 'private-host-label': 1 },
    });
    expect(JSON.parse(text).header.note).toContain('take the side from main');

    commitBaselineAsMain(repo);
    expect(capture(['--tree'], repo).exitCode).toBe(0);
  });

  it('fails a rise and a new file, fails a fall until --write-baseline, and lets the writer only lower', () => {
    useTerms();
    const repo = treeRepo();
    capture(['--tree', '--write-baseline', '--allow-increase'], repo);
    commitBaselineAsMain(repo);

    commit(repo, { 'src/a.ts': 'ssh zorblab\nssh zorblab again\nssh zorblab thrice\n' });
    const rise = capture(['--tree'], repo);
    expect(rise.exitCode).toBe(1);
    expect(rise.lines.join('\n')).toContain('src/a.ts private-host-label: Public repo text must not include private host labels. (count rose from 2 to 3)');
    const raise = capture(['--tree', '--write-baseline'], repo);
    expect(raise.exitCode).toBe(1);
    expect(raise.lines.join('\n')).toContain(`refusing to raise #${pathKey('src/a.ts')} private-host-label from 2 to 3`);

    commit(repo, { 'src/a.ts': 'ssh zorblab\nconst clean = 1;\n', 'src/b.ts': 'ask Quorpine\n' });
    const added = capture(['--tree'], repo);
    expect(added.exitCode).toBe(1);
    expect(added.lines.join('\n')).toContain('src/b.ts private-person:');
    expect(added.lines.join('\n')).toContain('(count fell from 2 to 1; run npm run guard:repo:tree:write-baseline');

    commit(repo, { 'src/b.ts': 'ask user-a\n' });
    const fall = capture(['--tree'], repo);
    expect(fall.exitCode).toBe(1);
    const lowered = capture(['--tree', '--write-baseline'], repo);
    expect(lowered.exitCode).toBe(0);
    expect(parseBoundaryBaseline(readFileSync(baselinePath(repo), 'utf8')).files.get(pathKey('src/a.ts'))?.get('private-host-label'))
      .toBe(1);
    git(repo, ['add', 'scripts/boundary-baseline.json']);
    git(repo, ['commit', '-m', 'chore: lower boundary baseline']);
    expect(capture(['--tree'], repo).exitCode).toBe(0);
    expectNoTermText([...rise.lines, ...raise.lines, ...added.lines, ...fall.lines, ...lowered.lines]);
  });

  it('compares only generic and fallback codes when the term file differs, and fails under the require switch', () => {
    useTerms();
    const repo = treeRepo();
    capture(['--tree', '--write-baseline', '--allow-increase'], repo);
    commitBaselineAsMain(repo);

    const revised = JSON.parse(readFileSync(SYNTHETIC_PRIVATE_TERMS_FILE, 'utf8')) as { terms: unknown[] };
    revised.terms.push({ id: 'M002', class: 'machine', value: 'zarnlab', match: 'word', case: 'sensitive', replace: 'host-b' });
    const revisedFile = join(tmp.make('revised'), 'private-terms.json');
    writeFileSync(revisedFile, JSON.stringify(revised));
    useTerms(revisedFile);

    const degraded = capture(['--tree'], repo);
    expect(degraded.exitCode).toBe(0);
    expect(degraded.lines.join('\n')).toContain('differs from the one scripts/boundary-baseline.json was built from');

    vi.stubEnv('WHATSOUP_REQUIRE_PRIVATE_TERMS', '1');
    const required = capture(['--tree'], repo);
    expect(required.exitCode).toBe(2);
    expect(required.lines.join('\n')).toContain('--allow-increase');
  });

  it('compares only the generic codes, and still fails a fallback rise, when the term file is absent', () => {
    useTerms();
    const repo = treeRepo();
    capture(['--tree', '--write-baseline', '--allow-increase'], repo);
    commitBaselineAsMain(repo);

    useTerms(ABSENT_PRIVATE_TERMS_FILE);
    const absent = capture(['--tree'], repo);
    expect(absent.exitCode).toBe(0);
    expect(absent.lines.filter((line) => line.includes('private term file absent'))).toHaveLength(1);

    // A fallback label read from the inline list at runtime, never spelled in this file.
    const fallbackLabel = privateHostLabels[0]!;
    commit(repo, { 'src/c.ts': `deploy to ${fallbackLabel}\n` });
    const rise = capture(['--tree'], repo);
    expect(rise.exitCode).toBe(1);
    expect(rise.lines.join('\n')).toContain('private-host-label');
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

  it('binds the term file digest into the policy projection', () => {
    useTerms(ABSENT_PRIVATE_TERMS_FILE);
    const absent = JSON.parse(canonicalRepoHygienePolicyProjection()) as { privateTerms: { status: string; termsSha256: unknown } };
    useTerms();
    const loaded = JSON.parse(canonicalRepoHygienePolicyProjection()) as { privateTerms: { status: string; termsSha256: unknown } };
    expect(absent.privateTerms).toMatchObject({ status: 'absent', termsSha256: null });
    expect(loaded.privateTerms).toMatchObject({
      status: 'loaded',
      termsSha256: createHash('sha256').update(readFileSync(SYNTHETIC_PRIVATE_TERMS_FILE)).digest('hex'),
    });
  });
});
