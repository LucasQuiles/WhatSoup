import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanGitEnv } from '../../src/lib/git-env.ts';

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

export function normalizeRepoPath(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

export function git(args: string[], cwd: string): string {
  // 64 MiB: a large sync-merge's staged diff overflows the 1 MiB execFileSync
  // default and fails the guard with ENOBUFS instead of a real verdict.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
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
