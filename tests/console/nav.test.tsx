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

function activeUnderline(link: HTMLElement) {
  const underline = link.querySelector('span.absolute.h-\\[var\\(--bw-accent\\)\\]');
  expect(underline).not.toBeNull();
  return underline as HTMLElement;
}

beforeEach(() => {
  wsConnected = false;
});

afterEach(() => {
  cleanup();
});

describe('Nav routing targets', () => {
  it('links to the console top-level routes', () => {
    renderNav();

    expect(navLink('Soup Kitchen').getAttribute('href')).toBe('/');
    expect(navLink('Inbox').getAttribute('href')).toBe('/inbox');
    expect(navLink('Ops').getAttribute('href')).toBe('/ops');
  });
});

describe('Nav route state', () => {
  it('marks Soup Kitchen current at the fleet root', () => {
    renderNav({}, '/');

    expectCurrentLink('Soup Kitchen');
  });

  it('marks Soup Kitchen current for line detail routes', () => {
    renderNav({}, '/lines/abc123');

    expectCurrentLink('Soup Kitchen');
  });

  it('marks Inbox current only on the inbox route', () => {
    renderNav({}, '/inbox');

    expectCurrentLink('Inbox');
    expect(navLink('Soup Kitchen').getAttribute('aria-current')).toBeNull();
    expect(navLink('Ops').getAttribute('aria-current')).toBeNull();
  });

  it('marks Ops current only on the ops route', () => {
    renderNav({}, '/ops');

    expectCurrentLink('Ops');
    expect(navLink('Soup Kitchen').getAttribute('aria-current')).toBeNull();
    expect(navLink('Inbox').getAttribute('aria-current')).toBeNull();
  });

  it('uses the action accent, not status green, for active-route underlines', () => {
    renderNav({}, '/inbox');

    const underline = activeUnderline(navLink('Inbox'));
    expect(underline.className).toContain('bg-[var(--accent)]');
    expect(underline.className).not.toContain('bg-s-ok');
  });
});

describe('Nav unread badge placement', () => {
  it('renders the unread badge inside the Inbox link only', () => {
    renderNav({ unreadCount: 7 });

    expect(within(navLink(/Inbox/)).getByText('7')).toBeDefined();
    expect(within(navLink('Soup Kitchen')).queryByText('7')).toBeNull();
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
