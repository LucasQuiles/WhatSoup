/**
 * CatalogueSnapshotCache — in-memory coordinate snapshot for numbered-drill stability.
 *
 * When a user sees a catalogue (e.g., `/model` lists numbered options D1, D2, …),
 * this cache records the exact ordered list at that moment. When the user replies
 * with `/model N`, we resolve N (1-based index) against the snapshot they saw,
 * not a stale or changed list.
 *
 * Why: Dense dynamic numbering (D17) needs `/model N` to resolve against exactly
 * the list the user saw (invariant 6). This is a COORDINATE snapshot only —
 * NOT the dropped NL pending-store.
 *
 * Invariant 7: a pin stores the RESOLVED `(provider, model)` pair, so hiding an
 * unconfigured provider from the catalogue never breaks an existing pin.
 *
 * TTL: ~15 minutes. Latest snapshot supersedes earlier ones per chat.
 * Quoted-reply resolution: store by-msgId map for `/model N` with a quotedMsgId.
 */

export interface CatalogueEntry {
  providerId: string;
  id: string;
}

interface CatalogueSnapshot {
  msgId: string;
  entries: CatalogueEntry[];
  createdAt: number; // epoch ms
}

export interface CatalogueSnapshotCache {
  /**
   * Store the rendered catalogue snapshot for a chat.
   * entries = the catalogue in order; index+1 = the N the user sees.
   * Each entry is { providerId, id } (the resolved pair, invariant 7).
   */
  putCatalogueSnapshot(
    chatJid: string,
    outboundMsgId: string,
    entries: CatalogueEntry[]
  ): void;

  /**
   * Resolve N (1-based) against the snapshot for the quoted message id if given,
   * else the latest snapshot for the chat.
   * @returns { providerId, id } or null if miss (out of range / expired / no snapshot).
   */
  resolveCataloguePick(
    chatJid: string,
    n: number,
    opts?: { quotedMsgId?: string }
  ): CatalogueEntry | null;

  /**
   * Test helper: returns the current size of the byMsgId map.
   * Used to verify that expired entries are pruned and growth is bounded.
   */
  getMsgIdMapSize(): number;
}

const TTL_MS = 15 * 60_000; // 15 minutes

export function createCatalogueSnapshotCache(): CatalogueSnapshotCache {
  // chatJid → latest snapshot for that chat
  const latestByChat = new Map<string, CatalogueSnapshot>();

  // msgId → snapshot (for quoted-reply resolution)
  const byMsgId = new Map<string, CatalogueSnapshot>();

  function isExpired(snapshot: CatalogueSnapshot, now: number): boolean {
    return now - snapshot.createdAt >= TTL_MS;
  }

  return {
    putCatalogueSnapshot(chatJid: string, outboundMsgId: string, entries: CatalogueEntry[]): void {
      const now = Date.now();
      const snapshot: CatalogueSnapshot = {
        msgId: outboundMsgId,
        entries,
        createdAt: now,
      };

      // Store by msgId (for quoted-reply resolution)
      byMsgId.set(outboundMsgId, snapshot);

      // Prune expired entries from byMsgId to prevent unbounded growth
      // Walk through all entries and delete those older than TTL
      for (const [msgId, snap] of byMsgId) {
        if (isExpired(snap, now)) {
          byMsgId.delete(msgId);
        }
      }

      // Store as latest for this chat (replaces any prior snapshot)
      latestByChat.set(chatJid, snapshot);
    },

    resolveCataloguePick(
      chatJid: string,
      n: number,
      opts?: { quotedMsgId?: string }
    ): CatalogueEntry | null {
      const now = Date.now();

      let snapshot: CatalogueSnapshot | undefined;

      if (opts?.quotedMsgId) {
        // Resolve against the quoted message snapshot
        snapshot = byMsgId.get(opts.quotedMsgId);
      } else {
        // Resolve against the latest snapshot for this chat
        snapshot = latestByChat.get(chatJid);
      }

      if (!snapshot) {
        return null; // No snapshot found
      }

      if (isExpired(snapshot, now)) {
        return null; // Snapshot expired
      }

      // 1-based index: n=1 → entries[0], n=2 → entries[1], etc.
      const entry = snapshot.entries[n - 1];
      if (!entry) {
        return null; // Out of range
      }

      return entry;
    },

    getMsgIdMapSize(): number {
      return byMsgId.size;
    },
  };
}
