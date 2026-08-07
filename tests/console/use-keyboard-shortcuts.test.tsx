/**
 * Tests for console/src/hooks/use-keyboard-shortcuts.ts
 *
 * The hook is pure behavior - no DOM render - so we mount it via renderHook
 * wrapped in a MemoryRouter (required for useNavigate + useLocation).
 * Events dispatch from their real target and bubble to the document listener.
 *
 * Source surprises documented inline:
 *  S1 - listener is on `document`, not `window`
 *  S2 - Cmd/Ctrl+K fires EVEN when an input is focused (opt-in exception)
 *  S3 - `?` requires no modifier keys (metaKey/ctrlKey/altKey all must be false)
 *  S4 - number keys 1/2/3 are guarded: navigate only when NOT already on target path
 *  S5 - handlers are held in a ref (not a useCallback dep), so a fresh handlers object
 *       each render does NOT re-register the listener (#1099); the listener re-binds only
 *       on navigation, and always invokes the latest handlers (no stale closure)
 *  S6 - no capture-phase (`addEventListener` without `{ capture: true }`)
 *  S7 - key '4' is NOT wired (only 1, 2, 3 produce navigation)
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createElement, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Navigation mock - capture calls to navigate()
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
let mockPathname = '/';

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: mockPathname }),
  };
});

// Dynamic import AFTER mock registration
import { useKeyboardShortcuts } from '../../console/src/hooks/use-keyboard-shortcuts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: ReactNode }) {
  return createElement(MemoryRouter, { initialEntries: ['/'] }, children);
}

/** Fire a keydown event from the requested target and let it bubble. */
function fireKey(
  key: string,
  opts: Partial<KeyboardEventInit> = {},
  target: Document | HTMLElement = document,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...opts });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockPathname = '/';
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Cmd/Ctrl+K - search shortcut
// ---------------------------------------------------------------------------

describe('useKeyboardShortcuts - Cmd/Ctrl+K search', () => {
  it('calls onSearch when metaKey+K is pressed', () => {
    const onSearch = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onSearch }), { wrapper });

    act(() => { fireKey('k', { metaKey: true }); });

    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('calls onSearch when ctrlKey+K is pressed', () => {
    const onSearch = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onSearch }), { wrapper });

    act(() => { fireKey('k', { ctrlKey: true }); });

    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('calls preventDefault on Cmd/Ctrl+K (S2)', () => {
    const onSearch = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onSearch }), { wrapper });

    let prevented = false;
    const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true });
    Object.defineProperty(event, 'preventDefault', {
      value: () => { prevented = true; },
      writable: false,
    });

    act(() => { document.dispatchEvent(event); });

    expect(prevented).toBe(true);
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('fires even when an input element is focused (S2)', () => {
    const onSearch = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onSearch }), { wrapper });

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    act(() => {
      fireKey('k', { metaKey: true }, input);
    });

    expect(onSearch).toHaveBeenCalledTimes(1);
    document.body.removeChild(input);
  });

  it('does not call onSearch for bare K (no modifier)', () => {
    const onSearch = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onSearch }), { wrapper });

    act(() => { fireKey('k'); });

    expect(onSearch).not.toHaveBeenCalled();
  });

  it('does not call onSearch when handlers.onSearch is omitted', () => {
    // Should not throw
    expect(() => {
      renderHook(() => useKeyboardShortcuts({}), { wrapper });
      act(() => { fireKey('k', { metaKey: true }); });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ? key - help toggle
// ---------------------------------------------------------------------------

describe('useKeyboardShortcuts - ? help toggle', () => {
  it('calls onHelp when ? is pressed with no modifiers', () => {
    const onHelp = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onHelp }), { wrapper });

    act(() => { fireKey('?'); });

    expect(onHelp).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onHelp when metaKey+? pressed (S3)', () => {
    const onHelp = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onHelp }), { wrapper });

    act(() => { fireKey('?', { metaKey: true }); });

    expect(onHelp).not.toHaveBeenCalled();
  });

  it('does NOT call onHelp when ctrlKey+? pressed (S3)', () => {
    const onHelp = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onHelp }), { wrapper });

    act(() => { fireKey('?', { ctrlKey: true }); });

    expect(onHelp).not.toHaveBeenCalled();
  });

  it('does NOT call onHelp when altKey+? pressed (S3)', () => {
    const onHelp = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onHelp }), { wrapper });

    act(() => { fireKey('?', { altKey: true }); });

    expect(onHelp).not.toHaveBeenCalled();
  });

  it('does NOT call onHelp when input is focused', () => {
    const onHelp = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onHelp }), { wrapper });

    const input = document.createElement('input');
    document.body.appendChild(input);

    act(() => {
      fireKey('?', {}, input);
    });

    expect(onHelp).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it('does not throw when onHelp is omitted', () => {
    expect(() => {
      renderHook(() => useKeyboardShortcuts({}), { wrapper });
      act(() => { fireKey('?'); });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Number key navigation (1/2/3)
// ---------------------------------------------------------------------------

describe('useKeyboardShortcuts - number key navigation', () => {
  it('navigates to / on key 1 when not already on /', () => {
    mockPathname = '/inbox';
    renderHook(() => useKeyboardShortcuts({}), { wrapper });

    act(() => { fireKey('1'); });

    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('does NOT navigate when key 1 pressed and already on / (S4)', () => {
    mockPathname = '/';
    renderHook(() => useKeyboardShortcuts({}), { wrapper });

    act(() => { fireKey('1'); });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates to /inbox on key 2 when not already there', () => {
    mockPathname = '/';
    renderHook(() => useKeyboardShortcuts({}), { wrapper });

    act(() => { fireKey('2'); });

    expect(mockNavigate).toHaveBeenCalledWith('/inbox');
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('does NOT navigate when key 2 pressed and already on /inbox (S4)', () => {
    mockPathname = '/inbox';
    renderHook(() => useKeyboardShortcuts({}), { wrapper });

    act(() => { fireKey('2'); });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates to /operator on key 3 when not already there', () => {
    mockPathname = '/';
    renderHook(() => useKeyboardShortcuts({}), { wrapper });

    act(() => { fireKey('3'); });

    // Canonical /operator route, not the /ops alias (which redirects → history pollution).
    expect(mockNavigate).toHaveBeenCalledWith('/operator');
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('does NOT navigate when key 3 pressed and already on /operator (S4)', () => {
    mockPathname = '/operator';
    renderHook(() => useKeyboardShortcuts({}), { wrapper });

    act(() => { fireKey('3'); });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does NOT navigate on key 4 - not wired (S7)', () => {
    mockPathname = '/';
    renderHook(() => useKeyboardShortcuts({}), { wrapper });

    act(() => { fireKey('4'); });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does NOT navigate when metaKey held with number key', () => {
    mockPathname = '/inbox';
    renderHook(() => useKeyboardShortcuts({}), { wrapper });

    act(() => { fireKey('1', { metaKey: true }); });

    // metaKey+'1' does not match the Cmd+K branch (key is '1', not 'k');
    // it falls through to the number-key guard `if (!metaKey && ...)` which is
    // false, so navigation is skipped.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does NOT navigate when ctrlKey held with number key', () => {
    mockPathname = '/';
    renderHook(() => useKeyboardShortcuts({}), { wrapper });

    act(() => { fireKey('1', { ctrlKey: true }); });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does NOT navigate when altKey held with number key', () => {
    mockPathname = '/';
    renderHook(() => useKeyboardShortcuts({}), { wrapper });

    act(() => { fireKey('1', { altKey: true }); });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does NOT navigate when shiftKey held with number key', () => {
    mockPathname = '/';
    renderHook(() => useKeyboardShortcuts({}), { wrapper });

    act(() => { fireKey('1', { shiftKey: true }); });

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Input-element opt-out for non-search shortcuts
// ---------------------------------------------------------------------------

describe('useKeyboardShortcuts - input element opt-out', () => {
  const inputTypes = [
    { label: 'INPUT', tag: 'input' },
    { label: 'TEXTAREA', tag: 'textarea' },
    { label: 'SELECT', tag: 'select' },
  ] as const;

  for (const { label, tag } of inputTypes) {
    it(`does not navigate on '1' when a ${label} is the event target`, () => {
      mockPathname = '/inbox';
      const onHelp = vi.fn();
      renderHook(() => useKeyboardShortcuts({ onHelp }), { wrapper });

      const el = document.createElement(tag);
      document.body.appendChild(el);

      act(() => {
        fireKey('1', {}, el);
      });

      expect(mockNavigate).not.toHaveBeenCalled();
      expect(onHelp).not.toHaveBeenCalled();
      document.body.removeChild(el);
    });
  }

  it('does not navigate when a contentEditable element is the event target', () => {
    mockPathname = '/inbox';
    const onHelp = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onHelp }), { wrapper });

    const div = document.createElement('div');
    div.contentEditable = 'true';
    Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true });
    document.body.appendChild(div);

    act(() => {
      fireKey('1', {}, div);
      fireKey('?', {}, div);
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(onHelp).not.toHaveBeenCalled();
    document.body.removeChild(div);
  });
});

// ---------------------------------------------------------------------------
// Unregistered keys - no-op
// ---------------------------------------------------------------------------

describe('useKeyboardShortcuts - unregistered keys (no-op)', () => {
  it('does nothing for Escape key', () => {
    const onSearch = vi.fn();
    const onHelp = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onSearch, onHelp }), { wrapper });

    act(() => { fireKey('Escape'); });

    expect(onSearch).not.toHaveBeenCalled();
    expect(onHelp).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does nothing for arbitrary letter keys', () => {
    const onSearch = vi.fn();
    const onHelp = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onSearch, onHelp }), { wrapper });

    act(() => { fireKey('a'); });
    act(() => { fireKey('z'); });

    expect(onSearch).not.toHaveBeenCalled();
    expect(onHelp).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Empty / default handlers argument
// ---------------------------------------------------------------------------

describe('useKeyboardShortcuts - default empty handlers', () => {
  it('mounts with no args and fires Cmd+K without throwing', () => {
    expect(() => {
      renderHook(() => useKeyboardShortcuts(), { wrapper });
      act(() => { fireKey('k', { metaKey: true }); });
    }).not.toThrow();
  });

  it('mounts with no args and fires ? without throwing', () => {
    expect(() => {
      renderHook(() => useKeyboardShortcuts(), { wrapper });
      act(() => { fireKey('?'); });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cleanup - listener removed on unmount (S1, S6)
// ---------------------------------------------------------------------------

describe('useKeyboardShortcuts - cleanup on unmount', () => {
  it('removes document keydown listener on unmount (S1)', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const onSearch = vi.fn();
    const { unmount } = renderHook(() => useKeyboardShortcuts({ onSearch }), { wrapper });

    // Confirm a keydown listener was registered
    const addCalls = addSpy.mock.calls.filter(([evt]) => evt === 'keydown');
    expect(addCalls.length).toBeGreaterThan(0);

    unmount();

    // Confirm the same handler was removed
    const removeCalls = removeSpy.mock.calls.filter(([evt]) => evt === 'keydown');
    expect(removeCalls.length).toBeGreaterThan(0);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('does not fire onSearch after unmount', () => {
    const onSearch = vi.fn();
    const { unmount } = renderHook(() => useKeyboardShortcuts({ onSearch }), { wrapper });

    unmount();

    act(() => { fireKey('k', { metaKey: true }); });

    expect(onSearch).not.toHaveBeenCalled();
  });

  it('does not navigate after unmount', () => {
    mockPathname = '/inbox';
    const { unmount } = renderHook(() => useKeyboardShortcuts({}), { wrapper });

    unmount();

    act(() => { fireKey('1'); });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('symmetry: removeEventListener count matches addEventListener count for keydown', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const { unmount } = renderHook(() => useKeyboardShortcuts({}), { wrapper });
    unmount();

    const added = addSpy.mock.calls.filter(([evt]) => evt === 'keydown').length;
    const removed = removeSpy.mock.calls.filter(([evt]) => evt === 'keydown').length;
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('does not re-register the listener on re-render with a fresh handlers object (#1099)', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    // Pass a NEW object literal each render (as App.tsx does). The handlers ref keeps
    // handleKeyDown stable, so the keydown listener must bind only once across re-renders.
    const { rerender } = renderHook(
      () => useKeyboardShortcuts({ onSearch: () => {}, onHelp: () => {} }),
      { wrapper },
    );
    const afterFirst = addSpy.mock.calls.filter(([evt]) => evt === 'keydown').length;
    rerender();
    rerender();
    const afterRerenders = addSpy.mock.calls.filter(([evt]) => evt === 'keydown').length;

    expect(afterFirst).toBe(1);
    expect(afterRerenders).toBe(1); // no churn on re-render

    addSpy.mockRestore();
  });

  it('invokes the latest handlers after a re-render (no stale closure)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ h }: { h: () => void }) => useKeyboardShortcuts({ onSearch: h }), {
      wrapper,
      initialProps: { h: first },
    });
    rerender({ h: second });
    act(() => { fireKey('k', { metaKey: true }); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// "/" - focus the page search input (#1101)
// ---------------------------------------------------------------------------

describe('useKeyboardShortcuts - "/" focuses the search target (#1101)', () => {
  function addSearchTarget(): HTMLInputElement {
    const input = document.createElement('input');
    input.setAttribute('data-search-shortcut-target', 'true');
    document.body.appendChild(input);
    return input;
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('focuses the element marked data-search-shortcut-target on "/"', () => {
    const input = addSearchTarget();
    renderHook(() => useKeyboardShortcuts(), { wrapper });

    expect(document.activeElement).not.toBe(input);
    const event = fireKey('/', { cancelable: true });
    expect(document.activeElement).toBe(input);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does NOT hijack "/" while the user is typing in another input', () => {
    addSearchTarget();
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    renderHook(() => useKeyboardShortcuts(), { wrapper });

    const event = fireKey('/', { cancelable: true }, other);
    expect(document.activeElement).toBe(other); // focus stays where the user is typing
    expect(event.defaultPrevented).toBe(false);
  });

  it('does NOT consume "/" when no search target is present on the page', () => {
    renderHook(() => useKeyboardShortcuts(), { wrapper });
    const event = fireKey('/', { cancelable: true });
    expect(event.defaultPrevented).toBe(false);
  });

  it('does NOT fire on "/" combined with a modifier (e.g. Cmd+/)', () => {
    const input = addSearchTarget();
    renderHook(() => useKeyboardShortcuts(), { wrapper });
    const event = fireKey('/', { metaKey: true, cancelable: true });
    expect(document.activeElement).not.toBe(input);
    expect(event.defaultPrevented).toBe(false);
  });
});
