/**
 * primitives/index.ts — barrel export for SOUP v3 primitive components.
 *
 * Badge (StatusCell + ModeBadge), Button, ActionButton.
 * All consumers import from this barrel; never import from individual files.
 */
export { StatusCell, ModeBadge } from './Badge';
export type { StatusCellProps, ModeBadgeProps } from './Badge';

export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { ActionButton } from './ActionButton';
export type { ActionButtonProps } from './ActionButton';
