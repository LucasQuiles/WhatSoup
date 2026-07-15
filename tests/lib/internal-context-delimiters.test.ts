import { describe, expect, it } from 'vitest';

import { createInternalContextDelimiters } from '../../src/lib/internal-context-delimiters.ts';

const DELIMS = createInternalContextDelimiters({
  begin: '<<<BEGIN_INTERNAL>>>',
  end: '<<<END_INTERNAL>>>',
});

describe('createInternalContextDelimiters — construction', () => {
  it('throws when begin is empty', () => {
    expect(() => createInternalContextDelimiters({ begin: '', end: 'x' })).toThrow(/required/);
  });

  it('throws when end is empty', () => {
    expect(() => createInternalContextDelimiters({ begin: 'x', end: '' })).toThrow(/required/);
  });

  it('exposes the delimiter tokens', () => {
    expect(DELIMS.begin).toBe('<<<BEGIN_INTERNAL>>>');
    expect(DELIMS.end).toBe('<<<END_INTERNAL>>>');
  });
});

describe('wrap', () => {
  it('wraps inner content in delimiters', () => {
    expect(DELIMS.wrap('hello')).toBe('<<<BEGIN_INTERNAL>>>\nhello\n<<<END_INTERNAL>>>');
  });

  it('wraps multiline content', () => {
    expect(DELIMS.wrap('line1\nline2')).toBe(
      '<<<BEGIN_INTERNAL>>>\nline1\nline2\n<<<END_INTERNAL>>>',
    );
  });

  it('wraps empty content', () => {
    expect(DELIMS.wrap('')).toBe('<<<BEGIN_INTERNAL>>>\n\n<<<END_INTERNAL>>>');
  });
});

describe('hasInternalContext', () => {
  it('returns true when begin token is present at line boundary', () => {
    expect(DELIMS.hasInternalContext(`prefix\n<<<BEGIN_INTERNAL>>>\nbody\n<<<END_INTERNAL>>>`)).toBe(
      true,
    );
  });

  it('returns true when only begin token is present (unterminated)', () => {
    expect(DELIMS.hasInternalContext('<<<BEGIN_INTERNAL>>>\nno end')).toBe(true);
  });

  it('returns false when begin token is mid-line (not at boundary)', () => {
    expect(DELIMS.hasInternalContext('mid <<<BEGIN_INTERNAL>>> line')).toBe(false);
  });

  it('returns false for plain text', () => {
    expect(DELIMS.hasInternalContext('just user text')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(DELIMS.hasInternalContext('')).toBe(false);
  });

  it('returns true when begin is at start of text', () => {
    expect(DELIMS.hasInternalContext('<<<BEGIN_INTERNAL>>>\nx\n<<<END_INTERNAL>>>')).toBe(true);
  });
});

describe('stripInternalContext', () => {
  it('removes a single delimited block', () => {
    const input = 'before\n<<<BEGIN_INTERNAL>>>\nsecret\n<<<END_INTERNAL>>>\nafter';
    expect(DELIMS.stripInternalContext(input)).toBe('before\n\nafter');
  });

  it('removes multiple delimited blocks', () => {
    const input =
      'a\n<<<BEGIN_INTERNAL>>>\n1\n<<<END_INTERNAL>>>\nb\n<<<BEGIN_INTERNAL>>>\n2\n<<<END_INTERNAL>>>\nc';
    expect(DELIMS.stripInternalContext(input)).toBe('a\n\nb\n\nc');
  });

  it('handles block at start of text', () => {
    const input = '<<<BEGIN_INTERNAL>>>\nsecret\n<<<END_INTERNAL>>>\nafter';
    expect(DELIMS.stripInternalContext(input)).toBe('after');
  });

  it('handles block at end of text', () => {
    const input = 'before\n<<<BEGIN_INTERNAL>>>\nsecret\n<<<END_INTERNAL>>>';
    expect(DELIMS.stripInternalContext(input)).toBe('before');
  });

  it('handles block as entire text', () => {
    const input = '<<<BEGIN_INTERNAL>>>\nsecret\n<<<END_INTERNAL>>>';
    expect(DELIMS.stripInternalContext(input)).toBe('');
  });

  it('handles nested (depth-aware) blocks', () => {
    const input =
      'outer-before\n<<<BEGIN_INTERNAL>>>\nouter\n<<<BEGIN_INTERNAL>>>\ninner\n<<<END_INTERNAL>>>\nouter-after\n<<<END_INTERNAL>>>\nvisible';
    // Both outer and inner are stripped together.
    expect(DELIMS.stripInternalContext(input)).toBe('outer-before\n\nvisible');
  });

  it('drops unterminated block entirely', () => {
    const input = 'before\n<<<BEGIN_INTERNAL>>>\nunterminated';
    expect(DELIMS.stripInternalContext(input)).toBe('before');
  });

  it('returns empty string unchanged', () => {
    expect(DELIMS.stripInternalContext('')).toBe('');
  });

  it('returns plain text unchanged', () => {
    expect(DELIMS.stripInternalContext('just text')).toBe('just text');
  });

  it('ignores begin token mid-line (does not start a block)', () => {
    const input = 'text <<<BEGIN_INTERNAL>>> still text <<<END_INTERNAL>>> end';
    expect(DELIMS.stripInternalContext(input)).toBe(input);
  });

  it('collapses multiple blank lines after stripping', () => {
    const input = 'a\n<<<BEGIN_INTERNAL>>>\nx\n<<<END_INTERNAL>>>\n\n\nb';
    expect(DELIMS.stripInternalContext(input)).toBe('a\n\nb');
  });
});

describe('extractInternalContext', () => {
  it('extracts a single block and returns remaining text', () => {
    const input = 'before\n<<<BEGIN_INTERNAL>>>\nsecret\n<<<END_INTERNAL>>>\nafter';
    const result = DELIMS.extractInternalContext(input);
    expect(result.text).toBe('before\n\nafter');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toContain('secret');
    expect(result.blocks[0]).toContain('<<<BEGIN_INTERNAL>>>');
  });

  it('extracts multiple blocks', () => {
    const input =
      'a\n<<<BEGIN_INTERNAL>>>\n1\n<<<END_INTERNAL>>>\nb\n<<<BEGIN_INTERNAL>>>\n2\n<<<END_INTERNAL>>>\nc';
    const result = DELIMS.extractInternalContext(input);
    expect(result.blocks).toHaveLength(2);
    expect(result.text).toBe('a\n\nb\n\nc');
  });

  it('returns empty blocks array when no markers present', () => {
    const result = DELIMS.extractInternalContext('just text');
    expect(result.blocks).toEqual([]);
    expect(result.text).toBe('just text');
  });

  it('returns the joined blocks for nested extraction', () => {
    const input =
      '<<<BEGIN_INTERNAL>>>\nouter\n<<<BEGIN_INTERNAL>>>\ninner\n<<<END_INTERNAL>>>\nrest\n<<<END_INTERNAL>>>';
    const result = DELIMS.extractInternalContext(input);
    expect(result.text).toBe('');
    // Nested block is consumed by the outer block.
    expect(result.blocks).toHaveLength(1);
  });
});

describe('escapeDelimiters', () => {
  it('replaces begin token with escaped form', () => {
    const escaped = DELIMS.escapeDelimiters('text <<<BEGIN_INTERNAL>>> more');
    expect(escaped).not.toContain('<<<BEGIN_INTERNAL>>>');
    expect(escaped).toContain('[[WHATSOUPEscaped_BEGIN]]');
  });

  it('replaces end token with escaped form', () => {
    const escaped = DELIMS.escapeDelimiters('text <<<END_INTERNAL>>> more');
    expect(escaped).not.toContain('<<<END_INTERNAL>>>');
    expect(escaped).toContain('[[WHATSOUPEscaped_END]]');
  });

  it('replaces multiple occurrences', () => {
    const escaped = DELIMS.escapeDelimiters(
      '<<<BEGIN_INTERNAL>>><<<END_INTERNAL>>><<<BEGIN_INTERNAL>>>',
    );
    expect(escaped.match(/BEGIN/g)).toHaveLength(2);
    expect(escaped.match(/END/g)).toHaveLength(1);
  });

  it('does not alter text without delimiters', () => {
    expect(DELIMS.escapeDelimiters('plain text')).toBe('plain text');
  });

  it('prevents escaped text from being recognized by hasInternalContext', () => {
    const escaped = DELIMS.escapeDelimiters('<<<BEGIN_INTERNAL>>>\ninjected\n<<<END_INTERNAL>>>');
    expect(DELIMS.hasInternalContext(escaped)).toBe(false);
  });

  it('prevents escaped text from being stripped', () => {
    const escaped = DELIMS.escapeDelimiters('<<<BEGIN_INTERNAL>>>\ninjected\n<<<END_INTERNAL>>>');
    expect(DELIMS.stripInternalContext(escaped)).toBe(escaped);
  });

  it('handles empty string', () => {
    expect(DELIMS.escapeDelimiters('')).toBe('');
  });
});

describe('independent instances', () => {
  it('separate factories do not interfere', () => {
    const other = createInternalContextDelimiters({
      begin: '[[START]]',
      end: '[[STOP]]',
    });
    expect(DELIMS.hasInternalContext('<<<BEGIN_INTERNAL>>>\nx')).toBe(true);
    expect(other.hasInternalContext('<<<BEGIN_INTERNAL>>>\nx')).toBe(false);
    expect(other.hasInternalContext('[[START]]\nx')).toBe(true);
  });

  it('separate factories use their own delimiters', () => {
    const other = createInternalContextDelimiters({
      begin: '[[START]]',
      end: '[[STOP]]',
    });
    expect(other.wrap('hi')).toBe('[[START]]\nhi\n[[STOP]]');
    expect(other.stripInternalContext('a\n[[START]]\nx\n[[STOP]]\nb')).toBe('a\n\nb');
  });
});

describe('round-trip integration', () => {
  it('escapes untrusted inner content then strips cleanly', () => {
    // Simulate: user injects delimiter text into a context block.
    const injected = '<<<BEGIN_INTERNAL>>>\ninjected\n<<<END_INTERNAL>>>';
    const safeInner = DELIMS.escapeDelimiters(injected);
    const block = DELIMS.wrap(`safe context\nuser-said: ${safeInner}`);
    // Model echoes the whole block back to the user.
    const modelOutput = `user reply\n${block}\nmore reply`;
    // Strip before delivery.
    const delivered = DELIMS.stripInternalContext(modelOutput);
    expect(delivered).toBe('user reply\n\nmore reply');
    // The injected block never escaped into visible text.
    expect(delivered).not.toContain('injected');
  });
});
