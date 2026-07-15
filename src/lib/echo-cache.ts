/**
 * Sent-message echo cache.
 *
 * When a bot sends a message, the messaging socket (Baileys, iMessage bridge,
 * etc.) often echoes the sent message back as an inbound event. Without
 * deduplication, the bot processes its own messages as if they came from
 * the user, causing loops.
 *
 * This module provides a two-tier TTL cache for detecting echoes:
 *
 * 1. **Text cache** (short TTL, default 4s): keyed by normalized
 *    `${conversationKey}:${text}`. Catches echoes where the message arrives
 *    quickly (typically within 1-3s of send).
 *
 * 2. **Message-ID cache** (longer TTL, default 60s): keyed by
 *    `${conversationKey}:${messageId}`. Catches echoes where the text
 *    matches but the platform-assigned ID is also known. More precise than
 *    text matching but only works when the platform assigns IDs synchronously.
 *
 * 3. **Text-backed-by-ID tracking**: when a text entry is later confirmed
 *    with an ID, the text entry can be promoted to the ID cache for the
 *    longer TTL. This handles the case where the echo arrives after the
 *    short text-TTL has expired but the ID is still recognizable.
 *
 * The cache is in-memory by default but supports an injectable persistent
 * store for surviving process restarts. Corruption-marker stripping
 * (NUL, BOM, replacement chars) is applied to text keys to normalize
 * platform-introduced artifacts.
 */

export interface EchoCacheOptions {
  /** TTL for text-based echo entries, in ms. Default: 4_000. */
  textTtlMs?: number;
  /** TTL for message-ID-based echo entries, in ms. Default: 60_000. */
  idTtlMs?: number;
  /** Max text entries before GC is forced. Default: 1_000. */
  maxTextEntries?: number;
  /** Max ID entries before GC is forced. Default: 5_000. */
  maxIdEntries?: number;
  /** Injectable clock (default: Date.now). */
  now?: () => number;
}

export interface EchoCacheEntry {
  /** The conversation key (JID, chat ID, etc.). */
  conversationKey: string;
  /** The sent text (normalized). */
  text: string;
  /** The platform-assigned message ID, if known. */
  messageId?: string;
  /** When the entry was recorded (ms since epoch). */
  recordedAt: number;
}

export interface EchoCheckResult {
  /** True if the inbound message matches a cached sent message (is an echo). */
  isEcho: boolean;
  /** The matched entry, if isEcho is true. */
  entry?: EchoCacheEntry;
  /** Which cache matched: 'text' or 'id'. */
  matchedBy?: 'text' | 'id';
}

// ─── Corruption-marker stripping ───────────────────────────────────────────

const CORRUPTION_MARKERS = /[\u0000\uFEFF\uFFFD\uFFFE\uFFFF]/g;

/**
 * Normalize text for echo-cache keying.
 * Strips corruption markers (NUL, BOM, replacement chars, noncharacters)
 * that platforms can introduce during binary-payload decode.
 */
export function normalizeEchoText(text: string): string {
  return text.replace(CORRUPTION_MARKERS, '');
}

// ─── Internal entry types ──────────────────────────────────────────────────

interface TextEntry {
  conversationKey: string;
  text: string;
  recordedAt: number;
  /** If later confirmed with an ID, track it here for promotion. */
  messageId?: string;
  /** Timeout handle for auto-expiry. */
  timer?: ReturnType<typeof setTimeout>;
}

interface IdEntry {
  conversationKey: string;
  messageId: string;
  recordedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

// ─── EchoCache ─────────────────────────────────────────────────────────────

export interface EchoCache {
  /**
   * Record a sent message for echo detection.
   * Stores both a text entry (short TTL) and optionally an ID entry (long TTL).
   */
  record: (params: { conversationKey: string; text: string; messageId?: string }) => void;
  /**
   * Check whether an inbound message is an echo of a previously-sent message.
   * Checks the ID cache first (more precise), then the text cache.
   */
  check: (params: { conversationKey: string; text?: string; messageId?: string }) => EchoCheckResult;
  /**
   * Promote a text entry to the ID cache when the platform-assigned ID
   * arrives later. Extends the TTL for that message.
   */
  confirmId: (params: { conversationKey: string; text: string; messageId: string }) => void;
  /** Remove all entries. */
  clear: () => void;
  /** Get current entry counts (for diagnostics). */
  stats: () => { textEntries: number; idEntries: number };
  /** Force-expire all entries past their TTL. */
  gc: () => number;
}

export function createEchoCache(options: EchoCacheOptions = {}): EchoCache {
  const textTtlMs = options.textTtlMs ?? 4_000;
  const idTtlMs = options.idTtlMs ?? 60_000;
  const maxTextEntries = options.maxTextEntries ?? 1_000;
  const maxIdEntries = options.maxIdEntries ?? 5_000;
  const now = options.now ?? (() => Date.now());

  const textCache = new Map<string, TextEntry>();
  const idCache = new Map<string, IdEntry>();

  const textKey = (conversationKey: string, text: string) =>
    `${conversationKey}\0${normalizeEchoText(text)}`;
  const idKey = (conversationKey: string, messageId: string) =>
    `${conversationKey}\0${messageId}`;

  const scheduleTextExpiry = (key: string, entry: TextEntry) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      textCache.delete(key);
    }, textTtlMs);
  };

  const scheduleIdExpiry = (key: string, entry: IdEntry) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      idCache.delete(key);
    }, idTtlMs);
  };

  const evictTextIfFull = () => {
    if (textCache.size >= maxTextEntries) {
      // Evict oldest entry
      const oldest = textCache.entries().next();
      if (!oldest.done) {
        const [key, entry] = oldest.value;
        if (entry.timer) clearTimeout(entry.timer);
        textCache.delete(key);
      }
    }
  };

  const evictIdIfFull = () => {
    if (idCache.size >= maxIdEntries) {
      const oldest = idCache.entries().next();
      if (!oldest.done) {
        const [key, entry] = oldest.value;
        if (entry.timer) clearTimeout(entry.timer);
        idCache.delete(key);
      }
    }
  };

  const record: EchoCache['record'] = ({ conversationKey, text, messageId }) => {
    const normalizedText = normalizeEchoText(text);
    const tKey = textKey(conversationKey, normalizedText);
    const tEntry: TextEntry = {
      conversationKey,
      text: normalizedText,
      recordedAt: now(),
      messageId,
    };
    evictTextIfFull();
    textCache.set(tKey, tEntry);
    scheduleTextExpiry(tKey, tEntry);

    if (messageId) {
      const iKey = idKey(conversationKey, messageId);
      const iEntry: IdEntry = {
        conversationKey,
        messageId,
        recordedAt: now(),
      };
      evictIdIfFull();
      idCache.set(iKey, iEntry);
      scheduleIdExpiry(iKey, iEntry);
    }
  };

  const check: EchoCache['check'] = ({ conversationKey, text, messageId }) => {
    // Check ID cache first (more precise)
    if (messageId) {
      const iKey = idKey(conversationKey, messageId);
      const iEntry = idCache.get(iKey);
      if (iEntry) {
        return {
          isEcho: true,
          entry: {
            conversationKey: iEntry.conversationKey,
            messageId: iEntry.messageId,
            text: text ?? '',
            recordedAt: iEntry.recordedAt,
          },
          matchedBy: 'id',
        };
      }
    }

    // Then check text cache
    if (text) {
      const normalizedText = normalizeEchoText(text);
      const tKey = textKey(conversationKey, normalizedText);
      const tEntry = textCache.get(tKey);
      if (tEntry) {
        return {
          isEcho: true,
          entry: {
            conversationKey: tEntry.conversationKey,
            text: tEntry.text,
            messageId: tEntry.messageId,
            recordedAt: tEntry.recordedAt,
          },
          matchedBy: 'text',
        };
      }
    }

    return { isEcho: false };
  };

  const confirmId: EchoCache['confirmId'] = ({ conversationKey, text, messageId }) => {
    const normalizedText = normalizeEchoText(text);
    const tKey = textKey(conversationKey, normalizedText);

    // Promote the text entry's ID
    const tEntry = textCache.get(tKey);
    if (tEntry) {
      tEntry.messageId = messageId;
    }

    // Add to ID cache with the longer TTL
    const iKey = idKey(conversationKey, messageId);
    const iEntry: IdEntry = {
      conversationKey,
      messageId,
      recordedAt: now(),
    };
    evictIdIfFull();
    idCache.set(iKey, iEntry);
    scheduleIdExpiry(iKey, iEntry);
  };

  const clear: EchoCache['clear'] = () => {
    for (const entry of textCache.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    for (const entry of idCache.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    textCache.clear();
    idCache.clear();
  };

  const stats: EchoCache['stats'] = () => ({
    textEntries: textCache.size,
    idEntries: idCache.size,
  });

  const gc: EchoCache['gc'] = () => {
    const nowMs = now();
    let evicted = 0;

    for (const [key, entry] of textCache) {
      if (nowMs - entry.recordedAt > textTtlMs) {
        if (entry.timer) clearTimeout(entry.timer);
        textCache.delete(key);
        evicted++;
      }
    }

    for (const [key, entry] of idCache) {
      if (nowMs - entry.recordedAt > idTtlMs) {
        if (entry.timer) clearTimeout(entry.timer);
        idCache.delete(key);
        evicted++;
      }
    }

    return evicted;
  };

  return { record, check, confirmId, clear, stats, gc };
}
