/**
 * Tooltip.tsx — the hover/focus tooltip primitive (showcase §24 Tooltip).
 *
 * Retires the hand-rolled DetailCard in MessageBubble.tsx (DD-43): one bubble on
 * the paid tokens (--tooltip-min-w / --tooltip-val-max) with the single focus
 * recipe, Esc-to-dismiss, top/bottom collision flip, and the lift removed (not
 * shortened) under reduced motion.
 *
 * Contract (interaction-patterns.md §45):
 *   - The bubble is NEVER the sole carrier of information — it is an accelerator.
 *   - The trigger stays focusable; the content is associated via `aria-describedby`
 *     on the anchor so keyboard and SR users reach the fact a `title` would hide.
 *   - Pointer (mouseenter/leave) AND keyboard focus reveal; blur/leave/Esc dismiss
 *     without moving focus off the trigger.
 *
 * Placement: reuses useViewportPlacement's `resolveViewportPlacement` — the
 * sanctioned viewport owner — to flip above↔below when the bubble would clip the
 * top edge. No raw matchMedia/innerWidth in component code (soup/no-raw-viewport-js).
 */
import {
  type FC,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  cloneElement,
  isValidElement,
  type ReactElement,
  useCallback,
  useId,
  useRef,
  useState,
} from 'react';
import {
  resolveViewportPlacement,
  type ViewportPlacement,
} from '../../hooks/useViewportPlacement';

/** Estimated bubble height used for the top-edge clip check (matches min-height stage). */
const ESTIMATED_BUBBLE_HEIGHT = 96;
/** Estimated bubble width — only feeds the (unused here) right-anchor signal. */
const ESTIMATED_BUBBLE_WIDTH = 220;

export interface TooltipProps {
  /** Tooltip body — text or rich content. Lives durably elsewhere too (§45). */
  content: ReactNode;
  /**
   * The focusable trigger. A single element that receives the hover/focus/Esc
   * handlers and the `aria-describedby` association.
   */
  children: ReactElement<Record<string, unknown>>;
  /** Optional id for the bubble (aria-describedby target). */
  id?: string;
  /** Extra class on the positioned anchor wrapper. */
  className?: string;
}

export const Tooltip: FC<TooltipProps> = ({ content, children, id, className }) => {
  const autoId = useId();
  const bubbleId = id ?? `soup-tooltip-${autoId}`;

  const [showByHover, setShowByHover] = useState(false);
  const [showByFocus, setShowByFocus] = useState(false);
  const [placement, setPlacement] = useState<ViewportPlacement>('above');
  const anchorRef = useRef<HTMLSpanElement>(null);

  const show = showByHover || showByFocus;

  /**
   * Measure the anchor and resolve above/below via the sanctioned placement owner.
   * Zero-rect guard: jsdom returns an all-zero rect — keep the default 'above'
   * so suites that do not stub getBoundingClientRect run unchanged.
   */
  const measure = useCallback(() => {
    const node = anchorRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) {
      return;
    }
    const resolved = resolveViewportPlacement({
      anchorRect: rect,
      estimatedCardHeight: ESTIMATED_BUBBLE_HEIGHT,
      estimatedCardWidth: ESTIMATED_BUBBLE_WIDTH,
    });
    setPlacement(resolved.placement);
  }, []);

  const onEnter = useCallback(() => {
    measure();
    setShowByHover(true);
  }, [measure]);

  const onLeave = useCallback(() => {
    setShowByHover(false);
  }, []);

  const onFocus = useCallback(() => {
    measure();
    setShowByFocus(true);
  }, [measure]);

  const onBlur = useCallback(() => {
    setShowByFocus(false);
  }, []);

  // Esc dismisses without moving focus off the trigger (§45). stopPropagation so a
  // tooltip inside a dialog does not also close the dialog (one-layer law §2).
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === 'Escape' && show) {
        event.stopPropagation();
        setShowByHover(false);
        setShowByFocus(false);
      }
    },
    [show],
  );

  // The bubble is rendered for measurement but only painted (opacity/pointer) when
  // `show` — the `--show` class drives the reveal so CSS owns the motion.
  const sideClass = placement === 'below' ? 'soup-tooltip__bubble--bottom' : 'soup-tooltip__bubble--top';
  const bubbleClass = ['soup-tooltip__bubble', sideClass, show ? 'soup-tooltip__bubble--show' : '']
    .filter(Boolean)
    .join(' ');
  const anchorClass = ['soup-tooltip', className].filter(Boolean).join(' ');

  // The aria-describedby association must sit on the real trigger node so SR users
  // reach the bubble — inject it (merging any existing value) via cloneElement.
  // Pointer/focus/Esc handlers live on the wrapper span instead: React's onFocus/
  // onBlur bubble (focusin/focusout) and mouseenter/leave on the wrapper cover the
  // child, so the trigger element is never handed a ref-bearing prop here.
  const existingDescribedBy =
    isValidElement(children) && typeof children.props['aria-describedby'] === 'string'
      ? (children.props['aria-describedby'] as string)
      : undefined;
  const describedBy = [existingDescribedBy, bubbleId].filter(Boolean).join(' ');

  const trigger = cloneElement(children, { 'aria-describedby': describedBy });

  return (
    <span
      ref={anchorRef}
      className={anchorClass}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      {trigger}
      <span
        id={bubbleId}
        role="tooltip"
        data-placement={placement}
        aria-hidden={show ? undefined : true}
        className={bubbleClass}
      >
        {content}
        <span aria-hidden="true" className="soup-tooltip__caret" />
      </span>
    </span>
  );
};
