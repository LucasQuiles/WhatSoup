/**
 * ChromeHeader — v3.5 chrome header tests (T5 b-02).
 * Pins: per-route h1 (demoted to a span on line-detail, which owns its own
 * h1), the attention pill (copy grammar + link target), and the rightmost
 * theme toggle (sun + mono label, aria-label, toggle behavior).
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createElement } from 'react';

import ChromeHeader from '../../console/src/components/chrome/ChromeHeader';

function renderHeader(
  props: Record<string, unknown> = {},
  initialPath = '/',
  routePattern?: string,
) {
  const header = createElement(ChromeHeader, props as Record<string, unknown>);
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      routePattern
        ? createElement(Routes, null, createElement(Route, { path: routePattern, element: header }))
        : header,
    ),
  );
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

describe('ChromeHeader — title', () => {
  it('renders the page h1 per route', () => {
    const cases: Array<[string, string]> = [
      ['/', 'Fleet'],
      ['/inbox', 'Inbox'],
      ['/ops', 'Ops'],
      ['/agents', 'Agents'],
      ['/skills', 'Skills'],
      ['/dream-lab', 'Dream Lab'],
      ['/deployments', 'Deployments'],
      ['/settings', 'Settings'],
    ];
    for (const [path, title] of cases) {
      cleanup();
      renderHeader({}, path);
      const h1 = screen.getByRole('heading', { level: 1 });
      expect(h1.textContent).toBe(title);
    }
  });

  it('demotes the chrome title to a span on line-detail (the page owns its h1)', () => {
    renderHeader({}, '/lines/primary-line', '/lines/:name');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    const title = document.querySelector('.chrome-title');
    expect(title?.textContent).toBe('primary-line');
  });
});

// ---------------------------------------------------------------------------
// Attention pill
// ---------------------------------------------------------------------------

describe('ChromeHeader — attention pill', () => {
  it('renders no pill when alertCount is 0', () => {
    renderHeader({ alertCount: 0 });
    expect(screen.queryByText(/need.*attention/)).toBeNull();
  });

  it('singular grammar for 1 line', () => {
    renderHeader({ alertCount: 1 });
    expect(screen.getByText('1 line needs attention')).toBeDefined();
  });

  it('plural grammar for > 1 lines, linking to the fleet surface', () => {
    renderHeader({ alertCount: 3 });
    const pill = screen.getByRole('link', { name: /3 lines need attention/ });
    expect(pill.getAttribute('href')).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

describe('ChromeHeader — theme toggle', () => {
  it('renders the rightmost sun + "theme" toggle with an actionable aria-label', () => {
    renderHeader();
    const btn = screen.getByRole('button', { name: /Switch to (light|dark) theme/ });
    expect(btn.textContent).toContain('theme');
    expect(btn.querySelector('svg')).not.toBeNull();
  });

  it('flips the offered direction on click', () => {
    renderHeader();
    const before = screen.getByRole('button', { name: /Switch to/ }).getAttribute('aria-label');
    fireEvent.click(screen.getByRole('button', { name: /Switch to/ }));
    const after = screen.getByRole('button', { name: /Switch to/ }).getAttribute('aria-label');
    expect(after).not.toBe(before);
  });
});
