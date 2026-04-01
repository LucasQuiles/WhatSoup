// src/core/mentions.ts
// Utility for detecting, resolving, and formatting @mentions in outgoing text.

import { extractPhone } from './access-list.ts';
import { toPersonalJid } from './jid-constants.ts';

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

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  /**
   * Record a sender's display name → phone mapping.
   * Call this for every incoming message to keep the directory fresh.
   *
   * Accepts a full JID (e.g. '15184194479@s.whatsapp.net') or bare phone.
   * Generates lowercase keys for: full name, first name, and phone number.
   */
  observe(senderJid: string, senderName: string | null): void {
    const phone = extractPhone(senderJid);
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
