// src/core/mentions.ts
// Utility for detecting, resolving, and formatting @mentions in outgoing text.

import { resolvePhoneFromJid, extractLocal } from './access-list.ts';
import type { Database } from './database.ts';
import { toPersonalJid, isLidJid } from './jid-constants.ts';

/**
 * Result of formatting + extracting mentions from a text string.
 */
export interface FormattedMentions {
  /** The text with any @name patterns rewritten to @number. */
  text: string;
  /** JIDs to pass to Baileys' `mentions` field (@s.whatsapp.net only). */
  jids: string[];
  /** Whether any mentions were found or resolved. */
  hasMentions: boolean;
}

/**
 * A contacts directory mapping display names / aliases to phone numbers.
 * Keys are lowercase for case-insensitive lookup.
 *
 * Built automatically from incoming messages by the transport layer.
 */
export type ContactsMap = Map<string, string>;

/**
 * Create and manage a contacts map that accumulates name→phone mappings
 * from incoming messages. Thread-safe (single-threaded JS), bounded to
 * prevent unbounded growth.
 */
export class ContactsDirectory {
  private readonly map: ContactsMap = new Map();
  private readonly insertOrder: string[] = [];
  private readonly maxEntries: number;
  private db: Database | null = null;
  /**
   * Cache LID→phone resolutions to avoid repeated DB queries for the same sender.
   * Bounded to maxEntries. Cleared on invalidation (e.g. when LID mappings change).
   */
  private readonly lidCache: Map<string, string> = new Map();

  constructor(maxEntries?: number);
  constructor(db: Database, maxEntries?: number);
  constructor(dbOrMax?: Database | number, maxEntries?: number) {
    if (typeof dbOrMax === 'number') {
      this.maxEntries = dbOrMax;
    } else if (dbOrMax != null) {
      this.db = dbOrMax;
      this.maxEntries = maxEntries ?? 500;
    } else {
      this.maxEntries = maxEntries ?? 500;
    }
  }

  /** Inject the database after construction (for ConnectionManager). */
  setDatabase(db: Database): void {
    this.db = db;
  }

  /**
   * Clear the LID→phone cache. Call when LID mappings change
   * (e.g. after upsertLidMapping) so stale resolutions are evicted.
   */
  invalidateLidCache(): void {
    this.lidCache.clear();
  }

  /**
   * Record a sender's display name → phone mapping.
   * Call this for every incoming message to keep the directory fresh.
   *
   * Accepts a full JID (e.g. '15184194479@s.whatsapp.net') or bare phone.
   * Resolves LID JIDs to real phone numbers via the DB when available.
   * Generates lowercase keys for: full name, first name, and phone number.
   */
  observe(senderJid: string, senderName: string | null): void {
    let phone: string;
    if (this.db && isLidJid(senderJid)) {
      // LID senders: check cache first, resolve via DB only on miss
      const cached = this.lidCache.get(senderJid);
      if (cached) {
        phone = cached;
      } else {
        phone = resolvePhoneFromJid(senderJid, this.db);
        // Bound the cache to prevent unbounded growth
        if (this.lidCache.size >= this.maxEntries) {
          const oldest = this.lidCache.keys().next().value;
          if (oldest !== undefined) this.lidCache.delete(oldest);
        }
        this.lidCache.set(senderJid, phone);
      }
    } else if (this.db) {
      phone = resolvePhoneFromJid(senderJid, this.db);
    } else {
      phone = extractLocal(senderJid);
    }
    if (!phone || phone.length < 5) return;

    const keys: string[] = [];

    // Always map phone → phone (so @15550100001 always resolves)
    keys.push(phone);

    if (senderName) {
      const lower = senderName.toLowerCase().trim();
      if (lower) {
        keys.push(lower);

        // Also index the first name (before the first space)
        const firstSpace = lower.indexOf(' ');
        if (firstSpace > 0) {
          const firstName = lower.slice(0, firstSpace);
          // Only add first name if it's not already a phone number pattern
          if (!/^\d+$/.test(firstName)) {
            keys.push(firstName);
          }
        }
      }
    }

    for (const key of keys) {
      if (!this.map.has(key)) {
        // Fix: use while loop to correctly drain when multiple keys are added
        // and the map may already be at or beyond capacity.
        while (this.map.size >= this.maxEntries) {
          const oldest = this.insertOrder.shift()!;
          this.map.delete(oldest);
        }
        this.insertOrder.push(key);
      }
      this.map.set(key, phone);
    }
  }

  /** Look up a name/alias → phone number. Case-insensitive. */
  resolve(nameOrPhone: string): string | undefined {
    return this.map.get(nameOrPhone.toLowerCase().trim());
  }

  /** Get the underlying map (for passing to formatMentions). */
  get contacts(): ContactsMap {
    return this.map;
  }

  /** Current number of entries. */
  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Core formatting function
// ---------------------------------------------------------------------------

/**
 * Scan outgoing text for @mention patterns, resolve names to phone numbers
 * via the contacts directory, rewrite the text, and build the Baileys
 * mentions array.
 *
 * Recognition order:
 *   1. `@<digits>` / `@+<digits>` — used as-is (direct phone mention)
 *   2. `@<word>` / `@<Word>` — looked up in contacts map (name mention)
 *
 * Only `@s.whatsapp.net` JIDs are emitted — `@lid` variants are omitted
 * to avoid duplicates in the Baileys mentions array.
 *
 * Unresolved @name patterns are left unchanged in the text.
 */
export function formatMentions(text: string, contacts?: ContactsMap): FormattedMentions {
  const seen = new Set<string>();
  const jids: string[] = [];

  // Single pass: match @<something> patterns
  // - @+?<digits> for phone numbers
  // - @<word chars> for names (letters, hyphens, underscores)
  const formatted = text.replace(
    /@(\+?\d{5,}\b|[A-Za-z][\w-]*)/g,
    (fullMatch, capture: string) => {
      let phone: string | undefined;

      if (/^\+?\d{5,}$/.test(capture)) {
        // Direct phone number — strip leading +
        phone = capture.replace(/^\+/, '');
      } else if (contacts) {
        // Name-based — look up in contacts directory
        phone = contacts.get(capture.toLowerCase());
      }

      if (phone && !seen.has(phone)) {
        seen.add(phone);
        // Emit only @s.whatsapp.net — no @lid variant
        jids.push(toPersonalJid(phone));
      }

      if (phone) {
        // Rewrite to @<phone> so WhatsApp renders the mention
        return `@${phone}`;
      }

      // Unresolved — leave as-is
      return fullMatch;
    },
  );

  return {
    text: formatted,
    jids,
    hasMentions: jids.length > 0,
  };
}
