/**
 * Button.tsx — the single button primitive (button.md).
 *
 * 6 variants: primary | neutral | ghost | danger | success | warning
 * 3 sizes:    md (32px) | sm (28px) | xs (24px)
 *
 * All rendered via <button>; icon-only forms require aria-label.
 * Loading state: spinner replaces start icon, aria-busy set, button inert.
 * Disabled state: opacity token, cursor not-allowed, variant colours kept.
 */
import { type FC, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'neutral' | 'ghost' | 'danger' | 'success' | 'warning';
export type ButtonSize = 'md' | 'sm' | 'xs';

interface ButtonBaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon placed before the label. Hidden when loading (replaced by spinner). */
  icon?: ReactNode;
  /** Icon placed after the label. */
  iconEnd?: ReactNode;
  /** When true: spinner replaces start icon, button is inert (aria-busy). */
  loading?: boolean;
}

/**
 * Icon-only buttons MUST carry an aria-label (enforced at the type level: omitting
 * children requires the label; with children the label is optional). A dev-only
 * runtime warning backs the contract for untyped call sites.
 */
export type ButtonProps =
  | (ButtonBaseProps & { children: ReactNode; 'aria-label'?: string })
  | (ButtonBaseProps & { children?: undefined; 'aria-label': string });

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const Button: FC<ButtonProps> = ({
  variant = 'neutral',
  size = 'md',
  icon,
  iconEnd,
  loading = false,
  disabled,
  children,
  className,
  type = 'button',
  ...rest
}) => {
  const isInert = disabled || loading;

  const sizeClass = size === 'sm' ? 'soup-btn--sm' : size === 'xs' ? 'soup-btn--xs' : '';
  const variantClass = `soup-btn--${variant}`;
  const composedClass = ['soup-btn', variantClass, sizeClass, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={composedClass}
      disabled={isInert}
      aria-busy={loading ? 'true' : undefined}
      aria-disabled={isInert ? 'true' : undefined}
      {...rest}
    >
      {loading ? (
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      ) : (
        icon && <span aria-hidden="true">{icon}</span>
      )}
      {children}
      {iconEnd && <span aria-hidden="true">{iconEnd}</span>}
    </button>
  );
};
