/**
 * Checkbox.tsx — the boolean selection primitive (showcase §17 Checkbox).
 *
 * Distinct from CheckboxField (form-kit, label-wrapped, helper-text capable):
 * Checkbox is the BARE checkbox used inside table cells and selection bars where
 * the consumer owns the row layout. A checkbox opts a row or feature into a set;
 * a Switch flips a single on/off setting.
 *
 * Anatomy: a single <input type="checkbox"> visually styled via the project
 * token system. The native element is intentionally kept (not a <button> or
 * <div role="checkbox">) because:
 *   - Native keyboard activation: Space toggles, in DOM tab order.
 *   - The DOM `.indeterminate` property is part of the HTMLCheckBoxElement
 *     interface; setting it through a ref is the only sanctioned way to surface
 *     the partial-selection state.
 *   - The shadow-lint no-raw-form-control rule exempts `components/primitives/**`
 *     (the primitive IS the canonical renderer; eslint.config.shadow.mjs).
 *
 * Features:
 *   - `checked` / `onChange` — controlled. `onChange` is called with the next
 *     boolean (not the synthetic event), matching the Switch contract.
 *   - `indeterminate` — sets the DOM `.indeterminate` property via a ref effect.
 *     Independent of `checked`; can be combined with checked=false (e.g. the
 *     "select-all" header when some but not all rows are selected).
 *   - `disabled` — blocks toggle and applies the dim treatment.
 *   - `label` — accessible name. When present, rendered as a sibling and wired
 *     via aria-labelledby (useId); when absent, an explicit `aria-label` is
 *     required and passed through to the input.
 *   - focus ring — the canonical focus-visible recipe (--focus-ring).
 *
 * Styling: tokens only. The box is 16×16 (--sp-4) with hairline border, accent
 * fill when checked, indeterminate fills the box with an em-dash hint.
 */
import {
  type FC,
  type InputHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from 'react';
import { Check, Minus } from 'lucide-react';

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  /** Current checked state. */
  checked: boolean;
  /** Called with the next boolean when the user toggles. */
  onChange: (checked: boolean) => void;
  /** Visible label rendered beside the box and wired via aria-labelledby. */
  label?: string;
  /** Sets the DOM `.indeterminate` property — independent of `checked`. */
  indeterminate?: boolean;
  /** Disables toggling; the box dims and ignores pointer/keyboard. */
  disabled?: boolean;
  /** Optional class on the row wrapper. */
  className?: string;
}

export const Checkbox: FC<CheckboxProps> = ({
  checked,
  onChange,
  label,
  indeterminate = false,
  disabled = false,
  className,
  id,
  ...rest
}) => {
  const autoId = useId();
  const inputId = id ?? `soup-checkbox-${autoId}`;
  const labelId = `${inputId}-label`;
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Apply indeterminate via a ref effect: it is a DOM property, not an attribute,
  // so it cannot be expressed in JSX. The value tracks both `indeterminate`
  // and the re-render cycle so toggling the prop on/off updates the live state.
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  const rowClass = ['soup-checkbox-row', className].filter(Boolean).join(' ');
  const boxClass = [
    'soup-checkbox',
    checked ? 'soup-checkbox--on' : '',
    indeterminate ? 'soup-checkbox--indeterminate' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // The native input is visually hidden but kept in the DOM/tab order for native
  // keyboard + a11y; the visible box is a sibling span carrying the lucide glyph
  // (indeterminate wins over checked). The focus-visible ring renders on the box
  // via the `:focus-visible + .soup-checkbox` sibling rule. The <label> wrapper
  // makes the whole control toggle the input on click.
  return (
    <label className={rowClass}>
      <input
        ref={inputRef}
        id={inputId}
        type="checkbox"
        className="soup-checkbox-input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label === undefined ? rest['aria-label'] : undefined}
        aria-labelledby={label !== undefined ? labelId : undefined}
        {...rest}
      />
      <span className={boxClass} aria-hidden="true">
        {indeterminate ? (
          <Minus size={12} strokeWidth={3} />
        ) : checked ? (
          <Check size={12} strokeWidth={3} />
        ) : null}
      </span>
      {label !== undefined && (
        <span id={labelId} className="soup-checkbox__label">
          {label}
        </span>
      )}
    </label>
  );
};

export default Checkbox;
