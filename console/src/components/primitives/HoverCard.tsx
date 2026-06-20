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
  type FocusEvent as ReactFocusEvent,
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
  /**
   * Horizontal anchoring. "center" (default) centers the panel over the trigger.
   * "edge" pins it to the trigger's left edge, flipping to the right edge near the
   * viewport's right border (driven by resolveViewportPlacement().rightAnchored) — the
   * model MessageBubble's detail card needs to avoid clipping at the conversation edge.
   */
  anchorX?: 'center' | 'edge';
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
  anchorX = 'center',
  className,
}) => {
  const autoId = useId();
  const cardId = id ?? `soup-hovercard-${autoId}`;

  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<ViewportPlacement>('above');
  const [rightAnchored, setRightAnchored] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when Escape explicitly dismisses the card; suppresses focus-reopen while focus
  // stays on the trigger. Cleared once the pointer/focus leaves and a fresh hover begins.
  const dismissedRef = useRef(false);
  // Independent pointer/focus presence (OR-semantics): the card stays open while EITHER
  // the pointer or keyboard focus is within the wrapper, and closes only once BOTH have
  // left — a keyboard user keeps the card as incidental mouse motion comes and goes, and
  // a hovering user keeps it across focus changes (the model MessageBubble's DD-18r §6.9).
  const pointerInsideRef = useRef(false);
  const focusInsideRef = useRef(false);

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
    setRightAnchored(resolved.rightAnchored);
  }, []);

  const scheduleOpen = useCallback(() => {
    // A fresh hover clears a prior Escape-dismissal so the card can open again.
    dismissedRef.current = false;
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

  // Schedule the close only when the wrapper holds NEITHER pointer nor focus. A leave on
  // one channel while the other is still inside is a no-op (the OR-semantics gate).
  const maybeScheduleClose = useCallback(() => {
    if (pointerInsideRef.current || focusInsideRef.current) return;
    scheduleClose();
  }, [scheduleClose]);

  const handleMouseEnter = useCallback(() => {
    pointerInsideRef.current = true;
    scheduleOpen();
  }, [scheduleOpen]);

  const handleMouseLeave = useCallback(() => {
    pointerInsideRef.current = false;
    maybeScheduleClose();
  }, [maybeScheduleClose]);

  // Focus opens immediately (hover never sole carrier) — unless the card was just
  // Escape-dismissed while the trigger keeps focus (don't resurrect it).
  const onFocus = useCallback(() => {
    focusInsideRef.current = true;
    if (dismissedRef.current) return;
    clearTimers();
    measure();
    setOpen(true);
  }, [clearTimers, measure]);

  // Close only when focus leaves the WHOLE wrapper. Focus moving from the trigger into
  // interactive card content keeps relatedTarget inside the wrapper → the card stays open
  // (a containment check, not event-ordering luck). Focus leaving the component clears the
  // dismissed latch and schedules the close only if the pointer is also gone (OR-semantics).
  const onBlur = useCallback(
    (event: ReactFocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && anchorRef.current?.contains(next)) return;
      focusInsideRef.current = false;
      dismissedRef.current = false;
      maybeScheduleClose();
    },
    [maybeScheduleClose],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        clearTimers();
        dismissedRef.current = true;
        setOpen(false);
      }
    },
    [open, clearTimers],
  );

  const sideClass = placement === 'below' ? 'soup-hovercard__panel--bottom' : 'soup-hovercard__panel--top';
  const alignClass =
    anchorX === 'edge'
      ? rightAnchored
        ? 'soup-hovercard__panel--align-right'
        : 'soup-hovercard__panel--align-left'
      : '';
  const panelClass = ['soup-hovercard__panel', sideClass, alignClass, open ? 'soup-hovercard__panel--show' : '']
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
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
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
        data-align={anchorX === 'edge' ? (rightAnchored ? 'right' : 'left') : 'center'}
        aria-hidden={open ? undefined : true}
        className={panelClass}
      >
        {/* Render interactive card content only while open: a closed card must not hold
            focusable descendants (they'd sit under aria-hidden and be a keyboard trap). */}
        {open ? card : null}
      </span>
    </span>
  );
};
