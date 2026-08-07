/**
 * @file tests/browser/keyboard-proofs.test.tsx
 *
 * Deferred keyboard proofs — trusted-event behaviors that jsdom cannot verify.
 *
 * DEFERRAL PROVENANCE
 * ====================
 * B2 trusted-event deferrals (b2-evidence.md):
 *   "real-browser trusted-event keyboard proof for the pickers is INCONCLUSIVE
 *   under this harness and formally DEFERRED TO D7 (playwright trusted events
 *   with deterministic focus — d7-investigation.md is staged and GO)"
 *
 * C-B3W3-7 (b3-wave3-investigation.md §7.2):
 *   Focus-trap boundary edge with roving-tabindex tabs while the body is the
 *   loading EmptyState. One forward-Tab stop can escape the portal; the very
 *   next Tab press is recaptured by the `!container.contains(activeElement)`
 *   branch. "Transient (loading-only), self-healing, jsdom cannot exercise
 *   native traversal — recorded as a known edge owned by the D7 trusted-keyboard
 *   lane."
 *
 *   D7 FINDING (C-B3W3-7 VERDICT): The self-healing claim did NOT hold in real
 *   Chromium with Playwright CDP-driven Tab. Root cause was the trap's focusable
 *   set: the selector matched roving-tabindex buttons through the generic
 *   `button:not([disabled])` arm even when they had tabIndex=-1, so the trap's
 *   boundary and the browser's native Tab order disagreed.
 *
 *   DD-27 RESOLUTION: use-dismissable filters focusable candidates to native
 *   Tab stops (`tabIndex >= 0`). The test below now proves the loading-edge modal
 *   keeps repeated trusted Tab presses inside the dialog.
 *
 * WHY THESE PROOFS REQUIRE THE BROWSER RUNNER
 * =============================================
 * jsdom's userEvent.keyboard() synthesises events with isTrusted: false.
 * The CSS :focus-visible selector depends on the browser's "focus source
 * heuristic" — it applies only when focus arrived via a trusted keyboard
 * event. jsdom also does not run a CSS cascade, so getComputedStyle returns
 * zeros for all geometry.
 *
 * In the playwright chromium runner:
 *   • userEvent.keyboard('{ArrowDown}') drives a real OS keydown via CDP;
 *     isTrusted: true; the browser's React synthetic event fires correctly.
 *   • userEvent.tab() drives a real OS Tab via CDP; the browser's native
 *     Tab traversal runs, and native Tab actually traverses the tabIndex
 *     order the real DOM specifies.
 *
 * SUITES
 * =======
 * 1. ChatPicker ArrowDown — opens panel and activates first option.
 *    Exonerates the "ArrowDown closes the composer" false P1.
 *    (b2-evidence.md §Live-QA disposition)
 *
 * 2. ChatPicker Enter — selects the active option.
 *    Proves the jsdom-pinned "Down + Enter selects the first result" contract
 *    holds with trusted events.
 *    (b2-evidence.md §Live-QA disposition)
 *
 * 3. Toolbar roving tabindex — trusted Arrow/Home/End focus movement, search
 *    text-editing key preservation, and native Tab/Shift+Tab exit behavior.
 *
 * 4. C-B3W3-7: Modal + loading-body edge — repeated trusted Tab presses stay
 *    inside the dialog after DD-27 aligned the trap boundary with native Tab order.
 *    (b3-wave3-investigation §7.2 — "self-healing" disposition REVISED by D7,
 *    then closed by the tabIndex filter in use-dismissable)
 *
 * DEBT REGISTER NOTE (C-B3W3-7)
 * ==============================
 * The `!container.contains(document.activeElement)` recapture branch in
 * use-dismissable.ts handleTab cannot be the primary browser-Tab defense:
 * Chromium's native Tab traversal runs after keydown and can override a
 * programmatic focus() call. DD-27 closes the real edge earlier by excluding
 * tabIndex=-1 candidates from the trap's focusable set, so the trap boundary
 * matches native Tab traversal before focus can leave the dialog.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../console/src/index.css';

// ---------------------------------------------------------------------------
// Stubs — ChatPicker renders inside Popover which uses useDismissable.
// lib/api is stubbed to prevent the sentinel from firing on searchContacts.
// ---------------------------------------------------------------------------

vi.mock('../../console/src/lib/api', () => ({
  api: {
    searchContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
    restart: vi.fn(() => Promise.resolve()),
    deleteLine: vi.fn(() => Promise.resolve()),
  },
}));

// ---------------------------------------------------------------------------
// Component imports (AFTER mocks)
// ---------------------------------------------------------------------------

import { ChatPicker } from '../../console/src/components/shared/ChatPicker.tsx';
import {
  Modal,
  ModalBody,
  ActionButton,
  Tabs,
  Tab,
  Toolbar,
  ToolbarFilters,
  ToolbarTimeRange,
  ToolbarSearch,
  ToolbarSpring,
} from '../../console/src/components/primitives/index.ts';
import type { ChatItem } from '../../console/src/types.ts';

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeChat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    conversationKey: overrides.conversationKey ?? 'conv-1',
    name: overrides.name ?? 'Alice',
    lastMessagePreview: '',
    lastMessageAt: new Date().toISOString(),
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  };
}

const THREE_CHATS: ChatItem[] = [
  makeChat({ conversationKey: 'conv-alice', name: 'Alice' }),
  makeChat({ conversationKey: 'conv-bob', name: 'Bob' }),
  makeChat({ conversationKey: 'conv-carol', name: 'Carol' }),
];

// ---------------------------------------------------------------------------
// B2 DEFERRED PROOF: ChatPicker ArrowDown keyboard
//
// WHAT THIS PROVES
// -----------------
// Down key with focus on the ChatPicker's SearchInput:
//   (a) opens the Popover panel (aria-expanded → true and Popover rendered)
//   (b) sets the first option as active (aria-activedescendant updates)
//   (c) does NOT close the surrounding container (the false-P1 exoneration)
//
// ChatPicker behaviour notes:
//   • onFocus fires on the SearchInput and sets open=true — so after a click,
//     aria-expanded is already true (panel opens on focus).
//   • ArrowDown calls usePopoverKeyboard.handleKeyDown which, when panel is
//     already open, moves the active option to the first result.
//   • The test therefore: (1) verifies panel opens on focus, (2) verifies
//     ArrowDown activates the first option, (3) confirms the wrapper is intact.
//
// CONTRAST WITH JSDOM
// --------------------
// The jsdom suite pins "Down + Enter selects the first result" via
// @testing-library/user-event (isTrusted: false events). This test uses
// real CDP-driven keydown (isTrusted: true) to confirm the contract holds
// under realistic browser conditions — the actual "false-P1" scenario.
// ---------------------------------------------------------------------------

describe('B2 deferred: ChatPicker ArrowDown — panel + active option (trusted events)', () => {
  it('clicking the SearchInput opens the panel (aria-expanded = true)', async () => {
    const onSelect = vi.fn();
    const { getByRole } = await render(
      <ChatPicker
        chats={THREE_CHATS}
        selected={null}
        onSelect={onSelect}
        onClear={vi.fn()}
        placeholder="Search chats"
      />,
    );

    // ChatPicker renders a SearchInput with role="combobox" when no item is selected.
    const combobox = getByRole('combobox');
    // Click to give focus — triggers onFocus → setOpen(true).
    await userEvent.click(combobox);

    // Panel is now open: aria-expanded must be 'true'.
    expect(combobox.element().getAttribute('aria-expanded')).toBe('true');
  });

  it('ArrowDown with open panel sets aria-activedescendant to first option', async () => {
    const onSelect = vi.fn();
    const { getByRole } = await render(
      <ChatPicker
        chats={THREE_CHATS}
        selected={null}
        onSelect={onSelect}
        onClear={vi.fn()}
        placeholder="Search chats"
      />,
    );

    const combobox = getByRole('combobox');
    // Focus to open the panel.
    await userEvent.click(combobox);
    // Panel is open. ArrowDown moves active option to first result.
    await userEvent.keyboard('{ArrowDown}');

    // aria-activedescendant must be set when an option is active.
    const activeDesc = combobox.element().getAttribute('aria-activedescendant');
    expect(activeDesc).not.toBeNull();
    // The referenced element must exist in the DOM.
    const activatedOption = document.getElementById(activeDesc!);
    expect(activatedOption).not.toBeNull();
    // The first option should reference Alice (first in THREE_CHATS).
    expect(activatedOption!.textContent).toContain('Alice');
  });

  it('ArrowDown does NOT unmount the surrounding wrapper (false-P1 exoneration)', async () => {
    // The false-P1 report: "ArrowDown closes the composer".
    // Exoneration: with real focus on the input, ArrowDown sets active option —
    // the dialog/wrapper stays mounted. (b2-evidence.md §Live-QA)
    const { getByRole, container } = await render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <div data-testid="outer-wrapper">
            <ChatPicker
              chats={THREE_CHATS}
              selected={null}
              onSelect={vi.fn()}
              onClear={vi.fn()}
              placeholder="Search chats"
            />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const combobox = getByRole('combobox');
    await userEvent.click(combobox);
    await userEvent.keyboard('{ArrowDown}');

    // Outer wrapper is still in the DOM.
    const outer = container.querySelector('[data-testid="outer-wrapper"]');
    expect(outer).not.toBeNull();
    // Combobox is still connected.
    expect(combobox.element().isConnected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B2 DEFERRED PROOF: ChatPicker Enter selects the active option
//
// WHAT THIS PROVES
// -----------------
// Click (open) → ArrowDown (activate first option) → Enter:
//   (a) calls onSelect with the first chat object
//   (b) the select sequence works with trusted events
//
// The jsdom suite pins "Down + Enter selects the first result" using
// @testing-library/user-event (isTrusted: false). This test proves the
// same contract holds with real trusted events.
// ---------------------------------------------------------------------------

describe('B2 deferred: ChatPicker Enter selects active option (trusted events)', () => {
  it('click + ArrowDown + Enter calls onSelect with the first option', async () => {
    const onSelect = vi.fn();
    const { getByRole } = await render(
      <ChatPicker
        chats={THREE_CHATS}
        selected={null}
        onSelect={onSelect}
        onClear={vi.fn()}
        placeholder="Search chats"
      />,
    );

    const combobox = getByRole('combobox');
    await userEvent.click(combobox);
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledTimes(1);
    // Called with Alice's ChatItem (first in THREE_CHATS).
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: 'conv-alice' }),
    );
  });

  it('ArrowDown twice + Enter selects the second option (not always first)', async () => {
    const onSelect = vi.fn();
    const { getByRole } = await render(
      <ChatPicker
        chats={THREE_CHATS}
        selected={null}
        onSelect={onSelect}
        onClear={vi.fn()}
        placeholder="Search chats"
      />,
    );

    const combobox = getByRole('combobox');
    await userEvent.click(combobox);
    // First Down: activate Alice.
    await userEvent.keyboard('{ArrowDown}');
    // Second Down: move to Bob.
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: 'conv-bob' }),
    );
  });

  it('Escape with panel open does not call onSelect (panel closes, no selection)', async () => {
    const onSelect = vi.fn();
    const { getByRole } = await render(
      <ChatPicker
        chats={THREE_CHATS}
        selected={null}
        onSelect={onSelect}
        onClear={vi.fn()}
        placeholder="Search chats"
      />,
    );

    const combobox = getByRole('combobox');
    await userEvent.click(combobox);
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Escape}');

    // Escape closes the panel; onSelect must NOT have been called.
    expect(onSelect).toHaveBeenCalledTimes(0);
    // Panel is closed.
    expect(combobox.element().getAttribute('aria-expanded')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// TOOLBAR: trusted-event roving tabindex proof
// ---------------------------------------------------------------------------

const TOOLBAR_TIME_OPTIONS = [
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
];

function ToolbarTrustedKeyboardFixture() {
  return (
    <>
      <button type="button" id="before-toolbar">Before toolbar</button>
      <Toolbar aria-label="Fleet toolbar">
        <ToolbarFilters label="Mode filter">
          <button type="button">All</button>
        </ToolbarFilters>
        <ToolbarTimeRange
          label="Time range"
          options={TOOLBAR_TIME_OPTIONS}
          value="24h"
          onChange={() => undefined}
        />
        <ToolbarSpring />
        <ToolbarSearch label="Search lines" value="alpha" onChange={() => undefined} />
        <button type="button" disabled>Disabled action</button>
        <span tabIndex={-1}>programmatic sentinel</span>
        <button type="button">Add line</button>
      </Toolbar>
      <button type="button" id="after-toolbar">After toolbar</button>
    </>
  );
}

function toolbarItems(toolbar: HTMLElement): HTMLElement[] {
  return Array.from(
    toolbar.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => {
    if (el.closest('[aria-hidden="true"]')) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    return true;
  });
}

function expectSingleToolbarTabStop(items: HTMLElement[], activeIndex: number) {
  expect(items.length).toBe(6);
  items.forEach((item, index) => {
    expect(item.tabIndex).toBe(index === activeIndex ? 0 : -1);
  });
}

describe('Toolbar roving tabindex — trusted browser keyboard events', () => {
  it('Arrow/Home/End move focus through full toolbar anatomy and keep one tab stop', async () => {
    await render(<ToolbarTrustedKeyboardFixture />);

    const toolbar = document.querySelector('[role="toolbar"]') as HTMLElement | null;
    expect(toolbar).not.toBeNull();
    expect(toolbar!.getAttribute('aria-label')).toBe('Fleet toolbar');

    const items = toolbarItems(toolbar!);
    expect(items.map((item) => item.textContent || item.getAttribute('aria-label'))).toEqual([
      'All',
      '24h',
      '7d',
      '30d',
      'Search lines',
      'Add line',
    ]);

    items[0].focus();
    expect(document.activeElement).toBe(items[0]);
    expectSingleToolbarTabStop(items, 0);

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(items[1]);
    expectSingleToolbarTabStop(items, 1);

    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(items[5]);
    expectSingleToolbarTabStop(items, 5);

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(items[0]);
    expectSingleToolbarTabStop(items, 0);

    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(items[5]);
    expectSingleToolbarTabStop(items, 5);

    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(items[0]);
    expectSingleToolbarTabStop(items, 0);
  });

  it('ToolbarSearch keeps trusted editing navigation keys inside the input', async () => {
    await render(<ToolbarTrustedKeyboardFixture />);

    const toolbar = document.querySelector('[role="toolbar"]') as HTMLElement | null;
    expect(toolbar).not.toBeNull();
    const items = toolbarItems(toolbar!);
    const searchInput = toolbar!.querySelector('input[type="search"]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    searchInput!.focus();
    expect(document.activeElement).toBe(searchInput);
    expectSingleToolbarTabStop(items, 4);

    for (const key of ['{ArrowLeft}', '{ArrowRight}', '{Home}', '{End}']) {
      await userEvent.keyboard(key);
      expect(document.activeElement).toBe(searchInput);
      expectSingleToolbarTabStop(items, 4);
    }
  });

  it('native Tab and Shift+Tab leave the toolbar instead of visiting roved items', async () => {
    await render(<ToolbarTrustedKeyboardFixture />);

    const before = document.getElementById('before-toolbar') as HTMLButtonElement | null;
    const after = document.getElementById('after-toolbar') as HTMLButtonElement | null;
    const toolbar = document.querySelector('[role="toolbar"]') as HTMLElement | null;
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(toolbar).not.toBeNull();

    const items = toolbarItems(toolbar!);

    before!.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(items[0]);
    expectSingleToolbarTabStop(items, 0);

    await userEvent.tab();
    expect(document.activeElement).toBe(after);

    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(items[0]);
    expectSingleToolbarTabStop(items, 0);

    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// C-B3W3-7: Focus-trap boundary edge — loading-body Tab trap
//
// SCENARIO (b3-wave3-investigation §7.2)
// ========================================
// A Modal is open with:
//   1. A Tabs primitive with 3 tabs (first tab selected).
//   2. A MINIMAL modal body (the "loading" scenario — EmptyState has no
//      focusable content; here simulated as a plain text div).
//
// The focus trap (useDismissable) uses:
//   FOCUSABLE_SELECTOR = 'button:not([disabled]):not([aria-disabled="true"]), …'
// This selector MATCHES tabIndex=-1 tab buttons (they are not [disabled]).
// So the trap computes "last focusable" as the LAST tab (whether tabIndex=0 or -1).
//
// When the selected tab is NOT the last DOM-order tab button:
//   • A forward Tab from the selected tab does NOT trigger the `last===active`
//     wrap condition because `last` per the selector is an unselected tabIndex=-1
//     tab that native Tab order skips.
//   • The Tab event escapes; native focus moves to the next tabIndex=0 element
//     in the page — possibly outside the portal for one stop.
//
// D7 VERDICT: The `!container.contains(activeElement)` recapture branch
// (use-dismissable.ts:182) does NOT work as the primary real-browser defense
// because native Tab traversal can override the programmatic focus() call.
// DD-27 closes the edge by excluding roving tabIndex=-1 buttons from the trap
// boundary set, so the boundary matches native Tab traversal.
//
// WHAT THIS TEST PROVES
// ======================
// • Modal opens with focus inside.
// • Escape closes the modal from inside.
// • Repeated trusted Tab presses remain inside the modal on the loading-body edge.
//
// The original "self-healing" contract from b3-wave3-investigation §7.2 is
// REVISED: the edge needed a trap-boundary fix rather than relying on recapture.
//
// Modal portals to document.body (createPortal in Modal.tsx) — queries must
// use document.querySelector, not container.querySelector.
// ---------------------------------------------------------------------------

describe('C-B3W3-7: Modal focus-trap edge — loading-body Tab trap', () => {
  /**
   * A Modal with Tabs in the body (first tab selected) and no other focusable
   * content — the "loading / empty state" scenario.
   *
   * The header has a Close ActionButton (first focusable element for the trap).
   * The body has a Tabs primitive with 3 tabs — only the selected one has
   * tabIndex=0; the rest are tabIndex=-1.
   * No other focusable elements in the body.
   */
  function ModalWithTabsAndEmptyBody({ onClose }: { onClose: () => void }) {
    const [activeTab, setActiveTab] = React.useState('info');
    return (
      <Modal open onClose={onClose} size="md">
        <div className="soup-modal-header">
          <span id="kb-test-title" className="soup-modal-title">Group Details</span>
          <ActionButton
            label="Close dialog"
            onClick={onClose}
          />
        </div>
        <ModalBody>
          <Tabs label="Detail tabs" value={activeTab} onChange={setActiveTab}>
            <Tab id="info">Info</Tab>
            <Tab id="participants">Participants</Tab>
            <Tab id="settings">Settings</Tab>
          </Tabs>
          {/* Empty body simulates loading state — no focusable content */}
          <div role="status" aria-label="Loading…">Loading…</div>
        </ModalBody>
      </Modal>
    );
  }

  it('modal opens with focus inside the dialog', async () => {
    const onClose = vi.fn();
    await render(
      <MemoryRouter>
        <ModalWithTabsAndEmptyBody onClose={onClose} />
      </MemoryRouter>,
    );

    // Modal portals to document.body — query from document.
    const modalEl = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(modalEl).not.toBeNull();
    // useDismissable shifts focus to first focusable element on open.
    expect(modalEl!.contains(document.activeElement)).toBe(true);
  });

  it('Escape closes the modal from initial focus position', async () => {
    const onClose = vi.fn();
    await render(
      <MemoryRouter>
        <ModalWithTabsAndEmptyBody onClose={onClose} />
      </MemoryRouter>,
    );

    // Modal portals to document.body.
    const modalEl = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(modalEl).not.toBeNull();

    await userEvent.keyboard('{Escape}');
    // useDismissable's capture-phase stack fires onClose.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('C-B3W3-7: repeated trusted Tab presses stay trapped inside the modal', async () => {
    const onClose = vi.fn();
    await render(
      <MemoryRouter>
        {/* Focusable elements outside the modal — provide landing targets for escaped focus. */}
        <button type="button" id="before-modal">Before modal</button>
        <ModalWithTabsAndEmptyBody onClose={onClose} />
        <button type="button" id="after-modal">After modal</button>
      </MemoryRouter>,
    );

    const modalEl = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(modalEl).not.toBeNull();

    // Repeated trusted Tab presses cycle between the close button and the selected
    // tab; roving tabIndex=-1 tabs must not become the trap boundary.
    for (let i = 0; i < 10; i++) {
      await userEvent.tab();
      expect(modalEl!.contains(document.activeElement)).toBe(true);
    }
  });
});
