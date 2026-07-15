import { describe, expect, it } from 'vitest';

import {
  buildSelfMentionStripPatterns,
  stripSelfMentions,
  stripSelfMentionsFrom,
} from '../../src/lib/self-mention-strip.ts';

describe('buildSelfMentionStripPatterns', () => {
  it('returns empty array for no identifiers', () => {
    expect(buildSelfMentionStripPatterns([])).toEqual([]);
  });

  it('returns empty array for empty identifier', () => {
    expect(buildSelfMentionStripPatterns([''])).toEqual([]);
  });

  it('returns empty array for whitespace-only identifier', () => {
    expect(buildSelfMentionStripPatterns(['   '])).toEqual([]);
  });

  it('builds bare and @-prefixed patterns for a phone number', () => {
    const patterns = buildSelfMentionStripPatterns(['15550100001']);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].source).toContain('15550100001');
    expect(patterns[1].source).toContain('@15550100001');
  });

  it('strips whatsapp: prefix by default', () => {
    const patterns = buildSelfMentionStripPatterns(['whatsapp:15550100001']);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].source).toContain('15550100001');
    expect(patterns[0].source).not.toContain('whatsapp');
  });

  it('strips custom prefixes when provided', () => {
    const patterns = buildSelfMentionStripPatterns(['tel:+1555'], {
      stripPrefixes: ['tel:'],
    });
    expect(patterns[0].source).toContain('\\+1555');
    expect(patterns[0].source).not.toContain('tel');
  });

  it('strips multiple prefixes in order', () => {
    const patterns = buildSelfMentionStripPatterns(['whatsapp:bot'], {
      stripPrefixes: ['whatsapp:'],
    });
    expect(patterns[0].source).toContain('bot');
  });

  it('deduplicates case-insensitively', () => {
    const patterns = buildSelfMentionStripPatterns(['Bot', 'bot', 'BOT']);
    // One bare + one @-prefixed (the @-prefixed is case-insensitive).
    expect(patterns).toHaveLength(2);
  });

  it('handles handle-style identifiers', () => {
    const patterns = buildSelfMentionStripPatterns(['@assistant']);
    // The leading @ in the identifier is part of the token; we still emit
    // the bare and the @@-prefixed forms. The bare form matches @assistant.
    expect(patterns.length).toBeGreaterThanOrEqual(1);
  });

  it('escapes regex special characters in identifiers', () => {
    const patterns = buildSelfMentionStripPatterns(['bot.name+special']);
    // The pattern source should contain escaped forms, not raw specials.
    expect(patterns[0].source).toContain('bot\\.name\\+special');
  });
});

describe('stripSelfMentions', () => {
  it('strips a bare phone mention', () => {
    const patterns = buildSelfMentionStripPatterns(['15550100001']);
    expect(stripSelfMentions('15550100001 hello there', patterns)).toBe('hello there');
  });

  it('strips an @-prefixed phone mention', () => {
    const patterns = buildSelfMentionStripPatterns(['15550100001']);
    expect(stripSelfMentions('@15550100001 hello there', patterns)).toBe('hello there');
  });

  it('strips a mention in the middle of text', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    expect(stripSelfMentions('hey @bot can you help', patterns)).toBe('hey can you help');
  });

  it('strips multiple mentions in one pass', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    expect(stripSelfMentions('@bot @bot @bot please', patterns)).toBe('please');
  });

  it('collapses whitespace after stripping', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    expect(stripSelfMentions('@bot    hello     world', patterns)).toBe('hello world');
  });

  it('trims leading/trailing whitespace', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    expect(stripSelfMentions('  @bot hello  ', patterns)).toBe('hello');
  });

  it('returns empty string when text is only the mention', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    expect(stripSelfMentions('@bot', patterns)).toBe('');
  });

  it('returns empty string when text is mention + whitespace', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    expect(stripSelfMentions('  @bot   ', patterns)).toBe('');
  });

  it('does not strip a substring of a larger token', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    // "robotics" should NOT have "bot" stripped from it.
    expect(stripSelfMentions('robotics is cool', patterns)).toBe('robotics is cool');
  });

  it('does not strip mid-token mentions', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    expect(stripSelfMentions('hello@bot world', patterns)).toBe('hello@bot world');
  });

  it('handles case-insensitive @-prefixed match', () => {
    const patterns = buildSelfMentionStripPatterns(['Bot']);
    expect(stripSelfMentions('@BOT hello', patterns)).toBe('hello');
    expect(stripSelfMentions('@bot hello', patterns)).toBe('hello');
  });

  it('handles multiple different identifiers', () => {
    const patterns = buildSelfMentionStripPatterns(['15550100001', 'assistant']);
    expect(stripSelfMentions('@15550100001 @assistant hi', patterns)).toBe('hi');
  });

  it('returns empty string unchanged', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    expect(stripSelfMentions('', patterns)).toBe('');
  });

  it('returns text unchanged when no patterns match', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    expect(stripSelfMentions('just plain text', patterns)).toBe('just plain text');
  });

  it('handles empty patterns array (no-op)', () => {
    expect(stripSelfMentions('hello world', [])).toBe('hello world');
  });

  it('resets regex lastIndex before matching (reusable patterns)', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    // Simulate prior use that advanced lastIndex.
    patterns[0].lastIndex = 5;
    patterns[1].lastIndex = 5;
    expect(stripSelfMentions('@bot hello', patterns)).toBe('hello');
  });

  it('preserves newlines and message structure when stripping a mention (#1854)', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    // A group @mention on a multi-line message must not flatten the structure.
    const input = '@bot here is my list:\n- item one\n- item two';
    expect(stripSelfMentions(input, patterns)).toBe('here is my list:\n- item one\n- item two');
  });

  it('returns multi-line text verbatim when no mention is present (non-destructive #1854)', () => {
    const patterns = buildSelfMentionStripPatterns(['bot']);
    // No self-mention → must NOT collapse newlines, blank lines, or internal spacing.
    const input = 'line one\nline  two\n\nline three';
    expect(stripSelfMentions(input, patterns)).toBe(input);
  });
});

describe('stripSelfMentionsFrom (convenience)', () => {
  it('builds patterns and strips in one call', () => {
    expect(stripSelfMentionsFrom('@15550100001 hello', ['15550100001'])).toBe('hello');
  });

  it('passes options through', () => {
    expect(
      stripSelfMentionsFrom('@bot hello', ['whatsapp:bot']),
    ).toBe('hello');
  });

  it('handles whatsapp: prefix in identifier (normalized, matches bare in text)', () => {
    // The whatsapp: prefix is stripped from the IDENTIFIER before building
    // patterns; the text itself contains the bare form.
    expect(
      stripSelfMentionsFrom('@15550100001 hi', ['whatsapp:15550100001']),
    ).toBe('hi');
  });
});

describe('realistic inbound scenarios', () => {
  it('strips bot mention from a typical group message', () => {
    const identifiers = ['15550100001', 'whatsapp:15550100001'];
    const text = '@15550100001 what is the weather in Tokyo?';
    expect(stripSelfMentionsFrom(text, identifiers)).toBe('what is the weather in Tokyo?');
  });

  it('leaves other users mentions intact', () => {
    const identifiers = ['15550100001'];
    const text = '@15550100001 ask @15550100222 about the meeting';
    expect(stripSelfMentionsFrom(text, identifiers)).toBe('ask @15550100222 about the meeting');
  });

  it('handles mention at end of message', () => {
    const identifiers = ['bot'];
    expect(stripSelfMentionsFrom('thanks @bot', identifiers)).toBe('thanks');
  });

  it('handles a message with only the mention token', () => {
    const identifiers = ['bot'];
    expect(stripSelfMentionsFrom('@bot', identifiers)).toBe('');
  });
});
