import { AsyncLocalStorage } from 'node:async_hooks';
import {
  TransportAuthorityUnavailableError,
  type OperationsAuthorityPort,
  type TransportAdmission,
  type TransportInboundContext,
  type TransportInboundResponse,
  type TransportOperation,
  type TransportReview,
  type TransportReceiptInput,
} from './operations-authority-client.ts';

export { TransportAuthorityUnavailableError } from './operations-authority-client.ts';

export interface FrozenOutboundContent {
  /** JSON-safe exact snapshot submitted to the authority for its immutable digest. */
  approvalContent: unknown;
  /** Independent object and byte copies passed to Baileys after admission. */
  wireContent: unknown;
}

export interface FrozenOutboundOptions {
  /** JSON-safe exact snapshot submitted to the authority for its immutable digest. */
  approvalOptions: Record<string, unknown>;
  /** Independent object and byte copies passed to Baileys after admission. */
  wireOptions: Record<string, unknown>;
}

const MEDIA_KEYS = new Set(['image', 'video', 'audio', 'document', 'sticker']);
const inboundContext = new AsyncLocalStorage<TransportInboundContext>();

export function withTransportInboundContext<T>(
  context: TransportInboundContext,
  work: () => T,
): T {
  return inboundContext.run(context, work);
}

export function getTransportInboundContext(): TransportInboundContext | undefined {
  return inboundContext.getStore();
}

export interface TrustedInboundRegistration {
  eventId: string;
  sender: string;
  conversation: string;
  receivedAt: string;
  content: string | null;
}

/**
 * Register transport-authenticated ingress before it reaches the conversation
 * queue. The protected authority independently verifies the configured owner
 * identity and parses its stored inbound text; this client never treats a
 * caller-supplied sender or command as trusted on its own.
 */
export async function registerTrustedInbound<T>(
  authority: Pick<OperationsAuthorityPort, 'registerInbound' | 'closeInbound'>,
  inbound: TrustedInboundRegistration,
  deliver: (response: TransportInboundResponse) => T,
): Promise<T> {
  const response = await authority.registerInbound({
    eventId: inbound.eventId,
    sender: inbound.sender,
    conversation: inbound.conversation,
    receivedAt: inbound.receivedAt,
    ...(inbound.content === null ? {} : { text: inbound.content }),
  });
  // The authority parses owner commands from this stored authenticated event and
  // returns `paused` only after it has persisted the pause. Do not parse `/stop`
  // locally or enqueue this event before that server-side ordering is known.
  try {
    return await withTransportInboundContext(
      { inbound_event_id: inbound.eventId },
      () => Promise.resolve(deliver(response)),
    );
  } finally {
    // Closing is deliberately after the conversational callback settles. Any
    // failure to close propagates so the connection cannot treat the lease as
    // released locally when the authority still considers it active.
    await authority.closeInbound({ eventId: inbound.eventId });
  }
}

function reviewJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('not JSON');
    return encoded;
  } catch {
    throw new TransportAuthorityUnavailableError('transport review payload cannot be rendered safely');
  }
}

function commandToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new TransportAuthorityUnavailableError(`transport review ${label} is not a safe command token`);
  }
  return value;
}

// The established WhatsApp formatter splits ordinary assistant text at 4,000
// characters. A review card is one exact approval surface, so it must never be
// split or silently shortened into a card whose commands appear beside partial
// recipients, body, headers, or attachment metadata.
const REVIEW_CARD_MAX_CHARS = 4_000;

function renderMailPreview(preview: NonNullable<TransportOperation['preview']>): string {
  return [
    'Mail preview: server-verified semantic fields',
    `Sender: ${reviewJson(preview.sender)}`,
    `From: ${reviewJson(preview.from)}`,
    `Reply-To: ${reviewJson(preview.replyTo)}`,
    `Subject: ${reviewJson(preview.subject)}`,
    `Content-Type: ${reviewJson(preview.contentType)}`,
    `Body: ${reviewJson(preview.body)}`,
    `To: ${reviewJson(preview.to)}`,
    `Cc: ${reviewJson(preview.cc)}`,
    `Bcc: ${reviewJson(preview.bcc)}`,
    `Mailbox: ${reviewJson(preview.mailbox)}`,
    `Attachments: ${reviewJson(preview.attachments)}`,
    `Extra headers: ${reviewJson(preview.extraHeaders)}`,
    `Desk attachment download: ${reviewJson(preview.deskUrl)}`,
  ].join('\n');
}

/** Render exactly the authority-supplied review data; conversational code never sees it. */
export function renderTransportReviewCard(review: TransportReview): string {
  const challenge = commandToken(review.challenge, 'challenge');
  const ids = review.items.map((item) => commandToken(item.id, 'operation id'));
  const previews = review.previews.map((preview) => [
    `Operation: ${reviewJson(preview.id)}`,
    `Digest: ${reviewJson(preview.digest)}`,
    `Account: ${reviewJson(preview.accountId)}`,
    `Action: ${reviewJson(preview.action)}`,
    `State: ${reviewJson(preview.state)}`,
    ...(preview.action === 'mail.send' && preview.preview !== undefined
      ? [renderMailPreview(preview.preview)]
      : [`Payload: ${reviewJson(preview.payload)}`]),
  ].join('\n')).join('\n\n');
  const card = [
    'Transport review',
    `Challenge: ${challenge}`,
    `Expires: ${reviewJson(review.expiresAt)}`,
    '',
    previews,
    '',
    `Approve: /approve ${challenge} ${ids.join(' ')}`,
    `Reject: /reject ${challenge} ${ids.join(' ')}`,
  ].join('\n');
  if (card.length <= REVIEW_CARD_MAX_CHARS) return card;

  // Do not emit executable approval commands beside a partial representation.
  // The Desk location is server-configured, and all semantic content remains
  // available there for the human reviewer without truncating this card.
  const deskUrls = [...new Set(review.previews
    .filter((preview) => preview.action === 'mail.send')
    .map((preview) => preview.preview?.deskUrl)
    .filter((url): url is string => url !== undefined))];
  return [
    'Transport review exceeds the WhatsApp review-card limit.',
    'No approval or rejection command is shown because no partial review is valid.',
    ...(deskUrls.length === 0
      ? ['Open Agent365 Desk for the complete review.']
      : deskUrls.map((url) => `Open Agent365 Desk for the complete review and attachment download: ${url}`)),
  ].join('\n');
}

function fromApprovedSnapshot(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (Array.isArray(value)) return value.map(fromApprovedSnapshot);
  if (value === undefined || typeof value !== 'object' || !isPlainObject(value)) {
    throw new TransportAuthorityUnavailableError('approved operation content is not a JSON payload');
  }
  const entries = Object.entries(value);
  if (entries.length === 1 && entries[0]?.[0] === '$binary') {
    const encoded = entries[0][1];
    if (typeof encoded !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new TransportAuthorityUnavailableError('approved operation binary payload is malformed');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) {
      throw new TransportAuthorityUnavailableError('approved operation binary payload is malformed');
    }
    return bytes;
  }
  return Object.fromEntries(entries.map(([key, child]) => [key, fromApprovedSnapshot(child)]));
}

export async function retryApprovedWhatsappOperations(input: {
  accountId: string;
  inboundEventId: string;
  operations: TransportOperation[];
  send(recipient: string, content: unknown, options?: Record<string, unknown>): Promise<unknown>;
}): Promise<void> {
  const retries = input.operations
    .filter((operation) => operation.accountId === input.accountId
      && operation.action === 'whatsapp.send'
      && operation.state === 'approved')
    .map((operation) => ({ operation, payload: whatsappDispatchPayload(operation) }));
  for (const { operation, payload } of retries) {
    await withTransportInboundContext({
      inbound_event_id: input.inboundEventId,
      operation_id: operation.id,
    }, () => input.send(payload.recipient, payload.content, payload.options));
  }
}

function whatsappDispatchPayload(operation: TransportOperation): {
  recipient: string;
  content: unknown;
  options?: Record<string, unknown>;
} {
  const recipient = operation.payload['recipient'];
  if (typeof recipient !== 'string' || recipient.length === 0 || !Object.hasOwn(operation.payload, 'content')) {
    throw new TransportAuthorityUnavailableError('approved WhatsApp operation payload is malformed');
  }
  let options: Record<string, unknown> | undefined;
  if (Object.hasOwn(operation.payload, 'options')) {
    const restored = fromApprovedSnapshot(operation.payload['options']);
    if (restored === null || typeof restored !== 'object' || Array.isArray(restored) || !isPlainObject(restored)) {
      throw new TransportAuthorityUnavailableError('approved WhatsApp operation options are malformed');
    }
    options = restored;
  }
  return {
    recipient,
    content: fromApprovedSnapshot(operation.payload['content']),
    ...(options === undefined ? {} : { options }),
  };
}

/**
 * Deliver only the authority-created, one-use stop receipt. It is deliberately
 * separate from normal approved WhatsApp work so a caller cannot turn any
 * operation into a paused-account acknowledgement.
 */
export async function sendFixedControlReceipt(input: {
  accountId: string;
  inboundEventId: string;
  receipt: TransportOperation;
  send(recipient: string, content: unknown, options?: Record<string, unknown>): Promise<unknown>;
}): Promise<void> {
  const { receipt } = input;
  if (receipt.accountId !== input.accountId
    || receipt.action !== 'whatsapp.control_receipt'
    || receipt.state !== 'approved') {
    throw new TransportAuthorityUnavailableError('authority control receipt is not eligible for dispatch');
  }
  const payload = whatsappDispatchPayload(receipt);
  await withTransportInboundContext({
    inbound_event_id: input.inboundEventId,
    operation_id: receipt.id,
  }, () => input.send(payload.recipient, payload.content, payload.options));
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStream(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { pipe?: unknown }).pipe === 'function';
}

function byteCopy(value: Uint8Array): Buffer {
  // Buffer.from(ArrayBuffer, offset, length) aliases the original backing store;
  // use the typed-array overload so post-admission caller mutation cannot alter
  // either the authority snapshot or the bytes handed to Baileys.
  return Buffer.from(value);
}

function freezeValue(value: unknown, visited: WeakSet<object>, mediaValue: boolean): FrozenOutboundContent {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { approvalContent: value, wireContent: value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TransportAuthorityUnavailableError('outbound content has a non-finite number');
    return { approvalContent: value, wireContent: value };
  }
  if (typeof value === 'undefined') {
    return { approvalContent: undefined, wireContent: undefined };
  }
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    throw new TransportAuthorityUnavailableError('outbound content cannot be frozen as JSON');
  }
  if (value instanceof URL) {
    throw new TransportAuthorityUnavailableError('URL-backed outbound content cannot be approved without frozen bytes');
  }
  if (isStream(value)) {
    throw new TransportAuthorityUnavailableError('stream-backed outbound content cannot be approved without frozen bytes');
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const copy = byteCopy(value);
    return {
      approvalContent: { $binary: copy.toString('base64') },
      wireContent: copy,
    };
  }
  if (Array.isArray(value)) {
    if (visited.has(value)) throw new TransportAuthorityUnavailableError('outbound content contains a cycle');
    visited.add(value);
    const approval: unknown[] = [];
    const wire: unknown[] = [];
    for (const item of value) {
      const frozen = freezeValue(item, visited, false);
      approval.push(frozen.approvalContent);
      wire.push(frozen.wireContent);
    }
    visited.delete(value);
    return { approvalContent: approval, wireContent: wire };
  }
  if (typeof value !== 'object' || !isPlainObject(value)) {
    throw new TransportAuthorityUnavailableError('outbound content has an unsupported object type');
  }
  if (visited.has(value)) throw new TransportAuthorityUnavailableError('outbound content contains a cycle');
  if (Object.keys(value).length === 1 && Object.hasOwn(value, '$binary')) {
    throw new TransportAuthorityUnavailableError('outbound content uses the reserved binary snapshot representation');
  }
  if (mediaValue && Object.hasOwn(value, 'url')) {
    throw new TransportAuthorityUnavailableError('URL-backed outbound content cannot be approved without frozen bytes');
  }

  visited.add(value);
  const approval: Record<string, unknown> = {};
  const wire: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new TransportAuthorityUnavailableError('outbound content contains a reserved prototype key');
    }
    if (typeof child === 'undefined') continue;
    if (MEDIA_KEYS.has(key) && typeof child === 'string') {
      throw new TransportAuthorityUnavailableError('path-backed outbound attachment cannot be approved without frozen bytes');
    }
    const frozen = freezeValue(child, visited, mediaValue || MEDIA_KEYS.has(key));
    approval[key] = frozen.approvalContent;
    wire[key] = frozen.wireContent;
  }
  visited.delete(value);
  return { approvalContent: approval, wireContent: wire };
}

/**
 * Produces one immutable authority snapshot and a separate byte/object copy for
 * the provider. Streams, remote URLs, and filesystem-path attachments fail
 * before admission because their eventual bytes cannot be truthfully approved.
 */
export function freezeOutboundContent(content: unknown): FrozenOutboundContent {
  return freezeValue(content, new WeakSet<object>(), false);
}

/**
 * Baileys' third sendMessage argument can change the audience (for example
 * `statusJidList`). It is part of the wire payload, never an unreviewed
 * passthrough. Options must be a plain object so they have a canonical JSON
 * authority representation and a separately copied provider representation.
 */
export function freezeOutboundOptions(options: unknown): FrozenOutboundOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options) || !isPlainObject(options)) {
    throw new TransportAuthorityUnavailableError('outbound send options must be a plain JSON object');
  }
  const frozen = freezeValue(options, new WeakSet<object>(), false);
  const { approvalContent: approvalOptions, wireContent: wireOptions } = frozen;
  if (approvalOptions === null || typeof approvalOptions !== 'object'
    || wireOptions === null || typeof wireOptions !== 'object'
    || !isPlainObject(approvalOptions) || !isPlainObject(wireOptions)) {
    throw new TransportAuthorityUnavailableError('outbound send options could not be frozen');
  }
  return {
    approvalOptions,
    wireOptions,
  };
}

export interface AuthorityDispatch extends TransportAdmission {
  content: unknown;
  options?: Record<string, unknown>;
}

export interface OutboundAuthorityGate {
  admit(input: { recipient: string; content: unknown; options?: unknown }): Promise<AuthorityDispatch>;
  recordReceipt(input: TransportReceiptInput): Promise<void>;
}

/** Authority gate installed at the actual `sock.sendMessage` call boundary. */
export class FinalTransportAuthorityGate implements OutboundAuthorityGate {
  private readonly authority: Pick<OperationsAuthorityPort, 'admit' | 'recordReceipt'>;

  constructor(authority: Pick<OperationsAuthorityPort, 'admit' | 'recordReceipt'>) {
    this.authority = authority;
  }

  async admit(input: { recipient: string; content: unknown; options?: unknown }): Promise<AuthorityDispatch> {
    const frozen = freezeOutboundContent(input.content);
    const options = input.options === undefined ? undefined : freezeOutboundOptions(input.options);
    const activeInbound = getTransportInboundContext();
    const admission = await this.authority.admit({
      recipient: input.recipient,
      content: frozen.approvalContent,
      ...(options === undefined ? {} : { options: options.approvalOptions }),
      ...(activeInbound === undefined
        ? {}
        : { context: { inbound_event_id: activeInbound.inbound_event_id } }),
      ...(activeInbound?.operation_id === undefined
        ? {}
        : { operationId: activeInbound.operation_id }),
    });
    return {
      ...admission,
      content: frozen.wireContent,
      ...(options === undefined ? {} : { options: options.wireOptions }),
    };
  }

  recordReceipt(input: TransportReceiptInput): Promise<void> {
    return this.authority.recordReceipt(input);
  }
}

/** Used while enabled authority configuration has not been qualified or wired. */
export class FailClosedTransportAuthorityGate implements OutboundAuthorityGate {
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  async admit(): Promise<AuthorityDispatch> {
    throw new TransportAuthorityUnavailableError(this.reason);
  }

  async recordReceipt(): Promise<void> {
    throw new TransportAuthorityUnavailableError(this.reason);
  }
}
