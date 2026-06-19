/**
 * HoverCard.tsx — interactive hover/focus disclosure card (showcase §43, DD-43).
 *
 * Distinct from Tooltip: a Tooltip is a NON-interactive accelerator bubble that closes
 * the instant the pointer leaves the trigger. A HoverCard's content is INTERACTIVE
 * (the pointer must be able to travel onto the card to read/copy/click it), so this
 * primitive adds the two things the Tooltip contract fundamentally cannot provide:
 *
 *   1. Hover-bridge — the card has its own mouseenter/leave; while the pointer is over
 *      EITHER the trigger or the card, the card stays open. Moving trigger→card does
 *      not collapse it.
 *   2. Open/close debounce — `openDelay` avoids flicker on fast pointer traversal;
 *      `closeDelay` gives the pointer time to cross the gap onto the card.
 *
 * Contract (interaction-patterns.md §45 — "never the sole carrier"):
 *   - Hover is never required: keyboard focus on the trigger also opens the card, and
 *     the trigger carries `aria-expanded` + `aria-controls` so SR users reach it.
 *   - Escape closes without moving focus off the trigger (single-layer, stopPropagation).
 *   - The card is a labelled region (`role="group"` + `aria-label`), NOT a modal — it
 *     does not trap focus or render an inert backdrop.
 *
 * Placement: reuses `resolveViewportPlacement` (the sanctioned viewport owner) to flip
 * above↔below on top-edge collision. No raw matchMedia/innerWidth (soup/no-raw-viewport-js).
 *
 * NOTE (browser-proven follow-on): clip-escape via a portal is intentionally NOT in this
 * primitive yet — it requires real-browser visual proof (portal placement, reduced motion,
 * theme) that JSDOM cannot give. Tracked for the consumer-migration packet.
 */
import {
  type FC,
  type ReactNode,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  resolveViewportPlacement,
  type ViewportPlacement,
} from '../../hooks/useViewportPlacement';

/** Estimated card box for the top-edge clip check (above↔below flip). */
const ESTIMATED_CARD_HEIGHT = 160;
const ESTIMATED_CARD_WIDTH = 260;
const DEFAULT_OPEN_DELAY = 150;
const DEFAULT_CLOSE_DELAY = 180;

export interface HoverCardProps {
  /** Interactive card content. Per §45 the same information must live durably elsewhere too. */
  card: ReactNode;
  /** Accessible name for the card region (it is `role="group"`). */
  cardLabel: string;
  /** The focusable trigger — a single element that receives hover/focus/Esc + aria wiring. */
  children: ReactElement<Record<string, unknown>>;
  /** Optional id for the card region (aria-controls target). */
  id?: string;
  /** Open debounce in ms (default 150) — suppresses flicker on fast pointer traversal. */
  openDelay?: number;
  /** Close debounce in ms (default 180) — lets the pointer cross the gap onto the card. */
  closeDelay?: number;
  /** Extra class on the positioned anchor wrapper. */
  className?: string;
}

export const HoverCard: FC<HoverCardProps> = ({
  card,
  cardLabel,
  children,
  id,
  openDelay = DEFAULT_OPEN_DELAY,
  closeDelay = DEFAULT_CLOSE_DELAY,
  className,
}) => {
  const autoId = useId();
  const cardId = id ?? `soup-hovercard-${autoId}`;

  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<ViewportPlacement>('above');
  const anchorRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  // Clean up any pending timer on unmount so a debounce can't fire into a gone tree.
  useEffect(() => clearTimers, [clearTimers]);

  /**
   * Measure the anchor and resolve above/below. Zero-rect guard mirrors Tooltip: jsdom
   * returns an all-zero rect, so keep the default 'above' for suites that don't stub
   * getBoundingClientRect.
   */
  const measure = useCallback(() => {
    const node = anchorRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) return;
    const resolved = resolveViewportPlacement({
      anchorRect: rect,
      estimatedCardHeight: ESTIMATED_CARD_HEIGHT,
      estimatedCardWidth: ESTIMATED_CARD_WIDTH,
    });
    setPlacement(resolved.placement);
  }, []);

  const scheduleOpen = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      measure();
      setOpen(true);
    }, openDelay);
  }, [open, openDelay, measure]);

  const scheduleClose = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, closeDelay);
  }, [closeDelay]);

  // Focus opens immediately (hover never sole carrier); blur closes via the same
  // debounce so focus moving INTO the card (which lives in the wrapper) doesn't collapse it.
  const onFocus = useCallback(() => {
    clearTimers();
    measure();
    setOpen(true);
  }, [clearTimers, measure]);

  const onBlur = useCallback(() => {
    scheduleClose();
  }, [scheduleClose]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        clearTimers();
        setOpen(false);
      }
    },
    [open, clearTimers],
  );

  const sideClass = placement === 'below' ? 'soup-hovercard__panel--bottom' : 'soup-hovercard__panel--top';
  const panelClass = ['soup-hovercard__panel', sideClass, open ? 'soup-hovercard__panel--show' : '']
    .filter(Boolean)
    .join(' ');
  const anchorClass = ['soup-hovercard', className].filter(Boolean).join(' ');

  // Disclosure wiring on the real trigger: aria-expanded + aria-controls so keyboard/SR
  // users know the card exists and is reachable (merging any existing aria-controls).
  const existingControls =
    isValidElement(children) && typeof children.props['aria-controls'] === 'string'
      ? (children.props['aria-controls'] as string)
      : undefined;
  const controls = [existingControls, cardId].filter(Boolean).join(' ');
  const trigger = cloneElement(children, { 'aria-expanded': open, 'aria-controls': controls });

  return (
    <span
      ref={anchorRef}
      className={anchorClass}
      // Wrapper-level pointer handlers cover BOTH the trigger and the card (both live
      // inside this span), so a single enter/leave pair implements the hover-bridge:
      // leaving the trigger toward the card stays "inside" → no leave event fires.
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      {trigger}
      <span
        id={cardId}
        role="group"
        aria-label={cardLabel}
        data-placement={placement}
        aria-hidden={open ? undefined : true}
        className={panelClass}
      >
        {card}
      </span>
    </span>
  );
};
