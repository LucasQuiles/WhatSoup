/**
 * Switch.tsx — the boolean toggle primitive (showcase §15 Switch).
 *
 * A `role="switch"` control distinct from CheckboxField: a checkbox opts into a
 * set, a Switch flips a single on/off setting (auto-respond, business-hours-only).
 *
 * Anatomy: a `<button role="switch">` track with a sliding thumb. The button
 * element gives us native keyboard activation (Space AND Enter fire click) and
 * `:focus-visible` for free, so there is no synthetic key handling to drift.
 *
 * Features:
 *   - role="switch" + aria-checked reflecting the boolean state.
 *   - Keyboard: Space/Enter toggle (native button behaviour).
 *   - focus-visible ring via the shared --focus-ring recipe.
 *   - disabled state (no toggle, dimmed track).
 *   - Label association: when a `label` is provided it is rendered as a sibling
 *     and wired to the control with `aria-labelledby` (useId) so SR users hear
 *     the setting name; an explicit `aria-label` is honoured for icon-only rows.
 *   - Reduced motion: the thumb slide transition is removed (not shortened) via
 *     the stylesheet @media (prefers-reduced-motion: reduce) block — no JS check.
 */
import { type FC, type ReactNode, useId } from 'react';

export interface SwitchProps {
  /** Current on/off state. */
  checked: boolean;
  /** Called with the next boolean when the user toggles. Not called when disabled. */
  onChange: (checked: boolean) => void;
  /**
   * Visible label rendered beside the track and wired via aria-labelledby.
   * Omit for icon-only rows that supply `aria-label` instead.
   */
  label?: ReactNode;
  /** Accessible name when no visible `label` is rendered. */
  'aria-label'?: string;
  /** Disables toggling and dims the track. */
  disabled?: boolean;
  /** Optional id for the control button (label association / external wiring). */
  id?: string;
  /** Extra class on the row wrapper. */
  className?: string;
}

export const Switch: FC<SwitchProps> = ({
  checked,
  onChange,
  label,
  'aria-label': ariaLabel,
  disabled = false,
  id,
  className,
}) => {
  const autoId = useId();
  const buttonId = id ?? `soup-switch-${autoId}`;
  const labelId = `${buttonId}-label`;
  const hasLabel = label !== undefined && label !== null && label !== false;

  const rowClass = ['soup-switch-row', className].filter(Boolean).join(' ');
  const trackClass = ['soup-switch', checked ? 'soup-switch--on' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rowClass}>
      {hasLabel && (
        <span id={labelId} className="soup-switch__label">
          {label}
        </span>
      )}
      <button
        type="button"
        id={buttonId}
        role="switch"
        aria-checked={checked}
        aria-label={hasLabel ? undefined : ariaLabel}
        aria-labelledby={hasLabel ? labelId : undefined}
        disabled={disabled}
        className={trackClass}
        onClick={() => onChange(!checked)}
      >
        <span aria-hidden="true" className="soup-switch__thumb" />
      </button>
    </div>
  );
};
