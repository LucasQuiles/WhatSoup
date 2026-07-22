/**
 * ChromeHeader — v3.5 chrome header tests (T5 b-02).
 * Pins: the chrome title is always a styled span — never an h1 (every page
 * surface owns its own h1; D1.3 landmark contract), the attention pill
 * (copy grammar + link target), and the rightmost theme toggle (sun + mono
 * label, aria-label, toggle behavior).
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
  it('renders the route title as a styled span, never an h1 (the surface owns the h1)', () => {
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
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
      const titleEl = document.querySelector('.chrome-title');
      expect(titleEl?.tagName).toBe('SPAN');
      expect(titleEl?.textContent).toBe(title);
    }
  });

  it('shows the line name as the span title on line-detail (the page owns its h1)', () => {
    renderHeader({}, '/lines/primary-line', '/lines/:name');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    const title = document.querySelector('.chrome-title');
    expect(title?.tagName).toBe('SPAN');
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
