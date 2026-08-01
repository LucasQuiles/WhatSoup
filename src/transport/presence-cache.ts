// src/transport/presence-cache.ts
// In-memory cache for WhatsApp presence status.

import { MS_PER_MINUTE } from '../lib/time-units.ts';

interface PresenceEntry {
  status: string;
  lastSeen?: number;
  updatedAt: number;
}

export interface PresenceResult {
  status: string;
  lastSeen?: number;
  stale: boolean;
}

const STALE_THRESHOLD_MS = 5 * MS_PER_MINUTE;
const DEFAULT_MAX_ENTRIES = 10_000;

export class PresenceCache {
  private readonly entries = new Map<string, PresenceEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /**
   * Store or update the presence status for a JID.
   * Timestamps the entry with Date.now().
   * If the cache is at capacity, the least-recently-accessed entry is evicted.
   */
  update(jid: string, info: { status: string; lastSeen?: number }): void {
    // Delete first so re-insert moves to end (most-recent position)
    this.entries.delete(jid);

    // Evict the least-recently-accessed entry if at capacity
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }

    this.entries.set(jid, {
      status: info.status,
      lastSeen: info.lastSeen,
      updatedAt: Date.now(),
    });
  }

  /** Iterate all entries with their JID, updatedAt, and stale flag. */
  *getAll(): IterableIterator<[string, PresenceEntry & { stale: boolean }]> {
    const now = Date.now();
    for (const [jid, entry] of this.entries) {
      yield [jid, { ...entry, stale: now - entry.updatedAt > STALE_THRESHOLD_MS }];
    }
  }

  /**
   * Retrieve the presence status for a JID.
   * Returns undefined if the JID has never been seen.
   * Returns the entry with a `stale` flag if it was last updated more than 5 minutes ago.
   * Accessing an entry promotes it to most-recently-used.
   */
  get(jid: string): PresenceResult | undefined {
    const entry = this.entries.get(jid);
    if (!entry) return undefined;

    // Promote to most-recently-used by deleting and re-inserting
    this.entries.delete(jid);
    this.entries.set(jid, entry);

    const stale = Date.now() - entry.updatedAt > STALE_THRESHOLD_MS;
    return {
      status: entry.status,
      lastSeen: entry.lastSeen,
      stale,
    };
  }

  /** Current number of entries in the cache. */
  get size(): number {
    return this.entries.size;
  }
}
