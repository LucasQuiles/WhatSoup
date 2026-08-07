/**
 * DD-20: MotionConfig reducedMotion="user" at app root.
 *
 * What this test proves
 * ---------------------
 * The app's return tree wraps all motion consumers in a MotionConfig that
 * sets reducedMotion="user". This means framer-motion reads the OS
 * prefers-reduced-motion setting at runtime rather than hard-coding motion on.
 *
 * Approach — structural context probe inside App's tree
 * -----------------------------------------------------
 * jsdom does not implement CSSOM so we cannot directly observe whether a
 * motion.div suppresses its animation. Instead we read framer-motion's
 * MotionConfigContext from inside the rendered tree via a probe component
 * injected into the SoupKitchen stub that App renders on "/".
 *
 * The default MotionConfigContext value (no MotionConfig ancestor) has
 * reducedMotion: "never". After our fix the value must be "user".
 *
 * What it does NOT prove
 * ----------------------
 * It does not prove that a specific motion.div actually suppresses its spring
 * when the OS reports prefers-reduced-motion. That behavioural verification
 * requires a full browser / Playwright environment where CSSOM is available.
 * See DD-10 for the D7 Playwright gate that will cover computed-property checks.
 *
 * Behavioural attempt (documented as infeasible in jsdom)
 * -------------------------------------------------------
 * We attempted to stub matchMedia so `window.matchMedia('(prefers-reduced-motion: reduce)').matches`
 * returns true and then assert that a motion.div animate target is not applied.
 * jsdom's animation model is absent; framer-motion uses requestAnimationFrame
 * internally which does not fire in jsdom, so animate state never advances.
 * The structural context probe below is the correct jsdom-level assertion.
 *
 * Probe placement
 * ---------------
 * MotionConfig lives inside App's return tree (outermost wrapper). The probe
 * is rendered by the SoupKitchen stub so it is a child of App's tree and
 * therefore a descendant of the MotionConfig boundary. This avoids any change
 * to App's public API.
 *
 * matchMedia stub
 * ---------------
 * framer-motion probes window.matchMedia to evaluate prefers-reduced-motion.
 * jsdom has no matchMedia; we stub it in beforeEach (same pattern as
 * tests/console/line-detail-tabs.test.tsx). Two variants are exercised:
 *   - matches:false  (user has NOT requested reduced motion)
 *   - matches:true   (user HAS requested reduced motion)
 * Both must see reducedMotion:"user" in the context — the config is the same;
 * framer-motion's internal hook resolves the actual bool at animation time.
 *
 * @vitest-environment jsdom
 */
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import {
  render, screen, act, cleanup,
} from '@testing-library/react';
import { createElement, useContext, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfigContext } from 'framer-motion';

// ---------------------------------------------------------------------------
// Probe component — reads MotionConfigContext from inside App's tree.
// Rendered by the SoupKitchen stub so it is a descendant of MotionConfig.
// ---------------------------------------------------------------------------

let capturedReducedMotion: string | undefined;

function MotionConfigProbe() {
  const config = useContext(MotionConfigContext);
  capturedReducedMotion = config.reducedMotion as string | undefined;
  return createElement('div', { 'data-testid': 'motion-probe' });
}

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any dynamic import.
// SoupKitchen stub renders the probe so it sits inside App's tree, which is
// inside the MotionConfig boundary placed at App's outermost return element.
// ---------------------------------------------------------------------------

vi.mock('../../console/src/pages/SoupKitchen', () => ({
  default: () => createElement(
    'div',
    { 'data-testid': 'page-soup-kitchen' },
    'SoupKitchen',
    createElement(MotionConfigProbe),
  ),
}));

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: () => ({ data: undefined }),
}));

vi.mock('../../console/src/hooks/use-update-check', () => ({
  useUpdateCheck: () => ({
    data: undefined,
    showUpdateModal: false,
    openUpdateModal: vi.fn(),
    closeUpdateModal: vi.fn(),
  }),
  getStaticVersion: () => 'test-sha',
}));

vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: false }),
  RealtimeProvider: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('../../console/src/pages/LineDetail', () => ({
  default: () => createElement('div', { 'data-testid': 'page-line-detail' }, 'LineDetail'),
}));
vi.mock('../../console/src/pages/Inbox', () => ({
  default: () => createElement('div', { 'data-testid': 'page-inbox' }, 'Inbox'),
}));
vi.mock('../../console/src/pages/Operator', () => ({
  default: () => createElement('div', { 'data-testid': 'page-ops' }, 'Ops'),
}));
vi.mock('../../console/src/components/UpdateModal', () => ({
  default: () => null,
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import App from '../../console/src/App';
import { ToastProvider } from '../../console/src/hooks/use-toast';

// ---------------------------------------------------------------------------
// matchMedia stub — framer-motion probes this in jsdom
// ---------------------------------------------------------------------------

function stubMatchMedia(prefersReducedMotion: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: prefersReducedMotion && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

// ---------------------------------------------------------------------------
// Render helper — mirrors the provider shell from main.tsx
// ---------------------------------------------------------------------------

function renderApp(initialPath = '/') {
  capturedReducedMotion = undefined;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });

  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [initialPath] },
        createElement(
          ToastProvider,
          null,
          createElement(App),
        ),
      ),
    ),
  );
}

beforeEach(() => {
  capturedReducedMotion = undefined;
  stubMatchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DD-20 — MotionConfig reducedMotion="user" at app root', () => {
  it('MotionConfigContext has reducedMotion="user" when OS does not request reduced motion', async () => {
    stubMatchMedia(false);
    await act(async () => { renderApp('/'); });
    // Probe rendered by SoupKitchen stub — inside App's MotionConfig boundary
    expect(screen.getByTestId('motion-probe')).toBeDefined();
    expect(capturedReducedMotion).toBe('user');
  });

  it('MotionConfigContext has reducedMotion="user" when OS requests reduced motion', async () => {
    stubMatchMedia(true);
    await act(async () => { renderApp('/'); });
    expect(screen.getByTestId('motion-probe')).toBeDefined();
    expect(capturedReducedMotion).toBe('user');
  });

  it('MotionConfigContext reducedMotion is not "never" (the hard-coded-motion default)', async () => {
    await act(async () => { renderApp('/'); });
    // "never" is the framer-motion default when no MotionConfig is present.
    // If this assertion fails, the MotionConfig wrapper is missing or misconfigured.
    expect(capturedReducedMotion).not.toBe('never');
    expect(capturedReducedMotion).not.toBeUndefined();
  });
});
