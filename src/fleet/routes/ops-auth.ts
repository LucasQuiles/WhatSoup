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

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

import { jsonResponse, parseQueryString, readBody, requireInstance } from '../../lib/http.ts';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../../lib/time-units.ts';
import { systemClock } from '../../lib/clock.ts';
import { instancePaths } from '../paths.ts';
import { parseAccountScopeId, type AccountScopeIdV1, type PairingErrorClass } from '../../transport/auth-custody-contracts.ts';
import {
  executePairingSaga,
  pairingPreflight,
  readPairingOperationRecord,
  type PairingSagaEffects,
} from '../../transport/pairing-saga.ts';
import {
  acquireCoordinationLease,
  defaultLeaseProbes,
  releaseCoordinationLease,
} from '../../transport/coordination-lease.ts';
import { persistIntroSentFlag } from '../../core/intro-sent-config.ts';
import { createChildLogger } from '../../logger.ts';
import { repoRoot } from '../paths.ts';
import { createSSEWriter } from '../sse-helpers.ts';
import { trackAuthHelper, type AuthHelper } from '../auth-helper.ts';
import { projectError, serviceActionError } from '../response-error-projection.ts';
import { NAME_MAX_LENGTH, NAME_RE, validateInstanceName } from './instance-name.ts';
import type { OpsDeps } from './ops.ts';

const log = createChildLogger('fleet:ops-auth');

// Active auth processes per instance — prevents duplicate concurrent auth sessions
const activeAuthProcesses = new Map<string, AuthHelper>();
// In-flight auth operations — prevents concurrent auth requests from racing
const authInFlight = new Set<string>();

// Auth session wall-clock timeout (5 minutes — QR codes expire in ~60s, allows 5 scan attempts)
const AUTH_TIMEOUT_MS = 5 * MS_PER_MINUTE;
// The helper normally exits about two seconds after it persists credentials.
// Keep a short, bounded window so that a hung helper cannot strand its service.
const AUTH_COMPLETION_TIMEOUT_MS = 15 * MS_PER_SECOND;
const AUTH_ACTIVATION_TIMEOUT_MS = 30 * MS_PER_SECOND;
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
  'NODE_PATH', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMPDIR',
] as const;

function buildAuthHelperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AUTH_HELPER_ENV_KEYS) {
    // env-allowed: deliberate ops-token presence scan over process.env
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Forward WHATSOUP_* config overrides (explicit prefix, not blanket inheritance)
  // env-allowed: deliberate ops-token presence scan over process.env
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

  // Instances with a configured account scope pair ONLY through the explicit,
  // idempotent POST saga (q-canary lane, T5): this legacy SSE route stops the
  // service and pairs into the existing auth directory with no quarantine,
  // exactly the replay surface the saga exists to close.
  const legacyGateScope = readInstanceAccountScope(instance.configPath);
  if (legacyGateScope !== null) {
    jsonResponse(res, 409, {
      error: legacyGateScope === 'malformed'
        ? 'instance accountScopeId is malformed; fix config before pairing'
        : 'this instance requires the pairing saga: POST /api/lines/:name/pairing/preflight then /apply',
    });
    return;
  }

  // Prevent concurrent auth requests for the same instance from racing
  if (authInFlight.has(params.name) || activeAuthProcesses.has(params.name)) {
    jsonResponse(res, 409, { error: 'auth already in progress for this instance' });
    return;
  }
  authInFlight.add(params.name);

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
  let helper: AuthHelper | undefined;
  let streamEnded = false;
  let servicePending = false;
  const releaseIfSettled = () => {
    if (helper?.confirmedClosed && activeAuthProcesses.get(params.name) === helper) activeAuthProcesses.delete(params.name);
    if (streamEnded && !servicePending && (!helper || helper.confirmedClosed)) authInFlight.delete(params.name);
  };
  const { writeSSE, endOnce } = createSSEWriter(res, () => {
    streamEnded = true;
    releaseIfSettled();
    if (authTimer) clearTimeout(authTimer);
  });
  const activateService = (onComplete: (error: Error | null) => void) => {
    servicePending = true;
    let completed = false;
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      log.error({ instance: params.name }, 'Authentication service activation unconfirmed; retain admission until callback settles');
      writeSSE('error', { message: 'Service activation was not confirmed. Inspect the instance service before retrying.' });
      endOnce();
    }, AUTH_ACTIVATION_TIMEOUT_MS);
    const settle = (error: Error | null) => {
      if (completed) return;
      completed = true;
      clearTimeout(deadline);
      servicePending = false;
      if (!expired) onComplete(error);
      else if (error) log.error({ err: error, instance: params.name }, 'Delayed authentication service activation failed');
      releaseIfSettled();
    };
    try {
      if (deps.serviceManager.startAfterAuthFire) deps.serviceManager.startAfterAuthFire(params.name, settle);
      else deps.serviceManager.startFire(params.name, settle);
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const restoreStoppedInstance = (reason: string) => {
    if (!stoppedForAuth || startupRequested || restoreRequested) return;
    restoreRequested = true;
    activateService((err) => {
      if (err) log.error({ err, instance: params.name, reason }, 'post-auth failure restart failed');
    });
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

  // Auth bootstrap is an admin-only operation, but it still receives only the
  // explicit allowlist above plus WHATSOUP_* configuration overrides.
  // Resolve bootstrap-auth against the repo root, not `process.cwd()`.
  // Under systemd the fleet unit ships with no `WorkingDirectory=`, so cwd
  // is the service user's `$HOME` and a relative script path ENOENTs (#419).
  let child: ReturnType<typeof spawn>;
  try { child = spawn(process.execPath, [
    '--experimental-strip-types',
    path.join(repoRoot, 'src', 'bootstrap-auth.ts'),
    params.name,
  ], {
    cwd: repoRoot,
    env: buildAuthHelperEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }); } catch (error) {
    writeSSE('error', projectError(error, { operation: 'auth', stage: 'execute' }));
    restoreStoppedInstance('spawn-rejected');
    endOnce();
    return;
  }
  helper = trackAuthHelper(child);
  activeAuthProcesses.set(params.name, helper);
  void helper.closed.then(releaseIfSettled);

  // Guard against double res.end() — declared before any event handlers
  let connected = false;
  let terminalFailure = false;

  const startAfterSuccessfulAuth = () => {
    if (startupRequested) return;
    startupRequested = true;
    activateService((err) => {
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
    });
  };

  const stopHelper = (reason: string) => {
    void helper!.stop().then((outcome) => {
      if (outcome === 'closed') restoreStoppedInstance(reason);
      else log.error({ instance: params.name, reason }, 'Authentication helper cleanup unconfirmed; inspect the helper before retrying');
      releaseIfSettled();
    });
  };

  const armAuthTimeout = (delayMs: number, message: string, reason: string) => {
    if (authTimer) clearTimeout(authTimer);
    authTimer = setTimeout(() => {
      terminalFailure = true;
      writeSSE('error', { message });
      stopHelper(reason);
      endOnce();
    }, delayMs);
  };

  // Wall-clock timeout — prevents auth process from hanging forever.
  armAuthTimeout(
    AUTH_TIMEOUT_MS,
    'Authentication timed out. Wait for helper cleanup and inspect the instance before retrying.',
    'timeout',
  );

  // Parse stdout for JSON events
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    if (terminalFailure || streamEnded) return;
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
              'Authentication completed but did not finish. Wait for helper cleanup before retrying.',
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
    if (helper!.confirmedClosed) restoreStoppedInstance('child-error');
    else stopHelper('child-error');
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
    } else {
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
    stopHelper('client-close');
    endOnce();
  });
}

// ---------------------------------------------------------------------------
// Pairing saga routes (q-canary lane, T5)
//
// POST /api/lines/:name/pairing/preflight  — side-effect-free typed plan
// POST /api/lines/:name/pairing/apply      — idempotent saga execution
// GET  /api/lines/:name/pairing/status     — plan + operation + last event
//
// These routes exist only for instances with a configured accountScopeId.
// They are explicitly mutating POSTs behind the fleet bearer/ticket gate;
// as CSRF defense they additionally require header-borne credentials (no
// cookie-only acceptance) and reject cross-site fetch metadata. Shared
// bearer possession authenticates the CALLER, not a named human — the
// authorizationId in the apply body is the operator-supplied authorization
// record, threaded into the durable operation journal.
// ---------------------------------------------------------------------------

/** Last pairing helper event per instance, served via the status route. */
const lastPairingEvents = new Map<string, { event: string; data: string | null; at: string }>();

function readInstanceAccountScope(configPath: string): AccountScopeIdV1 | null | 'malformed' {
  // Absent or unparseable config reads as NO scope: legacy instances predate
  // the field and discovery already owns config-error reporting. Only a
  // present-but-invalid value is 'malformed' (fail closed on the value, not
  // on unrelated read failures).
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // intentional: absent or unparseable config reads as no scope - legacy
    // instances predate the field and discovery owns config-error reporting.
    return null;
  }
  const raw = parsed.accountScopeId;
  if (raw === undefined || raw === null) return null;
  const scope = parseAccountScopeId(raw);
  return scope === null ? 'malformed' : scope;
}

function rejectNonHeaderAuthOrCrossSite(req: IncomingMessage, res: ServerResponse): boolean {
  const authorization = req.headers.authorization ?? '';
  if (!authorization.startsWith('Bearer ')) {
    jsonResponse(res, 401, { error: 'pairing routes require header-borne Bearer credentials' });
    return false;
  }
  // The global gate accepts a legacy ?token= query credential; a Bearer-shaped
  // header alone does not prove the header is what authenticated. Refuse the
  // URL-borne form outright so these mutations cannot ride a loggable token.
  const query = parseQueryString(req.url);
  if (typeof query.token === 'string') {
    jsonResponse(res, 403, { error: 'pairing routes refuse URL-borne token credentials; use the Authorization header' });
    return false;
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite === 'cross-site') {
    jsonResponse(res, 403, { error: 'cross-site pairing requests are refused' });
    return false;
  }
  return true;
}

function pairingPathsFor(instance: { name: string; stateRoot: string }): { stateRoot: string; authDir: string } {
  return { stateRoot: instance.stateRoot, authDir: instancePaths(instance.name).authDir };
}

/** POST /api/lines/:name/pairing/preflight */
export async function handlePairingPreflight(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!rejectNonHeaderAuthOrCrossSite(req, res)) return;
  const scope = readInstanceAccountScope(instance.configPath);
  if (scope === 'malformed') {
    jsonResponse(res, 500, { error: 'instance accountScopeId is malformed; fix config before pairing' });
    return;
  }
  if (scope === null) {
    jsonResponse(res, 409, { error: 'pairing saga requires a configured accountScopeId; legacy instances use the SSE auth flow' });
    return;
  }
  jsonResponse(res, 200, {
    scopeId: scope,
    plan: pairingPreflight(pairingPathsFor(instance)),
  });
}

/** GET /api/lines/:name/pairing/status */
export async function handlePairingStatus(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!rejectNonHeaderAuthOrCrossSite(req, res)) return;
  const scope = readInstanceAccountScope(instance.configPath);
  if (scope === null || scope === 'malformed') {
    jsonResponse(res, 409, { error: 'pairing status exists only for accountScopeId-configured instances' });
    return;
  }
  const qs = parseQueryString(req.url);
  const paths = pairingPathsFor(instance);
  const operation = typeof qs.idempotencyKey === 'string' && qs.idempotencyKey.length > 0
    ? readPairingOperationRecord(paths.stateRoot, qs.idempotencyKey)
    : null;
  jsonResponse(res, 200, {
    scopeId: scope,
    plan: pairingPreflight(paths),
    operation: operation === null
      ? null
      : operation === 'journal_unreadable'
        ? { state: 'journal_unreadable' }
        : { state: operation.operation.state, generationId: operation.generationId, custody: operation.custody },
    lastEvent: lastPairingEvents.get(params.name) ?? null,
  });
}

/** POST /api/lines/:name/pairing/apply */
export async function handlePairingApply(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!rejectNonHeaderAuthOrCrossSite(req, res)) return;
  const scope = readInstanceAccountScope(instance.configPath);
  if (scope === 'malformed') {
    jsonResponse(res, 500, { error: 'instance accountScopeId is malformed; fix config before pairing' });
    return;
  }
  if (scope === null) {
    jsonResponse(res, 409, { error: 'pairing saga requires a configured accountScopeId; legacy instances use the SSE auth flow' });
    return;
  }
  // Reserve the in-flight slot in the same synchronous section as the check:
  // an `await` between has() and add() would let two concurrent applies both
  // pass the guard and run sagas concurrently.
  if (authInFlight.has(params.name) || activeAuthProcesses.has(params.name)) {
    jsonResponse(res, 409, { error: 'auth already in progress for this instance' });
    return;
  }
  authInFlight.add(params.name);
  try {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      jsonResponse(res, 400, { error: 'apply requires a JSON body' });
      return;
    }
    const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.length > 0 ? body.idempotencyKey : null;
    const authorizationId = typeof body.authorizationId === 'string' && body.authorizationId.length > 0 ? body.authorizationId : null;
    const method = body.method === 'qr' || body.method === 'pairing_code' ? body.method : null;
    const expectedLatchRevision = typeof body.expectedLatchRevision === 'number' && Number.isInteger(body.expectedLatchRevision) && body.expectedLatchRevision >= 0
      ? body.expectedLatchRevision
      : null;
    const expectedCurrentGenerationId = body.expectedCurrentGenerationId === null || body.expectedCurrentGenerationId === undefined
      ? null
      : typeof body.expectedCurrentGenerationId === 'string' && body.expectedCurrentGenerationId.length > 0
        ? body.expectedCurrentGenerationId
        : undefined;
    if (idempotencyKey === null || authorizationId === null || method === null || expectedLatchRevision === null || expectedCurrentGenerationId === undefined) {
      jsonResponse(res, 400, { error: 'apply requires idempotencyKey, authorizationId, method (qr|pairing_code), expectedLatchRevision, and expectedCurrentGenerationId (string or null)' });
      return;
    }

    const paths = pairingPathsFor(instance);
    const outcome = await executePairingSaga(
      {
        idempotencyKey,
        host: hostname(),
        instance: params.name,
        scopeId: scope,
        expectedCurrentGenerationId,
        expectedLatchRevision,
        method,
        authorizationId,
        actorOperationId: null,
        startService: body.startService === true,
      },
      paths,
      buildSagaEffects(params.name, deps, paths, scope),
    );
    jsonResponse(res, outcome.ok ? 200 : 409, outcome);
  } catch (err) {
    log.error({ err, instance: params.name }, 'pairing apply crashed');
    jsonResponse(res, 500, projectError(err, { operation: 'auth', stage: 'execute' }));
  } finally {
    authInFlight.delete(params.name);
  }
}

// Exported for focused effect-level tests (the spawn/service-control seams are
// otherwise only reachable through a live pairing).
export function buildSagaEffects(
  name: string,
  deps: OpsDeps,
  paths: { stateRoot: string; authDir: string },
  scope: AccountScopeIdV1,
): PairingSagaEffects {
  return {
    nowMs: () => systemClock.now(),
    stopService: async () => {
      try {
        if (deps.serviceManager.stopForAuth) {
          return (await deps.serviceManager.stopForAuth(name)) !== false;
        }
        await deps.serviceManager.stop(name);
        return true;
      } catch {
        // intentional: a failed stop maps to the saga's closed
        // service_stop_unverified refusal rather than an exception.
        return false;
      }
    },
    startService: () =>
      new Promise<boolean>(resolve => {
        const onError = (err: Error | null) => resolve(err === null);
        if (deps.serviceManager.startAfterAuthFire) {
          deps.serviceManager.startAfterAuthFire(name, onError);
        } else {
          deps.serviceManager.startFire(name, onError);
        }
      }),
    acquireLease: operationId =>
      acquireCoordinationLease({
        stateRoot: paths.stateRoot,
        scopeId: scope,
        operationId,
        mode: 'pairing',
        ttlMs: 10 * MS_PER_MINUTE,
        probes: defaultLeaseProbes(),
      }),
    releaseLease: lease => {
      releaseCoordinationLease({ stateRoot: paths.stateRoot, scopeId: scope, lease });
    },
    runPairingHelper: input =>
      new Promise(resolve => {
        const env = buildAuthHelperEnv();
        // Delegated lease handoff (T4.3): the coordinator owns the lease; the
        // helper adopts exactly this lease instead of acquiring its own.
        env.WHATSOUP_PAIRING_LEASE_OP = input.lease.operationId;
        env.WHATSOUP_PAIRING_LEASE_FENCING = String(input.lease.fencingToken);
        // A stale 'connected' from a PREVIOUS helper run must never validate
        // this one's exit; success evidence starts empty for every run.
        lastPairingEvents.delete(name);
        let child: ReturnType<typeof spawn>;
        try { child = spawn(process.execPath, [
          '--experimental-strip-types',
          path.join(repoRoot, 'src', 'bootstrap-auth.ts'),
          name,
        ], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch {
          resolve({ ok: false, errorClass: 'unknown' });
          return;
        }
        const helper = trackAuthHelper(child);
        activeAuthProcesses.set(name, helper);
        let releaseOnClose = false;
        void helper.closed.then(() => {
          if (activeAuthProcesses.get(name) === helper) activeAuthProcesses.delete(name);
          if (releaseOnClose) {
            let released = false;
            try {
              const result = releaseCoordinationLease({ stateRoot: paths.stateRoot, scopeId: scope, lease: input.lease });
              released = result.ok;
              if (!result.ok) log.error({ instance: name, refusal: result.refusal }, 'Pairing helper closed but lease release was refused');
            } catch (err) {
              log.error({ err, instance: name }, 'Pairing helper closed but lease release failed');
            }
            lastPairingEvents.set(name, { event: released ? 'cleanup_confirmed' : 'cleanup_release_unconfirmed', data: null, at: new Date(systemClock.now()).toISOString() });
          }
        });

        let settled = false;
        let forcedFailure: PairingErrorClass | undefined;
        const settle = (result: { ok: true } | { ok: false; errorClass: PairingErrorClass; cleanupUnconfirmed?: true }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const stopHelper = (errorClass: PairingErrorClass) => {
          forcedFailure ??= errorClass;
          void helper.stop().then(() => {
            if (settled) return;
            releaseOnClose = !helper.confirmedClosed;
            if (releaseOnClose) {
              lastPairingEvents.set(name, { event: 'cleanup_unconfirmed', data: null, at: new Date(systemClock.now()).toISOString() });
            }
            settle({ ok: false, errorClass: forcedFailure!, ...(releaseOnClose ? { cleanupUnconfirmed: true } : {}) });
          });
        };
        const timer = setTimeout(() => stopHelper('pairing_timeout'), AUTH_TIMEOUT_MS);

        let stdoutBuffer = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          if (settled || forcedFailure) return;
          stdoutBuffer += chunk.toString('utf-8');
          let newlineAt = stdoutBuffer.indexOf('\n');
          while (newlineAt !== -1) {
            const line = stdoutBuffer.slice(0, newlineAt).trim();
            stdoutBuffer = stdoutBuffer.slice(newlineAt + 1);
            newlineAt = stdoutBuffer.indexOf('\n');
            if (line.length === 0) continue;
            try {
              const parsed = JSON.parse(line) as { event?: string; data?: string; code?: string };
              if (parsed.event === 'qr' && typeof parsed.data === 'string') {
                lastPairingEvents.set(name, { event: 'qr', data: parsed.data, at: new Date(systemClock.now()).toISOString() });
              } else if (parsed.event === 'pairing_code' && typeof parsed.code === 'string') {
                lastPairingEvents.set(name, { event: 'pairing_code', data: parsed.code, at: new Date(systemClock.now()).toISOString() });
              } else if (parsed.event === 'connected') {
                lastPairingEvents.set(name, { event: 'connected', data: null, at: new Date(systemClock.now()).toISOString() });
              }
            } catch {
              // by design: non-JSON stdout noise from the helper is ignored -
              // only the typed qr/pairing_code/connected events matter here.
            }
          }
        });
        // Drain stderr: the helper logs freely there, and an unread pipe
        // eventually blocks the child on backpressure until the timeout kills
        // a pairing that was otherwise proceeding.
        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8').trim();
          if (text) log.info({ instance: name, stderr: text.slice(0, 200) }, 'pairing helper stderr');
        });
        child.on('close', code => {
          const last = lastPairingEvents.get(name);
          if (forcedFailure) {
            settle({ ok: false, errorClass: forcedFailure });
          } else if (last?.event === 'connected' && code === 0) {
            settle({ ok: true });
          } else {
            settle({ ok: false, errorClass: code === 0 ? 'pairing_rejected' : 'unknown' });
          }
        });
        child.on('error', () => {
          if (helper.confirmedClosed) settle({ ok: false, errorClass: 'unknown' });
          else stopHelper('unknown');
        });
      }),
  };
}
