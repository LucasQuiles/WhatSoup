/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createElement, type ComponentProps } from 'react';

let wsConnected = false;

vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: wsConnected }),
}));

import Nav from '../../console/src/components/Nav';

function renderNav(
  props: Partial<ComponentProps<typeof Nav>> = {},
  initialPath = '/',
) {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      createElement(Nav, { onUpdateClick: vi.fn(), ...props }),
    ),
  );
}

function navLink(name: string | RegExp) {
  return screen.getByRole('link', { name });
}

function expectCurrentLink(name: string | RegExp) {
  const currentLinks = screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page');

  expect(currentLinks).toHaveLength(1);
  expect(currentLinks[0]).toBe(navLink(name));
}

// The active-item indicator is now a FULL accent fill on the row itself
// (showcase-accurate): the active link carries bg-[var(--accent)] +
// text-[var(--accent-fg)], replacing the prior left-edge accent bar / underline.

beforeEach(() => {
  wsConnected = false;
});

afterEach(() => {
  cleanup();
});

describe('Nav routing targets', () => {
  it('links to the console top-level routes', () => {
    renderNav();

    expect(navLink('Fleet').getAttribute('href')).toBe('/');
    expect(navLink('Inbox').getAttribute('href')).toBe('/inbox');
    expect(navLink('Metrics').getAttribute('href')).toBe('/metrics');
    expect(navLink('Ops').getAttribute('href')).toBe('/ops');
  });
});

describe('Nav route state', () => {
  it('marks Fleet current at the fleet root', () => {
    renderNav({}, '/');

    expectCurrentLink('Fleet');
  });

  it('marks Fleet current for line detail routes', () => {
    renderNav({}, '/lines/abc123');

    expectCurrentLink('Fleet');
  });

  it('marks Inbox current only on the inbox route', () => {
    renderNav({}, '/inbox');

    expectCurrentLink('Inbox');
    expect(navLink('Fleet').getAttribute('aria-current')).toBeNull();
    expect(navLink('Metrics').getAttribute('aria-current')).toBeNull();
    expect(navLink('Ops').getAttribute('aria-current')).toBeNull();
  });

  it('marks Metrics current only on the metrics route', () => {
    renderNav({}, '/metrics');

    expectCurrentLink('Metrics');
    expect(navLink('Fleet').getAttribute('aria-current')).toBeNull();
    expect(navLink('Inbox').getAttribute('aria-current')).toBeNull();
    expect(navLink('Ops').getAttribute('aria-current')).toBeNull();
  });

  it('marks Ops current only on the ops route', () => {
    renderNav({}, '/ops');

    expectCurrentLink('Ops');
    expect(navLink('Fleet').getAttribute('aria-current')).toBeNull();
    expect(navLink('Inbox').getAttribute('aria-current')).toBeNull();
    expect(navLink('Metrics').getAttribute('aria-current')).toBeNull();
  });

  it('uses the action accent, not status green, for the active-route full fill', () => {
    renderNav({}, '/inbox');

    const active = navLink('Inbox');
    expect(active.className).toContain('bg-[var(--accent)]');
    expect(active.className).toContain('text-[var(--accent-fg)]');
    expect(active.className).not.toContain('bg-s-ok');
  });

  it('marks the active item with a full accent fill (not a bar or bottom underline)', () => {
    renderNav({}, '/ops');

    const active = navLink('Ops');
    // Full-row accent fill with dark accent-fg text/icon — showcase-accurate.
    expect(active.className).toContain('bg-[var(--accent)]');
    expect(active.className).toContain('text-[var(--accent-fg)]');
    // No legacy left-edge bar anywhere in the rail.
    expect(active.querySelector('span.soup-rail__bar')).toBeNull();
    // Inactive items carry neither the fill nor a bar.
    expect(navLink('Fleet').className).not.toContain('bg-[var(--accent)]');
    expect(navLink('Fleet').querySelector('span.soup-rail__bar')).toBeNull();
    expect(navLink('Inbox').className).not.toContain('bg-[var(--accent)]');
    expect(navLink('Inbox').querySelector('span.soup-rail__bar')).toBeNull();
  });
});

describe('Nav rail structure', () => {
  it('renders the navigation as a vertical rail landmark with the nameplate at the top', () => {
    const { container } = renderNav();

    const nav = screen.getByRole('navigation');
    expect(nav.getAttribute('aria-label')).toBe('Main navigation');
    // The nav is the rail container.
    expect(nav.className).toContain('soup-rail');
    // Nameplate docks at the top of the rail.
    const head = container.querySelector('.soup-rail__head');
    expect(head).not.toBeNull();
    expect(within(head as HTMLElement).getByLabelText('SOUP')).toBeDefined();
  });

  it('stacks the four primary destinations as rail items inside the nav', () => {
    const { container } = renderNav();

    const items = container.querySelectorAll('.soup-rail__nav .soup-rail__item');
    expect(items).toHaveLength(4);
    expect(navLink('Fleet').className).toContain('soup-rail__item');
    expect(navLink('Inbox').className).toContain('soup-rail__item');
    expect(navLink('Metrics').className).toContain('soup-rail__item');
    expect(navLink('Ops').className).toContain('soup-rail__item');
  });

  it('docks the secondary controls (theme toggle + status) at the bottom of the rail', () => {
    const { container } = renderNav();

    const dock = container.querySelector('.soup-rail__dock');
    expect(dock).not.toBeNull();
    // Theme toggle lives in the bottom dock.
    expect(within(dock as HTMLElement).getByRole('button', { name: /Switch to (light|dark) theme/ })).toBeDefined();
    // A flex spacer separates the nav list from the dock.
    expect(container.querySelector('.soup-rail__spacer')).not.toBeNull();
  });

  it('renders the logout control in the bottom dock when onLogout is provided', () => {
    const { container } = renderNav({ onLogout: vi.fn() });

    const dock = container.querySelector('.soup-rail__dock') as HTMLElement;
    expect(within(dock).getByRole('button', { name: 'Lock console' })).toBeDefined();
  });
});

describe('Nav unread badge placement', () => {
  it('renders the unread badge inside the Inbox link only', () => {
    renderNav({ unreadCount: 7 });

    expect(within(navLink(/Inbox/)).getByText('7')).toBeDefined();
    expect(within(navLink('Fleet')).queryByText('7')).toBeNull();
    expect(within(navLink('Metrics')).queryByText('7')).toBeNull();
    expect(within(navLink('Ops')).queryByText('7')).toBeNull();
  });

  it('uses the action accent, not warning status color, for unread count badges', () => {
    renderNav({ unreadCount: 7 });

    const badge = within(navLink(/Inbox/)).getByText('7');
    expect(badge.className).toContain('bg-[var(--accent)]');
    expect(badge.className).toContain('text-[var(--accent-fg)]');
    expect(badge.className).not.toContain('color-s-warn');
  });
});

describe('Nav update button attributes', () => {
  it('describes the version transition on the update button', () => {
    renderNav({ version: 'abc1234', updateAvailable: true, remoteSha: 'def5678' });

    const button = screen.getByRole('button', {
      name: /Update available: abc1234 to def5678/,
    });

    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('title')).toContain('abc1234');
    expect(button.getAttribute('title')).toContain('def5678');
  });
});
