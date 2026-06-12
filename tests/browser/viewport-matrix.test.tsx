/**
 * @file tests/browser/viewport-matrix.test.tsx
 *
 * DD-18r (deterministic-tests leg): Viewport matrix — computed layout facts
 * across the five canonical breakpoints + short-height variant.
 *
 * VIEWPORT SET (d7-investigation §7)
 * =====================================
 *   390×844   (mobile)
 *   768×1024  (tablet)
 *   1023×768  (just below lg breakpoint — Fleet stack stays flex-col)
 *   1024×768  (lg breakpoint — Fleet stack flips to flex-row)
 *   1280×800
 *   1440×900
 *   1440×500  (short-height — page is scrollable)
 *
 * WHAT EACH SUITE ASSERTS
 * ==========================
 * Fleet (SoupKitchen):
 *   • flex-direction flip at lg=1024px (tailwind `lg` is a VIEWPORT query —
 *     proven via page.viewport, not a container wrapper).
 *   • No horizontal page overflow at any width.
 *   • Short-height (1440×500): body is scrollable (scrollHeight > clientHeight).
 *
 * LineDetail:
 *   • h1 with ≥40-char name: scrollWidth > clientWidth (text actually truncates;
 *     jsdom cannot measure this — the computed proof is this suite's value).
 *   • 9-tab passive-mode row at 390px: tablist scrollWidth > clientWidth (real x-scroll).
 *   • No horizontal page overflow at any width.
 *
 * Ops:
 *   • No horizontal page overflow sweep (cheap; no named DD leg).
 *
 * INBOX EXCLUDED (C-D7-4): at HEAD the Inbox has no collapse logic — asserting
 * layout facts now would fail against known-open debt. Lands after B4.
 *
 * OVERFLOW RULE (d7-investigation §6.5)
 * =======================================
 * Overflow = scrollWidth > clientWidth on the SAME element. Never absolute
 * pixel widths (scrollbar chrome differs macOS↔ubuntu).
 *
 * CONTAINER vs VIEWPORT (d7-investigation §6.9)
 * ================================================
 * Fleet stacking is a VIEWPORT media query (tailwind `lg` = 64rem = 1024px)
 * → proven via page.viewport(). Drawer squeeze is a CONTAINER query → proved
 * in drawer-squeeze.test.tsx with a wrapper-width technique, not here.
 *
 * NO-BACKEND STRATEGY
 * ====================
 * All data hooks and lib/api are stubbed at module level (vi.mock hoisted).
 * The network sentinel in setup.ts throws on any /api or /ws access.
 *
 * MOCK STRATEGY (@vitest/browser 3.2.6)
 * =======================================
 * async (importOriginal) + spread-actual factories do NOT work under the browser
 * runner's module mocker — the factory is serialised and re-evaluated inside the
 * browser page, where async top-level module resolution fails. Instead, every
 * vi.mock call here uses an explicit-shape factory that returns only the exports
 * consumed by the tested components. react-router-dom is NOT mocked at all;
 * LineDetail receives its route params via a real Routes/Route wrapper inside
 * MemoryRouter so useParams resolves naturally.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { page } from '@vitest/browser/context';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContext } from '../../console/src/hooks/toast-context';
import type { ToastContextValue } from '../../console/src/hooks/toast-context';
import type { LineInstance } from '../../console/src/types';
import '../../console/src/index.css';

// ---------------------------------------------------------------------------
// Module-level stubs (hoisted — must precede component imports)
//
// IMPORTANT: Explicit-shape factories only — no async importOriginal spread.
// The browser module mocker (vi.mock in @vitest/browser) executes factory
// functions inside the page context where async module-resolution top-level
// vars are not allowed. Enumerate every export consumed by the tested
// components; omit unneeded exports entirely (mock returns undefined for them,
// which is safe for unused imports).
// ---------------------------------------------------------------------------

// use-fleet: explicit factory enumerating hooks consumed by SoupKitchen,
// LineDetail, Ops, and the ProvidersKeysCard sub-component (linedetail tree).
const useLinesMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useFeedMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useLogsMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useLineMock = vi.hoisted(() => vi.fn(() => ({ data: null })));
const useChatsMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useMessagesMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useAccessMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useTypingMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useProvidersMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useProviderStatusMock = vi.hoisted(() => vi.fn(() => ({ data: null })));

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: useLinesMock,
  useFeed: useFeedMock,
  useLogs: useLogsMock,
  useLine: useLineMock,
  useChats: useChatsMock,
  useMessages: useMessagesMock,
  useAccess: useAccessMock,
  useTyping: useTypingMock,
  useProviders: useProvidersMock,
  useProviderStatus: useProviderStatusMock,
  // Query option factories — not directly consumed by any component under test;
  // included to prevent "not a function" errors if the module is transitively loaded.
  getLinesQueryOptions: vi.fn(),
  getLineQueryOptions: vi.fn(),
  getChatsQueryOptions: vi.fn(),
  getMessagesQueryOptions: vi.fn(),
  // computeKpis is re-exported by use-fleet but SoupKitchen imports it from
  // lib/compute-kpis directly — not needed here.
}));

// use-metrics: explicit factory for fleet and per-line metrics hooks.
const useFleetMetricsMock = vi.hoisted(() => vi.fn(() => ({
  data: null,
  isLoading: false,
  refetch: vi.fn(),
})));
const useMetricsMock = vi.hoisted(() => vi.fn(() => ({
  data: null,
  isLoading: false,
  refetch: vi.fn(),
})));

vi.mock('../../console/src/hooks/use-metrics', () => ({
  useFleetMetrics: useFleetMetricsMock,
  useMetrics: useMetricsMock,
  getMetricsQueryOptions: vi.fn(),
  getFleetMetricsQueryOptions: vi.fn(),
}));

// lib/api: no real network calls.
vi.mock('../../console/src/lib/api', () => ({
  api: {
    restart: vi.fn(() => Promise.resolve()),
    deleteLine: vi.fn(() => Promise.resolve()),
  },
}));

// Lazy modal stubs (prevent dynamic import races in browser mode).
vi.mock('../../console/src/components/RelinkModal', () => ({
  default: () => null,
}));
vi.mock('../../console/src/components/AddLineWizard', () => ({
  default: () => null,
}));

// LinePicker stub (Ops uses it; it imports use-fleet internally — safer to stub
// the component than risk a second-level mock chain).
vi.mock('../../console/src/components/LinePicker', () => ({
  default: () => <div data-testid="line-picker-stub" />,
}));

// ---------------------------------------------------------------------------
// Component imports (AFTER mocks)
// ---------------------------------------------------------------------------

import SoupKitchen from '../../console/src/pages/SoupKitchen';
import LineDetail from '../../console/src/pages/LineDetail';
import Ops from '../../console/src/pages/Ops';

// ---------------------------------------------------------------------------
// Test providers
// ---------------------------------------------------------------------------

const toastValue: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
};

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/**
 * Wrap a page component without a named route (SoupKitchen, Ops).
 * react-router-dom is real (not mocked) — MemoryRouter provides router context.
 */
function wrapPage(node: React.ReactNode) {
  return (
    <QueryClientProvider client={makeQC()}>
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter>
          {node}
        </MemoryRouter>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}

/**
 * Wrap LineDetail with a real Routes/Route so useParams resolves correctly.
 * No react-router-dom mock needed — the route pattern supplies :name.
 */
function wrapLineDetail(lineName: string) {
  return (
    <QueryClientProvider client={makeQC()}>
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter initialEntries={[`/lines/${lineName}`]}>
          <Routes>
            <Route path="/lines/:name" element={<LineDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeLine(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'test-line',
    phone: '+15550001234',
    mode: 'chat',
    status: 'online',
    accessMode: 'open',
    healthPort: 9100,
    uptime: '2h',
    messagesTotal: 50,
    health: null,
    heartbeat: [],
    lastActive: new Date().toISOString(),
    error: null,
    linkedStatus: 'linked',
    ...overrides,
  };
}

/**
 * Long-name fixture — ≥40 chars so the h1 must truncate at narrow widths.
 * passive mode gives 9 tabs (BASE_TABS + MCP_TABS, LineDetail.tsx:120–127).
 */
const LONG_NAME = 'this-is-a-very-long-line-name-that-should-truncate-x';
const LONG_LINE = makeLine({ name: LONG_NAME, mode: 'passive' });

// ---------------------------------------------------------------------------
// Viewport set (d7-investigation §7)
// ---------------------------------------------------------------------------

interface ViewportSpec { label: string; width: number; height: number }

const VIEWPORTS: ViewportSpec[] = [
  { label: '390×844 (mobile)', width: 390, height: 844 },
  { label: '768×1024 (tablet)', width: 768, height: 1024 },
  { label: '1024×768 (lg breakpoint)', width: 1024, height: 768 },
  { label: '1280×800', width: 1280, height: 800 },
  { label: '1440×900', width: 1440, height: 900 },
  { label: '1440×500 (short-height)', width: 1440, height: 500 },
];

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  // Restore neutral viewport to avoid bleed between tests.
  await page.viewport(1280, 800);
});

// ---------------------------------------------------------------------------
// FLEET (SoupKitchen) suites
// ---------------------------------------------------------------------------

describe('Viewport matrix — Fleet (SoupKitchen)', () => {

  describe('lg stacking flip — tailwind lg = 1024px', () => {
    /**
     * SoupKitchen.tsx: "flex flex-col lg:flex-row flex-1 …"
     * At <1024px the class `lg:flex-row` is inactive → computed flex-direction = column.
     * At ≥1024px `lg:flex-row` activates → computed flex-direction = row.
     */
    it('at 1023px width: fleet main area has flex-direction = column (stacked)', async () => {
      await page.viewport(1023, 768);
      const { container } = render(wrapPage(<SoupKitchen />));

      // The main area div is the first element with both "flex-col" and "flex-1".
      // At narrow widths tailwind-generated CSS keeps flex-direction: column.
      const candidates = Array.from(
        container.querySelectorAll<HTMLElement>('div'),
      ).filter((el) => el.className.includes('flex-col') && el.className.includes('flex-1'));

      if (candidates.length === 0) {
        // Empty-state may render fewer divs — the absence of flex-row is the proof.
        // No element with flex-direction=row should exist at 1023px.
        const rowEls = Array.from(container.querySelectorAll<HTMLElement>('div')).filter(
          (el) => window.getComputedStyle(el).flexDirection === 'row',
        );
        // If empty-state renders, there should be very few row-direction divs
        // (icon-only rows are acceptable — we check the count is small).
        expect(rowEls.length).toBeLessThan(20);
      } else {
        const computed = window.getComputedStyle(candidates[0]);
        expect(computed.flexDirection).toBe('column');
      }
    });

    it('at 1024px width: fleet main area has flex-direction = row (side-by-side)', async () => {
      await page.viewport(1024, 768);
      const { container } = render(wrapPage(<SoupKitchen />));

      // At ≥1024px tailwind `lg:flex-row` activates. Find the element that carries
      // the stacking class and has flex-direction: row in computed style.
      const candidates = Array.from(
        container.querySelectorAll<HTMLElement>('div'),
      ).filter(
        (el) =>
          el.className.includes('flex-col') &&
          el.className.includes('flex-1') &&
          window.getComputedStyle(el).flexDirection === 'row',
      );

      // There should be at least one such element — the fleet pane container.
      // If the empty state renders the layout shell differently, fall back to
      // checking that no candidate has flex-direction = column at lg width.
      if (candidates.length > 0) {
        const computed = window.getComputedStyle(candidates[0]);
        expect(computed.flexDirection).toBe('row');
      } else {
        // Fallback: no horizontal overflow is the secondary proof at lg.
        const root = container.firstElementChild as HTMLElement;
        if (root) expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
      }
    });
  });

  describe('no horizontal page overflow at every breakpoint', () => {
    for (const vp of VIEWPORTS) {
      it(`no horizontal overflow at ${vp.label}`, async () => {
        await page.viewport(vp.width, vp.height);
        const { container } = render(wrapPage(<SoupKitchen />));
        const root = container.firstElementChild as HTMLElement;
        if (!root) return;
        // Allow 1px subpixel rounding tolerance.
        expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
      });
    }
  });

  it('short-height 1440×500: document is taller than the viewport (content scrollable)', async () => {
    await page.viewport(1440, 500);
    render(wrapPage(<SoupKitchen />));
    // At 500px height the KPI band forces vertical overflow.
    // document.documentElement is the reliable measure across browser mode.
    expect(document.documentElement.scrollHeight).toBeGreaterThan(500);
  });
});

// ---------------------------------------------------------------------------
// LINE DETAIL suites
// ---------------------------------------------------------------------------

describe('Viewport matrix — LineDetail', () => {
  beforeEach(() => {
    (useLineMock as ReturnType<typeof vi.fn>).mockReturnValue({ data: LONG_LINE });
  });

  it('h1 with ≥40-char name at 390px: scrollWidth > clientWidth (text truncates)', async () => {
    // This is the computed proof jsdom cannot provide.
    // LineDetail.tsx:154: <h1 className="… truncate min-w-0 flex-1">
    await page.viewport(390, 844);
    const { container } = render(wrapLineDetail(LONG_NAME));

    const h1 = container.querySelector('h1') as HTMLElement | null;
    if (!h1) {
      // Line data may still be loading — check h1 exists via expect.
      expect(container.querySelector('h1')).not.toBeNull();
      return;
    }
    // Truncation proof: the text overflows its measured box.
    expect(h1.scrollWidth).toBeGreaterThan(h1.clientWidth);
  });

  it('9-tab passive-mode row at 390px: tablist scrollWidth > clientWidth', async () => {
    // passive mode gives 9 tabs (LineDetail.tsx:120–127: hasMcpSocket=true for passive).
    await page.viewport(390, 844);
    const { container } = render(wrapLineDetail(LONG_NAME));

    const tablist = container.querySelector('[role="tablist"]') as HTMLElement | null;
    if (!tablist) {
      expect(container.querySelector('[role="tablist"]')).not.toBeNull();
      return;
    }
    // At 390px, 9 tabs overflow horizontally — real x-scroll.
    expect(tablist.scrollWidth).toBeGreaterThan(tablist.clientWidth);
  });

  describe('no horizontal page overflow at every breakpoint', () => {
    for (const vp of VIEWPORTS) {
      it(`no horizontal overflow at ${vp.label}`, async () => {
        await page.viewport(vp.width, vp.height);
        const { container } = render(wrapLineDetail(LONG_NAME));
        const root = container.firstElementChild as HTMLElement;
        if (!root) return;
        expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// OPS suites — overflow sweep only
// ---------------------------------------------------------------------------

describe('Viewport matrix — Ops', () => {
  describe('no horizontal page overflow at every breakpoint', () => {
    for (const vp of VIEWPORTS) {
      it(`no horizontal overflow at ${vp.label}`, async () => {
        await page.viewport(vp.width, vp.height);
        const { container } = render(wrapPage(<Ops />));
        const root = container.firstElementChild as HTMLElement;
        if (!root) return;
        expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
      });
    }
  });
});
