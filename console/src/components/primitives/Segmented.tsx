/**
 * Segmented.tsx — the canonical segmented control (segmented.md).
 *
 * A generic, `Toolbar`-namespace-independent implementation of the role="group"
 * + aria-pressed exactly-one primitive that backs both the `ToolbarTimeRange`
 * (toolbar time-scoping) and the `DateTimePicker` recurrence row. The CSS
 * recipe (`.soup-toolbar-seg`, `.soup-toolbar-seg__btn`) is unchanged: this
 * primitive is byte-identical markup to the prior `ToolbarTimeRange` body.
 *
 * Markup (frozen — every existing test on `ToolbarTimeRange`/`DateTimePicker`
 * keys off this DOM):
 *   <div role="group" aria-label={label} className="soup-toolbar-seg">
 *     <button type="button" className="soup-toolbar-seg__btn"
 *             aria-pressed={value === opt.value} disabled={disabled}
 *             onClick={() => { if (!disabled) onChange(opt.value); }} />
 *   </div>
 *
 * DD-32 resolution: `ToolbarTimeRange` is now a thin delegation to `Segmented`.
 * The naming ruling is "extract" (this primitive exists as the canonical seg
 * recipe; `ToolbarTimeRange` keeps its name for back-compat with the wave-2
 * toolbar consumption and the documented toolbar.md anatomy).
 */
import { type FC } from 'react';

export interface SegmentedOption {
  /** Visible label for the segment button. */
  label: string;
  /** Stable value passed to `onChange` and matched against `value` for pressed state. */
  value: string;
}

export interface SegmentedProps {
  /** Required accessible label for the seg group (group role). */
  label: string;
  /** Available segment options. Order = visual + DOM order. */
  options: ReadonlyArray<SegmentedOption>;
  /** Currently selected value — exactly one segment is `aria-pressed=true`. */
  value: string;
  /** Called with the new value when a segment button is activated. */
  onChange: (value: string) => void;
  /**
   * When true, all segment buttons are `disabled` and `onChange` is not called.
   * Default undefined — existing consumers are byte-identical.
   */
  disabled?: boolean;
}

export const Segmented: FC<SegmentedProps> = ({
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
