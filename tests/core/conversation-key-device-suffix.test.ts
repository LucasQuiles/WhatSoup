/**
 * QR-027 — toConversationKey must strip the :device suffix for @s.whatsapp.net
 * symmetrically with the @lid branch. The canonical conversation_key is a chat
 * identity and must NEVER carry a device qualifier regardless of domain; the LID
 * branch already strips it, the personal branch did not. contacts-sync feeds the
 * result to contacts.canonical_phone, which the outbound warm-check matches on a
 * BARE phone — a :device-polluted canonical_phone silently misses (fail-closed).
 */
import { describe, it, expect } from 'vitest';
import { toConversationKey } from '../../src/core/conversation-key.ts';
import { Database } from '../../src/core/database.ts';
import { handleContactsUpsert } from '../../src/core/contacts-sync.ts';

describe('toConversationKey — personal/LID device-suffix symmetry (QR-027)', () => {
  it('strips the :device suffix for @s.whatsapp.net (matching the @lid case)', () => {
    expect(toConversationKey('15550100001:5@s.whatsapp.net')).toBe('15550100001');
  });

  it('keeps the existing @lid device-suffix stripping', () => {
    expect(toConversationKey('81536414179557:42@lid')).toBe('81536414179557');
  });

  it('is a no-op for a bare personal JID (no colon)', () => {
    expect(toConversationKey('15550100001@s.whatsapp.net')).toBe('15550100001');
  });

  it('handles a multi-digit device index', () => {
    expect(toConversationKey('15550100001:127@s.whatsapp.net')).toBe('15550100001');
  });

  it('contacts-sync stores a BARE canonical_phone for a :device personal contact id', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      handleContactsUpsert(db, [{ id: '15550100001:5@s.whatsapp.net', name: 'Dev Suffixed' }]);
      const row = db.raw
        .prepare('SELECT canonical_phone FROM contacts WHERE jid = ?')
        .get('15550100001:5@s.whatsapp.net') as { canonical_phone: string } | undefined;
      expect(row?.canonical_phone).toBe('15550100001');
    } finally {
      db.close();
    }
  });
});
