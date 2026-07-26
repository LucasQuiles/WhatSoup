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
