// src/transport/presence-cache.ts
// In-memory cache for WhatsApp presence status.

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

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export class PresenceCache {
  private readonly entries = new Map<string, PresenceEntry>();

  /**
   * Store or update the presence status for a JID.
   * Timestamps the entry with Date.now().
   */
  update(jid: string, info: { status: string; lastSeen?: number }): void {
    this.entries.set(jid, {
      status: info.status,
      lastSeen: info.lastSeen,
      updatedAt: Date.now(),
    });
  }

  /**
   * Retrieve the presence status for a JID.
   * Returns undefined if the JID has never been seen.
   * Returns the entry with a `stale` flag if it was last updated more than 5 minutes ago.
   */
  get(jid: string): PresenceResult | undefined {
    const entry = this.entries.get(jid);
    if (!entry) return undefined;

    const stale = Date.now() - entry.updatedAt > STALE_THRESHOLD_MS;
    return {
      status: entry.status,
      lastSeen: entry.lastSeen,
      stale,
    };
  }
}
