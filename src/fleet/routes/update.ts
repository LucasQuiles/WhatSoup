import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { jsonResponse } from '../../lib/http.ts';
import { createChildLogger } from '../../logger.ts';
import type { UpdateChecker } from '../update-checker.ts';

const execFileAsync = promisify(execFile);
const log = createChildLogger('fleet:update');

let updateInProgress = false;

/** Attempt to rollback to a previous SHA after a failed update step. Best-effort — logs but doesn't throw. */
async function rollback(repoRoot: string, sha: string, writeSSE: (event: string, data: unknown) => void): Promise<void> {
  try {
    await execFileAsync('git', ['reset', '--hard', sha], { cwd: repoRoot, timeout: 15_000 });
    writeSSE('progress', { step: 'rollback', status: 'done', message: `Rolled back to ${sha.slice(0, 7)}` });
    log.info({ sha }, 'update rollback succeeded');
  } catch (err) {
    writeSSE('error', { step: 'rollback', message: `Rollback failed: ${(err as Error).message}` });
    log.error({ err, sha }, 'update rollback failed');
  }
}

export function handleGetVersion(
  _req: IncomingMessage,
  res: ServerResponse,
  checker: UpdateChecker,
): void {
  jsonResponse(res, 200, checker.getState());
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

  let ended = false;
  const endOnce = () => { if (!ended) { ended = true; res.end(); updateInProgress = false; } };
  _req.on('close', endOnce);

  const writeSSE = (event: string, data: unknown) => {
    if (!ended) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Save pre-pull SHA so we can diff the full range after pull (not just HEAD~1)
    let prePullSha: string | null = null;
    try {
      prePullSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5_000 })).stdout.trim();
    } catch { /* proceed without — install steps will run unconditionally */ }

    // Pre-flight: reject if working tree is dirty (uncommitted changes would cause pull conflicts)
    try {
      const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot, timeout: 5_000 });
      // Only block on tracked-file modifications (M, A, D, R, etc.) — untracked files (??) are
      // safe for git pull and should not prevent updates.
      const trackedChanges = porcelain.split('\n').filter(l => l.trim() && !l.startsWith('??'));
      if (trackedChanges.length > 0) {
        writeSSE('error', { step: 'pull', message: `Working tree has uncommitted changes — commit or stash before updating.\n${trackedChanges.join('\n')}` });
        endOnce();
        return;
      }
    } catch { /* git status failed — proceed anyway, pull will fail if truly dirty */ }

    // Step 1: git pull
    writeSSE('progress', { step: 'pull', status: 'running' });
    try {
      const { stdout } = await execFileAsync('git', ['pull', 'origin', 'main'], {
        cwd: repoRoot, timeout: 60_000,
      });
      writeSSE('progress', { step: 'pull', status: 'done', message: stdout.trim() });
      // Refresh cached version state so /api/version reflects the pull
      await checker.checkNow();
    } catch (err: any) {
      writeSSE('error', { step: 'pull', message: err.stderr?.trim() || err.message });
      endOnce();
      return;
    }

    // Diff the full pull range once (not HEAD~1 which misses multi-commit pulls)
    let changedFiles: string[] = [];
    if (prePullSha) {
      try {
        const { stdout: diffOut } = await execFileAsync(
          'git', ['diff', prePullSha, '--name-only'],
          { cwd: repoRoot, timeout: 10_000 },
        );
        changedFiles = diffOut.split('\n').map(f => f.trim()).filter(Boolean);
      } catch { /* diff failed — changedFiles stays empty, install steps run unconditionally */ }
    }

    // Step 2: Root npm install (if root lockfile changed)
    writeSSE('progress', { step: 'install', status: 'running' });
    const rootLockfileChanged = !prePullSha || changedFiles.includes('package-lock.json');
    if (rootLockfileChanged) {
      try {
        await execFileAsync('npm', ['install'], { cwd: repoRoot, timeout: 120_000 });
        writeSSE('progress', { step: 'install', status: 'done' });
      } catch (err: any) {
        writeSSE('error', { step: 'install', message: err.stderr?.trim() || err.message });
        if (prePullSha) await rollback(repoRoot, prePullSha, writeSSE);
        endOnce();
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
          cwd: `${repoRoot}/console`, timeout: 120_000,
        });
        writeSSE('progress', { step: 'console-install', status: 'done' });
      } catch (err: any) {
        writeSSE('error', { step: 'console-install', message: err.stderr?.trim() || err.message });
        if (prePullSha) await rollback(repoRoot, prePullSha, writeSSE);
        endOnce();
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
          cwd: `${repoRoot}/console`, timeout: 120_000,
        });
        writeSSE('progress', { step: 'console-build', status: 'done' });
      } catch (err: any) {
        writeSSE('error', { step: 'console-build', message: err.stderr?.trim() || err.message });
        if (prePullSha) await rollback(repoRoot, prePullSha, writeSSE);
        endOnce();
        return;
      }
    } else {
      writeSSE('progress', { step: 'console-build', status: 'skip', message: 'No console file changes' });
    }

    // Step 5: Restart fleet server via systemd
    writeSSE('progress', { step: 'restart', status: 'running' });
    execFile('systemctl', ['--user', 'restart', 'whatsoup-fleet'], (err) => {
      if (err) {
        writeSSE('error', {
          step: 'restart',
          message: 'Fleet not managed by systemd. Restart manually: npm run fleet',
        });
      }
      // Always release mutex + end response — on success the process is about
      // to be killed by systemd, but if it survives (e.g. systemd is slow),
      // the endpoint must not stay permanently locked.
      endOnce();
    });
  } catch (err: any) {
    writeSSE('error', { step: 'unknown', message: err.message });
    endOnce();
  }
}
