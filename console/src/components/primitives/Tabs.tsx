/**
 * Tabs.tsx — tabs.md-canonical tablist mechanic; remaining hand-rolled tablists
 * are register-tracked (ConfigStep, ModelAuthStep, GroupDetailModal — to be migrated
 * in B2/B3 slices).
 *
 * Contract: role wiring (tablist/tab/tabpanel), roving tabindex, Arrow/Home/End
 * focus movement with wrap, MANUAL activation (Enter/Space select — focus alone
 * never switches panels; LineDetail has 9 data-loading panels), selected =
 * 2px --accent underline (custom underline treatments are an anti-pattern),
 * disabled-with-reason (aria-disabled, arrow-reachable, aria-describedby).
 * Panels are hidden via the hidden attribute by TabPanel; callers MAY instead
 * conditionally mount heavy panels and skip TabPanel's hidden mechanic — the
 * aria contract is identical (id/aria-labelledby).
 * Switches are instant (motion.md instant band): no indicator tween.
 */
import {
  createContext,
  useContext,
  useRef,
  type FC,
  type ReactNode,
  type KeyboardEvent,
} from 'react';

interface TabsCtx {
  value: string;
  onChange: (id: string) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  lazyPanels: boolean;
}
const TabsContext = createContext<TabsCtx | null>(null);

export interface TabsProps {
  /** Accessible name for the tablist. */
  label: string;
  /** Selected tab id (controlled). */
  value: string;
  onChange: (id: string) => void;
  /** Adds side padding so the rule aligns with page gutters (tabs.md inset). */
  inset?: boolean;
  /**
   * Set when the caller conditionally mounts only the active panel (instead of
   * TabPanel's hidden mechanic). Inactive tabs then omit `aria-controls` so they
   * don't point at non-existent panel ids (ARIA 1.2 / axe aria-valid-attr-value);
   * the tab↔panel link is still carried by `aria-labelledby` on the live panel.
   */
  lazyPanels?: boolean;
  children: ReactNode;
  className?: string;
}

export const Tabs: FC<TabsProps> = ({ label, value, onChange, inset = false, lazyPanels = false, children, className }) => {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Roving focus: operate on the rendered, enabled-or-disabled tab buttons in
  // DOM order. Disabled tabs are arrow-reachable (tabs.md) but not selectable.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    if (tabs.length === 0) return;
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (e.key === 'ArrowRight') next = (current + 1) % tabs.length;
    if (e.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = tabs.length - 1;
    e.preventDefault();
    tabs[next]?.focus();
  };

  const cls = ['soup-tabs', inset ? 'soup-tabs--inset' : '', className].filter(Boolean).join(' ');
  return (
    <TabsContext value={{ value, onChange, listRef, lazyPanels }}>
      <div ref={listRef} role="tablist" aria-label={label} className={cls} onKeyDown={handleKeyDown}>
        {children}
      </div>
    </TabsContext>
  );
};

export interface TabProps {
  id: string;
  disabled?: boolean;
  /** Shown to AT via aria-describedby when disabled (tabs.md disabled-with-reason). */
  disabledReason?: string;
  children: ReactNode;
}

export const Tab: FC<TabProps> = ({ id, disabled = false, disabledReason, children }) => {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('Tab must render inside <Tabs>');
  const selected = ctx.value === id;
  const reasonId = disabledReason ? `tab-${id}-reason` : undefined;
  const select = () => {
    if (disabled) return;
    ctx.onChange(id);
  };
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={selected}
      // Omit aria-controls for inactive tabs when only the active panel is mounted
      // (lazyPanels) — otherwise it points at a non-existent id (axe aria-valid-attr-value).
      aria-controls={!ctx.lazyPanels || selected ? `tabpanel-${id}` : undefined}
      aria-disabled={disabled || undefined}
      aria-describedby={reasonId}
      tabIndex={selected && !disabled ? 0 : -1}
      className={[
        'soup-tab',
        selected ? 'soup-tab--selected' : '',
        disabled ? 'soup-tab--disabled' : '',
      ].filter(Boolean).join(' ')}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      }}
    >
      {children}
      {disabledReason ? (
        <span id={reasonId} className="soup-tab__reason">{disabledReason}</span>
      ) : null}
    </button>
  );
};

export interface TabPanelProps {
  id: string;
  /** Currently selected tab id. */
  active: string;
  children: ReactNode;
  className?: string;
}

export const TabPanel: FC<TabPanelProps> = ({ id, active, children, className }) => (
  <div
    role="tabpanel"
    id={`tabpanel-${id}`}
    aria-labelledby={`tab-${id}`}
    hidden={active !== id}
    className={['soup-tabpanel', className].filter(Boolean).join(' ')}
  >
    {children}
  </div>
);
