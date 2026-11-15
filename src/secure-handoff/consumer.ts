import { createHash } from 'node:crypto';
import { systemClock } from '../lib/clock.ts';
import { isNonEmptyString, isRecord, requireRecord } from '../lib/type-guards.ts';
import { parseSecretInputOperationResult, type SecretInputOperationResult } from '../core/secret-input-operation-result.ts';
import {
  isServiceOwnedCredentialStore,
  type ServiceOwnedCredentialStore,
} from './credential-store.ts';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const OPAQUE_ID = /^[A-Za-z0-9_-]{22}$/;
const RECEIPT = /^[A-Za-z0-9_-]{43}$/;
const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TRACKED_OPERATIONS = 1_000;
const MAX_CHALLENGE_RESPONSE_BYTES = 4 * 1024;
const MAX_CHALLENGE_TTL_MS = 10 * 60_000;

export type ConsumerKind = 'password' | 'token' | 'mfa';
export type ConsumerOutcome = 'succeeded' | 'failed' | 'ambiguous';
type FixedHttpLoginOptions = {
  resourceId: string;
  principal: string;
  action: string;
  endpoint: string;
  username: string;
  /** An administrator-registered store; no caller can select its destination. */
  store?: ServiceOwnedCredentialStore;
  /** A fixed, one-way transition to one registered MFA resource. */
  mfaTransition?: FixedMfaTransition;
  fetch?: FetchLike;
};

export type FixedMfaTransition = Readonly<{
  resourceId: string;
  account: string;
}>;

type RegisteredChallenge = Readonly<{
  resourceId: string;
  principal: string;
  operationId: string;
  expiresAt: string;
}>;

type AdapterExecution = Exclude<ConsumerOutcome, 'ambiguous'>
  | Readonly<{ outcome: 'succeeded'; challenge: RegisteredChallenge }>
  | Readonly<{ outcome: 'succeeded'; operationResult: SecretInputOperationResult }>;

/** A fixed, administrator-registered operation. It has no caller-selected destination or command. */
export interface FixedConsumerAdapter {
  readonly resourceId: string;
  readonly principal: string;
  readonly action: string;
  readonly kinds: readonly ConsumerKind[];
  /** Required only for MFA, where Links binds one live challenge operation. */
  readonly mfaOperationId?: string;
  /** Accepts an MFA operation only when Links returned it from a registered challenge consume. */
  readonly acceptsRegisteredMfa?: true;
  /** A fixed password source may register exactly this MFA resource after a strict 202 response. */
  readonly mfaTransition?: FixedMfaTransition;
  /** A registered service-owned credential store, or null when saving is prohibited. */
  readonly approvedSaveStore: string | null;
  execute(input: {
    value: string;
    kind: ConsumerKind;
    saveStore: string | null;
    intakeId?: string;
    operationId?: string | null;
  }): Promise<AdapterExecution>;
}

type ConsumedBinding = {
  id: string;
  resourceId: string;
  principal: string;
  kind: ConsumerKind;
  action: string;
  operationId: string | null;
  value: string;
  save: boolean;
  receipt: string;
};

type PublicOutcome = { id: string; state: ConsumerOutcome; operationResult?: SecretInputOperationResult };
type TrackedOperation = { resourceId: string; result: Promise<PublicOutcome>; settled: boolean };

type FixedConsumerOptions = {
  baseUrl: string;
  token: string;
  adapters: ReadonlyArray<FixedConsumerAdapter>;
  fetch?: FetchLike;
};

/**
 * Service-side client that retrieves a value once and gives it only to the
 * registered adapter. Its public method accepts no secret, URL, command, or
 * destination fields.
 */
export class FixedIntakeConsumer {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #adapters = new Map<string, FixedConsumerAdapter>();
  readonly #fetchFn: FetchLike;
  readonly #operations = new Map<string, TrackedOperation>();

  constructor(options: FixedConsumerOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || !base.pathname.replace(/\/$/, '').endsWith('/s/api/v1') || options.token.length === 0) {
      throw new Error('fixed consumer configuration is invalid');
    }
    for (const adapter of options.adapters) {
      if (!validAdapter(adapter) || this.#adapters.has(adapter.resourceId)) throw new Error('fixed consumer registry is invalid');
      const registered: FixedConsumerAdapter = {
        resourceId: adapter.resourceId,
        principal: adapter.principal,
        action: adapter.action,
        kinds: Object.freeze([...adapter.kinds]),
        mfaOperationId: adapter.mfaOperationId,
        ...(adapter.acceptsRegisteredMfa === true ? { acceptsRegisteredMfa: true as const } : {}),
        ...(adapter.mfaTransition === undefined ? {} : {
          mfaTransition: Object.freeze({ resourceId: adapter.mfaTransition.resourceId, account: adapter.mfaTransition.account }),
        }),
        approvedSaveStore: adapter.approvedSaveStore,
        execute: adapter.execute,
      };
      registered.execute = adapter.execute.bind(registered);
      this.#adapters.set(registered.resourceId, Object.freeze(registered));
    }
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#token = options.token;
    this.#fetchFn = options.fetch ?? fetch;
  }

  execute(request: unknown): Promise<PublicOutcome> {
    if (!isExecuteRequest(request)) return Promise.reject(new Error('consumer request is invalid'));
    const adapter = this.#adapters.get(request.resourceId);
    if (!adapter) return Promise.reject(new Error('consumer request is invalid'));
    return this.#track(request.intakeId, request.resourceId, () => this.#executeOnce(request.intakeId, adapter));
  }

  reconcileAmbiguous(request: unknown): Promise<PublicOutcome> {
    if (!isExecuteRequest(request) || !this.#adapters.has(request.resourceId)) {
      return Promise.reject(new Error('consumer request is invalid'));
    }
    // A restarted worker cannot know whether a prior action reached its target.
    return this.#track(request.intakeId, request.resourceId, () => this.#markAmbiguous(request.intakeId));
  }

  #track(intakeId: string, resourceId: string, run: () => Promise<PublicOutcome>): Promise<PublicOutcome> {
    const existing = this.#operations.get(intakeId);
    if (existing) return existing.resourceId === resourceId
      ? existing.result
      : Promise.reject(new Error('consumer request is invalid'));
    if (this.#operations.size >= MAX_TRACKED_OPERATIONS) {
      for (const [id, tracked] of this.#operations) {
        if (tracked.settled) {
          // Links remains the durable consume fence after cache eviction or restart.
          this.#operations.delete(id);
          break;
        }
      }
    }
    if (this.#operations.size >= MAX_TRACKED_OPERATIONS) {
      return Promise.reject(new Error('consumer capacity is unavailable'));
    }
    const tracked: TrackedOperation = { resourceId, result: run(), settled: false };
    tracked.result = tracked.result.finally(() => { tracked.settled = true; });
    this.#operations.set(intakeId, tracked);
    return tracked.result;
  }

  async #executeOnce(intakeId: string, adapter: FixedConsumerAdapter): Promise<PublicOutcome> {
    let raw: unknown;
    try {
      raw = await this.#request(`/intakes/${encodeURIComponent(intakeId)}/consume`, { method: 'POST', body: '{}' });
    } catch {
      return this.#markAmbiguous(intakeId);
    }

    let consumed: ConsumedBinding;
    try {
      consumed = parseConsumed(raw);
    } catch {
      return this.#markAmbiguous(intakeId);
    }

    try {
      if (!matchesAdapter(consumed, intakeId, adapter)) return this.#markAmbiguous(intakeId);
      const saveStore = saveStoreFor(consumed, adapter);
      const executed = await adapter.execute({
        value: consumed.value, kind: consumed.kind, saveStore, intakeId, operationId: consumed.operationId,
      });
      const outcome = typeof executed === 'string' ? executed : executed.outcome;
      if (outcome !== 'succeeded' && outcome !== 'failed') return this.#markAmbiguous(intakeId);
      let operationResult: SecretInputOperationResult | null = null;
      if (typeof executed !== 'string') {
        if ('challenge' in executed) {
          await this.#registerMfaChallenge(intakeId, adapter, executed.challenge);
          operationResult = { phase: 'password', outcome: 'mfa_required' };
        } else {
          operationResult = parseSecretInputOperationResult(executed.operationResult, consumed.kind, outcome);
        }
      }
      return await this.#complete(intakeId, consumed.receipt, consumed.kind, outcome, operationResult);
    } catch {
      return this.#markAmbiguous(intakeId);
    }
  }

  async #complete(
    id: string,
    receipt: string,
    kind: ConsumerKind,
    outcome: Exclude<ConsumerOutcome, 'ambiguous'>,
    operationResult: SecretInputOperationResult | null,
  ): Promise<PublicOutcome> {
    try {
      const body = operationResult === null ? { receipt, outcome } : { receipt, outcome, operationResult };
      const response = requireRecord(await this.#request(`/intakes/${encodeURIComponent(id)}/complete`, {
        method: 'POST', body: JSON.stringify(body),
      }), 'Links completion');
      if (response.id !== id || response.state !== outcome) throw new Error('invalid completion');
      const recorded = parseSecretInputOperationResult(response.operationResult, kind, outcome);
      if ((recorded === null && operationResult !== null)
        || (recorded !== null && (operationResult === null || recorded.phase !== operationResult.phase || recorded.outcome !== operationResult.outcome))) {
        throw new Error('invalid completion operation result');
      }
      return recorded === null ? { id, state: outcome } : { id, state: outcome, operationResult: recorded };
    } catch {
      return this.#markAmbiguous(id);
    }
  }

  async #markAmbiguous(id: string): Promise<PublicOutcome> {
    try {
      const response = requireRecord(await this.#request(`/intakes/${encodeURIComponent(id)}/ambiguous`, { method: 'POST', body: '{}' }), 'Links reconciliation');
      if (response.id !== id || response.state !== 'ambiguous') throw new Error('invalid ambiguous response');
    } catch {
      // intentional: reconciliation failure must still return ambiguous; never replay a consumed value or claim success.
    }
    return { id, state: 'ambiguous' };
  }

  async #registerMfaChallenge(intakeId: string, adapter: FixedConsumerAdapter, challenge: RegisteredChallenge): Promise<void> {
    const transition = adapter.mfaTransition;
    if (!transition || challenge.resourceId !== transition.resourceId || challenge.principal !== adapter.principal) {
      throw new Error('fixed MFA challenge is invalid');
    }
    const response = requireRecord(await this.#request(`/resources/${encodeURIComponent(challenge.resourceId)}/challenges`, {
      method: 'POST',
      headers: { 'Idempotency-Key': challengeIdempotencyKey(intakeId, challenge.operationId) },
      body: JSON.stringify({ principal: challenge.principal, operationId: challenge.operationId, expiresAt: challenge.expiresAt }),
    }), 'Links challenge registration');
    if (!exactKeys(response, ['id', 'resourceId', 'operationId', 'expiresAt', 'state'])
      || typeof response.id !== 'string' || !OPAQUE_ID.test(response.id)
      || response.resourceId !== challenge.resourceId || response.operationId !== challenge.operationId
      || response.expiresAt !== challenge.expiresAt || response.state !== 'open') {
      throw new Error('Links challenge registration is invalid');
    }
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.#token}`);
    headers.set('Accept', 'application/json');
    headers.set('Cache-Control', 'no-store');
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await this.#fetchFn(`${this.#baseUrl}${path}`, {
        ...init, headers, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Links consumer request is unavailable');
    }
    if (!response.ok) throw new LinksResponseError(await errorCode(response));
    return readJson(response);
  }
}

/** A fixed HTTP login operation, useful for a specifically registered dummy or service account. */
export function createFixedHttpLoginAdapter(options: FixedHttpLoginOptions): FixedConsumerAdapter {
  if (!isFixedHttpLoginOptions(options)) throw new Error('fixed HTTP login adapter is invalid');
  const resourceId = options.resourceId;
  const principal = options.principal;
  const action = options.action;
  const endpoint = new URL(options.endpoint);
  const username = options.username;
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || username.length === 0) {
    throw new Error('fixed HTTP login adapter is invalid');
  }
  const store = options.store ?? null;
  const transition = options.mfaTransition === undefined
    ? undefined
    : Object.freeze({ resourceId: options.mfaTransition.resourceId, account: options.mfaTransition.account });
  if (store !== null && (store.resourceId !== resourceId || store.principal !== principal || store.action !== action)) {
    throw new Error('fixed HTTP login adapter is invalid');
  }
  if (transition !== undefined && (!validMfaTransition(transition) || action !== 'Verify password for two-step sign-in' || store !== null)) {
    throw new Error('fixed HTTP login adapter is invalid');
  }
  const fetchFn = options.fetch ?? fetch;
  return Object.freeze<FixedConsumerAdapter>({
    resourceId,
    principal,
    action,
    kinds: Object.freeze(['password'] as const),
    approvedSaveStore: store?.name ?? null,
    ...(transition === undefined ? {} : { mfaTransition: transition }),
    async execute(input) {
      if (input.kind !== 'password' || (input.saveStore !== null && input.saveStore !== store?.name)) {
        throw new Error('fixed login outcome is ambiguous');
      }
      if (transition !== undefined && (!input.intakeId || !OPAQUE_ID.test(input.intakeId))) {
        throw new Error('fixed login outcome is ambiguous');
      }
      try {
        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          body: JSON.stringify(transition === undefined
            ? { username, password: input.value }
            : { username, password: input.value, intakeId: input.intakeId }),
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (transition !== undefined && response.status === 202) {
          return {
            outcome: 'succeeded',
            challenge: await parseSourceChallenge(response, input.intakeId, principal, transition),
          };
        }
        if (transition === undefined && (response.status === 200 || response.status === 204)) {
          if (input.saveStore !== null) await store?.save(input.value);
          return { outcome: 'succeeded', operationResult: { phase: 'password', outcome: 'completed' } };
        }
        if (response.status === 401 || response.status === 403) return 'failed';
        throw new Error('fixed login outcome is ambiguous');
      } catch {
        throw new Error('fixed login outcome is ambiguous');
      }
    },
  });
}

function isExecuteRequest(value: unknown): value is { intakeId: string; resourceId: string } {
  return isRecord(value) && exactKeys(value, ['intakeId', 'resourceId']) && typeof value.intakeId === 'string' && OPAQUE_ID.test(value.intakeId)
    && typeof value.resourceId === 'string' && RESOURCE_ID.test(value.resourceId);
}

function validAdapter(adapter: FixedConsumerAdapter): boolean {
  return typeof adapter.execute === 'function'
    && RESOURCE_ID.test(adapter.resourceId)
    && validText(adapter.principal)
    && validText(adapter.action)
    && adapter.kinds.length > 0
    && adapter.kinds.every(isKind)
    && (adapter.mfaOperationId === undefined || validOperationId(adapter.mfaOperationId))
    && (adapter.acceptsRegisteredMfa === undefined || adapter.acceptsRegisteredMfa === true)
    && (adapter.mfaTransition === undefined || validMfaTransition(adapter.mfaTransition))
    && !(adapter.mfaOperationId !== undefined && adapter.acceptsRegisteredMfa === true)
    && (adapter.mfaTransition === undefined || (adapter.kinds.length === 1 && adapter.kinds[0] === 'password'
      && adapter.action === 'Verify password for two-step sign-in' && adapter.approvedSaveStore === null))
    && (adapter.acceptsRegisteredMfa !== true || (adapter.kinds.length === 1 && adapter.kinds[0] === 'mfa'))
    && (adapter.approvedSaveStore === null || validText(adapter.approvedSaveStore));
}

function parseConsumed(value: unknown): ConsumedBinding {
  const data = requireRecord(value, 'Links consumed intake');
  if (!exactKeys(data, ['id', 'resourceId', 'principal', 'kind', 'action', 'operationId', 'value', 'save', 'receipt'])
    || typeof data.id !== 'string' || !OPAQUE_ID.test(data.id)
    || typeof data.resourceId !== 'string' || !RESOURCE_ID.test(data.resourceId)
    || typeof data.principal !== 'string' || !validText(data.principal)
    || !isKind(data.kind)
    || typeof data.action !== 'string' || !validText(data.action)
    || !(data.operationId === null || validOperationId(data.operationId))
    || typeof data.value !== 'string' || data.value.length === 0 || data.value.length > 16_384
    || typeof data.save !== 'boolean'
    || typeof data.receipt !== 'string' || !RECEIPT.test(data.receipt)) {
    throw new Error('invalid consumed intake');
  }
  return data as ConsumedBinding;
}

function matchesAdapter(value: ConsumedBinding, intakeId: string, adapter: FixedConsumerAdapter): boolean {
  if (value.id !== intakeId || value.resourceId !== adapter.resourceId || value.principal !== adapter.principal
    || value.action !== adapter.action || !adapter.kinds.includes(value.kind)) return false;
  if (value.kind === 'mfa') {
    return typeof value.operationId === 'string'
      && (adapter.acceptsRegisteredMfa === true || (adapter.mfaOperationId !== undefined && value.operationId === adapter.mfaOperationId));
  }
  return value.operationId === null;
}

function saveStoreFor(value: ConsumedBinding, adapter: FixedConsumerAdapter): string | null {
  if (!value.save) return null;
  if (value.kind === 'mfa' || adapter.approvedSaveStore === null) throw new Error('saving is not registered');
  return adapter.approvedSaveStore;
}

function isKind(value: unknown): value is ConsumerKind {
  return value === 'password' || value === 'token' || value === 'mfa';
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

function isFixedHttpLoginOptions(value: FixedHttpLoginOptions): boolean {
  return isRecord(value)
    && (
      exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'username'])
      || exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'username', 'fetch'])
      || exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'username', 'store'])
      || exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'username', 'store', 'fetch'])
      || exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'username', 'mfaTransition'])
      || exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'username', 'mfaTransition', 'fetch'])
    )
    && typeof value.resourceId === 'string'
    && typeof value.principal === 'string'
    && typeof value.action === 'string'
    && typeof value.endpoint === 'string'
    && typeof value.username === 'string'
    && (value.store === undefined || isServiceOwnedCredentialStore(value.store))
    && (value.mfaTransition === undefined || validMfaTransition(value.mfaTransition))
    && (value.fetch === undefined || typeof value.fetch === 'function');
}

function validMfaTransition(value: unknown): value is FixedMfaTransition {
  return isRecord(value) && exactKeys(value, ['resourceId', 'account'])
    && typeof value.resourceId === 'string' && RESOURCE_ID.test(value.resourceId)
    && validText(value.account);
}

async function parseSourceChallenge(
  response: Response,
  intakeId: string | undefined,
  principal: string,
  transition: FixedMfaTransition,
): Promise<RegisteredChallenge> {
  const value = requireRecord(await readBoundedJson(response, MAX_CHALLENGE_RESPONSE_BYTES), 'fixed MFA source response');
  if (!exactKeys(value, ['parentIntakeId', 'principal', 'account', 'resourceId', 'operationId', 'expiresAt'])
    || value.parentIntakeId !== intakeId || value.principal !== principal || value.account !== transition.account
    || value.resourceId !== transition.resourceId || !validOperationId(value.operationId)
    || typeof value.expiresAt !== 'string') {
    throw new Error('fixed MFA source response is invalid');
  }
  const expiresAt = Date.parse(value.expiresAt);
  const now = systemClock.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + MAX_CHALLENGE_TTL_MS) {
    throw new Error('fixed MFA source response is invalid');
  }
  return Object.freeze({ resourceId: value.resourceId, principal, operationId: value.operationId, expiresAt: new Date(expiresAt).toISOString() });
}

function challengeIdempotencyKey(intakeId: string, operationId: string): string {
  return createHash('sha256').update(`managed-mfa-challenge:${intakeId}:${operationId}`).digest('base64url');
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

class LinksResponseError extends Error {
  readonly code: string;

  constructor(code: string) {
    super('Links consumer request was rejected');
    this.code = code;
  }
}

async function errorCode(response: Response): Promise<string> {
  try {
    const value = requireRecord(await readJson(response), 'Links error');
    return typeof value.error === 'string' && /^[a-z_]{1,64}$/.test(value.error) ? value.error : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

async function readJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new Error('Links response is invalid');
  if (!response.body) throw new Error('Links response is invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Links response is invalid');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Links response is invalid') throw error;
    throw new Error('Links consumer request is unavailable');
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('Links response is invalid'); }
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit) || !response.body) {
    throw new Error('fixed MFA source response is invalid');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('fixed MFA source response is invalid');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('fixed MFA source response is invalid'); }
}
