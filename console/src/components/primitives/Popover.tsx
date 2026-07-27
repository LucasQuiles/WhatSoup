/* eslint-disable react-refresh/only-export-components -- waiver:WVR-012 file exports Popover component alongside popoverOptionId helper and usePopoverKeyboard hook; all three are co-located per select.md canonical picker API; safe — component is stable; expires 2026-12-31 */
/**
 * Popover.tsx — select.md-canonical anchored panel for picker surfaces (B2).
 *
 * Built on useDismissable with trapFocus: false, autoFocus: false so focus
 * STAYS on the combobox trigger/input while the panel is open. Escape is
 * handled via the shared overlay stack (capture-phase + stopPropagation),
 * which fixes the recorded Escape-layering defect: when a Popover is open
 * inside a legacy dialog with a bubble-phase Escape handler, the Popover
 * consumes Escape first and the dialog is left open — one Escape per layer,
 * not both at once.
 *
 * The panel portals to document.body (matching Modal/Drawer) so that:
 *   1. The panel is never clipped by ancestor overflow:hidden containers.
 *   2. Positioning is applied via a useLayoutEffect directly to the DOM node,
 *      avoiding both the react-hooks/refs lint rule and unnecessary re-renders.
 *
 * Anatomy (select.md § Anatomy):
 *   panel root  — soup-popover / data-state="open|closed"
 *   option list — soup-popover__list (role=listbox)
 *   option row  — soup-popover__option (role=option), 28px compressed row
 *
 * Keyboard contract (select.md § Accessibility):
 *   Down  — open panel / move active option down (clamp at end)
 *   Up    — move active option up (clamp at start)
 *   Enter — select active option + close
 *   Escape — close one layer, focus returns to trigger/input
 *
 * Focus: remains on trigger/input throughout. aria-activedescendant tracks
 * the visually active option row inside the listbox. No focus trap, no steal.
 *
 * Placement: bottom-span (min-width = trigger, default) or bottom-start
 * (panel-min-w token floor only). Bottom-only; no collision-flip engine
 * (DD-23, C-B2-2 documented non-goal).
 *
 * Generic-content mode (Phase B addition, datetimepicker.md § Phase B):
 *   When the `children` prop is supplied, the listbox is NOT rendered — the
 *   panel root carries `children` directly. Positioning, escape, focus-restore
 *   and outside-click semantics remain identical. This is how the calendar
 *   grid (role=grid) and any future non-listbox anchor surfaces reuse the
 *   same panel infrastructure without hand-rolling positioning. When both
 *   `children` and `options` are passed, `children` wins (documented; not an
 *   error — Phase B callers supply children only).
 *
 * Note: select.md-canonical for picker surfaces — not "the only popover";
 * legacy dialogs still hand-roll overlays until B3.
 */
import {
  type FC,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useLayoutEffect,
} from 'react';
import { createPortal } from 'react-dom';
import { useDismissable } from '../../hooks/use-dismissable';
import { useExitPresence } from '../../hooks/use-exit-presence';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single selectable option in the Popover list. */
export interface PopoverOption {
  /** Unique value — used as the id suffix for aria-activedescendant. */
  value: string;
  /** Display label. */
  label: string;
  /** When true the row carries aria-selected and --accent-wash. */
  selected?: boolean;
  /** Render custom content instead of label (label still used for accessible name). */
  renderOption?: () => ReactNode;
}

export interface PopoverProps {
  /** Controls visibility. */
  open: boolean;
  /** Called when the panel should close. */
  onClose: () => void;
  /**
   * Ref to the trigger/anchor element. The panel is positioned below it via a
   * portal to document.body with coordinates derived from getBoundingClientRect,
   * applied in useLayoutEffect to avoid reading ref.current during render.
   */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * Options to render in the listbox (legacy select.md path).
   * Required when no `children` is supplied; ignored when `children` is given.
   */
  options?: PopoverOption[];
  /**
   * Value of the currently keyboard-active option (aria-activedescendant).
   * null when no option is active. Required for the listbox path; ignored
   * when `children` is given (children own their own focus/keyboard state).
   */
  activeValue?: string | null;
  /** Called when an option is selected (click or Enter). Required for the listbox path. */
  onSelect?: (value: string) => void;
  /**
   * Accessible label for the listbox panel.
   * Typically matches the trigger's accessible name.
   */
  listboxLabel?: string;
  /**
   * Exposes the generated listbox id so the combobox trigger can wire
   * aria-controls and aria-activedescendant from the outside.
   * If omitted, the panel generates a stable id internally.
   */
  listboxId?: string;
  /**
   * When "span" (default) the panel min-width matches the trigger width.
   * When "start" the panel uses the --popover-min-w token floor only.
   */
  placement?: 'span' | 'start';
  /** Additional class names for the panel root. */
  className?: string;
  /**
   * Generic content (Phase B addition, datetimepicker.md § Phase B calendar popover).
   * When supplied, the listbox is NOT rendered and the panel root carries
   * `children` directly — positioning, escape, focus-restore and outside-click
   * semantics are unchanged. This is how the calendar grid (`role="grid"`) and
   * any future non-listbox anchor surfaces reuse the same panel infrastructure
   * without hand-rolling positioning. When both `children` and `options` are
   * passed, `children` wins (documented; Phase B callers supply children only).
   */
  children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the id for an option element (used for aria-activedescendant). */
export function popoverOptionId(listboxId: string, value: string): string {
  let encodedValue = '';
  for (let index = 0; index < value.length; index += 1) {
    encodedValue += value.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return `${listboxId}-opt-${encodedValue}`;
}

// ---------------------------------------------------------------------------
// Popover (portal-based anchored panel)
// ---------------------------------------------------------------------------

/** CSS animation name for the popover exit keyframe (B5 §4.2 guard, motion.md §5). */
const POPOVER_OUT_ANIM = 'soup-popover-out';

export const Popover: FC<PopoverProps> = ({
  open,
  onClose,
  anchorRef,
  options,
  activeValue,
  onSelect,
  listboxLabel,
  listboxId: externalListboxId,
  placement = 'span',
  className,
  children,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const autoId = useId();
  // Use external id if provided (allows caller to wire aria-controls), else auto.
  const listboxId = externalListboxId ?? autoId;

  // Register with overlay stack — trapFocus: false + autoFocus: false so focus
  // stays on the combobox trigger/input. Escape handled via capture-phase stack.
  // dismissable: true — outside-click closes (select.md § Accessibility).
  // useDismissable receives the REAL open prop: Escape deregisters and focus
  // restores at close-start; the closing panel never captures input.
  useDismissable(panelRef, {
    onClose,
    open,
    dismissable: true,
    trapFocus: false,
    autoFocus: false,
  });

  // Exit presence: deferred unmount while soup-popover-out keyframe plays (B5 §4.2).
  // In jsdom (no stylesheet) the dwell is instant — all existing suites stable (C-B5-1).
  const { mounted, phase } = useExitPresence(open, panelRef, POPOVER_OUT_ANIM);

  // Apply anchor-based positioning to the portal panel after paint (safe DOM write).
  // Using useLayoutEffect + direct style mutation avoids:
  //   (a) reading anchorRef.current during render (react-hooks/refs rule)
  //   (b) setState-in-effect cascade (react-hooks/set-state-in-effect rule)
  // jsdom returns all zeros for getBoundingClientRect — tests rely on CSS classes.
  // Run when open OR during closing dwell so the panel stays positioned while it fades.
  useLayoutEffect(() => {
    if (!mounted) return;
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!panel || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const scrollY = window.scrollY;
    const scrollX = window.scrollX;
    panel.style.position = 'absolute';
    panel.style.top = `${rect.bottom + scrollY}px`;
    panel.style.left = `${rect.left + scrollX}px`;
    if (placement === 'span' && rect.width > 0) {
      panel.style.minWidth = `${rect.width}px`;
    }
  }, [mounted, anchorRef, placement]);

  if (!mounted) return null;

  const panelClass = ['soup-popover', className].filter(Boolean).join(' ');

  // Generic-content mode (children) vs legacy listbox (options). When both
  // are supplied, children wins — documented in the file header.
  const isGeneric = children !== undefined;
  const safeOptions = options ?? [];
  const safeActiveValue = activeValue ?? null;
  const safeOnSelect = onSelect ?? (() => {});

  const panel = (
    <div
      ref={panelRef}
      className={panelClass}
      data-state={phase}
    >
      {isGeneric ? (
        children
      ) : (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={listboxLabel}
          className="soup-popover__list"
        >
          {safeOptions.map((opt) => {
            const optId = popoverOptionId(listboxId, opt.value);
            const isActive = safeActiveValue === opt.value;
            const isSelected = opt.selected ?? false;
            return (
              <li
                key={opt.value}
                id={optId}
                role="option"
                aria-selected={isSelected}
                data-active={isActive ? 'true' : undefined}
                className={[
                  'soup-popover__option',
                  isSelected ? 'soup-popover__option--selected' : '',
                  isActive ? 'soup-popover__option--active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onMouseDown={(e) => {
                  // Use mousedown so the trigger doesn't lose focus on pointerdown
                  // (which would fire the outside-click handler first).
                  e.preventDefault();
                  safeOnSelect(opt.value);
                }}
              >
                {isSelected && (
                  <span className="soup-popover__check" aria-hidden="true" />
                )}
                <span className="soup-popover__option-label" title={opt.label}>
                  {opt.renderOption ? opt.renderOption() : opt.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  // Portal to body: keeps the panel out of ancestor overflow:hidden containers.
  if (typeof document !== 'undefined') {
    return createPortal(panel, document.body);
  }
  return panel;
};

// ---------------------------------------------------------------------------
// usePopoverKeyboard — keyboard contract for combobox triggers
//
// Encapsulates Down/Up/Enter key handling for a combobox trigger that drives
// a Popover. Import alongside Popover for full combobox keyboard support.
// Escape is handled by useDismissable's capture-phase stack in the Popover —
// no additional Escape handling here.
// ---------------------------------------------------------------------------

export interface UsePopoverKeyboardOptions {
  open: boolean;
  options: Pick<PopoverOption, 'value'>[];
  activeValue: string | null;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (value: string) => void;
  onActiveChange: (value: string | null) => void;
}

export interface UsePopoverKeyboardResult {
  handleKeyDown: (e: React.KeyboardEvent) => void;
}

export function usePopoverKeyboard(
  opts: UsePopoverKeyboardOptions,
): UsePopoverKeyboardResult {
  const { open, options, activeValue, onSelect, onOpen, onActiveChange } = opts;

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        onOpen();
        // Set first option active on open via Down
        if (options.length > 0) onActiveChange(options[0].value);
        return;
      }
      if (options.length === 0) return;
      const idx = options.findIndex((o) => o.value === activeValue);
      // Clamp at end (select.md is silent; clamping is the documented interpretation)
      const nextIdx = idx < options.length - 1 ? idx + 1 : idx;
      onActiveChange(options[nextIdx].value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open || options.length === 0) return;
      const idx = options.findIndex((o) => o.value === activeValue);
      if (idx === -1) return;
      // Clamp at start
      const prevIdx = idx > 0 ? idx - 1 : 0;
      onActiveChange(options[prevIdx].value);
    } else if (e.key === 'Enter') {
      if (!open || activeValue === null) return;
      e.preventDefault();
      onSelect(activeValue);
      // Note: closing is the caller's responsibility (wire onSelect → close) so
      // consumers can sequence their own state updates before unmounting the panel.
    }
    // Escape is handled by useDismissable's capture-phase stack in the Popover.
    // No additional handling here — the hook fires onClose, focus stays on trigger.
  }

  return { handleKeyDown };
}
