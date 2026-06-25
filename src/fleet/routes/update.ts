import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { jsonResponse } from '../../lib/http.ts';
import { createSSEWriter } from '../sse-helpers.ts';
import { createChildLogger } from '../../logger.ts';
import type { UpdateChecker } from '../update-checker.ts';
import { createServiceManager } from '../platform.ts';
import { cleanGitEnv } from '../../lib/git-env.ts';
import {
  DEFAULT_UPDATE_BRANCH,
  githubPublicHttpsUrlFromRemote,
  publicFetchArgs,
  shouldRetryWithPublicHttps,
} from '../../lib/git-public-remote.ts';

const execFileAsync = promisify(execFile);
const log = createChildLogger('fleet:update');

let updateInProgress = false;

function childEnv(): NodeJS.ProcessEnv {
  return cleanGitEnv();
}

function execGit(repoRoot: string, args: string[], timeout: number) {
  return execFileAsync('git', args, {
    cwd: repoRoot,
    timeout,
    env: childEnv(),
  });
}

async function pullFromConfiguredRemote(repoRoot: string): Promise<{ stdout: string; stderr: string; publicHttpsFallback: boolean }> {
  try {
    const result = await execGit(repoRoot, ['pull', 'origin', DEFAULT_UPDATE_BRANCH], 60_000);
    return { stdout: result.stdout, stderr: result.stderr, publicHttpsFallback: false };
  } catch (err) {
    if (!shouldRetryWithPublicHttps(err)) {
      throw err;
    }

    let remoteUrl: string;
    try {
      const result = await execGit(repoRoot, ['remote', 'get-url', 'origin'], 5_000);
      remoteUrl = result.stdout;
    } catch {
      throw err;
    }
    const publicUrl = githubPublicHttpsUrlFromRemote(remoteUrl);
    if (!publicUrl) {
      throw err;
    }

    await execGit(repoRoot, publicFetchArgs(publicUrl, DEFAULT_UPDATE_BRANCH), 60_000);
    const merge = await execGit(repoRoot, ['merge', '--ff-only', `origin/${DEFAULT_UPDATE_BRANCH}`], 60_000);
    return { stdout: merge.stdout, stderr: merge.stderr, publicHttpsFallback: true };
  }
}

/**
 * Parse `git status --porcelain` output, filtering out untracked entries (`??`).
 * Returns the list of tracked-file paths with pending modifications.
 */
function parseTrackedChanges(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('??'))
    // porcelain format: "XY <path>" — XY are status codes, path starts at col 3
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

async function preservePostUpdateFailure(
  repoRoot: string,
  previousSha: string | null,
  writeSSE: (event: string, data: unknown) => void,
): Promise<void> {
  try {
    let preservedFiles: string[] = [];
    let patchPath: string | undefined;
    let stashRef: string | undefined;

    try {
      const { stdout: porcelain } = await execGit(repoRoot, ['status', '--porcelain'], 5_000);
      preservedFiles = parseTrackedChanges(porcelain);
    } catch (statusErr) {
      log.warn({ err: statusErr, previousSha }, 'post-update preserve: git status failed');
      writeSSE('progress', {
        step: 'preserve',
        status: 'skipped',
        reason: 'status-failed',
        previousSha,
        message: 'Update validation failed. Unable to inspect local changes; fleet server was not restarted.',
      });
      return;
    }

    if (preservedFiles.length > 0) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const shortSha = previousSha?.slice(0, 7) ?? 'unknown';
      const candidatePath = `/tmp/whatsoup-update-preserve-${timestamp}-${shortSha}.patch`;

      let diffOut = '';
      try {
        const { stdout } = await execGit(repoRoot, ['diff', 'HEAD'], 10_000);
        diffOut = stdout;
      } catch (diffErr) {
        log.warn({ err: diffErr, previousSha }, 'post-update preserve: git diff HEAD failed');
        writeSSE('progress', {
          step: 'preserve',
          status: 'skipped',
          reason: 'diff-capture-failed',
          previousSha,
          files: preservedFiles,
          message: 'Update validation failed. Unable to capture a patch; fleet server was not restarted.',
        });
        return;
      }

      try {
        writeFileSync(candidatePath, diffOut, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        patchPath = candidatePath;
      } catch (writeErr) {
        log.error({ err: writeErr, previousSha, candidatePath }, 'post-update preserve: patch write failed');
        writeSSE('progress', {
          step: 'preserve',
          status: 'skipped',
          reason: 'patch-write-failed',
          previousSha,
          files: preservedFiles,
          message: 'Update validation failed. Unable to write a recovery patch; fleet server was not restarted.',
        });
        return;
      }

      try {
        await execGit(repoRoot, ['stash', 'push', '--message', `whatsoup-update-preserve ${timestamp}`, '--', ...preservedFiles], 15_000);
        stashRef = 'stash@{0}';
      } catch (stashErr) {
        log.warn({ err: stashErr, previousSha }, 'post-update preserve: git stash push failed, patch artifact still on disk');
      }
    }

    writeSSE('progress', {
      step: 'preserve',
      status: 'done',
      previousSha,
      message: preservedFiles.length > 0
        ? 'Update validation failed. Preserved tracked drift; fleet server was not restarted.'
        : 'Update validation failed. No tracked drift to preserve; fleet server was not restarted.',
      preservedFiles,
      ...(patchPath ? { patchPath } : {}),
      ...(stashRef ? { stashRef } : {}),
    });
    log.info({ previousSha, preservedFiles, patchPath, stashRef }, 'post-update failure preserved');
  } catch (err) {
    writeSSE('error', { step: 'preserve', message: `Post-update preservation failed: ${(err as Error).message}` });
    log.error({ err, previousSha }, 'post-update preservation failed');
  }
}

export function handleGetVersion(
  _req: IncomingMessage,
  res: ServerResponse,
  checker: UpdateChecker,
): void {
  // B1 observability: non-secret console auth posture rides the version
  // payload so operators can verify the closure from the API.
  jsonResponse(res, 200, { ...checker.getState(), consoleAuthMode: 'session', rootTokenInHtml: false });
}

export async function handleUpdate(
  _req: IncomingMessage,
  res: ServerResponse,
  checker: UpdateChecker,
  repoRoot: string,
): Promise<void> {
  if (updateInProgress) {
    jsonResponse(res, 409, { error: 'Update already in progress' });
    return;
  }
  updateInProgress = true;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const { writeSSE, endOnce } = createSSEWriter(res);
  const finishUpdate = () => {
    updateInProgress = false;
    endOnce();
  };
  _req.on('close', endOnce);

  try {
    // Save pre-pull SHA so we can diff the full range after pull (not just HEAD~1)
    let prePullSha: string | null = null;
    try {
      prePullSha = (await execGit(repoRoot, ['rev-parse', 'HEAD'], 5_000)).stdout.trim();
    } catch { /* proceed without — install steps will run unconditionally */ }

    // Pre-flight: reject if working tree is dirty (uncommitted changes would cause pull conflicts)
    try {
      const { stdout: porcelain } = await execGit(repoRoot, ['status', '--porcelain'], 5_000);
      // Only block on tracked-file modifications (M, A, D, R, etc.) — untracked files (??) are
      // safe for git pull and should not prevent updates.
      const trackedChanges = parseTrackedChanges(porcelain);
      if (trackedChanges.length > 0) {
        writeSSE('error', { step: 'pull', message: `Working tree has ${trackedChanges.length} uncommitted change(s). Commit or stash before updating.` });
        finishUpdate();
        return;
      }
    } catch { /* git status failed — proceed anyway, pull will fail if truly dirty */ }

    // Step 1: git pull
    writeSSE('progress', { step: 'pull', status: 'running' });
    try {
      const { stdout, publicHttpsFallback } = await pullFromConfiguredRemote(repoRoot);
      // Read the new SHA explicitly so the console can detect the update
      // without relying on checker.checkNow() completing in time
      let newSha: string | undefined;
      try {
        newSha = (await execGit(repoRoot, ['rev-parse', '--short', 'HEAD'], 5_000)).stdout.trim();
      } catch { /* non-critical — proceed without */ }

      const alreadyUpToDate = stdout.includes('Already up to date');
      if (alreadyUpToDate) {
        writeSSE('progress', { step: 'pull', status: 'done', message: 'Already up to date — no new changes to pull.', noChanges: true, newSha, publicHttpsFallback });
      } else {
        writeSSE('progress', { step: 'pull', status: 'done', message: stdout.trim(), newSha, publicHttpsFallback });
      }
      // Refresh cached version state so /api/version reflects the pull
      checker.checkNow().catch(() => {});
    } catch (err: any) {
      writeSSE('error', { step: 'pull', message: err.stderr?.trim() || err.message });
      finishUpdate();
      return;
    }

    // Diff the full pull range once (not HEAD~1 which misses multi-commit pulls)
    let changedFiles: string[] = [];
    if (prePullSha) {
      try {
        const { stdout: diffOut } = await execGit(repoRoot, ['diff', prePullSha, '--name-only'], 10_000);
        changedFiles = diffOut.split('\n').map(f => f.trim()).filter(Boolean);
      } catch { /* diff failed — changedFiles stays empty, install steps run unconditionally */ }
    }

    // Step 2: Root npm install (if root lockfile changed)
    writeSSE('progress', { step: 'install', status: 'running' });
    const rootLockfileChanged = !prePullSha || changedFiles.includes('package-lock.json');
    if (rootLockfileChanged) {
      try {
        await execFileAsync('npm', ['install'], { cwd: repoRoot, timeout: 120_000, env: childEnv() });
        writeSSE('progress', { step: 'install', status: 'done' });
      } catch (err: any) {
        writeSSE('error', { step: 'install', message: err.stderr?.trim() || err.message });
        await preservePostUpdateFailure(repoRoot, prePullSha, writeSSE);
        finishUpdate();
        return;
      }
    } else {
      writeSSE('progress', { step: 'install', status: 'skip', message: 'No lockfile changes' });
    }

    // Step 3: Console npm install (if console lockfile changed)
    writeSSE('progress', { step: 'console-install', status: 'running' });
    const consoleLockfileChanged = !prePullSha || changedFiles.includes('console/package-lock.json');
    if (consoleLockfileChanged) {
      try {
        await execFileAsync('npm', ['install'], {
          cwd: `${repoRoot}/console`, timeout: 120_000, env: childEnv(),
        });
        writeSSE('progress', { step: 'console-install', status: 'done' });
      } catch (err: any) {
        writeSSE('error', { step: 'console-install', message: err.stderr?.trim() || err.message });
        await preservePostUpdateFailure(repoRoot, prePullSha, writeSSE);
        finishUpdate();
        return;
      }
    } else {
      writeSSE('progress', { step: 'console-install', status: 'skip', message: 'No console lockfile changes' });
    }

    // Step 4: Console rebuild (only if console/ files changed)
    const consoleFilesChanged = !prePullSha || changedFiles.some(f => f.startsWith('console/'));
    if (consoleFilesChanged) {
      writeSSE('progress', { step: 'console-build', status: 'running' });
      try {
        await execFileAsync('npx', ['vite', 'build'], {
          cwd: `${repoRoot}/console`, timeout: 120_000, env: childEnv(),
        });
        writeSSE('progress', { step: 'console-build', status: 'done' });
      } catch (err: any) {
        writeSSE('error', { step: 'console-build', message: err.stderr?.trim() || err.message });
        await preservePostUpdateFailure(repoRoot, prePullSha, writeSSE);
        finishUpdate();
        return;
      }
    } else {
      writeSSE('progress', { step: 'console-build', status: 'skip', message: 'No console file changes' });
    }

    // Step 5: Restart fleet server via service manager
    writeSSE('progress', { step: 'restart', status: 'running' });
    const svcMgr = createServiceManager();
    svcMgr.restart('whatsoup-fleet').catch((err: Error) => {
      writeSSE('error', {
        step: 'restart',
        message: `Fleet restart failed: ${err.message}. Restart manually: npm run fleet`,
      });
    }).finally(() => {
      // Always release mutex + end response — on success the process is about
      // to be killed by the service manager, but if it survives (e.g. slow),
      // the endpoint must not stay permanently locked.
      finishUpdate();
    });
  } catch (err: any) {
    writeSSE('error', { step: 'unknown', message: err.message });
    finishUpdate();
  }
}
