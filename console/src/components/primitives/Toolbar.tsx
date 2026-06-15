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
 */
import { type FC, type ReactNode, type ChangeEventHandler } from 'react';

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
  const flushClass = flush ? 'soup-toolbar--flush' : '';
  const toolbarClass = ['soup-toolbar', flushClass, className].filter(Boolean).join(' ');

  return (
    <div role="toolbar" aria-label={ariaLabel} className={toolbarClass}>
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
