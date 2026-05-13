/**
 * Nav component — routing / active-state / accessibility coverage.
 *
 * This file is COMPLEMENTARY to nav-status.test.tsx which already covers:
 *   - Navigation link rendering (text labels)
 *   - WS connection indicator (Live / Polling)
 *   - Alert count display (0 / 1 / n)
 *   - Unread badge numeric display and 99+ cap
 *   - Version string display / "unknown" suppression
 *   - Update button rendering and onUpdateClick callback
 *
 * This file covers the GAPS:
 *   - Active-route detection: isFleetActive for "/" and "/lines/*"
 *   - Active underline indicator rendered only for active link
 *   - NavLink href attributes point to correct routes
 *   - aria-current="page" applied for Soup Kitchen, Inbox, and Ops active state
 *   - Update button aria-label and title attributes
 *   - Unread badge structural isolation (only inside Inbox link)
 *   - Soup Kitchen active when navigating to /lines/* sub-path
 *
 * Source behaviour (post F-052 fix):
 *   - Soup Kitchen link uses useLocation + custom isFleetActive (not NavLink isActive),
 *     so the className and children render functions both ignore the isActive argument.
 *   - aria-current="page" is explicitly set on the Soup Kitchen NavLink via
 *     aria-current={isFleetActive ? 'page' : undefined}, overriding react-router-dom's
 *     default (which only fires at exact "/"). This ensures screen readers get the nav
 *     signal at /lines/* paths too, matching the visual active treatment.
 *   - The active underline is a sibling <span> inside the NavLink child render fn,
 *     not a CSS ::after pseudo-element — testable via DOM queries.
 *   - /lines/* paths activate Soup Kitchen but NOT via NavLink's "end" matching;
 *     the "end" prop only affects the "/" exact match; isFleetActive handles /lines/*.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createElement } from 'react';

// ---- mock use-websocket before Nav import ----
let wsConnected = false;
vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: wsConnected }),
}));

import Nav from '../../console/src/components/Nav';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderNav(
  props: Record<string, unknown> = {},
  initialPath = '/',
) {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      createElement(Nav, { onUpdateClick: vi.fn(), ...props } as any),
    ),
  );
}

beforeEach(() => {
  wsConnected = false;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// NavLink href attributes
// ---------------------------------------------------------------------------

describe('Nav — href routing targets', () => {
  it('Soup Kitchen link points to "/"', () => {
    renderNav();
    const link = screen.getByText('Soup Kitchen').closest('a');
    expect(link?.getAttribute('href')).toBe('/');
  });

  it('Inbox link points to "/inbox"', () => {
    renderNav();
    const link = screen.getByText('Inbox').closest('a');
    expect(link?.getAttribute('href')).toBe('/inbox');
  });

  it('Ops link points to "/ops"', () => {
    renderNav();
    const link = screen.getByText('Ops').closest('a');
    expect(link?.getAttribute('href')).toBe('/ops');
  });
});

// ---------------------------------------------------------------------------
// Active-route detection for Soup Kitchen (isFleetActive)
// ---------------------------------------------------------------------------

describe('Nav — Soup Kitchen active-route detection', () => {
  it('Soup Kitchen has active bg class when path is "/"', () => {
    renderNav({}, '/');
    const link = screen.getByText('Soup Kitchen').closest('a');
    expect(link?.className).toContain('bg-d4');
    expect(link?.className).toContain('text-t1');
  });

  it('Soup Kitchen does NOT have active bg class when path is "/inbox"', () => {
    renderNav({}, '/inbox');
    const link = screen.getByText('Soup Kitchen').closest('a');
    expect(link?.className).not.toContain('bg-d4');
    expect(link?.className).toContain('text-t4');
  });

  it('Soup Kitchen has active bg class when path is "/lines/abc123"', () => {
    renderNav({}, '/lines/abc123');
    const link = screen.getByText('Soup Kitchen').closest('a');
    expect(link?.className).toContain('bg-d4');
    expect(link?.className).toContain('text-t1');
  });

  it('Soup Kitchen does NOT have active bg class when path is "/ops"', () => {
    renderNav({}, '/ops');
    const link = screen.getByText('Soup Kitchen').closest('a');
    expect(link?.className).not.toContain('bg-d4');
  });
});

// ---------------------------------------------------------------------------
// Active underline indicator span
// ---------------------------------------------------------------------------

describe('Nav — active underline indicator', () => {
  it('Soup Kitchen underline span is present when path is "/"', () => {
    renderNav({}, '/');
    const link = screen.getByText('Soup Kitchen').closest('a');
    // The underline span has inline bottom:-1px style and bg-s-ok class
    const underline = link?.querySelector('span[style*="bottom"]');
    expect(underline?.className).toContain('bg-s-ok');
  });

  it('Soup Kitchen underline span is absent when path is "/inbox"', () => {
    renderNav({}, '/inbox');
    const link = screen.getByText('Soup Kitchen').closest('a');
    // No underline: link itself carries the inactive text class instead of active bg
    expect(link?.className).toContain('text-t4');
    expect(link?.querySelector('span[style*="bottom"]')).toBeNull();
  });

  it('Inbox underline span is present when path is "/inbox"', () => {
    renderNav({}, '/inbox');
    const link = screen.getByText('Inbox').closest('a');
    const underline = link?.querySelector('span[style*="bottom"]');
    expect(underline?.className).toContain('bg-s-ok');
  });

  it('Inbox underline span is absent when path is "/"', () => {
    renderNav({}, '/');
    const link = screen.getByText('Inbox').closest('a');
    // No underline: link carries inactive styling
    expect(link?.className).toContain('text-t4');
    expect(link?.querySelector('span[style*="bottom"]')).toBeNull();
  });

  it('Ops underline span is present when path is "/ops"', () => {
    renderNav({}, '/ops');
    const link = screen.getByText('Ops').closest('a');
    const underline = link?.querySelector('span[style*="bottom"]');
    expect(underline?.className).toContain('bg-s-ok');
  });

  it('Ops underline span is absent when path is "/"', () => {
    renderNav({}, '/');
    const link = screen.getByText('Ops').closest('a');
    // No underline: link carries inactive styling
    expect(link?.className).toContain('text-t4');
    expect(link?.querySelector('span[style*="bottom"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Soup Kitchen aria-current — F-052 fix: present at "/" AND at "/lines/*"
// ---------------------------------------------------------------------------

describe('Nav — Soup Kitchen aria-current (F-052)', () => {
  it('Soup Kitchen has aria-current="page" at "/" (isFleetActive true)', () => {
    renderNav({}, '/');
    const link = screen.getByText('Soup Kitchen').closest('a');
    expect(link?.getAttribute('aria-current')).toBe('page');
  });

  it('Soup Kitchen has aria-current="page" at "/lines/abc" (isFleetActive true, F-052 fix)', () => {
    // Previously a11y gap: isFleetActive drove visual state but no aria-current was set.
    // Fixed by aria-current={isFleetActive ? 'page' : undefined} on the NavLink.
    renderNav({}, '/lines/abc');
    const link = screen.getByText('Soup Kitchen').closest('a');
    expect(link?.getAttribute('aria-current')).toBe('page');
  });

  it('Soup Kitchen does NOT have aria-current when path is "/inbox"', () => {
    renderNav({}, '/inbox');
    const link = screen.getByText('Soup Kitchen').closest('a');
    expect(link?.getAttribute('aria-current')).toBeNull();
  });

  it('Soup Kitchen does NOT have aria-current when path is "/ops"', () => {
    renderNav({}, '/ops');
    const link = screen.getByText('Soup Kitchen').closest('a');
    expect(link?.getAttribute('aria-current')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inbox / Ops active state via react-router-dom aria-current
// ---------------------------------------------------------------------------

describe('Nav — aria-current for Inbox and Ops', () => {
  it('Inbox link has aria-current="page" when path is "/inbox"', () => {
    renderNav({}, '/inbox');
    const link = screen.getByText('Inbox').closest('a');
    expect(link?.getAttribute('aria-current')).toBe('page');
  });

  it('Inbox link does NOT have aria-current when path is "/"', () => {
    renderNav({}, '/');
    const link = screen.getByText('Inbox').closest('a');
    expect(link?.getAttribute('aria-current')).toBeNull();
  });

  it('Ops link has aria-current="page" when path is "/ops"', () => {
    renderNav({}, '/ops');
    const link = screen.getByText('Ops').closest('a');
    expect(link?.getAttribute('aria-current')).toBe('page');
  });

  it('Ops link does NOT have aria-current when path is "/inbox"', () => {
    renderNav({}, '/inbox');
    const link = screen.getByText('Ops').closest('a');
    expect(link?.getAttribute('aria-current')).toBeNull();
  });

  it('Inbox has active bg class when path is "/inbox"', () => {
    renderNav({}, '/inbox');
    const link = screen.getByText('Inbox').closest('a');
    expect(link?.className).toContain('bg-d4');
    expect(link?.className).toContain('text-t1');
  });

  it('Ops has active bg class when path is "/ops"', () => {
    renderNav({}, '/ops');
    const link = screen.getByText('Ops').closest('a');
    expect(link?.className).toContain('bg-d4');
    expect(link?.className).toContain('text-t1');
  });
});

// ---------------------------------------------------------------------------
// Unread badge structural isolation
// ---------------------------------------------------------------------------

describe('Nav — unread badge isolation', () => {
  it('unread badge is inside the Inbox link, not the Soup Kitchen link', () => {
    renderNav({ unreadCount: 7 }, '/');
    const inboxLink = screen.getByText('Inbox').closest('a')!;
    const soupLink = screen.getByText('Soup Kitchen').closest('a')!;
    // Badge text should be inside Inbox anchor
    expect(within(inboxLink).getByText('7')).toBeDefined();
    // And NOT inside Soup Kitchen anchor
    expect(within(soupLink).queryByText('7')).toBeNull();
  });

  it('unread badge is absent from Ops link', () => {
    renderNav({ unreadCount: 3 }, '/');
    const opsLink = screen.getByText('Ops').closest('a')!;
    expect(within(opsLink).queryByText('3')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Update button aria-label and title
// ---------------------------------------------------------------------------

describe('Nav — update button attributes', () => {
  it('update button has aria-label describing the version transition', () => {
    renderNav({ version: 'abc1234', updateAvailable: true, remoteSha: 'def5678' });
    const btn = screen.getByRole('button');
    const label = btn.getAttribute('aria-label') ?? '';
    expect(label).toContain('abc1234');
    expect(label).toContain('def5678');
  });

  it('update button has title describing the version transition', () => {
    renderNav({ version: 'abc1234', updateAvailable: true, remoteSha: 'def5678' });
    const btn = screen.getByRole('button');
    const title = btn.getAttribute('title') ?? '';
    expect(title).toContain('abc1234');
    expect(title).toContain('def5678');
  });

  it('update button has type="button" to avoid accidental form submit', () => {
    renderNav({ version: 'abc1234', updateAvailable: true, remoteSha: 'def5678' });
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('type')).toBe('button');
  });
});

// ---------------------------------------------------------------------------
// /lines/* sub-path activates Soup Kitchen underline
// ---------------------------------------------------------------------------

describe('Nav — /lines/* sub-path routing', () => {
  it('Soup Kitchen underline present for /lines/line-001', () => {
    renderNav({}, '/lines/line-001');
    const link = screen.getByText('Soup Kitchen').closest('a');
    const underline = link?.querySelector('span[style*="bottom"]');
    expect(underline).not.toBeNull();
  });

  it('Inbox underline absent for /lines/line-001', () => {
    renderNav({}, '/lines/line-001');
    const link = screen.getByText('Inbox').closest('a');
    // Inbox is inactive on a /lines/* path: carries text-t4, no underline span
    expect(link?.className).toContain('text-t4');
    expect(link?.querySelector('span[style*="bottom"]')).toBeNull();
  });

  it('Ops underline absent for /lines/line-001', () => {
    renderNav({}, '/lines/line-001');
    const link = screen.getByText('Ops').closest('a');
    // Ops is inactive on a /lines/* path: carries text-t4, no underline span
    expect(link?.className).toContain('text-t4');
    expect(link?.querySelector('span[style*="bottom"]')).toBeNull();
  });
});
