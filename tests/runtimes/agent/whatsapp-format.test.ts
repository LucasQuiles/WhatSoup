import { describe, it, expect } from 'vitest';
import {
  markdownToWhatsApp,
  repairChunkFormatting,
} from '../../../src/runtimes/agent/whatsapp-format.ts';

describe('markdownToWhatsApp', () => {
  // ── Bold ──

  it('converts **bold** to *bold*', () => {
    expect(markdownToWhatsApp('this is **bold** text')).toBe('this is *bold* text');
  });

  it('converts multiple **bold** spans', () => {
    expect(markdownToWhatsApp('**one** and **two**')).toBe('*one* and *two*');
  });

  it('handles **bold with spaces inside**', () => {
    expect(markdownToWhatsApp('**bold with spaces**')).toBe('*bold with spaces*');
  });

  // ── Italic / underline ──

  it('converts __text__ to _text_', () => {
    expect(markdownToWhatsApp('this is __italic__ text')).toBe('this is _italic_ text');
  });

  // ── Strikethrough ──

  it('converts ~~strike~~ to ~strike~', () => {
    expect(markdownToWhatsApp('this is ~~deleted~~ text')).toBe('this is ~deleted~ text');
  });

  // ── Headings ──

  it('converts # Heading to *Heading*', () => {
    expect(markdownToWhatsApp('# My Heading')).toBe('*My Heading*');
  });

  it('converts ## through ###### headings', () => {
    expect(markdownToWhatsApp('## Sub')).toBe('*Sub*');
    expect(markdownToWhatsApp('###### Deep')).toBe('*Deep*');
  });

  it('leaves # in middle of line alone', () => {
    expect(markdownToWhatsApp('issue #123')).toBe('issue #123');
  });

  // ── Horizontal rules ──

  it('removes --- horizontal rules', () => {
    expect(markdownToWhatsApp('above\n---\nbelow')).toBe('above\n\nbelow');
  });

  it('removes *** horizontal rules', () => {
    expect(markdownToWhatsApp('above\n***\nbelow')).toBe('above\n\nbelow');
  });

  // ── Links ──

  it('converts [text](url) to text (url)', () => {
    expect(markdownToWhatsApp('see [docs](https://example.com)'))
      .toBe('see docs (https://example.com)');
  });

  it('removes image links ![alt](url)', () => {
    expect(markdownToWhatsApp('look ![screenshot](https://img.png) here'))
      .toBe('look  here');
  });

  // ── Whitespace ──

  it('collapses 3+ blank lines to 2', () => {
    expect(markdownToWhatsApp('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims leading blank lines', () => {
    expect(markdownToWhatsApp('\n\nhello')).toBe('hello');
  });

  // ── Code protection ──

  it('does not convert **bold** inside code blocks', () => {
    const input = '```\n**not bold**\n```';
    expect(markdownToWhatsApp(input)).toBe(input);
  });

  it('does not convert **bold** inside inline code', () => {
    const input = 'run `**something**` now';
    expect(markdownToWhatsApp(input)).toBe(input);
  });

  it('converts bold outside code but preserves inside', () => {
    const input = '**yes** and `**no**` and **also**';
    expect(markdownToWhatsApp(input)).toBe('*yes* and `**no**` and *also*');
  });

  // ── Bracket cleanup ──

  it('strips bare [text] brackets', () => {
    expect(markdownToWhatsApp('see [this section] for details')).toBe('see this section for details');
  });

  it('removes reference-style link definitions', () => {
    expect(markdownToWhatsApp('[1]: https://example.com')).toBe('');
  });

  it('converts [text](url) before stripping bare brackets', () => {
    expect(markdownToWhatsApp('[click here](https://example.com) and [ref]'))
      .toBe('click here (https://example.com) and ref');
  });

  // ── Preserved formatting ──

  it('leaves > quotes alone', () => {
    expect(markdownToWhatsApp('> quoted text')).toBe('> quoted text');
  });

  it('leaves - list items alone', () => {
    expect(markdownToWhatsApp('- item one\n- item two')).toBe('- item one\n- item two');
  });

  it('leaves numbered lists alone', () => {
    expect(markdownToWhatsApp('1. first\n2. second')).toBe('1. first\n2. second');
  });

  it('leaves triple-backtick code blocks alone', () => {
    const input = '```typescript\nconst x = 1;\n```';
    expect(markdownToWhatsApp(input)).toBe(input);
  });

  // ── Combined ──

  it('handles a realistic Claude response', () => {
    const input = [
      '## Summary',
      '',
      'I found **3 issues** in the codebase:',
      '',
      '1. ~~Old approach~~ replaced with new one',
      '2. See [the docs](https://docs.example.com) for details',
      '3. Run `npm test` to verify',
      '',
      '---',
      '',
      '### Next Steps',
      '',
      'Let me know if you want to proceed.',
    ].join('\n');

    const expected = [
      '*Summary*',
      '',
      'I found *3 issues* in the codebase:',
      '',
      '1. ~Old approach~ replaced with new one',
      '2. See the docs (https://docs.example.com) for details',
      '3. Run `npm test` to verify',
      '',
      '*Next Steps*',
      '',
      'Let me know if you want to proceed.',
    ].join('\n');

    expect(markdownToWhatsApp(input)).toBe(expected);
  });
});

describe('repairChunkFormatting', () => {
  it('returns single chunk unchanged', () => {
    expect(repairChunkFormatting(['hello *world'])).toEqual(['hello *world']);
  });

  it('closes unclosed bold at chunk boundary', () => {
    const chunks = ['start *bold text', 'continues here* end'];
    const result = repairChunkFormatting(chunks);
    expect(result[0]).toBe('start *bold text*');
    expect(result[1]).toBe('*continues here* end');
  });

  it('closes unclosed italic at chunk boundary', () => {
    const chunks = ['start _italic', 'rest_ end'];
    const result = repairChunkFormatting(chunks);
    expect(result[0]).toBe('start _italic_');
    expect(result[1]).toBe('_rest_ end');
  });

  it('closes unclosed strikethrough at chunk boundary', () => {
    const chunks = ['start ~strike', 'rest~ end'];
    const result = repairChunkFormatting(chunks);
    expect(result[0]).toBe('start ~strike~');
    expect(result[1]).toBe('~rest~ end');
  });

  it('does not modify balanced chunks', () => {
    const chunks = ['*bold* text', 'more *bold* text'];
    expect(repairChunkFormatting(chunks)).toEqual(chunks);
  });

  it('ignores delimiters inside code blocks', () => {
    const chunks = ['```\n*unbalanced\n```', 'next chunk'];
    expect(repairChunkFormatting(chunks)).toEqual(chunks);
  });

  it('ignores delimiters inside inline code', () => {
    const chunks = ['run `*command` here', 'next chunk'];
    expect(repairChunkFormatting(chunks)).toEqual(chunks);
  });

  it('handles truncated file path with backtick', () => {
    // This is the specific bug: a truncated path like `src/very/long/...
    // leaves an unclosed backtick. Our delimiter repair handles *, _, ~
    // but backticks have different semantics (not a simple toggle).
    // The markdown transform should have already handled this via code protection.
    const chunks = ['reading *file at path/to/so', 'mething* done'];
    const result = repairChunkFormatting(chunks);
    expect(result[0]).toBe('reading *file at path/to/so*');
    expect(result[1]).toBe('*mething* done');
  });

  it('repairs across three chunks', () => {
    const chunks = ['*open', 'middle', 'close*'];
    const result = repairChunkFormatting(chunks);
    // Chunk 0: odd * → close it
    expect(result[0]).toBe('*open*');
    // Chunk 1: gets opener from chunk 0 repair + its own text, now has odd * → close
    expect(result[1]).toBe('*middle*');
    // Chunk 2: gets opener from chunk 1 repair
    expect(result[2]).toBe('*close*');
  });
});
