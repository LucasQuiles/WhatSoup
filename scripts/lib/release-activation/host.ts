/**
 * Host adapter for `release:activate`: every effect that reaches outside the
 * filesystem (launchctl, ps, plutil, renderer scripts, process liveness,
 * clocks, and the loopback health probe) goes through this seam so tests can
 * drive the whole activation against a real temporary HOME with fakes here.
 *
 * Filesystem effects use node:fs directly against paths derived from `HOME`
 * and the `XDG_*` variables, so tests point those at a temporary tree.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { configRoot } from '../../../src/fleet/paths.ts';

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
}

const EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_MAX_BYTES = 65_536;

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

export function createDefaultActivationHost(): ActivationHost {
  return {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    exec: defaultExec,
    isProcessAlive: defaultIsProcessAlive,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
    fetchHealth: defaultFetchHealth,
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
}

const PUBLIC_HEALTH_SCHEMA_PREFIX = 'health.public.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Classify a health body the way `health_reader.classify_projection` does for
 * a request that carried a token: only a body with a `whatsapp` object and no
 * public schema is `diagnostic`; a public envelope means the token was
 * rejected, and anything else is unobserved. Only a diagnostic body yields
 * commit and connection fields.
 */
export function classifyAuthenticatedHealth(status: number | null, body: string): HealthObservation {
  let payload: unknown = null;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  const unobserved: HealthObservation = { projection: 'unobserved', httpStatus: status, commit: null, connected: null };
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
  };
}
