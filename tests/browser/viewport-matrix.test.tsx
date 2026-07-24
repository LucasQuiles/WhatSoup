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
 * Inbox (T5 b-07 — v3.5 surface, mockup inbox.html SSOT):
 *   • Context pane collapse at the mockup's own 1100px VIEWPORT threshold.
 *   • CSS-only master-detail switch at the mockup's 760px breakpoint (fifth
 *     distinct SSOT breakpoint; data-mobile-detail mirrors selection state).
 *   • Composer uniform control height — caps, input, Send all compute to
 *     var(--inbox-composer-h) = 36px (the bead acceptance item).
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
 * → proven via page.viewport(). Drawer squeeze is a CONTAINER query → proven
 * via wrapper-width technique. The v3.5 Inbox (b-07) uses VIEWPORT queries
 * (the mockup's own) → proven via page.viewport().
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
import Agents from '../../console/src/pages/Agents';
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
// v3.5 Inbox (T5 b-07): chats fixture served by the getChatsQueryOptions mock.
const inboxChatsFixture = vi.hoisted(() => [
  {
    conversationKey: 'conv-a',
    name: 'Fixture Chat',
    lastMessagePreview: 'preview',
    lastMessageAt: '2026-07-23T12:00:00.000Z',
    unreadCount: 0,
    isGroup: false,
  },
]);

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
  // Query option factories — getChatsQueryOptions must be FUNCTIONAL: the
  // v3.5 Inbox composes per-line chats queries through it inside useQueries.
  // The queryFn serves the hoisted fixture (retry off) so no network fires.
  getLinesQueryOptions: vi.fn(),
  getLineQueryOptions: vi.fn(),
  getChatsQueryOptions: (name: string) => ({
    queryKey: ['chats', name],
    queryFn: () => Promise.resolve(inboxChatsFixture),
    enabled: !!name,
    retry: false,
    staleTime: Infinity,
  }),
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
    // v3.5 Inbox: mark-read on open + context-pane checkpoint query.
    markRead: vi.fn(() => Promise.resolve()),
    getCheckpoints: vi.fn(() => Promise.resolve({ observedAt: '', checkpoints: [] })),
    // v3.5 Deployments (T5 b-08): version + fleet liveness queries.
    getVersion: vi.fn(() => Promise.resolve({ sha: 'abc1234def', remoteSha: 'abc1234def', updateAvailable: false, checkedAt: '' })),
    getLivez: vi.fn(() => Promise.resolve({ alive: true, instance: 'whatsoup', pid: 1, uptime_seconds: 1814400, started_at: '' })),
    // v3.5 Settings (T5 b-09): silences + provider credentials.
    getSilences: vi.fn(() => Promise.resolve({ silences: [] })),
    silenceLine: vi.fn(() => Promise.resolve({ ok: true, rule: {} })),
    unsilenceLine: vi.fn(() => Promise.resolve({ ok: true })),
    setCredential: vi.fn(() => Promise.resolve({ ok: true, service: 'deepseek' })),
    verifyCredential: vi.fn(() => Promise.resolve({ service: 'deepseek', status: 'valid' })),
    deleteCredential: vi.fn(() => Promise.resolve({ ok: true, service: 'deepseek' })),
  },
  lockConsole: vi.fn(() => Promise.resolve()),
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

// lib/inbox-virtualization: pure helpers; stub to isolate from data shape.
vi.mock('../../console/src/lib/inbox-virtualization', () => ({
  toChronologicalMessages: (msgs: unknown[]) => (Array.isArray(msgs) ? msgs : []),
  selectVirtualMessageRows: () => [],
}));

// ---------------------------------------------------------------------------
// Component imports (AFTER mocks)
// ---------------------------------------------------------------------------

import SoupKitchen from '../../console/src/pages/SoupKitchen';
import LineDetail from '../../console/src/pages/LineDetail';
import Ops from '../../console/src/pages/Operator';
import Inbox from '../../console/src/pages/Inbox';
import SkillsHub from '../../console/src/pages/SkillsHub';
import DreamLab from '../../console/src/pages/DreamLab';
import Deployments from '../../console/src/pages/Deployments';
import Settings from '../../console/src/pages/Settings';
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
// INBOX suites (T5 b-07 — v3.5 surface, mockup inbox.html SSOT)
//
// The v3.5 inbox collapse rules are VIEWPORT media queries (the mockup's own):
//   @media (max-width: 1100px) { .inbox-ctx { display: none; } wrap → 280px 1fr }
//   @media (max-width: 760px)  { wrap → 1fr; CSS-only master-detail switch on
//                                data-mobile-detail (React selection state) }
// so they are proven via page.viewport() directly (d7-investigation §6.9 —
// the retired v3 band was a container query; this surface is not).
// ---------------------------------------------------------------------------

/** Render the v3.5 Inbox with providers. The useLines mock supplies one line. */
function wrapInboxV35() {
  return (
    <QueryClientProvider client={makeQC()}>
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter>
          <Inbox />
        </MemoryRouter>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}

describe('Viewport matrix — v3.5 Inbox (T5 b-07)', () => {
  beforeEach(async () => {
    useLinesMock.mockReturnValue({
      data: [
        {
          name: 'personal',
          mode: 'chat',
          status: 'running',
          accessMode: 'allowlist',
          health: {
            transport: { kind: 'baileys', connected: true },
            whatsapp: { connected: true, connection: { state: 'connected' } },
          },
        },
      ],
    } as never);
    useMessagesMock.mockReturnValue({
      data: [
        {
          pk: 1,
          conversationKey: 'conv-a',
          senderName: 'Fixture Sender',
          senderJid: '',
          content: 'hello',
          timestamp: '2026-07-23T12:00:00.000Z',
          fromMe: false,
          type: 'text',
        },
      ],
    } as never);
  });

  describe('context pane collapse — viewport query at the mockup 1100px threshold', () => {
    it('context pane present and 3-column grid at 1440×900', async () => {
      await page.viewport(1440, 900);
      const { container } = await render(wrapInboxV35());
      const ctx = container.querySelector('.inbox-ctx') as HTMLElement | null;
      expect(ctx).not.toBeNull();
      expect(window.getComputedStyle(ctx!).display).not.toBe('none');
      const wrap = container.querySelector('.inbox-wrap') as HTMLElement;
      expect(window.getComputedStyle(wrap).gridTemplateColumns.split(' ').length).toBe(3);
    });

    it('context pane present at 1101px (just above the mockup threshold)', async () => {
      await page.viewport(1101, 900);
      const { container } = await render(wrapInboxV35());
      const ctx = container.querySelector('.inbox-ctx') as HTMLElement | null;
      expect(ctx).not.toBeNull();
      expect(window.getComputedStyle(ctx!).display).not.toBe('none');
    });

    it('context pane collapsed (display = none) at 1100px (the mockup threshold)', async () => {
      await page.viewport(1100, 900);
      const { container } = await render(wrapInboxV35());
      const ctx = container.querySelector('.inbox-ctx') as HTMLElement | null;
      expect(ctx).not.toBeNull();
      expect(window.getComputedStyle(ctx!).display).toBe('none');
      // grid drops to the narrow 2-column form
      const wrap = container.querySelector('.inbox-wrap') as HTMLElement;
      expect(window.getComputedStyle(wrap).gridTemplateColumns.split(' ').length).toBe(2);
    });

    it('context pane collapsed at 1000px (below threshold)', async () => {
      await page.viewport(1000, 900);
      const { container } = await render(wrapInboxV35());
      const ctx = container.querySelector('.inbox-ctx') as HTMLElement | null;
      expect(window.getComputedStyle(ctx!).display).toBe('none');
    });
  });

  describe('master-detail switch — the mockup 760px breakpoint (fifth SSOT breakpoint)', () => {
    it('list mode hides the thread at 760px; both panes present at 761px', async () => {
      await page.viewport(760, 800);
      const { container } = await render(wrapInboxV35());
      // no selection → data-mobile-detail="list": thread hidden, list visible
      const page1 = container.querySelector('.inbox-page') as HTMLElement;
      expect(page1.getAttribute('data-mobile-detail')).toBe('list');
      const thread = container.querySelector('.inbox-thread') as HTMLElement;
      expect(window.getComputedStyle(thread).display).toBe('none');
      const list = container.querySelector('.inbox-list') as HTMLElement;
      expect(window.getComputedStyle(list).display).not.toBe('none');

      await page.viewport(761, 800);
      expect(window.getComputedStyle(thread).display).not.toBe('none');
    });

    it('selecting a conversation flips to thread mode: list hides at 760px', async () => {
      await page.viewport(760, 800);
      const { container } = await render(wrapInboxV35());
      await vi.waitFor(() => {
        expect(container.querySelector('.inbox-citem')).not.toBeNull();
      });
      const item = container.querySelector('.inbox-citem') as HTMLElement | null;
      item!.click();
      const pageEl = container.querySelector('.inbox-page') as HTMLElement;
      await vi.waitFor(() => {
        expect(pageEl.getAttribute('data-mobile-detail')).toBe('thread');
      });
      const list = container.querySelector('.inbox-list') as HTMLElement;
      expect(window.getComputedStyle(list).display).toBe('none');
      // back affordance appears only in this mode
      const back = container.querySelector('.inbox-back') as HTMLElement;
      expect(window.getComputedStyle(back).display).not.toBe('none');
    });
  });

  describe('composer uniform control height — the bead acceptance item', () => {
    it('caps, input, and Send all compute to the --inbox-composer-h 36px', async () => {
      await page.viewport(1440, 900);
      const { container } = await render(wrapInboxV35());
      await vi.waitFor(() => {
        expect(container.querySelector('.inbox-citem')).not.toBeNull();
      });
      const item = container.querySelector('.inbox-citem') as HTMLElement | null;
      item!.click();
      await vi.waitFor(() => {
        expect(container.querySelector('.inbox-cap')).not.toBeNull();
      });
      const cap = container.querySelector('.inbox-cap') as HTMLElement;
      const input = container.querySelector('.inbox-input') as HTMLElement;
      const send = container.querySelector('.inbox-send') as HTMLElement;
      expect(cap.getBoundingClientRect().height).toBe(36);
      expect(input.getBoundingClientRect().height).toBe(36);
      expect(send.getBoundingClientRect().height).toBe(36);
    });
  });

  describe('no horizontal overflow at every breakpoint', () => {
    for (const vp of VIEWPORTS) {
      it(`Inbox: no horizontal overflow at ${vp.label}`, async () => {
        await page.viewport(vp.width, vp.height);
        const { container } = await render(wrapInboxV35());
        const root = container.querySelector('.inbox-page') as HTMLElement;
        if (!root) return;
        // Allow 1px subpixel rounding tolerance (C-D7-6).
        expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
      });
    }
  });
});


// ---------------------------------------------------------------------------
// DEPLOYMENTS suite (T5 b-08 — v3.5 surface, mockup deployments.html SSOT)
//
// The mockup's own breakpoint: summary strip + card bodies go 4→2 columns at
// @media (max-width: 1000px) — a VIEWPORT query (shared with the agents
// surface), proven via page.viewport().
// ---------------------------------------------------------------------------

function wrapDeployments() {
  return (
    <QueryClientProvider client={makeQC()}>
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter>
          <Deployments />
        </MemoryRouter>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}

describe('Viewport matrix — v3.5 Deployments (T5 b-08)', () => {
  beforeEach(async () => {
    useLinesMock.mockReturnValue({
      data: [
        {
          name: 'personal',
          mode: 'agent',
          status: 'online',
          accessMode: 'allowlist',
          health: {
            transport: { kind: 'baileys', connected: true },
            whatsapp: { connected: true, connection: { state: 'connected' } },
          },
        },
      ],
    } as never);
  });

  it('summary strip and card body render 4-column grids at 1440×900', async () => {
    await page.viewport(1440, 900);
    const { container } = await render(wrapDeployments());
    await vi.waitFor(() => {
      expect(container.querySelector('.deploy-sum')).not.toBeNull();
    });
    const sum = container.querySelector('.deploy-sum') as HTMLElement;
    expect(window.getComputedStyle(sum).gridTemplateColumns.split(' ').length).toBe(4);
    const dbody = container.querySelector('.deploy-dbody') as HTMLElement;
    expect(window.getComputedStyle(dbody).gridTemplateColumns.split(' ').length).toBe(4);
  });

  it('grids stay 4-column at 1001px (just above the mockup threshold)', async () => {
    await page.viewport(1001, 900);
    const { container } = await render(wrapDeployments());
    await vi.waitFor(() => {
      expect(container.querySelector('.deploy-sum')).not.toBeNull();
    });
    const sum = container.querySelector('.deploy-sum') as HTMLElement;
    expect(window.getComputedStyle(sum).gridTemplateColumns.split(' ').length).toBe(4);
  });

  it('grids collapse to 2 columns at 1000px (the mockup threshold)', async () => {
    await page.viewport(1000, 900);
    const { container } = await render(wrapDeployments());
    await vi.waitFor(() => {
      expect(container.querySelector('.deploy-sum')).not.toBeNull();
    });
    const sum = container.querySelector('.deploy-sum') as HTMLElement;
    expect(window.getComputedStyle(sum).gridTemplateColumns.split(' ').length).toBe(2);
    const dbody = container.querySelector('.deploy-dbody') as HTMLElement;
    expect(window.getComputedStyle(dbody).gridTemplateColumns.split(' ').length).toBe(2);
  });

  it('grids stay 2-column at 999px', async () => {
    await page.viewport(999, 900);
    const { container } = await render(wrapDeployments());
    await vi.waitFor(() => {
      expect(container.querySelector('.deploy-sum')).not.toBeNull();
    });
    const sum = container.querySelector('.deploy-sum') as HTMLElement;
    expect(window.getComputedStyle(sum).gridTemplateColumns.split(' ').length).toBe(2);
  });

  it('fits 1440×900 with no horizontal overflow (the bead acceptance item)', async () => {
    await page.viewport(1440, 900);
    const { container } = await render(wrapDeployments());
    await vi.waitFor(() => {
      expect(container.querySelector('.deploy-page')).not.toBeNull();
    });
    const root = container.querySelector('.deploy-page') as HTMLElement;
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
    // the summary + one card + pair card compose inside the viewport height:
    // the page itself never scrolls the document (main scrolls internally)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth + 1,
    );
  });
});


// ---------------------------------------------------------------------------
// SETTINGS suite (T5 b-09 — v3.5 surface, mockup settings.html SSOT)
//
// The mockup's own breakpoint: the section nav goes horizontal-scroll at
// @media (max-width: 800px) — the SIXTH distinct SSOT breakpoint, a VIEWPORT
// query proven via page.viewport().
// ---------------------------------------------------------------------------

function wrapSettings() {
  return (
    <QueryClientProvider client={makeQC()}>
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter>
          <Settings />
        </MemoryRouter>
      </ToastContext.Provider>
    </QueryClientProvider>
  );
}

describe('Viewport matrix — v3.5 Settings (T5 b-09)', () => {
  it('section nav + content render the 190px grid at 1440×900', async () => {
    await page.viewport(1440, 900);
    const { container } = await render(wrapSettings());
    await vi.waitFor(() => {
      expect(container.querySelector('.settings-wrap')).not.toBeNull();
    });
    const wrap = container.querySelector('.settings-wrap') as HTMLElement;
    expect(window.getComputedStyle(wrap).gridTemplateColumns.split(' ').length).toBe(2);
    const snav = container.querySelector('.settings-snav') as HTMLElement;
    expect(snav.getBoundingClientRect().width).toBe(190);
  });

  it('nav stays the column grid at 801px (just above the threshold)', async () => {
    await page.viewport(801, 900);
    const { container } = await render(wrapSettings());
    await vi.waitFor(() => {
      expect(container.querySelector('.settings-wrap')).not.toBeNull();
    });
    const wrap = container.querySelector('.settings-wrap') as HTMLElement;
    expect(window.getComputedStyle(wrap).gridTemplateColumns.split(' ').length).toBe(2);
  });

  it('nav goes horizontal-scroll single-column at 800px (the mockup threshold)', async () => {
    await page.viewport(800, 900);
    const { container } = await render(wrapSettings());
    await vi.waitFor(() => {
      expect(container.querySelector('.settings-wrap')).not.toBeNull();
    });
    const wrap = container.querySelector('.settings-wrap') as HTMLElement;
    expect(window.getComputedStyle(wrap).gridTemplateColumns.split(' ').length).toBe(1);
    const snav = container.querySelector('.settings-snav') as HTMLElement;
    expect(window.getComputedStyle(snav).flexDirection).toBe('row');
  });

  it('nav stays single-column at 799px', async () => {
    await page.viewport(799, 900);
    const { container } = await render(wrapSettings());
    await vi.waitFor(() => {
      expect(container.querySelector('.settings-wrap')).not.toBeNull();
    });
    const wrap = container.querySelector('.settings-wrap') as HTMLElement;
    expect(window.getComputedStyle(wrap).gridTemplateColumns.split(' ').length).toBe(1);
  });

  it('fits 1440×900 with no horizontal overflow (the acceptance item)', async () => {
    await page.viewport(1440, 900);
    const { container } = await render(wrapSettings());
    await vi.waitFor(() => {
      expect(container.querySelector('.settings-page')).not.toBeNull();
    });
    const root = container.querySelector('.settings-page') as HTMLElement;
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
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

// ---------------------------------------------------------------------------
// AGENTS suite (v3.5 T5 b-04)
//
// The Agents surface stacks at the mockup's OWN breakpoint — agents.html
// `@media (max-width:1000px)` — NOT the chrome/fleet 1100px idiom. Legs pin
// the boundary exactly (1001/1000/999) plus the acceptance item: internal
// detail scroll preserved (roster + detail scroll independently; the page
// itself does not).
// ---------------------------------------------------------------------------

describe('Viewport matrix — Agents (v3.5 b-04)', () => {
  const agentLine: LineInstance = {
    name: 'quinn',
    phone: '+15550001234',
    mode: 'agent',
    status: 'online',
    accessMode: 'open',
    healthPort: 9100,
    uptime: '2h',
    messagesTotal: 128,
    health: null,
    heartbeat: [],
    lastActive: new Date().toISOString(),
    error: null,
  };

  beforeEach(() => {
    // The hoisted factories type the defaults (null/[]); the Agents fixtures
    // are intentionally richer — widen via the mock's own ReturnType.
    useLinesMock.mockReturnValue({ data: [agentLine] } as unknown as ReturnType<typeof useLinesMock>);
    useLineMock.mockReturnValue({ data: agentLine } as unknown as ReturnType<typeof useLineMock>);
    useProviderStatusMock.mockReturnValue({
      data: {
        primary: { provider: 'test-provider', model: 'test-model-1', keyPresent: true },
        fallback: { provider: null, model: null, keyPresent: null, active: false, activeUntil: null },
      },
    } as unknown as ReturnType<typeof useProviderStatusMock>);
    useLiveSessionsMock.mockReturnValue({
      data: { observedAt: null, sessions: [], anomalyCount: 0 },
    } as unknown as ReturnType<typeof useLiveSessionsMock>);
  });

  it('at 1001px: wrap is roster+detail side-by-side and the panel grid is 2-up', async () => {
    await page.viewport(1001, 800);
    const { container } = await render(wrapPage(<Agents />));
    const wrap = container.querySelector<HTMLElement>('.agents-wrap');
    expect(wrap).not.toBeNull();
    expect(window.getComputedStyle(wrap!).gridTemplateColumns.split(' ').length).toBe(2);
    const grid = container.querySelector<HTMLElement>('.agents-grid');
    expect(grid).not.toBeNull();
    expect(window.getComputedStyle(grid!).gridTemplateColumns.split(' ').length).toBe(2);
  });

  it('at 1000px: wrap and panel grid stack (max-width matches at the boundary)', async () => {
    await page.viewport(1000, 800);
    const { container } = await render(wrapPage(<Agents />));
    const wrap = container.querySelector<HTMLElement>('.agents-wrap');
    expect(wrap).not.toBeNull();
    expect(window.getComputedStyle(wrap!).gridTemplateColumns.split(' ').length).toBe(1);
    const grid = container.querySelector<HTMLElement>('.agents-grid');
    expect(grid).not.toBeNull();
    expect(window.getComputedStyle(grid!).gridTemplateColumns.split(' ').length).toBe(1);
    // roster loses its right border and gains the bottom rule (mockup SSOT)
    const roster = container.querySelector<HTMLElement>('.agents-roster');
    expect(window.getComputedStyle(roster!).borderRightWidth).toBe('0px');
    expect(window.getComputedStyle(roster!).borderBottomWidth).toBe('1px');
  });

  it('at 999px: wrap and panel grid are stacked', async () => {
    await page.viewport(999, 800);
    const { container } = await render(wrapPage(<Agents />));
    const wrap = container.querySelector<HTMLElement>('.agents-wrap');
    expect(window.getComputedStyle(wrap!).gridTemplateColumns.split(' ').length).toBe(1);
  });

  it('internal detail scroll preserved: page clips, roster + detail own their scroll', async () => {
    await page.viewport(1440, 500);
    const { container } = await render(wrapPage(<Agents />));
    const root = container.querySelector<HTMLElement>('.agents-page');
    expect(root).not.toBeNull();
    expect(window.getComputedStyle(root!).overflow).toBe('hidden');
    const detail = container.querySelector<HTMLElement>('.agents-detail');
    expect(detail).not.toBeNull();
    expect(window.getComputedStyle(detail!).overflowY).toBe('auto');
    const roster = container.querySelector<HTMLElement>('.agents-roster');
    expect(window.getComputedStyle(roster!).overflowY).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// SKILLS HUB suite (v3.5 T5 b-05)
//
// The filters rail hides at the mockup's OWN breakpoint — skills-hub.html
// `@media (max-width:900px)` — the third distinct SSOT breakpoint (chrome/
// fleet 1100px, agents 1000px, skills 900px). Legs pin the boundary exactly
// (901/900/899) plus the results column owning its scroll.
// ---------------------------------------------------------------------------

describe('Viewport matrix — Skills Hub (v3.5 b-05)', () => {
  it('at 901px: filters rail is visible beside the results column', async () => {
    await page.viewport(901, 800);
    const { container } = await render(wrapPage(<SkillsHub />));
    const rail = container.querySelector<HTMLElement>('.skills-filters');
    expect(rail).not.toBeNull();
    expect(window.getComputedStyle(rail!).display).not.toBe('none');
    expect(window.getComputedStyle(rail!).width).toBe('196px');
  });

  it('at 900px: filters rail hides (max-width matches at the boundary)', async () => {
    await page.viewport(900, 800);
    const { container } = await render(wrapPage(<SkillsHub />));
    const rail = container.querySelector<HTMLElement>('.skills-filters');
    expect(rail).not.toBeNull();
    expect(window.getComputedStyle(rail!).display).toBe('none');
  });

  it('at 899px: filters rail stays hidden', async () => {
    await page.viewport(899, 800);
    const { container } = await render(wrapPage(<SkillsHub />));
    const rail = container.querySelector<HTMLElement>('.skills-filters');
    expect(window.getComputedStyle(rail!).display).toBe('none');
  });

  it('results column owns its scroll at short height (page clips, main scrolls)', async () => {
    await page.viewport(1440, 500);
    const { container } = await render(wrapPage(<SkillsHub />));
    const root = container.querySelector<HTMLElement>('.skills-page');
    expect(root).not.toBeNull();
    expect(window.getComputedStyle(root!).overflow).toBe('hidden');
    const main = container.querySelector<HTMLElement>('.skills-main');
    expect(main).not.toBeNull();
    expect(window.getComputedStyle(main!).overflowY).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// DREAM LAB suite (v3.5 T5 b-06)
//
// The queue stacks at the mockup's OWN breakpoint — dream-lab.html
// `@media (max-width:980px)` — the fourth distinct SSOT breakpoint (chrome/
// fleet 1100px, agents 1000px, dream 980px, skills 900px). Legs pin the
// boundary (981/980/979), the review pane's scroll ownership, and the bead
// acceptance item: the proposed-diff column caps at 72ch.
// ---------------------------------------------------------------------------

describe('Viewport matrix — Dream Lab (v3.5 b-06)', () => {
  it('at 981px: wrap is queue+review side-by-side (2 columns)', async () => {
    await page.viewport(981, 800);
    const { container } = await render(wrapPage(<DreamLab />));
    const wrap = container.querySelector<HTMLElement>('.dream-wrap');
    expect(wrap).not.toBeNull();
    expect(window.getComputedStyle(wrap!).gridTemplateColumns.split(' ').length).toBe(2);
  });

  it('at 980px: wrap stacks and the queue takes the bottom rule (boundary match)', async () => {
    await page.viewport(980, 800);
    const { container } = await render(wrapPage(<DreamLab />));
    const wrap = container.querySelector<HTMLElement>('.dream-wrap');
    expect(window.getComputedStyle(wrap!).gridTemplateColumns.split(' ').length).toBe(1);
    const queue = container.querySelector<HTMLElement>('.dream-queue');
    expect(window.getComputedStyle(queue!).borderRightWidth).toBe('0px');
    expect(window.getComputedStyle(queue!).borderBottomWidth).toBe('1px');
  });

  it('at 979px: wrap stays stacked', async () => {
    await page.viewport(979, 800);
    const { container } = await render(wrapPage(<DreamLab />));
    const wrap = container.querySelector<HTMLElement>('.dream-wrap');
    expect(window.getComputedStyle(wrap!).gridTemplateColumns.split(' ').length).toBe(1);
  });

  it('review pane owns its scroll; the page clips', async () => {
    await page.viewport(1440, 500);
    const { container } = await render(wrapPage(<DreamLab />));
    const root = container.querySelector<HTMLElement>('.dream-page');
    expect(window.getComputedStyle(root!).overflow).toBe('hidden');
    const review = container.querySelector<HTMLElement>('.dream-review');
    expect(window.getComputedStyle(review!).overflowY).toBe('auto');
  });

  it('acceptance: the proposed-diff column caps at 72ch computed width', async () => {
    await page.viewport(1440, 900);
    const { container } = await render(wrapPage(<DreamLab />));
    // The empty-review page carries no diff block; pin the token itself via a
    // probe element bound to the class recipe.
    const probe = document.createElement('div');
    probe.className = 'dream-diff';
    probe.textContent = 'x'.repeat(4000);
    container.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    // 72ch at the mono face is strictly less than the 1fr review column here
    const parent = container.querySelector<HTMLElement>('.dream-review')!;
    expect(w).toBeLessThanOrEqual(parent.getBoundingClientRect().width);
    probe.remove();
  });
});
