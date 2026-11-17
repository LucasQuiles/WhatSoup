/**
 * The hosted private boundary checks (scripts/boundary-private-scan.ts), on synthetic data only:
 * the synthetic term file, repositories built here and a fake GitHub API.
 *
 * - The candidate is fetched into its own bare git directory and read as objects. Its added
 *   lines (tree to tree, text forced), added and renamed path names, commit messages and
 *   identities, and the pull request title and body are each scanned with the guard's own code.
 * - The binding refuses what it cannot tie to the Quality run: base = head, an all-zero or
 *   malformed id, a base that is not an ancestor of the head, a commit the fetch did not bring.
 * - Output and the published check give counts by mode and rule code, never a matched text.
 * - The text check reads issues and comments from the event payload, and lists changed items
 *   for the hourly run.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BoundaryRefusal,
  CHECK_NAME,
  bindPullRequestCandidate,
  collectChangedItems,
  collectEventItems,
  fetchCandidateObjects,
  formatCandidateResult,
  formatTextResult,
  publishCheckRun,
  requireExactCommitRecords,
  scanCandidate,
  scanTextItems,
  scheduleSince,
  type CandidateScanResult,
  type GitHubApi,
} from '../../scripts/boundary-private-scan.ts';
import { resolveBoundaryTerms } from '../../scripts/lib/repo-hygiene-boundary.ts';
import { scanAddedLines, type CommitAuthor } from '../../scripts/repo-hygiene-guard.ts';
import { isolatedGitEnv } from '../helpers/isolated-git-env.ts';
import { ABSENT_PRIVATE_TERMS_FILE, SYNTHETIC_PRIVATE_TERMS_FILE } from '../helpers/private-terms-env.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const termRules = resolveBoundaryTerms({ WHATSOUP_PRIVATE_TERMS_FILE: SYNTHETIC_PRIVATE_TERMS_FILE }).rules;
const SYNTHETIC_VALUES = ['zorblab', 'zmini', 'qx-bot', 'zqline', 'quorpine', 'corp-zz.example', 'acct-zq-4471', '100.1.2.3'];
// The commit-message term epoch is 2026-11-17T15:08:00Z; fixed dates keep each case on one side of it.
const AFTER_EPOCH = '2026-12-01T12:00:00Z';
const BEFORE_EPOCH = '2026-10-01T12:00:00Z';
const ZERO = '0'.repeat(40);
// A fixture path of the hygiene policy: exempt from the generic shapes in every diff mode.
const FIXTURE_DIR = 'tools/agent-runtime-probes';

function expectNoSyntheticTerm(text: string): void {
  for (const value of SYNTHETIC_VALUES) expect(text.toLowerCase(), value).not.toContain(value);
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'whatsoup-boundary-private-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Git = (...args: string[]) => string;
type Write = (file: string, content: string | Buffer) => void;

function repoGit(cwd: string, date: string = AFTER_EPOCH): Git {
  return (...args) => execFileSync('git', args, {
    cwd,
    env: isolatedGitEnv({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const commitAll = (git: Git, message = 'add files'): void => {
  git('add', '-A');
  git('commit', '-q', '-m', message);
};

interface Candidate {
  readonly remote: string;
  readonly base: string;
  readonly head: string;
}

/** A remote with `main` at a clean base commit and `feature` at the head that `change` builds. */
function makeCandidate(change: (write: Write, git: Git, remote: string) => void): Candidate {
  const remote = join(root, 'remote');
  mkdirSync(remote);
  const git = repoGit(remote);
  const write: Write = (file, content) => {
    mkdirSync(dirname(join(remote, file)), { recursive: true });
    writeFileSync(join(remote, file), content);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Guard Test');
  git('config', 'user.email', 'guard@users.noreply.github.com');
  write('README.md', 'base\n');
  commitAll(git, 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  change(write, git, remote);
  git('checkout', '-q', 'feature');
  return { remote, base, head: git('rev-parse', 'HEAD') };
}

const candidateDirs = (): { gitDir: string; home: string } => {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { gitDir: join(root, 'candidate.git'), home };
};

const NO_COUNTS = { 'added-lines': {}, 'path-names': {}, 'sensitive-paths': {}, 'commit-lines': {}, commits: {}, 'head-ref': {}, 'pr-text': {} };
const PLAIN_TEXT = { title: 'Add notes', body: 'A plain body.', headRef: 'feature-a' };

function scan(candidate: Candidate, text: { title: string; body: string; headRef: string } = PLAIN_TEXT): CandidateScanResult {
  const dirs = candidateDirs();
  fetchCandidateObjects({ ...dirs, remote: candidate.remote, base: candidate.base, head: candidate.head });
  return scanCandidate({ ...dirs, base: candidate.base, head: candidate.head, ...text, termRules });
}

describe('boundary (private) candidate scan', () => {
  it('passes a clean candidate and reports what each mode scanned', () => {
    const result = scan(makeCandidate((write, git) => {
      write('docs/notes.md', 'plain notes\n');
      commitAll(git);
    }));
    expect(result.conclusion).toBe('pass');
    expect(result.scanned).toEqual({ addedLines: 1, pathNames: 1, changedPaths: 1, commits: 1, commitLines: 1, commitPaths: 1, refNames: 1, texts: 2 });
    expect(result.counts).toEqual(NO_COUNTS);
  });

  it('fails on a term that one commit adds and a later commit removes', () => {
    const result = scan(makeCandidate((write, git) => {
      write('docs/notes.md', 'deploy on zorblab\n');
      commitAll(git, 'add notes');
      write('docs/notes.md', 'deploy on host-a\n');
      commitAll(git, 'reword notes');
    }));
    expect(result.counts['added-lines']).toEqual({});
    expect(result.counts['commit-lines']).toEqual({ 'private-host-label': 1 });
    expect(result.conclusion).toBe('fail');
  });

  it('does not count the lines a merge from the base brings back unchanged', () => {
    const candidate = makeCandidate((write, git) => {
      write('docs/notes.md', 'plain notes\n');
      commitAll(git, 'add notes');
      git('checkout', '-q', 'main');
      write('main-only.txt', 'a published zorblab line\n');
      commitAll(git, 'main moves on');
      git('checkout', '-q', 'feature');
      git('merge', '-q', '--no-ff', '-m', 'merge main', 'main');
    });
    const result = scan({ ...candidate, base: repoGit(candidate.remote)('rev-parse', 'main') });
    expect(result.scanned.commits).toBe(2);
    expect(result.counts).toEqual(NO_COUNTS);
  });

  it('classifies a sensitive artifact path that the candidate adds', () => {
    const result = scan(makeCandidate((write, git) => {
      write('.mcp.json', '{}\n');
      commitAll(git, 'add config');
    }));
    expect(result.counts['sensitive-paths']).toEqual({ 'branch-sensitive-artifact': 1 });
    expect(result.conclusion).toBe('fail');
  });

  it('classifies a sensitive artifact path that one commit adds and a later commit removes', () => {
    const result = scan(makeCandidate((write, git) => {
      write('.mcp.json', '{}\n');
      write('docs/notes.md', 'plain notes\n');
      commitAll(git, 'add config');
      git('rm', '-q', '.mcp.json');
      git('commit', '-q', '-m', 'drop config');
    }));
    expect(result.counts['sensitive-paths']).toEqual({ 'branch-history-sensitive-artifact': 1 });
    expect(result.conclusion).toBe('fail');
  });

  it('counts a term in the pull request head branch name', () => {
    const candidate = makeCandidate((write, git) => {
      write('a.txt', 'plain\n');
      commitAll(git);
    });
    const result = scan(candidate, { ...PLAIN_TEXT, headRef: 'feature/zorblab-notes' });
    expect(result.counts['head-ref']).toEqual({ 'private-host-label': 1 });
    expect(result.conclusion).toBe('fail');
  });

  it.each<[string, 'added-lines' | 'path-names', (write: Write) => void]>([
    ['an added line', 'added-lines', (write) => write('docs/notes.md', 'deploy to zorblab\n')],
    ['an added path name', 'path-names', (write) => write('notes/zorblab.txt', 'plain\n')],
    ['the line after an added "++ /dev/null" line', 'added-lines', (write) => write('docs/notes.md', '++ /dev/null\nruns on zorblab\n')],
    ['a path the change marks -diff', 'added-lines', (write) => {
      write('.gitattributes', 'hidden.txt -diff\n');
      write('hidden.txt', 'runs on zorblab\n');
    }],
    ['a path the change marks binary', 'added-lines', (write) => {
      write('.gitattributes', '*.dat binary\n');
      write('data.dat', 'runs on zorblab\n');
    }],
    ['a file with a NUL byte in its first 8000 bytes', 'added-lines', (write) => {
      write('blob.bin', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('\nruns on zorblab\n')]));
    }],
  ])('fails on a synthetic term in %s', (_label, mode, plant) => {
    const result = scan(makeCandidate((write, git) => {
      plant(write);
      commitAll(git);
    }));
    expect(result.conclusion).toBe('fail');
    expect(result.counts[mode]['private-host-label']).toBeGreaterThanOrEqual(1);
  });

  it('scans the new name of a renamed file', () => {
    const result = scan(makeCandidate((write, git) => {
      git('mv', 'README.md', 'zorblab-readme.md');
      commitAll(git, 'rename the readme');
    }));
    expect(result.counts['path-names']).toEqual({ 'private-host-label': 1 });
    expect(result.counts['added-lines']).toEqual({});
  });

  it('scans content that only a merge commit introduces', () => {
    const result = scan(makeCandidate((write, git) => {
      write('left.txt', 'left\n');
      commitAll(git, 'left');
      git('checkout', '-q', '-b', 'right', 'main');
      write('right.txt', 'right\n');
      commitAll(git, 'right');
      git('checkout', '-q', 'feature');
      git('merge', '-q', '--no-ff', '--no-commit', 'right');
      write('merged.txt', 'runs on zorblab\n');
      commitAll(git, 'merge right');
    }));
    expect(result.counts['added-lines']).toEqual({ 'private-host-label': 1 });
    expect(result.scanned.commits).toBe(3);
  });

  it('applies private names under fixture paths, which stay exempt from the generic shapes only', () => {
    const token = ['ghp', 'SyntheticToken1234567890'].join('_');
    const result = scan(makeCandidate((write, git) => {
      write(`${FIXTURE_DIR}/corpus.txt`, `runs on zorblab\nexample ${token}\n`);
      write('docs/token.txt', `example ${token}\n`);
      commitAll(git);
    }));
    expect(result.counts['added-lines']).toEqual({ 'github-token': 1, 'private-host-label': 1 });
    // The local diff modes keep their fixture exemption.
    const fixtureLine = { filePath: `${FIXTURE_DIR}/corpus.txt`, line: 1, text: 'runs on zorblab' };
    expect(scanAddedLines([fixtureLine], termRules)).toEqual([]);
  });

  it('counts a term in a commit message and in an author identity', () => {
    const result = scan(makeCandidate((write, git) => {
      write('a.txt', 'plain\n');
      commitAll(git, 'notes for zorblab');
      write('b.txt', 'plain\n');
      git('add', '-A');
      git('-c', 'user.name=Zorblab Builder', 'commit', '-q', '-m', 'add another file');
    }));
    expect(result.counts.commits).toEqual({ 'private-host-label': 2 });
  });

  it('fails on a term in a commit dated before the term-list epoch: every commit in base..head is new', () => {
    const result = scan(makeCandidate((write, git, remote) => {
      write('a.txt', 'plain\n');
      commitAll(repoGit(remote, BEFORE_EPOCH), 'notes for zorblab');
      write('b.txt', 'plain\n');
      git('add', '-A');
      repoGit(remote, BEFORE_EPOCH)('-c', 'user.name=Zorblab Builder', 'commit', '-q', '-m', 'add another file');
    }));
    expect(result.counts.commits).toEqual({ 'private-host-label': 2 });
    expect(result.conclusion).toBe('fail');
    expect(result).not.toHaveProperty('olderTermHits');
  });

  it('counts terms in the pull request title and body', () => {
    const candidate = makeCandidate((write, git) => {
      write('a.txt', 'plain\n');
      commitAll(git);
    });
    const result = scan(candidate, { ...PLAIN_TEXT, title: 'Deploy to zorblab', body: 'First line\nruns on zorblab' });
    expect(result.counts['pr-text']).toEqual({ 'private-host-label': 2 });
  });

  it('prints counts by mode and rule code only, during the scan and in its result lines', () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((message?: unknown) => { errors.push(String(message)); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => { logs.push(String(message)); });
    let lines: string[];
    try {
      const result = scan(makeCandidate((write, git) => {
        write('notes/zorblab.txt', 'runs on zorblab\n');
        git('add', '-A');
        git('-c', 'user.name=Zorblab Builder', 'commit', '-q', '-m', 'notes for zorblab');
      }), { title: 'Deploy to zorblab', body: 'runs on zorblab', headRef: 'zorblab-notes' });
      lines = formatCandidateResult(result);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
    expect(lines).toEqual(expect.arrayContaining([
      'boundary (private): added-lines private-host-label 1',
      'boundary (private): path-names private-host-label 1',
      'boundary (private): commit-lines private-host-label 1',
      'boundary (private): commits private-host-label 2',
      'boundary (private): head-ref private-host-label 1',
      'boundary (private): pr-text private-host-label 2',
    ]));
    expectNoSyntheticTerm([...lines, ...logs, ...errors].join('\n'));
  });
});

describe('boundary (private) candidate binding to the fetched objects', () => {
  it('refuses base = head, all-zero and malformed ids before any fetch', () => {
    const candidate = makeCandidate((write, git) => {
      write('a.txt', 'plain\n');
      commitAll(git);
    });
    const dirs = candidateDirs();
    for (const [base, head] of [
      [candidate.head, candidate.head],
      [ZERO, candidate.head],
      [candidate.base, ZERO],
      ['not-a-commit', candidate.head],
      [candidate.base, `${candidate.head} --all`],
    ] as const) {
      expect(() => fetchCandidateObjects({ ...dirs, remote: candidate.remote, base, head })).toThrow(BoundaryRefusal);
      expect(() => scanCandidate({ ...dirs, base, head, title: '', body: '', headRef: 'feature-a', termRules })).toThrow(BoundaryRefusal);
    }
  });

  it('refuses a range whose commit records cannot be read exactly, such as a message that ends in 0x1E', () => {
    const candidate = makeCandidate((write, git) => {
      write('a.txt', 'plain\n');
      git('add', '-A');
      // commit-tree keeps the message verbatim, so the record separator stays at its end.
      const commit = git('commit-tree', git('write-tree'), '-p', git('rev-parse', 'HEAD'), '-m', 'fix\x1e');
      git('update-ref', 'refs/heads/feature', commit);
    });
    expect(() => scan(candidate)).toThrow(BoundaryRefusal);
  });

  it('requires every field of every commit record, in the order of the revision list', () => {
    const sha = 'c'.repeat(40);
    const full: CommitAuthor = {
      sha,
      name: 'User A',
      email: 'guard@users.noreply.github.com',
      subject: 'fix',
      message: 'fix\n',
      committerName: 'User A',
      committerEmail: 'guard@users.noreply.github.com',
      committerTime: 1763400000,
    };
    const without = (key: keyof CommitAuthor): CommitAuthor =>
      Object.fromEntries(Object.entries(full).filter(([name]) => name !== key)) as unknown as CommitAuthor;
    expect(requireExactCommitRecords([full], [sha])).toEqual([full]);
    for (const records of [
      [],
      [full, full],
      [{ ...full, sha: 'd'.repeat(40) }],
      [{ ...full, committerTime: -1 }],
      [without('message')],
      [without('committerName')],
      [without('committerEmail')],
      [without('committerTime')],
    ]) {
      expect(() => requireExactCommitRecords(records, [sha])).toThrow(BoundaryRefusal);
    }
  });

  it('refuses a base the fetch did not bring', () => {
    const candidate = makeCandidate((write, git) => {
      write('a.txt', 'plain\n');
      commitAll(git);
    });
    expect(() => fetchCandidateObjects({ ...candidateDirs(), remote: candidate.remote, base: 'c'.repeat(40), head: candidate.head }))
      .toThrow(BoundaryRefusal);
  });

  it('refuses a base branch tip that is not an ancestor of the head', () => {
    const candidate = makeCandidate((write, git) => {
      write('a.txt', 'plain\n');
      commitAll(git);
      git('checkout', '-q', 'main');
      write('main-only.txt', 'later\n');
      commitAll(git, 'main moves on');
    });
    const advancedBase = repoGit(candidate.remote)('rev-parse', 'main');
    expect(() => scan({ ...candidate, base: advancedBase })).toThrow(BoundaryRefusal);
  });

  it('fails closed with one fixed line when the term file is required and absent', () => {
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/boundary-private-scan.ts'), 'scan', '--out', root], {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '', WHATSOUP_PRIVATE_TERMS_FILE: ABSENT_PRIVATE_TERMS_FILE, WHATSOUP_REQUIRE_PRIVATE_TERMS: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(2);
    const lines = `${result.stdout}${result.stderr}`.split('\n')
      .filter((line) => line !== '' && !line.includes('ExperimentalWarning') && !line.includes('--trace-warnings'));
    expect(lines).toEqual(['boundary (private): the private term file is missing, unreadable or invalid; the check fails closed']);
  });
});

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const REPOSITORY = 'owner-a/repo-a';

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    state: 'open',
    title: 'A title',
    body: 'A body',
    head: { sha: HEAD, ref: 'feature-a', repo: { full_name: 'fork-a/repo-a' } },
    base: { ref: 'main', sha: 'd'.repeat(40), repo: { full_name: REPOSITORY } },
    ...overrides,
  };
}

const QUALITY_RUN = {
  id: 99,
  name: 'Quality',
  path: '.github/workflows/quality.yml',
  event: 'pull_request',
  status: 'completed',
  head_sha: HEAD,
  repository: { full_name: REPOSITORY },
  pull_requests: [],
};

/** A fake API: GET answers by path, and every request outside the table fails the test. */
function routedApi(routes: Record<string, unknown>): GitHubApi {
  return {
    async getJson(path) {
      if (!(path in routes)) throw new Error('unexpected request');
      return routes[path];
    },
    async postJson() {
      throw new Error('unexpected post');
    },
  };
}

function bindingApi(overrides: Record<string, unknown> = {}): GitHubApi {
  return routedApi({
    'actions/runs/99': QUALITY_RUN,
    [`commits/${HEAD}/pulls?per_page=100`]: [pullRequest()],
    'pulls/7': pullRequest(),
    'git/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'commit', sha: BASE } },
    ...overrides,
  });
}

const bind = (api: GitHubApi, headSha = HEAD) => bindPullRequestCandidate(api, { runId: '99', headSha, repository: REPOSITORY });

describe('boundary (private) pull request binding', () => {
  it('binds a fork pull request through the commit association, with the base tip read at run time', async () => {
    await expect(bind(bindingApi())).resolves.toEqual({ head: HEAD, base: BASE, number: 7, title: 'A title', body: 'A body', headRef: 'feature-a' });
  });

  it('refuses a pull request whose head branch name is not a string', async () => {
    const pull = pullRequest({ head: { sha: HEAD, repo: { full_name: 'fork-a/repo-a' } } });
    await expect(bind(bindingApi({ 'pulls/7': pull }))).rejects.toBeInstanceOf(BoundaryRefusal);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a run that is not the Quality pull_request run', { 'actions/runs/99': { ...QUALITY_RUN, event: 'push' } }],
    ['a run from another workflow file', { 'actions/runs/99': { ...QUALITY_RUN, path: '.github/workflows/other.yml' } }],
    ['a run whose head differs from the event', { 'actions/runs/99': { ...QUALITY_RUN, head_sha: 'e'.repeat(40) } }],
    ['no associated open pull request', { [`commits/${HEAD}/pulls?per_page=100`]: [] }],
    ['two associated open pull requests', { [`commits/${HEAD}/pulls?per_page=100`]: [pullRequest(), pullRequest({ number: 8 })] }],
    ['a pull request whose head moved', { 'pulls/7': pullRequest({ head: { sha: 'e'.repeat(40), repo: { full_name: REPOSITORY } } }) }],
    ['a closed pull request', { 'pulls/7': pullRequest({ state: 'closed' }) }],
    ['a pull request into another repository', { 'pulls/7': pullRequest({ base: { ref: 'main', repo: { full_name: 'other-a/repo-a' } } }) }],
    ['a malformed base ref', { 'pulls/7': pullRequest({ base: { ref: '../main', repo: { full_name: REPOSITORY } } }) }],
    ['a base tip that is not a commit', { 'git/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'tag', sha: BASE } } }],
    ['a base tip equal to the head', { 'git/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'commit', sha: HEAD } } }],
    ['an all-zero base tip', { 'git/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'commit', sha: ZERO } } }],
  ])('refuses %s', async (_label, overrides) => {
    await expect(bind(bindingApi(overrides))).rejects.toBeInstanceOf(BoundaryRefusal);
  });

  it.each([ZERO, 'A'.repeat(40), `${HEAD} `, ''])('refuses the head %j before any request', async (headSha) => {
    await expect(bind(routedApi({}), headSha)).rejects.toBeInstanceOf(BoundaryRefusal);
  });
});

function publishApi(): { api: GitHubApi; posts: Array<{ path: string; body: Record<string, unknown> }> } {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const api: GitHubApi = {
    async postJson(path, body) {
      posts.push({ path, body: body as Record<string, unknown> });
      return { id: 11 };
    },
    async getJson(path) {
      if (path !== 'check-runs/11') throw new Error('unexpected request');
      const last = posts.at(-1)!.body;
      return { id: 11, name: last['name'], head_sha: last['head_sha'], status: 'completed', conclusion: last['conclusion'] };
    },
  };
  return { api, posts };
}

const failing: CandidateScanResult = {
  version: 2,
  conclusion: 'fail',
  counts: { ...NO_COUNTS, 'added-lines': { 'private-host-label': 2 }, commits: { 'private-person': 1 } },
  scanned: { addedLines: 4, pathNames: 2, changedPaths: 2, commits: 1, commitLines: 4, commitPaths: 2, refNames: 1, texts: 2 },
};

describe('boundary (private) check run publication', () => {
  it('publishes success on the candidate head for a passing result', async () => {
    const { api, posts } = publishApi();
    const passing: CandidateScanResult = { ...failing, conclusion: 'pass', counts: NO_COUNTS };
    await expect(publishCheckRun(api, { headSha: HEAD, result: passing })).resolves.toBe('success');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe('check-runs');
    expect(posts[0]!.body).toMatchObject({ name: CHECK_NAME, head_sha: HEAD, status: 'completed', conclusion: 'success' });
  });

  it('publishes failure with counts by mode and rule code', async () => {
    const { api, posts } = publishApi();
    await expect(publishCheckRun(api, { headSha: HEAD, result: failing })).resolves.toBe('failure');
    const summary = JSON.stringify(posts[0]!.body['output']);
    expect(summary).toContain('added-lines private-host-label 2');
    expect(summary).toContain('commits private-person 1');
  });

  it('publishes failure with one fixed line when the scan left no result', async () => {
    const { api, posts } = publishApi();
    await expect(publishCheckRun(api, { headSha: HEAD, result: null })).resolves.toBe('failure');
    expect(posts[0]!.body).toMatchObject({ conclusion: 'failure', output: { title: 'boundary (private): the check could not complete' } });
  });

  it('refuses to publish on a malformed head', async () => {
    const { api, posts } = publishApi();
    await expect(publishCheckRun(api, { headSha: 'not-a-sha', result: failing })).rejects.toBeInstanceOf(BoundaryRefusal);
    expect(posts).toHaveLength(0);
  });
});

describe('boundary text check', () => {
  it('reads an issue and a comment from the event payload', () => {
    expect(collectEventItems('issues', { issue: { number: 4, id: 40, title: 'A title', body: 'A body' } }))
      .toEqual([{ kind: 'issue', number: 4, id: 40, text: 'A title\nA body' }]);
    expect(collectEventItems('issue_comment', { issue: { number: 4 }, comment: { id: 41, body: 'A comment' } }))
      .toEqual([{ kind: 'issue-comment', number: 4, id: 41, text: 'A comment' }]);
  });

  it('refuses an event it does not handle and a payload without its item', () => {
    expect(() => collectEventItems('pull_request_review', { review: { id: 1, body: 'x' } })).toThrow(BoundaryRefusal);
    expect(() => collectEventItems('issue_comment', { issue: { number: 4 } })).toThrow(BoundaryRefusal);
  });

  it('fails on a term and prints the item kind and number with counts only', () => {
    const result = scanTextItems([
      { kind: 'issue-comment', number: 4, id: 41, text: 'runs on zorblab\nand on zorblab again' },
      { kind: 'issue', number: 5, id: 50, text: 'A clean title\nA clean body' },
    ], termRules);
    expect(result.conclusion).toBe('fail');
    const lines = formatTextResult(result);
    expect(lines).toContain('boundary text: issue-comment #4 (id 41) private-host-label 2');
    expect(lines.some((line) => line.includes('#5'))).toBe(false);
    expectNoSyntheticTerm(lines.join('\n'));
  });

  it('passes clean items and says how many it scanned', () => {
    const result = scanTextItems([{ kind: 'review', number: 6, id: 60, text: 'Looks fine.' }], termRules);
    expect(result.conclusion).toBe('pass');
    expect(formatTextResult(result)).toEqual(['boundary text: 1 item(s) scanned; no findings']);
  });

  const listingApi = (handler: (name: string, params: URLSearchParams) => unknown): GitHubApi => ({
    async getJson(path) {
      const [name, query = ''] = path.split('?');
      const answer = handler(name!, new URLSearchParams(query));
      if (answer === undefined) throw new Error('unexpected request');
      return answer;
    },
    async postJson() {
      throw new Error('unexpected post');
    },
  });

  it('starts the hourly listing at the last successful scheduled run, else two hours back', async () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const runs = (workflowRuns: unknown[]) => listingApi((name, params) => (
      name === 'actions/workflows/boundary-private-text.yml/runs' && params.get('status') === 'success' && params.get('event') === 'schedule'
        ? { workflow_runs: workflowRuns }
        : undefined
    ));
    await expect(scheduleSince(runs([{ created_at: '2026-11-17T10:00:00Z' }]), now)).resolves.toBe('2026-11-17T09:45:00.000Z');
    await expect(scheduleSince(runs([]), now)).resolves.toBe('2026-11-17T10:00:00.000Z');
  });

  it('collects issues, pull requests, comments, review comments and reviews changed since a time', async () => {
    const since = '2026-11-17T09:45:00.000Z';
    const api = listingApi((name, params) => {
      if (name !== 'pulls/2/reviews' && params.get('since') !== since) return undefined;
      if (params.get('page') !== '1') return [];
      if (name === 'issues') return [{ number: 1, id: 10, title: 'An issue', body: null }, { number: 2, id: 20, title: 'A pull', body: 'Its body', pull_request: {} }];
      if (name === 'issues/comments') return [{ id: 30, body: 'A comment', issue_url: 'https://api.github.com/repos/owner-a/repo-a/issues/1' }];
      if (name === 'pulls/comments') return [{ id: 40, body: 'A review comment', pull_request_url: 'https://api.github.com/repos/owner-a/repo-a/pulls/2' }];
      if (name === 'pulls/2/reviews') return [{ id: 50, body: 'A review' }];
      return undefined;
    });
    await expect(collectChangedItems(api, since)).resolves.toEqual([
      { kind: 'issue', number: 1, id: 10, text: 'An issue\n' },
      { kind: 'pull-request', number: 2, id: 20, text: 'A pull\nIts body' },
      { kind: 'issue-comment', number: 1, id: 30, text: 'A comment' },
      { kind: 'review-comment', number: 2, id: 40, text: 'A review comment' },
      { kind: 'review', number: 2, id: 50, text: 'A review' },
    ]);
  });

  it('fails closed when a listing fills every page it may read', async () => {
    const full = Array.from({ length: 100 }, (_unused, index) => ({ number: index + 1, id: index + 1, title: 'An issue', body: '' }));
    const api = listingApi((name) => (name === 'issues' ? full : []));
    await expect(collectChangedItems(api, '2026-11-17T09:45:00.000Z')).rejects.toBeInstanceOf(BoundaryRefusal);
  });
});
