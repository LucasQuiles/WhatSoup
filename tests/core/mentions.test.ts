import { describe, it, expect } from 'vitest';
import { formatMentions, ContactsDirectory } from '../../src/core/mentions.ts';

// ---------------------------------------------------------------------------
// formatMentions — no contacts (pure number detection)
// ---------------------------------------------------------------------------

describe('formatMentions (no contacts)', () => {
  it('returns unchanged text when no mentions present', () => {
    const result = formatMentions('Hello world, no mentions here');
    expect(result.hasMentions).toBe(false);
    expect(result.jids).toEqual([]);
    expect(result.text).toBe('Hello world, no mentions here');
  });

  it('detects bare @number mention — emits only @s.whatsapp.net (no @lid)', () => {
    const result = formatMentions('Hey @15184194479 check this');
    expect(result.hasMentions).toBe(true);
    expect(result.jids).toContain('15184194479@s.whatsapp.net');
    // @lid variant is NOT emitted
    expect(result.jids).not.toContain('15184194479@lid');
    expect(result.jids).toHaveLength(1);
    expect(result.text).toBe('Hey @15184194479 check this');
  });

  it('detects @+number with leading plus and rewrites to bare number', () => {
    const result = formatMentions('Hey @+15184194479 check this');
    expect(result.hasMentions).toBe(true);
    expect(result.jids).toContain('15184194479@s.whatsapp.net');
    expect(result.text).toBe('Hey @15184194479 check this');
  });

  it('detects multiple number mentions — one JID per phone', () => {
    const result = formatMentions('@15184194479 and @18455943112 are here');
    expect(result.hasMentions).toBe(true);
    expect(result.jids).toHaveLength(2); // 1 JID per phone (no @lid)
    expect(result.jids).toContain('15184194479@s.whatsapp.net');
    expect(result.jids).toContain('18455943112@s.whatsapp.net');
  });

  it('deduplicates repeated mentions of the same number', () => {
    const result = formatMentions('@15184194479 said hi, @15184194479 again');
    expect(result.hasMentions).toBe(true);
    expect(result.jids).toHaveLength(1); // one set only
  });

  it('ignores short numbers (< 5 digits)', () => {
    const result = formatMentions('Order @1234 is ready');
    expect(result.hasMentions).toBe(false);
  });

  it('handles mention followed by punctuation', () => {
    const result = formatMentions('Hey @15184194479, what do you think?');
    expect(result.hasMentions).toBe(true);
    expect(result.jids).toContain('15184194479@s.whatsapp.net');
  });

  it('leaves unresolved @name patterns unchanged when no contacts', () => {
    const result = formatMentions('Hey @Jason check this out');
    expect(result.hasMentions).toBe(false);
    expect(result.text).toBe('Hey @Jason check this out');
  });
});

// ---------------------------------------------------------------------------
// formatMentions — with contacts directory
// ---------------------------------------------------------------------------

describe('formatMentions (with contacts)', () => {
  function buildContacts(): ContactsDirectory {
    const dir = new ContactsDirectory();
    dir.observe('18459780919@s.whatsapp.net', 'Q');
    dir.observe('18455943112@s.whatsapp.net', 'Loops');
    dir.observe('15551234567@s.whatsapp.net', 'Jason Bradshaw');
    return dir;
  }

  it('rewrites @name to @number using contacts map', () => {
    const dir = buildContacts();
    const result = formatMentions('Hey @Q check this', dir.contacts);
    expect(result.text).toBe('Hey @18459780919 check this');
    expect(result.jids).toContain('18459780919@s.whatsapp.net');
    // @lid NOT emitted
    expect(result.jids).not.toContain('18459780919@lid');
    expect(result.hasMentions).toBe(true);
  });

  it('is case-insensitive for name lookup', () => {
    const dir = buildContacts();
    const result = formatMentions('Hey @loops whats up', dir.contacts);
    expect(result.text).toBe('Hey @18455943112 whats up');
    expect(result.jids).toContain('18455943112@s.whatsapp.net');
  });

  it('resolves first name from multi-word display name', () => {
    const dir = buildContacts();
    const result = formatMentions('@Jason can you look at this?', dir.contacts);
    expect(result.text).toBe('@15551234567 can you look at this?');
    expect(result.jids).toContain('15551234567@s.whatsapp.net');
  });

  it('resolves full name (lowercase)', () => {
    const dir = buildContacts();
    const result = formatMentions('@jason can you look?', dir.contacts);
    expect(result.text).toBe('@15551234567 can you look?');
  });

  it('handles mix of @number and @name in same message', () => {
    const dir = buildContacts();
    const result2 = formatMentions('@Q and @18455943112 should both see this', dir.contacts);
    expect(result2.text).toBe('@18459780919 and @18455943112 should both see this');
    expect(result2.jids).toHaveLength(2); // 2 phones * 1 suffix each
  });

  it('leaves unresolved names unchanged', () => {
    const dir = buildContacts();
    const result = formatMentions('Hey @UnknownPerson check this', dir.contacts);
    expect(result.text).toBe('Hey @UnknownPerson check this');
    expect(result.hasMentions).toBe(false);
  });

  it('deduplicates when @name and @number refer to same phone', () => {
    const dir = buildContacts();
    const result = formatMentions('@Q and @18459780919 same person', dir.contacts);
    expect(result.text).toBe('@18459780919 and @18459780919 same person');
    expect(result.jids).toHaveLength(1); // one set only
  });
});

// ---------------------------------------------------------------------------
// ContactsDirectory
// ---------------------------------------------------------------------------

describe('ContactsDirectory', () => {
  it('indexes by phone, full name, and first name', () => {
    const dir = new ContactsDirectory();
    dir.observe('15551234567@s.whatsapp.net', 'Jason Bradshaw');

    expect(dir.resolve('15551234567')).toBe('15551234567');
    expect(dir.resolve('jason bradshaw')).toBe('15551234567');
    expect(dir.resolve('jason')).toBe('15551234567');
    expect(dir.resolve('Jason')).toBe('15551234567'); // case-insensitive
  });

  it('handles JIDs with @lid suffix', () => {
    const dir = new ContactsDirectory();
    dir.observe('81536414179557@lid', 'Bot User');

    expect(dir.resolve('81536414179557')).toBe('81536414179557');
    expect(dir.resolve('bot user')).toBe('81536414179557');
  });

  it('handles null sender name gracefully', () => {
    const dir = new ContactsDirectory();
    dir.observe('15551234567@s.whatsapp.net', null);

    // Still indexes by phone
    expect(dir.resolve('15551234567')).toBe('15551234567');
    expect(dir.size).toBe(1);
  });

  it('updates mapping when name changes for same phone', () => {
    const dir = new ContactsDirectory();
    dir.observe('15551234567@s.whatsapp.net', 'Old Name');
    dir.observe('15551234567@s.whatsapp.net', 'New Name');

    expect(dir.resolve('new name')).toBe('15551234567');
    // Old name still maps (we don't evict — it's a feature)
    expect(dir.resolve('old name')).toBe('15551234567');
  });

  it('evicts oldest entries when at capacity (while loop fix)', () => {
    const dir = new ContactsDirectory(5); // tiny capacity
    dir.observe('11111@s.whatsapp.net', 'A');
    dir.observe('22222@s.whatsapp.net', 'B');
    dir.observe('33333@s.whatsapp.net', 'C');

    // At this point we have entries for: 11111, a, 22222, b, 33333
    // Adding more should evict the oldest
    dir.observe('44444@s.whatsapp.net', 'D');
    dir.observe('55555@s.whatsapp.net', 'E');

    // Newest entries should be resolvable
    expect(dir.resolve('55555')).toBe('55555');
    expect(dir.resolve('e')).toBe('55555');
    // Map should not exceed capacity
    expect(dir.size).toBeLessThanOrEqual(5);
  });

  it('skips short JIDs (< 5 digits)', () => {
    const dir = new ContactsDirectory();
    dir.observe('123@s.whatsapp.net', 'Short');

    expect(dir.resolve('123')).toBeUndefined();
    expect(dir.resolve('short')).toBeUndefined();
    expect(dir.size).toBe(0);
  });
});
