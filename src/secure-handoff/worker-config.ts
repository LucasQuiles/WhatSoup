import { isRecord } from '../lib/type-guards.ts';
import { isExactPinnedHost, PROTECTED_DELIVERY_PINS, type ProtectedDeliveryPins } from '../core/protected-delivery-pins.ts';

const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const RESERVED_ENV = /^LINKS_MANAGED_[A-Z0-9_]{1,96}$/;
const MAX_TEXT_BYTES = 256;

export const MANAGED_TRANSPORT_TOKEN_ENV = 'LINKS_MANAGED_TRANSPORT_TOKEN';
export const MANAGED_CONSUMER_TOKEN_ENV = 'LINKS_MANAGED_CONSUMER_TOKEN';
/**
 * The consumer API is served from the managed link service, so its host must
 * be a hash-pinned canonical link host (owner ruling: source keeps only the
 * SHA-256 pins; the real host lives in the administrator's worker config).
 */
export const MANAGED_LINKS_API_PATH = '/s/api/v1';

export type FixedSaveStoreConfig = Readonly<{
  name: string;
  endpoint: string;
  authorizationEnv: string;
}>;

type AdapterBinding = Readonly<{
  resourceId: string;
  principal: string;
  action: string;
  endpoint: string;
}>;

export type FixedPasswordAdapterConfig = AdapterBinding & Readonly<{
  kind: 'password';
  username: string;
  saveStore?: FixedSaveStoreConfig;
}>;

export type FixedTokenAdapterConfig = AdapterBinding & Readonly<{
  kind: 'token';
  saveStore?: FixedSaveStoreConfig;
}>;

export type FixedMfaAdapterConfig = AdapterBinding & Readonly<{
  kind: 'mfa';
  username: string;
  operationId: string;
}>;

export type FixedAdapterConfig = FixedPasswordAdapterConfig | FixedTokenAdapterConfig | FixedMfaAdapterConfig;

/** Non-secret, administrator-owned startup configuration for the consumer worker. */
export type SecureHandoffWorkerConfig = Readonly<{
  databasePath: string;
  linksBaseUrl: string;
  pollIntervalMs: number;
  adapters: readonly FixedAdapterConfig[];
}>;

/**
 * Parses the only JSON shape accepted by the worker; runtime rows cannot add targets or operations.
 * Production callers use the default pins; only tests pass their own.
 */
export function parseSecureHandoffWorkerConfig(
  value: unknown,
  pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS,
): SecureHandoffWorkerConfig {
  if (!isRecord(value) || !exactKeys(value, ['databasePath', 'linksBaseUrl', 'pollIntervalMs', 'adapters'])
    || !validPath(value.databasePath) || !validLinksBase(value.linksBaseUrl, pins)
    || typeof value.pollIntervalMs !== 'number' || !Number.isInteger(value.pollIntervalMs)
    || value.pollIntervalMs < 1_000 || value.pollIntervalMs > 3_600_000
    || !Array.isArray(value.adapters) || value.adapters.length === 0 || value.adapters.length > 100) {
    throw new Error('secure handoff worker configuration is invalid');
  }
  const adapters = value.adapters.map(parseAdapter);
  if (new Set(adapters.map((adapter) => adapter.resourceId)).size !== adapters.length) {
    throw new Error('secure handoff worker configuration is invalid');
  }
  return Object.freeze({
    databasePath: value.databasePath,
    linksBaseUrl: canonicalUrl(value.linksBaseUrl),
    pollIntervalMs: value.pollIntervalMs,
    adapters: Object.freeze(adapters),
  });
}

function parseAdapter(value: unknown): FixedAdapterConfig {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('secure handoff worker configuration is invalid');
  if (value.kind === 'password' && exactKeys(value, ['kind', 'resourceId', 'principal', 'action', 'endpoint', 'username'])) {
    return password(value, undefined);
  }
  if (value.kind === 'password' && exactKeys(value, ['kind', 'resourceId', 'principal', 'action', 'endpoint', 'username', 'saveStore'])) {
    return password(value, parseSaveStore(value.saveStore));
  }
  if (value.kind === 'token' && exactKeys(value, ['kind', 'resourceId', 'principal', 'action', 'endpoint'])) {
    return token(value, undefined);
  }
  if (value.kind === 'token' && exactKeys(value, ['kind', 'resourceId', 'principal', 'action', 'endpoint', 'saveStore'])) {
    return token(value, parseSaveStore(value.saveStore));
  }
  if (value.kind === 'mfa' && exactKeys(value, ['kind', 'resourceId', 'principal', 'action', 'endpoint', 'username', 'operationId'])) {
    return mfa(value);
  }
  throw new Error('secure handoff worker configuration is invalid');
}

function password(value: Record<string, unknown>, saveStore: FixedSaveStoreConfig | undefined): FixedPasswordAdapterConfig {
  if (!validBinding(value) || !validText(value.username)) throw new Error('secure handoff worker configuration is invalid');
  return Object.freeze({ kind: 'password', resourceId: value.resourceId, principal: value.principal, action: value.action,
    endpoint: canonicalUrl(value.endpoint), username: value.username, ...(saveStore === undefined ? {} : { saveStore }) });
}

function token(value: Record<string, unknown>, saveStore: FixedSaveStoreConfig | undefined): FixedTokenAdapterConfig {
  if (!validBinding(value)) throw new Error('secure handoff worker configuration is invalid');
  return Object.freeze({ kind: 'token', resourceId: value.resourceId, principal: value.principal, action: value.action,
    endpoint: canonicalUrl(value.endpoint), ...(saveStore === undefined ? {} : { saveStore }) });
}

function mfa(value: Record<string, unknown>): FixedMfaAdapterConfig {
  if (!validBinding(value) || !validText(value.username) || !validOperationId(value.operationId)) {
    throw new Error('secure handoff worker configuration is invalid');
  }
  return Object.freeze({ kind: 'mfa', resourceId: value.resourceId, principal: value.principal, action: value.action,
    endpoint: canonicalUrl(value.endpoint), username: value.username, operationId: value.operationId });
}

function parseSaveStore(value: unknown): FixedSaveStoreConfig {
  if (!isRecord(value) || !exactKeys(value, ['name', 'endpoint', 'authorizationEnv'])
    || typeof value.name !== 'string' || !RESOURCE_ID.test(value.name)
    || !validHttpsUrl(value.endpoint) || typeof value.authorizationEnv !== 'string' || !RESERVED_ENV.test(value.authorizationEnv)
    || value.authorizationEnv === MANAGED_TRANSPORT_TOKEN_ENV || value.authorizationEnv === MANAGED_CONSUMER_TOKEN_ENV) {
    throw new Error('secure handoff worker configuration is invalid');
  }
  return Object.freeze({ name: value.name, endpoint: canonicalUrl(value.endpoint), authorizationEnv: value.authorizationEnv });
}

function validBinding(value: Record<string, unknown>): value is Record<string, string> {
  return typeof value.resourceId === 'string' && RESOURCE_ID.test(value.resourceId)
    && validText(value.principal) && validText(value.action) && typeof value.endpoint === 'string' && validHttpsUrl(value.endpoint);
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 4_096 && !value.includes('\u0000');
}

// The URL-normalized form must be exactly `https://<host>/s/api/v1` (default
// port, no credentials, query or fragment), and its host, spelled exactly in
// normalized form, must be a pinned canonical link host. This accepts the same
// spellings as the former literal comparison and refuses every other host.
function validLinksBase(value: unknown, pins: ProtectedDeliveryPins): value is string {
  if (typeof value !== 'string' || !validHttpsUrl(value)) return false;
  const canonical = canonicalUrl(value);
  const { hostname } = new URL(canonical);
  return canonical === `https://${hostname}${MANAGED_LINKS_API_PATH}`
    && isExactPinnedHost(hostname, pins.canonicalLinkHostSha256);
}

function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function canonicalUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, '');
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && new TextEncoder().encode(value).byteLength >= 1
    && new TextEncoder().encode(value).byteLength <= MAX_TEXT_BYTES && !/[\u0000-\u001F\u007F]/.test(value);
}

function validOperationId(value: unknown): value is string {
  return validText(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}
