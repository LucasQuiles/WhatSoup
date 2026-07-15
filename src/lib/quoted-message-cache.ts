/**
 * Quoted-message metadata cache.
 *
 * When the outbound adapter needs to quote (reply to) a prior inbound message,
 * it needs the original message's sender JID and preview text. Re-fetching that
 * metadata from the Baileys store on every outbound quote adds latency and
 * store churn. This cache holds the metadata from the inbound path so the
 * outbound path can look it up by message ID in O(1).
 *
 * Insertion-time TTL with LRU-style eviction:
 *  - Entries expire after `ttlMs` (default 10 min).
 *  - When the cache is full, the oldest-inserted entry is evicted (FIFO, which
 *    is a close-enough approximation of LRU for short-TTL caches and avoids the
 *    overhead of re-ordering on every read).
 *
 * Factory pattern (`createQuotedMessageCache`) so each account or test case gets
 * an isolated instance — no module-level singleton state.
 */

/** Metadata needed to render an outbound quote for a prior inbound message. */
export interface QuotedMessageMeta {
  /** Sender JID of the original message (group participants only). */
  participant?: string;
  /** E.164 phone number of the sender, if resolved. */
  participantE164?: string;
  /** Body / preview text of the original message. */
  body?: string;
  /** Whether the original message was sent by the bot itself. */
  fromMe?: boolean;
}

/** Options for {@link createQuotedMessageCache}. */
export interface QuotedMessageCacheOptions {
  /** Time-to-live per entry in ms. Default 600_000 (10 min). */
  ttlMs?: number;
  /** Maximum number of entries before oldest eviction. Default 500. */
  maxEntries?: number;
  /** Injected clock for testing. Default `Date.now`. */
  now?: () => number;
}

interface CacheEntry extends QuotedMessageMeta {
  ts: number;
}

export interface QuotedMessageCache {
  /** Store metadata for an inbound message. No-op if any key part is empty. */
  cache(accountId: string, remoteJid: string, messageId: string, meta: QuotedMessageMeta): void;
  /** Look up metadata, returning `undefined` if missing or expired. */
  lookup(accountId: string, remoteJid: string, messageId: string): QuotedMessageMeta | undefined;
  /** Current number of live (non-expired) entries. Expires stale entries lazily. */
  size(): number;
  /** Remove all entries. */
  clear(): void;
}

function makeKey(accountId: string, remoteJid: string, messageId: string): string {
  return `${accountId}:${remoteJid}:${messageId}`;
}

export function createQuotedMessageCache(options: QuotedMessageCacheOptions = {}): QuotedMessageCache {
  const ttlMs = options.ttlMs ?? 600_000;
  const maxEntries = options.maxEntries ?? 500;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  function evictIfFull(): void {
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
  }

  return {
    cache(accountId, remoteJid, messageId, meta) {
      if (!accountId || !messageId || !remoteJid) {
        return;
      }
      const key = makeKey(accountId, remoteJid, messageId);
      // Only evict when inserting a genuinely new key — overwriting an
      // existing entry does not grow the cache, so no eviction is needed.
      if (!cache.has(key)) {
        evictIfFull();
      }
      cache.set(key, { ...meta, ts: now() });
    },

    lookup(accountId, remoteJid, messageId) {
      const key = makeKey(accountId, remoteJid, messageId);
      const entry = cache.get(key);
      if (!entry) {
        return undefined;
      }
      if (now() - entry.ts > ttlMs) {
        cache.delete(key);
        return undefined;
      }
      return {
        participant: entry.participant,
        participantE164: entry.participantE164,
        body: entry.body,
        fromMe: entry.fromMe,
      };
    },

    size() {
      const cutoff = now() - ttlMs;
      let live = 0;
      for (const [key, entry] of cache) {
        if (entry.ts <= cutoff) {
          cache.delete(key);
        } else {
          live++;
        }
      }
      return live;
    },

    clear() {
      cache.clear();
    },
  };
}
