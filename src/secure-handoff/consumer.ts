type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const OPAQUE_ID = /^[A-Za-z0-9_-]{22}$/;
const RECEIPT = /^[A-Za-z0-9_-]{43}$/;
const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export type ConsumerKind = 'password' | 'token' | 'mfa';
export type ConsumerOutcome = 'succeeded' | 'failed' | 'ambiguous';
type FixedHttpLoginOptions = {
  resourceId: string;
  principal: string;
  action: string;
  endpoint: string;
  username: string;
  fetch?: FetchLike;
};

/** A fixed, administrator-registered operation. It has no caller-selected destination or command. */
export interface FixedConsumerAdapter {
  readonly resourceId: string;
  readonly principal: string;
  readonly action: string;
  readonly kinds: readonly ConsumerKind[];
  /** Required only for MFA, where Links binds one live challenge operation. */
  readonly mfaOperationId?: string;
  /** A registered service-owned credential store, or null when saving is prohibited. */
  readonly approvedSaveStore: string | null;
  execute(input: {
    value: string;
    kind: ConsumerKind;
    saveStore: string | null;
  }): Promise<Exclude<ConsumerOutcome, 'ambiguous'>>;
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

type PublicOutcome = { id: string; state: ConsumerOutcome };

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
  readonly #operations = new Map<string, { resourceId: string; result: Promise<PublicOutcome> }>();

  constructor(options: FixedConsumerOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || !base.pathname.replace(/\/$/, '').endsWith('/s/api/v1') || options.token.length === 0) {
      throw new Error('fixed consumer configuration is invalid');
    }
    for (const adapter of options.adapters) {
      if (!validAdapter(adapter) || this.#adapters.has(adapter.resourceId)) throw new Error('fixed consumer registry is invalid');
      this.#adapters.set(adapter.resourceId, adapter);
    }
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#token = options.token;
    this.#fetchFn = options.fetch ?? fetch;
  }

  execute(request: unknown): Promise<PublicOutcome> {
    if (!isExecuteRequest(request)) return Promise.reject(new Error('consumer request is invalid'));
    const adapter = this.#adapters.get(request.resourceId);
    if (!adapter) return Promise.reject(new Error('consumer request is invalid'));
    const existing = this.#operations.get(request.intakeId);
    if (existing) return existing.resourceId === request.resourceId
      ? existing.result
      : Promise.reject(new Error('consumer request is invalid'));
    const operation = this.#executeOnce(request.intakeId, adapter);
    this.#operations.set(request.intakeId, { resourceId: request.resourceId, result: operation });
    return operation;
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
      const outcome = await adapter.execute({ value: consumed.value, kind: consumed.kind, saveStore });
      if (outcome !== 'succeeded' && outcome !== 'failed') return this.#markAmbiguous(intakeId);
      return await this.#complete(intakeId, consumed.receipt, outcome);
    } catch {
      return this.#markAmbiguous(intakeId);
    }
  }

  async #complete(id: string, receipt: string, outcome: Exclude<ConsumerOutcome, 'ambiguous'>): Promise<PublicOutcome> {
    try {
      const response = record(await this.#request(`/intakes/${encodeURIComponent(id)}/complete`, {
        method: 'POST', body: JSON.stringify({ receipt, outcome }),
      }));
      if (response.id !== id || response.state !== outcome) throw new Error('invalid completion');
      return { id, state: outcome };
    } catch {
      return this.#markAmbiguous(id);
    }
  }

  async #markAmbiguous(id: string): Promise<PublicOutcome> {
    try {
      const response = record(await this.#request(`/intakes/${encodeURIComponent(id)}/ambiguous`, { method: 'POST', body: '{}' }));
      if (response.id !== id || response.state !== 'ambiguous') throw new Error('invalid ambiguous response');
    } catch {
      // The consumer must never replay a value merely because reconciliation was unavailable.
    }
    return { id, state: 'ambiguous' };
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
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || options.username.length === 0) {
    throw new Error('fixed HTTP login adapter is invalid');
  }
  const fetchFn = options.fetch ?? fetch;
  return {
    resourceId: options.resourceId,
    principal: options.principal,
    action: options.action,
    kinds: ['password'],
    approvedSaveStore: null,
    async execute(input) {
      try {
        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          body: JSON.stringify({ username: options.username, password: input.value }),
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 200 || response.status === 204) return 'succeeded';
        if (response.status === 401 || response.status === 403) return 'failed';
        throw new Error('fixed login outcome is ambiguous');
      } catch {
        throw new Error('fixed login outcome is ambiguous');
      }
    },
  };
}

function isExecuteRequest(value: unknown): value is { intakeId: string; resourceId: string } {
  return isRecord(value) && exactKeys(value, ['intakeId', 'resourceId']) && typeof value.intakeId === 'string' && OPAQUE_ID.test(value.intakeId)
    && typeof value.resourceId === 'string' && RESOURCE_ID.test(value.resourceId);
}

function validAdapter(adapter: FixedConsumerAdapter): boolean {
  return RESOURCE_ID.test(adapter.resourceId)
    && validText(adapter.principal)
    && validText(adapter.action)
    && adapter.kinds.length > 0
    && adapter.kinds.every(isKind)
    && (adapter.mfaOperationId === undefined || validOperationId(adapter.mfaOperationId))
    && (adapter.approvedSaveStore === null || validText(adapter.approvedSaveStore));
}

function parseConsumed(value: unknown): ConsumedBinding {
  const data = record(value);
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
  if (value.kind === 'mfa') return adapter.mfaOperationId !== undefined && value.operationId === adapter.mfaOperationId;
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
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function validOperationId(value: unknown): value is string {
  return typeof value === 'string'
    && new TextEncoder().encode(value).byteLength >= 1
    && new TextEncoder().encode(value).byteLength <= 256
    && !/[\u0000-\u001F\u007F]/.test(value);
}

function isFixedHttpLoginOptions(value: FixedHttpLoginOptions): boolean {
  return isRecord(value)
    && (exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'username'])
      || exactKeys(value, ['resourceId', 'principal', 'action', 'endpoint', 'username', 'fetch']))
    && typeof value.resourceId === 'string'
    && typeof value.principal === 'string'
    && typeof value.action === 'string'
    && typeof value.endpoint === 'string'
    && typeof value.username === 'string'
    && (value.fetch === undefined || typeof value.fetch === 'function');
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('invalid Links response');
  return value;
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
    const value = record(await readJson(response));
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
