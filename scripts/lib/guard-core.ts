import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { cleanGitEnv } from '../../src/lib/git-env.ts';
import { isNonEmptyString } from '../../src/lib/type-guards.ts';
import { parseClosedOptions } from './cli-args.ts';

export { cleanGitEnv } from '../../src/lib/git-env.ts';

const textExtensions = new Set([
  '.cjs',
  '.css',
  '.env',
  '.example',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

export type GitBlobReadResult = { ok: true; content?: string } | { ok: false; error: string };

export type SourceInventoryIssueCode =
  | 'guard.scan.root-unreadable'
  | 'guard.scan.directory-unreadable'
  | 'guard.scan.entry-unreadable'
  | 'guard.scan.entry-replaced'
  | 'guard.scan.symlink-refused';

export type SourceInventoryOperation = 'lstat' | 'readdir' | 'read';

export interface SourceInventoryIssue {
  code: SourceInventoryIssueCode;
  operation: SourceInventoryOperation;
  path: string;
  /** Present only for a bounded, privacy-safe Node system error code. */
  systemCode?: string;
}

export interface SourceInventoryFile {
  /** Normalized repository-relative path. */
  path: string;
  /** Normalized scan root that selected this file. */
  root: string;
  content: string;
}

export interface SourceInventoryCounts {
  rootsRequested: number;
  rootsScanned: number;
  directoriesScanned: number;
  entriesInspected: number;
  candidatesFound: number;
  filesRead: number;
  issuesTotal: number;
  issuesOmitted: number;
}

export interface SourceInventoryResult {
  files: SourceInventoryFile[];
  issues: SourceInventoryIssue[];
  counts: SourceInventoryCounts;
}

export type SourceInventoryStat = Pick<
  Stats,
  | 'ctimeMs'
  | 'dev'
  | 'ino'
  | 'isDirectory'
  | 'isFile'
  | 'isSymbolicLink'
  | 'mtimeMs'
  | 'size'
>;

export interface SourceInventoryFileSystem {
  readdirSync(directory: string, boundDirectory?: string): readonly string[];
  lstatSync(entry: string, boundEntry?: string): SourceInventoryStat;
  readFileSync(file: string, expectedStat: SourceInventoryStat, boundFile?: string): string;
}

export interface SourceInventoryNativeFileSystemOptions {
  /** Narrow syscall seam used to verify the flags on the descriptor-bound open. */
  openFile?: (file: string, flags: number) => number;
  /** `null` models a platform without a usable no-follow flag. */
  noFollowFlag?: number | null;
}

export interface SourceInventoryOptions {
  repoRoot: string;
  roots: readonly string[];
  includeFile(file: string): boolean;
  excludeDirectory?(directory: string): boolean;
  fileSystem?: SourceInventoryFileSystem;
  issueLimit?: number;
}

export const SOURCE_INVENTORY_DEFAULT_ISSUE_LIMIT = 20;

export type InventoryGuardStatus = 'pass' | 'block' | 'inconclusive';
export type InventoryGuardExitCode = 0 | 1 | 2;
export type InventoryGuardOutputMode = 'human' | 'verbose' | 'json';
export type InventoryGuardCliIssueCode =
  | 'guard.cli.unknown-option'
  | 'guard.cli.duplicate-option'
  | 'guard.cli.conflicting-option';

export interface InventoryGuardDiagnostic {
  code: string;
  path?: string;
  line?: number;
  subject?: string;
  operation?: SourceInventoryOperation;
  systemCode?: string;
}

export interface InventoryGuardReport {
  schemaVersion: 1;
  guard: string;
  status: InventoryGuardStatus;
  exitCode: InventoryGuardExitCode;
  counts: Readonly<Record<string, number>>;
  diagnostics: readonly InventoryGuardDiagnostic[];
}

export interface InventoryGuardStreams {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export type InventoryGuardArgs =
  | { ok: true; mode: InventoryGuardOutputMode }
  | { ok: false; mode: 'human' | 'json'; code: InventoryGuardCliIssueCode };

/** Closed, TTY-independent output-mode parsing shared by source inventory guards. */
export function parseInventoryGuardArgs(argv: readonly string[]): InventoryGuardArgs {
  const parsed = parseClosedOptions(argv, {
    booleanOptions: ['--json', '--verbose'],
    valueOptions: [],
  });
  const failureMode = argv.includes('--json') ? 'json' : 'human';
  if (parsed.error === 'ci.input.option-unknown') {
    return { ok: false, mode: failureMode, code: 'guard.cli.unknown-option' };
  }
  if (parsed.error === 'ci.input.duplicate-option') {
    return { ok: false, mode: failureMode, code: 'guard.cli.duplicate-option' };
  }
  if (parsed.error !== null) {
    return { ok: false, mode: failureMode, code: 'guard.cli.unknown-option' };
  }
  if (parsed.flags.has('--json') && parsed.flags.has('--verbose')) {
    return { ok: false, mode: 'json', code: 'guard.cli.conflicting-option' };
  }
  if (parsed.flags.has('--json')) return { ok: true, mode: 'json' };
  if (parsed.flags.has('--verbose')) return { ok: true, mode: 'verbose' };
  return { ok: true, mode: 'human' };
}

export function inventoryGuardCliFailure(
  guard: string,
  code: InventoryGuardCliIssueCode,
): InventoryGuardReport {
  return {
    schemaVersion: 1,
    guard,
    status: 'inconclusive',
    exitCode: 2,
    counts: {
      filesExamined: 0,
      findings: 0,
      scanIssues: 0,
      scanIssuesOmitted: 0,
    },
    diagnostics: [{ code }],
  };
}

export function sourceInventoryDiagnostics(
  inventory: Pick<SourceInventoryResult, 'issues'>,
): InventoryGuardDiagnostic[] {
  return inventory.issues.map((issue) => ({ ...issue }));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function verboseInventoryGuardLines(report: InventoryGuardReport): string[] {
  const counts = Object.entries(report.counts)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const lines = [`guard-report: status=${report.status} exitCode=${report.exitCode} ${counts}`.trimEnd()];
  for (const diagnostic of report.diagnostics) {
    const fields = Object.entries(diagnostic)
      .filter(([key]) => key !== 'code')
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    lines.push(`  [${diagnostic.code}]${fields === '' ? '' : ` ${fields}`}`);
  }
  return lines;
}

/** Emit exactly one JSON document in JSON mode; human modes retain their guard prefix. */
export function emitInventoryGuardReport(
  report: InventoryGuardReport,
  mode: InventoryGuardOutputMode,
  humanLines: readonly string[],
  streams: InventoryGuardStreams = process,
): InventoryGuardExitCode {
  if (mode === 'json') {
    streams.stdout.write(`${JSON.stringify(report)}\n`);
    return report.exitCode;
  }
  const lines = mode === 'verbose'
    ? [...humanLines, ...verboseInventoryGuardLines(report)]
    : [...humanLines];
  const stream = report.exitCode === 0 ? streams.stdout : streams.stderr;
  stream.write(`${lines.join('\n')}\n`);
  return report.exitCode;
}

export function emitInventoryGuardUnexpectedFailure(
  guard: string,
  argv: readonly string[],
  streams: InventoryGuardStreams = process,
): InventoryGuardExitCode {
  const mode: 'human' | 'json' = argv.includes('--json') ? 'json' : 'human';
  const report: InventoryGuardReport = {
    schemaVersion: 1,
    guard,
    status: 'inconclusive',
    exitCode: 2,
    counts: {
      filesExamined: 0,
      findings: 0,
      scanIssues: 0,
      scanIssuesOmitted: 0,
    },
    diagnostics: [{ code: 'guard.internal.unexpected' }],
  };
  return emitInventoryGuardReport(
    report,
    mode,
    [`${guard}: INCONCLUSIVE — guard.internal.unexpected`],
    streams,
  );
}

/**
 * Final privacy boundary for synchronous inventory CLIs. Library-level
 * programming errors still propagate to callers; executable entry points map
 * them to one stable, non-sensitive inconclusive receipt.
 */
export function runInventoryGuardCliBoundary(
  guard: string,
  argv: readonly string[],
  action: () => InventoryGuardExitCode,
  streams: InventoryGuardStreams = process,
): InventoryGuardExitCode {
  try {
    return action();
  } catch {
    return emitInventoryGuardUnexpectedFailure(guard, argv, streams);
  }
}

class SourceInventoryReplacementError extends Error {}

function sameSourceIdentity(left: SourceInventoryStat, right: SourceInventoryStat): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameSourceNode(left: SourceInventoryStat, right: SourceInventoryStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function replacementError(): SourceInventoryReplacementError {
  return new SourceInventoryReplacementError('source inventory entry changed during read');
}

function replacementPathFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['ELOOP', 'ENOENT', 'ENOTDIR'].includes(String((error as { code?: unknown }).code));
}

function noFollowUnavailableError(): NodeJS.ErrnoException {
  return Object.assign(
    new Error('source inventory no-follow protection is unavailable'),
    { code: 'ENOSYS' },
  );
}

/** Build the native adapter while keeping the descriptor-open contract directly testable. */
export function createNativeSourceInventoryFileSystem(
  options: SourceInventoryNativeFileSystemOptions = {},
): SourceInventoryFileSystem {
  const openFile = options.openFile ?? openSync;
  const noFollowFlag = options.noFollowFlag === undefined
    ? constants.O_NOFOLLOW
    : options.noFollowFlag;

  return {
    readdirSync: (directory, boundDirectory = directory) => readdirSync(boundDirectory),
    lstatSync: (entry, boundEntry = entry) => lstatSync(boundEntry),
    readFileSync: (file, expectedStat, boundFile = file) => {
      if (
        typeof noFollowFlag !== 'number'
        || !Number.isSafeInteger(noFollowFlag)
        || noFollowFlag <= 0
      ) {
        throw noFollowUnavailableError();
      }

      let descriptor: number;
      try {
        descriptor = openFile(boundFile, constants.O_RDONLY | noFollowFlag);
      } catch (error) {
        if (replacementPathFailure(error)) throw replacementError();
        throw error;
      }
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || !sameSourceIdentity(opened, expectedStat)) {
          throw replacementError();
        }
        const content = readFileSync(descriptor, 'utf8');
        const afterRead = fstatSync(descriptor);
        let currentPath: SourceInventoryStat;
        try {
          currentPath = lstatSync(boundFile);
        } catch (error) {
          if (replacementPathFailure(error)) throw replacementError();
          throw error;
        }
        if (
          !afterRead.isFile()
          || !currentPath.isFile()
          || currentPath.isSymbolicLink()
          || !sameSourceIdentity(opened, afterRead)
          || !sameSourceIdentity(opened, currentPath)
        ) {
          throw replacementError();
        }
        return content;
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

const nativeSourceInventoryFileSystem = createNativeSourceInventoryFileSystem();

function inventoryRoot(root: string): string {
  if (path.isAbsolute(root)) {
    throw new RangeError('source inventory roots must be repository-relative');
  }
  const normalized = normalizeRepoPath(path.normalize(root)).replace(/\/$/, '');
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new RangeError('source inventory roots must stay inside the repository');
  }
  return normalized;
}

function systemErrorCode(error: unknown): { operational: boolean; systemCode?: string } {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return { operational: false };
  }
  const code = (error as { code?: unknown }).code;
  return isNonEmptyString(code) && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? { operational: true, systemCode: code }
    : { operational: true };
}

/**
 * Deterministically inventory and read selected source files without following
 * symlinks. Each synchronous traversal is rooted in the entered directory's
 * kernel-held working-directory identity, so swapping an absolute ancestor
 * cannot redirect later child lookups. Operational filesystem failures become
 * bounded, privacy-safe issues; exceptions without a Node-style system `code`
 * propagate unchanged.
 */
export function inventorySourceFiles(options: SourceInventoryOptions): SourceInventoryResult {
  const fileSystem = options.fileSystem ?? nativeSourceInventoryFileSystem;
  const repoRoot = path.resolve(options.repoRoot);
  const startingCwd = process.cwd();
  const startingCwdStat = lstatSync('.');
  const issueLimit = options.issueLimit ?? SOURCE_INVENTORY_DEFAULT_ISSUE_LIMIT;
  if (!Number.isSafeInteger(issueLimit) || issueLimit < 0) {
    throw new RangeError('source inventory issueLimit must be a non-negative safe integer');
  }

  const roots = [...new Set(options.roots.map(inventoryRoot))].sort(compareText);
  const files: SourceInventoryFile[] = [];
  const issues: SourceInventoryIssue[] = [];
  let rootsScanned = 0;
  let directoriesScanned = 0;
  let entriesInspected = 0;
  let candidatesFound = 0;
  let issuesTotal = 0;
  let cwdDepth = 0;

  const recordIssue = (issue: SourceInventoryIssue): void => {
    issuesTotal += 1;
    if (issues.length < issueLimit) issues.push(issue);
  };

  const classifyFailure = (
    error: unknown,
    code: SourceInventoryIssueCode,
    operation: SourceInventoryOperation,
    relativePath: string,
  ): void => {
    const classified = systemErrorCode(error);
    if (!classified.operational) throw error;
    recordIssue({
      code,
      operation,
      path: normalizeRepoPath(relativePath),
      ...(classified.systemCode === undefined ? {} : { systemCode: classified.systemCode }),
    });
  };

  const walk = (
    root: string,
    relativeDirectory: string,
    absoluteDirectory: string,
    expectedDirectoryStat: SourceInventoryStat,
  ): boolean => {
    const fileCheckpoint = files.length;
    let entries: readonly string[];
    try {
      entries = fileSystem.readdirSync(absoluteDirectory, '.');
    } catch (error) {
      classifyFailure(
        error,
        relativeDirectory === root
          ? 'guard.scan.root-unreadable'
          : 'guard.scan.directory-unreadable',
        'readdir',
        relativeDirectory,
      );
      return true;
    }
    directoriesScanned += 1;
    if (relativeDirectory === root) rootsScanned += 1;

    for (const entry of [...entries].sort(compareText)) {
      if (
        entry === ''
        || entry === '.'
        || entry === '..'
        || path.isAbsolute(entry)
        || path.basename(entry) !== entry
      ) {
        throw new RangeError('source inventory adapter returned a non-basename entry');
      }
      const relativeEntry = normalizeRepoPath(path.join(relativeDirectory, entry));
      const absoluteEntry = path.join(absoluteDirectory, entry);
      entriesInspected += 1;
      let stat: SourceInventoryStat;
      try {
        stat = fileSystem.lstatSync(absoluteEntry, entry);
      } catch (error) {
        classifyFailure(error, 'guard.scan.entry-unreadable', 'lstat', relativeEntry);
        continue;
      }
      if (stat.isSymbolicLink()) {
        recordIssue({
          code: 'guard.scan.symlink-refused',
          operation: 'lstat',
          path: relativeEntry,
        });
        continue;
      }
      if (stat.isDirectory()) {
        if (!options.excludeDirectory?.(relativeEntry)) {
          try {
            process.chdir(entry);
            cwdDepth += 1;
          } catch (error) {
            if (replacementPathFailure(error)) {
              recordIssue({
                code: 'guard.scan.entry-replaced',
                operation: 'readdir',
                path: relativeEntry,
              });
            } else {
              classifyFailure(error, 'guard.scan.entry-unreadable', 'readdir', relativeEntry);
            }
            continue;
          }

          let enteredStat: SourceInventoryStat;
          try {
            enteredStat = fileSystem.lstatSync(absoluteEntry, '.');
          } catch (error) {
            files.splice(fileCheckpoint);
            if (replacementPathFailure(error)) {
              recordIssue({
                code: 'guard.scan.entry-replaced',
                operation: 'readdir',
                path: relativeEntry,
              });
            } else {
              classifyFailure(error, 'guard.scan.directory-unreadable', 'lstat', relativeEntry);
            }
            return false;
          }
          if (
            !enteredStat.isDirectory()
            || enteredStat.isSymbolicLink()
            || !sameSourceIdentity(stat, enteredStat)
          ) {
            files.splice(fileCheckpoint);
            recordIssue({
              code: 'guard.scan.entry-replaced',
              operation: 'readdir',
              path: relativeEntry,
            });
            return false;
          }

          if (!walk(root, relativeEntry, absoluteEntry, enteredStat)) {
            files.splice(fileCheckpoint);
            return false;
          }

          try {
            process.chdir('..');
            cwdDepth -= 1;
          } catch (error) {
            files.splice(fileCheckpoint);
            classifyFailure(error, 'guard.scan.directory-unreadable', 'readdir', relativeDirectory);
            return false;
          }
          let returnedStat: SourceInventoryStat;
          try {
            returnedStat = fileSystem.lstatSync(absoluteDirectory, '.');
          } catch (error) {
            files.splice(fileCheckpoint);
            if (replacementPathFailure(error)) {
              recordIssue({
                code: 'guard.scan.entry-replaced',
                operation: 'readdir',
                path: relativeDirectory,
              });
            } else {
              classifyFailure(error, 'guard.scan.directory-unreadable', 'lstat', relativeDirectory);
            }
            return false;
          }
          if (
            !returnedStat.isDirectory()
            || returnedStat.isSymbolicLink()
            || !sameSourceIdentity(expectedDirectoryStat, returnedStat)
          ) {
            files.splice(fileCheckpoint);
            recordIssue({
              code: 'guard.scan.entry-replaced',
              operation: 'readdir',
              path: relativeDirectory,
            });
            return false;
          }
        }
        continue;
      }
      if (!options.includeFile(relativeEntry)) continue;
      candidatesFound += 1;
      if (!stat.isFile()) {
        recordIssue({
          code: 'guard.scan.entry-unreadable',
          operation: 'lstat',
          path: relativeEntry,
        });
        continue;
      }
      try {
        const content = fileSystem.readFileSync(absoluteEntry, stat, entry);
        if (typeof content !== 'string') {
          throw new TypeError('source inventory adapter returned non-text content');
        }
        const afterRead = fileSystem.lstatSync(absoluteEntry, entry);
        if (
          !afterRead.isFile()
          || afterRead.isSymbolicLink()
          || !sameSourceIdentity(stat, afterRead)
        ) {
          recordIssue({
            code: 'guard.scan.entry-replaced',
            operation: 'read',
            path: relativeEntry,
          });
          continue;
        }
        files.push({ path: relativeEntry, root, content });
      } catch (error) {
        if (error instanceof SourceInventoryReplacementError || replacementPathFailure(error)) {
          recordIssue({
            code: 'guard.scan.entry-replaced',
            operation: 'read',
            path: relativeEntry,
          });
        } else {
          classifyFailure(error, 'guard.scan.entry-unreadable', 'read', relativeEntry);
        }
      }
    }

    let currentDirectoryStat: SourceInventoryStat;
    try {
      currentDirectoryStat = fileSystem.lstatSync(absoluteDirectory, '.');
    } catch (error) {
      files.splice(fileCheckpoint);
      if (replacementPathFailure(error)) {
        recordIssue({
          code: 'guard.scan.entry-replaced',
          operation: 'readdir',
          path: relativeDirectory,
        });
      } else {
        classifyFailure(
          error,
          relativeDirectory === root
            ? 'guard.scan.root-unreadable'
            : 'guard.scan.directory-unreadable',
          'lstat',
          relativeDirectory,
        );
      }
      return true;
    }
    if (
      !currentDirectoryStat.isDirectory()
      || currentDirectoryStat.isSymbolicLink()
      || !sameSourceIdentity(expectedDirectoryStat, currentDirectoryStat)
    ) {
      files.splice(fileCheckpoint);
      recordIssue({
        code: 'guard.scan.entry-replaced',
        operation: 'readdir',
        path: relativeDirectory,
      });
      return false;
    }
    return true;
  };

  let repositoryStat: SourceInventoryStat | null = null;
  try {
    repositoryStat = fileSystem.lstatSync(repoRoot, repoRoot);
  } catch (error) {
    for (const root of roots) {
      classifyFailure(error, 'guard.scan.root-unreadable', 'lstat', root);
    }
  }

  let enteredRepository = false;
  if (repositoryStat !== null) {
    if (repositoryStat.isSymbolicLink() || !repositoryStat.isDirectory()) {
      for (const root of roots) {
        recordIssue({
          code: repositoryStat.isSymbolicLink()
            ? 'guard.scan.symlink-refused'
            : 'guard.scan.root-unreadable',
          operation: 'lstat',
          path: root,
        });
      }
      repositoryStat = null;
    } else if (sameSourceNode(repositoryStat, startingCwdStat)) {
      enteredRepository = true;
    } else if (path.resolve(startingCwd) === repoRoot) {
      for (const root of roots) {
        recordIssue({
          code: 'guard.scan.entry-replaced',
          operation: 'readdir',
          path: root,
        });
      }
      repositoryStat = null;
    } else {
      try {
        process.chdir(repoRoot);
        enteredRepository = true;
      } catch (error) {
        for (const root of roots) {
          if (replacementPathFailure(error)) {
            recordIssue({
              code: 'guard.scan.entry-replaced',
              operation: 'readdir',
              path: root,
            });
          } else {
            classifyFailure(error, 'guard.scan.root-unreadable', 'readdir', root);
          }
        }
        repositoryStat = null;
      }
    }
  }

  try {
    if (repositoryStat !== null && enteredRepository) {
      let enteredRepositoryStat: SourceInventoryStat | null = null;
      try {
        enteredRepositoryStat = fileSystem.lstatSync(repoRoot, '.');
      } catch (error) {
        for (const root of roots) {
          if (replacementPathFailure(error)) {
            recordIssue({
              code: 'guard.scan.entry-replaced',
              operation: 'readdir',
              path: root,
            });
          } else {
            classifyFailure(error, 'guard.scan.root-unreadable', 'lstat', root);
          }
        }
        repositoryStat = null;
      }
      if (
        repositoryStat !== null
        && enteredRepositoryStat !== null
        && (
          !enteredRepositoryStat.isDirectory()
          || enteredRepositoryStat.isSymbolicLink()
          || !sameSourceIdentity(repositoryStat, enteredRepositoryStat)
        )
      ) {
        for (const root of roots) {
          recordIssue({
            code: 'guard.scan.entry-replaced',
            operation: 'readdir',
            path: root,
          });
        }
        repositoryStat = null;
      }
    }

    let repositoryNavigationValid = true;
    rootLoop: for (const root of repositoryStat === null ? [] : roots) {
      if (!repositoryNavigationValid) break;
      const absoluteRoot = path.join(repoRoot, root);
      const rootFileCheckpoint = files.length;
      try {
        let enteredStat: SourceInventoryStat | null = null;
        let traversedRoot = '';
        for (const segment of root.split('/')) {
          traversedRoot = traversedRoot === '' ? segment : `${traversedRoot}/${segment}`;
          const absoluteSegment = path.join(repoRoot, traversedRoot);
          let segmentStat: SourceInventoryStat;
          try {
            segmentStat = fileSystem.lstatSync(absoluteSegment, segment);
          } catch (error) {
            classifyFailure(error, 'guard.scan.root-unreadable', 'lstat', root);
            continue rootLoop;
          }
          if (segmentStat.isSymbolicLink()) {
            recordIssue({
              code: 'guard.scan.symlink-refused',
              operation: 'lstat',
              path: root,
            });
            continue rootLoop;
          }
          if (!segmentStat.isDirectory()) {
            recordIssue({
              code: 'guard.scan.root-unreadable',
              operation: 'lstat',
              path: root,
            });
            continue rootLoop;
          }
          try {
            process.chdir(segment);
            cwdDepth += 1;
          } catch (error) {
            if (replacementPathFailure(error)) {
              recordIssue({
                code: 'guard.scan.entry-replaced',
                operation: 'readdir',
                path: root,
              });
            } else {
              classifyFailure(error, 'guard.scan.root-unreadable', 'readdir', root);
            }
            continue rootLoop;
          }
          try {
            enteredStat = fileSystem.lstatSync(absoluteSegment, '.');
          } catch (error) {
            if (replacementPathFailure(error)) {
              recordIssue({
                code: 'guard.scan.entry-replaced',
                operation: 'readdir',
                path: root,
              });
            } else {
              classifyFailure(error, 'guard.scan.root-unreadable', 'lstat', root);
            }
            continue rootLoop;
          }
          if (
            !enteredStat.isDirectory()
            || enteredStat.isSymbolicLink()
            || !sameSourceIdentity(segmentStat, enteredStat)
          ) {
            recordIssue({
              code: 'guard.scan.entry-replaced',
              operation: 'readdir',
              path: root,
            });
            files.splice(rootFileCheckpoint);
            continue rootLoop;
          }
        }
        if (enteredStat === null) throw new RangeError('source inventory root had no path segments');
        if (!walk(root, root, absoluteRoot, enteredStat)) {
          files.splice(rootFileCheckpoint);
        }
      } finally {
        while (cwdDepth > 0) {
          try {
            process.chdir('..');
            cwdDepth -= 1;
          } catch {
            repositoryNavigationValid = false;
            break;
          }
        }
        let currentRepositoryStat: SourceInventoryStat | null = null;
        let currentRepositoryPathStat: SourceInventoryStat | null = null;
        if (repositoryNavigationValid) {
          try {
            currentRepositoryStat = fileSystem.lstatSync(repoRoot, '.');
            currentRepositoryPathStat = fileSystem.lstatSync(repoRoot, repoRoot);
          } catch {
            repositoryNavigationValid = false;
          }
        }
        if (
          !repositoryNavigationValid
          || currentRepositoryStat === null
          || currentRepositoryPathStat === null
          || repositoryStat === null
          || !currentRepositoryStat.isDirectory()
          || !currentRepositoryPathStat.isDirectory()
          || currentRepositoryStat.isSymbolicLink()
          || currentRepositoryPathStat.isSymbolicLink()
          || !sameSourceIdentity(repositoryStat, currentRepositoryStat)
          || !sameSourceIdentity(repositoryStat, currentRepositoryPathStat)
        ) {
          files.length = 0;
          recordIssue({
            code: 'guard.scan.entry-replaced',
            operation: 'readdir',
            path: root,
          });
          repositoryNavigationValid = false;
        }
      }
    }
  } finally {
    const currentCwdStat = lstatSync('.');
    if (!sameSourceNode(startingCwdStat, currentCwdStat)) {
      process.chdir(startingCwd);
      const restoredCwdStat = lstatSync('.');
      if (!sameSourceNode(startingCwdStat, restoredCwdStat)) throw replacementError();
    }
  }

  files.sort((left, right) => compareText(left.path, right.path) || compareText(left.root, right.root));
  issues.sort((left, right) =>
    compareText(left.path, right.path)
    || compareText(left.code, right.code)
    || compareText(left.operation, right.operation)
    || compareText(left.systemCode ?? '', right.systemCode ?? ''));
  return {
    files,
    issues,
    counts: {
      rootsRequested: roots.length,
      rootsScanned,
      directoriesScanned,
      entriesInspected,
      candidatesFound,
      filesRead: files.length,
      issuesTotal,
      issuesOmitted: issuesTotal - issues.length,
    },
  };
}

export function normalizeRepoPath(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

export function git(args: string[], cwd: string, timeout?: number): string {
  // 64 MiB: a large sync-merge's staged diff overflows the 1 MiB execFileSync
  // default and fails the guard with ENOBUFS instead of a real verdict.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeout ?? 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function gitList(args: string[], cwd: string): string[] {
  return git(args, cwd)
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizeRepoPath);
}

export function listStagedFiles(cwd: string, diffFilter: string): string[] {
  return gitList(['diff', '--cached', '--name-only', `--diff-filter=${diffFilter}`], cwd);
}

export function readStagedAddedLines(cwd: string, filePath: string): string {
  try {
    return execFileSync('git', ['diff', '--cached', '--unified=0', '--', filePath], {
      cwd,
      encoding: 'utf8',
      env: cleanGitEnv(),
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch {
    return '';
  }
}

function errorText(error: unknown): string {
  const candidate = error as { stderr?: unknown; message?: unknown };
  if (typeof candidate.stderr === 'string') return candidate.stderr;
  if (Buffer.isBuffer(candidate.stderr)) return candidate.stderr.toString('utf8');
  if (typeof candidate.message === 'string') return candidate.message;
  return String(error);
}

function isMissingGitBlobError(error: unknown): boolean {
  const text = errorText(error);
  return /does not exist \(neither on disk nor in the index\)/i.test(text)
    || /exists on disk, but not in the index/i.test(text)
    || /does not exist in 'HEAD'/i.test(text)
    || /invalid object name 'HEAD'/i.test(text);
}

function readGitBlob(cwd: string, blob: string): GitBlobReadResult {
  try {
    return {
      ok: true,
      content: execFileSync('git', ['show', blob], {
        cwd,
        encoding: 'utf8',
        env: cleanGitEnv(),
        maxBuffer: 20 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      }),
    };
  } catch (error) {
    if (isMissingGitBlobError(error)) return { ok: true, content: undefined };
    return { ok: false, error: errorText(error).trim() || `git show ${blob} failed` };
  }
}

/**
 * Read the content of a file from the staged index (`:0:<path>`), falling back
 * to the HEAD blob if the file has not been staged. Expected missing staged and
 * HEAD blobs return `{ ok: true, content: undefined }`; unexpected Git/blob
 * failures return `{ ok: false, error }`. Never reads from the working tree.
 */
export function readStagedFileContentResult(cwd: string, filePath: string): GitBlobReadResult {
  const normalized = normalizeRepoPath(filePath);
  const staged = readGitBlob(cwd, `:0:${normalized}`);
  if (!staged.ok || staged.content !== undefined) return staged;
  return readGitBlob(cwd, `HEAD:${normalized}`);
}

/**
 * Compatibility wrapper for callers that intentionally treat read failures as
 * absent content. New guard code should prefer readStagedFileContentResult.
 */
export function readStagedFileContent(cwd: string, filePath: string): string | undefined {
  const result = readStagedFileContentResult(cwd, filePath);
  return result.ok ? result.content : undefined;
}

/**
 * Read a file relative to `cwd`. Returns the UTF-8 content, or null if the
 * file does not exist. Byte-identical to the private `readText` helpers
 * previously duplicated in agent-decision-polls-guard and safeguard-diagnostics.
 */
export function readText(cwd: string, file: string): string | null {
  const absolute = path.join(cwd, file);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute, 'utf8');
}

export function isTextCandidate(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  const baseName = path.basename(normalized);
  if (baseName === 'Dockerfile' || baseName.startsWith('.env')) return true;
  return textExtensions.has(path.extname(normalized));
}

// Operational release-hygiene allowlist, shared by repo-hygiene-guard and
// publication-guard. These files describe the REAL fleet (health profiles,
// expected-fleet manifest, cutover scripts): the daily-health
// profile_coverage check matches their entries against on-disk instance
// dirs and live unit names, so the literal labels must appear verbatim
// (issue #1422).
export const operationalReleaseHygieneFiles = new Set([
  'scripts/cutover.sh',
  'scripts/migrate-namespace.sh',
  'scripts/soak-check.sh',
  'deploy/health-profiles/mwlab.json',
  'deploy/health-profiles/nucles.json',
  'deploy/bot-errors-expected-fleet.json',
]);

export const operationalProtocolIdentifiers = new Set([
  'whatsapp-bot@personal',
  'whatsapp-bot@loops',
  'whatsapp-bot@besbot',
  'whatsoup@q',
  'whatsoup@loops',
  'whatsoup@besbot',
  'whatsoup@personal',
  'whatsoup-personal',
  'instances/personal/whatsoup.sock',
  // Agent-bot instance label required verbatim by the daily-health
  // profile_coverage matcher (issue #1422).
  'mw-bot',
]);

// A systemd template unit renders an allowlisted identifier with a trailing
// ".service" suffix, which email-shape scanners match. Accept the identifier
// with or without that suffix.
export function isOperationalProtocolToken(token: string): boolean {
  if (operationalProtocolIdentifiers.has(token)) return true;
  return (
    token.endsWith('.service') && operationalProtocolIdentifiers.has(token.slice(0, -'.service'.length))
  );
}

// Domains reserved for documentation by RFC 2606 and RFC 6761. They cannot resolve
// to a real inbox, so an email-shaped token in one is a fixture by construction —
// the email analogue of the phone and Twilio SID fixture allowances. Without it, a
// transport that legitimately needs an email fixture (an iMessage AppleID sender)
// has no legal way to write one and the pressure is to weaken the rule instead.
//
// Lives here because the personal-email rule is implemented twice, in
// repo-hygiene-guard and publication-guard. Keeping the exception in one place is
// what stops the two from disagreeing about the same token.
//
// End-anchored on purpose: a routable domain that merely embeds a reserved name,
// such as a host under example.com.evil.net, must still be a finding.
const documentationEmailRhs = /@(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|net|org)|example|invalid|test)$/i;

export function isDocumentationEmailFixture(token: string): boolean {
  return documentationEmailRhs.test(token);
}

/** GitHub's fixed SSH transport principal is not a mailbox. */
export function isGitHubSshTransportPrincipal(token: string): boolean {
  return token === 'git@github.com';
}
