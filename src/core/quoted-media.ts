// src/core/quoted-media.ts
// SP10 — Extract quoted message media from a WAMessage's contextInfo.

/**
 * Message type fields that can carry a contextInfo with a quotedMessage.
 */
const CONTEXT_CARRIER_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'extendedTextMessage',
  'stickerMessage',
  'contactsArrayMessage',
  'locationMessage',
] as const;

/**
 * Message type fields that carry downloadable media inside quotedMessage.
 */
const DOWNLOADABLE_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
] as const;

export type QuotedMediaContentType = 'image' | 'video' | 'audio' | 'document' | 'sticker';

const DOWNLOADABLE_KEY_TO_CONTENT_TYPE: Readonly<Record<string, QuotedMediaContentType>> = {
  imageMessage:    'image',
  videoMessage:    'video',
  audioMessage:    'audio',
  documentMessage: 'document',
  stickerMessage:  'sticker',
};

export interface QuotedMediaResult {
  /**
   * Synthetic WAMessage compatible with Baileys' downloadMediaMessage().
   * Typed as unknown because the exact proto shape is internal to Baileys;
   * callers must pass it to downloadMediaMessage() as-is.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any;
  /**
   * Minimal WAMessageKey for logging / DB correlation.
   * Typed as unknown for the same reason as above.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  key: any;
  /** Detected content type of the quoted media. */
  contentType: QuotedMediaContentType;
}

// ---------------------------------------------------------------------------
// Internal narrowing helpers — avoid repetitive `as` casts in business logic
// ---------------------------------------------------------------------------

/** Returns the value only when it is a plain (non-array) object. */
function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Returns the value only when it is a non-empty string. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract quoted message media from a raw WAMessage (as stored in the DB).
 *
 * Traverses all possible message type fields to find contextInfo.quotedMessage,
 * then checks if the quotedMessage contains downloadable media. When found,
 * wraps it as a synthetic WAMessage compatible with Baileys' downloadMediaMessage().
 *
 * Returns null if no quoted media is found.
 */
export function extractQuotedMedia(rawMessage: unknown): QuotedMediaResult | null {
  const raw = asPlainObject(rawMessage);
  if (!raw) return null;

  const msgObj = asPlainObject(raw['message']);
  if (!msgObj) return null;

  for (const carrierKey of CONTEXT_CARRIER_KEYS) {
    const carrierObj = asPlainObject(msgObj[carrierKey]);
    if (!carrierObj) continue;

    const contextInfoObj = asPlainObject(carrierObj['contextInfo']);
    if (!contextInfoObj) continue;

    const quotedObj = asPlainObject(contextInfoObj['quotedMessage']);
    if (!quotedObj) continue;

    for (const dlKey of DOWNLOADABLE_KEYS) {
      const mediaNode = asPlainObject(quotedObj[dlKey]);
      if (!mediaNode) continue;

      const contentType = DOWNLOADABLE_KEY_TO_CONTENT_TYPE[dlKey];
      if (!contentType) continue; // defensive: unreachable given constant arrays

      // Resolve remoteJid from the outer message's key, falling back safely.
      const outerKey = asPlainObject(raw['key']);
      const remoteJid =
        asString(outerKey?.['remoteJid']) ?? 'unknown@s.whatsapp.net';

      // stanzaId identifies the original quoted message in WhatsApp's protocol.
      const stanzaId =
        asString(contextInfoObj['stanzaId']) ?? 'quoted';

      // Build a synthetic WAMessage.
      // Shape: { key, message: { <mediaType>: <mediaNode> } }
      // Baileys' downloadMediaMessage() reads message.message to find the media node.
      const syntheticMessage = {
        key: { remoteJid, id: stanzaId, fromMe: false as const },
        message: { [dlKey]: mediaNode },
      };

      return {
        message: syntheticMessage,
        key: syntheticMessage.key,
        contentType,
      };
    }
  }

  return null;
}
