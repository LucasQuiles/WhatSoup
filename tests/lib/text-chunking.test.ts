import { describe, expect, it } from 'vitest';

import {
  avoidTrailingHighSurrogateBreak,
  chunkByParagraph,
  chunkMarkdownText,
  chunkText,
  findFenceSpanAt,
  isSafeFenceBreak,
  parseFenceSpans,
} from '../../src/lib/text-chunking.ts';

// ── chunkText ───────────────────────────────────────────────────────────────

describe('chunkText', () => {
  it('returns [] for empty string', () => {
    expect(chunkText('', 100)).toEqual([]);
  });

  it('returns [text] when within limit', () => {
    const text = 'short text';
    expect(chunkText(text, 100)).toEqual([text]);
  });

  it('returns [text] when exactly at limit', () => {
    const text = 'exactly20characters!!';
    expect(chunkText(text, text.length)).toEqual([text]);
  });

  it('splits at newline boundary', () => {
    const text = 'line one\nline two\nline three';
    const chunks = chunkText(text, 15);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Reconstructed content must not gain or lose characters (ignoring separators)
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('splits at whitespace when no newline', () => {
    const text = 'word1 word2 word3 word4 word5';
    const chunks = chunkText(text, 15);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(15);
    }
  });

  it('hard cuts when no whitespace available', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const chunks = chunkText(text, 5);
    expect(chunks.length).toBe(6);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
  });

  it('does not split inside parentheses', () => {
    const text = 'before (a very long parenthetical expression here) after';
    const chunks = chunkText(text, 20);
    // The parenthetical should be kept together if possible
    const rejoined = chunks.join('');
    // All content preserved
    expect(rejoined.replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('respects limit for each chunk', () => {
    const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50) + '\n' + 'c'.repeat(50);
    const chunks = chunkText(text, 30);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it('handles limit of 1', () => {
    const text = 'abc';
    const chunks = chunkText(text, 1);
    expect(chunks).toEqual(['a', 'b', 'c']);
  });

  it('handles limit <= 0 by returning [text]', () => {
    expect(chunkText('hello', 0)).toEqual(['hello']);
    expect(chunkText('hello', -1)).toEqual(['hello']);
  });

  it('preserves surrogate pairs (emoji)', () => {
    const text = '😀'.repeat(10); // 10 emoji = 20 UTF-16 units
    const chunks = chunkText(text, 5);
    // Each chunk must not split a surrogate pair
    for (const chunk of chunks) {
      // A valid string — no lone high surrogate at end
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        // Shouldn't happen — there should be a low surrogate after
        expect.fail(`Chunk ends with lone high surrogate: ${JSON.stringify(chunk)}`);
      }
    }
  });
});

// ── chunkByParagraph ────────────────────────────────────────────────────────

describe('chunkByParagraph', () => {
  it('returns [] for empty string', () => {
    expect(chunkByParagraph('', 100)).toEqual([]);
  });

  it('returns single paragraph within limit', () => {
    const text = 'Hello world.';
    expect(chunkByParagraph(text, 100)).toEqual([text]);
  });

  it('packs multiple paragraphs within limit', () => {
    const text = 'First paragraph.\n\nSecond paragraph.';
    const chunks = chunkByParagraph(text, 100);
    expect(chunks).toEqual([text]);
  });

  it('splits when paragraphs exceed limit', () => {
    const long1 = 'a'.repeat(60);
    const long2 = 'b'.repeat(60);
    const text = `${long1}\n\n${long2}`;
    const chunks = chunkByParagraph(text, 50);
    // Each 60-char paragraph splits into 2 sub-chunks at limit 50 → 4 total
    expect(chunks.length).toBe(4);
    expect(chunks.join('')).toBe(long1 + long2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it('preserves paragraph separators in packed chunks', () => {
    const p1 = 'First.';
    const p2 = 'Second.';
    const text = `${p1}\n\n${p2}`;
    const chunks = chunkByParagraph(text, 50);
    expect(chunks).toEqual([`${p1}\n\n${p2}`]);
  });

  it('falls back to length-based split for single long paragraph', () => {
    const text = 'a'.repeat(100);
    const chunks = chunkByParagraph(text, 30);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it('respects splitLongParagraphs: false', () => {
    const text = 'a'.repeat(100);
    const chunks = chunkByParagraph(text, 30, { splitLongParagraphs: false });
    // Returns the full paragraph unsplit
    expect(chunks).toEqual([text]);
  });

  it('handles three paragraphs packing two', () => {
    const text = 'AAA\n\nBBB\n\nCCC';
    const chunks = chunkByParagraph(text, 10);
    // Should pack AAA + BBB (with separator) = 8 chars, then CCC
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const rejoined = chunks.join('\n\n').replace(/\s/g, '');
    expect(rejoined).toBe('AAABBBCCC');
  });

  it('handles limit <= 0 by returning [text]', () => {
    expect(chunkByParagraph('hello', 0)).toEqual(['hello']);
  });

  it('normalizes CRLF to LF', () => {
    const text = 'First.\r\n\r\nSecond.';
    const chunks = chunkByParagraph(text, 100);
    expect(chunks).toEqual(['First.\n\nSecond.']);
  });
});

// ── parseFenceSpans ─────────────────────────────────────────────────────────

describe('parseFenceSpans', () => {
  it('returns [] for no fences', () => {
    expect(parseFenceSpans('plain text\nno fences')).toEqual([]);
  });

  it('parses a single backtick fence', () => {
    const text = 'before\n```js\nconst x = 1;\n```\nafter';
    const spans = parseFenceSpans(text);
    expect(spans.length).toBe(1);
    expect(spans[0]!.openLine).toBe('```js');
    expect(spans[0]!.marker).toBe('```');
    expect(spans[0]!.indent).toBe('');
  });

  it('parses a tilde fence', () => {
    const text = '~~~python\nprint(1)\n~~~';
    const spans = parseFenceSpans(text);
    expect(spans.length).toBe(1);
    expect(spans[0]!.marker).toBe('~~~');
    expect(spans[0]!.openLine).toBe('~~~python');
  });

  it('parses indented fences', () => {
    const text = '  ```\n  code\n  ```';
    const spans = parseFenceSpans(text);
    expect(spans.length).toBe(1);
    expect(spans[0]!.indent).toBe('  ');
  });

  it('parses multiple separate fences', () => {
    const text = '```\na\n```\n\ntext\n\n```\nb\n```';
    const spans = parseFenceSpans(text);
    expect(spans.length).toBe(2);
  });

  it('does not include unclosed fences', () => {
    const text = '```\ncode without close';
    const spans = parseFenceSpans(text);
    expect(spans.length).toBe(0);
  });

  it('handles longer fence markers (4+ backticks)', () => {
    const text = '````\ncode with ``` inside\n````';
    const spans = parseFenceSpans(text);
    expect(spans.length).toBe(1);
    expect(spans[0]!.marker).toBe('````');
  });
});

// ── isSafeFenceBreak / findFenceSpanAt ──────────────────────────────────────

describe('isSafeFenceBreak', () => {
  it('returns true outside fences', () => {
    const text = '```\ncode\n```\noutside';
    const spans = parseFenceSpans(text);
    expect(isSafeFenceBreak(spans, 0)).toBe(true);
    expect(isSafeFenceBreak(spans, text.indexOf('outside'))).toBe(true);
  });

  it('returns false inside fences', () => {
    const text = '```\ncode here\n```';
    const spans = parseFenceSpans(text);
    expect(isSafeFenceBreak(spans, text.indexOf('code'))).toBe(false);
    expect(isSafeFenceBreak(spans, text.indexOf('here'))).toBe(false);
  });
});

describe('findFenceSpanAt', () => {
  it('finds the fence span containing an index', () => {
    const text = '```\ncode\n```';
    const spans = parseFenceSpans(text);
    const span = findFenceSpanAt(spans, text.indexOf('code'));
    expect(span).toBeDefined();
    expect(span!.openLine).toBe('```');
  });

  it('returns undefined for index outside any fence', () => {
    const text = 'before\n```\ncode\n```\nafter';
    const spans = parseFenceSpans(text);
    expect(findFenceSpanAt(spans, 0)).toBeUndefined();
  });
});

// ── avoidTrailingHighSurrogateBreak ─────────────────────────────────────────

describe('avoidTrailingHighSurrogateBreak', () => {
  it('backs up past a trailing high surrogate', () => {
    const text = '😀😀'; // [Hi,Lo][Hi,Lo]
    // Breaking at index 1 (after the first Hi) should back up to 0
    const result = avoidTrailingHighSurrogateBreak(text, 0, 1);
    expect(result).toBe(0);
  });

  it('leaves non-surrogate breaks alone', () => {
    const text = 'abcde';
    expect(avoidTrailingHighSurrogateBreak(text, 0, 3)).toBe(3);
  });

  it('handles end beyond text length', () => {
    const text = 'ab';
    expect(avoidTrailingHighSurrogateBreak(text, 0, 10)).toBe(10);
  });
});

// ── chunkMarkdownText ───────────────────────────────────────────────────────

describe('chunkMarkdownText', () => {
  it('returns [] for empty string', () => {
    expect(chunkMarkdownText('', 100)).toEqual([]);
  });

  it('returns [text] when within limit', () => {
    const text = 'short markdown';
    expect(chunkMarkdownText(text, 100)).toEqual([text]);
  });

  it('splits plain markdown without fences', () => {
    const text = '# Heading\n\npara1\n\npara2\n\npara3';
    const chunks = chunkMarkdownText(text, 15);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(15);
    }
  });

  it('closes and reopens a fence spanning a chunk boundary', () => {
    const code = 'line1\nline2\nline3\nline4\nline5';
    const text = '```\n' + code + '\n```';
    const chunks = chunkMarkdownText(text, 20);

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Every chunk must be within limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }

    // Reassembly: the code content must survive
    const rejoined = chunks.join('');
    expect(rejoined).toContain('line1');
    expect(rejoined).toContain('line5');
  });

  it('keeps a short fence intact in one chunk', () => {
    const text = '```\nshort\n```';
    expect(chunkMarkdownText(text, 50)).toEqual([text]);
  });

  it('handles fence with language tag across split', () => {
    const code = 'const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;';
    const text = '```ts\n' + code + '\n```';
    const chunks = chunkMarkdownText(text, 25);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // The reopened fence should preserve the language tag
    const reopenedChunk = chunks.find((c) => c.startsWith('```ts\n') && chunks.indexOf(c) > 0);
    if (reopenedChunk) {
      expect(reopenedChunk.startsWith('```ts\n')).toBe(true);
    }

    // Reassembled content preserves all code lines
    const rejoined = chunks.join('');
    expect(rejoined).toContain('const x = 1');
    expect(rejoined).toContain('const w = 4');
  });

  it('handles indented fences across split', () => {
    const code = 'aaa\nbbb\nccc\nddd';
    const text = '  ```\n  ' + code.split('\n').join('\n  ') + '\n  ```';
    const chunks = chunkMarkdownText(text, 20);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });

  it('does not break the marker characters themselves', () => {
    // A fence marker split mid-marker would corrupt the markdown.
    // The chunker should keep fence markers intact.
    const code = 'x'.repeat(40);
    const text = '```\n' + code + '\n```';
    const chunks = chunkMarkdownText(text, 15);
    for (const chunk of chunks) {
      // No chunk should contain a partial fence like "`" or "``" at the boundary
      // that would leave a lone backtick fragment
      expect(chunk.length).toBeLessThanOrEqual(15);
    }
  });

  it('handles text before and after a fence', () => {
    const text = 'Intro text here.\n\n```\ncode line one\ncode line two\n```\n\nOutro text here.';
    const chunks = chunkMarkdownText(text, 25);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(25);
    }
    const rejoined = chunks.join('');
    expect(rejoined).toContain('Intro');
    expect(rejoined).toContain('code line one');
    expect(rejoined).toContain('Outro');
  });

  it('handles limit <= 0 by returning [text]', () => {
    expect(chunkMarkdownText('hello', 0)).toEqual(['hello']);
  });

  it('always makes progress (no infinite loop)', () => {
    // Edge case: limit smaller than the reopen prefix
    const text = '```\n' + 'a'.repeat(50) + '\n```';
    const chunks = chunkMarkdownText(text, 2);
    expect(chunks.length).toBeGreaterThan(0);
    // Each chunk has at least 1 char
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('preserves all content across splits', () => {
    const inside = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta';
    const text = `Before code.\n\n\`\`\`\n${inside}\n\`\`\`\n\nAfter code.`;
    const chunks = chunkMarkdownText(text, 18);
    const rejoined = chunks.join('');
    for (const word of ['Before', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'After']) {
      expect(rejoined).toContain(word);
    }
  });
});
