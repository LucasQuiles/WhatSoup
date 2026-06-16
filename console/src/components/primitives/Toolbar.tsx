/**
 * Toolbar.tsx — the one pattern that fronts every list, table, and log (toolbar.md).
 *
 * Canonical anatomy (DOM order = visual order, never reordered):
 *   [ToolbarFilters | ToolbarTimeRange · ToolbarSpring · ToolbarSearch · primary Button]
 *
 * Sections are omittable but never reordered.
 *
 * Density: 28px controls by construction — compressed surface (toolbar.md §States).
 *
 * Sub-components:
 *   Toolbar          — shell; flush variant joins a table/log block.
 *   ToolbarFilters   — role="group" + label; children = interactive Pills.
 *   ToolbarTimeRange — segmented control; role="group" + label; aria-pressed exactly-one.
 *   ToolbarSearch    — 28px input with required accessible label.
 *   ToolbarSpring    — flex spring (flex: 1 1 auto).
 *
 * Roving tabindex (ARIA 1.2 §3.25 toolbar):
 *   The Toolbar shell manages a single tab stop. Arrow keys (Left/Right) move focus
 *   among focusable controls in DOM order; Home/End jump to first/last. Tab/Shift-Tab are
 *   never intercepted — they exit the toolbar. The implementation mirrors Tabs.tsx's
 *   querySelectorAll + focus() roving approach, extended to handle composite children:
 *   ToolbarSearch text inputs keep their internal
 *   ArrowLeft/ArrowRight/Home/End text-editing behavior because we only intercept
 *   at the toolbar level when the event target is not inside a text input).
 */
import { type FC, type ReactNode, type ChangeEventHandler, useRef, useCallback, type KeyboardEvent, type FocusEvent } from 'react';

// ---------------------------------------------------------------------------
// Helpers — focusable item discovery
// ---------------------------------------------------------------------------

/**
 * Returns the flat list of focusable toolbar items in DOM order.
 * "Focusable toolbar item" = any enabled interactive element in toolbar DOM order.
 *
 * Strategy (mirrors Tabs.tsx): query for native controls, links, and explicit
 * tabbables within the toolbar. Programmatic tabIndex=-1 sentinels are excluded
 * from discovery so implementation details do not become arrow-key stops.
 *
 * Special handling for ToolbarSearch: the <input type="search"> is the single
 * focusable stop for the whole search section, so it is included directly.
 *
 * ToolbarFilters and ToolbarTimeRange are role="group" containers, not independent
 * composite widgets with their own roving handlers, so their child buttons remain
 * toolbar-level arrow targets. ToolbarSearch wraps its input in a <label>; the
 * input itself surfaces as the editable target.
 */
function getToolbarItems(toolbar: HTMLElement): HTMLElement[] {
  // Query broadly, then filter disabled/hidden candidates in one place. This
  // keeps native controls and explicit tab stops aligned with browser Tab order.
  const candidates = Array.from(
    toolbar.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
    )
  );
  // Exclude any element that is itself aria-hidden or inside an aria-hidden container
  // (ToolbarSpring is aria-hidden on the div but has no focusable children, so no
  // items will originate from it anyway).
  return candidates.filter((el) => {
    if (el.closest('[aria-hidden="true"]')) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    return true;
  });
}

/**
 * Returns true when the keyboard event target is a text input or textarea —
 * meaning ArrowLeft/ArrowRight/Home/End should not be intercepted.
 */
function eventTargetIsTextEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const el = target;
  if (
    el.isContentEditable
    || el.closest('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]')
  ) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type.toLowerCase();
    // text-editing input types that use arrow keys for cursor movement
    return ['text', 'search', 'email', 'url', 'tel', 'number', 'password', ''].includes(type);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Toolbar (shell)
// ---------------------------------------------------------------------------

export interface ToolbarProps {
  /**
   * When true: no radius/side borders — flush variant joins its table/log block
   * (toolbar.md §Anatomy flush variant).
   */
  flush?: boolean;
  /** Required accessible label for the toolbar landmark. */
  'aria-label': string;
  children: ReactNode;
  className?: string;
}

export const Toolbar: FC<ToolbarProps> = ({
  flush = false,
  'aria-label': ariaLabel,
  children,
  className,
}) => {
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  // Track the roving active index across renders. We store it as a ref (not
  // state) so focus management doesn't trigger re-renders, mirroring Tabs.tsx.
  const activeIndexRef = useRef<number>(0);

  /**
   * Apply roving tabindex to all toolbar items: only the item at `activeIndex`
   * gets tabIndex=0; all others get tabIndex=-1.
   */
  const applyRoving = useCallback((items: HTMLElement[], activeIndex: number) => {
    items.forEach((item, i) => {
      item.tabIndex = i === activeIndex ? 0 : -1;
    });
  }, []);

  /**
   * Handle keyboard navigation. Mirrors Tabs.tsx handleKeyDown exactly:
   * - ArrowRight / ArrowLeft: move focus (with wrap)
   * - Home: first item
   * - End: last item
   * - Tab / Shift-Tab: NOT intercepted — exits toolbar (ARIA 1.2 §3.25)
   *
   * Arrow/Home/End navigation keys are suppressed when the event target is a
   * text input — ToolbarSearch must keep its cursor-movement behavior.
   */
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const { key } = e;

    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(key)) return;

    if (eventTargetIsTextEditable(e.target)) return;

    const toolbar = toolbarRef.current;
    if (!toolbar) return;

    const items = getToolbarItems(toolbar);
    if (items.length === 0) return;

    const current = items.indexOf(document.activeElement as HTMLElement);
    // If focus is inside the toolbar but not on a tracked item, default to 0
    const from = current >= 0 ? current : 0;

    let next = from;
    if (key === 'ArrowRight') next = (from + 1) % items.length;
    if (key === 'ArrowLeft') next = (from - 1 + items.length) % items.length;
    if (key === 'Home') next = 0;
    if (key === 'End') next = items.length - 1;

    e.preventDefault();
    activeIndexRef.current = next;
    applyRoving(items, next);
    items[next]?.focus();
  }, [applyRoving]);

  /**
   * When focus enters the toolbar, apply roving tabindex from scratch so the
   * DOM state is consistent. Preserve the last active index if possible, else
   * default to 0.
   */
  const handleFocus = useCallback((e: FocusEvent<HTMLDivElement>) => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const items = getToolbarItems(toolbar);
    if (items.length === 0) return;
    const target = e.target instanceof HTMLElement && toolbar.contains(e.target) ? e.target : null;
    const current = target ? items.indexOf(target) : -1;
    const idx = current >= 0 ? current : Math.min(activeIndexRef.current, items.length - 1);
    // Direct focus/click entry must become the next roving origin.
    activeIndexRef.current = idx;
    applyRoving(items, idx);
  }, [applyRoving]);

  const flushClass = flush ? 'soup-toolbar--flush' : '';
  const toolbarClass = ['soup-toolbar', flushClass, className].filter(Boolean).join(' ');

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={ariaLabel}
      className={toolbarClass}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
    >
      {children}
    </div>
  );
};

// ---------------------------------------------------------------------------
// ToolbarFilters — filter group (role="group" + label, interactive Pills)
// ---------------------------------------------------------------------------

export interface ToolbarFiltersProps {
  /** Required accessible label for the filter group. */
  label: string;
  /** Interactive Pill elements supplied by caller. */
  children: ReactNode;
}

export const ToolbarFilters: FC<ToolbarFiltersProps> = ({ label, children }) => (
  <div role="group" aria-label={label} className="soup-toolbar-filters">
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// ToolbarTimeRange — segmented time-range control
// ---------------------------------------------------------------------------

export interface TimeRangeOption {
  label: string;
  value: string;
}

export interface ToolbarTimeRangeProps {
  /** Required accessible label for the seg group. */
  label: string;
  /** Available options. */
  options: TimeRangeOption[];
  /** Currently selected value — exactly one option is pressed. */
  value: string;
  /** Called with the new value when a segment button is activated. */
  onChange: (value: string) => void;
  /**
   * When true, all segment buttons are disabled and onChange is not called.
   * Default undefined — existing consumers are byte-identical (C-B3W3-2).
   * Used by GroupDetailModal settings pairs during in-flight saves to preserve
   * the legacy double-fire protection while gaining the disabled AT affordance.
   */
  disabled?: boolean;
}

export const ToolbarTimeRange: FC<ToolbarTimeRangeProps> = ({
  label,
  options,
  value,
  onChange,
  disabled,
}) => (
  <div role="group" aria-label={label} className="soup-toolbar-seg">
    {options.map((opt) => (
      <button
        key={opt.value}
        type="button"
        className="soup-toolbar-seg__btn"
        aria-pressed={value === opt.value}
        disabled={disabled}
        onClick={() => { if (!disabled) onChange(opt.value); }}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// ToolbarSearch — compact 28px search input
// ---------------------------------------------------------------------------

export interface ToolbarSearchProps {
  /** Required accessible label (visible label or aria-label). */
  label: string;
  /** Current value. */
  value: string;
  /** Called on input change. */
  onChange: ChangeEventHandler<HTMLInputElement>;
  /** Input placeholder text. */
  placeholder?: string;
  /** Additional class names. */
  className?: string;
  /** Marks this input as the global search shortcut target. */
  shortcutTarget?: boolean;
}

export const ToolbarSearch: FC<ToolbarSearchProps> = ({
  label,
  value,
  onChange,
  placeholder = 'Search…',
  className,
  shortcutTarget = false,
}) => {
  const inputClass = ['soup-toolbar-search', className].filter(Boolean).join(' ');
  return (
    <label className="soup-toolbar-search-wrap">
      <span className="soup-toolbar-search__label">{label}</span>
      <input
        type="search"
        className={inputClass}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-label={label}
        data-search-shortcut-target={shortcutTarget ? 'true' : undefined}
      />
    </label>
  );
};

// ---------------------------------------------------------------------------
// ToolbarSpring — flex spring (fills available space)
// ---------------------------------------------------------------------------

export const ToolbarSpring: FC = () => (
  <div className="soup-toolbar-spring" aria-hidden="true" />
);
