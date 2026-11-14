import { isRecord } from '../lib/type-guards.ts';
import { normalizeFallbackEntriesFromAgentOptions } from './fallback-chain.ts';
import { isExactPinnedHost, PROTECTED_DELIVERY_PINS, type ProtectedDeliveryPins } from './protected-delivery-pins.ts';

export interface ProtectedDeliveryConfig {
  baseUrl: string;
  /** Resolved at process configuration load; never included in a tool declaration or response. */
  token: string;
  /**
   * Optional link hosts from the private instance configuration. Every entry is
   * a hash-pinned approved host; when present, a managed link is sent only on
   * one of them. Redaction never narrows: it always uses every pinned host.
   */
  linkHosts?: readonly string[];
}

/** The managed API path is fixed; only its host comes from instance configuration. */
const APPROVED_MANAGED_DELIVERY_API_PATH = '/s/api/v1';
const MANAGED_DELIVERY_CREDENTIAL_ENV = /^LINKS_MANAGED_[A-Z][A-Z0-9_]*$/;

/**
 * The configured base URL must use a hash-pinned approved host (owner ruling)
 * on the default HTTPS port with the fixed API path. The URL parser has
 * already lowercased the host and dropped a default port, as the deployed
 * string comparison relied on; `www.` and trailing-dot spellings stay refused.
 */
function isApprovedManagedDeliveryEndpoint(endpoint: URL, pins: ProtectedDeliveryPins): boolean {
  return endpoint.port === ''
    && isExactPinnedHost(endpoint.hostname, pins.deliveryHostSha256)
    && endpoint.pathname.replace(/\/$/, '') === APPROVED_MANAGED_DELIVERY_API_PATH;
}

export function validateProtectedDeliveryBinding(
  opts: Record<string, unknown>,
  isManagedLoopProvider: (provider: unknown) => boolean,
): string | null {
  const delivery = opts['protectedDelivery'];
  if (!isRecord(delivery) || delivery['enabled'] !== true) return null;
  // The caller supplies the provider-catalog decision so this configuration
  // module does not depend on an agent runtime or duplicate its provider list.
  const bound = opts['sessionScope'] === 'per_chat' && (
    opts['sandboxPerChat'] === true || opts['perChatConversationBound'] === true
    || (opts['fallbackDiscovery'] === undefined && [
      opts['provider'],
      ...normalizeFallbackEntriesFromAgentOptions(opts).map((entry) => entry.provider),
    ].every(isManagedLoopProvider))
  );
  return bound ? null
    : 'protectedDelivery requires per_chat scope with sandboxPerChat, perChatConversationBound, or managed-loop-only provider routes';
}

export function parseProtectedDeliveryConfig(
  raw: unknown,
  environment: Record<string, string | undefined>,
  pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS,
): ProtectedDeliveryConfig | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (!isRecord(raw)) throw new Error('protectedDelivery must be an object');
  if (raw['enabled'] === false) return null;
  if (raw['enabled'] !== true) throw new Error('protectedDelivery.enabled must be true to enable protected delivery');
  const permitted = new Set(['enabled', 'baseUrl', 'credentialEnv', 'linkHosts']);
  for (const key of Object.keys(raw)) {
    if (!permitted.has(key)) throw new Error(`protectedDelivery.${key} is not allowed`);
  }
  const baseUrl = requiredString(raw['baseUrl'], 'protectedDelivery.baseUrl');
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error('protectedDelivery.baseUrl must be a valid HTTPS URL');
  }
  // `search` and `hash` read '' for a bare `?` or `#`; the serialized form still
  // carries the delimiter, which would move an appended route out of the path.
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || /[?#]/.test(endpoint.href)) {
    throw new Error('protectedDelivery.baseUrl must be an HTTPS endpoint without credentials, query, or fragment');
  }
  if (!isApprovedManagedDeliveryEndpoint(endpoint, pins)) {
    throw new Error('protectedDelivery.baseUrl must be the approved managed-delivery API endpoint');
  }
  const linkHosts = optionalLinkHosts(raw['linkHosts'], pins);
  const credentialEnv = requiredString(raw['credentialEnv'], 'protectedDelivery.credentialEnv');
  if (!MANAGED_DELIVERY_CREDENTIAL_ENV.test(credentialEnv)) {
    throw new Error('protectedDelivery.credentialEnv must use the reserved managed credential namespace');
  }
  const token = environment[credentialEnv];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('protectedDelivery credential is unavailable');
  }
  return {
    // Rebuilt from the validated parts so no unvalidated spelling reaches the client.
    baseUrl: `https://${endpoint.hostname}${APPROVED_MANAGED_DELIVERY_API_PATH}`,
    token,
    ...(linkHosts === undefined ? {} : { linkHosts }),
  };
}

function optionalLinkHosts(value: unknown, pins: ProtectedDeliveryPins): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('protectedDelivery.linkHosts must be a non-empty array of hash-pinned approved hosts');
  }
  for (const host of value) {
    if (typeof host !== 'string' || !isExactPinnedHost(host, pins.linkHostSha256)) {
      throw new Error('protectedDelivery.linkHosts must list only hash-pinned approved hosts in lowercase form');
    }
  }
  return Object.freeze([...value] as string[]);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}
