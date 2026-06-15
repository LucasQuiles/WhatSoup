/**
 * Drawer.tsx — contextual inspector primitive (drawer.md).
 *
 * Built on useDismissable (open/onClose/Escape stacking/focus trap/restoration).
 * The hook is used unmodified per the slice contract (investigation §6.8).
 *
 * Squeeze-layout production rule is implemented via a CSS container query on
 * DrawerLayout (sets container-type: inline-size). At container ≥900px the
 * drawer is a flex sibling (no scrim, role="complementary"). Below 900px it
 * becomes absolute overlay + scrim (reuses --scrim token from Modal's CSS).
 * Threshold: drawer.md authored 1080px assuming a full-width container; the
 * Fleet container shares the viewport with the activity feed (~1044px at a
 * 1440px window), so 1080px produced overlay on desktop — contradicting the
 * rule's own intent. Amended to 900px (C2.3 live-QA finding D2; squeezed
 * content keeps ≥~540px). The mode flip is CSS-only; jsdom cannot prove the
 * squeeze flip — marked INCONCLUSIVE in tests, manual QA covers D7.
 *
 * Motion: enter translateX(100%→0) at --dur-slow --ease-enter; exit
 * translateX(0→100%) at --dur-base --ease-exit (180ms). The global
 * prefers-reduced-motion block neutralizes all CSS animations — no JS check.
 * Exit motion uses use-exit-presence (deferred unmount while CSS -out plays).
 * In jsdom (no stylesheet) the dwell is instant — all existing suites stable
 * (C-B5-1).
 *
 * Background inert exception (C-B5-2, DD-19):
 *   The Drawer does NOT get background inert. It is non-modal by spec (drawer.md
 *   §Accessibility: role="complementary"; squeeze mode keeps table interaction live).
 *   It also renders inline inside #root (not portaled) — inert on #root would inert
 *   the Drawer itself. This is the DD-19-sanctioned documented exception recorded
 *   in the design-debt-register closing row. The drawer's existing containment
 *   (focus trap, Escape stack, scrim in overlay mode) is unchanged.
 *
 * Content retarget: callers swap children/props while open=true. The Drawer
 * does NOT remount or re-animate on content change — key stability is the
 * caller's responsibility (keep the same Drawer instance, change its props).
 * Focus is not moved on retarget (investigation §6.6).
 *
 * Missing-entity contract: when the inspected entity is not found, callers
 * render an error state inside DrawerBody (e.g. via LogStream error prop or
 * a custom error block). The drawer is never empty on failure (drawer.md §States).
 *
 * Squeeze proof: INCONCLUSIVE in jsdom — manual QA + D7 viewport tests are
 * the proof path (investigation §6.9).
 */
import {
  type FC,
  type ReactNode,
  type RefObject,
  type MutableRefObject,
  createContext,
  useContext,
  useRef,
} from 'react';
import { X } from 'lucide-react';
import { useDismissable } from '../../hooks/use-dismissable';
import { useExitPresence } from '../../hooks/use-exit-presence';

// ---------------------------------------------------------------------------
// DrawerCloseRefContext — thread the close button ref to DrawerHeader
// so useDismissable can shift initial focus to it on open.
// ---------------------------------------------------------------------------

type CloseRefValue = MutableRefObject<HTMLElement | null>;
const DrawerCloseRefContext = createContext<CloseRefValue | null>(null);

// ---------------------------------------------------------------------------
// DrawerLayout — wrapping container that owns the container query
// ---------------------------------------------------------------------------

export interface DrawerLayoutProps {
  /**
   * The content region (table / main body). At container ≥900px rendered as
   * a flex sibling of the drawer (squeeze mode). At <900px the drawer overlays.
   * The content div receives soup-drawer-layout__content (flex: 1 1 auto; min-width: 0).
   */
  children: ReactNode;
  /** The Drawer element. Rendered as the second child of the layout root. */
  drawer: ReactNode;
  className?: string;
}

export const DrawerLayout: FC<DrawerLayoutProps> = ({
  children,
  drawer,
  className,
}) => {
  const wrapClass = ['soup-drawer-layout', className].filter(Boolean).join(' ');
  return (
    <div className={wrapClass}>
      <div className="soup-drawer-layout__content">{children}</div>
      {drawer}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Drawer (shell)
// ---------------------------------------------------------------------------

/** CSS animation name for the drawer exit keyframe (B5 §4.2 guard, C-B5-6). */
const DRAWER_OUT_ANIM = 'soup-drawer-out';

export interface DrawerProps {
  /** Controls visibility. */
  open: boolean;
  /** Called on Escape / close button. */
  onClose: () => void;
  /**
   * Accessible label for the drawer region (the inspected entity name).
   * Provide either aria-label or aria-labelledby.
   */
  'aria-label'?: string;
  /**
   * When the title is rendered inside the drawer, provide the title element's id
   * for aria-labelledby wiring on the shell.
   */
  'aria-labelledby'?: string;
  /** Drawer content. Compose DrawerHeader + DrawerBody + optional DrawerFooter. */
  children: ReactNode;
  className?: string;
  /**
   * Focus-restoration override (forwarded to useDismissable). Retargeting
   * callers point this at the CURRENT originating row so that closing after a
   * retarget restores focus to the row whose data is shown, not the row that
   * first opened the drawer (C2.3 live-QA finding D3).
   */
  restoreFocus?: RefObject<HTMLElement | null>;
}

export const Drawer: FC<DrawerProps> = ({
  open,
  onClose,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  children,
  className,
  restoreFocus,
}) => {
  const shellRef = useRef<HTMLDivElement>(null);

  // The close button in DrawerHeader receives initial focus on open
  // (drawer.md §Accessibility). We create a shared ref that DrawerHeader
  // registers its close button into, then pass it as initialFocus.
  const closeButtonRef = useRef<HTMLElement | null>(null);

  // useDismissable receives the REAL open prop: Escape deregisters and focus
  // restores at close-start; the closing shell never captures input.
  useDismissable(shellRef, {
    onClose,
    open,
    // Outside-click dismissal is NOT enabled by default — squeeze mode keeps
    // the table live and users interact with both surfaces freely.
    dismissable: false,
    initialFocus: closeButtonRef as RefObject<HTMLElement | null>,
    restoreFocus,
  });

  // Exit presence: deferred unmount while soup-drawer-out keyframe plays (B5 §4.2).
  const { mounted, phase } = useExitPresence(open, shellRef, DRAWER_OUT_ANIM);

  if (!mounted) return null;

  const drawerClass = ['soup-drawer', className].filter(Boolean).join(' ');

  return (
    <>
      {/* Scrim — only rendered in overlay mode (<900px container).
          The container query in soup-drawer-layout hides it at ≥900px.
          Carries data-state so it fades out in parallel with the drawer shell. */}
      <div
        className="soup-drawer-scrim"
        aria-hidden="true"
        data-state={phase}
      />

      <div
        ref={shellRef}
        role="complementary"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={drawerClass}
        data-state={phase}
        tabIndex={-1}
      >
        <DrawerCloseRefContext value={closeButtonRef}>
          {children}
        </DrawerCloseRefContext>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// DrawerHeader
// ---------------------------------------------------------------------------

export interface DrawerHeaderProps {
  /** Optional status shape element rendered before the title. */
  statusShape?: ReactNode;
  /**
   * Drawer title text. Rendered in the --type-title font.
   * Wire titleId + Drawer aria-labelledby for accessible naming.
   */
  title: string;
  /** id applied to the title span, for aria-labelledby on the Drawer shell. */
  titleId?: string;
  /** Optional mode badge element rendered after the title. */
  modeBadge?: ReactNode;
  /** Called when the close X is clicked. Must match Drawer's onClose. */
  onClose: () => void;
}

export const DrawerHeader: FC<DrawerHeaderProps> = ({
  statusShape,
  title,
  titleId,
  modeBadge,
  onClose,
}) => {
  // Register the close button DOM ref so useDismissable can focus it on open.
  const closeRef = useContext(DrawerCloseRefContext);

  return (
    <div className="soup-drawer-head">
      {statusShape && (
        <span className="soup-drawer-head__shape" aria-hidden="true">
          {statusShape}
        </span>
      )}
      <span className="soup-drawer-head__title" id={titleId}>
        {title}
      </span>
      {modeBadge && (
        <span className="soup-drawer-head__badge">{modeBadge}</span>
      )}
      <span className="soup-drawer-head__spring" aria-hidden="true" />
      {/* Close X — icon button; receives initial focus on open.
          Rendered inline (no forwardRef dependency) so we can wire the ref directly. */}
      <button
        ref={(el) => {
          if (closeRef) closeRef.current = el;
        }}
        type="button"
        className="soup-actbtn"
        aria-label="Close inspector"
        onClick={onClose}
      >
        <span aria-hidden="true">
          <X size={16} strokeWidth={1.75} />
        </span>
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// DrawerBody — scrollable content region
// ---------------------------------------------------------------------------

export interface DrawerBodyProps {
  children: ReactNode;
  className?: string;
}

export const DrawerBody: FC<DrawerBodyProps> = ({ children, className }) => {
  const composed = ['soup-drawer-body', className].filter(Boolean).join(' ');
  return <div className={composed}>{children}</div>;
};

// ---------------------------------------------------------------------------
// DrawerFooter — optional pinned footer
// ---------------------------------------------------------------------------

export interface DrawerFooterProps {
  children: ReactNode;
  className?: string;
}

export const DrawerFooter: FC<DrawerFooterProps> = ({ children, className }) => {
  const composed = ['soup-drawer-footer', className].filter(Boolean).join(' ');
  return <div className={composed}>{children}</div>;
};
