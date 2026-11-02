import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyRacing, parseStashes } from '../../scripts/git-estate-guard.ts';
import type { EstateScanCapture, EstateSnapshot } from '../../scripts/lib/git-estate-model.ts';
import {
  repoRoot, script, tmp, STATUS_TIMEOUT_GIT_BUDGET_MS, type SnapshotDocument, type GuardDocument,
  run, git, initRepo, snapshot, shellQuote, betweenScansEnvironment, worktreeOutputEnvironment,
  gitCallLogEnvironment, readGitCalls,
} from '../helpers/git-estate-guard-fixtures.ts';

describe('round 3 scan scope and diagnostics', () => {
  it.each(['unexplained topology', 'common directory', 'stash reflog'] as const)(
    'F10 F15 blocks %s drift even with an unrelated status change', (kind) => {
      const root = tmp.make('whatsoup-capture');
      const other = join(root, 'other');
      const start: EstateScanCapture = {
        commonDir: join(root, '.git'), worktrees: [], statusHashes: { [other]: 'before' },
        branchHashes: {}, refHashes: { 'refs/stash': 'unchanged' }, stashHash: 'before',
      };
      const end: EstateScanCapture = {
        ...start, statusHashes: { [other]: 'after' },
        ...(kind === 'common directory' ? { commonDir: join(root, 'another.git') } : {}),
        ...(kind === 'stash reflog' ? { stashHash: 'after' } : {}),
      };
      const captured: EstateSnapshot = {
        schemaVersion: 1, commonDir: start.commonDir, baselinePath: join(root, 'baseline.json'),
        invokingWorktreePath: join(root, 'invoking'), statusScope: 'repository',
        topologyFingerprintStart: 'before', topologyFingerprintEnd: 'after',
        statusFingerprintStart: 'before', statusFingerprintEnd: 'after',
        consistencyStart: start, consistencyEnd: end, incomplete: true, racing: true,
        worktrees: [], branches: [], stashes: [], findings: [], errors: [], snapshotHash: 'snapshot',
      };
      const decision = classifyRacing(captured, new Set(), new Set());
      expect(decision.scopedRacing).toBe(true);
      expect(decision.advisoryRacingWorktrees).toEqual([other]);
    },
  );

  it('F8 runs status only on the invoking and pushed worktrees', () => {
    const { root, repo } = initRepo();
    const pushed = join(root, 'pushed');
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'feat', pushed]);
    git(repo, ['worktree', 'add', '-b', 'other', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const calls = gitCallLogEnvironment(root);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/feat', '--json'], calls.env);
    expect(result.status, result.stderr).toBe(0);
    const statusCalls = readGitCalls(calls.log).filter((call) => call.includes(' status '));
    expect(statusCalls).toHaveLength(4);
    expect(statusCalls.filter((call) => call.includes(`-C ${repo} status `))).toHaveLength(2);
    expect(statusCalls.filter((call) => call.includes(`-C ${pushed} status `))).toHaveLength(2);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.snapshot).toMatchObject({ statusScope: 'pusher', incomplete: false, errors: [] });
    expect(doc.snapshot!.worktrees.find(({ path }) => path === other)!.status).toBeNull();
  });

  it.each(['fail', 'slow'] as const)('F8 never invokes an out-of-scope %s status', (mode) => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'other', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const called = join(root, 'out-of-scope-called');
    const wrapper = betweenScansEnvironment(root, ':',
      `if [ "$worktree_path" = ${shellQuote(other)} ]; then
        : > ${shellQuote(called)}
        ${mode === 'fail' ? 'exit 71' : 'exec sleep 30'}
      fi`);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--json'], {
      ...wrapper.env, WHATSOUP_GIT_ESTATE_GIT_TIMEOUT_MS: String(STATUS_TIMEOUT_GIT_BUDGET_MS),
    });
    expect(existsSync(called)).toBe(false);
    expect(result.status, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as GuardDocument).snapshot).toMatchObject({ incomplete: false, errors: [] });
  });

  it('F8 reports dead out-of-scope topology without a status error', () => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'other', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    rmSync(other, { recursive: true, force: true });
    const args = ['guard', '--phase', 'pre-push'];
    const result = run(repo, [...args, '--json']);
    expect(result.status, result.stderr).toBe(0);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.snapshot).toMatchObject({ statusScope: 'pusher', incomplete: false, errors: [] });
    const human = run(repo, args);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain(`WARN git-estate: prunable worktree=${JSON.stringify(other)}`);
    expect(human.stdout).toContain('complete=true');
  });

  it.each([['snapshot', '--json'], ['guard', '--phase', 'pre-commit', '--json']])(
    'F8 retains the full repository scan for %s', (...args) => {
      const { root, repo } = initRepo();
      const other = join(root, 'other');
      git(repo, ['worktree', 'add', '-b', 'other', other]);
      writeFileSync(join(other, 'untracked.txt'), 'other lane\n');
      const calls = gitCallLogEnvironment(root);
      const result = run(repo, args, calls.env);
      expect(result.status, result.stderr).toBe(0);
      const doc = JSON.parse(result.stdout) as SnapshotDocument;
      expect(doc.snapshot.statusScope).toBe('repository');
      expect(doc.snapshot.worktrees.find(({ path }) => path === other)!.status!.untracked).toEqual(['untracked.txt']);
      expect(readGitCalls(calls.log).filter((call) => call.includes(`-C ${other} status `)))
        .toHaveLength(args[0] === 'snapshot' ? 2 : 1);
    },
  );

  it('F8 scans a worktree entering a pushed branch between passes', () => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'other', other]);
    git(repo, ['branch', 'feat']);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const calls = join(root, 'status-calls');
    const race = betweenScansEnvironment(root,
      `"$real_git" -C ${shellQuote(other)} switch feat >/dev/null 2>&1`,
      `printf '%s:%s\\n' "$scan_pass" "$worktree_path" >> ${shellQuote(calls)}`);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/feat', '--json'], race.env);
    expect(result.status, result.stderr).toBe(2);
    expect(readFileSync(calls, 'utf8').trim().split('\n').sort()).toEqual([
      `1:${repo}`, `2:${repo}`, `2:${other}`,
    ].sort());
    expect((JSON.parse(result.stdout) as GuardDocument).decision.scopedRacing).toBe(true);
  });

  it.each([['feat', 2], ['main', 0]] as const)('F9 attributes a dead rebase when pushing %s', (pushed, exitCode) => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'feat', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    for (const [cwd, content] of [[repo, 'main'], [other, 'feat']] as const) {
      writeFileSync(join(cwd, 'tracked.txt'), `${content}\n`);
      git(cwd, ['commit', '-am', 'conflicting change']);
    }
    git(other, ['rebase', '--merge', 'main'], 1);
    rmSync(other, { recursive: true, force: true });
    const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', `refs/heads/${pushed}`, '--json']);
    expect(result.status, result.stderr).toBe(exitCode);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.snapshot!.worktrees.find(({ path }) => path === other)).toMatchObject({ detached: true, operationBranch: 'feat' });
    expect(doc.snapshot!.errors).toEqual(exitCode === 2
      ? [expect.objectContaining({ kind: 'worktree_status_failed', worktree: other })] : []);
  });

  it('F9 blocks failed operation attribution outside the proven scope', () => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '--detach', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const gitDir = git(other, ['rev-parse', '--absolute-git-dir']);
    mkdirSync(join(gitDir, 'BISECT_START'));
    const result = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(result.status, result.stderr).toBe(2);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.snapshot!.errors).toContainEqual(expect.objectContaining({
      kind: 'operation_branch_attribution_failed', worktree: other,
    }));
    expect(doc.decision.blockingReasons).toContain('scan_incomplete');
  });

  it.each(['relative', 'missing'] as const)('F9 resolves a %s admin gitdir entry', (kind) => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['branch', 'feat']);
    git(repo, ['worktree', 'add', '--detach', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const adminDir = git(other, ['rev-parse', '--absolute-git-dir']);
    const topologyFile = join(root, 'topology');
    writeFileSync(topologyFile, git(repo, ['worktree', 'list', '--porcelain', '-z']));
    writeFileSync(join(adminDir, 'BISECT_START'), 'feat\n');
    if (kind === 'relative') {
      writeFileSync(join(adminDir, 'gitdir'), `${relative(adminDir, join(other, '.git'))}\n`);
    } else {
      rmSync(join(adminDir, 'gitdir'));
    }
    rmSync(other, { recursive: true, force: true });
    // Hold the registered topology constant while exercising admin-file reads.
    const env = worktreeOutputEnvironment(root, `cat ${shellQuote(topologyFile)}`);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/feat', '--json'], env);
    expect(result.status, result.stderr).toBe(2);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.snapshot!.worktrees.find(({ path }) => path === other)!.operationBranch)
      .toBe(kind === 'relative' ? 'feat' : null);
    expect(doc.snapshot!.errors).toEqual([expect.objectContaining({
      kind: kind === 'relative' ? 'worktree_status_failed' : 'operation_branch_attribution_failed', worktree: other,
    })]);
    expect(doc.decision.blockingReasons).toContain('scan_incomplete');
  });

  it('F10 ignores a tag collision created between captures', () => {
    const { root, repo } = initRepo();
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const race = betweenScansEnvironment(root, `"$real_git" -C ${shellQuote(repo)} tag main`);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/main', '--json'], race.env);
    expect(existsSync(race.marker)).toBe(true);
    expect(result.status, result.stderr).toBe(0);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.snapshot).toMatchObject({ racing: false, incomplete: false });
    expect(doc.decision.reasons).toEqual([]);
  });

  it('F11 scopes the invoking bisect branch stash for a HEAD destination', () => {
    const { repo } = initRepo();
    git(repo, ['switch', '-c', 'feat']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    for (let i = 0; i < 3; i += 1) git(repo, ['commit', '--allow-empty', '-m', `step ${i}`]);
    git(repo, ['bisect', 'start']);
    git(repo, ['bisect', 'bad']);
    git(repo, ['bisect', 'good', base]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    writeFileSync(join(repo, 'tracked.txt'), 'stash content\n');
    const oid = git(repo, ['stash', 'create']);
    git(repo, ['stash', 'store', '-m', 'WIP on feat: saved', oid]);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/y', '--json']);
    expect(result.status, result.stderr).toBe(2);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    const stash = doc.snapshot!.findings.find(({ kind }) => kind === 'stash')!;
    expect(doc.decision.blockingFindingIds).toContain(stash.id);
  });

  it('F12 bounds scoped finding locations to ten and a remainder', () => {
    const { repo } = initRepo();
    const refs: string[] = [];
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    for (let i = 0; i < 11; i += 1) {
      git(repo, ['branch', `feat-${i}`]);
      git(repo, ['config', `branch.feat-${i}.remote`, '.']);
      git(repo, ['config', `branch.feat-${i}.merge`, 'refs/heads/missing']);
      refs.push('--push-local-ref', `refs/heads/feat-${i}`);
    }
    const result = run(repo, ['guard', '--phase', 'pre-push', ...refs]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout.split('\n').filter((line) => line.startsWith('BLOCK git-estate: branch_gone branch='))).toHaveLength(10);
    expect(result.stdout).toContain('BLOCK git-estate: 1 more blocking findings');
  });

  it('F12 names scoped racing worktrees and branches in JSON and human output', () => {
    const { root, repo } = initRepo();
    git(repo, ['branch', 'feat']);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    for (const json of [true, false]) {
      const next = git(repo, ['commit-tree', 'HEAD^{tree}', '-p', 'feat', '-m', 'next']);
      const target = join(repo, json ? 'first.txt' : 'second.txt');
      const race = betweenScansEnvironment(root,
        `printf 'changed\\n' > ${shellQuote(target)}
         "$real_git" -C ${shellQuote(repo)} update-ref refs/heads/feat ${next}`);
      const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/feat', ...(json ? ['--json'] : [])], race.env);
      expect(result.status, result.stderr).toBe(2);
      if (json) {
        const doc = JSON.parse(result.stdout) as GuardDocument;
        expect(doc.decision.scopedRacingWorktrees).toEqual([repo]);
        expect(doc.decision.scopedRacingBranches).toEqual(['feat']);
      } else {
        expect(result.stdout).toContain(`BLOCK git-estate: racing worktree=${JSON.stringify(repo)}`);
        expect(result.stdout).toContain('BLOCK git-estate: racing branch="feat"');
      }
    }
  });

  it('F13 drops syntactically valid stash names without a local branch', () => {
    const { repo } = initRepo();
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    writeFileSync(join(repo, 'tracked.txt'), 'stash content\n');
    const oid = git(repo, ['stash', 'create']);
    git(repo, ['stash', 'store', '-m', 'On acme-renewal: notes', oid]);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('acme-renewal');
    expect((JSON.parse(result.stdout) as GuardDocument).snapshot!.stashes[0]!.branch).toBeNull();
    const human = run(repo, ['guard', '--phase', 'pre-push']);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).not.toContain('acme-renewal');
    expect(human.stdout).toContain('stash branch="(unknown)"');
  });

  it.each([false, true])('F15 bounds racing output and retains mixed drift (scoped=%s)', (scoped) => {
    const { root, repo } = initRepo();
    const branches = Array.from({ length: 11 }, (_, i) => `other-${i}`);
    for (const branch of branches) git(repo, ['branch', branch]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const next = git(repo, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'next']);
    const change = branches.map((branch) =>
      `"$real_git" -C ${shellQuote(repo)} update-ref refs/heads/${branch} ${next}`).join('\n');
    const race = betweenScansEnvironment(root, change);
    const refs = scoped ? branches.flatMap((branch) => ['--push-local-ref', `refs/heads/${branch}`]) : [];
    const result = run(repo, ['guard', '--phase', 'pre-push', ...refs], race.env);
    expect(result.status, result.stderr).toBe(scoped ? 2 : 0);
    expect(result.stdout.split('\n').filter((line) => line.startsWith(`${scoped ? 'BLOCK' : 'WARN'} git-estate: racing branch=`))).toHaveLength(10);
    expect(result.stdout).toContain('1 more racing locations');
  });

  it('F15 blocks scoped drift while listing out-of-scope branch drift', () => {
    const { root, repo } = initRepo();
    git(repo, ['branch', 'other']);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    for (const json of [true, false]) {
      const next = git(repo, ['commit-tree', 'HEAD^{tree}', '-p', 'other', '-m', 'next']);
      const race = betweenScansEnvironment(root,
        `printf 'changed\\n' > ${shellQuote(join(repo, json ? 'first.txt' : 'second.txt'))}
         "$real_git" -C ${shellQuote(repo)} update-ref refs/heads/other ${next}`);
      const result = run(repo, ['guard', '--phase', 'pre-push', ...(json ? ['--json'] : [])], race.env);
      expect(result.status, result.stderr).toBe(2);
      if (json) {
        const doc = JSON.parse(result.stdout) as GuardDocument;
        expect(doc.decision.scopedRacing).toBe(true);
        expect(doc.decision.advisoryRacingBranches).toEqual(['other']);
      } else {
        expect(result.stdout).toContain(`BLOCK git-estate: racing worktree=${JSON.stringify(repo)}`);
        expect(result.stdout).toContain('WARN git-estate: racing branch="other"');
      }
    }
  });

  it('F15 routes a real pre-push stdin line to a scoped estate block', () => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'feat', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    git(repo, ['worktree', 'lock', other]);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: {
      'guard:git-estate': `${shellQuote(process.execPath)} --experimental-strip-types ${shellQuote(script)}`,
    } }));
    const oid = git(repo, ['rev-parse', 'feat']);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', resolve(repoRoot, 'scripts/pre-push-guard.ts')], {
      cwd: repo, encoding: 'utf8', input: `refs/heads/feat ${oid} refs/heads/feat ${'0'.repeat(40)}\n`,
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain(`BLOCK git-estate: locked worktree=${JSON.stringify(other)}`);
    expect(result.stderr).not.toContain('missing required console');
  });
});

describe('scoped consistency and attribution', () => {
  it('blocks unattributed racing while preserving out-of-scope status advisories', () => {
    const root = tmp.make('whatsoup-racing');
    const other = join(root, 'other');
    const capture: EstateScanCapture = {
      commonDir: join(root, '.git'),
      worktrees: [],
      statusHashes: { [other]: 'unchanged' },
      branchHashes: {},
      refHashes: {},
      stashHash: 'unchanged',
    };
    const racingSnapshot: EstateSnapshot = {
      schemaVersion: 1,
      statusScope: 'repository',
      commonDir: capture.commonDir,
      baselinePath: join(capture.commonDir, 'whatsoup', 'git-estate-baseline.v2.json'),
      invokingWorktreePath: join(root, 'invoking'),
      topologyFingerprintStart: 'before',
      topologyFingerprintEnd: 'after',
      statusFingerprintStart: 'unchanged',
      statusFingerprintEnd: 'unchanged',
      consistencyStart: capture,
      consistencyEnd: capture,
      incomplete: true,
      racing: true,
      worktrees: [],
      branches: [],
      stashes: [],
      findings: [],
      errors: [],
      snapshotHash: 'snapshot',
    };
    expect(classifyRacing({
      ...racingSnapshot,
      topologyFingerprintEnd: racingSnapshot.topologyFingerprintStart,
      consistencyEnd: { ...capture, statusHashes: { [other]: 'changed' } },
    }, new Set(), new Set())).toEqual({
      scopedRacing: false,
      scopedRacingWorktrees: [],
      scopedRacingBranches: [],
      advisoryRacingWorktrees: [other],
      advisoryRacingBranches: [],
    });
    expect(classifyRacing(racingSnapshot, new Set(), new Set())).toEqual({
      scopedRacing: true,
      scopedRacingWorktrees: [],
      scopedRacingBranches: [],
      advisoryRacingWorktrees: [],
      advisoryRacingBranches: [],
    });
  });

  it.each([
    ['main', 2],
    ['other', 0],
  ] as const)('scopes status drift in %s between passes', (branch, exitCode) => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'other', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const target = branch === 'main' ? repo : other;
    const change = `printf 'changed\\n' > ${shellQuote(join(target, 'new.txt'))}`;
    const race = betweenScansEnvironment(root, change);
    const args = ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/main'];
    const result = run(repo, [...args, '--json'], race.env);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(existsSync(race.marker)).toBe(true);
    expect(doc.snapshot).toMatchObject({ racing: exitCode === 2, incomplete: exitCode === 2 });
    expect(doc.snapshot!.errors).toEqual([]);
    expect(existsSync(join(target, 'new.txt'))).toBe(true);
    expect(result.status, result.stderr).toBe(exitCode);
    expect(doc.decision.blockingReasons).toEqual(exitCode === 2 ? ['scan_incomplete', 'scan_racing'] : []);
    if (exitCode === 0) {
      expect(doc.decision.scopedRacing).toBe(false);
      expect(doc.decision.advisoryRacingWorktrees).toEqual([]);
      expect(doc.decision.advisoryReasons).toEqual([]);
      rmSync(join(target, 'new.txt'));
      const humanRace = betweenScansEnvironment(root, change);
      const human = run(repo, args, humanRace.env);
      expect(existsSync(humanRace.marker)).toBe(true);
      expect(human.status, human.stderr).toBe(0);
      expect(human.stdout).toContain('OK');
      expect(human.stdout).not.toContain('other_worktree_scan_racing');
      expect(human.stdout).not.toContain(JSON.stringify(other));
    }
  });

  it.each([['feat', 2], ['other', 0]] as const)(
    'scopes branch ref drift on %s without a worktree between passes', (branch, exitCode) => {
      const { root, repo } = initRepo();
      git(repo, ['branch', branch]);
      const next = git(repo, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'next']);
      expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
      const race = betweenScansEnvironment(root,
        `"$real_git" -C ${shellQuote(repo)} update-ref refs/heads/${branch} ${next}`);
      const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/feat', '--json'], race.env);
      const doc = JSON.parse(result.stdout) as GuardDocument;
      expect(existsSync(race.marker)).toBe(true);
      expect(doc.snapshot!.racing).toBe(true);
      expect(doc.snapshot!.errors).toEqual([]);
      expect(git(repo, ['rev-parse', `refs/heads/${branch}`])).toBe(next);
      expect(result.status, result.stderr).toBe(exitCode);
      if (exitCode === 0) {
        expect(doc.decision.scopedRacing).toBe(false);
        expect(doc.decision.advisoryRacingBranches).toEqual(['other']);
      }
      expect(doc.decision.reasons).toContain(exitCode === 2 ? 'scan_racing' : 'other_worktree_scan_racing');
    },
  );

  it.each([['other', 0], ['feat', 2]] as const)(
    'scopes a worktree on %s appearing between passes', (branch, exitCode) => {
      const { root, repo } = initRepo();
      const added = join(root, 'added');
      git(repo, ['branch', branch]);
      expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
      const race = betweenScansEnvironment(root,
        `"$real_git" -C ${shellQuote(repo)} worktree add ${shellQuote(added)} ${branch} >/dev/null 2>&1`);
      const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/feat', '--json'], race.env);
      const doc = JSON.parse(result.stdout) as GuardDocument;
      expect(existsSync(race.marker)).toBe(true);
      expect(doc.snapshot!.racing).toBe(true);
      expect(doc.snapshot!.errors).toEqual([]);
      expect(existsSync(added)).toBe(true);
      expect(result.status, result.stderr).toBe(exitCode);
      if (exitCode === 0) expect(doc.decision.advisoryRacingWorktrees).toEqual([added]);
      expect(doc.decision.reasons).toContain(exitCode === 2 ? 'scan_racing' : 'other_worktree_scan_racing');
    },
  );

  it('blocks when a worktree leaves a pushed branch between passes', () => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'feat', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const race = betweenScansEnvironment(root,
      `"$real_git" -C ${shellQuote(other)} switch --detach >/dev/null 2>&1`);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/feat', '--json'], race.env);
    expect(existsSync(race.marker)).toBe(true);
    expect(result.status, result.stderr).toBe(2);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.snapshot!.errors).toEqual([]);
    expect(git(other, ['symbolic-ref', '--quiet', 'HEAD'], 1)).toBe('');
    expect(doc.decision.reasons).toContain('scan_racing');
  });

  it('blocks a stash ref change between passes', () => {
    const { root, repo } = initRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'stash content\n');
    const oid = git(repo, ['stash', 'create']);
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const race = betweenScansEnvironment(root,
      `"$real_git" -C ${shellQuote(repo)} stash store -m 'On other: stored' ${oid}`);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--json'], race.env);
    expect(existsSync(race.marker)).toBe(true);
    expect(result.status, result.stderr).toBe(2);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.snapshot!.errors).toEqual([]);
    expect(git(repo, ['rev-parse', 'refs/stash'])).toBe(oid);
    expect(doc.decision.reasons).toContain('scan_racing');
  });

  it.each([['other', 0], ['main', 2]] as const)(
    'scopes a status rescan failure in %s', (branch, exitCode) => {
      const { root, repo } = initRepo();
      const other = join(root, 'other');
      git(repo, ['worktree', 'add', '-b', 'other', other]);
      expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
      const target = branch === 'main' ? repo : other;
      const race = betweenScansEnvironment(root, ':',
        `if [ "$scan_pass" -eq 2 ] && [ "$worktree_path" = ${shellQuote(target)} ]; then exit 71; fi`);
      const result = run(repo, ['guard', '--phase', 'pre-push', '--json'], race.env);
      const doc = JSON.parse(result.stdout) as GuardDocument;
      expect(doc.snapshot!.errors).toEqual(exitCode === 2 ? [
        expect.objectContaining({ kind: 'worktree_status_rescan_failed', worktree: target }),
      ] : []);
      expect(result.status, result.stderr).toBe(exitCode);
      expect(doc.decision.reasons).toEqual(exitCode === 2 ? ['scan_incomplete', 'scan_racing'] : []);
    },
  );

  it.each(['in-scope', 'global'] as const)('blocks an %s error while omitting out-of-scope status', (kind) => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'other', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const race = betweenScansEnvironment(root, kind === 'global' ? 'exit 71' : ':',
      kind === 'in-scope' ? 'exit 71' : `if [ "$worktree_path" = ${shellQuote(other)} ]; then exit 71; fi`);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--json'], race.env);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(result.status, result.stderr).toBe(2);
    expect(doc.decision.blockingReasons).toContain('scan_incomplete');
    expect(doc.snapshot!.errors).toEqual([
      expect.objectContaining(kind === 'global'
        ? { kind: 'topology_rescan_failed' }
        : { kind: 'worktree_status_failed', worktree: repo }),
    ]);
  });

  it('blocks a gone invoking branch with a colliding tag without changing identity', () => {
    const { repo } = initRepo();
    git(repo, ['switch', '-c', 'release-1']);
    git(repo, ['branch', 'upstream']);
    git(repo, ['tag', 'release-1']);
    git(repo, ['config', 'branch.release-1.remote', '.']);
    git(repo, ['config', 'branch.release-1.merge', 'refs/heads/upstream']);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    git(repo, ['branch', '-d', 'upstream']);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/release-1', '--json']);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    const branch = doc.snapshot!.branches.find(({ name }) => name === 'heads/release-1')!;
    const finding = doc.snapshot!.findings.find(({ kind }) => kind === 'branch_gone')!;
    expect(branch).toMatchObject({ name: 'heads/release-1', gone: true });
    const digest = createHash('sha256').update(`branch_gone\0${branch.name}\0${branch.upstream}`).digest('hex').slice(0, 24);
    expect(finding).toMatchObject({ branch: 'heads/release-1', id: `branch_gone:${digest}` });
    expect(result.status, result.stderr).toBe(2);
    expect(branch.scopeName).toBe('release-1');
    expect(doc.decision.blockingFindingIds).toContain(finding.id);
    expect(doc.decision.advisoryFindingIds).not.toContain(finding.id);
    expect(doc.decision.newBranchIds).toEqual([]);
  });

  it.each([
    'customer acme renewal notes', 'main:SECRET', 'bad\tname', 'bad\x01name',
    'bad~name', 'bad^name', 'bad?name', 'bad*name', 'bad[name', 'bad\\name',
    'bad..name', 'bad@{name', '-bad', '/bad', 'bad/', 'bad.', 'bad.lock',
    'bad//name', '.bad', 'bad/.name', 'bad.lock/name', '@',
  ])('discards invalid stash branch syntax %j', (branch) => {
    expect(parseStashes(`${'a'.repeat(40)}\0${'b'.repeat(40)}\0On ${branch}: x\0\n`)).toEqual([
      { oid: 'a'.repeat(40), parents: ['b'.repeat(40)], branch: null },
    ]);
  });

  it.each([
    ['customer acme renewal notes', 'json'],
    ['customer acme renewal notes', 'human'],
    ['main:SECRET', 'json'],
    ['main:SECRET', 'human'],
  ] as const)(
    'keeps malformed stash branch %s out of %s output', (branch, format) => {
      const { repo } = initRepo();
      expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
      writeFileSync(join(repo, 'tracked.txt'), 'stash content\n');
      const oid = git(repo, ['stash', 'create']);
      git(repo, ['stash', 'store', '-m', `On ${branch}: x`, oid]);
      const args = ['guard', '--phase', 'pre-push'];
      const result = run(repo, format === 'json' ? [...args, '--json'] : args);
      expect(result.stdout).not.toContain(branch);
      expect(result.status, result.stderr).toBe(0);
      if (format === 'json') {
        const doc = JSON.parse(result.stdout) as GuardDocument;
        expect(doc.snapshot!.stashes).toEqual([expect.objectContaining({ oid, branch: null })]);
        expect(doc.decision.advisoryFindingIds).toHaveLength(1);
      } else {
        expect(result.stdout).toContain('branch="(unknown)"');
      }
    },
  );

  it.each([
    ['--merge', false],
    ['--apply', false],
    ['--merge', true],
  ] as const)('keeps the pushed branch in scope during a conflicted rebase %s (statusFailure=%s)', (backend, statusFailure) => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'feat', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    for (const [cwd, content] of [[repo, 'main'], [other, 'feat']] as const) {
      writeFileSync(join(cwd, 'tracked.txt'), `${content}\n`);
      git(cwd, ['commit', '-am', 'conflicting change']);
    }
    git(other, ['rebase', backend, 'main'], 1);
    const env = statusFailure ? betweenScansEnvironment(root, ':',
      `if [ "$worktree_path" = ${shellQuote(other)} ]; then exit 71; fi`).env : {};
    const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/feat', '--json'], env);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.snapshot!.worktrees.find(({ path }) => path === other)).toMatchObject({ detached: true });
    expect(result.status, result.stderr).toBe(2);
    expect(doc.snapshot!.worktrees.find(({ path }) => path === other)!.operationBranch).toBe('feat');
    if (statusFailure) {
      expect(doc.snapshot!.errors).toEqual([
        expect.objectContaining({ kind: 'worktree_status_failed', worktree: other }),
      ]);
      expect(doc.decision.blockingReasons).toContain('scan_incomplete');
    } else {
      const conflict = doc.snapshot!.findings.find(({ kind }) => kind === 'conflict')!;
      expect(conflict).toMatchObject({ worktree: other });
      expect(doc.decision.blockingFindingIds).toContain(conflict.id);
      expect(doc.decision.reasons).toContain('new_conflicts');
    }
  });

  it('keeps the pushed branch in scope during bisect', () => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'feat', other]);
    const base = git(other, ['rev-parse', 'HEAD']);
    for (let i = 0; i < 3; i += 1) git(other, ['commit', '--allow-empty', '-m', `step ${i}`]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    git(other, ['bisect', 'start']);
    git(other, ['bisect', 'bad']);
    git(other, ['bisect', 'good', base]);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/feat', '--json']);
    expect(result.status, result.stderr).toBe(2);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.snapshot!.worktrees.find(({ path }) => path === other)).toMatchObject({ detached: true, operationBranch: 'feat' });
    const finding = doc.snapshot!.findings.find(({ kind }) => kind === 'detached')!;
    expect(doc.decision.blockingFindingIds).toContain(finding.id);
  });

  it('blocks debt on the second pushed ref', () => {
    const { root, repo } = initRepo();
    const other = join(root, 'other');
    git(repo, ['worktree', 'add', '-b', 'second', other]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    git(repo, ['worktree', 'lock', other]);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--push-local-ref', 'refs/heads/main', '--push-local-ref', 'refs/heads/second', '--json']);
    expect(result.status, result.stderr).toBe(2);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.decision.blockingFindingIds).toEqual([doc.snapshot!.findings.find(({ kind }) => kind === 'locked')!.id]);
  });

  it('bounds eleven advisory findings to ten location lines and a remainder', () => {
    const { repo } = initRepo();
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    for (let i = 0; i < 11; i += 1) {
      git(repo, ['branch', `other-${i}`]);
      git(repo, ['config', `branch.other-${i}.remote`, '.']);
      git(repo, ['config', `branch.other-${i}.merge`, 'refs/heads/missing']);
    }
    const result = run(repo, ['guard', '--phase', 'pre-push']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split('\n').filter((line) => line.includes('branch_gone branch='))).toHaveLength(10);
    expect(result.stdout).toContain('1 more');
  });

  it('blocks a conflict in a detached invoking worktree by path', () => {
    const { repo } = initRepo();
    git(repo, ['switch', '-c', 'other']);
    writeFileSync(join(repo, 'tracked.txt'), 'other\n');
    git(repo, ['commit', '-am', 'other change']);
    git(repo, ['switch', '--detach', 'main']);
    writeFileSync(join(repo, 'tracked.txt'), 'detached\n');
    git(repo, ['commit', '-am', 'detached change']);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    git(repo, ['merge', 'other'], 1);
    const result = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(result.status, result.stderr).toBe(2);
    const doc = JSON.parse(result.stdout) as GuardDocument;
    expect(doc.snapshot!.worktrees[0]!.detached).toBe(true);
    expect(doc.decision.reasons).toContain('new_conflicts');
    expect(doc.decision.blockingFindingIds).toContain(doc.snapshot!.findings.find(({ kind }) => kind === 'conflict')!.id);
  });
});
