import { describe, it, expect } from 'vitest';
import { splitSearchHighlights } from '../../console/src/lib/search-highlight.ts';
import { formatWhatsAppText } from '../../console/src/lib/format-wa-text.tsx';

describe('splitSearchHighlights', () => {
  it('highlights multiple query terms case-insensitively and ignores boolean operators', () => {
    expect(splitSearchHighlights('Alpha beta gamma beta', 'alpha OR beta')).toEqual([
      { text: 'Alpha', matched: true },
      { text: ' ', matched: false },
      { text: 'beta', matched: true },
      { text: ' gamma ', matched: false },
      { text: 'beta', matched: true },
    ]);
  });
});

describe('formatWhatsAppText', () => {
  it('returns an empty-state marker for nullish or blank text', () => {
    expect(formatWhatsAppText(null as unknown as string)).toEqual(['—']);
    expect(formatWhatsAppText(undefined as unknown as string)).toEqual(['—']);
    expect(formatWhatsAppText('')).toEqual(['—']);
    expect(formatWhatsAppText('   ')).toEqual(['—']);
  });

  it('highlights matches inside formatted spans', () => {
    const parts = formatWhatsAppText('hello *beta* world', 'beta');

    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('hello ');
    expect(parts[2]).toBe(' world');

    const strong = parts[1] as { type: string; props: { children: unknown } };
    expect(strong.type).toBe('strong');

    const children = Array.isArray(strong.props.children)
      ? strong.props.children
      : [strong.props.children];

    expect(children).toHaveLength(1);
    expect((children[0] as { type: string }).type).toBe('mark');
    expect((children[0] as { props: { children: string } }).props.children).toBe('beta');
  });
});
