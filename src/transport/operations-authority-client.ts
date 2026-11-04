import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseTransportAuthorityUrl, TRANSPORT_AUTHORITY_URL_REQUIREMENT } from '../lib/authority-url.ts';
import { isRecord } from '../lib/type-guards.ts';
import { currentTransportSendSignal } from './send-deadline.ts';

export const TRANSPORT_AUTHORITY_ADAPTER_VERSION = 1;

const AUTHORITY_REQUEST_TIMEOUT_MS = 5_000;
// An authority operation can carry the established 50 MiB media payload as
// base64 (~66.7 MiB) plus snapshot metadata. Activation still requires
// installed client/authority parity proof within the unchanged deadline.
const AUTHORITY_RESPONSE_MAX_BYTES = 100 * 1024 * 1024;
// The snapshot gate accepts depth 64 and 10,000 nodes. Leave room for the
// response envelope while stopping JSON.parse from creating a hostile graph.
const AUTHORITY_RESPONSE_MAX_DEPTH = 128;
const AUTHORITY_RESPONSE_MAX_CONTAINERS = 100_000;
// Count lexical JSON tokens instead of literal bytes: a gate-valid 10,000-node
// snapshot may contain long finite numbers, while flat graphs stay bounded.
// This matches the 100,000-container ceiling for a scalar admission snapshot.
const AUTHORITY_RESPONSE_MAX_JSON_TOKENS = 200_017;
// A byte limit alone permits an unbounded number of tiny chunks. This leaves
// ample room for ordinary streaming while bounding retained chunk objects.
const AUTHORITY_RESPONSE_MAX_CHUNKS = 100_000;

export type { TransportInboundContext } from '../core/transport-inbound-context.ts';

/** The authority admission API permits only the inbound event in `context`. */
export interface TransportReplyContext {
  inbound_event_id: string;
}

export interface TransportAdmissionInput {
  recipient: string;
  content: unknown;
  /** Every provider-visible sendMessage option, frozen by the final wire gate. */
  options?: Record<string, unknown>;
  context?: TransportReplyContext;
  /** A released held operation; never accepted inside the reply context. */
  operationId?: string;
}

export interface TransportAdmission {
  attemptId: string;
  payloadDigest: string;
}

export interface TransportReceiptInput {
  attemptId: string;
  state: 'provider_accepted' | 'unknown';
  providerId?: string;
}

export interface TransportInboundInput {
  eventId: string;
  sender: string;
  conversation: string;
  receivedAt: string;
  /** Text extracted from the authenticated provider event, never model input. */
  text?: string;
}

export interface TransportDecisionInput {
  eventId: string;
  operationIds: string[];
  digests: string[];
  challenge: string;
  approve?: boolean;
}

export interface MailPreviewAttachment {
  index: number;
  name: string;
  size: number;
  sha256: string;
  contentType: string;
  isInline: boolean;
  contentId: string | null;
}

/**
 * Server-verified semantic mail fields. The raw Graph or MIME source payload
 * is deliberately not a review surface: it can be opaque and cannot be read
 * as a truthful mail preview by the WhatsApp reviewer.
 */
export interface MailSendPreview {
  sender: string;
  from: string;
  replyTo: string[];
  subject: string;
  body: string;
  contentType: string;
  to: string[];
  cc: string[];
  bcc: string[];
  mailbox: string;
  attachments: MailPreviewAttachment[];
  extraHeaders: Record<string, unknown>;
  /** Trusted Agent365 Desk route derived from the configured authority origin. */
  deskUrl: string;
}

export interface TransportOperation {
  id: string;
  accountId: string;
  action: string;
  payload: Record<string, unknown>;
  digest: string;
  state: string;
  /** A review projection cannot supply bytes to an execution path. */
  reviewOnly?: boolean;
  /** Required for mail.send review operations, absent for non-mail operations. */
  preview?: MailSendPreview;
}

export interface TransportReview {
  challenge: string;
  items: Array<{ id: string; digest: string }>;
  previews: TransportOperation[];
  expiresAt: string;
  /** Derived from the configured authority origin, never a response field. */
  deskUrl?: string;
}

export interface TransportAutomationHold {
  ruleId: string;
  reason: string;
}

export interface ReadyTransportReference {
  id: string;
  digest: string;
}

export type TransportInboundResponse =
  | {
    kind: 'inbound';
    /** Server-created exact approved operations; never agent-supplied input. */
    automationOperations: TransportOperation[];
    /** Server-visible holds, logged locally without sending a third-party notice. */
    automationHolds: TransportAutomationHold[];
  }
  | { kind: 'paused'; receipt: TransportOperation }
  | { kind: 'review'; review: TransportReview }
  | { kind: 'decision'; operations: TransportOperation[] };

/** The narrow capability exposed to the final transport seam and inbound bridge. */
export interface OperationsAuthorityPort {
  readyOperations(signal?: AbortSignal): Promise<ReadyTransportReference[]>;
  readyOperation(reference: ReadyTransportReference, signal?: AbortSignal): Promise<TransportOperation>;
  admit(input: TransportAdmissionInput): Promise<TransportAdmission>;
  recordReceipt(input: TransportReceiptInput): Promise<void>;
  registerInbound(input: TransportInboundInput): Promise<TransportInboundResponse>;
  /** Release the server-side inbound lease after its bound turn is terminal. */
  closeInbound(input: { eventId: string }): Promise<void>;
  recordDecision(input: TransportDecisionInput): Promise<void>;
  pause(input: { eventId: string }): Promise<void>;
}

export class TransportAuthorityUnavailableError extends Error {
  readonly code = 'TRANSPORT_AUTHORITY_UNAVAILABLE';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransportAuthorityUnavailableError';
  }
}

export class TransportApprovalRequiredError extends Error {
  readonly code = 'TRANSPORT_APPROVAL_REQUIRED';
  readonly operationId: string | null;

  constructor(operationId: string | null) {
    super('transport send requires human approval');
    this.name = 'TransportApprovalRequiredError';
    this.operationId = operationId;
  }
}

type AuthorityFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OperationsAuthorityClientOptions {
  baseUrl: string;
  accountId: string;
  bearerToken: string;
  fetch?: AuthorityFetch;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(nonEmptyString) ? value : null;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('transport authority request aborted');
}

/**
 * An injected fetch can ignore AbortSignal. Continue observing its late
 * settlement while the caller fails at the authority request deadline.
 */
function awaitWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = signal.aborted;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError(signal));
    };
    if (!settled) signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (settled) reject(abortError(signal));
  });
}

function assertAuthorityJsonStructure(body: Buffer): void {
  let depth = 0;
  let containers = 0;
  let jsonTokens = 0;
  let inString = false;
  let inScalar = false;
  let escaped = false;
  const countToken = () => {
    jsonTokens += 1;
    if (jsonTokens > AUTHORITY_RESPONSE_MAX_JSON_TOKENS) {
      throw new RangeError('transport authority response JSON token count exceeds limit');
    }
  };
  for (const byte of body) {
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) inString = false;
      continue;
    }
    if (byte === 0x22) {
      countToken();
      inString = true;
      continue;
    }
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) {
      inScalar = false;
      continue;
    }
    if (byte === 0x7b || byte === 0x5b || byte === 0x7d || byte === 0x5d || byte === 0x2c || byte === 0x3a) {
      countToken();
      inScalar = false;
    }
    if (byte === 0x7b || byte === 0x5b) {
      depth += 1;
      containers += 1;
      if (depth > AUTHORITY_RESPONSE_MAX_DEPTH || containers > AUTHORITY_RESPONSE_MAX_CONTAINERS) {
        throw new RangeError('transport authority response JSON structure exceeds limit');
      }
      continue;
    }
    if (byte === 0x7d || byte === 0x5d) {
      depth -= 1;
      continue;
    }
    if (byte === 0x2c || byte === 0x3a) continue;
    if (!inScalar) {
      countToken();
      inScalar = true;
    }
  }
}

function cancellationFailure(error: unknown): TransportAuthorityUnavailableError {
  return new TransportAuthorityUnavailableError(
    'transport authority response cancellation failed',
    { cause: error },
  );
}

async function readAuthorityJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new SyntaxError('transport authority response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      if (done) {
        complete = true;
        break;
      }
      chunkCount += 1;
      if (chunkCount > AUTHORITY_RESPONSE_MAX_CHUNKS) {
        throw new RangeError('transport authority response exceeds chunk limit');
      }
      if (!value) continue;
      total += value.byteLength;
      if (total > AUTHORITY_RESPONSE_MAX_BYTES) {
        throw new RangeError('transport authority response exceeds byte limit');
      }
      chunks.push(value);
    }
    if (signal.aborted) throw abortError(signal);
    const body = Buffer.concat(chunks, total);
    assertAuthorityJsonStructure(body);
    return JSON.parse(body.toString('utf8')) as unknown;
  } finally {
    let cancelError: unknown;
    let cancellation: Promise<void> | undefined;
    if (!complete) {
      try {
        cancellation = awaitWithAbort(reader.cancel(), signal).then(
          () => {},
          (error) => { cancelError = error; },
        );
      } catch (error) {
        cancelError = error;
      }
    }
    chunks.length = 0;
    reader.releaseLock();
    if (cancellation !== undefined) await cancellation;
    if (cancelError !== undefined) throw cancellationFailure(cancelError);
  }
}

function mailPreview(value: unknown, deskUrl: string): MailSendPreview | null {
  if (!isRecord(value)
    || !nonEmptyString(value['sender'])
    || !nonEmptyString(value['from'])
    || !nonEmptyString(value['subject'])
    || typeof value['body'] !== 'string'
    || !nonEmptyString(value['content_type'])
    || !nonEmptyString(value['mailbox'])
    || !isRecord(value['extra_headers'])) return null;
  const replyTo = stringArray(value['reply_to']);
  const to = stringArray(value['to']);
  const cc = stringArray(value['cc']);
  const bcc = stringArray(value['bcc']);
  if (replyTo === null || to === null || cc === null || bcc === null || !Array.isArray(value['attachments'])) return null;
  const attachments = value['attachments'].map((attachment) => {
    if (!isRecord(attachment)) return null;
    const index = attachment['index'];
    const name = attachment['name'];
    const size = attachment['size'];
    const sha256 = attachment['sha256'];
    const contentType = attachment['content_type'];
    const isInline = attachment['is_inline'];
    const contentId = attachment['content_id'];
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0
      || !nonEmptyString(name)
      || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
      || !nonEmptyString(sha256) || !/^[a-f0-9]{64}$/.test(sha256)
      || !nonEmptyString(contentType)
      || typeof isInline !== 'boolean'
      || (contentId !== null && !nonEmptyString(contentId))) return null;
    return {
      index,
      name,
      size,
      sha256,
      contentType,
      isInline,
      contentId,
    };
  });
  if (!attachments.every((attachment): attachment is MailPreviewAttachment => attachment !== null)) return null;
  return {
    sender: value['sender'],
    from: value['from'],
    replyTo,
    subject: value['subject'],
    body: value['body'],
    contentType: value['content_type'],
    to,
    cc,
    bcc,
    mailbox: value['mailbox'],
    attachments,
    extraHeaders: value['extra_headers'],
    deskUrl,
  };
}

function transportOperation(value: unknown, deskUrl: string, allowReviewOnly = false): TransportOperation | null {
  if (!isRecord(value)
    || !nonEmptyString(value['id'])
    || !nonEmptyString(value['account_id'])
    || !nonEmptyString(value['action'])
    || !nonEmptyString(value['digest'])
    || !nonEmptyString(value['state'])) {
    return null;
  }
  const reviewOnly = Object.hasOwn(value, 'review_only');
  if (reviewOnly && (!allowReviewOnly || value['review_only'] !== true
    || value['action'] !== 'whatsapp.send' || value['state'] !== 'pending'
    || Object.hasOwn(value, 'payload') || !isRecord(value['preview'])
    || !nonEmptyString(value['preview']['recipient'])
    || !Array.isArray(value['preview']['attachments']) || value['preview']['attachments'].length === 0)) return null;
  const payload = reviewOnly ? {} : value['payload'];
  if (!isRecord(payload)) return null;
  if (!reviewOnly && (value['action'] === 'whatsapp.send' || value['action'] === 'whatsapp.control_receipt')
    && (!nonEmptyString(payload['recipient']) || !Object.hasOwn(payload, 'content'))) return null;
  if (value['action'] === 'mail.send' && Object.hasOwn(value, 'preview_error')) return null;
  const preview = value['action'] === 'mail.send' ? mailPreview(value['preview'], deskUrl) : undefined;
  if (value['action'] === 'mail.send' && preview === null) return null;
  return {
    id: value['id'],
    accountId: value['account_id'],
    action: value['action'],
    payload,
    digest: value['digest'],
    state: value['state'],
    ...(reviewOnly ? { reviewOnly: true } : {}),
    ...(preview === undefined || preview === null ? {} : { preview }),
  };
}

function transportOperations(value: unknown, deskUrl: string, allowReviewOnly = false): TransportOperation[] | null {
  if (!Array.isArray(value)) return null;
  const operations = value.map((operation) => transportOperation(operation, deskUrl, allowReviewOnly));
  return operations.every((operation): operation is TransportOperation => operation !== null)
    ? operations
    : null;
}

function inboundResponse(value: unknown, deskUrl: string): TransportInboundResponse | null {
  if (!isRecord(value) || !nonEmptyString(value['kind'])) return null;
  if (value['kind'] === 'inbound') {
    const automationOperations = value['automation_operations'] === undefined
      ? []
      : transportOperations(value['automation_operations'], deskUrl);
    if (automationOperations === null) return null;
    const automationHoldsRaw = value['automation_holds'] === undefined ? [] : value['automation_holds'];
    if (!Array.isArray(automationHoldsRaw)) return null;
    const automationHolds = automationHoldsRaw.map((hold) => {
      if (!isRecord(hold) || !nonEmptyString(hold['rule_id']) || !nonEmptyString(hold['reason'])) return null;
      return { ruleId: hold['rule_id'], reason: hold['reason'] };
    });
    if (!automationHolds.every((hold): hold is TransportAutomationHold => hold !== null)) return null;
    return { kind: 'inbound', automationOperations, automationHolds };
  }
  if (value['kind'] === 'paused') {
    const receipt = transportOperation(value['receipt'], deskUrl);
    if (receipt === null
      || receipt.action !== 'whatsapp.control_receipt'
      || receipt.state !== 'approved') return null;
    return { kind: 'paused', receipt };
  }
  if (value['kind'] === 'decision') {
    const operations = transportOperations(value['operations'], deskUrl);
    return operations === null ? null : { kind: 'decision', operations };
  }
  if (value['kind'] !== 'review' || !isRecord(value['review'])) return null;
  const review = value['review'];
  const expiry = review['expires_at'];
  const expiresAt = typeof expiry === 'number' && Number.isSafeInteger(expiry)
    && expiry >= 0 && expiry <= 8_640_000_000_000_000
    ? new Date(expiry).toISOString()
    : nonEmptyString(expiry) ? expiry : null;
  if (!nonEmptyString(review['challenge']) || expiresAt === null || !Array.isArray(review['items'])) {
    return null;
  }
  const items = review['items'].map((item) => {
    if (!isRecord(item) || !nonEmptyString(item['id']) || !nonEmptyString(item['digest'])) return null;
    return { id: item['id'], digest: item['digest'] };
  });
  if (!items.every((item): item is { id: string; digest: string } => item !== null)) return null;
  const previews = transportOperations(review['previews'], deskUrl, true);
  if (previews === null || previews.length !== items.length) return null;
  const previewsById = new Map(previews.map((preview) => [preview.id, preview]));
  if (previewsById.size !== previews.length
    || items.some((item) => previewsById.get(item.id)?.digest !== item.digest)) return null;
  return {
    kind: 'review',
    review: {
      challenge: review['challenge'],
      items,
      previews,
      expiresAt,
      deskUrl,
    },
  };
}

/**
 * HTTP client for the protected Agent365 authority. It has no approval endpoint
 * for agents: all decisions originate at the separately authenticated authority
 * ingress. The bearer is supplied only by the service-principal factory below.
 */
export class OperationsAuthorityClient implements OperationsAuthorityPort {
  private readonly baseUrl: URL;
  private readonly deskUrl: string;
  private readonly fetchImpl: AuthorityFetch;
  private readonly options: OperationsAuthorityClientOptions;

  constructor(options: OperationsAuthorityClientOptions) {
    this.options = options;
    const baseUrl = parseTransportAuthorityUrl(options.baseUrl);
    if (baseUrl === null) {
      throw new TransportAuthorityUnavailableError(`transport authority base URL ${TRANSPORT_AUTHORITY_URL_REQUIREMENT}`);
    }
    this.baseUrl = baseUrl;
    // The authority origin is configured by the service operator, not supplied
    // by a held operation. Keep the review link on that trusted origin so a
    // large, complete mail preview has a controlled Desk route.
    this.deskUrl = new URL('/operation-review', this.baseUrl).toString();
    if (!nonEmptyString(options.accountId) || !nonEmptyString(options.bearerToken)) {
      throw new TransportAuthorityUnavailableError('transport authority account or credential is unavailable');
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async readyOperations(signal?: AbortSignal): Promise<ReadyTransportReference[]> {
    const response = await this.post('/operations/transport/ready', { account_id: this.options.accountId }, signal);
    if (response.status !== 200 || !isRecord(response.body)
      || Object.keys(response.body).length !== 1 || !Array.isArray(response.body['items'])
      || response.body['items'].length > 100) {
      throw new TransportAuthorityUnavailableError('transport authority ready list is malformed');
    }
    const items = response.body['items'].map((item): ReadyTransportReference => {
      if (!isRecord(item) || Object.keys(item).length !== 2
        || !nonEmptyString(item['id']) || !nonEmptyString(item['digest'])) {
        throw new TransportAuthorityUnavailableError('transport authority ready reference is malformed');
      }
      return { id: item['id'], digest: item['digest'] };
    });
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw new TransportAuthorityUnavailableError('transport authority ready references are duplicated');
    }
    return items;
  }

  async readyOperation(reference: ReadyTransportReference, signal?: AbortSignal): Promise<TransportOperation> {
    const response = await this.post('/operations/transport/ready', {
      account_id: this.options.accountId, operation_id: reference.id, payload_digest: reference.digest,
    }, signal);
    const operation = isRecord(response.body) && Object.keys(response.body).length === 1
      ? transportOperation(response.body['operation'], this.deskUrl) : null;
    if (response.status !== 200 || operation === null || operation.accountId !== this.options.accountId
      || operation.action !== 'whatsapp.send' || operation.state !== 'approved'
      || operation.id !== reference.id || operation.digest !== reference.digest) {
      throw new TransportAuthorityUnavailableError('transport authority ready snapshot is unavailable');
    }
    return operation;
  }

  async admit(input: TransportAdmissionInput): Promise<TransportAdmission> {
    const response = await this.post('/operations/transport/admit', {
      account_id: this.options.accountId,
      action: 'whatsapp.send',
      adapter_version: TRANSPORT_AUTHORITY_ADAPTER_VERSION,
      payload: {
        recipient: input.recipient,
        content: input.content,
        ...(input.options === undefined ? {} : { options: input.options }),
      },
      ...(input.context === undefined
        ? {}
        : { context: { inbound_event_id: input.context.inbound_event_id } }),
      ...(input.operationId === undefined ? {} : { operation_id: input.operationId }),
    }, currentTransportSendSignal());

    if (response.status === 409
      && isRecord(response.body)
      && response.body['detail'] === 'approval_required') {
      throw new TransportApprovalRequiredError(
        nonEmptyString(response.body['operation_id']) ? response.body['operation_id'] : null,
      );
    }
    if (response.status < 200 || response.status >= 300 || !isRecord(response.body)) {
      throw new TransportAuthorityUnavailableError('transport authority admission was not accepted');
    }
    if (!nonEmptyString(response.body['attempt_id'])
      || !nonEmptyString(response.body['payload_digest'])
      || response.body['state'] !== 'dispatching') {
      throw new TransportAuthorityUnavailableError('transport authority admission response is malformed');
    }
    return {
      attemptId: response.body['attempt_id'],
      payloadDigest: response.body['payload_digest'],
    };
  }

  async recordReceipt(input: TransportReceiptInput): Promise<void> {
    const response = await this.post(`/operations/transport/receipts/${encodeURIComponent(input.attemptId)}`, {
      account_id: this.options.accountId,
      state: input.state,
      ...(input.providerId === undefined ? {} : { provider_id: input.providerId }),
    });
    const operation = transportOperation(response.body, this.deskUrl);
    if (response.status < 200 || response.status >= 300
      || operation === null
      || operation.accountId !== this.options.accountId
      || operation.state !== input.state
      || !isRecord(response.body)
      || response.body['attempt_id'] !== input.attemptId
      || response.body['provider_id'] !== (input.providerId ?? null)) {
      throw new TransportAuthorityUnavailableError('transport authority receipt response is malformed');
    }
  }

  async registerInbound(input: TransportInboundInput): Promise<TransportInboundResponse> {
    const response = await this.post('/operations/transport/inbound', {
      account_id: this.options.accountId,
      event_id: input.eventId,
      sender: input.sender,
      conversation: input.conversation,
      received_at: input.receivedAt,
      ...(input.text === undefined ? {} : { text: input.text }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new TransportAuthorityUnavailableError('transport authority inbound registration was not accepted');
    }
    const registered = inboundResponse(response.body, this.deskUrl);
    if (registered === null) {
      throw new TransportAuthorityUnavailableError('transport authority inbound response is malformed');
    }
    return registered;
  }

  async closeInbound(input: { eventId: string }): Promise<void> {
    const response = await this.post('/operations/transport/close', {
      account_id: this.options.accountId,
      event_id: input.eventId,
    });
    if (response.status < 200 || response.status >= 300
      || !isRecord(response.body)
      || response.body['closed'] !== true) {
      throw new TransportAuthorityUnavailableError('transport authority inbound close response is malformed');
    }
  }

  async recordDecision(input: TransportDecisionInput): Promise<void> {
    const response = await this.post('/operations/transport/decision', {
      account_id: this.options.accountId,
      event_id: input.eventId,
      operation_ids: input.operationIds,
      digests: input.digests,
      challenge: input.challenge,
      approve: input.approve ?? true,
    });
    const operations = transportOperations(response.body, this.deskUrl);
    const expectedState = (input.approve ?? true) ? 'approved' : 'cancelled';
    const expected = new Map(input.operationIds.map((id, index) => [id, input.digests[index]]));
    if (response.status < 200 || response.status >= 300
      || operations === null
      || operations.length !== expected.size
      || operations.some((operation) => operation.accountId !== this.options.accountId
        || operation.state !== expectedState
        || expected.get(operation.id) !== operation.digest)) {
      throw new TransportAuthorityUnavailableError('transport authority decision response is malformed');
    }
  }

  async pause(input: { eventId: string }): Promise<void> {
    const response = await this.post('/operations/transport/pause', {
      account_id: this.options.accountId,
      event_id: input.eventId,
    });
    if (response.status < 200 || response.status >= 300
      || !isRecord(response.body)
      || response.body['paused'] !== true
      || !Number.isSafeInteger(response.body['generation'])
      || !Array.isArray(response.body['in_flight_or_unknown'])
      || !response.body['in_flight_or_unknown'].every(nonEmptyString)) {
      throw new TransportAuthorityUnavailableError('transport authority pause response is malformed');
    }
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    deadlineSignal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    if (deadlineSignal?.aborted) {
      throw new TransportAuthorityUnavailableError('transport authority request failed');
    }
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), AUTHORITY_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    const signal = deadlineSignal === undefined
      ? timeoutController.signal
      : AbortSignal.any([timeoutController.signal, deadlineSignal]);
    const request = (async () => {
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      });
      if (signal.aborted) {
        await response.body?.cancel();
        throw abortError(signal);
      }

      let parsed: unknown;
      try {
        parsed = await readAuthorityJson(response, signal);
      } catch (error) {
        if (error instanceof TransportAuthorityUnavailableError) throw error;
        if (response.status >= 200 && response.status < 300) {
          throw new TransportAuthorityUnavailableError('transport authority response is not JSON');
        }
        parsed = null;
      }
      return { status: response.status, body: parsed };
    })();
    try {
      return await awaitWithAbort(request, signal);
    } catch (error) {
      if (error instanceof TransportAuthorityUnavailableError) throw error;
      throw new TransportAuthorityUnavailableError('transport authority request failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface ProtectedOperationsAuthorityConfig {
  baseUrl: string;
  accountId: string;
  credentialFile: string;
  serviceUid: number;
  workerUid: number;
}

/**
 * Build a client from a credential readable only by the transport service
 * principal. The agent worker must run under the separately attested `workerUid`;
 * this factory neither reads environment credentials nor exports the bearer.
 */
export function createProtectedOperationsAuthorityClient(
  config: ProtectedOperationsAuthorityConfig,
  dependencies: { fetch?: AuthorityFetch; getuid?: () => number | undefined } = {},
): OperationsAuthorityClient {
  const getuid = dependencies.getuid ?? process.getuid?.bind(process);
  const actualUid = getuid?.();
  if (!Number.isSafeInteger(actualUid) || actualUid !== config.serviceUid) {
    throw new TransportAuthorityUnavailableError('transport authority service UID attestation failed');
  }
  if (!Number.isSafeInteger(config.workerUid) || config.workerUid < 0 || config.workerUid === config.serviceUid) {
    throw new TransportAuthorityUnavailableError('transport authority requires distinct service and worker identities');
  }
  if (!isAbsolute(config.credentialFile)) {
    throw new TransportAuthorityUnavailableError('transport authority credential path must be absolute');
  }

  let initial;
  try {
    initial = lstatSync(config.credentialFile);
  } catch {
    throw new TransportAuthorityUnavailableError('transport authority credential file is unavailable');
  }
  if (initial.isSymbolicLink() || !initial.isFile() || initial.uid !== config.serviceUid) {
    throw new TransportAuthorityUnavailableError('transport authority credential file ownership is invalid');
  }
  if ((initial.mode & 0o777) !== 0o600) {
    throw new TransportAuthorityUnavailableError('transport authority credential file mode must be 0600');
  }

  let descriptor: number | undefined;
  let bearerToken: string;
  try {
    descriptor = openSync(config.credentialFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== config.serviceUid || (opened.mode & 0o777) !== 0o600
      || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw new TransportAuthorityUnavailableError('transport authority credential file changed during verification');
    }
    bearerToken = readFileSync(descriptor, 'utf8').trim();
  } catch (err) {
    if (err instanceof TransportAuthorityUnavailableError) throw err;
    throw new TransportAuthorityUnavailableError('transport authority credential file cannot be read safely');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (!nonEmptyString(bearerToken)) {
    throw new TransportAuthorityUnavailableError('transport authority credential is empty');
  }

  return new OperationsAuthorityClient({
    baseUrl: config.baseUrl,
    accountId: config.accountId,
    bearerToken,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
}
