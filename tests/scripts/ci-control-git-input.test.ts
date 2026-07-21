import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ExactGitInputError,
  MAX_CHANGE_FACT_COUNT,
  MAX_EXACT_ADDED_LINE_BYTES,
  MAX_EXACT_ADDED_LINE_COUNT,
  MAX_EXACT_ADDED_LINE_PATCH_BYTES,
  MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT,
  MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES,
  MAX_EXACT_ADDED_LINE_CHANGE_COUNT,
  MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT,
  MAX_EXACT_AGGREGATE_BLOB_BYTES,
  MAX_EXACT_BLOB_COUNT,
  MAX_EXACT_COMMIT_COUNT,
  MAX_EXACT_COMMIT_PARENT_EDGE_COUNT,
  MAX_EXACT_COMMIT_RANGE_BYTES,
  MAX_EXACT_AGGREGATE_COMMIT_METADATA_BYTES,
  MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES,
  MAX_EXACT_SINGLE_BLOB_BYTES,
  readExactChangeFacts,
  readExactAddedLines,
  readExactBlobs,
  readExactCommitRange,
  readExactCommitMetadata,
} from '../../scripts/lib/ci-control/git-input.ts';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function gitEnvironment(cwd: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: cwd,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnvironment(cwd),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitWithInput(cwd: string, args: string[], input: Uint8Array): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnvironment(cwd),
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function commit(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function fixture(): { root: string; baseOid: string } {
  const root = mkdtempSync(join(tmpdir(), 'ci-control-git-input-'));
  temporaryRoots.push(root);
  git(root, ['init', '--quiet', '--object-format=sha1']);
  write(root, 'README.md', 'base\n');
  return { root, baseOid: commit(root, 'base') };
}

function expectCode(run: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ExactGitInputError);
  expect(thrown).toMatchObject({ code });
  expect(String(thrown)).toContain(code);
}

function expectNoVisibleCause(value: unknown): void {
  expect(Object.prototype.hasOwnProperty.call(value, 'cause')).toBe(false);
  expect('cause' in Object(value)).toBe(false);
}

function hashBlob(root: string, bytes: Uint8Array): string {
  return gitWithInput(root, ['hash-object', '-w', '--stdin'], bytes);
}

function blobOid(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex');
}

function commitOid(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(`commit ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex');
}

function rawCommitBody(options: {
  treeOid?: string;
  parentOids?: readonly string[];
  author?: string;
  committer?: string;
  optionalHeaders?: readonly string[];
  message?: string;
} = {}): Buffer {
  const treeOid = options.treeOid ?? '1'.repeat(40);
  const author = options.author ?? 'Fixture Author <fixture@example.invalid> 1700000000 +0000';
  const committer = options.committer ?? author;
  return Buffer.from([
    `tree ${treeOid}`,
    ...(options.parentOids ?? []).map((oid) => `parent ${oid}`),
    `author ${author}`,
    `committer ${committer}`,
    ...(options.optionalHeaders ?? []),
    '',
    options.message ?? '',
  ].join('\n'), 'utf8');
}

function commitMetadataResponses(
  entries: readonly { oid: string; body: Buffer; type?: string; size?: string }[],
  objectFormat = 'sha1\n',
): Record<string, GitShimResponse> {
  const responses: Record<string, GitShimResponse> = {
    [responseKey(['rev-parse', '--show-object-format'])]: { stdout: objectFormat },
  };
  for (const entry of entries) {
    responses[responseKey(['cat-file', '-t', '--', entry.oid])] = {
      stdout: entry.type ?? 'commit\n',
    };
    responses[responseKey(['cat-file', '-s', '--', entry.oid])] = {
      stdout: entry.size ?? `${entry.body.byteLength}\n`,
    };
    responses[responseKey(['cat-file', 'commit', '--', entry.oid])] = {
      stdoutBase64: entry.body.toString('base64'),
    };
  }
  return responses;
}

function extractModuleSpecifiers(source: string): string[] {
  return [
    ...[...source.matchAll(/\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gu)]
      .map((match) => match[1]!),
    ...[...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu)]
      .map((match) => match[1]!),
  ];
}

interface GitShimResponse {
  stdout?: string;
  stdoutBase64?: string;
  stderr?: string;
  exit?: number;
  signal?: 'SIGKILL';
}

function responseKey(args: readonly string[]): string {
  return JSON.stringify(args);
}

function withGitShim<T>(
  responses: Record<string, GitShimResponse>,
  run: (cwd: string) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), 'ci-control-git-shim-'));
  temporaryRoots.push(root);
  const bin = join(root, 'bin');
  const cwd = join(root, 'work');
  mkdirSync(bin);
  mkdirSync(cwd);
  const scenarioPath = join(cwd, '.git-input-shim.json');
  writeFileSync(scenarioPath, JSON.stringify({ cwd, responses }), 'utf8');
  const shimPath = join(bin, 'git');
  writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const scenario = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.git-input-shim.json'), 'utf8'));
const args = process.argv.slice(2);
const fail = (message, code) => { fs.writeSync(2, message); process.exit(code); };
if (process.cwd() !== scenario.cwd) fail('unexpected cwd', 91);
if (args[0] !== '--no-replace-objects') fail('replacement isolation missing', 92);
if (process.env.GIT_NO_REPLACE_OBJECTS !== '1') fail('replace env missing', 93);
if (process.env.GIT_NO_LAZY_FETCH !== '1') fail('lazy fetch env missing', 94);
if (process.env.GIT_OPTIONAL_LOCKS !== '0') fail('optional locks env missing', 95);
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
  if (process.env[name] !== undefined) fail('ambient git env leaked', 96);
}
const key = JSON.stringify(args.slice(1));
const response = scenario.responses[key];
if (response === undefined) fail('unexpected args', 97);
if (response.stdoutBase64 !== undefined) fs.writeSync(1, Buffer.from(response.stdoutBase64, 'base64'));
else if (response.stdout !== undefined) fs.writeSync(1, response.stdout);
if (response.stderr !== undefined) fs.writeSync(2, response.stderr);
if (response.signal === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
process.exit(response.exit ?? 0);
`, 'utf8');
  chmodSync(shimPath, 0o755);

  const names = ['PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.GIT_DIR = '/ambient/repository';
  process.env.GIT_WORK_TREE = '/ambient/worktree';
  process.env.GIT_INDEX_FILE = '/ambient/index';
  try {
    return run(cwd);
  } finally {
    for (const name of names) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function addedLineShimResponses(
  baseOid: string,
  candidateOid: string,
  path: string,
  oldBytes: Buffer,
  newBytes: Buffer,
  patch: Buffer,
): Record<string, GitShimResponse> {
  const oldOid = blobOid(oldBytes);
  const newOid = blobOid(newBytes);
  const raw = Buffer.concat([
    Buffer.from(`:100644 100644 ${oldOid} ${newOid} M\0`, 'ascii'),
    Buffer.from(path, 'utf8'),
    Buffer.from([0]),
  ]);
  const diffArgs = [
    '-c', 'diff.algorithm=myers', 'diff', '--patch', '--unified=0',
    '--no-indent-heuristic', '--text', '--full-index', '--no-prefix',
    '--no-color', '--no-ext-diff', '--no-textconv', oldOid, newOid, '--',
  ];
  return {
    [responseKey(['cat-file', '-t', '--', baseOid])]: { stdout: 'commit\n' },
    [responseKey(['cat-file', '-t', '--', candidateOid])]: { stdout: 'commit\n' },
    [responseKey(['merge-base', '--all', baseOid, candidateOid])]: { stdout: `${baseOid}\n` },
    [responseKey([
      'diff-tree', '--raw', '-z', '--no-commit-id', '-r', '--abbrev=40',
      '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
      baseOid, candidateOid, '--',
    ])]: { stdoutBase64: raw.toString('base64') },
    [responseKey([
      '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
      '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', '--find-renames', '--find-copies',
      '--find-copies-harder', baseOid, candidateOid, '--',
    ])]: { stdoutBase64: raw.toString('base64') },
    [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
    [responseKey(['cat-file', '-t', '--', oldOid])]: { stdout: 'blob\n' },
    [responseKey(['cat-file', '-s', '--', oldOid])]: { stdout: `${oldBytes.byteLength}\n` },
    [responseKey(['cat-file', 'blob', '--', oldOid])]: { stdoutBase64: oldBytes.toString('base64') },
    [responseKey(['cat-file', '-t', '--', newOid])]: { stdout: 'blob\n' },
    [responseKey(['cat-file', '-s', '--', newOid])]: { stdout: `${newBytes.byteLength}\n` },
    [responseKey(['cat-file', 'blob', '--', newOid])]: { stdoutBase64: newBytes.toString('base64') },
    [responseKey(diffArgs)]: { stdoutBase64: patch.toString('base64') },
  };
}

function addedFactsShimResponses(
  baseOid: string,
  candidateOid: string,
  facts: readonly { path: string; bytes: Buffer }[],
): Record<string, GitShimResponse> {
  const raw = Buffer.concat(facts.map(({ path, bytes }) => Buffer.from(
    `:000000 100644 ${'0'.repeat(40)} ${blobOid(bytes)} A\0${path}\0`,
    'ascii',
  )));
  const responses: Record<string, GitShimResponse> = {
    [responseKey(['cat-file', '-t', '--', baseOid])]: { stdout: 'commit\n' },
    [responseKey(['cat-file', '-t', '--', candidateOid])]: { stdout: 'commit\n' },
    [responseKey(['merge-base', '--all', baseOid, candidateOid])]: { stdout: `${baseOid}\n` },
    [responseKey([
      'diff-tree', '--raw', '-z', '--no-commit-id', '-r', '--abbrev=40',
      '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
      baseOid, candidateOid, '--',
    ])]: { stdoutBase64: raw.toString('base64') },
    [responseKey([
      '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
      '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', '--find-renames', '--find-copies',
      '--find-copies-harder', baseOid, candidateOid, '--',
    ])]: { stdoutBase64: raw.toString('base64') },
    [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
  };
  for (const { bytes } of facts) {
    const oid = blobOid(bytes);
    responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'blob\n' };
    responses[responseKey(['cat-file', '-s', '--', oid])] = {
      stdout: `${bytes.byteLength}\n`,
    };
    responses[responseKey(['cat-file', 'blob', '--', oid])] = {
      stdoutBase64: bytes.toString('base64'),
    };
  }
  return responses;
}

function emptyRangeResponses(oid: string): Record<string, GitShimResponse> {
  return {
    [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
    [responseKey(['cat-file', '-t', '--', oid])]: { stdout: 'commit\n' },
    [responseKey(['merge-base', '--all', oid, oid])]: { stdout: `${oid}\n` },
    [responseKey(['rev-list', '--count', `${oid}..${oid}`, '--'])]: { stdout: '0\n' },
    [responseKey(['rev-list', '--parents', `${oid}..${oid}`, '--'])]: { stdout: '' },
  };
}

function rangeResponses(
  baseOid: string,
  localOid: string,
  countOutput: string,
  rows: Uint8Array,
  rowExit = 0,
): Record<string, GitShimResponse> {
  return {
    [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
    [responseKey(['cat-file', '-t', '--', baseOid])]: { stdout: 'commit\n' },
    [responseKey(['cat-file', '-t', '--', localOid])]: { stdout: 'commit\n' },
    [responseKey(['merge-base', '--all', baseOid, localOid])]: { stdout: `${baseOid}\n` },
    [responseKey(['rev-list', '--count', `${baseOid}..${localOid}`, '--'])]: { stdout: countOutput },
    [responseKey(['rev-list', '--parents', `${baseOid}..${localOid}`, '--'])]: {
      stdoutBase64: Buffer.from(rows).toString('base64'),
      exit: rowExit,
    },
  };
}

describe('exact added lines', () => {
  it('remains policy-neutral and does not import result, policy, or receipt modules', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts/lib/ci-control/git-input.ts'),
      'utf8',
    );
    const specifiers = extractModuleSpecifiers(source);
    const forbiddenFamilies = new Set(['policy', 'result', 'receipt']);
    expect(specifiers).not.toEqual([]);
    for (const specifier of specifiers) {
      const basename = specifier.split('/').at(-1)!.replace(/\.(?:[cm]?js|ts)$/u, '');
      const segments = basename.split('-');
      expect(segments.some((segment) => forbiddenFamilies.has(segment))).toBe(false);
    }
  });

  it('returns canonical rows for added, modified, deleted, repeated, CRLF, and unterminated lines', () => {
    const { root, baseOid } = fixture();
    write(root, 'modified.txt', 'alpha\nrepeat\nrepeat\nomega\n');
    write(root, 'deleted.txt', 'remove me\n');
    write(root, 'crlf.txt', 'alpha\r\nomega\r\n');
    commit(root, 'content base');
    const contentBaseOid = git(root, ['rev-parse', 'HEAD']);

    write(root, 'added.txt', 'first\nsecond');
    write(root, 'modified.txt', 'alpha\nrepeat\ninserted\nrepeat\nomega\n');
    rmSync(join(root, 'deleted.txt'));
    write(root, 'crlf.txt', 'alpha\r\ninserted-crlf\r\nomega\r\n');
    const candidateOid = commit(root, 'content candidate');

    const result = readExactAddedLines(root, {
      baseOid: contentBaseOid,
      candidateOid,
    });
    const rows = result.changes;

    expect(result).toMatchObject({ baseOid: contentBaseOid, candidateOid });
    expect(rows.map(({ path, status, addedLines }) => ({ path, status, addedLines }))).toEqual([
      {
        path: 'added.txt',
        status: 'added',
        addedLines: [
          { path: 'added.txt', newBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/), newLineNumber: 1, text: 'first' },
          { path: 'added.txt', newBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/), newLineNumber: 2, text: 'second' },
        ],
      },
      {
        path: 'crlf.txt',
        status: 'modified',
        addedLines: [
          { path: 'crlf.txt', newBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/), newLineNumber: 2, text: 'inserted-crlf' },
        ],
      },
      { path: 'deleted.txt', status: 'deleted', addedLines: [] },
      {
        path: 'modified.txt',
        status: 'modified',
        addedLines: [
          { path: 'modified.txt', newBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/), newLineNumber: 3, text: 'inserted' },
        ],
      },
    ]);
    expect(rows.every(({ addedLines, newOid }) =>
      addedLines.every(({ newBlobOid }) => newBlobOid === newOid))).toBe(true);
    expect(baseOid).not.toBe(contentBaseOid);
  });

  it('reads only the exact commit pair rather than ambient HEAD, index, or worktree', () => {
    const { root, baseOid } = fixture();
    write(root, 'target.txt', 'candidate\n');
    const candidateOid = commit(root, 'candidate');
    write(root, 'ambient.txt', 'head only\n');
    commit(root, 'ambient head');
    write(root, 'index.txt', 'index only\n');
    git(root, ['add', 'index.txt']);
    write(root, 'worktree.txt', 'worktree only\n');

    const rows = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(rows.map(({ path }) => path)).toEqual(['target.txt']);
    expect(rows[0]?.addedLines.map(({ text }) => text)).toEqual(['candidate']);
  });

  it('preserves pure rename/copy facts and returns no lines for equal blobs or mode-only changes', () => {
    const { root } = fixture();
    write(root, 'rename-old.txt', 'renamed content\n');
    write(root, 'copy-source.txt', 'copied content\n');
    write(root, 'mode-only.sh', '#!/bin/sh\nexit 0\n');
    const baseOid = commit(root, 'rename base');

    git(root, ['mv', 'rename-old.txt', 'rename-new.txt']);
    write(root, 'copy-target.txt', 'copied content\n');
    chmodSync(join(root, 'mode-only.sh'), 0o755);
    const candidateOid = commit(root, 'rename candidate');

    const rows = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(rows.map(({ status, path, oldPath }) => ({ status, path, oldPath }))).toEqual([
      { status: 'copied', path: 'copy-target.txt', oldPath: 'copy-source.txt' },
      { status: 'modified', path: 'mode-only.sh', oldPath: null },
      { status: 'renamed', path: 'rename-new.txt', oldPath: 'rename-old.txt' },
    ]);
    expect(rows.find(({ path }) => path === 'copy-target.txt')?.addedLines).toEqual([]);
    expect(rows.find(({ path }) => path === 'rename-new.txt')?.addedLines).toEqual([]);
    expect(rows.find(({ path }) => path === 'mode-only.sh')?.addedLines).toEqual([]);
  });

  it('preserves modified rename/copy facts and reports only their actual additions', () => {
    const { root } = fixture();
    write(root, 'rename-old.txt', `${'rename base\n'.repeat(20)}`);
    write(root, 'copy-source.txt', `${'copy base\n'.repeat(20)}`);
    const baseOid = commit(root, 'similarity base');
    git(root, ['mv', 'rename-old.txt', 'rename-new.txt']);
    write(root, 'rename-new.txt', `${'rename base\n'.repeat(20)}rename addition\n`);
    write(root, 'copy-target.txt', `${'copy base\n'.repeat(20)}copy addition\n`);
    const candidateOid = commit(root, 'similarity candidate');

    const changes = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(changes.map(({ status, path, oldPath, addedLines }) => ({
      status,
      path,
      oldPath,
      texts: addedLines.map(({ text }) => text),
    }))).toEqual([
      {
        status: 'copied',
        path: 'copy-target.txt',
        oldPath: 'copy-source.txt',
        texts: ['copy addition'],
      },
      {
        status: 'renamed',
        path: 'rename-new.txt',
        oldPath: 'rename-old.txt',
        texts: ['rename addition'],
      },
    ]);
    expect(changes.every(({ similarity }) => similarity !== null)).toBe(true);
  });

  it('handles repeated additions and patch-marker content without trusting patch text as identity', () => {
    const { root } = fixture();
    write(root, 'repeated.txt', 'same\nsame\nend\n');
    write(root, 'markers.txt', 'start\nend\n');
    const baseOid = commit(root, 'marker base');
    write(root, 'repeated.txt', 'same\nsame\nsame\nend\n');
    write(root, 'markers.txt', 'start\n+++ marker\n@@ marker\ndiff --git marker\nend\n');
    const candidateOid = commit(root, 'marker candidate');

    const changes = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(changes.find(({ path }) => path === 'repeated.txt')?.addedLines).toMatchObject([
      { newLineNumber: 3, text: 'same' },
    ]);
    expect(changes.find(({ path }) => path === 'markers.txt')?.addedLines.map(({ text }) => text))
      .toEqual(['+++ marker', '@@ marker', 'diff --git marker']);
  });

  it('handles modified-file terminated and unterminated newline transitions', () => {
    const { root } = fixture();
    write(root, 'terminated-to-unterminated.txt', 'old\n');
    write(root, 'unterminated-to-terminated.txt', 'old');
    write(root, 'unterminated-replacement.txt', 'anchor\nold');
    const baseOid = commit(root, 'newline base');
    write(root, 'terminated-to-unterminated.txt', 'new');
    write(root, 'unterminated-to-terminated.txt', 'new\n');
    write(root, 'unterminated-replacement.txt', 'anchor\nnew');
    const candidateOid = commit(root, 'newline candidate');

    const changes = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(changes.map(({ path, addedLines }) => ({
      path,
      additions: addedLines.map(({ newLineNumber, text }) => ({ newLineNumber, text })),
    }))).toEqual([
      {
        path: 'terminated-to-unterminated.txt',
        additions: [{ newLineNumber: 1, text: 'new' }],
      },
      {
        path: 'unterminated-replacement.txt',
        additions: [{ newLineNumber: 2, text: 'new' }],
      },
      {
        path: 'unterminated-to-terminated.txt',
        additions: [{ newLineNumber: 1, text: 'new' }],
      },
    ]);
  });

  it('supports symlinks, multibyte paths/content, and a cached pair mapped to two paths', () => {
    const { root } = fixture();
    write(root, 'first.txt', 'old\n');
    write(root, 'second.txt', 'old\n');
    const baseOid = commit(root, 'pair base');
    write(root, 'first.txt', 'new café\n');
    write(root, 'second.txt', 'new café\n');
    write(root, 'docs/café.txt', 'olá\n');
    symlinkSync('docs/café.txt', join(root, 'café-link'));
    const candidateOid = commit(root, 'pair candidate');

    const changes = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(changes.find(({ path }) => path === 'café-link')?.addedLines.map(({ text }) => text))
      .toEqual(['docs/café.txt']);
    expect(changes.find(({ path }) => path === 'docs/café.txt')?.addedLines.map(({ text }) => text))
      .toEqual(['olá']);
    for (const path of ['first.txt', 'second.txt']) {
      expect(changes.find((change) => change.path === path)?.addedLines).toMatchObject([
        { path, newLineNumber: 1, text: 'new café' },
      ]);
    }
  });

  it('executes one Git diff for a shared blob pair and remaps cached lines to each path', async () => {
    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const responses = addedLineShimResponses(
      baseOid, candidateOid, 'first.txt', oldBytes, newBytes, patch,
    );
    const raw = Buffer.concat(['first.txt', 'second.txt'].map((path) => Buffer.from(
      `:100644 100644 ${oldOid} ${newOid} M\0${path}\0`,
      'ascii',
    )));
    for (const args of [[
      'diff-tree', '--raw', '-z', '--no-commit-id', '-r', '--abbrev=40',
      '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
      baseOid, candidateOid, '--',
    ], [
      '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
      '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', '--find-renames', '--find-copies',
      '--find-copies-harder', baseOid, candidateOid, '--',
    ]]) {
      responses[responseKey(args)] = { stdoutBase64: raw.toString('base64') };
    }
    const diffKey = responseKey([
      '-c', 'diff.algorithm=myers', 'diff', '--patch', '--unified=0',
      '--no-indent-heuristic', '--text', '--full-index', '--no-prefix',
      '--no-color', '--no-ext-diff', '--no-textconv', oldOid, newOid, '--',
    ]);
    let diffExecutions = 0;
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: (_file: string, args: string[]) => {
        const key = responseKey(args.slice(1));
        if (key === diffKey) diffExecutions += 1;
        const response = responses[key];
        if (response === undefined) throw new Error('unexpected synthetic command');
        if (response.stdoutBase64 !== undefined) return Buffer.from(response.stdoutBase64, 'base64');
        return Buffer.from(response.stdout ?? '', 'utf8');
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      const changes = isolated.readExactAddedLines(
        '/isolated-fixture', { baseOid, candidateOid },
      ).changes;
      expect(diffExecutions).toBe(1);
      expect(changes.map(({ path, addedLines }) => ({ path, linePath: addedLines[0]?.path })))
        .toEqual([
          { path: 'first.txt', linePath: 'first.txt' },
          { path: 'second.txt', linePath: 'second.txt' },
        ]);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('rejects malformed exact-key input without invoking accessors or Git', () => {
    const oid = 'a'.repeat(40);
    for (const value of [
      null,
      [],
      {},
      { baseOid: oid },
      { baseOid: oid, candidateOid: oid, extra: true },
      { baseOid: oid.toUpperCase(), candidateOid: oid },
      { baseOid: oid, candidateOid: 7 },
    ]) {
      expectCode(() => readExactAddedLines('/not-a-repository', value as never),
        'ci.input.added-lines.input-malformed');
    }
    let getterCalls = 0;
    const accessor = { baseOid: oid } as Record<string, unknown>;
    Object.defineProperty(accessor, 'candidateOid', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return oid;
      },
    });
    expectCode(() => readExactAddedLines('/not-a-repository', accessor as never),
      'ci.input.added-lines.input-malformed');
    expect(getterCalls).toBe(0);

    for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
      let trapCalls = 0;
      const hostile = new Proxy({ baseOid: oid, candidateOid: oid }, {
        [trap]: () => {
          trapCalls += 1;
          throw new Error(`hostile ${trap}`);
        },
      });
      let thrown: unknown;
      try {
        readExactAddedLines('/not-a-repository', hostile);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.added-lines.input-malformed' });
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(trapCalls).toBe(1);
    }
  });

  it('rejects binary, invalid UTF-8, and changed gitlink content with closed codes', () => {
    for (const [name, bytes, code] of [
      ['binary.bin', Buffer.from([0x61, 0x00, 0x62]), 'ci.input.added-lines.binary'],
      ['invalid.txt', Buffer.from([0x61, 0xff, 0x62]), 'ci.input.added-lines.invalid-utf8'],
    ] as const) {
      const { root, baseOid } = fixture();
      writeFileSync(join(root, name), bytes);
      const candidateOid = commit(root, name);
      expectCode(() => readExactAddedLines(root, { baseOid, candidateOid }), code);
    }

    for (const [name, bytes, code] of [
      ['modified-binary.bin', Buffer.from([0x61, 0x00, 0x62]), 'ci.input.added-lines.binary'],
      ['modified-invalid.txt', Buffer.from([0x61, 0xff, 0x62]), 'ci.input.added-lines.invalid-utf8'],
    ] as const) {
      const { root } = fixture();
      write(root, name, 'safe\n');
      const baseOid = commit(root, 'modified binary base');
      writeFileSync(join(root, name), bytes);
      const candidateOid = commit(root, 'modified binary candidate');
      expectCode(() => readExactAddedLines(root, { baseOid, candidateOid }), code);
    }

    const { root, baseOid } = fixture();
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},vendor/component`]);
    git(root, ['commit', '--quiet', '-m', 'gitlink']);
    const candidateOid = git(root, ['rev-parse', 'HEAD']);
    expectCode(() => readExactAddedLines(root, { baseOid, candidateOid }),
      'ci.input.added-lines.gitlink');
  });

  it('does not decode deleted or equal-OID mode-only binary and invalid UTF-8 blobs', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'deleted-nul.bin'), Buffer.from([0x61, 0x00, 0x62]));
    writeFileSync(join(root, 'deleted-invalid.bin'), Buffer.from([0x61, 0xff, 0x62]));
    writeFileSync(join(root, 'mode-only.bin'), Buffer.from([0x61, 0x00, 0xff]));
    const baseOid = commit(root, 'binary base');
    rmSync(join(root, 'deleted-nul.bin'));
    rmSync(join(root, 'deleted-invalid.bin'));
    chmodSync(join(root, 'mode-only.bin'), 0o755);
    const candidateOid = commit(root, 'binary metadata only');

    const changes = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(changes.map(({ path, addedLines }) => ({ path, addedLines }))).toEqual([
      { path: 'deleted-invalid.bin', addedLines: [] },
      { path: 'deleted-nul.bin', addedLines: [] },
      { path: 'mode-only.bin', addedLines: [] },
    ]);
  });

  it('rejects malformed, truncated, and wrong-OID blob-pair patches without retaining raw evidence', () => {
    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const validPrefix = `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n--- ${oldOid}\n+++ ${newOid}\n`;
    const cases = [
      Buffer.from(`${validPrefix}@@ -1 +1 @@\n-old\n`),
      Buffer.from(`${validPrefix}@@ -1 +1 @@\n-old\n+new\nextra\n`),
      Buffer.from(`diff --git ${oldOid} ${newOid}\nindex ${'c'.repeat(40)}..${newOid} 100644\n--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`),
    ];
    for (const patch of cases) {
      const responses = addedLineShimResponses(
        baseOid, candidateOid, 'safe.txt', oldBytes, newBytes, patch,
      );
      let thrown: unknown;
      try {
        withGitShim(responses, (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ExactGitInputError);
      expect(thrown).toMatchObject({ code: 'ci.input.added-lines.patch-malformed' });
      expect(String(thrown)).not.toContain('old');
      expect(String(thrown)).not.toContain('new');
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    }

    const oldWithTail = Buffer.from('old\ntail\n');
    const omittedNew = Buffer.from('new\n');
    const omittedOldOid = blobOid(oldWithTail);
    const omittedNewOid = blobOid(omittedNew);
    const omittedPatch = Buffer.from(
      `diff --git ${omittedOldOid} ${omittedNewOid}\n`
      + `index ${omittedOldOid}..${omittedNewOid} 100644\n`
      + `--- ${omittedOldOid}\n+++ ${omittedNewOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    expectCode(() => withGitShim(
      addedLineShimResponses(
        baseOid,
        candidateOid,
        'safe.txt',
        oldWithTail,
        omittedNew,
        omittedPatch,
      ),
      (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }),
    ), 'ci.input.added-lines.patch-malformed');
  });

  it('rejects partial child output when the producer exits unsuccessfully', () => {
    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const responses = addedLineShimResponses(
      baseOid, candidateOid, 'safe.txt', oldBytes, newBytes, patch,
    );
    const diffKey = responseKey([
      '-c', 'diff.algorithm=myers', 'diff', '--patch', '--unified=0',
      '--no-indent-heuristic', '--text', '--full-index', '--no-prefix',
      '--no-color', '--no-ext-diff', '--no-textconv', oldOid, newOid, '--',
    ]);
    responses[diffKey] = {
      stdoutBase64: patch.toString('base64'),
      stderr: 'private partial child detail',
      exit: 23,
    };
    let thrown: unknown;
    try {
      withGitShim(responses, (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'ci.input.added-lines.unavailable' });
    expect(String(thrown)).not.toContain('private partial child detail');
    expectNoVisibleCause(thrown);
  });

  it('distinguishes direct timeout, signal, and output-budget failures without trusting legacy timeout', async () => {
    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const responses = addedLineShimResponses(
      baseOid, candidateOid, 'safe.txt', oldBytes, newBytes, patch,
    );
    const diffKey = responseKey([
      '-c', 'diff.algorithm=myers', 'diff', '--patch', '--unified=0',
      '--no-indent-heuristic', '--text', '--full-index', '--no-prefix',
      '--no-color', '--no-ext-diff', '--no-textconv', oldOid, newOid, '--',
    ]);
    const verifyDirectFailure = async (
      failure: NodeJS.ErrnoException & { signal?: string },
      expectedCode: string,
    ): Promise<void> => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        execFileSync: (_file: string, args: string[]) => {
          const key = responseKey(args.slice(1));
          if (key === diffKey) throw failure;
          const response = responses[key];
          if (response === undefined) throw new Error('unexpected synthetic command');
          if (response.stdoutBase64 !== undefined) return Buffer.from(response.stdoutBase64, 'base64');
          return Buffer.from(response.stdout ?? '', 'utf8');
        },
      }));
      try {
        const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
        let thrown: unknown;
        try {
          isolated.readExactAddedLines('/isolated-fixture', { baseOid, candidateOid });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: expectedCode });
        expect(String(thrown)).not.toContain(failure.message);
        expectNoVisibleCause(thrown);
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    };

    await verifyDirectFailure(
      Object.assign(new Error('synthetic direct timeout'), { code: 'ETIMEDOUT' }),
      'ci.input.added-lines.timeout',
    );
    await verifyDirectFailure(
      Object.assign(new Error('synthetic bare signal'), { signal: 'SIGKILL' }),
      'ci.input.added-lines.unavailable',
    );
    await verifyDirectFailure(
      Object.assign(new Error('synthetic output cap'), { code: 'ENOBUFS' }),
      'ci.input.added-lines.budget',
    );

    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: () => {
        throw Object.assign(new Error('ambiguous legacy timeout'), { code: 'ETIMEDOUT' });
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      let thrown: unknown;
      try {
        isolated.readExactAddedLines('/isolated-fixture', { baseOid, candidateOid });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.added-lines.unavailable' });
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('rejects a blob whose exact bytes change during terminal revalidation', async () => {
    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const responses = addedLineShimResponses(
      baseOid, candidateOid, 'safe.txt', oldBytes, newBytes, patch,
    );
    const changedKey = responseKey(['cat-file', 'blob', '--', newOid]);
    let changedReads = 0;
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: (_file: string, args: string[]) => {
        const key = responseKey(args.slice(1));
        if (key === changedKey) {
          changedReads += 1;
          return changedReads === 1 ? newBytes : Buffer.from('bad\n');
        }
        const response = responses[key];
        if (response === undefined) throw new Error('unexpected synthetic command');
        if (response.stdoutBase64 !== undefined) return Buffer.from(response.stdoutBase64, 'base64');
        return Buffer.from(response.stdout ?? '', 'utf8');
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      let thrown: unknown;
      try {
        isolated.readExactAddedLines('/isolated-fixture', { baseOid, candidateOid });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.added-lines.identity-mismatch' });
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('accepts the change-count boundary and rejects one additional fact before blob reads', () => {
    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const oldBytes = Buffer.from('deleted\n');
    const oldOid = blobOid(oldBytes);
    const rawForCount = (count: number): Buffer => Buffer.concat(
      Array.from({ length: count }, (_, index) => Buffer.from(
        `:100644 000000 ${oldOid} ${'0'.repeat(40)} D\0file-${String(index).padStart(4, '0')}.txt\0`,
        'ascii',
      )),
    );
    const responsesForCount = (count: number): Record<string, GitShimResponse> => {
      const raw = rawForCount(count);
      return {
        [responseKey(['cat-file', '-t', '--', baseOid])]: { stdout: 'commit\n' },
        [responseKey(['cat-file', '-t', '--', candidateOid])]: { stdout: 'commit\n' },
        [responseKey(['merge-base', '--all', baseOid, candidateOid])]: { stdout: `${baseOid}\n` },
        [responseKey([
          'diff-tree', '--raw', '-z', '--no-commit-id', '-r', '--abbrev=40',
          '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
          baseOid, candidateOid, '--',
        ])]: { stdoutBase64: raw.toString('base64') },
        [responseKey([
          '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
          '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
          '--ignore-submodules=none', '--find-renames', '--find-copies',
          '--find-copies-harder', baseOid, candidateOid, '--',
        ])]: { stdoutBase64: raw.toString('base64') },
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
        [responseKey(['cat-file', '-t', '--', oldOid])]: { stdout: 'blob\n' },
        [responseKey(['cat-file', '-s', '--', oldOid])]: { stdout: `${oldBytes.byteLength}\n` },
        [responseKey(['cat-file', 'blob', '--', oldOid])]: {
          stdoutBase64: oldBytes.toString('base64'),
        },
      };
    };

    expect(withGitShim(
      responsesForCount(MAX_EXACT_ADDED_LINE_CHANGE_COUNT),
      (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }),
    ).changes).toHaveLength(MAX_EXACT_ADDED_LINE_CHANGE_COUNT);
    const overResponses = responsesForCount(MAX_EXACT_ADDED_LINE_CHANGE_COUNT + 1);
    delete overResponses[responseKey(['rev-parse', '--show-object-format'])];
    delete overResponses[responseKey(['cat-file', '-t', '--', oldOid])];
    delete overResponses[responseKey(['cat-file', '-s', '--', oldOid])];
    delete overResponses[responseKey(['cat-file', 'blob', '--', oldOid])];
    expectCode(() => withGitShim(
      overResponses,
      (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }),
    ), 'ci.input.added-lines.budget');
  });

  it('publishes inclusive fixed budgets and rejects returned-line count one over', () => {
    expect(MAX_EXACT_ADDED_LINE_CHANGE_COUNT).toBe(4_096);
    expect(MAX_EXACT_ADDED_LINE_COUNT).toBe(100_000);
    expect(MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT).toBe(200_000);
    expect(MAX_EXACT_ADDED_LINE_PATCH_BYTES).toBe(4 * 1_024 * 1_024);
    expect(MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT).toBe(400_000);
    expect(MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES).toBe(16 * 1_024 * 1_024);
    expect(MAX_EXACT_ADDED_LINE_BYTES).toBe(16 * 1_024 * 1_024);

    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const shared = Buffer.from(`${'x\n'.repeat(MAX_EXACT_ADDED_LINE_COUNT / 2 - 1)}x`);
    const exactFacts = [
      { path: 'first.txt', bytes: shared },
      { path: 'second.txt', bytes: shared },
    ];
    expect(withGitShim(
      addedFactsShimResponses(baseOid, candidateOid, exactFacts),
      (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }),
    ).changes.flatMap(({ addedLines }) => addedLines)).toHaveLength(MAX_EXACT_ADDED_LINE_COUNT);

    const oneLine = Buffer.from('one');
    expectCode(() => withGitShim(
      addedFactsShimResponses(baseOid, candidateOid, [
        ...exactFacts,
        { path: 'third.txt', bytes: oneLine },
      ]),
      (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }),
    ), 'ci.input.added-lines.budget');
  });

  it('accepts the source-line processing boundary with one returned addition and rejects one over', () => {
    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const half = MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT / 2;
    const oldBytes = Buffer.from('x\n'.repeat(half));
    const exactNewBytes = Buffer.from(
      `${'x\n'.repeat(half / 2)}one replacement\n${'x\n'.repeat(half / 2 - 1)}`,
    );
    const oldOid = blobOid(oldBytes);
    const exactNewOid = blobOid(exactNewBytes);
    const exactPatch = Buffer.from(
      `diff --git ${oldOid} ${exactNewOid}\nindex ${oldOid}..${exactNewOid} 100644\n`
      + `--- ${oldOid}\n+++ ${exactNewOid}\n`
      + `@@ -${half / 2 + 1} +${half / 2 + 1} @@\n-x\n+one replacement\n`,
    );
    expect(withGitShim(
      addedLineShimResponses(
        baseOid, candidateOid, 'source-lines.txt', oldBytes, exactNewBytes, exactPatch,
      ),
      (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }),
    ).changes[0]?.addedLines).toMatchObject([
      { newLineNumber: half / 2 + 1, text: 'one replacement' },
    ]);

    const overNewBytes = Buffer.from(`${'x\n'.repeat(half)}one addition\n`);
    const overNewOid = blobOid(overNewBytes);
    const overPatch = Buffer.from(
      `diff --git ${oldOid} ${overNewOid}\nindex ${oldOid}..${overNewOid} 100644\n`
      + `--- ${oldOid}\n+++ ${overNewOid}\n@@ -${half},0 +${half + 1} @@\n+one addition\n`,
    );
    expectCode(() => withGitShim(
      addedLineShimResponses(
        baseOid, candidateOid, 'source-lines.txt', oldBytes, overNewBytes, overPatch,
      ),
      (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }),
    ), 'ci.input.added-lines.budget');
  });

  it('checks the raw patch-row boundary before decoding or splitting', () => {
    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    for (const [rowCount, code] of [
      [MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT, 'ci.input.added-lines.patch-malformed'],
      [MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT + 1, 'ci.input.added-lines.budget'],
    ] as const) {
      const patch = Buffer.from('x\n'.repeat(rowCount));
      expectCode(() => withGitShim(
        addedLineShimResponses(
          baseOid, candidateOid, 'safe.txt', oldBytes, newBytes, patch,
        ),
        (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }),
      ), code);
    }
  });

  it('accepts the aggregate added-text byte boundary and rejects one byte over', () => {
    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const shared = Buffer.alloc(MAX_EXACT_ADDED_LINE_BYTES / 4, 0x61);
    const exactFacts = Array.from({ length: 4 }, (_, index) => ({
      path: `exact-${index}.txt`,
      bytes: shared,
    }));
    const exact = withGitShim(
      addedFactsShimResponses(baseOid, candidateOid, exactFacts),
      (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }),
    );
    expect(exact.changes.flatMap(({ addedLines }) => addedLines)
      .reduce((total, { text }) => total + Buffer.byteLength(text, 'utf8'), 0))
      .toBe(MAX_EXACT_ADDED_LINE_BYTES);

    expectCode(() => withGitShim(
      addedFactsShimResponses(baseOid, candidateOid, [
        ...exactFacts,
        { path: 'over-extra.txt', bytes: Buffer.from('x') },
      ]),
      (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }),
    ), 'ci.input.added-lines.budget');
  });

  it('accepts exact single/aggregate patch byte limits and rejects one byte over', async () => {
    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const runScenario = async (patchSizes: number[], expectedCode?: string): Promise<void> => {
      const rawParts: Buffer[] = [];
      const responses = new Map<string, Buffer>();
      responses.set(responseKey(['cat-file', '-t', '--', baseOid]), Buffer.from('commit\n'));
      responses.set(responseKey(['cat-file', '-t', '--', candidateOid]), Buffer.from('commit\n'));
      responses.set(responseKey(['merge-base', '--all', baseOid, candidateOid]), Buffer.from(`${baseOid}\n`));
      responses.set(responseKey(['rev-parse', '--show-object-format']), Buffer.from('sha1\n'));
      for (const [index, patchSize] of patchSizes.entries()) {
        const placeholder = '0'.repeat(40);
        const fixed = Buffer.byteLength(
          `diff --git ${placeholder} ${placeholder}\nindex ${placeholder}..${placeholder} 100644\n`
          + `--- ${placeholder}\n+++ ${placeholder}\n@@ -1 +1 @@\n-\n+\n`,
        );
        const payloadBytes = patchSize - fixed;
        expect(payloadBytes).toBeGreaterThanOrEqual(2);
        const oldText = String.fromCharCode(0x61 + index * 2)
          .repeat(Math.floor(payloadBytes / 2));
        const newText = String.fromCharCode(0x62 + index * 2)
          .repeat(payloadBytes - oldText.length);
        const oldBytes = Buffer.from(`${oldText}\n`);
        const newBytes = Buffer.from(`${newText}\n`);
        const oldOid = blobOid(oldBytes);
        const newOid = blobOid(newBytes);
        const patchBytes = Buffer.from(
          `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
          + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-${oldText}\n+${newText}\n`,
        );
        expect(patchBytes).toHaveLength(patchSize);
        rawParts.push(Buffer.from(
          `:100644 100644 ${oldOid} ${newOid} M\0patch-${index}.txt\0`,
          'ascii',
        ));
        for (const [oid, bytes] of [[oldOid, oldBytes], [newOid, newBytes]] as const) {
          responses.set(responseKey(['cat-file', '-t', '--', oid]), Buffer.from('blob\n'));
          responses.set(responseKey(['cat-file', '-s', '--', oid]), Buffer.from(`${bytes.byteLength}\n`));
          responses.set(responseKey(['cat-file', 'blob', '--', oid]), bytes);
        }
        responses.set(responseKey([
          '-c', 'diff.algorithm=myers', 'diff', '--patch', '--unified=0',
          '--no-indent-heuristic', '--text', '--full-index', '--no-prefix',
          '--no-color', '--no-ext-diff', '--no-textconv', oldOid, newOid, '--',
        ]), patchBytes);
      }
      const raw = Buffer.concat(rawParts);
      responses.set(responseKey([
        'diff-tree', '--raw', '-z', '--no-commit-id', '-r', '--abbrev=40',
        '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
        baseOid, candidateOid, '--',
      ]), raw);
      responses.set(responseKey([
        '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
        '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
        '--ignore-submodules=none', '--find-renames', '--find-copies',
        '--find-copies-harder', baseOid, candidateOid, '--',
      ]), raw);

      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        execFileSync: (_file: string, args: string[], options: { maxBuffer: number }) => {
          const output = responses.get(responseKey(args.slice(1)));
          if (output === undefined) throw new Error('unexpected synthetic command');
          if (output.byteLength > options.maxBuffer) {
            throw Object.assign(new Error('synthetic output cap'), { code: 'ENOBUFS' });
          }
          return output;
        },
      }));
      try {
        const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
        if (expectedCode === undefined) {
          expect(isolated.readExactAddedLines(
            '/isolated-fixture', { baseOid, candidateOid },
          ).changes).toHaveLength(patchSizes.length);
        } else {
          let thrown: unknown;
          try {
            isolated.readExactAddedLines('/isolated-fixture', { baseOid, candidateOid });
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toMatchObject({ code: expectedCode });
        }
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    };

    await runScenario([MAX_EXACT_ADDED_LINE_PATCH_BYTES]);
    await runScenario(
      [MAX_EXACT_ADDED_LINE_PATCH_BYTES + 1],
      'ci.input.added-lines.budget',
    );
    const exactAggregate = Array.from({ length: 5 }, (_, index) =>
      Math.floor(MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES / 5)
      + (index < MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES % 5 ? 1 : 0));
    await runScenario(exactAggregate);
    await runScenario(
      exactAggregate.map((size, index) => size + (index === 4 ? 1 : 0)),
      'ci.input.added-lines.budget',
    );
  });
});

describe('exact commit range', () => {
  it('rejects malformed runtime records before Git or accessor evaluation', () => {
    const oid = 'a'.repeat(40);
    const malformed: unknown[] = [
      null,
      [],
      {},
      { baseOid: oid, remoteOid: null },
      { baseOid: oid, remoteOid: null, localOid: oid, extra: true },
      { baseOid: 7, remoteOid: null, localOid: oid },
      { baseOid: oid.toUpperCase(), remoteOid: null, localOid: oid },
      { baseOid: oid, remoteOid: '', localOid: oid },
      { baseOid: oid, remoteOid: 7, localOid: oid },
      { baseOid: oid, remoteOid: null, localOid: 'g'.repeat(40) },
    ];
    for (const value of malformed) {
      expectCode(() => readExactCommitRange(
        '/not-a-repository',
        value as never,
      ), 'ci.input.commit-range-malformed');
    }

    let getterCalls = 0;
    const accessor: Record<string, unknown> = { remoteOid: null, localOid: oid };
    Object.defineProperty(accessor, 'baseOid', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return oid;
      },
    });
    expectCode(() => readExactCommitRange('/not-a-repository', accessor as never),
      'ci.input.commit-range-malformed');
    expect(getterCalls).toBe(0);
  });

  it('requires canonical scalar framing for object format and commit type', () => {
    const oid = 'a'.repeat(40);
    const malformedScalars = [' sha1\n', 'sha1 \n', 'sha1\n\n', 'sha1', 'sha1\r\n', 'shá1\n'];
    for (const scalar of malformedScalars) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: scalar },
      }, (cwd) => readExactCommitRange(cwd, {
        baseOid: oid, remoteOid: null, localOid: oid,
      })), 'ci.input.commit-range-malformed');
    }

    for (const scalar of [' commit\n', 'commit \n', 'commit\n\n', 'commit', 'commit\r\n', 'commít\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
        [responseKey(['cat-file', '-t', '--', oid])]: { stdout: scalar },
      }, (cwd) => readExactCommitRange(cwd, {
        baseOid: oid, remoteOid: null, localOid: oid,
      })), 'ci.input.commit-range-malformed');
    }
  });

  it('distinguishes malformed merge-base framing from a well-formed unavailable relation', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'b'.repeat(40);
    const validRows = Buffer.from(`${localOid} ${baseOid}\n`);
    for (const scalar of [
      ` ${baseOid}\n`, `${baseOid} \n`, `${baseOid}\n\n`, baseOid, `${baseOid}\r\n`, `é${baseOid.slice(1)}\n`,
    ]) {
      const responses = rangeResponses(baseOid, localOid, '1\n', validRows);
      responses[responseKey(['merge-base', '--all', baseOid, localOid])] = { stdout: scalar };
      expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
        baseOid, remoteOid: null, localOid,
      })), 'ci.input.commit-range-malformed');
    }

    const otherOid = 'c'.repeat(40);
    const responses = rangeResponses(baseOid, localOid, '1\n', validRows);
    responses[responseKey(['merge-base', '--all', baseOid, localOid])] = { stdout: `${otherOid}\n` };
    expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
      baseOid, remoteOid: null, localOid,
    })), 'ci.input.commit-range-unavailable');
  });

  it('requires canonical decimal framing for the commit count', () => {
    const oid = 'a'.repeat(40);
    for (const scalar of [' 0\n', '0 \n', '0\n\n', '0', '0\r\n', '０\n']) {
      const responses = emptyRangeResponses(oid);
      responses[responseKey(['rev-list', '--count', `${oid}..${oid}`, '--'])] = { stdout: scalar };
      expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
        baseOid: oid, remoteOid: null, localOid: oid,
      })), 'ci.input.commit-range-malformed');
    }
  });

  it('uses remoteOid when present and baseOid otherwise', () => {
    const { root, baseOid } = fixture();
    write(root, 'one.txt', 'one\n');
    const firstOid = commit(root, 'first');
    write(root, 'two.txt', 'two\n');
    const secondOid = commit(root, 'second');

    expect(readExactCommitRange(root, {
      baseOid,
      remoteOid: null,
      localOid: secondOid,
    })).toMatchObject({
      baseOid,
      remoteOid: null,
      rangeStartOid: baseOid,
      localOid: secondOid,
      commits: [{ oid: firstOid }, { oid: secondOid }],
    });

    expect(readExactCommitRange(root, {
      baseOid,
      remoteOid: firstOid,
      localOid: secondOid,
    })).toMatchObject({
      baseOid,
      remoteOid: firstOid,
      rangeStartOid: firstOid,
      localOid: secondOid,
      commits: [{ oid: secondOid }],
    });
  });

  it('rejects malformed, missing, non-commit, unsupported-format, and non-ancestor inputs', () => {
    const { root, baseOid } = fixture();
    write(root, 'candidate.txt', 'candidate\n');
    const localOid = commit(root, 'candidate');
    const blobOid = git(root, ['rev-parse', `${localOid}:candidate.txt`]);

    expectCode(() => readExactCommitRange(root, {
      baseOid: baseOid.toUpperCase(), remoteOid: null, localOid,
    }), 'ci.input.commit-range-malformed');
    expectCode(() => readExactCommitRange(root, {
      baseOid, remoteOid: null, localOid: 'f'.repeat(40),
    }), 'ci.input.commit-range-unavailable');
    expectCode(() => readExactCommitRange(root, {
      baseOid, remoteOid: null, localOid: blobOid,
    }), 'ci.input.commit-range-malformed');

    git(root, ['checkout', '--quiet', '--detach', baseOid]);
    write(root, 'other.txt', 'other\n');
    const unrelatedOid = commit(root, 'unrelated');
    expectCode(() => readExactCommitRange(root, {
      baseOid: localOid, remoteOid: null, localOid: unrelatedOid,
    }), 'ci.input.commit-range-unavailable');

    const sha256Root = mkdtempSync(join(tmpdir(), 'ci-control-git-input-sha256-'));
    temporaryRoots.push(sha256Root);
    git(sha256Root, ['init', '--quiet', '--object-format=sha256']);
    expectCode(() => readExactCommitRange(sha256Root, {
      baseOid: 'a'.repeat(40), remoteOid: null, localOid: 'b'.repeat(40),
    }), 'ci.input.commit-range-malformed');
  });

  it('enumerates transient commits by exact OID while ignoring ambient HEAD, index, and worktree', () => {
    const { root, baseOid } = fixture();
    write(root, 'transient.txt', 'introduced\n');
    const addOid = commit(root, 'add transient');
    rmSync(join(root, 'transient.txt'));
    const removeOid = commit(root, 'remove transient');

    write(root, 'ambient-head.txt', 'outside exact range\n');
    commit(root, 'ambient head');
    write(root, 'ambient-index.txt', 'index only\n');
    git(root, ['add', 'ambient-index.txt']);
    write(root, 'ambient-worktree.txt', 'worktree only\n');

    const result = readExactCommitRange(root, {
      baseOid,
      remoteOid: null,
      localOid: removeOid,
    });
    expect(result.commits.map(({ oid }) => oid)).toEqual([addOid, removeOid]);
    expect(result.commits[0]).toEqual({
      oid: addOid,
      parentOids: [baseOid],
      firstParentOid: baseOid,
    });
    expect(result.commits[1]).toEqual({
      oid: removeOid,
      parentOids: [addOid],
      firstParentOid: addOid,
    });

    const facts = result.commits.flatMap(({ firstParentOid, oid }) =>
      readExactChangeFacts(root, firstParentOid, oid));
    expect(facts.map(({ status, path, oldMode, newMode, oldType, newType }) => ({
      status, path, oldMode, newMode, oldType, newType,
    }))).toEqual([
      {
        status: 'added', path: 'transient.txt', oldMode: '000000', newMode: '100644',
        oldType: 'absent', newType: 'blob',
      },
      {
        status: 'deleted', path: 'transient.txt', oldMode: '100644', newMode: '000000',
        oldType: 'blob', newType: 'absent',
      },
    ]);
    const introducedBlobOids = facts
      .filter(({ newType }) => newType === 'blob' || newType === 'executable' || newType === 'symlink')
      .map(({ newOid }) => newOid);
    const [introduced] = readExactBlobs(root, introducedBlobOids);
    expect(Buffer.from(introduced!.bytes).toString('utf8')).toBe('introduced\n');
  });

  it('uses deterministic parent-before-child ordering with ready siblings sorted by OID', () => {
    const { root, baseOid } = fixture();
    git(root, ['checkout', '--quiet', '-b', 'left']);
    write(root, 'left.txt', 'left\n');
    const leftOid = commit(root, 'left');

    git(root, ['checkout', '--quiet', '-b', 'right', baseOid]);
    write(root, 'right.txt', 'right\n');
    const rightOid = commit(root, 'right');
    git(root, ['merge', '--quiet', '--no-ff', 'left', '-m', 'merge diamond']);
    const mergeOid = git(root, ['rev-parse', 'HEAD']);

    const result = readExactCommitRange(root, {
      baseOid,
      remoteOid: null,
      localOid: mergeOid,
    });
    expect(result.commits.map(({ oid }) => oid)).toEqual([
      ...[leftOid, rightOid].sort(),
      mergeOid,
    ]);
    expect(result.commits.at(-1)).toEqual({
      oid: mergeOid,
      parentOids: [rightOid, leftOid],
      firstParentOid: rightOid,
    });
  });

  it('publishes fixed inclusive range budgets', () => {
    expect(MAX_EXACT_COMMIT_COUNT).toBe(4_096);
    expect(MAX_EXACT_COMMIT_PARENT_EDGE_COUNT).toBe(8_192);
    expect(MAX_EXACT_COMMIT_RANGE_BYTES).toBe(1 * 1_024 * 1_024);
  });

  it('accepts the exact parent-edge bound and rejects one over before row parsing', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'b'.repeat(40);
    const exactParents = Array.from(
      { length: MAX_EXACT_COMMIT_PARENT_EDGE_COUNT },
      (_, index) => (index + 1).toString(16).padStart(40, '0'),
    );
    const exactRows = Buffer.from(
      `${localOid} ${exactParents.join(' ')}\n`,
      'ascii',
    );
    const exact = withGitShim(
      rangeResponses(baseOid, localOid, '1\n', exactRows),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    );
    expect(exact.commits[0]?.parentOids).toHaveLength(MAX_EXACT_COMMIT_PARENT_EDGE_COUNT);

    const oneOverRows = Buffer.concat([
      Buffer.from(
        `${localOid} ${[...exactParents, 'c'.repeat(40)].join(' ')}`,
        'ascii',
      ),
      // If row decoding/materialization runs, this byte is malformed. The edge budget
      // must win before that later work.
      Buffer.from([0xff, 0x0a]),
    ]);
    expectCode(() => withGitShim(
      rangeResponses(baseOid, localOid, '1\n', oneOverRows),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    ), 'ci.input.commit-range-budget');
  });

  it('rejects duplicate parent identities within one commit row', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'b'.repeat(40);
    const rows = Buffer.from(`${localOid} ${baseOid} ${baseOid}\n`, 'ascii');
    expectCode(() => withGitShim(
      rangeResponses(baseOid, localOid, '1\n', rows),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    ), 'ci.input.commit-range-malformed');
  });

  it('rejects nonempty output for an empty range and blank normalized rows', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'c'.repeat(40);
    const firstOid = 'b'.repeat(40);
    const validRows = `${firstOid} ${baseOid}\n${localOid} ${firstOid}\n`;
    const cases = [
      {
        base: baseOid,
        local: baseOid,
        count: '0\n',
        rows: Buffer.from('\n'),
        responses: { ...emptyRangeResponses(baseOid) },
      },
      {
        base: baseOid,
        local: localOid,
        count: '2\n',
        rows: Buffer.from(validRows.replace('\n', '\n\n')),
      },
      {
        base: baseOid,
        local: localOid,
        count: '2\n',
        rows: Buffer.from(`${validRows}\n`),
      },
    ];

    for (const entry of cases) {
      const responses = rangeResponses(entry.base, entry.local, entry.count, entry.rows);
      expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
        baseOid: entry.base,
        remoteOid: null,
        localOid: entry.local,
      })), 'ci.input.commit-range-malformed');
    }
  });

  it('rejects missing LF, row-count mismatch, duplicate rows, cycles, and discarded partial output', () => {
    const baseOid = 'a'.repeat(40);
    const firstOid = 'b'.repeat(40);
    const localOid = 'c'.repeat(40);
    const malformed = [
      { count: '1\n', rows: Buffer.from(`${localOid} ${baseOid}`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '2\n', rows: Buffer.from(`${localOid} ${baseOid}\n`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '2\n', rows: Buffer.from(`${localOid} ${baseOid}\n${localOid} ${baseOid}\n`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '2\n', rows: Buffer.from(`${firstOid} ${localOid}\n${localOid} ${firstOid}\n`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '1\n', rows: Buffer.from(`${localOid} ${baseOid}\n`), exit: 1, code: 'ci.input.commit-range-unavailable' },
    ];
    for (const entry of malformed) {
      expectCode(() => withGitShim(
        rangeResponses(baseOid, localOid, entry.count, entry.rows, entry.exit),
        (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
      ), entry.code);
    }
  });

  it('accepts the exact commit-count bound and rejects one over before reading metadata', () => {
    const baseOid = 'a'.repeat(40);
    const commitOids = Array.from(
      { length: MAX_EXACT_COMMIT_COUNT },
      (_, index) => (index + 1).toString(16).padStart(40, '0'),
    );
    const localOid = commitOids.at(-1)!;
    const rows = Buffer.from(commitOids.map((oid, index) =>
      `${oid} ${index === 0 ? baseOid : commitOids[index - 1]}\n`).join(''));
    const exact = withGitShim(
      rangeResponses(baseOid, localOid, `${MAX_EXACT_COMMIT_COUNT}\n`, rows),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    );
    expect(exact.commits).toHaveLength(MAX_EXACT_COMMIT_COUNT);
    expect(exact.commits[0]?.firstParentOid).toBe(baseOid);
    expect(exact.commits.at(-1)?.oid).toBe(localOid);

    const oneOverResponses = rangeResponses(
      baseOid,
      localOid,
      `${MAX_EXACT_COMMIT_COUNT + 1}\n`,
      Buffer.alloc(0),
    );
    delete oneOverResponses[responseKey(['rev-list', '--parents', `${baseOid}..${localOid}`, '--'])];
    expectCode(() => withGitShim(oneOverResponses, (cwd) => readExactCommitRange(cwd, {
      baseOid, remoteOid: null, localOid,
    })), 'ci.input.commit-range-budget');
  });

  it('admits exactly the raw range-output byte limit before malformed parsing', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'b'.repeat(40);
    const exact = Buffer.alloc(MAX_EXACT_COMMIT_RANGE_BYTES, 0x61);
    expectCode(() => withGitShim(
      rangeResponses(baseOid, localOid, '1\n', exact),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    ), 'ci.input.commit-range-malformed');

    const over = Buffer.alloc(MAX_EXACT_COMMIT_RANGE_BYTES + 1, 0x61);
    expectCode(() => withGitShim(
      rangeResponses(baseOid, localOid, '1\n', over),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    ), 'ci.input.commit-range-budget');
  });

  it('uses bounded explicit Git calls with sanitized environment state', () => {
    const oid = 'a'.repeat(40);
    expect(withGitShim(emptyRangeResponses(oid), (cwd) => readExactCommitRange(cwd, {
      baseOid: oid,
      remoteOid: null,
      localOid: oid,
    }))).toEqual({
      baseOid: oid,
      remoteOid: null,
      rangeStartOid: oid,
      localOid: oid,
      commits: [],
    });
  });
});

describe('exact commit metadata', () => {
  it('uses only the closed policy-neutral static import surface', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts/lib/ci-control/git-input.ts'),
      'utf8',
    );
    const specifiers = extractModuleSpecifiers(source);
    expect([...new Set(specifiers)].sort()).toEqual([
      '../../../src/lib/git-env.ts',
      'node:child_process',
      'node:crypto',
      'node:util',
    ]);
    expect(source).not.toMatch(/\bimport\s*\(/u);
    expect(source).not.toMatch(/\b(?:require|createRequire)\s*\(/u);
  });

  it('reads the requested exact commit rather than a later safe ambient HEAD', () => {
    const { root } = fixture();
    write(root, 'unsafe.txt', 'unsafe commit fixture\n');
    git(root, ['add', '-A']);
    execFileSync('git', [
      'commit', '--quiet', '-m', 'unsafe subject',
      '-m', 'Co-Authored-By: Fixture <fixture@example.invalid>',
    ], {
      cwd: root,
      env: {
        ...gitEnvironment(root),
        GIT_AUTHOR_NAME: 'Retired Worker',
        GIT_AUTHOR_EMAIL: 'worker@invalid.example',
        GIT_COMMITTER_NAME: 'Retired Worker',
        GIT_COMMITTER_EMAIL: 'worker@invalid.example',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const unsafeOid = git(root, ['rev-parse', 'HEAD']);
    write(root, 'safe.txt', 'safe ambient head\n');
    commit(root, 'safe ambient head');

    const [metadata] = readExactCommitMetadata(root, [unsafeOid]);
    expect(metadata).toMatchObject({
      oid: unsafeOid,
      authorName: 'Retired Worker',
      authorEmail: 'worker@invalid.example',
      subject: 'unsafe subject',
      byteLength: expect.any(Number),
      contentSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(metadata?.message).toContain('Co-Authored-By: Fixture');
    expect(metadata?.parentOids).toHaveLength(1);
    expect(metadata?.treeOid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('preserves sorted input order, tree, parents, multiline messages, and signed headers', () => {
    const parentA = '2'.repeat(40);
    const parentB = '3'.repeat(40);
    const firstBody = rawCommitBody({
      parentOids: [parentA, parentB],
      optionalHeaders: [
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' continuation-line',
        ' ',
        ' -----END PGP SIGNATURE-----',
        'mergetag object deadbeef',
        ' continuation-two',
      ],
      message: 'first subject\n\nfirst body\nsecond body\n',
    });
    const secondBody = rawCommitBody({ message: '' });
    const entries = [firstBody, secondBody]
      .map((body) => ({ oid: commitOid(body), body }))
      .sort((left, right) => left.oid.localeCompare(right.oid));

    const metadata = withGitShim(commitMetadataResponses(entries), (cwd) =>
      readExactCommitMetadata(cwd, entries.map(({ oid }) => oid)));
    expect(metadata.map(({ oid }) => oid)).toEqual(entries.map(({ oid }) => oid));
    const signed = metadata.find(({ parentOids }) => parentOids.length === 2)!;
    expect(signed).toMatchObject({
      treeOid: '1'.repeat(40),
      parentOids: [parentA, parentB],
      subject: 'first subject',
      message: 'first subject\n\nfirst body\nsecond body\n',
      byteLength: firstBody.byteLength,
      contentSha256: `sha256:${createHash('sha256').update(firstBody).digest('hex')}`,
    });
    expect(metadata.find(({ parentOids }) => parentOids.length === 0)?.message).toBe('');
  });

  it('rejects non-arrays, sparse/accessor/proxy inputs, malformed OIDs, duplicates, and unsorted OIDs before Git', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const sparse = new Array<string>(1);
    const accessor: string[] = [];
    let getterCalls = 0;
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return a;
      },
    });
    Object.defineProperty(accessor, 'length', { value: 1 });
    const trapped = new Proxy([a], {
      getOwnPropertyDescriptor: () => {
        throw new Error('private trap text');
      },
    });
    const transparentProxy = new Proxy([a], {});
    const nonEnumerableIndex = [a];
    Object.defineProperty(nonEnumerableIndex, '0', {
      configurable: true,
      enumerable: false,
      value: a,
      writable: true,
    });
    const extraStringKey = [a];
    Object.defineProperty(extraStringKey, 'extra', { enumerable: true, value: a });
    const symbolKey = [a];
    Object.defineProperty(symbolKey, Symbol('extra'), { enumerable: true, value: a });
    const customPrototype = [a];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
    const malformed: unknown[] = [
      null, {}, new Set([a]), sparse, accessor, trapped, transparentProxy, nonEnumerableIndex,
      extraStringKey,
      symbolKey, customPrototype, [a.toUpperCase()], ['g'.repeat(40)],
      [a, a], [b, a],
    ];
    for (const value of malformed) {
      expectCode(() => readExactCommitMetadata(
        '/not-a-repository', value as readonly string[],
      ), 'ci.input.commit-metadata-malformed');
    }
    expect(getterCalls).toBe(0);
  });

  it('rejects malformed commit bodies, NUL, invalid UTF-8, and unsupported encoding', () => {
    const valid = rawCommitBody({ message: 'subject\n' });
    const malformedBodies = [
      Buffer.from(valid.toString('utf8').replace(/^tree /, 'parent ')),
      Buffer.from(valid.toString('utf8').replace('\nauthor ', '\ntree ')),
      Buffer.from(valid.toString('utf8').replace('\ncommitter ', '\nauthor ')),
      Buffer.from(valid.toString('utf8').replace('\n\nsubject', '\n continuation\n\nsubject')),
      rawCommitBody({ optionalHeaders: ['encoding ISO-8859-1'], message: 'subject\n' }),
      Buffer.from(valid.toString('utf8').replace('\nauthor ', '\r\nauthor ')),
      Buffer.concat([valid, Buffer.from([0])]),
    ];
    for (const body of malformedBodies) {
      const oid = commitOid(body);
      expectCode(() => withGitShim(
        commitMetadataResponses([{ oid, body }]),
        (cwd) => readExactCommitMetadata(cwd, [oid]),
      ), 'ci.input.commit-metadata-malformed');
    }

    const invalidUtf8 = Buffer.concat([
      rawCommitBody({ message: '' }),
      Buffer.from([0xff]),
    ]);
    const invalidOid = commitOid(invalidUtf8);
    expectCode(() => withGitShim(
      commitMetadataResponses([{ oid: invalidOid, body: invalidUtf8 }]),
      (cwd) => readExactCommitMetadata(cwd, [invalidOid]),
    ), 'ci.input.commit-metadata-invalid-utf8');
  });

  it('rejects author and committer name angle brackets and controls while preserving ordinary Unicode names', () => {
    for (const authorName of ['Bad<Name', 'Bad>Name', 'Bad\tName', `Bad${String.fromCharCode(1)}Name`]) {
      const body = rawCommitBody({
        author: `${authorName} <fixture@example.invalid> 1700000000 +0000`,
      });
      const oid = commitOid(body);
      expectCode(() => withGitShim(
        commitMetadataResponses([{ oid, body }]),
        (cwd) => readExactCommitMetadata(cwd, [oid]),
      ), 'ci.input.commit-metadata-malformed');
    }

    for (const committerName of ['Bad<Committer', 'Bad>Committer', 'Bad\tCommitter', `Bad${String.fromCharCode(1)}Committer`]) {
      const body = rawCommitBody({
        author: 'Safe Author <fixture@example.invalid> 1700000000 +0000',
        committer: `${committerName} <fixture@example.invalid> 1700000000 +0000`,
      });
      const oid = commitOid(body);
      expectCode(() => withGitShim(
        commitMetadataResponses([{ oid, body }]),
        (cwd) => readExactCommitMetadata(cwd, [oid]),
      ), 'ci.input.commit-metadata-malformed');
    }

    const safeBody = rawCommitBody({
      author: 'Zoë 李 <fixture@example.invalid> 1700000000 +0000',
      message: 'Unicode author\n',
    });
    const safeOid = commitOid(safeBody);
    expect(withGitShim(
      commitMetadataResponses([{ oid: safeOid, body: safeBody }]),
      (cwd) => readExactCommitMetadata(cwd, [safeOid]),
    )[0]?.authorName).toBe('Zoë 李');
  });

  it('rejects missing, non-commit, SHA-256, partial, and identity-mismatched evidence with sanitized errors', () => {
    const privateFixture = 'private-author-value@example.invalid';
    const body = rawCommitBody({
      author: `Private Fixture <${privateFixture}> 1700000000 +0000`,
    });
    const oid = commitOid(body);
    const wrongOid = 'f'.repeat(40);
    const cases: Array<{ responses: Record<string, GitShimResponse>; code: string }> = [
      {
        responses: {
          [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
          [responseKey(['cat-file', '-t', '--', oid])]: { stderr: privateFixture, exit: 1 },
        },
        code: 'ci.input.commit-metadata-unavailable',
      },
      {
        responses: {
          [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
          [responseKey(['cat-file', '-t', '--', oid])]: {
            stdout: 'commit\n', stderr: privateFixture, exit: 1,
          },
        },
        code: 'ci.input.commit-metadata-unavailable',
      },
      {
        responses: commitMetadataResponses([{ oid, body, type: 'blob\n' }]),
        code: 'ci.input.commit-metadata-malformed',
      },
      {
        responses: commitMetadataResponses([{ oid, body }], 'sha256\n'),
        code: 'ci.input.commit-metadata-malformed',
      },
      {
        responses: commitMetadataResponses([{ oid, body, size: `${body.byteLength + 1}\n` }]),
        code: 'ci.input.commit-metadata-identity-mismatch',
      },
      {
        responses: commitMetadataResponses([{ oid: wrongOid, body }]),
        code: 'ci.input.commit-metadata-identity-mismatch',
      },
    ];
    for (const entry of cases) {
      let thrown: unknown;
      try {
        withGitShim(entry.responses, (cwd) => readExactCommitMetadata(cwd, [
          entry.responses === cases.at(-1)?.responses ? wrongOid : oid,
        ]));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: entry.code });
      expect(String(thrown)).not.toContain(privateFixture);
      expectNoVisibleCause(thrown);
    }
  });

  it('rejects terminal commit-body substitution without exposing either body', async () => {
    const firstBody = rawCommitBody({ message: 'private first body\n' });
    const secondBody = rawCommitBody({ message: 'private other body\n' });
    expect(secondBody.byteLength).toBe(firstBody.byteLength);
    const oid = commitOid(firstBody);
    let bodyReads = 0;
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: (_file: string, rawArgs: string[]) => {
        const args = rawArgs.slice(1);
        if (responseKey(args) === responseKey(['rev-parse', '--show-object-format'])) {
          return Buffer.from('sha1\n');
        }
        if (responseKey(args) === responseKey(['cat-file', '-t', '--', oid])) {
          return Buffer.from('commit\n');
        }
        if (responseKey(args) === responseKey(['cat-file', '-s', '--', oid])) {
          return Buffer.from(`${firstBody.byteLength}\n`);
        }
        if (responseKey(args) === responseKey(['cat-file', 'commit', '--', oid])) {
          bodyReads += 1;
          return bodyReads === 1 ? firstBody : secondBody;
        }
        throw new Error('unexpected synthetic command');
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      let thrown: unknown;
      try {
        isolated.readExactCommitMetadata('/isolated-fixture', [oid]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.commit-metadata-identity-mismatch' });
      expect(String(thrown)).not.toContain('private first body');
      expect(String(thrown)).not.toContain('private other body');
      expect(bodyReads).toBe(2);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('maps only ETIMEDOUT to timeout, ENOBUFS to budget, and bare SIGKILL to unavailable', async () => {
    const verify = async (
      failure: NodeJS.ErrnoException & { signal?: string },
      code: string,
    ): Promise<void> => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({ execFileSync: () => { throw failure; } }));
      try {
        const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
        let thrown: unknown;
        try {
          isolated.readExactCommitMetadata('/isolated-fixture', []);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code });
        expect(String(thrown)).not.toContain(failure.message);
        expectNoVisibleCause(thrown);
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    };
    await verify(Object.assign(new Error('private timeout'), { code: 'ETIMEDOUT' }), 'ci.input.commit-metadata-timeout');
    await verify(Object.assign(new Error('private budget'), { code: 'ENOBUFS' }), 'ci.input.commit-metadata-budget');
    await verify(Object.assign(new Error('private signal'), { signal: 'SIGKILL' }), 'ci.input.commit-metadata-unavailable');
  });

  it('publishes fixed inclusive metadata budgets and rejects one-over count before Git', () => {
    expect(MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES).toBe(1 * 1_024 * 1_024);
    expect(MAX_EXACT_AGGREGATE_COMMIT_METADATA_BYTES).toBe(16 * 1_024 * 1_024);
    const exactCount = Array.from({ length: MAX_EXACT_COMMIT_COUNT }, (_, index) =>
      index.toString(16).padStart(40, '0'));
    expectCode(() => readExactCommitMetadata(
      '/not-a-repository', exactCount,
    ), 'ci.input.commit-metadata-unavailable');
    expectCode(() => readExactCommitMetadata(
      '/not-a-repository',
      Array.from({ length: MAX_EXACT_COMMIT_COUNT + 1 }, (_, index) =>
        index.toString(16).padStart(40, '0')),
    ), 'ci.input.commit-metadata-budget');
  });

  it('admits exact single and aggregate preflight bounds and rejects one over before loading bodies', () => {
    const oid = 'a'.repeat(40);
    const exactSingle = commitMetadataResponses([{
      oid,
      body: Buffer.alloc(0),
      size: `${MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES}\n`,
    }]);
    delete exactSingle[responseKey(['cat-file', 'commit', '--', oid])];
    expectCode(() => withGitShim(exactSingle, (cwd) => readExactCommitMetadata(cwd, [oid])),
      'ci.input.commit-metadata-unavailable');

    const oversized = commitMetadataResponses([{
      oid,
      body: Buffer.alloc(0),
      size: `${MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES + 1}\n`,
    }]);
    delete oversized[responseKey(['cat-file', 'commit', '--', oid])];
    expectCode(() => withGitShim(oversized, (cwd) => readExactCommitMetadata(cwd, [oid])),
      'ci.input.commit-metadata-budget');

    const exactAggregateOids = Array.from({ length: 16 }, (_, index) =>
      (index + 1).toString(16).padStart(40, '0'));
    const exactAggregate = commitMetadataResponses(exactAggregateOids.map((entryOid) => ({
      oid: entryOid,
      body: Buffer.alloc(0),
      size: `${MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES}\n`,
    })));
    for (const entryOid of exactAggregateOids) {
      delete exactAggregate[responseKey(['cat-file', 'commit', '--', entryOid])];
    }
    expectCode(() => withGitShim(
      exactAggregate,
      (cwd) => readExactCommitMetadata(cwd, exactAggregateOids),
    ), 'ci.input.commit-metadata-unavailable');

    const oids = [...exactAggregateOids, 'f'.repeat(40)];
    const responses = commitMetadataResponses(oids.map((entryOid, index) => ({
      oid: entryOid,
      body: Buffer.alloc(0),
      size: `${index === 16 ? 1 : MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES}\n`,
    })));
    for (const entryOid of oids) delete responses[responseKey(['cat-file', 'commit', '--', entryOid])];
    expectCode(() => withGitShim(responses, (cwd) => readExactCommitMetadata(cwd, oids)),
      'ci.input.commit-metadata-budget');
  });

  it('preflights every object before loading any body', () => {
    const firstBody = rawCommitBody({ message: 'first\n' });
    const firstOid = commitOid(firstBody);
    const secondOid = 'f'.repeat(40);
    const oids = [firstOid, secondOid].sort();
    const responses = commitMetadataResponses([{ oid: firstOid, body: firstBody }]);
    responses[responseKey(['cat-file', '-t', '--', secondOid])] = { stdout: 'commit\n' };
    responses[responseKey(['cat-file', '-s', '--', secondOid])] = {
      stdout: `${MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES + 1}\n`,
    };
    delete responses[responseKey(['cat-file', 'commit', '--', firstOid])];
    expectCode(() => withGitShim(responses, (cwd) => readExactCommitMetadata(cwd, oids)),
      'ci.input.commit-metadata-budget');
  });
});

describe('exact blob set', () => {
  it('validates every member before Git access', () => {
    const oid = 'a'.repeat(40);
    for (const invalid of ['', oid.toUpperCase(), 'g'.repeat(40), 7, null]) {
      expectCode(() => readExactBlobs(
        '/not-a-repository',
        [oid, invalid] as unknown as readonly string[],
      ), 'ci.input.blob-set-malformed');
    }

    let getterCalls = 0;
    const accessor: string[] = [];
    Object.defineProperty(accessor, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return oid;
      },
    });
    Object.defineProperty(accessor, 'length', { value: 1 });
    expectCode(() => readExactBlobs('/not-a-repository', accessor),
      'ci.input.blob-set-malformed');
    expect(getterCalls).toBe(0);
  });

  it('requires canonical scalar framing for object format, blob type, and blob size', () => {
    const oid = 'a'.repeat(40);
    for (const scalar of [' sha1\n', 'sha1 \n', 'sha1\n\n', 'sha1', 'sha1\r\n', 'shá1\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: scalar },
      }, (cwd) => readExactBlobs(cwd, [oid])), 'ci.input.blob-set-malformed');
    }

    for (const scalar of [' blob\n', 'blob \n', 'blob\n\n', 'blob', 'blob\r\n', 'blób\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
        [responseKey(['cat-file', '-t', '--', oid])]: { stdout: scalar },
      }, (cwd) => readExactBlobs(cwd, [oid])), 'ci.input.blob-set-malformed');
    }

    for (const scalar of [' 0\n', '0 \n', '0\n\n', '0', '0\r\n', '０\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
        [responseKey(['cat-file', '-t', '--', oid])]: { stdout: 'blob\n' },
        [responseKey(['cat-file', '-s', '--', oid])]: { stdout: scalar },
      }, (cwd) => readExactBlobs(cwd, [oid])), 'ci.input.blob-set-malformed');
    }
  });

  it('reads blob identities selected from regular, executable, and symlink tree entries', () => {
    const { root } = fixture();
    write(root, 'regular.txt', 'regular\n');
    write(root, 'executable.sh', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'executable.sh'), 0o755);
    symlinkSync('regular.txt', join(root, 'regular-link'));
    const commitOid = commit(root, 'blob modes');
    const oids = [
      git(root, ['rev-parse', `${commitOid}:regular.txt`]),
      git(root, ['rev-parse', `${commitOid}:executable.sh`]),
      git(root, ['rev-parse', `${commitOid}:regular-link`]),
    ];

    const blobs = readExactBlobs(root, [oids[2]!, oids[0]!, oids[1]!, oids[0]!]);
    expect(blobs.map(({ oid }) => oid)).toEqual([...oids].sort());
    for (const blob of blobs) {
      expect(blob.byteLength).toBe(blob.bytes.byteLength);
      expect(blob.contentSha256).toBe(`sha256:${createHash('sha256').update(blob.bytes).digest('hex')}`);
      expect(gitWithInput(root, ['hash-object', '--stdin'], blob.bytes)).toBe(blob.oid);
    }
    expect(blobs.map(({ bytes }) => Buffer.from(bytes).toString('utf8')).sort()).toEqual([
      '#!/bin/sh\nexit 0\n',
      'regular\n',
      'regular.txt',
    ].sort());
  });

  it('rejects malformed, missing, and non-blob identities without returning partial results', () => {
    const { root, baseOid } = fixture();
    const validBlob = git(root, ['rev-parse', `${baseOid}:README.md`]);

    expectCode(() => readExactBlobs(root, [validBlob, 'A'.repeat(40)]), 'ci.input.blob-set-malformed');
    expectCode(() => readExactBlobs(root, [validBlob, 'f'.repeat(40)]), 'ci.input.blob-unavailable');
    expectCode(() => readExactBlobs(root, [validBlob, baseOid]), 'ci.input.blob-type-unsupported');
  });

  it('ignores replacement objects and verifies the requested Git blob identity', () => {
    const { root } = fixture();
    const original = hashBlob(root, Buffer.from('original\n'));
    const replacement = hashBlob(root, Buffer.from('replacement\n'));
    git(root, ['replace', original, replacement]);

    const [blob] = readExactBlobs(root, [original]);
    expect(blob?.oid).toBe(original);
    expect(Buffer.from(blob!.bytes).toString('utf8')).toBe('original\n');
  });

  it('rejects a blob over the single-object budget before returning content', () => {
    const { root } = fixture();
    const oversized = hashBlob(root, Buffer.alloc(MAX_EXACT_SINGLE_BLOB_BYTES + 1, 0x61));
    expectCode(() => readExactBlobs(root, [oversized]), 'ci.input.blob-set-budget');
  });

  it('checks the deduplicated count budget before resolving object types', () => {
    const { root } = fixture();
    const tooMany = Array.from(
      { length: MAX_EXACT_BLOB_COUNT + 1 },
      (_, index) => index.toString(16).padStart(40, '0'),
    );
    expectCode(() => readExactBlobs(root, tooMany), 'ci.input.blob-set-budget');
  });

  it('checks raw array shape and count before Git access or deduplication', () => {
    const oid = 'a'.repeat(40);
    expectCode(() => readExactBlobs('/not-a-repository', null as unknown as readonly string[]),
      'ci.input.blob-set-malformed');
    expectCode(() => readExactBlobs(
      '/not-a-repository',
      Array.from({ length: MAX_EXACT_BLOB_COUNT + 1 }, () => oid),
    ), 'ci.input.blob-set-budget');
    expectCode(() => readExactBlobs(
      '/not-a-repository',
      Array.from({ length: MAX_EXACT_BLOB_COUNT }, () => oid),
    ), 'ci.input.blob-unavailable');
  });

  it('accepts the inclusive single and aggregate byte limits and rejects aggregate one over', () => {
    const { root } = fixture();
    const exactOids = Array.from({ length: 4 }, (_, index) => {
      const content = Buffer.alloc(MAX_EXACT_SINGLE_BLOB_BYTES, 0x61 + index);
      return hashBlob(root, content);
    });
    const exact = readExactBlobs(root, exactOids);
    expect(exact).toHaveLength(4);
    expect(exact.reduce((sum, blob) => sum + blob.byteLength, 0))
      .toBe(MAX_EXACT_AGGREGATE_BLOB_BYTES);
    expect(exact.every(({ byteLength }) => byteLength === MAX_EXACT_SINGLE_BLOB_BYTES)).toBe(true);

    const oneByteOid = hashBlob(root, Buffer.from('x'));
    expectCode(() => readExactBlobs(root, [...exactOids, oneByteOid]),
      'ci.input.blob-set-budget');
  });

  it('rejects preflight single and aggregate sizes before requesting blob content', () => {
    const singleOid = 'a'.repeat(40);
    expectCode(() => withGitShim({
      [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
      [responseKey(['cat-file', '-t', '--', singleOid])]: { stdout: 'blob\n' },
      [responseKey(['cat-file', '-s', '--', singleOid])]: {
        stdout: `${MAX_EXACT_SINGLE_BLOB_BYTES + 1}\n`,
      },
    }, (cwd) => readExactBlobs(cwd, [singleOid])), 'ci.input.blob-set-budget');

    const oids = ['a', 'b', 'c', 'd', 'e'].map((prefix) => prefix.repeat(40));
    const responses: Record<string, GitShimResponse> = {
      [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
    };
    for (const [index, oid] of oids.entries()) {
      responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'blob\n' };
      responses[responseKey(['cat-file', '-s', '--', oid])] = {
        stdout: `${index === oids.length - 1 ? 1 : MAX_EXACT_SINGLE_BLOB_BYTES}\n`,
      };
    }
    expectCode(() => withGitShim(responses, (cwd) => readExactBlobs(cwd, oids)),
      'ci.input.blob-set-budget');
  });

  it('composes exact change facts and blob bytes for all supported Git entry modes', () => {
    const { root, baseOid } = fixture();
    write(root, 'regular.txt', 'regular mode\n');
    write(root, 'executable.sh', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'executable.sh'), 0o755);
    symlinkSync('regular.txt', join(root, 'regular-link'));
    git(root, ['add', '-A']);
    const multibyteBytes = Buffer.from('multibyte path\n');
    const multibyteOid = hashBlob(root, multibyteBytes);
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${multibyteOid},docs/café.txt`]);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},vendor/component`]);
    git(root, ['commit', '--quiet', '-m', 'all entry modes']);
    const localOid = git(root, ['rev-parse', 'HEAD']);

    const range = readExactCommitRange(root, { baseOid, remoteOid: null, localOid });
    expect(range.commits).toHaveLength(1);
    const facts = range.commits.flatMap(({ firstParentOid, oid }) =>
      readExactChangeFacts(root, firstParentOid, oid));
    expect(facts.map(({ path, newMode, newType }) => ({ path, newMode, newType }))).toEqual([
      { path: 'docs/café.txt', newMode: '100644', newType: 'blob' },
      { path: 'executable.sh', newMode: '100755', newType: 'executable' },
      { path: 'regular-link', newMode: '120000', newType: 'symlink' },
      { path: 'regular.txt', newMode: '100644', newType: 'blob' },
      { path: 'vendor/component', newMode: '160000', newType: 'gitlink' },
    ]);
    const eligibleFacts = facts.filter(({ newType }) =>
      newType === 'blob' || newType === 'executable' || newType === 'symlink');
    expect(eligibleFacts.map(({ path }) => path)).not.toContain('vendor/component');
    const blobs = readExactBlobs(root, eligibleFacts.map(({ newOid }) => newOid));
    const bytesByOid = new Map(blobs.map((blob) => [blob.oid, Buffer.from(blob.bytes).toString('utf8')]));
    expect(bytesByOid.get(multibyteOid)).toBe('multibyte path\n');
    expect([...bytesByOid.values()].sort()).toEqual([
      '#!/bin/sh\nexit 0\n',
      'multibyte path\n',
      'regular mode\n',
      'regular.txt',
    ].sort());
    expectCode(() => readExactBlobs(root, [baseOid]), 'ci.input.blob-type-unsupported');
  });

  it('rejects bytes that do not rehash to the requested blob identity', () => {
    const oid = 'a'.repeat(40);
    const wrong = Buffer.from('different bytes');
    const responses: Record<string, GitShimResponse> = {
      [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
      [responseKey(['cat-file', '-t', '--', oid])]: { stdout: 'blob\n' },
      [responseKey(['cat-file', '-s', '--', oid])]: { stdout: `${wrong.byteLength}\n` },
      [responseKey(['cat-file', 'blob', '--', oid])]: {
        stdoutBase64: wrong.toString('base64'),
      },
    };
    expectCode(() => withGitShim(responses, (cwd) => readExactBlobs(cwd, [oid])),
      'ci.input.blob-identity-mismatch');
  });

  it('does not send gitlink commit identities to blob reads during change-fact composition', () => {
    const { root, baseOid } = fixture();
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},vendor/component`]);
    git(root, ['commit', '--quiet', '-m', 'gitlink']);
    const localOid = git(root, ['rev-parse', 'HEAD']);
    const facts = readExactChangeFacts(root, baseOid, localOid);
    expect(facts).toMatchObject([{ path: 'vendor/component', newType: 'gitlink', newOid: baseOid }]);
    const eligible = facts
      .filter(({ newType }) => newType === 'blob' || newType === 'executable' || newType === 'symlink')
      .map(({ newOid }) => newOid);
    expect(eligible).toEqual([]);
    expectCode(() => readExactBlobs(root, [baseOid]), 'ci.input.blob-type-unsupported');
  });

  it('does not classify a SIGKILL-only child failure as a timeout', () => {
    const responses: Record<string, GitShimResponse> = {
      [responseKey(['rev-parse', '--show-object-format'])]: { signal: 'SIGKILL' },
    };
    expectCode(() => withGitShim(responses, (cwd) => readExactBlobs(cwd, [])),
      'ci.input.blob-unavailable');
  });

  it('maps only a proven ETIMEDOUT child-process error to the timeout code', async () => {
    const verifyIsolatedFailure = async (
      failure: NodeJS.ErrnoException & { signal?: string },
      code: string,
    ): Promise<void> => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        execFileSync: () => {
          throw failure;
        },
      }));
      try {
        const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
        let thrown: unknown;
        try {
          isolated.readExactBlobs('/isolated-fixture', []);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code });
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    };

    await verifyIsolatedFailure(
      Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT', signal: 'SIGKILL' }),
      'ci.input.git-execution-timeout',
    );
    await verifyIsolatedFailure(
      Object.assign(new Error('synthetic signal'), { signal: 'SIGKILL' }),
      'ci.input.blob-unavailable',
    );
  });

  it('publishes fixed inclusive blob budgets', () => {
    expect(MAX_EXACT_BLOB_COUNT).toBe(50_000);
    expect(MAX_EXACT_SINGLE_BLOB_BYTES).toBe(4 * 1_024 * 1_024);
    expect(MAX_EXACT_AGGREGATE_BLOB_BYTES).toBe(16 * 1_024 * 1_024);
  });
});
