// src/fleet/routes/credentials.ts
//
// Fleet-level provider-credential management: PUT (set/rotate), DELETE,
// POST verify. Fleet-scoped — keychain entries are per-OS-user, machine-wide;
// a per-line route would imply isolation that does not exist. Sits behind the
// fleet Bearer/auth-ticket layer like every other mutating /api route.
//
// INVARIANTS (tested):
//  - no read-back: GET is an explicit 405; no handler returns a key value.
//  - the value never reaches a logger: keyring errors arrive pre-sanitized
//    (KeyringWriteError) and handlers never construct errors from the value.
//  - allowlist is the compile-time closed set below — the catalog references
//    it (cross-check test), never the reverse.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse, readBody } from '../../lib/http.ts';
import {
  writeCredential,
  deleteCredential,
  lookupCredential,
  KeyringWriteError,
  SERVICE_ENV_MAP,
  resolveProviderKeyService,
} from '../../lib/keyring.ts';
import { PROVIDER_VERIFY_DESCRIPTORS } from './providers.ts';

/**
 * Default closed set of writable keyring services. Operators extend it per
 * deployment via fleet config `extraCredentialServices` (see
 * `effectiveAllowlist`) — never via a request.
 */
export const CREDENTIAL_ALLOWLIST: ReadonlySet<string> = new Set([
  'deepseek',
  'minimax',
  'openai',
  'anthropic',
]);

let _extraServices: ReadonlySet<string> = new Set();

const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Install operator-declared extra services from fleet config. Entries failing
 * the charset rule or colliding with the blocklist are dropped with a WARN at
 * config-load time (caller logs). Called once at server startup.
 */
export function setExtraCredentialServices(services: readonly string[]): string[] {
  const rejected: string[] = [];
  const accepted = new Set<string>();
  for (const s of services) {
    if (SERVICE_NAME_RE.test(s) && !CREDENTIAL_WRITE_BLOCKLIST.has(s)) accepted.add(s);
    else rejected.push(s);
  }
  _extraServices = accepted;
  return rejected;
}

function allowlisted(service: string): boolean {
  return CREDENTIAL_ALLOWLIST.has(service) || _extraServices.has(service);
}

/**
 * Never writable regardless of catalog state — the health token gates the
 * fleet API itself; an API that can rewrite its own auth gate is an
 * escalation primitive.
 */
export const CREDENTIAL_WRITE_BLOCKLIST: ReadonlySet<string> = new Set([
  'whatsoup-health-token',
  'whatsoup_health',
]);

const MAX_VALUE_BYTES = 4096;

/**
 * Per-process, per-service cooldown shared by the mutating handlers (PUT/DELETE).
 * `writeCredential`/`deleteCredential` shell out via `execFileSync` (see
 * lib/keyring.ts) — a synchronous, blocking call on the request path. A caller
 * that hammers these endpoints can starve the event loop (sync-DoS), so we bound
 * how often the sync-exec path is entered. The cooldown arms UNCONDITIONALLY once
 * the request passes validation, before the keyring is touched.
 */
const MUTATION_COOLDOWN_MS = 1_000;
const mutationLastCall = new Map<string, number>();

/** Test hook — clear mutation cooldowns between cases. */
export function _resetMutationCooldownsForTests(): void {
  mutationLastCall.clear();
}

/**
 * Returns true and writes a 429 if `service` is still cooling down; otherwise
 * arms the cooldown and returns false. Arming is unconditional on the accepted
 * path so even no-op outcomes (absent key, failed write) are throttled.
 */
function throttle(
  res: ServerResponse,
  store: Map<string, number>,
  cooldownMs: number,
  service: string,
  errorLabel: string,
): boolean {
  const last = store.get(service);
  const now = Date.now();
  if (last !== undefined && now - last < cooldownMs) {
    jsonResponse(res, 429, { error: errorLabel, retryAfter: Math.ceil((cooldownMs - (now - last)) / 1000) });
    return true;
  }
  store.set(service, now);
  return false;
}

interface ServiceCheck { ok: true; service: string }
interface ServiceCheckFail { ok: false }

/** Shared validation chain: charset → blocklist → allowlist. Writes the error response itself. */
function checkService(res: ServerResponse, raw: string | undefined): ServiceCheck | ServiceCheckFail {
  const service = raw ?? '';
  if (!SERVICE_NAME_RE.test(service)) {
    jsonResponse(res, 400, { error: 'invalid service name' });
    return { ok: false };
  }
  if (CREDENTIAL_WRITE_BLOCKLIST.has(service)) {
    jsonResponse(res, 403, { error: 'service is not writable' });
    return { ok: false };
  }
  if (!allowlisted(service)) {
    jsonResponse(res, 404, { error: 'unknown credential service' });
    return { ok: false };
  }
  return { ok: true, service };
}

function envShadowed(service: string): boolean {
  const envKey = SERVICE_ENV_MAP[service];
  return envKey !== undefined && Boolean(process.env[envKey]);
}

function keyringErrorStatus(code: KeyringWriteError['code']): number {
  return code === 'KEYRING_LOCKED' ? 503 : code === 'KEYRING_WRITE_UNSUPPORTED' ? 501 : 500;
}

/** PUT /api/credentials/:service — set or rotate a provider key. No read-back. */
export async function handlePutCredential(
  req: IncomingMessage,
  res: ServerResponse,
  params: { name?: string },
): Promise<void> {
  const check = checkService(res, params.name);
  if (!check.ok) return;
  const { service } = check;

  if (throttle(res, mutationLastCall, MUTATION_COOLDOWN_MS, service, 'mutation cooldown')) return;

  let value: unknown;
  try {
    value = (JSON.parse((await readBody(req, MAX_VALUE_BYTES * 2)) || '{}') as { value?: unknown }).value;
  } catch {
    jsonResponse(res, 400, { error: 'invalid JSON body' });
    return;
  }
  if (typeof value !== 'string') {
    jsonResponse(res, 400, { error: 'body must be {"value": string}' });
    return;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    Buffer.byteLength(trimmed) > MAX_VALUE_BYTES ||
    /[\r\n]/.test(trimmed)
  ) {
    jsonResponse(res, 400, { error: 'value must be a non-empty single-line string of at most 4096 bytes' });
    return;
  }

  try {
    const { backend } = writeCredential(service, trimmed);
    jsonResponse(res, 200, { ok: true, service, backend, envShadowed: envShadowed(service) });
  } catch (err) {
    if (err instanceof KeyringWriteError) {
      // KeyringWriteError is sanitized at construction — safe to surface.
      jsonResponse(res, keyringErrorStatus(err.code), { error: err.message, code: err.code });
      return;
    }
    jsonResponse(res, 500, { error: 'credential write failed', code: 'KEYRING_WRITE_FAILED' });
  }
}

/** Minimal slice of discovery the DELETE handler needs (test-injectable). */
export interface CredentialDeps {
  instances: Array<{
    name: string;
    agentOptions?: {
      provider?: string;
      model?: string;
      fallbackProvider?: string;
      fallbackModel?: string;
    };
  }>;
}

function serviceInUse(deps: CredentialDeps, service: string): boolean {
  return deps.instances.some((inst) => {
    const ao = inst.agentOptions ?? {};
    return (
      resolveProviderKeyService(ao.provider, ao.model) === service ||
      resolveProviderKeyService(ao.fallbackProvider, ao.fallbackModel) === service
    );
  });
}

/** DELETE /api/credentials/:service — remove a stored key. */
export async function handleDeleteCredential(
  _req: IncomingMessage,
  res: ServerResponse,
  params: { name?: string },
  deps: CredentialDeps,
): Promise<void> {
  const check = checkService(res, params.name);
  if (!check.ok) return;
  const { service } = check;
  if (throttle(res, mutationLastCall, MUTATION_COOLDOWN_MS, service, 'mutation cooldown')) return;
  const { deleted, reason, errorCode } = deleteCredential(service);
  const body = { ok: deleted, service, envShadowed: envShadowed(service), inUse: serviceInUse(deps, service) };
  if (reason === 'backend_failed') {
    // A store that could not be consulted is NOT a 404. Reporting "not found"
    // here told an operator with a locked keychain that the credential did not
    // exist, while it remained stored and readable (#2292 L8).
    jsonResponse(res, 500, { ...body, error: 'credential store unavailable', errorCode });
    return;
  }
  jsonResponse(res, deleted ? 200 : 404, body);
}

/** GET /api/credentials/:service — explicit 405: credentials are write-only. */
export function handleGetCredential(_req: IncomingMessage, res: ServerResponse): void {
  jsonResponse(res, 405, { error: 'credentials are write-only' });
}

const VERIFY_COOLDOWN_MS = 10_000;
const VERIFY_TIMEOUT_MS = 5_000;
const verifyLastCall = new Map<string, number>();

/** Test hook — clear verify cooldowns between cases. */
export function _resetVerifyCooldownsForTests(): void {
  verifyLastCall.clear();
}

/**
 * POST /api/credentials/:service/verify — one live list-models call.
 * Key resolved via the keyring only; the request never carries one.
 * Cooldown keeps this from being a billing-DoS / key-probing oracle.
 */
export async function handleVerifyCredential(
  _req: IncomingMessage,
  res: ServerResponse,
  params: { name?: string },
): Promise<void> {
  const check = checkService(res, params.name);
  if (!check.ok) return;
  const { service } = check;

  // Arm the cooldown UNCONDITIONALLY, before the keyring lookup. The absent-key
  // (404) and unsupported-descriptor (200) paths must throttle too, otherwise
  // verify is a key-presence oracle a caller can probe at unlimited rate.
  if (throttle(res, verifyLastCall, VERIFY_COOLDOWN_MS, service, 'verify cooldown')) return;

  const key = lookupCredential(service);
  if (key === null) {
    jsonResponse(res, 404, { error: 'no key stored for service', service });
    return;
  }

  const descriptor = PROVIDER_VERIFY_DESCRIPTORS[service];
  if (!descriptor) {
    jsonResponse(res, 200, { ok: true, service, status: 'unsupported', envShadowed: envShadowed(service) });
    return;
  }

  // Typed auth scheme — header construction never interpolates free-form config.
  const headers: Record<string, string> = { ...descriptor.extraHeaders };
  if (descriptor.auth === 'bearer') headers.Authorization = `Bearer ${key}`;
  else headers['x-api-key'] = key;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  let status: 'valid' | 'invalid' | 'unreachable';
  try {
    const init: Parameters<typeof fetch>[1] = {
      method: descriptor.method,
      headers,
      signal: controller.signal,
      redirect: 'error',
    };
    if (descriptor.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(descriptor.body);
    }
    const resp = await fetch(descriptor.url, init);
    status = resp.status >= 200 && resp.status < 300 ? 'valid' : resp.status === 401 || resp.status === 403 ? 'invalid' : 'unreachable';
  } catch {
    status = 'unreachable';
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  jsonResponse(res, 200, { ok: status === 'valid', service, status, envShadowed: envShadowed(service) });
}
