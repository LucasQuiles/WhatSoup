import { execFileSync } from 'node:child_process';

import { cleanGitEnv } from '../../../src/lib/git-env.ts';
import type { ModuleSource } from './module-graph.ts';

export type SemanticScope = 'branch' | 'tree';
export type ChangedStatus = 'added' | 'copied' | 'modified' | 'renamed' | 'deleted';

export interface ChangedPath {
  status: ChangedStatus;
  path: string;
  oldPath?: string;
}

export interface CandidateTree {
  headOid: string;
  baseOid: string | null;
  mergeBaseOid: string | null;
  sources: ModuleSource[];
  changedPaths: ChangedPath[];
  limitations: string[];
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function normalizeRepoPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function boundedError(error: unknown): string {
  const candidate = error as { stderr?: unknown; message?: unknown };
  let text = '';
  if (typeof candidate.stderr === 'string') text = candidate.stderr;
  else if (Buffer.isBuffer(candidate.stderr)) text = candidate.stderr.toString('utf8');
  else if (typeof candidate.message === 'string') text = candidate.message;
  else text = String(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, 500) || 'unknown Git failure';
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function readGitTextAtRevision(input: {
  cwd: string;
  revision: string;
  path: string;
}): string {
  let oid: string;
  try {
    oid = git(input.cwd, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${input.revision}^{commit}`,
    ]).trim();
  } catch (error) {
    throw new Error(`revision ${input.revision} could not be resolved: ${boundedError(error)}`);
  }
  try {
    return git(input.cwd, ['show', `${oid}:${normalizeRepoPath(input.path)}`]);
  } catch (error) {
    throw new Error(`blob ${input.path} at ${oid} could not be read: ${boundedError(error)}`);
  }
}

function parseChangedPaths(output: string): ChangedPath[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changed: ChangedPath[] = [];

  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++];
    if (!rawStatus) throw new Error('diff output contains an empty status');
    const code = rawStatus[0];

    if (code === 'R' || code === 'C') {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (!oldPath || !newPath) throw new Error(`diff output is missing paths for ${rawStatus}`);
      changed.push({
        status: code === 'R' ? 'renamed' : 'copied',
        oldPath: normalizeRepoPath(oldPath),
        path: normalizeRepoPath(newPath),
      });
      continue;
    }

    const path = fields[index++];
    if (!path) throw new Error(`diff output is missing a path for ${rawStatus}`);
    const statuses: Record<string, ChangedStatus> = {
      A: 'added',
      M: 'modified',
      D: 'deleted',
    };
    const status = code ? statuses[code] : undefined;
    if (!status) throw new Error(`unsupported Git change status: ${rawStatus}`);
    changed.push({ status, path: normalizeRepoPath(path) });
  }

  return changed.sort((left, right) =>
    `${left.path}\0${left.status}\0${left.oldPath ?? ''}`.localeCompare(
      `${right.path}\0${right.status}\0${right.oldPath ?? ''}`,
    ),
  );
}

export function readCandidateTree(input: {
  cwd: string;
  head: string;
  baseRef?: string;
  scope: SemanticScope;
}): CandidateTree {
  const limitations: string[] = [];
  const result: CandidateTree = {
    headOid: '',
    baseOid: null,
    mergeBaseOid: null,
    sources: [],
    changedPaths: [],
    limitations,
  };

  try {
    result.headOid = git(input.cwd, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${input.head}^{commit}`,
    ]).trim();
  } catch (error) {
    limitations.push(`head ${input.head} could not be resolved: ${boundedError(error)}`);
    return result;
  }

  if (input.scope === 'branch') {
    if (!input.baseRef) {
      limitations.push('branch scope requires a base ref');
    } else {
      try {
        result.baseOid = git(input.cwd, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${input.baseRef}^{commit}`,
        ]).trim();
      } catch (error) {
        limitations.push(`base ${input.baseRef} could not be resolved: ${boundedError(error)}`);
      }
    }

    if (result.baseOid) {
      try {
        result.mergeBaseOid = git(input.cwd, [
          'merge-base',
          result.baseOid,
          result.headOid,
        ]).trim();
        if (!result.mergeBaseOid) limitations.push('git merge-base returned an empty object ID');
      } catch (error) {
        limitations.push(`merge base could not be resolved: ${boundedError(error)}`);
      }
    }

    if (result.mergeBaseOid) {
      try {
        const diff = git(input.cwd, [
          'diff',
          '--name-status',
          '-z',
          '--find-renames',
          '--find-copies',
          `${result.mergeBaseOid}..${result.headOid}`,
          '--',
          'src',
        ]);
        result.changedPaths = parseChangedPaths(diff);
      } catch (error) {
        limitations.push(`candidate diff could not be read: ${boundedError(error)}`);
      }
    }
  }

  let sourcePaths: string[] = [];
  try {
    sourcePaths = git(input.cwd, [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      result.headOid,
      '--',
      'src',
    ])
      .split('\0')
      .filter((path) => /\.tsx?$/.test(path) && !path.endsWith('.d.ts'))
      .map(normalizeRepoPath)
      .sort();
  } catch (error) {
    limitations.push(`head source tree could not be listed: ${boundedError(error)}`);
  }

  if (sourcePaths.length === 0) {
    limitations.push(`no TypeScript source files were found at head ${result.headOid}`);
  }

  for (const sourcePath of sourcePaths) {
    try {
      result.sources.push({
        path: sourcePath,
        text: git(input.cwd, ['show', `${result.headOid}:${sourcePath}`]),
      });
    } catch (error) {
      limitations.push(`head blob ${sourcePath} could not be read: ${boundedError(error)}`);
    }
  }

  if (result.sources.length !== sourcePaths.length) {
    limitations.push(
      `source tree is incomplete: read ${result.sources.length} of ${sourcePaths.length} blobs`,
    );
  }

  if (input.scope === 'tree') {
    result.changedPaths = sourcePaths.map((path) => ({ status: 'modified', path }));
  }

  return result;
}
