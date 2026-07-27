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

import { expect, vi } from 'vitest';

import {
  ExactGitInputError,
  MAX_CHANGE_FACT_COUNT,
  MAX_EXACT_ADDED_LINE_BUDGET_V1,
  type ExactAddedLineBudgetV1,
} from '../../../scripts/lib/ci-control/git-input.ts';

const temporaryRoots: string[] = [];

export function registerTemporaryRoot(directory: string): void {
  temporaryRoots.push(directory);
}

export function cleanupTemporaryRoots(): void {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function gitEnvironment(cwd: string): NodeJS.ProcessEnv {
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

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnvironment(cwd),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function gitWithInput(cwd: string, args: string[], input: Uint8Array): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnvironment(cwd),
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

export function commit(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

export function fixture(): { root: string; baseOid: string } {
  const root = mkdtempSync(join(tmpdir(), 'ci-control-git-input-'));
  temporaryRoots.push(root);
  git(root, ['init', '--quiet', '--object-format=sha1']);
  write(root, 'README.md', 'base\n');
  return { root, baseOid: commit(root, 'base') };
}

export function expectCode(run: () => unknown, code: string): void {
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

export function expectNoVisibleCause(value: unknown): void {
  expect(Object.prototype.hasOwnProperty.call(value, 'cause')).toBe(false);
  expect('cause' in Object(value)).toBe(false);
}

export function hashBlob(root: string, bytes: Uint8Array): string {
  return gitWithInput(root, ['hash-object', '-w', '--stdin'], bytes);
}

export function blobOid(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex');
}

export function commitOid(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(`commit ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex');
}

export function treeOid(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(`tree ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex');
}

export function rawTreeBody(entries: readonly {
  mode: '40000' | '100644' | '100755' | '120000' | '160000' | string;
  name: string;
  oid: string;
}[]): Buffer {
  return Buffer.concat(entries.flatMap(({ mode, name, oid }) => [
    Buffer.from(`${mode} ${name}\0`, 'utf8'),
    Buffer.from(oid, 'hex'),
  ]));
}

export function sortUtf8(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export function rawCommitBody(options: {
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

export function commitMetadataResponses(
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

export function extractModuleSpecifiers(source: string): string[] {
  return [
    ...[...source.matchAll(/\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gu)]
      .map((match) => match[1]!),
    ...[...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu)]
      .map((match) => match[1]!),
  ];
}

export interface GitShimResponse {
  stdout?: string;
  stdoutBase64?: string;
  stderr?: string;
  exit?: number;
  signal?: 'SIGKILL';
}

export interface ExactGitShimScenario {
  baseOid: string;
  candidateOid: string;
  responses: Record<string, GitShimResponse>;
}

export function responseKey(args: readonly string[]): string {
  return JSON.stringify(args);
}

function setBatchBlobTypeResponse(
  responses: Record<string, GitShimResponse>,
  oids: readonly string[],
): void {
  const exactOids = [...new Set(oids)].sort();
  responses[responseKey([
    'cat-file',
    '--batch-check=%(objectname) %(objecttype)',
  ])] = {
    stdout: exactOids.map((oid) => `${oid} blob\n`).join(''),
  };
}

export function withGitShim<T>(
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
if (process.env.GIT_GRAFT_FILE !== '/dev/null') fail('graft isolation missing', 98);
if (process.env.GIT_CONFIG_COUNT !== '1') fail('explicit config count missing', 99);
if (process.env.GIT_CONFIG_KEY_0 !== 'advice.graftFileDeprecated') fail('graft advice key missing', 100);
if (process.env.GIT_CONFIG_VALUE_0 !== 'false') fail('graft advice value missing', 101);
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

export function addedLineShimResponses(
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
    [responseKey(['cat-file', '-t', '--', oldOid])]: { stdout: 'blob\n' },
    [responseKey(['cat-file', '-s', '--', oldOid])]: { stdout: `${oldBytes.byteLength}\n` },
    [responseKey(['cat-file', 'blob', '--', oldOid])]: { stdoutBase64: oldBytes.toString('base64') },
    [responseKey(['cat-file', '-t', '--', newOid])]: { stdout: 'blob\n' },
    [responseKey(['cat-file', '-s', '--', newOid])]: { stdout: `${newBytes.byteLength}\n` },
    [responseKey(['cat-file', 'blob', '--', newOid])]: { stdoutBase64: newBytes.toString('base64') },
    [responseKey(diffArgs)]: { stdoutBase64: patch.toString('base64') },
  };
  setBatchBlobTypeResponse(responses, [oldOid, newOid]);
  return responses;
}

function exactFlatTree(
  entries: readonly { path: string; oid: string }[],
): { rootOid: string; trees: ReadonlyMap<string, Buffer> } {
  interface Node {
    files: Map<string, string>;
    directories: Map<string, Node>;
  }
  const root: Node = { files: new Map(), directories: new Map() };
  for (const { path, oid } of entries) {
    const components = path.split('/');
    let node = root;
    for (const component of components.slice(0, -1)) {
      const existing = node.directories.get(component);
      if (existing !== undefined) {
        node = existing;
      } else {
        const created: Node = { files: new Map(), directories: new Map() };
        node.directories.set(component, created);
        node = created;
      }
    }
    node.files.set(components.at(-1)!, oid);
  }
  const trees = new Map<string, Buffer>();
  const materialize = (node: Node): string => {
    const rows: { mode: string; name: string; oid: string; sortKey: Buffer }[] = [];
    for (const [name, oid] of node.files) {
      rows.push({ mode: '100644', name, oid, sortKey: Buffer.from(name, 'utf8') });
    }
    for (const [name, child] of node.directories) {
      rows.push({
        mode: '40000',
        name,
        oid: materialize(child),
        sortKey: Buffer.from(`${name}/`, 'utf8'),
      });
    }
    rows.sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));
    const body = rawTreeBody(rows);
    const oid = treeOid(body);
    trees.set(oid, body);
    return oid;
  };
  return { rootOid: materialize(root), trees };
}

function exactCommitPairResponses(
  baseEntries: readonly { path: string; oid: string }[],
  candidateEntries: readonly { path: string; oid: string }[],
): {
  baseOid: string;
  candidateOid: string;
  responses: Record<string, GitShimResponse>;
} {
  const baseTree = exactFlatTree(baseEntries);
  const baseBody = rawCommitBody({ treeOid: baseTree.rootOid, message: 'base\n' });
  const baseOid = commitOid(baseBody);
  const candidateTree = exactFlatTree(candidateEntries);
  const candidateBody = rawCommitBody({
    treeOid: candidateTree.rootOid,
    parentOids: [baseOid],
    message: 'candidate\n',
  });
  const candidateOid = commitOid(candidateBody);
  const responses = commitMetadataResponses([
    { oid: baseOid, body: baseBody },
    { oid: candidateOid, body: candidateBody },
  ]);
  for (const [oid, body] of new Map([...baseTree.trees, ...candidateTree.trees])) {
    responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'tree\n' };
    responses[responseKey(['cat-file', '-s', '--', oid])] = { stdout: `${body.byteLength}\n` };
    responses[responseKey(['cat-file', 'tree', '--', oid])] = {
      stdoutBase64: body.toString('base64'),
    };
  }
  responses[responseKey(['merge-base', '--all', baseOid, candidateOid])] = {
    stdout: `${baseOid}\n`,
  };
  return { baseOid, candidateOid, responses };
}

export function addedLineShimScenario(
  paths: string | readonly string[],
  oldBytes: Buffer,
  newBytes: Buffer,
  patch: Buffer,
): ExactGitShimScenario {
  const normalizedPaths = typeof paths === 'string' ? [paths] : [...paths];
  const oldOid = blobOid(oldBytes);
  const newOid = blobOid(newBytes);
  const scenario = exactCommitPairResponses(
    normalizedPaths.map((path) => ({ path, oid: oldOid })),
    normalizedPaths.map((path) => ({ path, oid: newOid })),
  );
  const raw = Buffer.concat(normalizedPaths.map((path) => Buffer.from(
    `:100644 100644 ${oldOid} ${newOid} M\0${path}\0`,
    'utf8',
  )));
  scenario.responses[responseKey([
    '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
    '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
    '--ignore-submodules=none', '--find-renames', '--find-copies',
    '--find-copies-harder', scenario.baseOid, scenario.candidateOid, '--',
  ])] = { stdoutBase64: raw.toString('base64') };
  for (const [oid, bytes] of [[oldOid, oldBytes], [newOid, newBytes]] as const) {
    scenario.responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'blob\n' };
    scenario.responses[responseKey(['cat-file', '-s', '--', oid])] = {
      stdout: `${bytes.byteLength}\n`,
    };
    scenario.responses[responseKey(['cat-file', 'blob', '--', oid])] = {
      stdoutBase64: bytes.toString('base64'),
    };
  }
  setBatchBlobTypeResponse(scenario.responses, [oldOid, newOid]);
  scenario.responses[responseKey([
    '-c', 'diff.algorithm=myers', 'diff', '--patch', '--unified=0',
    '--no-indent-heuristic', '--text', '--full-index', '--no-prefix',
    '--no-color', '--no-ext-diff', '--no-textconv', oldOid, newOid, '--',
  ])] = { stdoutBase64: patch.toString('base64') };
  return scenario;
}

export function modifiedFactsShimScenario(
  facts: readonly { path: string; oldBytes: Buffer; newBytes: Buffer; patch: Buffer }[],
): ExactGitShimScenario {
  const scenario = exactCommitPairResponses(
    facts.map(({ path, oldBytes }) => ({ path, oid: blobOid(oldBytes) })),
    facts.map(({ path, newBytes }) => ({ path, oid: blobOid(newBytes) })),
  );
  const raw = Buffer.concat(facts.map(({ path, oldBytes, newBytes }) => Buffer.from(
    `:100644 100644 ${blobOid(oldBytes)} ${blobOid(newBytes)} M\0${path}\0`,
    'utf8',
  )));
  scenario.responses[responseKey([
    '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
    '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
    '--ignore-submodules=none', '--find-renames', '--find-copies',
    '--find-copies-harder', scenario.baseOid, scenario.candidateOid, '--',
  ])] = { stdoutBase64: raw.toString('base64') };
  for (const { oldBytes, newBytes, patch } of facts) {
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    for (const [oid, bytes] of [[oldOid, oldBytes], [newOid, newBytes]] as const) {
      scenario.responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'blob\n' };
      scenario.responses[responseKey(['cat-file', '-s', '--', oid])] = {
        stdout: `${bytes.byteLength}\n`,
      };
      scenario.responses[responseKey(['cat-file', 'blob', '--', oid])] = {
        stdoutBase64: bytes.toString('base64'),
      };
    }
    scenario.responses[responseKey([
      '-c', 'diff.algorithm=myers', 'diff', '--patch', '--unified=0',
      '--no-indent-heuristic', '--text', '--full-index', '--no-prefix',
      '--no-color', '--no-ext-diff', '--no-textconv', oldOid, newOid, '--',
    ])] = { stdoutBase64: patch.toString('base64') };
  }
  setBatchBlobTypeResponse(scenario.responses, facts.flatMap(({ oldBytes, newBytes }) => [
    blobOid(oldBytes),
    blobOid(newBytes),
  ]));
  return scenario;
}

export function addedFactsShimScenario(
  facts: readonly { path: string; bytes: Buffer }[],
): ExactGitShimScenario {
  const entries = facts.map(({ path, bytes }) => ({ path, oid: blobOid(bytes) }));
  const scenario = exactCommitPairResponses([], entries);
  const raw = Buffer.concat(facts.map(({ path, bytes }) => Buffer.from(
    `:000000 100644 ${'0'.repeat(40)} ${blobOid(bytes)} A\0${path}\0`,
    'utf8',
  )));
  scenario.responses[responseKey([
    '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
    '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
    '--ignore-submodules=none', '--find-renames', '--find-copies',
    '--find-copies-harder', scenario.baseOid, scenario.candidateOid, '--',
  ])] = { stdoutBase64: raw.toString('base64') };
  for (const { bytes } of facts) {
    const oid = blobOid(bytes);
    scenario.responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'blob\n' };
    scenario.responses[responseKey(['cat-file', '-s', '--', oid])] = {
      stdout: `${bytes.byteLength}\n`,
    };
    scenario.responses[responseKey(['cat-file', 'blob', '--', oid])] = {
      stdoutBase64: bytes.toString('base64'),
    };
  }
  setBatchBlobTypeResponse(scenario.responses, facts.map(({ bytes }) => blobOid(bytes)));
  return scenario;
}

export function addedFactsShimResponses(
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
  setBatchBlobTypeResponse(responses, facts.map(({ bytes }) => blobOid(bytes)));
  return responses;
}

export function addedLineBudget(
  overrides: Partial<ExactAddedLineBudgetV1> = {},
): ExactAddedLineBudgetV1 {
  return { ...MAX_EXACT_ADDED_LINE_BUDGET_V1, ...overrides };
}

export function emptyRangeResponses(oid: string): Record<string, GitShimResponse> {
  return {
    [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
    [responseKey(['cat-file', '-t', '--', oid])]: { stdout: 'commit\n' },
    [responseKey(['merge-base', '--all', oid, oid])]: { stdout: `${oid}\n` },
    [responseKey(['rev-list', '--count', `${oid}..${oid}`, '--'])]: { stdout: '0\n' },
    [responseKey(['rev-list', '--parents', `${oid}..${oid}`, '--'])]: { stdout: '' },
  };
}

export function treeLookupResponses(options: {
  candidateOid: string;
  commitBody: Buffer;
  trees: ReadonlyMap<string, Buffer>;
  objectTypes?: ReadonlyMap<string, string>;
  objectFormat?: string;
}): Record<string, GitShimResponse> {
  const responses = commitMetadataResponses([
    { oid: options.candidateOid, body: options.commitBody },
  ], options.objectFormat ?? 'sha1\n');
  for (const [oid, body] of options.trees) {
    responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'tree\n' };
    responses[responseKey(['cat-file', '-s', '--', oid])] = { stdout: `${body.byteLength}\n` };
    responses[responseKey(['cat-file', 'tree', '--', oid])] = {
      stdoutBase64: body.toString('base64'),
    };
  }
  for (const [oid, type] of options.objectTypes ?? []) {
    responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: `${type}\n` };
  }
  return responses;
}

export type GitInputModule = typeof import('../../../scripts/lib/ci-control/git-input.ts');

export async function withMockedGitInput<T>(
  execute: (
    file: string,
    args: string[],
    options: Parameters<typeof execFileSync>[2],
  ) => Buffer,
  run: (module: GitInputModule) => T | Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock('node:child_process', () => ({ execFileSync: execute }));
  try {
    return await run(await import('../../../scripts/lib/ci-control/git-input.ts'));
  } finally {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  }
}

export function paddedTreeBody(byteLength: number, childOid: string | null): Buffer {
  const child = childOid === null
    ? Buffer.alloc(0)
    : Buffer.concat([Buffer.from('40000 a\0', 'utf8'), Buffer.from(childOid, 'hex')]);
  const prefix = Buffer.from('100644 ', 'utf8');
  const suffix = Buffer.concat([Buffer.from([0]), Buffer.from('1'.repeat(40), 'hex')]);
  const nameBytes = byteLength - child.byteLength - prefix.byteLength - suffix.byteLength;
  if (nameBytes < 1) throw new Error('synthetic tree byte length is too small');
  return Buffer.concat([child, prefix, Buffer.alloc(nameBytes, 0x7a), suffix], byteLength);
}

export function treeChain(byteLengths: readonly number[]): {
  rootOid: string;
  path: string;
  trees: ReadonlyMap<string, Buffer>;
} {
  const reverse: [string, Buffer][] = [];
  let childOid: string | null = null;
  for (const byteLength of [...byteLengths].reverse()) {
    const body = paddedTreeBody(byteLength, childOid);
    childOid = treeOid(body);
    reverse.push([childOid, body]);
  }
  return {
    rootOid: childOid!,
    path: Array.from({ length: byteLengths.length - 1 }, () => 'a').join('/'),
    trees: new Map(reverse),
  };
}

export function repeatedRawTreeEntries(count: number, trailingMalformed = false): Buffer {
  const entryBytes = 33;
  const body = Buffer.alloc(count * entryBytes + (trailingMalformed ? 1 : 0));
  const oid = Buffer.from('2'.repeat(40), 'hex');
  for (let index = 0; index < count; index += 1) {
    const offset = index * entryBytes;
    body.write('100644 ', offset, 'ascii');
    body.write(index.toString(16).padStart(5, '0'), offset + 7, 'ascii');
    body[offset + 12] = 0;
    oid.copy(body, offset + 13);
  }
  if (trailingMalformed) body[body.byteLength - 1] = 0x78;
  return body;
}
