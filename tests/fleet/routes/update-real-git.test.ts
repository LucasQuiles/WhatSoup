import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleUpdate } from '../../../src/fleet/routes/update.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeReqRes() {
  const chunks: string[] = [];
  const req = {
    on: () => undefined,
  } as any;
  const res = {
    writeHead: () => undefined,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => undefined,
    get chunks() {
      return chunks;
    },
  } as any;
  return { req, res };
}

function parseSSE(chunks: string[]) {
  return chunks.map((chunk) => {
    const lines = chunk.split('\n').filter(Boolean);
    const event = lines.find((l) => l.startsWith('event:'))?.slice('event:'.length).trim();
    const dataLine = lines.find((l) => l.startsWith('data:'))?.slice('data:'.length).trim();
    return { event, data: dataLine ? JSON.parse(dataLine) : undefined };
  });
}

describe('handleUpdate rollback with real git', () => {
  let tmpRoot: string | undefined;
  let patchPath: string | undefined;
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
    if (patchPath) {
      unlinkSync(patchPath);
      patchPath = undefined;
    }
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  it('preserves tracked rollback drift without stashing pre-existing untracked files', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-update-real-git-'));
    const remote = join(tmpRoot, 'remote.git');
    const seed = join(tmpRoot, 'seed');
    const repo = join(tmpRoot, 'repo');
    const fakeBin = join(tmpRoot, 'bin');

    execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    execFileSync('git', ['init', seed], { encoding: 'utf8' });
    git(seed, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(seed, ['config', 'user.email', 'whatsoup-test.invalid']);
    git(seed, ['config', 'user.name', 'WhatSoup Test']);
    writeFileSync(join(seed, 'package-lock.json'), 'base lock\n');
    git(seed, ['add', 'package-lock.json']);
    git(seed, ['commit', '-m', 'base']);
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', '-u', 'origin', 'main']);

    execFileSync('git', ['clone', remote, repo], { encoding: 'utf8' });
    git(repo, ['switch', 'main']);
    const prePullSha = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'operator-note.txt'), 'do not move\n');

    writeFileSync(join(seed, 'package-lock.json'), 'remote lock\n');
    git(seed, ['add', 'package-lock.json']);
    git(seed, ['commit', '-m', 'remote lock update']);
    git(seed, ['push', 'origin', 'main']);

    mkdirSync(fakeBin);
    const npmPath = join(fakeBin, 'npm');
    writeFileSync(
      npmPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nif [ "${1:-}" = "install" ]; then\n  printf "resolved during install\\n" > package-lock.json\n  exit 1\nfi\nexit 127\n',
    );
    chmodSync(npmPath, 0o700);
    process.env.PATH = `${fakeBin}:${originalPath}`;

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, { checkNow: async () => undefined, getState: () => ({}) } as any, repo);

    const events = parseSSE(res.chunks);
    const rollbackEvent = events.find((entry) => (
      entry.event === 'progress'
      && entry.data?.step === 'rollback'
      && entry.data?.status === 'done'
    ));
    expect(rollbackEvent).toBeDefined();
    expect(rollbackEvent!.data.preservedFiles).toEqual(['package-lock.json']);
    expect(rollbackEvent!.data.patchPath).toMatch(/^\/tmp\/whatsoup-update-rollback-.*-.*\.patch$/);
    expect(rollbackEvent!.data.stashRef).toBe('stash@{0}');
    patchPath = rollbackEvent!.data.patchPath;

    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(prePullSha);
    expect(readFileSync(join(repo, 'package-lock.json'), 'utf8')).toBe('base lock\n');
    expect(readFileSync(join(repo, 'operator-note.txt'), 'utf8')).toBe('do not move\n');

    const status = git(repo, ['status', '--porcelain']);
    expect(status).toContain('?? operator-note.txt');
    expect(status).not.toContain('package-lock.json');

    expect(readFileSync(patchPath!, 'utf8')).toContain('resolved during install');
    expect(statSync(patchPath!).mode & 0o777).toBe(0o600);
    expect(git(repo, ['stash', 'list'])).toContain('whatsoup-update-rollback');
    expect(existsSync(join(repo, 'operator-note.txt'))).toBe(true);
  });
});
