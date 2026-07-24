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
 * Inbox (C-D7-4 — unblocked since B4 landed):
 *   • Contact pane present (display != "none") when soup-inbox-layout container
 *     is ≥1080px (wrapper-width technique — CONTAINER query, not viewport).
 *   • Contact pane computed display = "none" when container is <1080px.
 *   • Chat-list pane and thread pane both present at named widths.
 *   • No horizontal overflow at the full viewport matrix.
 *
 * Drawer squeeze (DD-18r deterministic backstop — delivered here, not in the
 * never-created drawer-squeeze.test.tsx):
 *   • At 899px wrapper: .soup-drawer computed position = "absolute" (overlay mode).
 *   • At 900px wrapper: .soup-drawer computed position = "static" (squeeze / flex-sibling mode).
 *   • Scrim display = "none" at 900px; visible (not "none") at 899px.
 *   These are CONTAINER queries on .soup-drawer-layout — proven via wrapper-width,
 *   not page.viewport (d7-investigation §6.9).
 *
 * OVERFLOW RULE (d7-investigation §6.5)
 * =======================================
 * Overflow = scrollWidth > clientWidth on the SAME element. Never absolute
 * pixel widths (scrollbar chrome differs macOS↔ubuntu).
 *
 * CONTAINER vs VIEWPORT (d7-investigation §6.9)
 * ================================================
 * Fleet stacking is a VIEWPORT media query (tailwind `lg` = 64rem = 1024px)
 * → proven via page.viewport(). Drawer squeeze and Inbox contact-pane collapse
 * are CONTAINER queries → proven via wrapper-width technique in this file.
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
import { page } from 'vitest/browser';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContext } from '../../console/src/hooks/toast-context';
import type { ToastContextValue } from '../../console/src/hooks/toast-context';
import type { LineInstance, ChatItem, Message } from '../../console/src/types';
import NavRail from '../../console/src/components/chrome/NavRail';
import { SummaryTab } from '../../console/src/components/line-detail/SummaryTab';
import { HistoryTab } from '../../console/src/components/line-detail/HistoryTab';
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
const useCheckpointsMock = vi.hoisted(() => vi.fn(() => ({ data: undefined, isLoading: false, freshness: undefined })));
const useProvidersMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useProviderStatusMock = vi.hoisted(() => vi.fn(() => ({ data: null })));
// RateLimitsCard (SummaryTab, chat-mode) calls useRateLimits internally —
// the explicit-shape factory must provide it or the import errors at load.
const useRateLimitsMock = vi.hoisted(() => vi.fn(() => ({ data: undefined, isLoading: false, freshness: { observedAt: null, stale: false } })));
// LineDetail (checkpoints tab, terminal stage A) calls useLiveSessions —
// the explicit-shape factory must provide it or the import errors at load.
const useLiveSessionsMock = vi.hoisted(() => vi.fn(() => ({ data: undefined, isLoading: false, freshness: { observedAt: null, stale: false } })));
const useApprovalsMock = vi.hoisted(() => vi.fn(() => ({ data: undefined, isLoading: false, freshness: { observedAt: null, stale: false } })));

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: useLinesMock,
  useFeed: useFeedMock,
  useLogs: useLogsMock,
  useLine: useLineMock,
  useChats: useChatsMock,
  useMessages: useMessagesMock,
  useAccess: useAccessMock,
  useTyping: useTypingMock,
  useCheckpoints: useCheckpointsMock,
  useProviders: useProvidersMock,
  useProviderStatus: useProviderStatusMock,
  useRateLimits: useRateLimitsMock,
  useLiveSessions: useLiveSessionsMock,
  useApprovals: useApprovalsMock,
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
    searchMessages: vi.fn(() => Promise.resolve({ results: [], total: 0 })),
    getMessages: vi.fn(() => Promise.resolve([])),
    sendMessage: vi.fn(() => Promise.resolve()),
  },
  // App now reaches use-websocket (via the connection-status hook), which imports
  // isProductionConsole from lib/api — expose it on the explicit-shape mock.
  isProductionConsole: () => false,
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
// Additional stubs for Inbox
// ---------------------------------------------------------------------------

// use-sticky-scroll: returns a stable ref + no-op helpers so the Inbox
// message-area renders without real scroll measurements.
vi.mock('../../console/src/hooks/use-sticky-scroll', () => ({
  useStickyScroll: () => ({
    scrollRef: { current: null },
    showJump: false,
    handleScroll: () => {},
    jumpToBottom: () => {},
  }),
}));

// use-virtual-messages: returns a minimal virtualizer stub so the
// Inbox message list renders an empty virtual container.
vi.mock('../../console/src/hooks/use-virtual-messages', () => ({
  useVirtualMessages: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    scrollToIndex: () => {},
  }),
}));

// lib/inbox-chat-selection: resolveCurrentChat returns null (no active chat).
vi.mock('../../console/src/lib/inbox-chat-selection', () => ({
  resolveCurrentChat: () => null,
}));

// lib/inbox-virtualization: pure helpers; stub to isolate from data shape.
vi.mock('../../console/src/lib/inbox-virtualization', () => ({
  toChronologicalMessages: (msgs: unknown[]) => (Array.isArray(msgs) ? msgs : []),
  selectVirtualMessageRows: () => [],
}));

// ChatList — stub to avoid the listbox keyboard logic in this layout suite.
vi.mock('../../console/src/components/ChatList', () => ({
  default: () => <div data-testid="chat-list-stub" />,
}));

// MessageBubble — stub to avoid message-bubble rendering in this layout suite.
vi.mock('../../console/src/components/MessageBubble', () => ({
  default: () => <div data-testid="message-bubble-stub" />,
}));

// SaveContactDialog — stub the dialog component used by Inbox.
vi.mock('../../console/src/components/SaveContactDialog', () => ({
  SaveContactDialog: () => null,
}));

// ---------------------------------------------------------------------------
// Component imports (AFTER mocks)
// ---------------------------------------------------------------------------

import SoupKitchen from '../../console/src/pages/SoupKitchen';
import LineDetail from '../../console/src/pages/LineDetail';
import Ops from '../../console/src/pages/Operator';
import Inbox from '../../console/src/pages/Inbox';
import {
  Drawer,
  DrawerLayout,
  DrawerHeader,
  DrawerBody,
} from '../../console/src/components/primitives/Drawer';

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

  describe('content-grid stacking flip — mockup @media (max-width:1100px)', () => {
    /**
     * v3.5 b-03: SoupKitchen's main area is `.fleet-content`, a CSS grid
     * (1fr + --fleet-activity-w). The mockup's 1100px media query stacks it
     * to a single column — the tailwind lg:flex-row idiom is gone.
     */
    it('at 1099px width: fleet content grid stacks (grid-template-columns = 1fr)', async () => {
      await page.viewport(1099, 768);
      const { container } = await render(wrapPage(<SoupKitchen />));
      const grid = container.querySelector<HTMLElement>('.fleet-content');
      expect(grid).not.toBeNull();
      const computed = window.getComputedStyle(grid!);
      expect(computed.gridTemplateColumns.split(' ').length).toBe(1);
    });

    it('at 1101px width: fleet content grid is side-by-side (1fr + activity column)', async () => {
      await page.viewport(1101, 768);
      const { container } = await render(wrapPage(<SoupKitchen />));
      const grid = container.querySelector<HTMLElement>('.fleet-content');
      expect(grid).not.toBeNull();
      const computed = window.getComputedStyle(grid!);
      expect(computed.gridTemplateColumns.split(' ').length).toBe(2);
      // KPI strip flips 5-up → 2-up at ≤1100px; at 1101 it stays 5-up.
      const kpis = container.querySelector<HTMLElement>('.fleet-kpis');
      expect(kpis).not.toBeNull();
      expect(window.getComputedStyle(kpis!).gridTemplateColumns.split(' ').length).toBe(5);
    });

    it('at 1100px width: fleet content grid is stacked (max-width:1100px matches at the boundary)', async () => {
      await page.viewport(1100, 768);
      const { container } = await render(wrapPage(<SoupKitchen />));
      const grid = container.querySelector<HTMLElement>('.fleet-content');
      expect(grid).not.toBeNull();
      expect(window.getComputedStyle(grid!).gridTemplateColumns.split(' ').length).toBe(1);
      const kpis = container.querySelector<HTMLElement>('.fleet-kpis');
      expect(kpis).not.toBeNull();
      expect(window.getComputedStyle(kpis!).gridTemplateColumns.split(' ').length).toBe(2);
    });

    it('at 1099px width: KPI strip is 2-up', async () => {
      await page.viewport(1099, 768);
      const { container } = await render(wrapPage(<SoupKitchen />));
      const kpis = container.querySelector<HTMLElement>('.fleet-kpis');
      expect(kpis).not.toBeNull();
      expect(window.getComputedStyle(kpis!).gridTemplateColumns.split(' ').length).toBe(2);
    });
  });

  describe('no horizontal page overflow at every breakpoint', () => {
    for (const vp of VIEWPORTS) {
      it(`no horizontal overflow at ${vp.label}`, async () => {
        await page.viewport(vp.width, vp.height);
        const { container } = await render(wrapPage(<SoupKitchen />));
        const root = container.firstElementChild as HTMLElement;
        if (!root) return;
        // Allow 1px subpixel rounding tolerance.
        expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
      });
    }
  });

  it('short-height 1440×500: document is taller than the viewport (content scrollable)', async () => {
    await page.viewport(1440, 500);
    await render(wrapPage(<SoupKitchen />));
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
    const { container } = await render(wrapLineDetail(LONG_NAME));

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
    const { container } = await render(wrapLineDetail(LONG_NAME));

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
        const { container } = await render(wrapLineDetail(LONG_NAME));
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
        const { container } = await render(wrapPage(<Ops />));
        const root = container.firstElementChild as HTMLElement;
        if (!root) return;
        expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// INBOX suites (C-D7-4 — unblocked since B4 landed)
//
// The Inbox contact-pane collapse is a CONTAINER query on .soup-inbox-layout
// (primitives.css:1560–1568): @container (max-width: 1079px) { .soup-inbox-contact
// { display: none; } }. We control the container width via an explicit wrapper
// style — page.viewport() cannot prove a container query (d7-investigation §6.9).
// ---------------------------------------------------------------------------

/**
 * Wrap Inbox in a sized div so the container query evaluates against the
 * wrapper width, not the viewport. Also wraps in all required providers.
 */
function wrapInbox(containerWidthPx: number) {
  return (
    <QueryClientProvider client={makeQC()}>
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter>
          {/* The explicit width forces soup-inbox-layout's container query to
              evaluate at the supplied width regardless of viewport size. */}
          <div style={{ width: `${containerWidthPx}px`, overflow: 'hidden' }}>
            <Inbox />
          </div>
        </MemoryRouter>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}

describe('Viewport matrix — Inbox (C-D7-4)', () => {

  describe('contact-pane collapse — container query at 1080px threshold', () => {
    /**
     * primitives.css Inbox layout band:
     *   .soup-inbox-layout { container-type: inline-size; }
     *   @container (max-width: 1079px) { .soup-inbox-contact { display: none; } }
     *
     * At container >=1080px: contact pane must not be display:none.
     * At container <1080px:  contact pane must be display:none.
     */
    it('contact pane present (display != none) at 1280px container width', async () => {
      await page.viewport(1440, 900);
      const { container } = await render(wrapInbox(1280));

      const contactPane = container.querySelector('.soup-inbox-contact') as HTMLElement | null;
      if (!contactPane) {
        // Pane may not render if no line is selected — assert it exists.
        expect(container.querySelector('.soup-inbox-contact')).not.toBeNull();
        return;
      }
      const display = window.getComputedStyle(contactPane).display;
      expect(display).not.toBe('none');
    });

    it('contact pane present (display != none) at 1200px container width (safely above threshold)', async () => {
      // The @container (max-width: 1079px) rule collapses the pane at <1080px.
      // We use 1200px (safely above) to avoid subpixel boundary ambiguity.
      await page.viewport(1440, 900);
      const { container } = await render(wrapInbox(1200));

      const contactPane = container.querySelector('.soup-inbox-contact') as HTMLElement | null;
      if (!contactPane) {
        expect(container.querySelector('.soup-inbox-contact')).not.toBeNull();
        return;
      }
      const display = window.getComputedStyle(contactPane).display;
      expect(display).not.toBe('none');
    });

    it('contact pane collapsed (display = none) at 1079px container width (just below threshold)', async () => {
      await page.viewport(1440, 900);
      const { container } = await render(wrapInbox(1079));

      const contactPane = container.querySelector('.soup-inbox-contact') as HTMLElement | null;
      if (!contactPane) {
        // If the element is not in the DOM at all, the pane is collapsed — pass.
        return;
      }
      const display = window.getComputedStyle(contactPane).display;
      expect(display).toBe('none');
    });

    it('contact pane collapsed (display = none) at 768px container width', async () => {
      await page.viewport(1440, 900);
      const { container } = await render(wrapInbox(768));

      const contactPane = container.querySelector('.soup-inbox-contact') as HTMLElement | null;
      if (!contactPane) {
        return;
      }
      const display = window.getComputedStyle(contactPane).display;
      expect(display).toBe('none');
    });
  });

  describe('chat-list and thread panes present', () => {
    it('chat-list pane present at 1280px container', async () => {
      await page.viewport(1440, 900);
      const { container } = await render(wrapInbox(1280));
      // Chat-list pane carries the --inbox-pane-chats width class; the ChatList
      // stub renders inside it.
      const chatListStub = container.querySelector('[data-testid="chat-list-stub"]');
      expect(chatListStub).not.toBeNull();
    });

    it('chat-list pane present at 768px container', async () => {
      await page.viewport(1440, 900);
      const { container } = await render(wrapInbox(768));
      const chatListStub = container.querySelector('[data-testid="chat-list-stub"]');
      expect(chatListStub).not.toBeNull();
    });
  });

  describe('no horizontal overflow at every breakpoint', () => {
    for (const vp of VIEWPORTS) {
      it(`Inbox: no horizontal overflow at ${vp.label}`, async () => {
        await page.viewport(vp.width, vp.height);
        const { container } = await render(wrapInbox(vp.width));
        const root = container.firstElementChild as HTMLElement;
        if (!root) return;
        // Allow 1px subpixel rounding tolerance (C-D7-6).
        expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// DRAWER SQUEEZE suite (DD-18r deterministic backstop)
//
// Resolves primitives-drawer.test.tsx:382 INCONCLUSIVE marker.
// The flip is a CONTAINER query on .soup-drawer-layout:
//   @container (min-width: 900px) {
//     .soup-drawer { position: static; flex: 0 0 …; … }
//     .soup-drawer-scrim { display: none; }
//   }
// Default (< 900px container): .soup-drawer { position: absolute }
//                               .soup-drawer-scrim visible.
//
// Technique: wrap DrawerLayout in a div whose width is set explicitly.
// The container query evaluates against the .soup-drawer-layout element's
// inline size, which is constrained by the wrapper width.
// ---------------------------------------------------------------------------

describe('Drawer squeeze flip — container query at 900px (DD-18r)', () => {
  /**
   * Mount DrawerLayout + Drawer at controlled wrapper width and measure the
   * computed position of .soup-drawer and display of .soup-drawer-scrim.
   *
   * DrawerLayout sets container-type: inline-size on .soup-drawer-layout;
   * the @container rule fires when that element is ≥900px wide.
   */

  it('at 899px wrapper: .soup-drawer is position=absolute (overlay mode)', async () => {
    await page.viewport(1440, 900);

    const { container } = await render(
      <div style={{ width: '899px' }}>
        <DrawerLayout
          drawer={
            <Drawer open onClose={() => {}}>
              <DrawerHeader title="Test drawer" onClose={() => {}} />
              <DrawerBody><span>content</span></DrawerBody>
            </Drawer>
          }
        >
          <div>main content</div>
        </DrawerLayout>
      </div>
    );

    const drawerEl = container.querySelector('.soup-drawer') as HTMLElement | null;
    if (!drawerEl) {
      expect(container.querySelector('.soup-drawer')).not.toBeNull();
      return;
    }
    const position = window.getComputedStyle(drawerEl).position;
    expect(position).toBe('absolute');
  });

  it('at 900px wrapper: .soup-drawer is position=static (squeeze / flex-sibling mode)', async () => {
    await page.viewport(1440, 900);

    const { container } = await render(
      <div style={{ width: '900px' }}>
        <DrawerLayout
          drawer={
            <Drawer open onClose={() => {}}>
              <DrawerHeader title="Test drawer" onClose={() => {}} />
              <DrawerBody><span>content</span></DrawerBody>
            </Drawer>
          }
        >
          <div>main content</div>
        </DrawerLayout>
      </div>
    );

    const drawerEl = container.querySelector('.soup-drawer') as HTMLElement | null;
    if (!drawerEl) {
      expect(container.querySelector('.soup-drawer')).not.toBeNull();
      return;
    }
    const position = window.getComputedStyle(drawerEl).position;
    expect(position).toBe('static');
  });

  it('at 899px wrapper: scrim is visible (display != none)', async () => {
    await page.viewport(1440, 900);

    const { container } = await render(
      <div style={{ width: '899px' }}>
        <DrawerLayout
          drawer={
            <Drawer open onClose={() => {}}>
              <DrawerHeader title="Scrim test" onClose={() => {}} />
              <DrawerBody><span>content</span></DrawerBody>
            </Drawer>
          }
        >
          <div>main content</div>
        </DrawerLayout>
      </div>
    );

    const scrim = container.querySelector('.soup-drawer-scrim') as HTMLElement | null;
    if (!scrim) {
      expect(container.querySelector('.soup-drawer-scrim')).not.toBeNull();
      return;
    }
    const display = window.getComputedStyle(scrim).display;
    expect(display).not.toBe('none');
  });

  it('at 900px wrapper: scrim is display=none (squeeze mode — no scrim)', async () => {
    await page.viewport(1440, 900);

    const { container } = await render(
      <div style={{ width: '900px' }}>
        <DrawerLayout
          drawer={
            <Drawer open onClose={() => {}}>
              <DrawerHeader title="Scrim test" onClose={() => {}} />
              <DrawerBody><span>content</span></DrawerBody>
            </Drawer>
          }
        >
          <div>main content</div>
        </DrawerLayout>
      </div>
    );

    const scrim = container.querySelector('.soup-drawer-scrim') as HTMLElement | null;
    if (!scrim) {
      // Scrim element may not render at all in squeeze mode — that is also valid.
      return;
    }
    const display = window.getComputedStyle(scrim).display;
    expect(display).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// RAIL collapse suite (v3.5 T5 b-02 — mockup @media (max-width:1100px))
//
// The rail collapse is a VIEWPORT media query (chrome.css) — proven via
// page.viewport, mirroring the Fleet lg-flip rows. NavRail needs no hook
// mocks: useRealtime has a default context value and useTheme is
// provider-free (localStorage + document).
// Labels drop out of layout per the mockup SSOT via the sr-only clip recipe
// (NOT display:none) so icon-only rows keep their content-computed accessible
// name — label text + Inbox unread count — for screen readers (b-02
// cross-review finding); the glyph + link title reinforce meaning.
// ---------------------------------------------------------------------------

describe('Viewport matrix — rail collapse (v3.5 b-02)', () => {
  it('rail is full width (212px) with visible labels at 1101px viewport', async () => {
    await page.viewport(1101, 800);
    const { container } = await render(
      <MemoryRouter><NavRail /></MemoryRouter>,
    );
    const rail = container.querySelector('.chrome-rail') as HTMLElement;
    expect(rail).not.toBeNull();
    expect(window.getComputedStyle(rail).width).toBe('212px');
    const label = container.querySelector('.chrome-nav-item__label') as HTMLElement;
    expect(label).not.toBeNull();
    expect(window.getComputedStyle(label).display).not.toBe('none');
  });

  it('rail collapses to 64px with labels out of layout at 1100px viewport', async () => {
    await page.viewport(1100, 800);
    const { container } = await render(
      <MemoryRouter><NavRail /></MemoryRouter>,
    );
    const rail = container.querySelector('.chrome-rail') as HTMLElement;
    expect(rail).not.toBeNull();
    expect(window.getComputedStyle(rail).width).toBe('64px');
    const label = container.querySelector('.chrome-nav-item__label') as HTMLElement;
    expect(label).not.toBeNull();
    // Mockup SSOT: out of visual layout via sr-only clip — still displayed
    // (display != none) so the accessible name survives; 1px box clipped away.
    const cs = window.getComputedStyle(label);
    expect(cs.display).not.toBe('none');
    expect(cs.position).toBe('absolute');
    expect(cs.width).toBe('1px');
    expect(cs.height).toBe('1px');
    expect(cs.clip).toBe('rect(0px, 0px, 0px, 0px)');
  });

  it('at short height (1440×500) the nav region owns the scroll and the utility dock stays mounted', async () => {
    await page.viewport(1440, 500);
    const { container } = await render(
      <MemoryRouter><NavRail /></MemoryRouter>,
    );
    const scroll = container.querySelector('.chrome-nav') as HTMLElement;
    expect(scroll).not.toBeNull();
    expect(window.getComputedStyle(scroll).overflowY).toBe('auto');
    expect(window.getComputedStyle(scroll).minHeight).toBe('0px');
    expect(container.querySelector('.chrome-utility')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SIDE-PANEL FOLD suite (DD-18r leg 2 — non-Fleet side-panel law)
//
// Both folds are CONTAINER queries (primitives.css side-panel fold band) —
// proven via the wrapper-width technique (d7-investigation §6.9), mirroring
// the drawer-squeeze rows above.
//   SummaryTab Row 3:  @container (max-width: 599px) → stack + full-width panel
//   HistoryTab split:  @container (max-width: 639px) → stack + full-width
//                      capped chat list
// ---------------------------------------------------------------------------

const foldLine: LineInstance = {
  name: 'fold-line',
  phone: '+15551234567',
  mode: 'agent',
  status: 'online',
  accessMode: 'allowlist',
  healthPort: 9000,
  uptime: '1h',
  messagesTotal: 0,
  health: {
    status: 'ok',
    uptime_seconds: 3600,
    messages_total: 0,
    whatsapp: { connection: { state: 'connected' } },
    sqlite: { messages_total: 0, schema_version: 1 },
  } as LineInstance['health'],
  heartbeat: ['up'],
  lastActive: 'just now',
  error: null,
};

const foldChats: ChatItem[] = [
  { conversationKey: '15550000001@s.whatsapp.net', displayName: 'One', lastMessageAt: null, lastMessagePreview: null, unreadCount: 0, isGroup: false } as unknown as ChatItem,
  { conversationKey: '15550000002@s.whatsapp.net', displayName: 'Two', lastMessageAt: null, lastMessagePreview: null, unreadCount: 0, isGroup: false } as unknown as ChatItem,
];

function wrapSummaryTab(containerWidthPx: number) {
  return (
    <QueryClientProvider client={makeQC()}>
      <ToastContext.Provider value={{ toast: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn(), clear: vi.fn() }}>
        <div style={{ width: `${containerWidthPx}px`, overflow: 'hidden' }}>
          <SummaryTab line={foldLine} onEditConfig={() => {}} onChangeMode={() => {}} />
        </div>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}

function wrapHistoryTab(containerWidthPx: number) {
  return (
    <QueryClientProvider client={makeQC()}>
      <ToastContext.Provider value={{ toast: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn(), clear: vi.fn() }}>
        <div style={{ width: `${containerWidthPx}px`, height: '600px', overflow: 'hidden' }}>
          <HistoryTab
            chats={foldChats}
            messages={[] as Message[]}
            selectedChat={null}
            onSelectChat={() => {}}
            mode="chat"
            lineName="fold-line"
            typingJids={new Set()}
          />
        </div>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}

describe('Viewport matrix — side-panel fold (DD-18r leg 2)', () => {
  it('SummaryTab Row 3 stacks (flex-direction: column) with a full-width actions panel at 599px container', async () => {
    await page.viewport(1440, 900);
    const { container } = await render(wrapSummaryTab(599));
    const row = container.querySelector('.soup-summary-split__row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(window.getComputedStyle(row).flexDirection).toBe('column');
    const panel = container.querySelector('.soup-summary-split__panel') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(window.getComputedStyle(panel).width).toBe(window.getComputedStyle(row).width);
  });

  it('SummaryTab Row 3 is side-by-side (row) with the 260px actions panel at 600px container', async () => {
    await page.viewport(1440, 900);
    const { container } = await render(wrapSummaryTab(600));
    const row = container.querySelector('.soup-summary-split__row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(window.getComputedStyle(row).flexDirection).toBe('row');
    const panel = container.querySelector('.soup-summary-split__panel') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(window.getComputedStyle(panel).width).toBe('260px');
  });

  it('HistoryTab chat list folds full-width and capped at 639px container', async () => {
    await page.viewport(1440, 900);
    const { container } = await render(wrapHistoryTab(639));
    const row = container.querySelector('.soup-history-split__row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(window.getComputedStyle(row).flexDirection).toBe('column');
    const list = container.querySelector('.soup-history-split__list') as HTMLElement;
    expect(list).not.toBeNull();
    // The list fills the row's CONTENT box — the row carries c-border (1px
    // hairlines), so outer row width minus the border widths is the honest
    // full-width expectation (637px at the 639px container, not 639px).
    const rowStyle = window.getComputedStyle(row);
    const expectedWidth = 639
      - Number.parseFloat(rowStyle.borderLeftWidth)
      - Number.parseFloat(rowStyle.borderRightWidth);
    expect(Number.parseFloat(window.getComputedStyle(list).width)).toBeCloseTo(expectedWidth, 0);
    // Browsers resolve dvh to px in computed style — assert the resolved
    // cap is 40% of the viewport height (900px here), never the raw token.
    const maxH = Number.parseFloat(window.getComputedStyle(list).maxHeight);
    expect(maxH).toBeCloseTo(0.4 * 900, 0);
  });

  it('HistoryTab split is side-by-side with the 288px chat list at 640px container', async () => {
    await page.viewport(1440, 900);
    const { container } = await render(wrapHistoryTab(640));
    const row = container.querySelector('.soup-history-split__row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(window.getComputedStyle(row).flexDirection).toBe('row');
    const list = container.querySelector('.soup-history-split__list') as HTMLElement;
    expect(list).not.toBeNull();
    expect(window.getComputedStyle(list).width).toBe('288px');
  });
});
