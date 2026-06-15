/**
 * Modal.tsx — the one dialog shell primitive (modal.md).
 *
 * Anatomy: backdrop (scrim) > shell > ModalHeader > ModalBody > ModalFooter.
 *
 * Features:
 *   - role="dialog" aria-modal aria-labelledby wired by the shell.
 *   - size prop: sm / md / lg — maps to --panel-* width tokens.
 *   - useDismissable: Escape (stacking-aware), outside-click (dismissable prop),
 *     focus trap, focus restoration.
 *   - Enter/exit CSS keyframes; exit faster than enter (motion.md §5).
 *     Exit: --dur-fast --ease-exit (120ms); enter: --dur-base --ease-enter (180ms).
 *     data-state="open|closing" drives the CSS keyframe switch.
 *     Reduced motion: both enter and exit instant via the global
 *     prefers-reduced-motion CSS block (no JS matchMedia check needed).
 *   - Background inert: #root receives inert while any modal is open (DD-19).
 *     Refcounted (use-background-inert) so stacked modals are safe.
 *     Inert is released (effect cleanup) BEFORE focus restoration runs (C-B5-4).
 *   - Exit presence: deferred unmount via use-exit-presence; the closing dwell
 *     keeps the component mounted for ≤120ms while the CSS -out keyframe plays.
 *     In jsdom (no stylesheet) the dwell is instant — all existing suites stable
 *     (C-B5-1). useDismissable receives the REAL open prop so Escape de-registers,
 *     the trap disarms, and focus restores at close-start — the dying shell never
 *     captures input.
 *
 * Sub-components exported from this module:
 *   Modal, ModalHeader, ModalBody, ModalFooter
 */
import {
  type FC,
  type ReactNode,
  type RefObject,
  createContext,
  useContext,
  useId,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDismissable } from '../../hooks/use-dismissable';
import { useExitPresence } from '../../hooks/use-exit-presence';
import { useBackgroundInert } from '../../hooks/use-background-inert';
import { ActionButton } from './ActionButton';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps {
  /** Controls visibility. */
  open: boolean;
  /** Called on Escape / outside-click (when dismissable=true) / close button. */
  onClose: () => void;
  /**
   * sm  → min(480px, calc(100% - 32px))
   * md  → 560px (default)
   * lg  → 720px (wizard width, --panel-wizard)
   */
  size?: ModalSize;
  /**
   * When true, clicking the scrim also calls onClose.
   * Off by default — destructive confirms must require an explicit button.
   */
  dismissable?: boolean;
  /** Modal content. Compose ModalHeader + ModalBody + ModalFooter inside. */
  children: ReactNode;
  /**
   * Optional ref to the element that should receive initial focus when the modal opens.
   * When omitted the first focusable child (or the shell itself) gets focus — matching
   * the default useDismissable behaviour. Needed by form dialogs that want to land
   * focus on their primary input rather than the header close X (C-B3W1-1).
   */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Optional id for the modal shell (for aria-labelledby wiring when you control
   * the title element externally). Normally, use ModalHeader which wires this automatically.
   */
  labelledById?: string;
}

// Title-id plumbing: Modal provides the generated id; ModalHeader consumes it so the
// default composition wires aria-labelledby without explicit prop threading.
const ModalTitleIdContext = createContext<string | undefined>(undefined);

// ---------------------------------------------------------------------------
// Modal (shell + backdrop composite)
// ---------------------------------------------------------------------------

/** CSS animation name for the modal shell exit keyframe (B5 §4.2 guard, C-B5-6). */
const MODAL_SHELL_OUT_ANIM = 'soup-modal-shell-out';

export const Modal: FC<ModalProps> = ({
  open,
  onClose,
  size = 'md',
  dismissable = false,
  children,
  initialFocus,
  labelledById,
}) => {
  const shellRef = useRef<HTMLDivElement>(null);
  const autoId = useId();
  const titleId = labelledById ?? `soup-modal-title-${autoId}`;

  // useDismissable receives the REAL open prop: Escape deregisters, trap disarms,
  // and focus restores at close-start. The closing shell never captures input.
  useDismissable(shellRef, { onClose, open, dismissable, initialFocus });

  // Background inert: acquires on open, releases in cleanup (C-B5-4 ordering).
  useBackgroundInert(open);

  // Exit presence: deferred unmount while the -out keyframe plays (B5 §4.2).
  // In jsdom (no stylesheet) mounted→false is synchronous (C-B5-1).
  const { mounted, phase } = useExitPresence(open, shellRef, MODAL_SHELL_OUT_ANIM);

  if (!mounted) return null;

  const sizeClass =
    size === 'sm'
      ? 'soup-modal-shell--sm'
      : size === 'lg'
        ? 'soup-modal-shell--lg'
        : 'soup-modal-shell--md';

  // Outside dismissal is owned EXCLUSIVELY by useDismissable's stack-aware pointerdown
  // handler — no backdrop onClick, so a real browser sequence (pointerdown -> pointerup
  // -> click) can never double-fire onClose.
  return createPortal(
    <div
      className="soup-modal-backdrop"
      data-soup-backdrop
      data-state={phase}
    >
      <div
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`soup-modal-shell ${sizeClass}`}
        data-state={phase}
        data-soup-modal-title-id={titleId}
      >
        <ModalTitleIdContext.Provider value={titleId}>
          {children}
        </ModalTitleIdContext.Provider>
      </div>
    </div>,
    document.body,
  );
};

// ---------------------------------------------------------------------------
// ModalHeader
// ---------------------------------------------------------------------------

export interface ModalHeaderProps {
  /** Modal title text — wired to aria-labelledby on the shell. */
  title: string;
  /** When provided, renders a close X ActionButton at the end of the header. */
  onClose?: () => void;
}

export const ModalHeader: FC<ModalHeaderProps> = ({ title, onClose }) => {
  const titleId = useContext(ModalTitleIdContext);
  return (
    <div className="soup-modal-header">
      <span className="soup-modal-title" id={titleId}>
        {title}
      </span>
      {onClose && (
        <ActionButton
          label="Close dialog"
          icon={<X size={18} strokeWidth={1.75} />}
          onClick={onClose}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// ModalBody
// ---------------------------------------------------------------------------

export interface ModalBodyProps {
  children: ReactNode;
  className?: string;
}

export const ModalBody: FC<ModalBodyProps> = ({ children, className }) => {
  const composed = ['soup-modal-body', className].filter(Boolean).join(' ');
  return <div className={composed}>{children}</div>;
};

// ---------------------------------------------------------------------------
// ModalFooter
// ---------------------------------------------------------------------------

export interface ModalFooterProps {
  /** Right-aligned action slot(s). */
  children: ReactNode;
  /**
   * When provided, rendered left-aligned (note / secondary info).
   * Matches the "split variant for note + actions" anatomy from modal.md.
   */
  note?: ReactNode;
  className?: string;
}

export const ModalFooter: FC<ModalFooterProps> = ({ children, note, className }) => {
  const composed = ['soup-modal-footer', className].filter(Boolean).join(' ');
  return (
    <div className={composed}>
      {note && <div className="soup-modal-footer__note">{note}</div>}
      <div className="soup-modal-footer__actions">{children}</div>
    </div>
  );
};
