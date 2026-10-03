import { execFileSync } from 'node:child_process';

import { cleanGitEnv } from '../../../src/lib/git-env.ts';
import { readExactBlobsWithinAggregateBudget } from '../ci-control/git-blob-input.ts';
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
    timeout: 30_000,
    killSignal: 'SIGKILL',
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

interface SourceEntry {
  type: string;
  oid: string;
  path: string;
}

// One `ls-tree -r -z` record: `<mode> <type> <oid>\t<path>`.
function parseSourceEntry(record: string): SourceEntry {
  const tab = record.indexOf('\t');
  const match = tab < 0 ? null : /^[0-7]{6} (\S+) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(record.slice(0, tab));
  const [, type, oid] = match ?? [];
  if (!type || !oid) throw new Error(`unparseable tree entry: ${record.slice(0, 120)}`);
  return { type, oid, path: normalizeRepoPath(record.slice(tab + 1)) };
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

  let sourceEntries: SourceEntry[] = [];
  try {
    sourceEntries = git(input.cwd, [
      'ls-tree',
      '-r',
      '-z',
      result.headOid,
      '--',
      'src',
    ])
      .split('\0')
      .filter((record) => record !== '')
      .map(parseSourceEntry)
      .filter((entry) => /\.tsx?$/.test(entry.path) && !entry.path.endsWith('.d.ts'))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  } catch (error) {
    limitations.push(`head source tree could not be listed: ${boundedError(error)}`);
  }
  const sourcePaths = sourceEntries.map((entry) => entry.path);

  if (sourcePaths.length === 0) {
    limitations.push(`no TypeScript source files were found at head ${result.headOid}`);
  }

  // A gitlink names a commit, which `git show` printed as text; it has no blob.
  // Each non-blob entry is refused per path before the read, whatever its outcome.
  for (const entry of sourceEntries) {
    if (entry.type !== 'blob') {
      limitations.push(`head blob ${entry.path} could not be read: object is a ${entry.type}, not a blob`);
    }
  }

  // The exact blob reader the ci-control guards use reads the whole tree in one
  // check batch and one content batch, instead of one `git show` per file. It
  // returns every requested blob or throws, so a failure is one limitation and
  // leaves the map empty.
  const blobTexts = new Map<string, string>();
  const blobOids = sourceEntries.filter((entry) => entry.type === 'blob').map((entry) => entry.oid);
  if (blobOids.length > 0) {
    try {
      for (const blob of readExactBlobsWithinAggregateBudget(input.cwd, blobOids, GIT_MAX_BUFFER)) {
        blobTexts.set(blob.oid, Buffer.from(blob.bytes).toString('utf8'));
      }
    } catch (error) {
      limitations.push(`head blobs could not be read: ${boundedError(error)}`);
    }
  }

  for (const entry of sourceEntries) {
    const text = entry.type === 'blob' ? blobTexts.get(entry.oid) : undefined;
    if (text !== undefined) result.sources.push({ path: entry.path, text });
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
