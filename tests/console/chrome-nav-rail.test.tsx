/**
 * NavRail — v3.5 chrome rail tests (T5 b-02).
 * Pins: section IA (Operate/Create/System), all eight route links, the
 * spec-locked SOUP nameplate + page-context caps, aria-current active state
 * (incl. /lines/* → Fleet and the Ops consolidation), the Inbox attention
 * dot, Hosts block, and the utility dock (realtime, version/update, lock).
 * DD-8: the "Polling" degraded-transport row keeps AA text-2 ink.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createElement } from 'react';

let wsConnected = false;
const onUpdateClick = vi.fn();

vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: wsConnected }),
}));

import NavRail from '../../console/src/components/chrome/NavRail';

function renderRail(props: Record<string, unknown> = {}, initialPath = '/') {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      createElement(NavRail, { onUpdateClick, ...props } as Record<string, unknown>),
    ),
  );
}

function navLink(name: string | RegExp) {
  return screen.getByRole('link', { name });
}

function currentLinks() {
  return screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page');
}

beforeEach(() => {
  wsConnected = false;
  onUpdateClick.mockClear();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Structure — sections, links, nameplate
// ---------------------------------------------------------------------------

describe('NavRail — structure', () => {
  it('renders the nav landmark with the main-navigation label', () => {
    renderRail();
    const nav = screen.getByRole('navigation');
    expect(nav.getAttribute('aria-label')).toBe('Main navigation');
  });

  it('renders all eight v3.5 surface links with their route hrefs', () => {
    renderRail();
    expect(navLink('Fleet').getAttribute('href')).toBe('/');
    expect(navLink('Agents').getAttribute('href')).toBe('/agents');
    expect(navLink('Inbox').getAttribute('href')).toBe('/inbox');
    expect(navLink('Ops').getAttribute('href')).toBe('/ops');
    expect(navLink('Skills').getAttribute('href')).toBe('/skills');
    expect(navLink('Dream Lab').getAttribute('href')).toBe('/dream-lab');
    expect(navLink('Deployments').getAttribute('href')).toBe('/deployments');
    expect(navLink('Settings').getAttribute('href')).toBe('/settings');
  });

  it('renders the Operate / Create / System section labels', () => {
    renderRail();
    expect(screen.getByText('Operate')).toBeDefined();
    expect(screen.getByText('Create')).toBeDefined();
    expect(screen.getByText('System')).toBeDefined();
  });

  it('renders the SOUP wordmark with the accent U (brand.md §1)', () => {
    renderRail();
    const lockup = screen.getByLabelText('SOUP');
    expect(lockup.textContent?.replace(/\s+/g, '')).toBe('SOUP');
    expect(lockup.querySelector('.soup-nameplate__accent')?.textContent).toBe('U');
  });

  it('shows the page-context caps in the nameplate', () => {
    renderRail({}, '/inbox');
    expect(screen.getByText('INBOX')).toBeDefined();
  });

  it('renders the Hosts block with the local chip', () => {
    renderRail();
    expect(screen.getByText('Hosts')).toBeDefined();
    expect(screen.getByText('local · this host')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Active state — exactly one aria-current="page" per route
// ---------------------------------------------------------------------------

describe('NavRail — active state (aria-current)', () => {
  it('marks Fleet current at /', () => {
    renderRail({}, '/');
    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]).toBe(navLink('Fleet'));
  });

  it('keeps Fleet current on the line-detail route', () => {
    renderRail({}, '/lines/primary-line');
    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]).toBe(navLink('Fleet'));
  });

  it('marks Inbox current at /inbox', () => {
    renderRail({}, '/inbox');
    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]).toBe(navLink('Inbox'));
  });

  it('marks Ops current at /ops and on the legacy /operator + /metrics paths', () => {
    for (const path of ['/ops', '/operator', '/metrics']) {
      cleanup();
      renderRail({}, path);
      expect(currentLinks()).toHaveLength(1);
      expect(currentLinks()[0]).toBe(navLink('Ops'));
    }
  });

  it('marks the stub surfaces current on their routes', () => {
    const cases: Array<[string, string]> = [
      ['/agents', 'Agents'],
      ['/skills', 'Skills'],
      ['/dream-lab', 'Dream Lab'],
      ['/deployments', 'Deployments'],
      ['/settings', 'Settings'],
    ];
    for (const [path, name] of cases) {
      cleanup();
      renderRail({}, path);
      expect(currentLinks()).toHaveLength(1);
      expect(currentLinks()[0]).toBe(navLink(name));
    }
  });
});

// ---------------------------------------------------------------------------
// Inbox attention dot
// ---------------------------------------------------------------------------

describe('NavRail — inbox attention dot', () => {
  it('renders the dot + sr-only count when unreadCount > 0', () => {
    renderRail({ unreadCount: 5 });
    const inbox = navLink(/Inbox/);
    expect(inbox.querySelector('.chrome-attn-dot')).not.toBeNull();
    expect(screen.getByText('5 unread')).toBeDefined();
  });

  it('renders no dot when unreadCount is 0', () => {
    renderRail({ unreadCount: 0 });
    expect(navLink('Inbox').querySelector('.chrome-attn-dot')).toBeNull();
    expect(screen.queryByText(/unread/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Utility dock — realtime, version/update, lock
// ---------------------------------------------------------------------------

describe('NavRail — realtime status', () => {
  it('shows "Polling" when WS is disconnected', () => {
    wsConnected = false;
    renderRail();
    expect(screen.getByText('Polling')).toBeDefined();
    expect(screen.queryByText('Live')).toBeNull();
  });

  it('shows "Live" when WS is connected', () => {
    wsConnected = true;
    renderRail();
    expect(screen.getByText('Live')).toBeDefined();
    expect(screen.queryByText('Polling')).toBeNull();
  });

  it('DD-8: the Polling row keeps AA text-2 ink (--dim), never ghost (--recessed)', () => {
    wsConnected = false;
    renderRail();
    const row = screen.getByText('Polling').closest('.chrome-utility-row');
    expect(row).not.toBeNull();
    expect(row!.className).toContain('chrome-utility-row--dim');
    // Positive control: paired absence so a broken selector cannot vacuous-pass.
    expect(row!.className).not.toContain('chrome-utility-row--recessed');
  });
});

describe('NavRail — version + update', () => {
  it('shows the version when provided', () => {
    renderRail({ version: 'abc1234' });
    expect(screen.getByText('vabc1234')).toBeDefined();
  });

  it('hides the version when "unknown" or absent', () => {
    renderRail({ version: 'unknown' });
    expect(screen.queryByText(/vunknown/)).toBeNull();
  });

  it('shows the update button when an update is available', () => {
    renderRail({ version: 'abc1234', updateAvailable: true, remoteSha: 'def5678' });
    const btn = screen.getByRole('button', { name: /Update available: abc1234 to def5678/ });
    expect(btn.textContent).toContain('abc1234');
    expect(btn.textContent).toContain('def5678');
  });

  it('calls onUpdateClick when the update button is clicked', () => {
    renderRail({ version: 'abc1234', updateAvailable: true, remoteSha: 'def5678' });
    fireEvent.click(screen.getByRole('button', { name: /Update available/ }));
    expect(onUpdateClick).toHaveBeenCalledTimes(1);
  });

  it('shows the plain version (no update button) when no update is available', () => {
    renderRail({ version: 'abc1234', updateAvailable: false });
    expect(screen.getByText('vabc1234')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Update available/ })).toBeNull();
  });
});

describe('NavRail — lock control', () => {
  it('renders the lock button only when onLogout is provided', () => {
    renderRail();
    expect(screen.queryByRole('button', { name: 'Lock console' })).toBeNull();
    cleanup();
    const onLogout = vi.fn();
    renderRail({ onLogout });
    fireEvent.click(screen.getByRole('button', { name: 'Lock console' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
