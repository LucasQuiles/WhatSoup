// tests/transport/self-mention-strip.test.ts
// Unit tests for the self-mention stripping regex logic in sendMessage.
// The logic is inline in ConnectionManager.sendMessage — tested here as pure functions
// to avoid the heavyweight Baileys socket dependency.

import { describe, it, expect } from 'vitest';

/**
 * Mirrors the stripping logic in src/transport/connection.ts sendMessage().
 * Given a JID like '15551234567@s.whatsapp.net', strips @15551234567 → 15551234567.
 * Given a LID like '98765@lid', strips @98765 → 98765.
 * Returns the cleaned text plus whether any replacement occurred.
 */
function stripSelfMentions(
  text: string,
  botJid: string | undefined,
  botLid: string | undefined,
): string {
  let cleaned = text;
  const ownBare = botJid?.split('@')[0];
  const ownLidBare = botLid?.split('@')[0];
  if (ownBare) {
    cleaned = cleaned.replace(new RegExp(`@${ownBare}\\b`, 'g'), ownBare);
  }
  if (ownLidBare && ownLidBare !== ownBare) {
    cleaned = cleaned.replace(new RegExp(`@${ownLidBare}\\b`, 'g'), ownLidBare);
  }
  return cleaned;
}

describe('self-mention stripping', () => {
  const botJid = '15551234567@s.whatsapp.net';
  const botLid = '98765@lid';

  // ─── JID stripping ──────────────────────────────────────────────────────────

  it('strips @botNumber from text when JID is set', () => {
    const result = stripSelfMentions(
      'hey @15551234567 what do you think',
      botJid,
      undefined,
    );
    expect(result).toBe('hey 15551234567 what do you think');
  });

  it('strips @botNumber at start of text', () => {
    const result = stripSelfMentions('@15551234567 can you help', botJid, undefined);
    expect(result).toBe('15551234567 can you help');
  });

  it('strips @botNumber at end of text', () => {
    const result = stripSelfMentions('ping @15551234567', botJid, undefined);
    expect(result).toBe('ping 15551234567');
  });

  it('strips multiple occurrences of @botNumber', () => {
    const result = stripSelfMentions(
      '@15551234567 and @15551234567 again',
      botJid,
      undefined,
    );
    expect(result).toBe('15551234567 and 15551234567 again');
  });

  // ─── LID stripping ──────────────────────────────────────────────────────────

  it('strips @botLid bare number from text when LID is set', () => {
    const result = stripSelfMentions(
      'hey @98765 what do you think',
      undefined,
      botLid,
    );
    expect(result).toBe('hey 98765 what do you think');
  });

  it('strips both @botNumber and @botLid when both are set', () => {
    const result = stripSelfMentions(
      '@15551234567 and @98765 are both me',
      botJid,
      botLid,
    );
    expect(result).toBe('15551234567 and 98765 are both me');
  });

  it('does not double-strip when botJid bare equals botLid bare', () => {
    // If bare parts are equal the second replace is skipped (ownLidBare !== ownBare guard)
    const result = stripSelfMentions(
      'hi @12345',
      '12345@s.whatsapp.net',
      '12345@lid',
    );
    expect(result).toBe('hi 12345');
  });

  // ─── Non-matching mentions should pass through unchanged ────────────────────

  it('leaves @otherNumber unchanged', () => {
    const result = stripSelfMentions(
      'ping @18455943112 are you there',
      botJid,
      botLid,
    );
    expect(result).toBe('ping @18455943112 are you there');
  });

  it('leaves @name mentions unchanged', () => {
    const result = stripSelfMentions('hey @Alice check this', botJid, botLid);
    expect(result).toBe('hey @Alice check this');
  });

  it('leaves plain text without @ unchanged', () => {
    const result = stripSelfMentions('hello world', botJid, botLid);
    expect(result).toBe('hello world');
  });

  it('does not strip partial prefix match — word boundary matters', () => {
    // @15551234567extra should not match @15551234567 (\b stops before 'e')
    // because 'extra' follows digits — \b is between digit and non-word char.
    // Actually \b does apply between '7' and 'e' (word→word = no boundary).
    // So @15551234567extra should NOT be stripped. Verify the guard works.
    const result = stripSelfMentions('@15551234567extra', botJid, undefined);
    // The regex has \b so '15551234567extra' is one token — no match
    expect(result).toBe('@15551234567extra');
  });

  // ─── No JID/LID set ─────────────────────────────────────────────────────────

  it('returns text unchanged when botJid and botLid are both undefined', () => {
    const result = stripSelfMentions(
      'hey @15551234567 hi',
      undefined,
      undefined,
    );
    expect(result).toBe('hey @15551234567 hi');
  });

  it('returns text unchanged when botJid and botLid are empty strings', () => {
    // split('@')[0] on '' yields '' — falsy check guards the replace
    const result = stripSelfMentions('hey @15551234567 hi', '', '');
    expect(result).toBe('hey @15551234567 hi');
  });
});
