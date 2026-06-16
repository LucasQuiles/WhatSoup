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
  const { deleted } = deleteCredential(service);
  const body = { ok: deleted, service, envShadowed: envShadowed(service), inUse: serviceInUse(deps, service) };
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

  const last = verifyLastCall.get(service);
  const now = Date.now();
  if (last !== undefined && now - last < VERIFY_COOLDOWN_MS) {
    jsonResponse(res, 429, { error: 'verify cooldown', retryAfter: Math.ceil((VERIFY_COOLDOWN_MS - (now - last)) / 1000) });
    return;
  }

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

  verifyLastCall.set(service, now);
  // Typed auth scheme — header construction never interpolates free-form config.
  const headers: Record<string, string> = { ...descriptor.extraHeaders };
  if (descriptor.auth === 'bearer') headers.Authorization = `Bearer ${key}`;
  else headers['x-api-key'] = key;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  let status: 'valid' | 'invalid' | 'unreachable';
  try {
    const resp = await fetch(descriptor.url, { method: 'GET', headers, signal: controller.signal });
    status = resp.status >= 200 && resp.status < 300 ? 'valid' : resp.status === 401 || resp.status === 403 ? 'invalid' : 'unreachable';
  } catch {
    status = 'unreachable';
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  jsonResponse(res, 200, { ok: status === 'valid', service, status, envShadowed: envShadowed(service) });
}
