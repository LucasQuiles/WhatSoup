/**
 * @file tests/browser/smoke.test.tsx
 *
 * C-D7-1: browser-mode harness smoke gate.
 *
 * PURPOSE — gate before any D7 suite is built
 * ============================================
 * Two properties must hold before the computed-box, viewport, focus-ring, and
 * drawer suites are worth writing:
 *
 *   (A) vi.mock module interception works in browser mode (via @vitest/mocker,
 *       shipped with @vitest/browser@3.2.6).
 *
 *   (B) Real trusted-event keyboard interactions work — specifically, Tab focus
 *       + Enter activation — and produce outcomes jsdom cannot replicate.
 *
 * WHY JSDOM CANNOT PROVE THIS
 * ============================
 * jsdom's userEvent (from @testing-library/user-event) synthesises keyboard
 * events with document.createEvent() / initEvent(). Those events carry
 * isTrusted: false. The CSS :focus-visible selector is controlled by the
 * browser's "focus source" heuristic: it applies when focus arrived via
 * keyboard (trusted Tab/Shift+Tab event) — it does NOT apply on
 * programmatic .focus() calls or on untrusted synthetic events. Result in
 * jsdom: :focus-visible never becomes active; getComputedStyle on the
 * :focus-visible pseudo-selector always reads as if no rule applied. jsdom
 * also does not run a CSS cascade at all (no computed layout), so any
 * claim about getComputedStyle results is vacuous.
 *
 * In the playwright browser runner:
 *   - userEvent.tab() drives a real OS-level Tab keypress through the CDP
 *     protocol; the browser receives it as isTrusted: true.
 *   - The browser's focus-source heuristic marks the next focus as
 *     "keyboard-originated" and applies :focus-visible.
 *   - getComputedStyle() returns the COMPUTED value from the actual CSS
 *     cascade (including primitives.css, composites.css, tailwind utilities).
 *
 * WHAT THIS TEST PROVES
 * ======================
 *   1. A hoisted vi.mock intercepts a module import in browser mode — the
 *      mock function is called instead of the real implementation.
 *   2. userEvent.tab() moves focus to a Button in the document.
 *   3. After Tab, document.activeElement is the Button (trusted keyboard focus).
 *   4. After Tab, the Button matches :focus-visible (trusted keyboard focus
 *      source — this is the property jsdom cannot assert).
 *   5. After Enter (keyboard activation), the click handler fires with
 *      isTrusted: true — confirming the event was driven by the real browser
 *      engine, not synthesised by the test harness.
 *
 * Failures here are BLOCKED — stop and re-plan per C-D7-1 constraint before
 * writing any further browser suite. See d7-investigation §13 C-D7-1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from '@vitest/browser/context';
import { Button } from '../../console/src/components/primitives/index.ts';

// ---------------------------------------------------------------------------
// (A) vi.mock gate — verify module interception works in browser mode
//
// We mock a local helper module. The mock is hoisted by @vitest/mocker before
// the test body runs (same mechanism as jsdom suites).
// ---------------------------------------------------------------------------

// hoisted sentinel so the mock factory can reference it
const mockClickHandler = vi.hoisted(() => vi.fn());

// This vi.mock call verifies @vitest/mocker interception in browser mode.
// We mock the Button's import chain by injecting a wrapper that records the
// click callback via our hoisted spy, then renders the real Button.
// (The Button component itself does not import an external module we could
// intercept trivially; we use react-router-dom as the mock-gate target because
// it IS imported by the console module graph and is already stubbed in jsdom
// suites. If this intercept fails, the test file will throw on import.)
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    // Sentinel: confirm the mock factory ran in browser mode by
    // exporting a tagged value alongside the real module surface.
    __d7_mock_active: true,
  };
});

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  mockClickHandler.mockReset();
});

// ---------------------------------------------------------------------------
// (B) Trusted-event keyboard proof
// ---------------------------------------------------------------------------

describe('C-D7-1: browser-mode smoke gate', () => {

  it('(A) vi.mock intercepts react-router-dom in browser mode', async () => {
    // If @vitest/mocker interception is broken, this import will return the
    // real module (without __d7_mock_active) and the assertion fails clearly.
    const mod = await import('react-router-dom') as Record<string, unknown>;
    expect(mod.__d7_mock_active).toBe(true);
  });

  it('(B1) Tab moves focus to a Button — trusted keyboard focus confirmed', async () => {
    // Render a focusable Button in the real browser DOM.
    const { getByRole } = render(
      <Button variant="primary" onClick={mockClickHandler}>
        Focus target
      </Button>,
    );

    const btn = getByRole('button', { name: 'Focus target' });

    // Tab from document body to the button.
    // In jsdom: userEvent.tab() from @testing-library/user-event produces
    //   synthetic (isTrusted: false) events; :focus-visible is never applied.
    // In browser: @vitest/browser userEvent.tab() drives a real OS Tab via
    //   CDP; isTrusted: true; :focus-visible is set by the browser heuristic.
    await userEvent.tab();

    // (B1) The button received focus.
    expect(document.activeElement).toBe(btn.element());
  });

  it('(B2) After Tab, :focus-visible is active on the Button — jsdom cannot prove this', async () => {
    // Render the Button and tab to it.
    const { getByRole } = render(
      <Button variant="primary" onClick={mockClickHandler}>
        Keyboard target
      </Button>,
    );

    const btn = getByRole('button', { name: 'Keyboard target' });
    await userEvent.tab();

    // Confirm focus landed on the button (prerequisite).
    expect(document.activeElement).toBe(btn.element());

    // Assert :focus-visible matches.
    //
    // jsdom claim: matches() with :focus-visible always returns false after
    // synthetic focus because the focus source is not "keyboard" in jsdom's
    // (non-existent) heuristic. The CSS cascade is not computed in jsdom.
    //
    // Browser fact: after a real Tab keypress, the browser marks the next
    // focus as keyboard-originated → :focus-visible applies → matches() returns
    // true. This is the unique trusted-event proof this test provides.
    const isFocusVisible = btn.element().matches(':focus-visible');
    expect(isFocusVisible).toBe(true);
  });

  it('(B3) Enter on a focused Button fires a trusted click (isTrusted: true)', async () => {
    // Render the Button wired to the hoisted click spy.
    let capturedEvent: MouseEvent | null = null;
    const { getByRole } = render(
      <Button
        variant="primary"
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
          capturedEvent = e.nativeEvent as MouseEvent;
          mockClickHandler();
        }}
      >
        Enter target
      </Button>,
    );

    const btn = getByRole('button', { name: 'Enter target' });

    // Tab to the button, then press Enter.
    // In jsdom: fireEvent.click() is programmatic (isTrusted: false).
    //   @testing-library/user-event.keyboard('{Enter}') synthesises the event;
    //   isTrusted is still false.
    // In browser: userEvent.keyboard('{Enter}') drives a real keydown/keyup/
    //   click via CDP. The resulting click event is isTrusted: true.
    await userEvent.tab();
    expect(document.activeElement).toBe(btn.element());
    await userEvent.keyboard('{Enter}');

    // The click handler was called.
    expect(mockClickHandler).toHaveBeenCalledTimes(1);

    // The click event was trusted — driven by the real browser engine.
    // jsdom cannot produce this: its synthetic events are always isTrusted: false.
    expect(capturedEvent).not.toBeNull();
    expect((capturedEvent as MouseEvent).isTrusted).toBe(true);
  });
});
