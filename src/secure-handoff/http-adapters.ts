import { isNonEmptyString, isRecord } from '../lib/type-guards.ts';
import {
  isServiceOwnedCredentialStore,
  type ServiceOwnedCredentialStore,
} from './credential-store.ts';
import type { ConsumerKind, FixedConsumerAdapter } from './consumer.ts';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_CREDENTIAL_LENGTH = 16_384;
const REQUEST_TIMEOUT_MS = 10_000;

type FixedHttpTokenOptions = {
  resourceId: string;
  principal: string;
  action: string;
  endpoint: string;
  store?: ServiceOwnedCredentialStore;
  fetch?: FetchLike;
};

type FixedHttpMfaOptions = {
  resourceId: string;
  principal: string;
  action: string;
  endpoint: string;
  username: string;
  mfaOperationId: string;
  fetch?: FetchLike;
};

type ExecutionInput = {
  value: string;
  kind: ConsumerKind;
  saveStore: string | null;
};

/** A registered fixed token validation operation with no caller-selected target. */
export function createFixedHttpTokenAdapter(options: FixedHttpTokenOptions): FixedConsumerAdapter {
  if (!isFixedHttpTokenOptions(options)) throw new Error('fixed token adapter is invalid');
  const endpoint = trustedEndpoint(options.endpoint);
  if (!endpoint) throw new Error('fixed token adapter is invalid');
  const { resourceId, principal, action } = options;
  const store = options.store ?? null;
  if (store !== null && !matchesStore(store, resourceId, principal, action)) {
    throw new Error('fixed token adapter is invalid');
  }
  const fetchFn = options.fetch ?? fetch;

  return Object.freeze({
    resourceId,
    principal,
    action,
    kinds: Object.freeze(['token'] as const),
    approvedSaveStore: store?.name ?? null,
    async execute(input: ExecutionInput) {
      if (!validExecution(input, 'token', store?.name ?? null)) throw ambiguous('token');
      try {
        const response = await fetchFn(endpoint, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${input.value}`,
            'Cache-Control': 'no-store',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 200 || response.status === 204) {
          if (input.saveStore !== null) await store?.save(input.value);
          return 'succeeded';
        }
        if (response.status === 401 || response.status === 403) return 'failed';
        throw ambiguous('token');
      } catch {
        throw ambiguous('token');
      }
    },
  });
}

/** A registered fixed MFA operation; codes are never persisted. */
export function createFixedHttpMfaAdapter(options: FixedHttpMfaOptions): FixedConsumerAdapter {
  if (!isFixedHttpMfaOptions(options)) throw new Error('fixed MFA adapter is invalid');
  const endpoint = trustedEndpoint(options.endpoint);
  if (!endpoint) throw new Error('fixed MFA adapter is invalid');
  const { resourceId, principal, action, username, mfaOperationId } = options;
  const fetchFn = options.fetch ?? fetch;

  return Object.freeze({
    resourceId,
    principal,
    action,
    kinds: Object.freeze(['mfa'] as const),
    mfaOperationId,
    approvedSaveStore: null,
    async execute(input: ExecutionInput) {
      if (!validExecution(input, 'mfa', null)) throw ambiguous('MFA');
      try {
        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
          body: JSON.stringify({ username, code: input.value, operationId: mfaOperationId }),
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 200 || response.status === 204) return 'succeeded';
        if (response.status === 401 || response.status === 403) return 'failed';
        throw ambiguous('MFA');
      } catch {
        throw ambiguous('MFA');
      }
    },
  });
}

function isFixedHttpTokenOptions(value: unknown): value is FixedHttpTokenOptions {
  if (!isRecord(value) || !(
    exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint'])
    || exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'fetch'])
    || exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'store'])
    || exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'store', 'fetch'])
  )) return false;
  return validCommonOptions(value)
    && (value.store === undefined || isServiceOwnedCredentialStore(value.store))
    && (value.fetch === undefined || typeof value.fetch === 'function');
}

function isFixedHttpMfaOptions(value: unknown): value is FixedHttpMfaOptions {
  return (isRecord(value)
    && (exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'username', 'mfaOperationId'])
      || exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'username', 'mfaOperationId', 'fetch'])))
    && validCommonOptions(value)
    && validText(value.username)
    && validOperationId(value.mfaOperationId)
    && (value.fetch === undefined || typeof value.fetch === 'function');
}

function validCommonOptions(value: Record<string, unknown>): boolean {
  return typeof value.resourceId === 'string' && RESOURCE_ID.test(value.resourceId)
    && validText(value.principal)
    && validText(value.action)
    && typeof value.endpoint === 'string';
}

function trustedEndpoint(value: string): URL | null {
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === 'https:' && endpoint.hostname.length > 0
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
      ? endpoint
      : null;
  } catch {
    return null;
  }
}

function matchesStore(store: ServiceOwnedCredentialStore, resourceId: string, principal: string, action: string): boolean {
  return store.resourceId === resourceId && store.principal === principal && store.action === action;
}

function validExecution(
  value: unknown,
  kind: ConsumerKind,
  approvedSaveStore: string | null,
): value is ExecutionInput {
  return isRecord(value)
    && exactKeys(value, ['value', 'kind', 'saveStore'])
    && value.kind === kind
    && typeof value.value === 'string' && value.value.length > 0 && value.value.length <= MAX_CREDENTIAL_LENGTH
    && (value.saveStore === null || value.saveStore === approvedSaveStore);
}

function validText(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= 256;
}

function validOperationId(value: unknown): value is string {
  return typeof value === 'string'
    && new TextEncoder().encode(value).byteLength >= 1
    && new TextEncoder().encode(value).byteLength <= 256
    && !/[\u0000-\u001F\u007F]/.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function ambiguous(kind: 'token' | 'MFA'): Error {
  return new Error(`fixed ${kind} outcome is ambiguous`);
}
