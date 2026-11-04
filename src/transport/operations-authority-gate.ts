import { getTransportInboundContext, withTransportInboundContext } from '../core/transport-inbound-context.ts';
import {
  TransportAuthorityUnavailableError,
  type OperationsAuthorityPort,
  type TransportAdmission,
  type TransportInboundResponse,
  type TransportOperation,
  type TransportReview,
  type TransportReceiptInput,
} from './operations-authority-client.ts';

export { TransportAuthorityUnavailableError } from './operations-authority-client.ts';
export { getTransportInboundContext, withTransportInboundContext } from '../core/transport-inbound-context.ts';

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
const TEXT_SEMANTIC_KEYS = new Set(['text', 'mentions', 'linkPreview', 'viewOnce', 'contextInfo']);
const MEDIA_SEMANTIC_KEYS: Record<string, ReadonlySet<string>> = {
  image: new Set(['image', 'caption', 'mimetype', 'viewOnce']),
  document: new Set(['document', 'fileName', 'mimetype', 'caption']),
  audio: new Set(['audio', 'mimetype', 'ptt', 'seconds']),
  video: new Set(['video', 'caption', 'mimetype', 'ptv', 'gifPlayback', 'viewOnce']),
  sticker: new Set(['sticker', 'mimetype', 'isAnimated']),
};

// The media tool accepts files up to 50 MiB. Keep the operation snapshot at
// that provider boundary while reserving enough encoded space for base64 and
// metadata before any transport copy or decode is allocated.
const SNAPSHOT_MAX_DEPTH = 64;
const SNAPSHOT_MAX_NODES = 10_000;
const SNAPSHOT_MAX_KEYS_PER_OBJECT = 1_024;
const SNAPSHOT_MAX_KEY_BYTES = 4_096;
const SNAPSHOT_MAX_BINARY_BYTES = 50 * 1024 * 1024;
const SNAPSHOT_MAX_ENCODED_BYTES = 75 * 1024 * 1024;

interface SnapshotBudget {
  nodes: number;
  binaryBytes: number;
  encodedBytes: number;
}

function createSnapshotBudget(): SnapshotBudget {
  return { nodes: 0, binaryBytes: 0, encodedBytes: 0 };
}

function snapshotLimit(message: string): TransportAuthorityUnavailableError {
  return new TransportAuthorityUnavailableError(message);
}

function reserveSnapshotNode(budget: SnapshotBudget, label: string): void {
  budget.nodes += 1;
  if (budget.nodes > SNAPSHOT_MAX_NODES) {
    throw snapshotLimit(`${label} exceeds snapshot maximum nodes`);
  }
}

function reserveSnapshotBytes(budget: SnapshotBudget, bytes: number, label: string): void {
  budget.encodedBytes += bytes;
  if (budget.encodedBytes > SNAPSHOT_MAX_ENCODED_BYTES) {
    throw snapshotLimit(`${label} exceeds snapshot maximum encoded bytes`);
  }
}

function base64EncodedBytes(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function reserveSnapshotBinary(budget: SnapshotBudget, byteLength: number, label: string): void {
  budget.binaryBytes += byteLength;
  if (budget.binaryBytes > SNAPSHOT_MAX_BINARY_BYTES) {
    throw snapshotLimit(`${label} exceeds snapshot maximum binary bytes`);
  }
  reserveSnapshotBytes(budget, base64EncodedBytes(byteLength) + 2, label);
}

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f) {
      bytes += codePoint === 0x08 || codePoint === 0x09 || codePoint === 0x0a
        || codePoint === 0x0c || codePoint === 0x0d ? 2 : 6;
    } else if (codePoint === 0x22 || codePoint === 0x5c) {
      bytes += 2;
    } else if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      if (index + 1 < value.length) {
        const trailing = value.charCodeAt(index + 1);
        if (trailing >= 0xdc00 && trailing <= 0xdfff) {
          bytes += 4;
          index += 1;
          continue;
        }
      }
      bytes += 6;
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      bytes += 6;
    } else if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function reserveSnapshotString(budget: SnapshotBudget, value: string, label: string): void {
  reserveSnapshotBytes(budget, jsonStringBytes(value), label);
}

function assertSnapshotDepth(depth: number, label: string): void {
  if (depth > SNAPSHOT_MAX_DEPTH) {
    throw snapshotLimit(`${label} exceeds snapshot maximum depth`);
  }
}

function boundedObjectKeys(value: Record<string, unknown>, label: string): string[] {
  const keys: string[] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (keys.length >= SNAPSHOT_MAX_KEYS_PER_OBJECT) {
      throw snapshotLimit(`${label} exceeds snapshot maximum keys per object`);
    }
    if (jsonStringBytes(key) - 2 > SNAPSHOT_MAX_KEY_BYTES) {
      throw snapshotLimit(`${label} contains a key exceeding the snapshot maximum key bytes`);
    }
    keys.push(key);
  }
  return keys;
}

function reserveSnapshotContainer(budget: SnapshotBudget, label: string): void {
  reserveSnapshotBytes(budget, 2, label);
}

function reserveSnapshotObjectKey(
  budget: SnapshotBudget,
  key: string,
  position: number,
  label: string,
): void {
  reserveSnapshotString(budget, key, label);
  reserveSnapshotBytes(budget, position === 0 ? 1 : 2, label);
}

function reserveSnapshotArrayItem(budget: SnapshotBudget, position: number, label: string): void {
  if (position > 0) reserveSnapshotBytes(budget, 1, label);
}

function assertBase64LengthWithinBudget(value: string, budget: SnapshotBudget, label: string): void {
  if (value.length > base64EncodedBytes(SNAPSHOT_MAX_BINARY_BYTES - budget.binaryBytes)) {
    throw snapshotLimit(`${label} exceeds snapshot maximum binary bytes`);
  }
  if (value.length + 2 > SNAPSHOT_MAX_ENCODED_BYTES - budget.encodedBytes) {
    throw snapshotLimit(`${label} exceeds snapshot maximum encoded bytes`);
  }
}

function base64Value(charCode: number): number {
  if (charCode >= 65 && charCode <= 90) return charCode - 65;
  if (charCode >= 97 && charCode <= 122) return charCode - 71;
  if (charCode >= 48 && charCode <= 57) return charCode + 4;
  if (charCode === 43) return 62;
  if (charCode === 47) return 63;
  return -1;
}

function canonicalBase64DecodedBytes(value: string): number | null {
  if (value.length % 4 !== 0) return null;
  let firstPadding = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index);
    if (charCode === 61) {
      firstPadding = index;
      break;
    }
    if (base64Value(charCode) < 0) return null;
  }
  const padding = value.length - firstPadding;
  if (padding > 2) return null;
  for (let index = firstPadding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }
  if (padding === 1 && firstPadding % 4 !== 3) return null;
  if (padding === 2 && firstPadding % 4 !== 2) return null;
  if (padding > 0) {
    const finalData = base64Value(value.charCodeAt(firstPadding - 1));
    if ((padding === 1 && (finalData & 0b11) !== 0)
      || (padding === 2 && (finalData & 0b1111) !== 0)) return null;
  }
  return (value.length / 4) * 3 - padding;
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

function containsFrozenBinary(value: unknown): boolean {
  const pending = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === null || typeof item !== 'object' || visited.has(item)) continue;
    visited.add(item);
    if (Object.hasOwn(item, '$binary')) return true;
    for (const child of Object.values(item)) pending.push(child);
  }
  return false;
}

/** Render exactly the authority-supplied review data; conversational code never sees it. */
export function renderTransportReviewCard(review: TransportReview): string {
  if (review.previews.some((operation) => operation.reviewOnly === true || containsFrozenBinary(operation.payload))) {
    if (review.deskUrl === undefined) {
      throw new TransportAuthorityUnavailableError('media review requires the configured Desk URL');
    }
    return `Open Agent365 Desk to inspect the exact files and approve: ${review.deskUrl}`;
  }
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

function fromApprovedSnapshot(
  value: unknown,
  budget: SnapshotBudget,
  visited: WeakSet<object>,
  depth: number,
): unknown {
  if (value !== null && typeof value === 'object' && visited.has(value)) {
    throw new TransportAuthorityUnavailableError('approved operation snapshot contains a cycle');
  }
  reserveSnapshotNode(budget, 'approved operation snapshot');
  if (value === null) {
    reserveSnapshotBytes(budget, 4, 'approved operation snapshot');
    return value;
  }
  if (typeof value === 'string') {
    reserveSnapshotString(budget, value, 'approved operation snapshot');
    return value;
  }
  if (typeof value === 'boolean') {
    reserveSnapshotBytes(budget, value ? 4 : 5, 'approved operation snapshot');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TransportAuthorityUnavailableError('approved operation snapshot has a non-finite number');
    }
    reserveSnapshotBytes(budget, String(value).length, 'approved operation snapshot');
    return value;
  }
  if (Array.isArray(value)) {
    assertSnapshotDepth(depth, 'approved operation snapshot');
    reserveSnapshotContainer(budget, 'approved operation snapshot');
    visited.add(value);
    try {
      const restored: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        reserveSnapshotArrayItem(budget, index, 'approved operation snapshot');
        restored.push(fromApprovedSnapshot(value[index], budget, visited, depth + 1));
      }
      return restored;
    } finally {
      visited.delete(value);
    }
  }
  if (typeof value !== 'object' || !isPlainObject(value)) {
    throw new TransportAuthorityUnavailableError('approved operation content is not a JSON payload');
  }

  assertSnapshotDepth(depth, 'approved operation snapshot');
  reserveSnapshotContainer(budget, 'approved operation snapshot');
  visited.add(value);
  try {
    const keys = boundedObjectKeys(value, 'approved operation snapshot');
    if (keys.length === 1 && keys[0] === '$binary') {
      const encoded = value['$binary'];
      if (typeof encoded !== 'string') {
        throw new TransportAuthorityUnavailableError('approved operation binary payload is malformed');
      }
      reserveSnapshotObjectKey(budget, '$binary', 0, 'approved operation snapshot');
      assertBase64LengthWithinBudget(encoded, budget, 'approved operation binary payload');
      const decodedBytes = canonicalBase64DecodedBytes(encoded);
      if (decodedBytes === null) {
        throw new TransportAuthorityUnavailableError('approved operation binary payload is malformed');
      }
      reserveSnapshotBinary(budget, decodedBytes, 'approved operation binary payload');
      return Buffer.from(encoded, 'base64');
    }

    const restored: Record<string, unknown> = {};
    for (const [position, key] of keys.entries()) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new TransportAuthorityUnavailableError('approved operation snapshot contains a reserved prototype key');
      }
      reserveSnapshotObjectKey(budget, key, position, 'approved operation snapshot');
      restored[key] = fromApprovedSnapshot(value[key], budget, visited, depth + 1);
    }
    return restored;
  } finally {
    visited.delete(value);
  }
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
  const budget = createSnapshotBudget();
  let options: Record<string, unknown> | undefined;
  if (Object.hasOwn(operation.payload, 'options')) {
    const restored = fromApprovedSnapshot(operation.payload['options'], budget, new WeakSet<object>(), 0);
    if (restored === null || typeof restored !== 'object' || Array.isArray(restored) || !isPlainObject(restored)) {
      throw new TransportAuthorityUnavailableError('approved WhatsApp operation options are malformed');
    }
    options = restored;
  }
  return {
    recipient,
    content: fromApprovedSnapshot(operation.payload['content'], budget, new WeakSet<object>(), 0),
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

function hasOnlySemanticKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isInlineBinary(value: unknown): value is Buffer | Uint8Array {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isKnownReplyContext(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !isPlainObject(value)) return false;
  if (!hasOnlySemanticKeys(value, new Set(['stanzaId', 'participant', 'quotedMessage']))) return false;
  if (typeof value['stanzaId'] !== 'string' || typeof value['participant'] !== 'string') return false;
  const quotedMessage = value['quotedMessage'];
  return quotedMessage !== null
    && typeof quotedMessage === 'object'
    && !Array.isArray(quotedMessage)
    && isPlainObject(quotedMessage)
    && hasOnlySemanticKeys(quotedMessage, new Set(['conversation']))
    && typeof quotedMessage['conversation'] === 'string';
}

function isKnownTextContent(content: Record<string, unknown>): boolean {
  return typeof content['text'] === 'string'
    && hasOnlySemanticKeys(content, TEXT_SEMANTIC_KEYS)
    && (content['mentions'] === undefined
      || (Array.isArray(content['mentions']) && content['mentions'].every((mention) => typeof mention === 'string')))
    && (content['linkPreview'] === undefined || content['linkPreview'] === null)
    && isOptionalBoolean(content['viewOnce'])
    && isKnownReplyContext(content['contextInfo']);
}

function isKnownMediaContent(content: Record<string, unknown>): boolean {
  const mediaKeys = Object.keys(MEDIA_SEMANTIC_KEYS)
    .filter((key) => content[key] !== undefined);
  if (mediaKeys.length !== 1) return false;
  const mediaKey = mediaKeys[0]!;
  const allowedKeys = MEDIA_SEMANTIC_KEYS[mediaKey]!;
  if (!hasOnlySemanticKeys(content, allowedKeys) || !isInlineBinary(content[mediaKey])) return false;
  switch (mediaKey) {
    case 'image':
      return isOptionalString(content['caption'])
        && isOptionalString(content['mimetype'])
        && isOptionalBoolean(content['viewOnce']);
    case 'document':
      return typeof content['fileName'] === 'string'
        && isOptionalString(content['mimetype'])
        && isOptionalString(content['caption']);
    case 'audio':
      return isOptionalString(content['mimetype'])
        && isOptionalBoolean(content['ptt'])
        && (content['seconds'] === undefined
          || (typeof content['seconds'] === 'number' && Number.isFinite(content['seconds'])));
    case 'video':
      return isOptionalString(content['caption'])
        && isOptionalString(content['mimetype'])
        && isOptionalBoolean(content['ptv'])
        && isOptionalBoolean(content['gifPlayback'])
        && isOptionalBoolean(content['viewOnce']);
    case 'sticker':
      return isOptionalString(content['mimetype']) && isOptionalBoolean(content['isAnimated']);
    default:
      return false;
  }
}

function isKnownReplyOptions(options: unknown): boolean {
  if (options === undefined) return true;
  if (options === null || typeof options !== 'object' || Array.isArray(options) || !isPlainObject(options)) return false;
  return hasOnlySemanticKeys(options, new Set(['messageId']))
    && (options['messageId'] === undefined
      || (typeof options['messageId'] === 'string' && options['messageId'].length > 0));
}

function assertKnownOutboundSemantics(content: unknown, options: unknown): void {
  const knownContent = content !== null
    && typeof content === 'object'
    && !Array.isArray(content)
    && isPlainObject(content)
    && (isKnownTextContent(content) || isKnownMediaContent(content));
  if (!knownContent || !isKnownReplyOptions(options)) {
    throw new TransportAuthorityUnavailableError(
      'transport authority semantic adapter is required for this outbound payload or options',
    );
  }
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

function freezeValue(
  value: unknown,
  visited: WeakSet<object>,
  mediaValue: boolean,
  budget: SnapshotBudget,
  depth: number,
): FrozenOutboundContent {
  if (value !== null && typeof value === 'object' && visited.has(value)) {
    throw new TransportAuthorityUnavailableError('outbound content contains a cycle');
  }
  reserveSnapshotNode(budget, 'outbound content');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string') reserveSnapshotString(budget, value, 'outbound content');
    else reserveSnapshotBytes(budget, value === false ? 5 : 4, 'outbound content');
    return { approvalContent: value, wireContent: value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TransportAuthorityUnavailableError('outbound content has a non-finite number');
    reserveSnapshotBytes(budget, String(value).length, 'outbound content');
    return { approvalContent: value, wireContent: value };
  }
  if (typeof value === 'undefined') {
    reserveSnapshotBytes(budget, 4, 'outbound content');
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
    assertSnapshotDepth(depth, 'outbound content');
    reserveSnapshotContainer(budget, 'outbound content');
    reserveSnapshotObjectKey(budget, '$binary', 0, 'outbound content');
    reserveSnapshotBinary(budget, value.byteLength, 'outbound content');
    const copy = byteCopy(value);
    return {
      approvalContent: { $binary: copy.toString('base64') },
      wireContent: copy,
    };
  }
  if (Array.isArray(value)) {
    assertSnapshotDepth(depth, 'outbound content');
    reserveSnapshotContainer(budget, 'outbound content');
    visited.add(value);
    try {
      const approval: unknown[] = [];
      const wire: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        reserveSnapshotArrayItem(budget, index, 'outbound content');
        const frozen = freezeValue(value[index], visited, false, budget, depth + 1);
        approval.push(frozen.approvalContent);
        wire.push(frozen.wireContent);
      }
      return { approvalContent: approval, wireContent: wire };
    } finally {
      visited.delete(value);
    }
  }
  if (typeof value !== 'object' || !isPlainObject(value)) {
    throw new TransportAuthorityUnavailableError('outbound content has an unsupported object type');
  }
  assertSnapshotDepth(depth, 'outbound content');
  reserveSnapshotContainer(budget, 'outbound content');
  if (mediaValue && Object.hasOwn(value, 'url')) {
    throw new TransportAuthorityUnavailableError('URL-backed outbound content cannot be approved without frozen bytes');
  }

  visited.add(value);
  try {
    const keys = boundedObjectKeys(value, 'outbound content');
    if (keys.length === 1 && keys[0] === '$binary') {
      throw new TransportAuthorityUnavailableError('outbound content uses the reserved binary snapshot representation');
    }
    const approval: Record<string, unknown> = {};
    const wire: Record<string, unknown> = {};
    let emittedProperties = 0;
    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new TransportAuthorityUnavailableError('outbound content contains a reserved prototype key');
      }
      const child = value[key];
      if (typeof child === 'undefined') continue;
      reserveSnapshotObjectKey(budget, key, emittedProperties, 'outbound content');
      emittedProperties += 1;
      if (MEDIA_KEYS.has(key) && typeof child === 'string') {
        throw new TransportAuthorityUnavailableError('path-backed outbound attachment cannot be approved without frozen bytes');
      }
      const frozen = freezeValue(child, visited, mediaValue || MEDIA_KEYS.has(key), budget, depth + 1);
      approval[key] = frozen.approvalContent;
      wire[key] = frozen.wireContent;
    }
    return { approvalContent: approval, wireContent: wire };
  } finally {
    visited.delete(value);
  }
}

/**
 * Produces one immutable authority snapshot and a separate byte/object copy for
 * the provider. Streams, remote URLs, and filesystem-path attachments fail
 * before admission because their eventual bytes cannot be truthfully approved.
 */
export function freezeOutboundContent(content: unknown): FrozenOutboundContent {
  return freezeValue(content, new WeakSet<object>(), false, createSnapshotBudget(), 0);
}

/**
 * Baileys' third sendMessage argument can change the audience (for example
 * `statusJidList`). It is part of the wire payload, never an unreviewed
 * passthrough. Options must be a plain object so they have a canonical JSON
 * authority representation and a separately copied provider representation.
 */
export function freezeOutboundOptions(options: unknown): FrozenOutboundOptions {
  return freezeOutboundOptionsWithBudget(options, createSnapshotBudget());
}

function freezeOutboundOptionsWithBudget(options: unknown, budget: SnapshotBudget): FrozenOutboundOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options) || !isPlainObject(options)) {
    throw new TransportAuthorityUnavailableError('outbound send options must be a plain JSON object');
  }
  const frozen = freezeValue(options, new WeakSet<object>(), false, budget, 0);
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
    const budget = createSnapshotBudget();
    const frozen = freezeValue(input.content, new WeakSet<object>(), false, budget, 0);
    const options = input.options === undefined ? undefined : freezeOutboundOptionsWithBudget(input.options, budget);
    assertKnownOutboundSemantics(frozen.wireContent, options?.wireOptions);
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
