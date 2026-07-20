/**
 * @vitest-environment jsdom
 *
 * Rendered coverage for WhatsApp-style message formatting.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import MessageContent from '../../console/src/components/MessageContent';
import { formatWhatsAppText } from '../../console/src/lib/format-message-text';
import type { Message } from '../../console/src/types';

afterEach(() => cleanup());

function message(content: string | null): Message {
  return {
    pk: 42,
    conversationKey: 'chat-1',
    senderName: 'Alice',
    senderJid: 'sender-fixture-jid',
    content,
    timestamp: '2026-04-05T19:30:45.000Z',
    fromMe: false,
    type: 'text',
  };
}

function renderMessage(content: string | null) {
  return render(createElement(MessageContent, { msg: message(content) }));
}

function renderFormatted(content: string | null | undefined) {
  return render(createElement('div', null, formatWhatsAppText(content)));
}

describe('MessageContent WhatsApp formatting', () => {
  it('renders bold, italic, strike, and inline code as DOM elements', () => {
    const { container } = renderMessage('a *bold* _italic_ ~strike~ `code`');

    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('strike').tagName).toBe('S');

    const code = screen.getByText('code');
    expect(code.tagName).toBe('CODE');
    expect(code.className).not.toContain('block');
    expect(container.textContent).toBe('a bold italic strike code');
  });

  it('renders double-asterisk bold as a strong element', () => {
    renderMessage('**bold**');

    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  it('renders a single-line triple-backtick block as block code', () => {
    const { container } = renderMessage('```code-block```');

    const code = container.querySelector('code');
    expect(code?.textContent).toBe('code-block');
    expect(code?.className).toContain('block');
  });

  it('renders multiline triple-backtick text as one block code element', () => {
    const { container } = renderMessage('before\n```line one\nline two```\nafter');

    const code = container.querySelector('code');
    expect(code?.textContent).toBe('line one\nline two');
    expect(code?.className).toContain('block');
    expect(container.querySelectorAll('code')).toHaveLength(1);
    expect(container.textContent).toBe('beforeline one\nline twoafter');
  });

  it('keeps line breaks outside code blocks as br elements', () => {
    const { container } = renderMessage('one\ntwo\nthree');

    expect(container.querySelectorAll('br')).toHaveLength(2);
    expect(container.textContent).toBe('onetwothree');
  });

  it('renders URLs as external links with the full href', () => {
    renderMessage('go to https://example.com now');

    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('truncates long URL display text and keeps the full href', () => {
    const longUrl = 'https://example.com/very/long/path/' + 'x'.repeat(40);
    const displayText = `${longUrl.slice(0, 47)}...`;

    renderMessage(longUrl);

    const link = screen.getByRole('link', { name: displayText });
    expect(displayText).toHaveLength(50);
    expect(link.getAttribute('href')).toBe(longUrl);
    expect(link.textContent).toBe(displayText);
  });

  it('renders http URLs as links', () => {
    renderMessage('http://x.test/y');

    expect(screen.getByRole('link', { name: 'http://x.test/y' }).getAttribute('href')).toBe('http://x.test/y');
  });

  it('renders an empty-state marker for nullish or blank text', () => {
    renderFormatted(null);
    expect(screen.getByText('\u2014')).toBeDefined();
  });
});
