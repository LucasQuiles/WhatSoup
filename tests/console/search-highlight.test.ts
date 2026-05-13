/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { splitSearchHighlights } from '../../console/src/lib/search-highlight.ts';
import MessageContent from '../../console/src/components/MessageContent.tsx';
import type { Message } from '../../console/src/types.ts';

afterEach(() => cleanup());

function message(content: string): Message {
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
  it('highlights matches inside formatted spans', () => {
    const { container } = render(
      createElement(MessageContent, {
        msg: message('hello *beta* world'),
        highlightQuery: 'beta',
      }),
    );

    const strong = screen.getByText('beta').closest('strong');
    expect(strong).toBeDefined();
    expect(strong?.querySelector('mark')?.textContent).toBe('beta');
    expect(container.textContent).toBe('hello beta world');
  });
});
