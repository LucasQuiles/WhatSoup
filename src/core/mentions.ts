// src/core/mentions.ts
// Utility for detecting, resolving, and formatting @mentions in outgoing text.

import { resolvePhoneFromJid, extractLocal, canonicalConversationKey } from './access-list.ts';
import { toConversationKey } from './conversation-key.ts';
import type { Database } from './database.ts';
import type { DatabaseSync } from 'node:sqlite';
import { toPersonalJid, toLidJid, isLidJid, bareNumber } from './jid-constants.ts';

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
    let max: number;
    if (typeof dbOrMax === 'number') {
      max = dbOrMax;
    } else if (dbOrMax != null) {
      this.db = dbOrMax;
      max = maxEntries ?? 500;
    } else {
      max = maxEntries ?? 500;
    }
    // Floor to >=1: a 0/negative cap would make the eviction loop's
    // `size >= maxEntries` always true and spin forever on the first observe().
    this.maxEntries = Math.max(1, Math.floor(max));
  }

  /** Inject the database after construction (for ConnectionManager). */
  setDatabase(db: Database): void {
    this.db = db;
  }

  /** Build bidirectional LID mappings from the DB. Returns null if no DB available. */
  getLidMappings(): LidMappings | undefined {
    if (!this.db) return undefined;
    return buildLidMappings(this.db);
  }

  /**
   * Resolve a raw chat JID to the canonical `conversation_key` that message
   * ingest stores under — folding a mapped `@lid` DM to its phone key via
   * `lid_mappings`. Falls back to `toConversationKey` when no DB is wired.
   *
   * Used by the outbound-flood detector so a mid-stream `@lid` → phone-JID flip
   * cannot dodge the per-destination threshold (G2/H3). Keying on the ingest
   * identity also lets flood counts correlate with durability + PR-F.
   */
  resolveConversationKey(jid: string): string {
    return this.db ? canonicalConversationKey(jid, this.db) : toConversationKey(jid);
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
   * Accepts a full JID (e.g. '15555550101@s.whatsapp.net') or bare phone.
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
      // QR-044: display-name / alias keys are derived from the untrusted pushName
      // (any WhatsApp user can set any pushName). Once a name maps to a phone, a LATER
      // observe with a DIFFERENT phone must NOT overwrite it — an attacker spoofing a
      // victim's pushName ('Boss') would otherwise redirect the bot's @<Name> mention
      // to themselves. First-writer-wins for name keys. The phone self-key (key === phone)
      // is exempt: it is not spoofable since the key IS the resolved phone.
      const existing = this.map.get(key);
      if (existing !== undefined && existing !== phone && key !== phone) {
        continue;
      }
      if (!this.map.has(key)) {
        // Fix: use while loop to correctly drain when multiple keys are added
        // and the map may already be at or beyond capacity.
        while (this.map.size >= this.maxEntries) {
          const oldest = this.insertOrder.shift();
          if (oldest === undefined) break; // nothing left to evict — avoid spinning
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
 * Bidirectional LID↔phone mappings for mention resolution.
 *
 * Built from lid_mappings DB table via getAllLidMappings().
 * When provided, formatMentions can:
 *   1. Detect when a mentioned number is a LID (not a phone) and resolve
 *      it to the real phone number for display text.
 *   2. Emit both @s.whatsapp.net AND @lid JIDs so mentions render
 *      correctly in both phone-addressed and LID-addressed groups.
 */
export interface LidMappings {
  /** phone digits → LID digits */
  phoneToLid: Map<string, string>;
  /** LID digits → phone digits */
  lidToPhone: Map<string, string>;
}

/**
 * Build bidirectional LID mappings from the lid_mappings DB table.
 * Call once per send or cache and invalidate when mappings change.
 */
export function buildLidMappings(db: Database | DatabaseSync): LidMappings {
  const rawDb: DatabaseSync = 'raw' in db ? (db as Database).raw : db as DatabaseSync;
  const rows = rawDb.prepare(
    'SELECT lid, phone_jid FROM lid_mappings',
  ).all() as { lid: string; phone_jid: string }[];

  const phoneToLid = new Map<string, string>();
  const lidToPhone = new Map<string, string>();
  for (const row of rows) {
    const phone = bareNumber(row.phone_jid);
    if (phone && row.lid) {
      phoneToLid.set(phone, row.lid);
      lidToPhone.set(row.lid, phone);
    }
  }
  return { phoneToLid, lidToPhone };
}

/**
 * Scan outgoing text for @mention patterns, resolve names to phone numbers
 * via the contacts directory, rewrite the text, and build the Baileys
 * mentions array.
 *
 * Recognition order:
 *   1. `@<digits>` / `@+<digits>` — check if it's a known LID first,
 *      then treat as phone number
 *   2. `@<word>` / `@<Word>` — looked up in contacts map (name mention)
 *
 * When `lidMappings` is provided:
 *   - Numbers that are known LIDs are resolved to phone for display text
 *   - Both @s.whatsapp.net and @lid JIDs are emitted for each mention
 *   - This ensures mentions work in both phone-addressed and LID-addressed groups
 *
 * Unresolved @name patterns are left unchanged in the text.
 */
export function formatMentions(
  text: string,
  contacts?: ContactsMap,
  lidMappings?: LidMappings,
): FormattedMentions {
  const seen = new Set<string>();
  const jids: string[] = [];

  // Single pass: match @<something> patterns
  // - @+?<digits> for phone numbers or LIDs
  // - @<word chars> for names (letters, hyphens, underscores)
  //
  // #2138: the `(?<![\w.])` guard requires the at-sign to START a token. Without
  // it the pattern matched an at-sign anywhere, so an operational identifier that
  // merely CONTAINS one — a systemd unit template, or any address-shaped token —
  // had its second half rewritten into a resolved phone number and shipped with
  // real mention metadata. That corrupts the diagnostic AND injects contact data
  // that was never in the source text. A mention must be preceded by nothing, or
  // by something that cannot be part of an identifier.
  //
  // (Deliberately no worked example here: written out, one is address-shaped and
  // the repo's `personal-email` hygiene guard cannot tell a comment from a leak.
  // The cases live in tests/core/mentions.test.ts, assembled at runtime.)
  const formatted = text.replace(
    /(?<![\w.])@(\+?\d{5,}\b|[A-Za-z][\w-]*)/g,
    (fullMatch, capture: string) => {
      let phone: string | undefined;
      let lid: string | undefined;

      if (/^\+?\d{5,}$/.test(capture)) {
        const digits = capture.replace(/^\+/, '');

        // Check if this number is actually a LID (not a phone number).
        // LID-addressed groups show participant IDs as LIDs, so users
        // naturally copy/paste LID numbers into @mentions.
        if (lidMappings?.lidToPhone.has(digits)) {
          phone = lidMappings.lidToPhone.get(digits)!;
          lid = digits;
        } else {
          phone = digits;
          // Look up the corresponding LID for this phone number
          if (lidMappings) {
            lid = lidMappings.phoneToLid.get(digits);
          }
        }
      } else if (contacts) {
        // Name-based — look up in contacts directory
        phone = contacts.get(capture.toLowerCase());
        // Resolve LID for name-based mentions too
        if (phone && lidMappings) {
          lid = lidMappings.phoneToLid.get(phone);
        }
      }

      if (phone && !seen.has(phone)) {
        seen.add(phone);
        // Emit @s.whatsapp.net for phone-addressed groups
        jids.push(toPersonalJid(phone));
        // Also emit @lid for LID-addressed groups
        if (lid) {
          jids.push(toLidJid(lid));
        }
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
