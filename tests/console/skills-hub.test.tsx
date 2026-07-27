/**
 * Skills Hub surface (T5 b-05) — jsdom contracts against the mockup
 * skills-hub.html anatomy: filters rail (type/source sections with REAL
 * catalog counts, legend), toolbar (search + sort), result cards (icon,
 * name, description, source badge, manage action, compat strip), the
 * third-party warn-note, and the modebar/upload honesty states.
 *
 * Honesty law pins: catalog entries come from the real plugin-catalog SSOT
 * (shared with the hatch wizard); compat cells always render n/a until an
 * assessment API exists; zero-count entry types are honest; org hub and
 * Upload are disabled with explanatory titles, never dead affordances.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

import SkillsHub from '../../console/src/pages/SkillsHub';
import { PLUGIN_CATALOG, sourceOf, CATEGORY_LABELS } from '../../console/src/lib/plugin-catalog';

afterEach(() => cleanup());

function LocationProbe(): ReactElement | null {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/skills']}>
      <Routes>
        <Route path="/skills" element={<SkillsHub />} />
        <Route path="/agents" element={<div data-testid="agents-surface" />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Catalog SSOT
// ---------------------------------------------------------------------------

describe('plugin catalog (shared SSOT)', () => {
  it('carries the real installable entries with parsed source classes', () => {
    expect(PLUGIN_CATALOG.length).toBeGreaterThan(0);
    for (const e of PLUGIN_CATALOG) {
      expect(e.key).toContain('@');
      expect(['official', 'community', 'local', 'thirdparty']).toContain(e.source);
      expect(CATEGORY_LABELS[e.category]).toBeTruthy();
    }
  });

  it('source parses from the namespace — official/community/local/thirdparty', () => {
    expect(sourceOf('x@claude-plugins-official')).toBe('official');
    expect(sourceOf('x@superpowers-marketplace')).toBe('community');
    expect(sourceOf('x@tmup-dev')).toBe('local');
    expect(sourceOf('x@unverified-random')).toBe('thirdparty');
  });

  it('no third-party entries ship in the catalog today (warn-note stays unused)', () => {
    expect(PLUGIN_CATALOG.filter((e) => e.source === 'thirdparty').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Page row
// ---------------------------------------------------------------------------

describe('page row (single-h1 law + modebar + upload)', () => {
  it('the surface owns exactly one h1', () => {
    renderPage();
    const h1s = document.querySelectorAll('h1');
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe('Skills Hub');
  });

  it('personal hub is active; org hub is disabled with the honest note', () => {
    renderPage();
    const personal = screen.getByRole('button', { name: /personal hub/i }) as HTMLButtonElement;
    expect(personal.getAttribute('aria-pressed')).toBe('true');
    const org = screen.getByRole('button', { name: /org hub/i }) as HTMLButtonElement;
    expect(org.disabled).toBe(true);
    expect(org.title).toContain('hub API');
  });

  it('Upload is disabled with the honest no-endpoint note', () => {
    renderPage();
    const up = screen.getByRole('button', { name: 'Upload' }) as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(up.title).toContain('hub API');
  });
});

// ---------------------------------------------------------------------------
// Filters rail
// ---------------------------------------------------------------------------

describe('filters rail (mockup .filters)', () => {
  it('type section shows REAL catalog counts; zero-count types are honest', () => {
    renderPage();
    const rail = document.querySelector('.skills-filters') as HTMLElement;
    expect(within(rail).getByText('Plugins').parentElement?.textContent).toContain(String(PLUGIN_CATALOG.length));
    expect(within(rail).getByText('Skills').parentElement?.textContent).toContain('0');
    expect(within(rail).getByText('MCP servers').parentElement?.textContent).toContain('0');
    expect(within(rail).getByText('Tools').parentElement?.textContent).toContain('0');
  });

  it('source section counts derive from the catalog, never hardcoded', () => {
    renderPage();
    const official = PLUGIN_CATALOG.filter((e) => e.source === 'official').length;
    const rail = document.querySelector('.skills-filters') as HTMLElement;
    expect(within(rail).getByText('Official').parentElement?.textContent).toContain(String(official));
  });

  it('zero-count type filters render the honest empty note', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^Skills 0$/i }));
    expect(screen.getByTestId('skills-empty').textContent).toContain('land with the hub API');
    expect(document.querySelectorAll('.skills-scard').length).toBe(0);
  });

  it('source filter narrows the results and toggles off on re-click', () => {
    renderPage();
    const officialCount = PLUGIN_CATALOG.filter((e) => e.source === 'official').length;
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Official ${officialCount}$`, 'i') }));
    expect(document.querySelectorAll('.skills-scard').length).toBe(officialCount);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Official ${officialCount}$`, 'i') }));
    expect(document.querySelectorAll('.skills-scard').length).toBe(PLUGIN_CATALOG.length);
  });

  it('the legend renders the compat vocabulary', () => {
    renderPage();
    const rail = document.querySelector('.skills-filters') as HTMLElement;
    expect(rail.textContent).toContain('claude-cli');
    expect(rail.textContent).toContain('outline n/a');
  });
});

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

describe('toolbar (search + sort)', () => {
  it('search narrows by label, key, and description', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/search skills/i), { target: { value: 'playwright' } });
    const cards = document.querySelectorAll('.skills-scard');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('Playwright');
  });

  it('a fruitless search renders the honest no-match note', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/search skills/i), { target: { value: 'zzz-no-such-entry' } });
    expect(screen.getByTestId('skills-empty').textContent).toContain('No catalog entries match');
  });

  it('sort toggles between ascending and descending by label', () => {
    renderPage();
    const firstBefore = document.querySelector('.skills-scard__nm')!.textContent;
    fireEvent.click(screen.getByRole('button', { name: /sort: name/i }));
    const firstAfter = document.querySelector('.skills-scard__nm')!.textContent;
    expect(firstBefore).not.toBe(firstAfter);
    const labels = Array.from(document.querySelectorAll('.skills-scard__nm')).map((n) => n.textContent!);
    const sorted = labels.slice().sort((a, b) => b.localeCompare(a));
    expect(labels).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// Result cards
// ---------------------------------------------------------------------------

describe('result cards (mockup .scard anatomy)', () => {
  it('every catalog entry renders a card with name, description, and source badge', () => {
    renderPage();
    const cards = document.querySelectorAll('.skills-scard');
    expect(cards.length).toBe(PLUGIN_CATALOG.length);
    for (const e of PLUGIN_CATALOG) {
      const card = screen.getByTestId(`skill-card-${e.key}`);
      expect(card.textContent).toContain(e.label);
      expect(card.textContent).toContain(e.description);
      expect(card.querySelector(`.skills-src--${e.source}`)).toBeTruthy();
    }
  });

  it('every compat cell renders the honest n/a outline — never a fabricated verdict', () => {
    renderPage();
    const naCells = document.querySelectorAll('.skills-cdot--na');
    expect(naCells.length).toBe(PLUGIN_CATALOG.length * 8); // 5 provider + 3 harness
    expect(document.querySelectorAll('.skills-cdot--ok').length).toBe(0);
    expect(document.querySelectorAll('.skills-cdot--warn').length).toBe(0);
    expect(document.querySelectorAll('.skills-compat__gnote')[0].textContent).toContain('hub API');
  });

  it('no installed tags or update buttons render — that data does not exist', () => {
    renderPage();
    expect(document.querySelectorAll('.installed-tag').length).toBe(0);
    expect(screen.queryByRole('button', { name: /update/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^install$/i })).toBeNull();
  });

  it('the manage action navigates to the Agents surface', () => {
    renderPage();
    const manages = screen.getAllByRole('button', { name: /manage/i });
    fireEvent.click(manages[0]);
    expect(screen.getByTestId('location').textContent).toBe('/agents');
  });
});

// ---------------------------------------------------------------------------
// Warn-note anatomy (third-party entries — none in the catalog today)
// ---------------------------------------------------------------------------

describe('warn-note (third-party anatomy)', () => {
  it('renders for a third-party entry and only there', async () => {
    const { SkillCard } = await import('../../console/src/components/skills/SkillCard');
    const thirdparty = {
      key: 'shady@unverified-pub',
      label: 'Shady Tool',
      description: 'Unverified publisher entry',
      category: 'dev' as const,
      source: 'thirdparty' as const,
    };
    const official = { ...thirdparty, key: 'ok@claude-plugins-official', source: 'official' as const };
    const { container: c1, unmount } = render(
      <MemoryRouter>
        <SkillCard entry={thirdparty} />
      </MemoryRouter>,
    );
    expect(c1.querySelector('.skills-warnnote')).toBeTruthy();
    expect(c1.querySelector('.skills-warnnote b')?.textContent).toContain('Third-party publisher code');
    expect(c1.querySelector('.skills-src--thirdparty')).toBeTruthy();
    unmount();
    const { container: c2 } = render(
      <MemoryRouter>
        <SkillCard entry={official} />
      </MemoryRouter>,
    );
    expect(c2.querySelector('.skills-warnnote')).toBeNull();
  });
});
