// src/core/scheduled-payload.ts
// A10 — the single runtime contract for a scheduled_messages payload.
//
// Every writer (schedule-enqueue INSERT, update_scheduled UPDATE) and the
// scheduler's execution path decide sendability through decodeScheduledPayload,
// so a payload that could never become a send is refused before a due row
// exists, and a row that got in some other way (raw SQL, a restored backup, an
// older release) is dead-lettered instead of reaching the transport.
//
// The decoder BUILDS the send from allowlisted, type-checked fields. The parsed
// JSON is never forwarded as-is, so an unexpected key can never reach sendRaw
// or sendMedia. Reasons are fixed strings: no payload bytes.

import type { OutboundMedia } from './types.ts';
import { isRecord } from '../lib/type-guards.ts';

export const SCHEDULED_CONTENT_TYPES = ['text', 'image', 'video', 'audio', 'document', 'sticker'] as const;
export type ScheduledContentType = (typeof SCHEDULED_CONTENT_TYPES)[number];

/** Why a payload cannot be sent. Stable tokens: they are written to the row's `error` column. */
export type ScheduledPayloadShape =
  | 'not_json'
  | 'json_null'
  | 'json_primitive'
  | 'json_array'
  | 'unknown_content_type'
  | 'wrong_shape'
  | 'type_mismatch'
  | 'missing_media'
  | 'invalid_legacy_buffer';

export type ScheduledSend =
  | { kind: 'text'; content: { text: string } }
  | { kind: 'media'; media: OutboundMedia };

export type ScheduledPayloadVerdict =
  | { ok: true; send: ScheduledSend }
  | {
    ok: false;
    shape: ScheduledPayloadShape;
    /**
     * The JSON.parse message for `not_json` only. V8 echoes payload bytes in
     * it, so it is exposed separately and never folded into the reason.
     */
    parseError?: string;
  };

export interface ScheduledPayloadRow {
  content_type: string;
  payload: string;
  media_blob: Uint8Array | null;
}

type FieldKind = 'string' | 'boolean' | 'integer';

/**
 * Per-type field allowlist. `true` = required. Derived from every payload
 * builder since the table was introduced (c45bb7680 onward) and from the
 * OutboundMedia contract; `buffer` is the pre-SP9 legacy inline-bytes key.
 */
const MEDIA_FIELDS: Record<Exclude<ScheduledContentType, 'text'>, Record<string, [FieldKind, boolean]>> = {
  image: { caption: ['string', false], mimetype: ['string', false], viewOnce: ['boolean', false] },
  video: {
    caption: ['string', false], mimetype: ['string', false], ptv: ['boolean', false],
    gifPlayback: ['boolean', false], viewOnce: ['boolean', false],
  },
  audio: { mimetype: ['string', true], ptt: ['boolean', false], seconds: ['integer', false] },
  document: { filename: ['string', true], mimetype: ['string', true], caption: ['string', false] },
  sticker: { mimetype: ['string', false], isAnimated: ['boolean', false] },
};

function isScheduledContentType(value: string): value is ScheduledContentType {
  return (SCHEDULED_CONTENT_TYPES as readonly string[]).includes(value);
}

function matchesKind(value: unknown, kind: FieldKind): boolean {
  if (kind === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === kind;
}

function isByteArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255);
}

/** Legacy inline bytes: JSON.stringify(Buffer) = { type: 'Buffer', data: number[] }, or a bare number[]. */
function decodeLegacyBuffer(value: unknown): Buffer | null {
  if (isByteArray(value)) return Buffer.from(value);
  if (isRecord(value) && value['type'] === 'Buffer' && isByteArray(value['data'])) {
    return Buffer.from(value['data']);
  }
  return null;
}

function refuse(shape: ScheduledPayloadShape): ScheduledPayloadVerdict {
  return { ok: false, shape };
}

/** Decide whether a stored or about-to-be-stored row can become a send, and build that send. */
export function decodeScheduledPayload(row: ScheduledPayloadRow): ScheduledPayloadVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch (err) {
    return { ok: false, shape: 'not_json', parseError: err instanceof Error ? err.message : String(err) };
  }
  if (parsed === null) return refuse('json_null');
  if (Array.isArray(parsed)) return refuse('json_array');
  if (!isRecord(parsed)) return refuse('json_primitive');

  const contentType = row.content_type;
  if (!isScheduledContentType(contentType)) return refuse('unknown_content_type');

  if (contentType === 'text') {
    const keys = Object.keys(parsed);
    const text = parsed['text'];
    if (keys.length !== 1 || typeof text !== 'string' || text.length === 0) return refuse('wrong_shape');
    return { ok: true, send: { kind: 'text', content: { text } } };
  }

  if (parsed['type'] !== contentType) return refuse('type_mismatch');

  const allowed = MEDIA_FIELDS[contentType];
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'type' || key === 'buffer') continue;
    const spec = allowed[key];
    if (!spec || !matchesKind(value, spec[0])) return refuse('wrong_shape');
    fields[key] = value;
  }
  for (const [key, [, required]] of Object.entries(allowed)) {
    if (required && !(key in fields)) return refuse('wrong_shape');
  }

  let buffer: Buffer;
  if (row.media_blob && row.media_blob.byteLength > 0) {
    buffer = Buffer.from(row.media_blob);
  } else if ('buffer' in parsed) {
    const legacy = decodeLegacyBuffer(parsed['buffer']);
    if (!legacy) return refuse('invalid_legacy_buffer');
    buffer = legacy;
  } else {
    return refuse('missing_media');
  }

  return { ok: true, send: { kind: 'media', media: { type: contentType, ...fields, buffer } as OutboundMedia } };
}

/** The durable reason for a refused payload: `payload_undecodable shape=<class>`. */
export function payloadUndecodableReason(shape: ScheduledPayloadShape): string {
  return `payload_undecodable shape=${shape}`;
}

/**
 * Writer-side gate: throw before a row is inserted or changed if the scheduler
 * could never send it. The message carries the shape class, never payload bytes.
 */
export function assertScheduledPayloadWritable(contentType: string, payload: string, mediaBlob: Uint8Array | null): void {
  const verdict = decodeScheduledPayload({ content_type: contentType, payload, media_blob: mediaBlob });
  if (!verdict.ok) {
    throw new Error(`Invalid scheduled payload: ${payloadUndecodableReason(verdict.shape)}`);
  }
}
