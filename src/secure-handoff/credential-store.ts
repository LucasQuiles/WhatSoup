import { isNonEmptyString, isRecord } from '../lib/type-guards.ts';

const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_CREDENTIAL_LENGTH = 16_384;
const REQUEST_TIMEOUT_MS = 10_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ServiceOwnedCredentialStore {
  readonly name: string;
  readonly resourceId: string;
  readonly principal: string;
  readonly action: string;
  /** Writes one exact credential value to the service-owned destination fixed at registration. */
  save(value: string): Promise<void>;
}

type StoreOptions = {
  name: string;
  resourceId: string;
  principal: string;
  action: string;
  persist: (value: string) => Promise<void> | void;
};

type FixedHttpCredentialStoreOptions = {
  name: string;
  resourceId: string;
  principal: string;
  action: string;
  endpoint: string;
  authorization: string;
  fetch?: FetchLike;
};

const registeredStores = new WeakSet<object>();

/**
 * Registers a storage operation chosen by the service at startup. The caller
 * can later select only this registered name; it cannot supply a destination.
 */
export function createServiceOwnedCredentialStore(options: StoreOptions): ServiceOwnedCredentialStore {
  if (!isStoreOptions(options)) throw new Error('service-owned credential store is invalid');
  const name = options.name;
  const resourceId = options.resourceId;
  const principal = options.principal;
  const action = options.action;
  const persist = options.persist;
  const store: ServiceOwnedCredentialStore = Object.freeze({
    name,
    resourceId,
    principal,
    action,
    async save(value: string): Promise<void> {
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CREDENTIAL_LENGTH) {
        throw new Error('credential value is invalid');
      }
      await persist(value);
    },
  });
  registeredStores.add(store);
  return store;
}

/** Ensures an adapter accepts stores created by the fixed service registry only. */
export function isServiceOwnedCredentialStore(value: unknown): value is ServiceOwnedCredentialStore {
  return typeof value === 'object' && value !== null && registeredStores.has(value);
}

/**
 * A concrete store whose destination and authorization are fixed by service
 * configuration at registration. The save method accepts only a value.
 */
export function createFixedHttpCredentialStore(options: FixedHttpCredentialStoreOptions): ServiceOwnedCredentialStore {
  if (!isFixedHttpCredentialStoreOptions(options)) throw new Error('fixed credential store is invalid');
  const name = options.name;
  const resourceId = options.resourceId;
  const principal = options.principal;
  const action = options.action;
  const authorization = options.authorization;
  const fetchFn = options.fetch ?? fetch;
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new Error('fixed credential store is invalid');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('fixed credential store is invalid');
  }
  return createServiceOwnedCredentialStore({
    name,
    resourceId,
    principal,
    action,
    async persist(value) {
      try {
        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${authorization}`,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
          body: JSON.stringify({ value }),
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status !== 204) throw new Error('credential store refused write');
      } catch {
        throw new Error('fixed credential store write failed');
      }
    },
  });
}

function isStoreOptions(value: StoreOptions): boolean {
  return isRecord(value)
    && exactKeys(value, ['name', 'resourceId', 'principal', 'action', 'persist'])
    && typeof value.name === 'string' && RESOURCE_ID.test(value.name)
    && typeof value.resourceId === 'string' && RESOURCE_ID.test(value.resourceId)
    && validText(value.principal)
    && validText(value.action)
    && typeof value.persist === 'function';
}

function isFixedHttpCredentialStoreOptions(value: FixedHttpCredentialStoreOptions): boolean {
  return isRecord(value)
    && (
      exactKeys(value, ['name', 'resourceId', 'principal', 'action', 'endpoint', 'authorization'])
      || exactKeys(value, ['name', 'resourceId', 'principal', 'action', 'endpoint', 'authorization', 'fetch'])
    )
    && typeof value.name === 'string' && RESOURCE_ID.test(value.name)
    && typeof value.resourceId === 'string' && RESOURCE_ID.test(value.resourceId)
    && validText(value.principal)
    && validText(value.action)
    && typeof value.endpoint === 'string'
    && validHeaderValue(value.authorization)
    && (value.fetch === undefined || typeof value.fetch === 'function');
}

function validText(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= 256;
}

function validHeaderValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001F\u007F]/.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

