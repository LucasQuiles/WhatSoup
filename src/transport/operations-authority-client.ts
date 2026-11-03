import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseTransportAuthorityUrl, TRANSPORT_AUTHORITY_URL_REQUIREMENT } from '../lib/authority-url.ts';
import { isRecord } from '../lib/type-guards.ts';

export const TRANSPORT_AUTHORITY_ADAPTER_VERSION = 1;

export interface TransportInboundContext {
  inbound_event_id: string;
  /** Present only when authority has released this exact held operation. */
  operation_id?: string;
}

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
  /** Required for mail.send review operations, absent for non-mail operations. */
  preview?: MailSendPreview;
}

export interface TransportReview {
  challenge: string;
  items: Array<{ id: string; digest: string }>;
  previews: TransportOperation[];
  expiresAt: string;
}

export interface TransportAutomationHold {
  ruleId: string;
  reason: string;
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

  constructor(message: string) {
    super(message);
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

function transportOperation(value: unknown, deskUrl: string): TransportOperation | null {
  if (!isRecord(value)
    || !nonEmptyString(value['id'])
    || !nonEmptyString(value['account_id'])
    || !nonEmptyString(value['action'])
    || !nonEmptyString(value['digest'])
    || !nonEmptyString(value['state'])
    || !isRecord(value['payload'])) {
    return null;
  }
  if ((value['action'] === 'whatsapp.send' || value['action'] === 'whatsapp.control_receipt')
    && (!nonEmptyString(value['payload']['recipient']) || !Object.hasOwn(value['payload'], 'content'))) return null;
  if (value['action'] === 'mail.send' && Object.hasOwn(value, 'preview_error')) return null;
  const preview = value['action'] === 'mail.send' ? mailPreview(value['preview'], deskUrl) : undefined;
  if (value['action'] === 'mail.send' && preview === null) return null;
  return {
    id: value['id'],
    accountId: value['account_id'],
    action: value['action'],
    payload: value['payload'],
    digest: value['digest'],
    state: value['state'],
    ...(preview === undefined || preview === null ? {} : { preview }),
  };
}

function transportOperations(value: unknown, deskUrl: string): TransportOperation[] | null {
  if (!Array.isArray(value)) return null;
  const operations = value.map((operation) => transportOperation(operation, deskUrl));
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
  if (!nonEmptyString(review['challenge']) || !nonEmptyString(review['expires_at']) || !Array.isArray(review['items'])) {
    return null;
  }
  const items = review['items'].map((item) => {
    if (!isRecord(item) || !nonEmptyString(item['id']) || !nonEmptyString(item['digest'])) return null;
    return { id: item['id'], digest: item['digest'] };
  });
  if (!items.every((item): item is { id: string; digest: string } => item !== null)) return null;
  const previews = transportOperations(review['previews'], deskUrl);
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
      expiresAt: review['expires_at'],
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
    }, true);

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
    }, true);
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
    }, true);
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
    }, true);
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
    }, true);
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
    }, true);
    if (response.status < 200 || response.status >= 300
      || !isRecord(response.body)
      || response.body['paused'] !== true
      || !Number.isSafeInteger(response.body['generation'])
      || !Array.isArray(response.body['in_flight_or_unknown'])
      || !response.body['in_flight_or_unknown'].every(nonEmptyString)) {
      throw new TransportAuthorityUnavailableError('transport authority pause response is malformed');
    }
  }

  private async post(path: string, body: Record<string, unknown>, parseBody: boolean): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TransportAuthorityUnavailableError('transport authority request failed');
    }

    if (!parseBody) return { status: response.status, body: null };
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      if (response.status >= 200 && response.status < 300) {
        throw new TransportAuthorityUnavailableError('transport authority response is not JSON');
      }
      parsed = null;
    }
    return { status: response.status, body: parsed };
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
