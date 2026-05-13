/**
 * @vitest-environment jsdom
 *
 * Behavioral contract-lock for ModeBadge + StatusDot.
 *
 * These tests render the real components and assert user-visible DOM output
 * plus the design-token classes/styles the console UI depends on.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ModeBadge from '../../console/src/components/ModeBadge.tsx';
import StatusDot from '../../console/src/components/StatusDot.tsx';

afterEach(() => {
  cleanup();
});

function expectClassTokens(element: Element, tokens: string[]): void {
  for (const token of tokens) {
    expect(element.classList.contains(token)).toBe(true);
  }
}

function expectInlineStyleToken(element: HTMLElement, token: string): void {
  expect(element.getAttribute('style') ?? '').toContain(token);
}

describe('ModeBadge', () => {
  const modeTokenCases: Array<[
    'passive' | 'chat' | 'agent',
    { textToken: string; dotToken: string; washToken: string },
  ]> = [
    ['passive', { textToken: 'text-m-pas', dotToken: 'bg-m-pas', washToken: 'var(--m-pas-soft)' }],
    ['chat', { textToken: 'text-m-cht', dotToken: 'bg-m-cht', washToken: 'var(--m-cht-soft)' }],
    ['agent', { textToken: 'text-m-agt', dotToken: 'bg-m-agt', washToken: 'var(--m-agt-soft)' }],
  ];

  for (const [mode, { textToken, dotToken, washToken }] of modeTokenCases) {
    it(`renders the visible "${mode}" badge with mode design tokens`, () => {
      render(<ModeBadge mode={mode} />);

      const badge = screen.getByText(mode);
      expect(badge).toBeInstanceOf(HTMLSpanElement);
      expect(badge.textContent).toBe(mode);
      expectClassTokens(badge, ['text-label', textToken]);
      expectInlineStyleToken(badge, washToken);

      const dot = badge.querySelector(`.${dotToken}`);
      expect(dot).toBeInstanceOf(HTMLSpanElement);
      expectClassTokens(dot!, ['inline-block', 'rounded-full', dotToken]);
    });
  }
});

describe('StatusDot', () => {
  it('defaults size="md" to an 8px accessible status marker', () => {
    render(<StatusDot status="online" />);

    const marker = screen.getByLabelText('online');
    expect(marker).toBeInstanceOf(HTMLSpanElement);
    expectInlineStyleToken(marker, 'width: 8px');
    expectInlineStyleToken(marker, 'height: 8px');
  });

  it('respects size="sm" with a 6px accessible status marker', () => {
    render(<StatusDot status="online" size="sm" />);

    const marker = screen.getByLabelText('online');
    expect(marker).toBeInstanceOf(HTMLSpanElement);
    expectInlineStyleToken(marker, 'width: 6px');
    expectInlineStyleToken(marker, 'height: 6px');
  });

  it('exposes status values through aria-labels', () => {
    for (const status of ['online', 'degraded', 'unreachable'] as const) {
      cleanup();
      render(<StatusDot status={status} />);

      expect(screen.getByLabelText(status)).toBeDefined();
    }
  });

  const statusTokenCases: Array<['online' | 'degraded' | 'unreachable', string]> = [
    ['online', 'bg-s-ok'],
    ['degraded', 'bg-s-warn'],
    ['unreachable', 'bg-s-crit'],
  ];

  for (const [status, colorToken] of statusTokenCases) {
    it(`renders the "${status}" dot with ${colorToken}`, () => {
      render(<StatusDot status={status} />);

      const marker = screen.getByLabelText(status);
      const dot = marker.querySelector(`.${colorToken}`);
      expect(dot).toBeInstanceOf(HTMLSpanElement);
      expectClassTokens(dot!, ['absolute', 'inset-0', 'rounded-full', colorToken]);
    });
  }

  it('renders the animated online ring only for online status', () => {
    render(<StatusDot status="online" />);
    expect(screen.getByLabelText('online').querySelector('.animate-breathe-ring')).toBeInstanceOf(HTMLSpanElement);

    cleanup();
    render(<StatusDot status="degraded" />);
    expect(screen.getByLabelText('degraded').querySelector('.animate-breathe-ring')).toBeNull();

    cleanup();
    render(<StatusDot status="unreachable" />);
    expect(screen.getByLabelText('unreachable').querySelector('.animate-breathe-ring')).toBeNull();
  });
});
