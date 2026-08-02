/**
 * SSE auth-handler for the fleet ops API.
 *
 * Extracted from `src/fleet/routes/ops.ts` (#2239) — the 1415-line god-module
 * mixed this SSE/child-process/service-manager handler with message CRUD,
 * config persistence, and lifecycle orchestration. `handleAuth` owns:
 *   - child-process spawn + JSON-line stdout parsing
 *   - SSE stream protocol writing
 *   - service-manager orchestration (stop-for-auth → spawn → start-after-auth)
 *   - module-level mutable state for concurrent-auth deduplication
 *
 * Re-exported from `ops.ts` as a migration shim so existing callers and tests
 * are unchanged; follow-up slices update imports to point here directly.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { jsonResponse, requireInstance } from '../../lib/http.ts';
import { SIGNAL } from '../../lib/signals.ts';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../../lib/time-units.ts';
import { persistIntroSentFlag } from '../../core/intro-sent-config.ts';
import { createChildLogger } from '../../logger.ts';
import { repoRoot } from '../paths.ts';
import { createSSEWriter } from '../sse-helpers.ts';
import { projectError, serviceActionError } from '../response-error-projection.ts';
import { NAME_MAX_LENGTH, NAME_RE, validateInstanceName } from './instance-name.ts';
import type { OpsDeps } from './ops.ts';

const log = createChildLogger('fleet:ops-auth');

// Active auth processes per instance — prevents duplicate concurrent auth sessions
const activeAuthProcesses = new Map<string, ReturnType<typeof spawn>>();
// In-flight auth operations — prevents concurrent auth requests from racing
const authInFlight = new Set<string>();

// Auth session wall-clock timeout (5 minutes — QR codes expire in ~60s, allows 5 scan attempts)
const AUTH_TIMEOUT_MS = 5 * MS_PER_MINUTE;
// The helper normally exits about two seconds after it persists credentials.
// Keep a short, bounded window so that a hung helper cannot strand its service.
const AUTH_COMPLETION_TIMEOUT_MS = 15 * MS_PER_SECOND;
const ALLOWED_SSE_EVENTS = new Set(['qr', 'connected', 'error']);

/**
 * Explicit allowlist of env vars forwarded to the auth helper subprocess.
 * Mirrors `BASE_ENV_KEYS` in `src/core/mcp-launcher.ts` — the auth helper
 * needs XDG/HOME for config resolution and PATH for binary discovery, but
 * must NOT inherit the full parent env (provider keys, secrets, etc.).
 * `WHATSOUP_*` config overrides are forwarded since they control instance
 * behaviour the auth helper depends on.
 */
const AUTH_HELPER_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
  'NODE_PATH', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TMPDIR',
] as const;

function buildAuthHelperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AUTH_HELPER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Forward WHATSOUP_* config overrides (explicit prefix, not blanket inheritance)
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('WHATSOUP_') && value !== undefined) env[key] = value;
  }
  return env;
}

/** GET /api/lines/:name/auth — SSE stream of QR codes from the auth process. */
export async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  // Prevent concurrent auth requests for the same instance from racing
  if (authInFlight.has(params.name)) {
    jsonResponse(res, 409, { error: 'auth already in progress for this instance' });
    return;
  }
  authInFlight.add(params.name);

  // Kill any existing auth process for this instance before starting a new one
  const existing = activeAuthProcesses.get(params.name);
  if (existing) {
    try { existing.kill(SIGNAL.TERM); } catch { /* already exited: the previous auth process may have exited on its own before this cleanup runs, so kill throwing here is expected and safe to ignore. */ }
    activeAuthProcesses.delete(params.name);
  }

  // SSE headers — write BEFORE stopping the instance to avoid browser timeout
  // during a slow systemd stop (up to TimeoutStopSec=15s)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Attach the SSE error listener before the asynchronous stop preflight. A
  // client can disconnect while that stop is in flight.
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  let stoppedForAuth = false;
  let startupRequested = false;
  let restoreRequested = false;
  let preflightClosed = false;
  const { writeSSE, endOnce } = createSSEWriter(res, () => {
    activeAuthProcesses.delete(params.name);
    authInFlight.delete(params.name);
    if (authTimer) clearTimeout(authTimer);
  });
  const restoreStoppedInstance = (reason: string) => {
    if (!stoppedForAuth || startupRequested || restoreRequested) return;
    restoreRequested = true;
    const onError = (err: Error | null) => {
      if (err) log.error({ err, instance: params.name, reason }, 'post-auth failure restart failed');
    };
    if (deps.serviceManager.startAfterAuthFire) {
      deps.serviceManager.startAfterAuthFire(params.name, onError);
    } else {
      deps.serviceManager.startFire(params.name, onError);
    }
  };
  const onPreflightClose = () => {
    // Keep the in-flight claim until the stop settles, then either restore the
    // prior service or report the failure without writing to the closed stream.
    preflightClosed = true;
  };
  req.once('close', onPreflightClose);

  // Stop the running instance so the lock file is released for auth.
  if (deps.serviceManager.stopForAuth) {
    try {
      stoppedForAuth = (await deps.serviceManager.stopForAuth(params.name)) !== false;
    } catch (err) {
      req.removeListener('close', onPreflightClose);
      log.error({ err, instance: params.name }, 'auth preflight failed to stop existing service');
      if (!preflightClosed) {
        writeSSE('error', { message: 'Unable to stop the existing instance before authentication. Resolve its service state and retry.' });
      }
      endOnce();
      return;
    }
  } else {
    try {
      await deps.serviceManager.stop(params.name);
      stoppedForAuth = true;
    } catch { /* intentional: the service may not be running */ }
  }

  req.removeListener('close', onPreflightClose);
  if (preflightClosed) {
    restoreStoppedInstance('client-close-before-auth-spawn');
    endOnce();
    return;
  }

  // Auth bootstrap is an admin-only operation that needs full environment access
  // for WhatsApp pairing (QR code flow). This is not a user-facing agent session
  // and does not process untrusted input, so full env inheritance is acceptable.
  // Resolve bootstrap-auth against the repo root, not `process.cwd()`.
  // Under systemd the fleet unit ships with no `WorkingDirectory=`, so cwd
  // is the service user's `$HOME` and a relative script path ENOENTs (#419).
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    path.join(repoRoot, 'src', 'bootstrap-auth.ts'),
    params.name,
  ], {
    cwd: repoRoot,
    env: buildAuthHelperEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeAuthProcesses.set(params.name, child);

  // Guard against double res.end() — declared before any event handlers
  let connected = false;
  let terminalFailure = false;

  const startAfterSuccessfulAuth = () => {
    if (startupRequested) return;
    startupRequested = true;
    let activationCompleted = false;
    const onComplete = (err: Error | null) => {
      if (activationCompleted) return;
      activationCompleted = true;
      if (err) {
        terminalFailure = true;
        log.error({ err, instance: params.name }, 'post-auth start failed');
        // The pairing helper has already persisted credentials, but the
        // instance was not activated. Do not expose launchctl details in SSE.
        writeSSE('error', { message: 'Authentication completed but the instance could not start. Please retry or inspect fleet logs.' });
      } else {
        deps.discovery.scan();
        // The helper's internal `connected` signal proves persisted
        // credentials, not a live managed instance. Only report connected to
        // the browser after the helper exits and service activation succeeds.
        writeSSE('connected', {});
      }
      endOnce();
    };
    try {
      if (deps.serviceManager.startAfterAuthFire) {
        deps.serviceManager.startAfterAuthFire(params.name, onComplete);
      } else {
        deps.serviceManager.startFire(params.name, onComplete);
      }
    } catch (error) {
      onComplete(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const armAuthTimeout = (delayMs: number, message: string, reason: string) => {
    if (authTimer) clearTimeout(authTimer);
    authTimer = setTimeout(() => {
      terminalFailure = true;
      writeSSE('error', { message });
      child.kill(SIGNAL.TERM);
      restoreStoppedInstance(reason);
      endOnce();
    }, delayMs);
  };

  // Wall-clock timeout — prevents auth process from hanging forever.
  armAuthTimeout(
    AUTH_TIMEOUT_MS,
    'Authentication timed out. QR codes expire after ~60 seconds. Please retry.',
    'timeout',
  );

  // Parse stdout for JSON events
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (!ALLOWED_SSE_EVENTS.has(evt.event)) continue;
        if (evt.event === 'connected') {
          if (!connected) {
            connected = true;
            armAuthTimeout(
              AUTH_COMPLETION_TIMEOUT_MS,
              'Authentication completed but did not finish. Please retry.',
              'completion-timeout',
            );
            // Reset introSent so the instance sends an introduction on next boot
            try {
              persistIntroSentFlag(instance.configPath, false);
            } catch (err) {
              // Not fatal to the auth flow, but without this warn the operator
              // has no clue why the instance never re-introduced itself.
              log.warn({ err, instance: params.name }, 'introSent reset failed after re-auth; intro will not re-fire on next boot');
            }
          }
          continue;
        }
        writeSSE(evt.event, evt.data ?? {});
      } catch {
        // Intentional: the helper may emit human-readable non-JSON output;
        // only structured SSE events are safe to forward to the browser.
      }
    }
  });

  // Log stderr from auth process for debugging
  child.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log.info({ instance: params.name, stderr: text.slice(0, 200) }, 'auth process stderr');
  });

  // Forward errors
  child.on('error', (err) => {
    terminalFailure = true;
    writeSSE('error', projectError(err, { operation: 'auth', stage: 'execute' }));
    restoreStoppedInstance('child-error');
    endOnce();
  });
  // `exit` can arrive before the final stdout bytes. Wait for `close`, which
  // follows closure of the child's stdio streams, before deciding whether the
  // helper persisted credentials.
  child.on('close', (code) => {
    if (code === 0 && connected && !terminalFailure) {
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      startAfterSuccessfulAuth();
      return;
    } else if (code !== 0) {
      terminalFailure = true;
      writeSSE('error', serviceActionError(new Error(`auth exited with code ${code}`), 'auth', 'auth_failed'));
      restoreStoppedInstance('child-exit');
    }
    endOnce();
  });

  // Cleanup on client disconnect
  req.on('close', () => {
    // Once the helper has emitted the persisted-credential signal, let its
    // short successful completion activate the instance even if the browser
    // closes the SSE stream. Killing it here would strand the booted-out job.
    if (connected && !terminalFailure) return;
    terminalFailure = true;
    child.kill(SIGNAL.TERM);
    setTimeout(() => { try { child.kill(SIGNAL.KILL); } catch { /* already exited: the auth helper may have already exited before this escalation fires, so kill throwing here is expected and safe to ignore. */ } }, 5000);
    endOnce();
  });
}
