/**
 * Host adapter for `release:activate`: every effect that reaches outside the
 * filesystem (launchctl, ps, plutil, renderer scripts, process liveness,
 * clocks, the loopback health probe, and the BOT ERRORS alert helper) goes
 * through this seam so tests can
 * drive the whole activation against a real temporary HOME with fakes here.
 *
 * Filesystem effects use node:fs directly against paths derived from `HOME`
 * and the `XDG_*` variables, so tests point those at a temporary tree.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configRoot } from '../../../src/fleet/paths.ts';
import { isRecord } from '../../../src/lib/type-guards.ts';
import { emitReleaseAlert, type ReleaseAlertEmitPayload } from '../live-release-alert.ts';
import { type HealthInvariantsReading, readHealthInvariants } from './invariants.ts';
import { resolveToolCommit, type ToolCommitExec } from './tool-commit.ts';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HealthResponse {
  status: number;
  body: string;
}

export interface ActivationHost {
  platform: NodeJS.Platform;
  uid: number;
  /** Run a program with argv (never a shell string). Non-zero exit is a result, not a throw. */
  exec(file: string, args: readonly string[], options?: { input?: string }): Promise<ExecResult>;
  isProcessAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** GET http://127.0.0.1:<port>/health with the bearer token. */
  fetchHealth(port: number, token: string): Promise<HealthResponse>;
  /**
   * Send one BOT ERRORS event (an alert or its clear) through
   * `emitReleaseAlert` (the release observers' path). Returns the helper's
   * exit status; a spawn that fails outright may throw.
   */
  emitReleaseAlert(request: ReleaseAlertRequest): Promise<{ status: number | null }>;
  /**
   * Commit of the tree this tool runs from (the tree that supplies the
   * invariant floor), or null when it cannot be resolved within
   * `TOOL_COMMIT_TIMEOUT_MS` (see tool-commit.ts).
   */
  toolCommit(): Promise<string | null>;
}

export interface ReleaseAlertRequest {
  instance: string;
  source: string;
  /** `alert` raises the source's event; `clear` resolves it (`bot-errors-emit.py --clear`). */
  eventType: 'alert' | 'clear';
  payload: ReleaseAlertEmitPayload;
  /** Variables set for this helper call only (see `ReleaseAlertEmitOptions.env`). */
  env?: Readonly<Record<string, string>>;
}

const EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 10_000;
/** Body cap of the loopback health read; the same cap as health_reader.py (`read(65537)` / `> 65536`). */
export const HEALTH_MAX_BYTES = 65_536;
/** The activating tool's own tree, which owns the alert helper (not `--release`). */
const TOOL_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function defaultExec(file: string, args: readonly string[], options: { input?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(file, [...args], { maxBuffer: EXEC_MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null
        ? 0
        : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 127;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else: still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultFetchHealth(port: number, token: string): Promise<HealthResponse> {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: '/health',
      headers: { Authorization: `Bearer ${token}` },
      timeout: HEALTH_TIMEOUT_MS,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > HEALTH_MAX_BYTES) {
          request.destroy(new Error('health response exceeds limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('timeout', () => request.destroy(new Error('health request timed out')));
    request.on('error', reject);
  });
}

/** The tool-commit git child: its own timeout, killed outright when it expires. */
const toolCommitExec: ToolCommitExec = (file, args, { env, timeoutMs }) => new Promise((resolve) => {
  execFile(file, [...args], { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: EXEC_MAX_BUFFER, encoding: 'utf8' },
    (error, stdout) => {
      const code = error === null
        ? 0
        : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 127;
      resolve({ code, stdout: String(stdout) });
    });
});

export function createDefaultActivationHost(): ActivationHost {
  return {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    exec: defaultExec,
    isProcessAlive: defaultIsProcessAlive,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
    fetchHealth: defaultFetchHealth,
    emitReleaseAlert: async ({ instance, source, eventType, payload, env }) => {
      const result = emitReleaseAlert({
        repoRoot: TOOL_REPO_ROOT,
        instance,
        source,
        emitHelper: path.join(TOOL_REPO_ROOT, 'deploy/scripts/bot-errors-emit.py'),
        python: 'python3',
        ...(env ? { env } : {}),
      }, payload, eventType);
      return { status: result.status };
    },
    toolCommit: () => resolveToolCommit({ root: TOOL_REPO_ROOT, exec: toolCommitExec }),
  };
}

/**
 * Resolve an instance's health token with the precedence of
 * `deploy/scripts/lib/health_reader.py::instance_health_token`: the
 * per-instance `BOT_ERRORS_HEALTH_TOKEN_<NAME>` override, then the shared
 * `WHATSOUP_HEALTH_TOKEN`, then `WHATSOUP_HEALTH_TOKEN=` in the instance's
 * `tokens.env`. The file lookup honours `XDG_CONFIG_HOME` through
 * `configRoot()`, which is the Python path when that variable is unset.
 *
 * The value is returned to the caller for the Authorization header only; no
 * caller may print, log, or persist it.
 */
export function resolveInstanceHealthToken(
  instance: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const override = env[`BOT_ERRORS_HEALTH_TOKEN_${instance.replace(/-/g, '_').toUpperCase()}`];
  if (override) return override.trim() || null;
  const shared = env['WHATSOUP_HEALTH_TOKEN'];
  if (shared) return shared.trim() || null;
  const tokensPath = path.join(configRoot(), instance, 'tokens.env');
  let text: string;
  try {
    text = readFileSync(tokensPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('WHATSOUP_HEALTH_TOKEN=')) {
      return line.slice('WHATSOUP_HEALTH_TOKEN='.length).trim() || null;
    }
  }
  return null;
}

export type HealthProjection = 'diagnostic' | 'public' | 'unobserved';

export interface HealthObservation {
  projection: HealthProjection;
  httpStatus: number | null;
  commit: string | null;
  connected: boolean | null;
  /** `instance.pid` of the process that served the body (a positive integer), else null. */
  responderPid: number | null;
  /** The #2481 `health_invariants` reading; null unless the body is diagnostic. */
  invariants: HealthInvariantsReading | null;
}

const PUBLIC_HEALTH_SCHEMA_PREFIX = 'health.public.';

/**
 * Classify a health body the way `health_reader.classify_projection` does for
 * a request that carried a token: only a body with a `whatsapp` object and no
 * public schema is `diagnostic`; a public envelope means the token was
 * rejected, and anything else is unobserved. Only a diagnostic body yields
 * commit, connection, and invariant fields.
 */
export function classifyAuthenticatedHealth(status: number | null, body: string): HealthObservation {
  let payload: unknown = null;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  const unobserved: HealthObservation = {
    projection: 'unobserved', httpStatus: status, commit: null, connected: null, responderPid: null, invariants: null,
  };
  if (!isRecord(payload)) return unobserved;
  const schema = payload['schema_version'];
  if (typeof schema === 'string' && schema.startsWith(PUBLIC_HEALTH_SCHEMA_PREFIX)) return unobserved;
  const whatsapp = payload['whatsapp'];
  if (!isRecord(whatsapp)) return unobserved;
  const instance = isRecord(payload['instance']) ? payload['instance'] : {};
  return {
    projection: 'diagnostic',
    httpStatus: status,
    commit: typeof instance['commit'] === 'string' ? instance['commit'] : null,
    connected: typeof whatsapp['connected'] === 'boolean' ? whatsapp['connected'] : null,
    responderPid: Number.isSafeInteger(instance['pid']) && (instance['pid'] as number) > 0 ? instance['pid'] as number : null,
    invariants: readHealthInvariants(payload),
  };
}
