import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { jsonResponse } from '../../lib/http.ts';
import { createChildLogger } from '../../logger.ts';
import type { UpdateChecker } from '../update-checker.ts';

const execFileAsync = promisify(execFile);
const log = createChildLogger('fleet:update');

let updateInProgress = false;

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

    // Step 2: Root npm install (if root lockfile changed)
    writeSSE('progress', { step: 'install', status: 'running' });
    try {
      const { stdout: diffOut } = await execFileAsync(
        'git', ['diff', 'HEAD~1', '--name-only'],
        { cwd: repoRoot, timeout: 10_000 },
      );
      if (diffOut.includes('package-lock.json')) {
        await execFileAsync('npm', ['install'], { cwd: repoRoot, timeout: 120_000 });
        writeSSE('progress', { step: 'install', status: 'done' });
      } else {
        writeSSE('progress', { step: 'install', status: 'skip', message: 'No lockfile changes' });
      }
    } catch {
      await execFileAsync('npm', ['install'], { cwd: repoRoot, timeout: 120_000 });
      writeSSE('progress', { step: 'install', status: 'done' });
    }

    // Step 3: Console npm install (if console lockfile changed)
    writeSSE('progress', { step: 'console-install', status: 'running' });
    try {
      const { stdout: diffOut } = await execFileAsync(
        'git', ['diff', 'HEAD~1', '--name-only'],
        { cwd: repoRoot, timeout: 10_000 },
      );
      if (diffOut.includes('console/package-lock.json')) {
        await execFileAsync('npm', ['install'], {
          cwd: `${repoRoot}/console`, timeout: 120_000,
        });
        writeSSE('progress', { step: 'console-install', status: 'done' });
      } else {
        writeSSE('progress', { step: 'console-install', status: 'skip', message: 'No console lockfile changes' });
      }
    } catch {
      await execFileAsync('npm', ['install'], {
        cwd: `${repoRoot}/console`, timeout: 120_000,
      });
      writeSSE('progress', { step: 'console-install', status: 'done' });
    }

    // Step 4: Console rebuild
    writeSSE('progress', { step: 'console-build', status: 'running' });
    try {
      await execFileAsync('npx', ['vite', 'build'], {
        cwd: `${repoRoot}/console`, timeout: 120_000,
      });
      writeSSE('progress', { step: 'console-build', status: 'done' });
    } catch (err: any) {
      writeSSE('error', { step: 'console-build', message: err.stderr?.trim() || err.message });
      endOnce();
      return;
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
