/**
 * Accordion.tsx — the progressive-disclosure primitive (showcase §21; DD-43).
 *
 * The last unbuilt P0 toolkit primitive. Built on native <details>/<summary>
 * semantics — the native element carries the disclosure semantics (open/closed
 * state, Space/Enter activation, focus on the summary) for free, so the only
 * things this primitive adds are:
 *
 *   - one canonical focus recipe on the <summary> (the SAME focus-visible
 *     string the other primitives use, lifted verbatim from Card.tsx);
 *   - a rotating chevron that visually tracks the open/closed state;
 *   - a body region for the folded content;
 *   - a group wrapper that lays out multiple items with hairline dividers;
 *   - the reduced-motion LAW (motion.md §9): the chevron rotation is REMOVED,
 *     not shortened, under prefers-reduced-motion (off-and-instant).
 *
 * The leaf explicitly defers forced single-open exclusivity (each <details> is
 * independent); the wrapper is a styled container, not a controller.
 *
 * Visual target: showcase §21 — hairline-divided rows, summary label + rotating
 * chevron, body that reveals on open. Tokens only — no raw px/hex/z.
 */
import { type FC, type ReactNode, useId } from 'react';
import { ChevronRight } from 'lucide-react';

// ---------------------------------------------------------------------------
// AccordionItem
// ---------------------------------------------------------------------------

export interface AccordionItemProps {
  /**
   * Summary label rendered inside the <summary>. Accepts a ReactNode so a
   * consumer can compose an inline glyph + text or a richer label, but a plain
   * string is the common case.
   */
  label: ReactNode;
  /** Open the item by default on first paint. Native <details open>. */
  defaultOpen?: boolean;
  /** Folded body content. Rendered inside the <details>, after the summary. */
  children: ReactNode;
  className?: string;
}

/**
 * One disclosure row — native <details>/<summary>, the one focus recipe on the
 * summary, a chevron that rotates 90° on [open]. The body sits below; it
 * inherits flow so callers can compose any block (paragraphs, kv rows, panels).
 */
export const AccordionItem: FC<AccordionItemProps> = ({
  label,
  defaultOpen = false,
  children,
  className,
}) => {
  // Stable ids so assistive tech can associate the summary and the body if
  // the caller composes the item outside a wrapping Accordion group.
  const reactId = useId();
  const summaryId = `soup-accordion-summary-${reactId}`;
  const bodyId = `soup-accordion-body-${reactId}`;

  const detailsClass = ['soup-accordion__item', className].filter(Boolean).join(' ');

  return (
    <details className={detailsClass} {...(defaultOpen ? { open: true } : {})}>
      <summary
        id={summaryId}
        className="soup-accordion__summary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        aria-controls={bodyId}
      >
        <span className="soup-accordion__label">{label}</span>
        <span className="soup-accordion__chev" aria-hidden="true">
          <ChevronRight size={16} strokeWidth={1.75} />
        </span>
      </summary>
      <div id={bodyId} className="soup-accordion__body" role="region" aria-labelledby={summaryId}>
        {children}
      </div>
    </details>
  );
};

// ---------------------------------------------------------------------------
// Accordion (group wrapper)
// ---------------------------------------------------------------------------

export interface AccordionProps {
  /** One or more AccordionItem children. */
  children: ReactNode;
  className?: string;
}

/**
 * Optional group wrapper for multiple AccordionItems. Lays them out as a
 * hairline-divided stack. Each item remains an independent <details>, so
 * opening one does not close the others — single-open exclusivity is OUT OF
 * SCOPE for this primitive (the leaf defers it; consumers that need it can
 * coordinate via their own state).
 */
export const Accordion: FC<AccordionProps> = ({ children, className }) => {
  const groupClass = ['soup-accordion', className].filter(Boolean).join(' ');
  return <div className={groupClass}>{children}</div>;
};