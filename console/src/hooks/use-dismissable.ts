/**
 * use-dismissable.ts — the ONE dismissal hook (interaction-patterns.md §2).
 *
 * Implements the full useDismissable contract:
 *   - Focus trap: Tab cycles within the overlay; Shift+Tab reverses.
 *     Opt-out via `trapFocus: false` for combobox surfaces (C-B2-1).
 *   - Initial focus: shifts to the container (or caller-provided initialFocus ref)
 *     on mount. Opt-out via `autoFocus: false` for combobox surfaces (C-B2-1).
 *   - Focus restoration: captures document.activeElement at mount time; restores
 *     it to that element on close. Fixes the "cursor lands nowhere" bug.
 *   - Escape closes exactly one layer: stacking-aware single-fire via a module-level
 *     stack. Only the TOPMOST registered overlay handles a given Escape, fixing the
 *     GroupDetailModal + ConfirmDialog double-close (P1-2).
 *   - Outside-click: optional, controlled by the dismissable prop. Escape and the
 *     header close button are ALWAYS available — on a destructive confirm they CANCEL
 *     (the safe action, WAI dialog pattern); `dismissable` only opts into the riskier
 *     close-on-outside-click behavior.
 *   - SSR-safe: all DOM access is gated behind typeof document checks.
 *   - Reduced-motion neutral: no motion logic here; this hook is purely behavioural.
 *
 * C-B2-1 additive amendment: `trapFocus` and `autoFocus` default true so all
 * existing Modal/Drawer consumers are byte-identical. Popover opts both to false,
 * preserving focus on the combobox trigger/input per select.md accessibility contract.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   useDismissable(ref, { onClose, dismissable, open });
 */
import { useEffect, useRef, useCallback } from 'react';
import type { RefObject } from 'react';

// ---------------------------------------------------------------------------
// Stacking registry — module-level so it persists across renders.
// Only the TOPMOST entry handles Escape (single-fire, interaction-patterns §2).
// ---------------------------------------------------------------------------
const _overlayStack: Array<() => void> = [];

function pushOverlay(onClose: () => void): () => void {
  _overlayStack.push(onClose);
  return () => {
    const idx = _overlayStack.lastIndexOf(onClose);
    if (idx !== -1) _overlayStack.splice(idx, 1);
  };
}

function peekTopmost(): (() => void) | null {
  return _overlayStack.length > 0 ? _overlayStack[_overlayStack.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Focusable element selector (ARIA-inclusive)
// ---------------------------------------------------------------------------
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled]):not([aria-disabled="true"])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.closest('[aria-hidden="true"]') &&
      !el.closest('[hidden]') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      // Match native Tab order; button selectors also match roving tabIndex=-1 items.
      el.tabIndex >= 0,
  );
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UseDismissableOptions {
  /** Called when the overlay should close (Escape, outside click, or programmatic). */
  onClose: () => void;
  /** When true the overlay is open and effects are active. */
  open: boolean;
  /**
   * When true, clicking outside the container (on the scrim) also triggers onClose.
   * Default false — destructive confirms must require an explicit button (modal.md).
   */
  dismissable?: boolean;
  /**
   * Optional ref to the element that should receive initial focus.
   * When omitted the first focusable child (or the container itself) gets focus.
   */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Optional ref that overrides the focus-restoration target. When set and the
   * element is still in the document at close time, focus restores HERE instead
   * of the element captured at open. Needed by retargeting overlays (Drawer):
   * after the inspected entity changes while open, the correct restore target
   * is the CURRENT originating row, not the one that first opened the overlay.
   */
  restoreFocus?: RefObject<HTMLElement | null>;
  /**
   * When false, the focus trap (Tab/Shift+Tab cycling) is disabled.
   * Default true — Modal/Drawer keep the trap; combobox Popover opts out so
   * focus stays on the trigger/input and the user can type while navigating
   * options via arrow keys (C-B2-1 additive amendment, select.md combobox contract).
   */
  trapFocus?: boolean;
  /**
   * When false, initial focus is NOT shifted into the container on open.
   * Default true — Modal/Drawer steal focus on mount; combobox Popover opts out
   * so the trigger/input retains focus while the panel is visible (C-B2-1).
   */
  autoFocus?: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDismissable(
  containerRef: RefObject<HTMLElement | null>,
  options: UseDismissableOptions,
): void {
  const {
    onClose,
    open,
    dismissable = false,
    initialFocus,
    restoreFocus,
    trapFocus = true,
    autoFocus = true,
  } = options;

  // Stable ref to onClose so effects don't re-run on every render closure change.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Capture the element that had focus BEFORE the overlay opened (focus restoration).
  const returnFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    if (typeof document === 'undefined') return;
    returnFocusRef.current = document.activeElement;
  }, [open]);

  // Focus trap + initial focus
  useEffect(() => {
    if (!open) return;
    if (typeof document === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;

    // Set initial focus (opt-out via autoFocus: false for combobox surfaces)
    if (autoFocus) {
      const firstFocusable = getFocusableElements(container)[0];
      const initialTarget =
        (initialFocus?.current ?? null) !== null &&
        container.contains(initialFocus!.current)
          ? initialFocus!.current!
          : firstFocusable ?? container;
      (initialTarget as HTMLElement).focus({ preventScroll: true });
    }

    // Focus trap (opt-out via trapFocus: false for combobox surfaces)
    if (!trapFocus) return;

    function handleTab(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const focusable = getFocusableElements(container!);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !container!.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !container!.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleTab);
    return () => document.removeEventListener('keydown', handleTab);
  }, [open, containerRef, initialFocus, trapFocus, autoFocus]);

  // Escape handler — stacking-aware single-fire
  const stableClose = useCallback(() => onCloseRef.current(), []);

  useEffect(() => {
    if (!open) return;

    const deregister = pushOverlay(stableClose);

    function handleKeydown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const topmost = peekTopmost();
      if (topmost !== stableClose) return;
      e.stopPropagation();
      topmost();
    }

    document.addEventListener('keydown', handleKeydown, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleKeydown, { capture: true });
      deregister();
    };
  }, [open, stableClose]);

  // Focus restoration on close. The restoreFocus override (when provided and
  // still connected) wins over the element captured at open — see the option doc.
  useEffect(() => {
    if (open) return;
    const override = restoreFocus?.current ?? null;
    const target =
      override && typeof document !== 'undefined' && document.contains(override)
        ? override
        : returnFocusRef.current;
    if (!target || typeof (target as HTMLElement).focus !== 'function') return;
    if (typeof document !== 'undefined' && document.contains(target)) {
      (target as HTMLElement).focus({ preventScroll: true });
    }
    returnFocusRef.current = null;
  }, [open, restoreFocus]);

  // Outside-click handler (optional)
  useEffect(() => {
    if (!open || !dismissable) return;
    if (typeof document === 'undefined') return;

    function handlePointerDown(e: PointerEvent) {
      // Stacking-aware: only the TOPMOST overlay may dismiss on an outside click,
      // so stacked dismissable overlays never close together on one click.
      if (peekTopmost() !== stableClose) return;
      const container = containerRef.current;
      if (!container) return;
      if (!container.contains(e.target as Node)) {
        onCloseRef.current();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open, dismissable, containerRef, stableClose]);
}
