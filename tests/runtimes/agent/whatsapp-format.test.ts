import { describe, it, expect } from 'vitest';
import {
  markdownToWhatsApp,
  repairChunkFormatting,
} from '../../../src/runtimes/agent/whatsapp-format.ts';

describe('markdownToWhatsApp', () => {
  const nestedTag = (tag: string, depth: number): [string, string] => {
    if (depth === 0) return [`<${tag}>`, `</${tag}>`];

    const [open, close] = nestedTag(tag, depth - 1);
    const split = Math.ceil(tag.length / 2);

    return [
      `<${tag.slice(0, split)}${open}${tag.slice(split)}>`,
      `</${tag.slice(0, split)}${close}${tag.slice(split)}>`,
    ];
  };

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

  // ── Multiline bold ──

  it('converts **bold** spanning multiple lines', () => {
    expect(markdownToWhatsApp('the **quick brown\nfox** jumps'))
      .toBe('the *quick brown\nfox* jumps');
  });

  // ── HTML cleanup ──

  it('strips <details>/<summary> and bolds summary text', () => {
    expect(markdownToWhatsApp('<details><summary>Click here</summary>\nHidden content\n</details>'))
      .toBe('*Click here*\nHidden content\n');
  });

  it('converts <br> to newline', () => {
    expect(markdownToWhatsApp('line one<br>line two')).toBe('line one\nline two');
  });

  it('strips other HTML tags but keeps content', () => {
    expect(markdownToWhatsApp('<em>italic</em> and <strong>bold</strong>'))
      .toBe('italic and bold');
  });

  it('iterates nested HTML-like tag stripping to remove malicious script residue', () => {
    const output = markdownToWhatsApp('<scrip<script>t>alert(1)</script>');

    expect(output).toBe('alert(1)');
    expect(output).not.toMatch(/<\/?script/i);
  });

  it('strips malformed nested tags without leaving tag-like residue', () => {
    const output = markdownToWhatsApp('<di<div>v>content</di</div>v>');

    expect(output).toBe('content');
    expect(output).not.toMatch(/<[A-Za-z/]/);
  });

  it('strips deeply nested tag-like residue within the bounded fixed-point loop', () => {
    const [open, close] = nestedTag('span', 6);
    const output = markdownToWhatsApp(`${open}safe${close}`);

    expect(output).toBe('safe');
    expect(output).not.toMatch(/<[A-Za-z/]/);
  });

  it('strips tag-like residue beyond the current bounded loop depth', () => {
    const [open, close] = nestedTag('script', 8);
    const output = markdownToWhatsApp(`${open}alert(1)${close}`);

    expect(output).toBe('alert(1)');
    expect(output).not.toMatch(/<[A-Za-z/]/);
  });

  it('strips tag-like residue at depth sixteen', () => {
    const [open, close] = nestedTag('script', 16);
    const output = markdownToWhatsApp(`${open}alert(1)${close}`);

    expect(output).toBe('alert(1)');
    expect(output).not.toMatch(/<[A-Za-z/]/);
  });

  it('preserves plain comparison text when stripping HTML-like tags', () => {
    expect(markdownToWhatsApp('2 < 3 and 4 > 1')).toBe('2 < 3 and 4 > 1');
    expect(markdownToWhatsApp('5<x<10')).toBe('5<x<10');
  });

  it('preserves mathematical expressions in code blocks', () => {
    const input = '```text\n2 < 3 and 5<x<10\n```';
    expect(markdownToWhatsApp(input)).toBe(input);
  });

  it('strips tag attributes with the tag wrapper', () => {
    expect(markdownToWhatsApp('<a href="https://example.com">text</a>')).toBe('text');
  });

  it('strips HTML comments', () => {
    expect(markdownToWhatsApp('before <!-- hidden --> after')).toBe('before  after');
  });

  it('preserves malformed trailing less-than text', () => {
    expect(markdownToWhatsApp('text<')).toBe('text<');
  });

  it('decodes HTML entities', () => {
    expect(markdownToWhatsApp('a &lt; b &amp; c &gt; d')).toBe('a < b & c > d');
    expect(markdownToWhatsApp('&quot;hello&quot;')).toBe('"hello"');
  });

  it('does not double-unescape ampersand-encoded quote and less-than entities', () => {
    expect(markdownToWhatsApp('&amp;quot;')).toBe('&quot;');
    expect(markdownToWhatsApp('&amp;lt;')).toBe('&lt;');
  });

  it('still decodes direct quote entities and plain ampersands', () => {
    expect(markdownToWhatsApp('&quot;hello&quot;')).toBe('"hello"');
    expect(markdownToWhatsApp('Tom &amp; Jerry')).toBe('Tom & Jerry');
  });

  it('leaves encoded script tags as literal WhatsApp text after tag stripping', () => {
    // Entity decoding intentionally runs after tag stripping; WhatsApp treats the result as text.
    expect(markdownToWhatsApp('&lt;script&gt;alert(1)&lt;/script&gt;'))
      .toBe('<script>alert(1)</script>');
  });

  // ── Table cleanup ──

  it('strips pipe table separator rows', () => {
    expect(markdownToWhatsApp('| --- | --- |')).toBe('');
  });

  it('strips leading/trailing pipes from table rows', () => {
    expect(markdownToWhatsApp('| name | value |')).toBe('name | value');
  });

  it('handles a full pipe table', () => {
    const input = '| Tool | Status |\n| --- | --- |\n| Read | OK |\n| Write | OK |';
    const expected = 'Tool | Status\nRead | OK\nWrite | OK';
    expect(markdownToWhatsApp(input)).toBe(expected);
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

describe('markdownToWhatsApp — bracket-transform DoS bound (QR-083)', () => {
  it('does not blow up O(n^2) on a long bracket-heavy reply (event-loop DoS)', () => {
    const huge = '['.repeat(200_000);
    const start = Date.now();
    const out = markdownToWhatsApp(huge);
    const elapsed = Date.now() - start;
    // Without the length guard this is multi-second (quadratic). With it, the
    // oversized bracket blob skips the expensive transforms → near-instant.
    expect(elapsed).toBeLessThan(200);
    // Oversized text is returned (un-mangled is fine; brackets left as-is).
    expect(out.length).toBeGreaterThan(0);
  });

  it('still converts brackets/links for normal-size replies (below the cap)', () => {
    expect(markdownToWhatsApp('see [the docs](https://x.example)')).toContain('the docs (https://x.example)');
    expect(markdownToWhatsApp('a [bare] ref')).toBe('a bare ref');
    // bold still applies regardless
    expect(markdownToWhatsApp('**hi**')).toBe('*hi*');
  });
});
