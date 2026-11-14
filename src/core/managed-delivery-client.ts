import type {
  DeliveryEventStatus,
  ManagedDeliveryClient,
  ManagedDeliveryStatus,
  ProtectedDeliveryPurpose,
} from './protected-delivery.ts';
import { PROTECTED_DELIVERY_PINS, type ProtectedDeliveryPins } from './protected-delivery-pins.ts';
import { isCanonicalManagedLink } from './protected-message.ts';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class HttpManagedDeliveryClient implements ManagedDeliveryClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly pins: ProtectedDeliveryPins;
  private readonly linkHosts: readonly string[] | undefined;

  constructor(options: {
    baseUrl: string;
    token: string;
    fetch?: FetchLike;
    pins?: ProtectedDeliveryPins;
    linkHosts?: readonly string[];
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchFn = options.fetch ?? fetch;
    this.pins = options.pins ?? PROTECTED_DELIVERY_PINS;
    this.linkHosts = options.linkHosts;
  }

  async stageRustdesk(request: {
    deviceId: string;
    purpose: ProtectedDeliveryPurpose;
    principal: string;
    operationId: string;
  }): Promise<{ deliveryRef: string; id: string; expiresAt: string; state: string }> {
    const body = await this.mutate('/deliveries', request.operationId, {
      kind: 'rustdesk',
      deviceId: request.deviceId,
      principal: request.principal,
      purpose: request.purpose,
    });
    const delivery = requireDelivery(body, false, true, this.pins, this.linkHosts);
    return {
      deliveryRef: delivery.deliveryRef!,
      id: delivery.id,
      expiresAt: delivery.expiresAt,
      state: delivery.state,
    };
  }

  async resolve(request: {
    deliveryRef: string;
    principal: string;
    operationId: string;
  }): Promise<{ id: string; link: string; expiresAt: string; state: string }> {
    const body = await this.mutate(`/deliveries/${encodeURIComponent(request.deliveryRef)}/resolve`, request.operationId, {
      principal: request.principal,
      operationId: request.operationId,
    });
    const delivery = requireDelivery(body, true, false, this.pins, this.linkHosts);
    return { id: delivery.id, link: delivery.link!, expiresAt: delivery.expiresAt, state: delivery.state };
  }

  async getStatus(request: { deliveryRef: string; principal: string }): Promise<ManagedDeliveryStatus> {
    const query = new URLSearchParams({ principal: request.principal });
    const body = await this.request(`/deliveries/${encodeURIComponent(request.deliveryRef)}?${query.toString()}`, {
      method: 'GET',
    });
    const record = asRecord(body);
    return {
      deliveryRef: requiredOpaqueId(record['deliveryRef'], 'deliveryRef'),
      id: requiredOpaqueId(record['id'], 'id'),
      state: requiredGrantState(record['state']),
      deliveryStatus: requiredDeliveryStatus(record['status']),
      expiresAt: requiredInstant(record['expiresAt'], 'expiresAt'),
      issuedAt: requiredInstant(record['issuedAt'], 'issuedAt'),
      kind: requiredKind(record['kind']),
      deviceId: nullableString(record['deviceId'], 'deviceId'),
      purpose: nullablePurpose(record['purpose']),
    };
  }

  async reportEvent(event: {
    deliveryRef: string;
    eventId: string;
    status: DeliveryEventStatus;
    observedAt: string;
  }): Promise<void> {
    await this.mutate(`/deliveries/${encodeURIComponent(event.deliveryRef)}/events`, event.eventId, {
      eventId: event.eventId,
      status: event.status,
      observedAt: event.observedAt,
    });
  }

  private async mutate(path: string, operationId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(path, {
      method: 'POST',
      headers: { 'Idempotency-Key': operationId },
      body: JSON.stringify(body),
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    headers.set('Accept', 'application/json');
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    headers.set('Cache-Control', 'no-store');
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('managed delivery request is unavailable');
    }
    if (!response.ok) throw new Error('managed delivery request failed');
    return readJson(response);
  }
}

function requireDelivery(
  value: unknown,
  requireLink: boolean,
  requireRef: boolean,
  pins: ProtectedDeliveryPins,
  linkHosts: readonly string[] | undefined,
): {
  deliveryRef?: string; id: string; expiresAt: string; state: string; link?: string;
} {
  const record = asRecord(value);
  const result = {
    id: requiredOpaqueId(record['id'], 'id'),
    expiresAt: requiredInstant(record['expiresAt'], 'expiresAt'),
    state: requiredGrantState(record['state']),
    ...(requireRef ? { deliveryRef: requiredOpaqueId(record['deliveryRef'], 'deliveryRef') } : {}),
    ...(typeof record['link'] === 'string' && isCanonicalManagedLink(record['link'], pins, linkHosts) ? { link: record['link'] } : {}),
  };
  if (requireLink && result.link === undefined) throw new Error('managed delivery response is missing protected URL');
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('managed delivery response has an invalid shape');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`managed delivery response is missing ${field}`);
  return value;
}

function requiredOpaqueId(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (!/^[A-Za-z0-9_-]{22}$/.test(result)) throw new Error(`managed delivery response has an invalid ${field}`);
  return result;
}

function requiredInstant(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (!Number.isFinite(new Date(result).getTime())) throw new Error(`managed delivery response has an invalid ${field}`);
  return result;
}

function requiredGrantState(value: unknown): string {
  if (value === 'unclaimed' || value === 'claimed' || value === 'revoked' || value === 'expired' || value === 'done' || value === 'replaced') return value;
  throw new Error('managed delivery response has an invalid state');
}

function requiredDeliveryStatus(value: unknown): string {
  if (value === 'staged' || value === 'submitted' || value === 'delivered' || value === 'read' || value === 'ambiguous' || value === 'failed') return value;
  throw new Error('managed delivery response has an invalid delivery status');
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function requiredKind(value: unknown): 'secret' | 'rustdesk' {
  if (value === 'secret' || value === 'rustdesk') return value;
  throw new Error('managed delivery response has an invalid kind');
}

function nullablePurpose(value: unknown): ProtectedDeliveryPurpose | null {
  if (value === null) return null;
  if (value === 'login' || value === 'recovery') return value;
  throw new Error('managed delivery response has an invalid purpose');
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
    throw new Error('managed delivery response is too large');
  }
  if (response.body === null) throw new Error('managed delivery response is not JSON');
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
        throw new Error('managed delivery response is too large');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'managed delivery response is too large') throw error;
    throw new Error('managed delivery response is unavailable');
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('managed delivery response is not JSON'); }
}
