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
 * TTL: ~15 minutes. Latest snapshot supersedes earlier ones per (chat, sender)
 * — final-review Important-2: a group render is per-SENDER, not per-chat, so
 * a second/filtered render by a different member never repoints an earlier
 * member's still-pending `/model N`. Each sender resolves against the last
 * menu THEY saw.
 * Quoted-reply resolution: store by-msgId map for `/model N` with a quotedMsgId.
 *
 * Slice 2 (drill-down): the flat `/model list` menu and the two-level drill
 * menu (brand -> model) share ONE per-(chat, sender) "latest" slot — a tagged
 * union, last-write-wins. Recency is therefore PHYSICAL: whichever menu was
 * rendered most recently is the one in the slot, so `/model N` (resolveLatestPick)
 * AND `/model N default` (resolveCataloguePick, flat-only) can never disagree
 * about which menu is current. `/model N default` reads the same slot and MISSES
 * when a newer drill superseded the flat menu (its kind !== 'flat'), instead of
 * silently pinning a stale flat provider. (Two independent maps would leave
 * `/model N default` recency-blind — the bug this single-slot design forecloses.)
 */

export interface CatalogueEntry {
  providerId: string;
  id: string;
}

/** A drill-down level: brand (Level-1) or model (Level-2). Slice 3 adds 'effort'. */
export type DrillLevel = 'brand' | 'model';

/**
 * One numbered entry in a drill menu. A DISCRIMINATED UNION on `kind` so
 * invalid states are unrepresentable and consumers narrow (no non-null
 * assertions): a 'brand' entry (Level-1) carries brand+provider (picking it
 * renders Level-2 for that provider); a 'model' entry (Level-2) carries
 * provider+model (picking it pins that leaf). `label` is what was rendered at
 * that number. (Slice 3's 'effort' becomes a third arm.)
 */
export type DrillEntry =
  | { kind: 'brand'; label: string; brand: string; provider: string }
  | { kind: 'model'; label: string; provider: string; model: string };

/** resolveLatestPick's tagged result — the caller dispatches on `kind`. */
export type LatestPick =
  | { kind: 'flat'; entry: CatalogueEntry }
  | { kind: 'drill'; entry: DrillEntry };

/** By-msgId snapshot (flat only — quoted-reply resolution). */
interface CatalogueSnapshot {
  msgId: string;
  entries: CatalogueEntry[];
  createdAt: number; // epoch ms
}

/** The per-(chat, sender) "latest" slot — a tagged union, last-write-wins. */
type LatestSnapshot =
  | { kind: 'flat'; entries: CatalogueEntry[]; createdAt: number }
  | { kind: 'drill'; level: DrillLevel; entries: DrillEntry[]; createdAt: number };

export interface CatalogueSnapshotCache {
  /**
   * Store the rendered flat catalogue snapshot for a chat + the sender who saw
   * it. entries = the catalogue in order; index+1 = the N the user sees.
   * Each entry is { providerId, id } (the resolved pair, invariant 7). Writes
   * the shared latest slot tagged 'flat' (Slice 2 recency) AND the by-msgId map.
   */
  putCatalogueSnapshot(
    chatJid: string,
    senderJid: string,
    outboundMsgId: string,
    entries: CatalogueEntry[]
  ): void;

  /**
   * Store a rendered drill LEVEL for a chat + sender into the SAME latest slot
   * as the flat menu (tagged 'drill', last-write-wins) — so a following
   * `/model N` resolves against exactly the level the user just saw and
   * `/model N default` misses (a drill superseded the flat menu). Drill menus
   * never carry a real msgId (fire-and-forget send), so there is no by-msgId
   * drill path — parity with the shipped dynamic flat menu.
   */
  putDrillSnapshot(
    chatJid: string,
    senderJid: string,
    level: DrillLevel,
    entries: DrillEntry[]
  ): void;

  /**
   * Resolve N (1-based) against the FLAT snapshot for the quoted message id if
   * given, else the latest slot THIS sender saw for the chat — but only when
   * that slot is still a FLAT menu. Returns null when the latest slot is a
   * drill menu (recency: a newer drill superseded the flat list), so
   * `/model N default` never pins a stale flat provider.
   * @returns { providerId, id } or null on miss (out of range / expired / no
   *          snapshot / superseded by a drill).
   */
  resolveCataloguePick(
    chatJid: string,
    senderJid: string,
    n: number,
    opts?: { quotedMsgId?: string }
  ): CatalogueEntry | null;

  /**
   * Resolve N (1-based) against the latest slot THIS sender saw for the chat,
   * whichever KIND it is (flat or drill), returning a tagged pick the handler
   * dispatches on. The unified `/model N` resolver for the coexist surface —
   * one recency source for the flat pin, the drill brand->Level-2 step, and
   * the drill leaf pin. No quoted-reply path (drill uses the latest slot only,
   * parity with the shipped dynamic menu).
   * @returns a tagged { kind, entry } or null on miss (out of range / expired /
   *          no snapshot).
   */
  resolveLatestPick(
    chatJid: string,
    senderJid: string,
    n: number
  ): LatestPick | null;

  /**
   * The KIND of this sender's current live latest slot — 'flat', 'drill', or
   * null when there is no live snapshot (absent or expired). Lets a `/model N`
   * MISS re-render the SAME menu the user is on (out-of-range on a live menu)
   * rather than bouncing them: a true snapshot-miss (null) opens drill L1, but
   * an out-of-range pick against a live flat list re-renders the flat list.
   */
  latestSnapshotKind(chatJid: string, senderJid: string): 'flat' | 'drill' | null;

  /**
   * Test helper: returns the current size of the byMsgId map.
   * Used to verify that expired entries are pruned and growth is bounded.
   */
  getMsgIdMapSize(): number;
}

const TTL_MS = 15 * 60_000; // 15 minutes

/** Composite key for the per-(chat, sender) "latest" slot. */
function latestSlotKey(chatJid: string, senderJid: string): string {
  return `${chatJid}:${senderJid}`;
}

export function createCatalogueSnapshotCache(): CatalogueSnapshotCache {
  // "chatJid:senderJid" → latest snapshot THAT sender saw in that chat
  // (flat OR drill — one slot, last-write-wins).
  const latestByChat = new Map<string, LatestSnapshot>();

  // msgId → flat snapshot (for quoted-reply resolution; flat menus only)
  const byMsgId = new Map<string, CatalogueSnapshot>();

  function isExpired(createdAt: number, now: number): boolean {
    return now - createdAt >= TTL_MS;
  }

  /** The sender's latest slot IF live (present + not expired), else null — the
   *  one place the get-slot + TTL-guard rule lives, shared by all three latest
   *  readers so they can never drift on the keying or the expiry boundary. */
  function liveLatest(chatJid: string, senderJid: string, now: number): LatestSnapshot | null {
    const snapshot = latestByChat.get(latestSlotKey(chatJid, senderJid));
    return snapshot && !isExpired(snapshot.createdAt, now) ? snapshot : null;
  }

  return {
    putCatalogueSnapshot(
      chatJid: string,
      senderJid: string,
      outboundMsgId: string,
      entries: CatalogueEntry[]
    ): void {
      const now = Date.now();

      // Store by msgId (for quoted-reply resolution)
      byMsgId.set(outboundMsgId, { msgId: outboundMsgId, entries, createdAt: now });

      // Prune expired entries from byMsgId to prevent unbounded growth
      for (const [msgId, snap] of byMsgId) {
        if (isExpired(snap.createdAt, now)) {
          byMsgId.delete(msgId);
        }
      }

      // Store as latest for THIS sender in this chat (replaces only their
      // own prior snapshot — a different sender's slot is untouched).
      latestByChat.set(latestSlotKey(chatJid, senderJid), { kind: 'flat', entries, createdAt: now });
    },

    putDrillSnapshot(
      chatJid: string,
      senderJid: string,
      level: DrillLevel,
      entries: DrillEntry[]
    ): void {
      const now = Date.now();
      // Same slot as the flat menu — last-write-wins makes recency physical.
      latestByChat.set(latestSlotKey(chatJid, senderJid), { kind: 'drill', level, entries, createdAt: now });
    },

    resolveCataloguePick(
      chatJid: string,
      senderJid: string,
      n: number,
      opts?: { quotedMsgId?: string }
    ): CatalogueEntry | null {
      const now = Date.now();

      if (opts?.quotedMsgId) {
        // Resolve against the quoted flat-message snapshot.
        const snapshot = byMsgId.get(opts.quotedMsgId);
        if (!snapshot || isExpired(snapshot.createdAt, now)) return null;
        return snapshot.entries[n - 1] ?? null;
      }

      // Latest slot — but flat-only. A drill in the slot means a newer drill
      // menu superseded the flat list, so a flat pick (e.g. `/model N default`)
      // must MISS rather than pin a stale provider.
      const snapshot = liveLatest(chatJid, senderJid, now);
      if (!snapshot || snapshot.kind !== 'flat') return null;
      return snapshot.entries[n - 1] ?? null;
    },

    resolveLatestPick(
      chatJid: string,
      senderJid: string,
      n: number
    ): LatestPick | null {
      const snapshot = liveLatest(chatJid, senderJid, Date.now());
      if (!snapshot) return null;
      if (snapshot.kind === 'flat') {
        const entry = snapshot.entries[n - 1];
        return entry ? { kind: 'flat', entry } : null;
      }
      const entry = snapshot.entries[n - 1];
      return entry ? { kind: 'drill', entry } : null;
    },

    latestSnapshotKind(chatJid: string, senderJid: string): 'flat' | 'drill' | null {
      return liveLatest(chatJid, senderJid, Date.now())?.kind ?? null;
    },

    getMsgIdMapSize(): number {
      return byMsgId.size;
    },
  };
}
