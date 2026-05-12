/**
 * @vitest-environment jsdom
 *
 * Format-pattern coverage for console/src/lib/format-wa-text.tsx.
 *
 * Existing tests/console/search-highlight.test.ts covers the empty-state
 * fallback + bold-with-highlight integration. This file pins each of the
 * remaining WhatsApp format patterns to the helper's React-node contract:
 *
 *   - inline backtick code         ->  <code>
 *   - single-line triple backticks ->  <code> (block class)
 *   - *bold*                       ->  <strong>
 *   - **bold**                     ->  <strong>
 *   - _italic_                     ->  <em>
 *   - ~strikethrough~              ->  <s>
 *   - https URL                    ->  <a target=_blank rel=noopener noreferrer>
 *   - long URL (>50 chars)         ->  href = full, child = truncated with ...
 *   - multi-line text              ->  <br /> between lines
 *   - plain text                   ->  string children
 *
 * The function returns ReactNode[], so most assertions inspect that tree
 * directly. A rendered assertion below checks the user-visible text/link path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { formatWhatsAppText } from '../../console/src/lib/format-wa-text.tsx';

type FormatElementProps = {
  children?: ReactNode;
  className?: string;
  href?: string;
  rel?: string;
  target?: string;
};

afterEach(() => cleanup());

function asElement<P extends FormatElementProps = FormatElementProps>(node: ReactNode): ReactElement<P> {
  if (isValidElement<P>(node)) {
    return node;
  }
  throw new Error(`expected ReactElement, got ${typeof node}: ${String(node)}`);
}

function plainText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(plainText).join('');
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return plainText(children.props.children);
  }
  return '';
}

function isFormatElement(node: ReactNode): node is ReactElement<FormatElementProps> {
  return isValidElement<FormatElementProps>(node);
}

function isElementType(node: ReactNode, type: string): node is ReactElement<FormatElementProps> {
  return isFormatElement(node) && node.type === type;
}

describe('formatWhatsAppText — single-pattern formats', () => {
  it('wraps *bold* in <strong>', () => {
    const parts = formatWhatsAppText('a *b* c');
    // parts: ['a ', <strong>b</strong>, ' c']
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('a ');
    const strong = asElement(parts[1]);
    expect(strong.type).toBe('strong');
    expect(plainText(strong.props.children)).toBe('b');
    expect(parts[2]).toBe(' c');
  });

  it('wraps **double-asterisk bold** in <strong>', () => {
    const parts = formatWhatsAppText('**b**');
    const strong = asElement(parts[0]);
    expect(strong.type).toBe('strong');
    expect(plainText(strong.props.children)).toBe('b');
  });

  it('wraps _italic_ in <em>', () => {
    const parts = formatWhatsAppText('a _i_ b');
    const em = asElement(parts[1]);
    expect(em.type).toBe('em');
    expect(plainText(em.props.children)).toBe('i');
  });

  it('wraps ~strikethrough~ in <s>', () => {
    const parts = formatWhatsAppText('~s~');
    const s = asElement(parts[0]);
    expect(s.type).toBe('s');
    expect(plainText(s.props.children)).toBe('s');
  });

  it('wraps `inline code` in <code>', () => {
    const parts = formatWhatsAppText('a `x` b');
    const code = asElement(parts[1]);
    expect(code.type).toBe('code');
    expect(plainText(code.props.children)).toBe('x');
  });

  it('wraps single-line triple-backtick text in <code> (block variant)', () => {
    const parts = formatWhatsAppText('```code-block```');
    const code = asElement(parts[0]);
    expect(code.type).toBe('code');
    expect(plainText(code.props.children)).toBe('code-block');
    // Block variant carries a distinct className (`block` token)
    expect(String(code.props.className)).toContain('block');
  });
});

describe('formatWhatsAppText — URLs', () => {
  it('wraps an https URL in <a target=_blank rel=noopener noreferrer>', () => {
    const parts = formatWhatsAppText('go to https://example.com now');
    const link = asElement(parts[1]);
    expect(link.type).toBe('a');
    expect(link.props.href).toBe('https://example.com');
    expect(link.props.target).toBe('_blank');
    expect(link.props.rel).toBe('noopener noreferrer');
    expect(plainText(link.props.children)).toBe('https://example.com');
  });

  it('truncates display text for URLs longer than 50 chars but keeps full href', () => {
    const longUrl = 'https://example.com/very/long/path/' + 'x'.repeat(40);
    expect(longUrl.length).toBeGreaterThan(50);
    const parts = formatWhatsAppText(longUrl);
    const link = asElement(parts[0]);
    expect(link.props.href).toBe(longUrl);
    const displayed = plainText(link.props.children);
    expect(displayed.length).toBe(50);
    expect(displayed.endsWith('...')).toBe(true);
    expect(longUrl.startsWith(displayed.slice(0, 47))).toBe(true);
  });

  it('treats http:// (not just https) as a link', () => {
    const parts = formatWhatsAppText('http://x.test/y');
    const link = asElement(parts[0]);
    expect(link.type).toBe('a');
    expect(link.props.href).toBe('http://x.test/y');
  });
});

describe('formatWhatsAppText — line breaks and plain text', () => {
  it('inserts <br /> between lines', () => {
    const parts = formatWhatsAppText('one\ntwo');
    // Expected: ['one', <br />, 'two']
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('one');
    expect(asElement(parts[1]).type).toBe('br');
    expect(parts[2]).toBe('two');
  });

  it('renders visible formatted text and links', () => {
    render(createElement('div', null, formatWhatsAppText('go *now* https://example.com')));

    expect(screen.getByText('now').tagName).toBe('STRONG');
    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('returns plain string when no patterns match', () => {
    const parts = formatWhatsAppText('hello world');
    expect(parts).toEqual(['hello world']);
  });
});

describe('formatWhatsAppText — combined patterns', () => {
  it('preserves leading and trailing plain text around a format span', () => {
    const parts = formatWhatsAppText('before *bold* after');
    expect(parts[0]).toBe('before ');
    expect(asElement(parts[1]).type).toBe('strong');
    expect(parts[2]).toBe(' after');
  });

  it('renders adjacent formats independently', () => {
    const parts = formatWhatsAppText('*a* _b_');
    const strong = parts.find((p): p is ReactElement<FormatElementProps> => isElementType(p, 'strong'));
    const em = parts.find((p): p is ReactElement<FormatElementProps> => isElementType(p, 'em'));
    expect(strong).toBeDefined();
    expect(em).toBeDefined();
    expect(plainText(strong?.props.children)).toBe('a');
    expect(plainText(em?.props.children)).toBe('b');
  });
});
