/**
 * Nav component tests — console/src/components/Nav.tsx
 * Tests navigation links, WS connection indicator, alert display,
 * unread badge, version display, and update button.
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createElement, type ReactNode } from 'react';

let wsConnected = false;
const onUpdateClick = vi.fn();

vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: wsConnected }),
}));

// Import Nav after mocks
import Nav from '../../console/src/components/Nav';

function renderNav(props: Record<string, unknown> = {}) {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(Nav, { onUpdateClick, ...props } as Record<string, unknown>),
    ),
  );
}

beforeEach(() => {
  wsConnected = false;
  onUpdateClick.mockClear();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Navigation links
// ---------------------------------------------------------------------------

describe('Nav — navigation links', () => {
  it('renders Fleet, Inbox, and Ops links', () => {
    renderNav();
    expect(screen.getByText('Fleet')).toBeDefined();
    expect(screen.getByText('Inbox')).toBeDefined();
    expect(screen.getByText('Operator')).toBeDefined();
  });

  it('renders nav element with correct aria label', () => {
    renderNav();
    const nav = screen.getByRole('navigation');
    expect(nav.getAttribute('aria-label')).toBe('Main navigation');
  });

  it('renders the SOUP nameplate', () => {
    renderNav();
    // SOUP nameplate lockup (brand.md §1): wordmark text + an aria-label on the lockup.
    expect(screen.getByText('SOUP')).toBeDefined();
    expect(screen.getByLabelText('SOUP')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// WebSocket connection indicator
// ---------------------------------------------------------------------------

describe('Nav — WS connection indicator', () => {
  it('shows "Polling" when WS is disconnected', () => {
    wsConnected = false;
    renderNav();
    expect(screen.getByText('Polling')).toBeDefined();
    expect(screen.queryByText('Live')).toBeNull();
  });

  it('shows "Live" when WS is connected', () => {
    wsConnected = true;
    renderNav();
    expect(screen.getByText('Live')).toBeDefined();
    expect(screen.queryByText('Polling')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Alert status
// ---------------------------------------------------------------------------

describe('Nav — alert display', () => {
  it('shows "All systems operational" when alertCount is 0', () => {
    renderNav({ alertCount: 0 });
    expect(screen.getByText('All systems operational')).toBeDefined();
  });

  it('shows alert count with singular "alert" for 1', () => {
    renderNav({ alertCount: 1 });
    expect(screen.getByText('1 alert')).toBeDefined();
  });

  it('shows alert count with plural "alerts" for > 1', () => {
    renderNav({ alertCount: 3 });
    expect(screen.getByText('3 alerts')).toBeDefined();
  });

  it('shows operational state by default (no props)', () => {
    renderNav();
    expect(screen.getByText('All systems operational')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Unread badge
// ---------------------------------------------------------------------------

describe('Nav — unread badge', () => {
  it('does not show badge when unreadCount is 0', () => {
    renderNav({ unreadCount: 0 });
    expect(screen.queryByText('0')).toBeNull();
  });

  it('shows unread count when > 0', () => {
    renderNav({ unreadCount: 5 });
    expect(screen.getByText('5')).toBeDefined();
  });

  it('caps display at 99+', () => {
    renderNav({ unreadCount: 150 });
    expect(screen.getByText('99+')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Version display
// ---------------------------------------------------------------------------

describe('Nav — version display', () => {
  it('shows version when provided', () => {
    renderNav({ version: 'abc1234' });
    expect(screen.getByText('vabc1234')).toBeDefined();
  });

  it('does not show version when set to "unknown"', () => {
    renderNav({ version: 'unknown' });
    expect(screen.queryByText(/vunknown/)).toBeNull();
  });

  it('does not show version when not provided', () => {
    renderNav();
    // No version element — just ensure no crash
    expect(screen.getByText('All systems operational')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Update button
// ---------------------------------------------------------------------------

describe('Nav — update button', () => {
  it('shows update button when updateAvailable and remoteSha are set', () => {
    renderNav({ version: 'abc1234', updateAvailable: true, remoteSha: 'def5678' });
    // C1: Nav now includes a theme toggle button; use the update button's aria-label for specificity
    const btn = screen.getByRole('button', { name: /Update available: abc1234 to def5678/ });
    expect(btn).toBeDefined();
    expect(btn.textContent).toContain('abc1234');
    expect(btn.textContent).toContain('def5678');
  });

  it('calls onUpdateClick when update button is clicked', () => {
    renderNav({ version: 'abc1234', updateAvailable: true, remoteSha: 'def5678' });
    // C1: Nav now includes a theme toggle button; click the update button specifically
    fireEvent.click(screen.getByRole('button', { name: /Update available/ }));
    expect(onUpdateClick).toHaveBeenCalledTimes(1);
  });

  it('shows plain version when no update available', () => {
    renderNav({ version: 'abc1234', updateAvailable: false });
    expect(screen.getByText('vabc1234')).toBeDefined();
    // C1: Nav includes a theme toggle button; assert no UPDATE button (not zero buttons)
    expect(screen.queryByRole('button', { name: /Update available/ })).toBeNull();
  });
});
