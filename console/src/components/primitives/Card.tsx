/**
 * Card.tsx — the one card-surface primitive (card.md; DD-38).
 *
 * Absorbed the raw `.c-card` recipe (DD-38 closeout: now `.soup-card` in primitives.css) so the card contract is enforceable in one place
 * (card-via-primitive). Visual target: showcase §18 (Card primitive family).
 *
 * Variants (mirrors §18):
 *   - base        — neutral panel container (the default; the 13 c-card consumers' shape).
 *                   Renders the absorbed recipe verbatim (`.soup-card`) → zero visual change for
 *                   migrated consumers. Optional header/footer slots.
 *   - interactive — renders a real <button> (interactive-card-is-button law, never a click
 *                   <div>): the shared `c-hover` lift + the ONE focus recipe (2px --focus-ring,
 *                   2px offset) + user-select:none. Destructive actions must route through
 *                   ConfirmDialog at the call site, never fire inline.
 *   - kpi         — headerless stat layout: a centred, monospace tabular-nums numeral lane.
 *   - selectable  — a button card carrying aria-pressed + an accent border/inset ring; the
 *                   selection survives forced-colors via the ring, not colour alone.
 *   - status-edge — a 2px inset channel border keyed to a status; per color.md §6 the severity
 *                   must ALSO carry a shape + text at the call site — the edge is never the sole
 *                   signal.
 *
 * Note (DD-38, deferred): the §18 "lit-from-above" inset highlight is a showcase flourish with
 * no production token (dark `--shadow-raised` is `none`). Adding it touches tokens.semantic.css
 * (theme-parity + token-spec-drift + burndown) and is held for a separately-gated token step so
 * the base variant stays byte-faithful to the absorbed recipe.
 */
import { createElement } from 'react';
import type { ReactNode, HTMLAttributes } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CardVariant = 'base' | 'interactive' | 'kpi' | 'selectable' | 'status-edge';
export type CardEdge = 'ok' | 'warn' | 'crit';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Visual/behavioural family. Default 'base'. */
  variant?: CardVariant;
  /**
   * Element override for the non-interactive families ('base' | 'kpi' | 'status-edge').
   * 'section' renders a semantic <section> (the landmark-card consumers).
   * 'interactive'/'selectable' always render a <button> regardless (interactive-card-is-button);
   * an href additionally forces an <a> — neither path is reachable via 'section'. Default 'div'.
   */
  as?: 'div' | 'button' | 'a' | 'section';
  /** 'selectable' only — drives aria-pressed + the accent border/inset ring. */
  selected?: boolean;
  /** 'status-edge' only — the channel the inset edge is keyed to (pair with a shape + label). */
  edge?: CardEdge;
  /** Link target — forces <a> semantics for an interactive card. */
  href?: string;
  /** Interactive/selectable only — inert styling + aria-disabled. */
  disabled?: boolean;
  /** Optional header slot (rendered above the body, hairline-divided). */
  header?: ReactNode;
  /** Optional footer slot (rendered below the body, hairline-divided). */
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
  // Ref forwarding is intentionally omitted: a polymorphic ref over div|button|a needs
  // per-variant typing and trips react-hooks/refs through createElement. No current
  // consumer needs it; add it with a typed overload when one does.
}

// status-edge channel → status-solid token (the same channel tokens the status law uses).
const EDGE_TOKEN: Record<CardEdge, string> = {
  ok: 'var(--status-ok-solid)',
  warn: 'var(--status-warn-solid)',
  crit: 'var(--status-crit-solid)',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Card({
  variant = 'base',
  as = 'div',
  selected = false,
  edge,
  href,
  disabled = false,
  header,
  footer,
  className,
  children,
  style,
  ...rest
}: CardProps) {
  const isInteractive = variant === 'interactive' || variant === 'selectable';
  // Polymorphic tag: interactive/selectable (and as='button') render a real <button>; an href
  // forces <a>; otherwise the requested element (default 'div'). createElement (vs JSX) keeps
  // the union tag from over-narrowing and lets `ref` flow without a per-element cast.
  const tag: 'div' | 'button' | 'a' | 'section' = href ? 'a' : isInteractive || as === 'button' ? 'button' : as;
  const isButtonTag = tag === 'button';

  // Token-only utility composition. `soup-card` (primitives.css) carries
  // bg/border/radius/shadow verbatim — the absorbed DD-38 recipe.
  const composedClass = [
    'soup-card',
    variant === 'kpi' && 'flex flex-col',
    isInteractive &&
      'c-hover cursor-pointer select-none text-left w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
    variant === 'selectable' && selected && 'border-[color:var(--accent)] shadow-[inset_0_0_0_var(--bw)_var(--accent)]',
    disabled && 'opacity-[var(--opacity-disabled)] cursor-not-allowed',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const edgeStyle =
    variant === 'status-edge' && edge
      ? { borderLeftStyle: 'solid' as const, borderLeftWidth: 'var(--bw-accent)', borderLeftColor: EDGE_TOKEN[edge] }
      : undefined;

  const elementProps: Record<string, unknown> = {
    className: composedClass,
    style: edgeStyle ? { ...edgeStyle, ...style } : style,
    ...rest,
  };
  // Interactive/selectable attributes — only on the <button>/<a> families.
  if (isInteractive) {
    if (isButtonTag) {
      elementProps.type = 'button';
      elementProps.disabled = disabled;
    }
    if (href) elementProps.href = href;
    if (disabled) elementProps['aria-disabled'] = 'true';
    if (variant === 'selectable') elementProps['aria-pressed'] = selected;
  }

  const body =
    header || footer ? (
      <>
        {header}
        {children}
        {footer}
      </>
    ) : (
      children
    );

  return createElement(tag, elementProps, body);
}
