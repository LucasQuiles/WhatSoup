/**
 * Pill.tsx — the one chip/tag/filter primitive (pill.md).
 *
 * Tone × size × variant (static | interactive | removable).
 *
 * Tones:
 *   neutral — --text-2 / --btn-neutral-bg / --border-subtle
 *   ok / warn / crit — status channel tokens
 *   passive / chat / agent — mode channel tokens
 *   accent — accent channel tokens
 *
 * Sizes:
 *   default (md) — 20px height; 24px when interactive (WCAG target floor)
 *   sm — 16px height; 20px when interactive (reduced height only)
 *
 * Variants:
 *   static (default) — plain <span>
 *   interactive — <button> with aria-pressed toggle semantics
 *   removable — <span> with a trailing 24px-hit-area remove ActionButton
 *
 * No motion on removal (pill.md: removal is instant).
 */
import { type FC, type ReactNode, type ButtonHTMLAttributes, useId } from 'react';
import { X } from 'lucide-react';
import { ActionButton } from './ActionButton';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PillTone =
  | 'neutral'
  | 'ok'
  | 'warn'
  | 'crit'
  | 'passive'
  | 'chat'
  | 'agent'
  | 'accent';

export type PillSize = 'md' | 'sm';

interface PillBaseProps {
  tone?: PillTone;
  size?: PillSize;
  /** Optional leading count in the data lane (e.g. filter counts). */
  count?: number;
  className?: string;
}

/**
 * Static pill — a <span>. Non-interactive informational chip.
 */
export interface StaticPillProps extends PillBaseProps {
  variant?: 'static';
  children: ReactNode;
}

/**
 * Interactive pill — a <button> with aria-pressed toggle semantics.
 * 24px hit floor enforced via soup-pill--interactive class.
 */
export interface InteractivePillProps
  extends PillBaseProps,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant: 'interactive';
  /** Pressed/selected state exposed as aria-pressed. */
  pressed: boolean;
  children: ReactNode;
}

/**
 * Removable pill — a <span> with a trailing remove button.
 * The remove button carries aria-label="Remove <label>".
 */
export interface RemovablePillProps extends PillBaseProps {
  variant: 'removable';
  /** The chip label — used both for display and to construct the aria-label. */
  children: string;
  /** Called when the remove button is activated. */
  onRemove: () => void;
  /** Optional aria-label override for the remove button. */
  removeLabel?: string;
}

export type PillProps = StaticPillProps | InteractivePillProps | RemovablePillProps;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toneClass(tone: PillTone): string {
  switch (tone) {
    case 'ok':      return 'soup-pill--ok';
    case 'warn':    return 'soup-pill--warn';
    case 'crit':    return 'soup-pill--crit';
    case 'passive': return 'soup-pill--passive';
    case 'chat':    return 'soup-pill--chat';
    case 'agent':   return 'soup-pill--agent';
    case 'accent':  return 'soup-pill--accent';
    default:        return 'soup-pill--neutral';
  }
}

function buildClass(tone: PillTone, size: PillSize, extra: string[], className?: string): string {
  return [
    'soup-pill',
    toneClass(tone),
    size === 'sm' ? 'soup-pill--sm' : '',
    ...extra,
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const Pill: FC<PillProps> = (props) => {
  // Hooks must run unconditionally before the per-variant branches.
  const countId = `soup-pill-count-${useId()}`;
  if (props.variant === 'interactive') {
    const tone = props.tone ?? 'neutral';
    const size = props.size ?? 'md';
    const { pressed, children, count, className } = props;
    // Extract non-DOM props to avoid spreading them onto <button>
    const buttonProps: Omit<
      InteractivePillProps,
      'variant' | 'tone' | 'size' | 'pressed' | 'children' | 'count' | 'className'
    > = (() => {
      const rest = { ...props } as Partial<InteractivePillProps>;
      delete rest.variant; delete rest.tone; delete rest.size; delete rest.pressed;
      delete rest.children; delete rest.count; delete rest.className;
      return rest;
    })();
    const cls = buildClass(tone, size, [
      'soup-pill--interactive',
      pressed ? 'soup-pill--pressed' : '',
    ], className);
    return (
      <button
        type="button"
        aria-pressed={pressed}
        className={cls}
        {...buttonProps}
        aria-describedby={count !== undefined ? countId : undefined}
      >
        <span className="soup-pill__label">{children}</span>
        {count !== undefined && (
          // aria-hidden keeps the count OUT of the accessible NAME (name = label, stable
          // for muscle memory and tests); aria-describedby still computes a description
          // from hidden targets, so assistive tech announces the count after the name.
          <span id={countId} className="soup-pill__count" aria-hidden="true">{count}</span>
        )}
      </button>
    );
  }

  if (props.variant === 'removable') {
    const tone = props.tone ?? 'neutral';
    const size = props.size ?? 'md';
    const { children, count, className, onRemove, removeLabel } = props;
    const label = typeof children === 'string' ? children : '';
    const cls = buildClass(tone, size, ['soup-pill--removable'], className);
    return (
      <span className={cls}>
        <span className="soup-pill__label">{children}</span>
        {count !== undefined && (
          <span className="soup-pill__count" aria-hidden="true">{count}</span>
        )}
        <ActionButton
          label={removeLabel ?? `Remove ${label}`}
          icon={<X size={12} strokeWidth={1.75} />}
          className="soup-pill__remove"
          onClick={onRemove}
        />
      </span>
    );
  }

  // static (default)
  const tone = props.tone ?? 'neutral';
  const size = props.size ?? 'md';
  const { children, count, className } = props;
  const cls = buildClass(tone, size, [], className);
  return (
    <span className={cls}>
      {count !== undefined && (
        <span className="soup-pill__count" aria-hidden="true">{count}</span>
      )}
      {children}
    </span>
  );
};
