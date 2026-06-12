import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { cleanGitEnv } from '../../src/lib/git-env.ts';

export { cleanGitEnv } from '../../src/lib/git-env.ts';

const textExtensions = new Set([
  '.cjs',
  '.css',
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

export function normalizeRepoPath(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

export function git(args: string[], cwd: string): string {
  // maxBuffer matches readStagedAddedLines below: large merge commits (50+
  // upstream commits) produce staged diffs beyond the node default, and the
  // guard must fail on findings, not on buffer size.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    maxBuffer: 20 * 1024 * 1024,
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

export function isTextCandidate(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  const baseName = path.basename(normalized);
  if (baseName === 'Dockerfile' || baseName.startsWith('.env')) return true;
  return textExtensions.has(path.extname(normalized));
}
