/**
 * ActionButton.tsx — the ONE reveal-label icon-action mechanic (button.md).
 *
 * 28×28px minimum hit area. Icon 18px. Text label expands on hover/focus-visible
 * (max-width 0→120px). Danger flavor recolors to crit channel.
 *
 * The `label` prop is REQUIRED — it is the accessible name of the button.
 * Reduced motion: label appears instantly (no width animation).
 */
import { type FC, type ReactNode, type ButtonHTMLAttributes } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required accessible name AND visible reveal text. */
  label: string;
  /** Icon element (18px recommended). */
  icon?: ReactNode;
  /** When true: recolors to crit channel on hover/focus. */
  danger?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ActionButton: FC<ActionButtonProps> = ({
  label,
  icon,
  danger = false,
  className,
  type = 'button',
  ...rest
}) => {
  const dangerClass = danger ? ' soup-actbtn--danger' : '';
  const composedClass = ['soup-actbtn', dangerClass, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type={type}
      className={composedClass}
      aria-label={label}
    >
      {icon && <span aria-hidden="true">{icon}</span>}
      <span className="soup-actbtn__label" aria-hidden="true">
        {label}
      </span>
    </button>
  );
};
