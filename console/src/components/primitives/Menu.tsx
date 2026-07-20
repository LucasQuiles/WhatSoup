/**
 * Menu.tsx — the P0 action-surface primitive (showcase §22; DD-43).
 *
 * A role="menu" action surface — DISTINCT from Popover, which is a role="listbox"
 * combobox picker. The two share the useDismissable stack (one focus + dismissal
 * law) but carry different ARIA semantics and keyboard contracts:
 *
 *   Popover (listbox): focus stays on the trigger/input, aria-activedescendant
 *                      tracks the active option, Enter selects.
 *   Menu (menu):       focus MOVES into the surface; a roving tabIndex walks the
 *                      menuitems; Esc closes AND restores focus to the trigger.
 *
 * Built on useDismissable (trapFocus + autoFocus default true): on open, focus
 * shifts into the panel; Tab cycles within it; Escape closes one layer (stacking
 * aware) and useDismissable restores focus to the element that opened the menu
 * (the trigger). The panel portals to document.body so it is never clipped by an
 * ancestor overflow:hidden row.
 *
 * Keyboard contract (interaction-patterns.md menu law / WAI-ARIA menu pattern):
 *   ArrowDown/ArrowUp — move roving focus between enabled+disabled items (wrap).
 *   Home/End          — first / last item.
 *   Enter/Space       — activate the focused item.
 *   Escape            — close, focus returns to the trigger (via useDismissable).
 *
 * Item taxonomy (showcase §22):
 *   - Sections: grouped items under a mono uppercase label (role="group").
 *   - Checkable items: role="menuitemcheckbox" + aria-checked; the check uses the
 *     accent, never a status channel.
 *   - Disabled-with-reason: the reason is exposed to AT via aria-describedby and
 *     the item stays focusable (arrow-reachable) — never a bare title attribute.
 *   - Destructive items: route through ConfirmDialog — the destructive action is
 *     NEVER fired directly from the menu click.
 *
 * Reduced-motion: the panel enter/exit reuses the soup-menu keyframes, removed
 * (not shortened) under prefers-reduced-motion via the global media block.
 */
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useDismissable } from '../../hooks/use-dismissable';
import { useExitPresence } from '../../hooks/use-exit-presence';
import ConfirmDialog from '../ConfirmDialog';

// ---------------------------------------------------------------------------
// Context — lets MenuItem reach the surface's close handler + destructive route.
// ---------------------------------------------------------------------------

interface MenuCtx {
  /** Close the surface (used after an item activates). */
  close: () => void;
  /** Route a destructive item through ConfirmDialog instead of firing directly. */
  requestConfirm: (req: ConfirmRequest) => void;
}

interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}

const MenuContext = createContext<MenuCtx | null>(null);

function useMenuCtx(component: string): MenuCtx {
  const ctx = useContext(MenuContext);
  if (!ctx) throw new Error(`${component} must render inside <Menu>`);
  return ctx;
}

/** CSS animation name for the menu exit keyframe (motion.md §5, B5 §4.2). */
const MENU_OUT_ANIM = 'soup-menu-out';

// ---------------------------------------------------------------------------
// Menu — trigger + portal surface
// ---------------------------------------------------------------------------

export interface MenuProps {
  /** Accessible label for the menu surface (role="menu" aria-label). */
  label: string;
  /**
   * Trigger label — Menu owns the trigger <button> so it can wire the ref,
   * aria-haspopup/aria-expanded, and the open keys without passing a ref through
   * a render prop (which react-hooks/refs forbids). Pass any ReactNode (text +
   * a caret glyph, an icon, etc.).
   */
  triggerLabel: ReactNode;
  /** Accessible name for the trigger button (defaults to `label`). */
  triggerLabelText?: string;
  /** Extra class names appended to the trigger button (default .soup-menu-trigger). */
  triggerClassName?: string;
  /** Menu items / sections (MenuItem, MenuSection, MenuSeparator). */
  children: ReactNode;
  /** Panel min-width; defaults to the --menu-min-w token floor. */
  className?: string;
}

export const Menu: FC<MenuProps> = ({
  label,
  triggerLabel,
  triggerLabelText,
  triggerClassName,
  children,
  className,
}) => {
  const [open, setOpen] = useState(false);
  // The Menu owns the trigger button; this ref anchors the panel and is the
  // focus-restoration target (focus returns here on close).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const close = useCallback(() => setOpen(false), []);

  // useDismissable owns Escape (stacking-aware), Tab trapping, outside-click, and
  // focus restoration back to the trigger (the element focused when open flipped
  // true). trapFocus + autoFocus default true: focus moves into the surface.
  // dismissable: true → an outside click also closes (menu.md row-action surface).
  useDismissable(panelRef, {
    onClose: close,
    open,
    dismissable: true,
    restoreFocus: triggerRef,
  });

  // Deferred unmount while the exit keyframe plays; instant in jsdom (C-B5-1).
  const { mounted, phase } = useExitPresence(open, panelRef, MENU_OUT_ANIM);

  // Anchor the portal panel below the trigger after paint (same idiom as Popover).
  // jsdom returns zeros for getBoundingClientRect — tests assert on roles/classes.
  useLayoutEffect(() => {
    if (!mounted) return;
    const panel = panelRef.current;
    const anchor = triggerRef.current;
    /* v8 ignore next -- defensive: panel & anchor refs are set whenever this runs */
    if (!panel || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    panel.style.position = 'absolute';
    panel.style.top = `${rect.bottom + window.scrollY}px`;
    panel.style.left = `${rect.left + window.scrollX}px`;
  }, [mounted, open]);

  // Move roving focus to the first enabled-or-disabled menuitem once the surface
  // mounts (useDismissable's autoFocus lands on the container; we refine to item 0).
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    /* v8 ignore next -- defensive: panel ref exists while the menu is open */
    if (!panel) return;
    const items = getMenuItems(panel);
    items.forEach((el, i) => el.setAttribute('tabindex', i === 0 ? '0' : '-1'));
    items[0]?.focus({ preventScroll: true });
  }, [open]);

  const onTriggerKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  }, []);

  const requestConfirm = useCallback((req: ConfirmRequest) => {
    // Close the surface, then raise the confirm dialog: the destructive action
    // is gated behind an explicit confirm, never fired from the menu click.
    setOpen(false);
    setConfirm(req);
  }, []);

  // Roving-focus key handler for the surface (Arrow/Home/End over the items).
  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const nav = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!nav.includes(e.key)) return;
    const panel = panelRef.current;
    /* v8 ignore next -- defensive: panel ref exists while the menu is open */
    if (!panel) return;
    const items = getMenuItems(panel);
    /* v8 ignore next -- defensive: an open menu always renders items */
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = current;
    if (e.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
    if (e.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = items.length - 1;
    e.preventDefault();
    items.forEach((el, i) => el.setAttribute('tabindex', i === next ? '0' : '-1'));
    items[next]?.focus();
  };

  const panelClass = ['soup-menu', className].filter(Boolean).join(' ');

  const surface = mounted ? (
    <MenuContext value={{ close, requestConfirm }}>
      <div
        ref={panelRef}
        role="menu"
        aria-label={label}
        className={panelClass}
        data-state={phase}
        onKeyDown={onPanelKeyDown}
      >
        {children}
      </div>
    </MenuContext>
  ) : null;

  const triggerClass = ['soup-menu-trigger', triggerClassName]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabelText}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        {triggerLabel}
      </button>
      {surface != null && typeof document !== 'undefined'
        ? createPortal(surface, document.body)
        : surface}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        confirmLabel={confirm?.confirmLabel ?? 'Confirm'}
        confirmVariant="danger"
        onConfirm={() => {
          confirm?.onConfirm();
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      >
        {confirm?.body}
      </ConfirmDialog>
    </>
  );
};

/** All roving-focusable menuitems within the surface, in DOM order. */
function getMenuItems(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]',
    ),
  );
}

// ---------------------------------------------------------------------------
// MenuSection — grouped items under a mono uppercase label (role="group").
// ---------------------------------------------------------------------------

export interface MenuSectionProps {
  /** Section heading (mono uppercase, --text-2 — DD-8: sole-carrier label). */
  label: string;
  children: ReactNode;
}

export const MenuSection: FC<MenuSectionProps> = ({ label, children }) => {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="soup-menu__section">
      <div id={labelId} className="soup-menu__label" aria-hidden="true">
        {label}
      </div>
      {children}
    </div>
  );
};

// ---------------------------------------------------------------------------
// MenuSeparator — non-focusable divider between item clusters.
// ---------------------------------------------------------------------------

export const MenuSeparator: FC = () => (
  <div role="separator" className="soup-menu__sep" />
);

// ---------------------------------------------------------------------------
// MenuItem — the action row.
// ---------------------------------------------------------------------------

export interface MenuItemProps {
  /** Item label / accessible name. */
  children: ReactNode;
  /** Invoked on activation (click / Enter / Space). Omitted for pure-display. */
  onSelect?: () => void;
  /** Keyboard-shortcut hint rendered as a trailing <kbd>. Visual + announced. */
  shortcut?: string;
  /** Leading icon node (decorative). */
  icon?: ReactNode;
  /** Disable the item. Stays arrow-reachable; pair with disabledReason. */
  disabled?: boolean;
  /**
   * Why the item is disabled. Exposed to AT via aria-describedby (never a bare
   * title). Required to satisfy disabled-with-reason — disabled is never silent.
   */
  disabledReason?: string;
  /**
   * When true the item is a checkbox: role="menuitemcheckbox" + aria-checked,
   * leading accent check. `checked` drives the state.
   */
  checkable?: boolean;
  checked?: boolean;
  /**
   * Destructive items route through ConfirmDialog: onSelect fires only after the
   * user confirms. The menu closes and the confirm dialog opens on click.
   */
  destructive?: boolean;
  /** Confirm dialog title for a destructive item. */
  confirmTitle?: string;
  /** Confirm dialog body for a destructive item. */
  confirmBody?: ReactNode;
  /** Confirm button label for a destructive item. */
  confirmLabel?: string;
}

export const MenuItem: FC<MenuItemProps> = ({
  children,
  onSelect,
  shortcut,
  icon,
  disabled = false,
  disabledReason,
  checkable = false,
  checked = false,
  destructive = false,
  confirmTitle,
  confirmBody,
  confirmLabel = 'Confirm',
}) => {
  const ctx = useMenuCtx('MenuItem');
  const reasonId = useId();
  const hasReason = disabled && !!disabledReason;

  const activate = () => {
    if (disabled) return;
    if (destructive && onSelect) {
      // Never fire the destructive action directly — gate it behind ConfirmDialog.
      ctx.requestConfirm({
        title: confirmTitle ?? 'Confirm action',
        body: confirmBody ?? 'This action cannot be undone.',
        confirmLabel,
        onConfirm: onSelect,
      });
      return;
    }
    onSelect?.();
    // Checkable items keep the surface open so several toggles read as one task;
    // plain actions close it.
    if (!checkable) ctx.close();
  };

  const role = checkable ? 'menuitemcheckbox' : 'menuitem';

  return (
    <div
      role={role}
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      aria-checked={checkable ? checked : undefined}
      aria-describedby={hasReason ? reasonId : undefined}
      data-destructive={destructive ? 'true' : undefined}
      className={[
        'soup-menu__item',
        disabled ? 'soup-menu__item--disabled' : '',
        destructive ? 'soup-menu__item--destructive' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
    >
      {checkable ? (
        <span
          className={[
            'soup-menu__check',
            checked ? 'soup-menu__check--on' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-hidden="true"
        />
      ) : icon ? (
        <span className="soup-menu__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="soup-menu__item-label">{children}</span>
      {shortcut ? <kbd className="soup-menu__kbd">{shortcut}</kbd> : null}
      {hasReason ? (
        // Visually hidden; announced to AT via aria-describedby. Reuses the
        // shared .soup-tab__reason sr-only recipe (one idiom across primitives).
        <span id={reasonId} className="soup-tab__reason">
          {disabledReason}
        </span>
      ) : null}
    </div>
  );
};
