/**
 * Table.tsx — the first-class data surface primitive (table.md).
 *
 * Composable sub-components:
 *   Table           — outer shell; scrollable wrapper, data-density attribute.
 *   TableHeader     — <thead> with sticky ghost headers.
 *   TableHeaderCell — <th>; sortable variant renders a real <button> inside,
 *                     sets aria-sort on the th, inline glyph, instant (no animation).
 *   TableBody       — <tbody>.
 *   TableRow        — <tr>; interactive, severity, current variants.
 *   TableCell       — <td>; numeric and default truncation variants.
 *   TableEmpty      — empty state row spanning all columns.
 *   TableError      — error state row spanning all columns.
 *   TableLoading    — skeleton rows mirroring the table's column geometry (table.md §States).
 *
 * Status cells are composed by callers using StatusCell from the barrel.
 * Absent values: use the EM_DASH helper (text-3 tier ghost per table.md §Status).
 *
 * WAI note: this is a read-mostly table with interactive rows (link semantics).
 * It is NOT a grid — no cell-level managed focus. If cell editing or arrow-key
 * navigation is added, the component must graduate to role="grid" with managed
 * focus (table.md §WAI table-vs-grid law).
 */
import {
  type FC,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TableDensity = 'default' | 'compressed';
export type SortDir = 'asc' | 'desc' | 'none';
export type RowSeverity = 'warn' | 'crit';

export interface SortState {
  key: string;
  dir: SortDir;
}

// ---------------------------------------------------------------------------
// Table (shell)
// ---------------------------------------------------------------------------

export interface TableProps {
  /**
   * Row height density.
   * 'default' = 36px (browse, forms-adjacent).
   * 'compressed' = 28px (Fleet, Ops, logs).
   */
  density?: TableDensity;
  children: ReactNode;
  className?: string;
}

export const Table: FC<TableProps> = ({
  density = 'default',
  children,
  className,
}) => {
  const wrapClass = ['soup-tblwrap', className].filter(Boolean).join(' ');
  return (
    <div className={wrapClass} data-density={density}>
      <table className="soup-table">{children}</table>
    </div>
  );
};

// ---------------------------------------------------------------------------
// TableHeader (<thead>)
// ---------------------------------------------------------------------------

export interface TableHeaderProps {
  children: ReactNode;
}

export const TableHeader: FC<TableHeaderProps> = ({ children }) => (
  <thead className="soup-table-thead">{children}</thead>
);

// ---------------------------------------------------------------------------
// TableHeaderCell (<th>)
// ---------------------------------------------------------------------------

export interface TableHeaderCellProps
  extends Omit<ThHTMLAttributes<HTMLTableCellElement>, 'onClick'> {
  /** When provided, this column is sortable and renders a button inside the th. */
  sortKey?: string;
  /** Current sort state ({key, dir}) — used to derive aria-sort and glyph. */
  sort?: SortState;
  /**
   * Called with the next sort state when the sort button is activated.
   * Cycle: none -> asc -> desc -> none.
   */
  onSort?: (next: SortState) => void;
  children: ReactNode;
}

function nextSortDir(current: SortDir): SortDir {
  if (current === 'none') return 'asc';
  if (current === 'asc') return 'desc';
  return 'none';
}

export const TableHeaderCell: FC<TableHeaderCellProps> = ({
  sortKey,
  sort,
  onSort,
  children,
  className,
  ...rest
}) => {
  const isSortable = Boolean(sortKey && onSort);
  const currentDir: SortDir =
    isSortable && sort && sort.key === sortKey ? sort.dir : 'none';

  const ariaSortValue =
    currentDir === 'asc'
      ? 'ascending'
      : currentDir === 'desc'
        ? 'descending'
        : undefined;

  const thClass = ['soup-table-th', className].filter(Boolean).join(' ');

  const handleSort = () => {
    if (!sortKey || !onSort) return;
    onSort({ key: sortKey, dir: nextSortDir(currentDir) });
  };

  const columnLabel = typeof children === 'string' ? children : String(sortKey ?? 'column');
  const nextDir = nextSortDir(currentDir);
  const sortActionLabel = `Sort by ${columnLabel}${nextDir === 'asc' ? ', ascending' : nextDir === 'desc' ? ', descending' : ''}`;

  return (
    <th className={thClass} scope="col" aria-sort={ariaSortValue} {...rest}>
      {isSortable ? (
        <button
          type="button"
          className="soup-table-th__sort-btn"
          onClick={handleSort}
          aria-label={sortActionLabel}
          tabIndex={0}
        >
          {children}
          <span className="soup-table-th__sort-glyph" aria-hidden="true">
            {currentDir === 'asc' ? (
              <ChevronUp size={12} strokeWidth={1.75} />
            ) : currentDir === 'desc' ? (
              <ChevronDown size={12} strokeWidth={1.75} />
            ) : (
              <ChevronsUpDown size={12} strokeWidth={1.75} />
            )}
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  );
};

// ---------------------------------------------------------------------------
// TableBody (<tbody>)
// ---------------------------------------------------------------------------

export interface TableBodyProps {
  children: ReactNode;
}

export const TableBody: FC<TableBodyProps> = ({ children }) => (
  <tbody className="soup-table-tbody">{children}</tbody>
);

// ---------------------------------------------------------------------------
// TableRow (<tr>)
// ---------------------------------------------------------------------------

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  /**
   * When true: row is focusable (tabIndex 0) and activates on click and Enter.
   * Calls onActivate on both events.
   */
  interactive?: boolean;
  /** Called on click or Enter when interactive=true. */
  onActivate?: () => void;
  /** Row severity — channel wash fill + 2px inset left edge. */
  severity?: RowSeverity;
  /** When true: aria-current="true" + accent edge class (selected/open row). */
  current?: boolean;
  /**
   * Ref to the underlying <tr> (React 19 ref-as-prop). Used by callers that
   * need the row element, e.g. as a Drawer restoreFocus target. Declared
   * structurally (callback or {current}) rather than as React.Ref: the repo
   * typechecks console sources under two @types/react installations, and
   * React.Ref's unique-symbol cleanup variant is not identity-compatible
   * across copies.
   */
  ref?: ((instance: HTMLTableRowElement | null) => void) | { current: HTMLTableRowElement | null };
  children: ReactNode;
}

export const TableRow: FC<TableRowProps> = ({
  interactive = false,
  onActivate,
  severity,
  current = false,
  children,
  className,
  onClick,
  onKeyDown,
  ...rest
}) => {
  const severityClass =
    severity === 'warn'
      ? 'soup-table-row--warn'
      : severity === 'crit'
        ? 'soup-table-row--crit'
        : '';

  const interactiveClass = interactive ? 'soup-table-row--interactive' : '';
  const currentClass = current ? 'soup-table-row--current' : '';

  const rowClass = [
    'soup-table-row',
    interactiveClass,
    severityClass,
    currentClass,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const handleClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
    onClick?.(e);
    if (interactive) onActivate?.();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    onKeyDown?.(e);
    if (interactive && e.key === 'Enter') {
      e.preventDefault();
      onActivate?.();
    }
  };

  return (
    <tr
      className={rowClass}
      tabIndex={interactive ? 0 : undefined}
      aria-current={current ? 'true' : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {children}
    </tr>
  );
};

// ---------------------------------------------------------------------------
// TableCell (<td>)
// ---------------------------------------------------------------------------

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  /**
   * When true: right-aligned tabular-figures lane class (mono data lane).
   * Use for timestamps, counts, tokens, uptime, phones (table.md §Status).
   */
  numeric?: boolean;
  children?: ReactNode;
}

export const TableCell: FC<TableCellProps> = ({
  numeric = false,
  children,
  className,
  ...rest
}) => {
  const numClass = numeric ? 'soup-table-td--num' : '';
  const tdClass = ['soup-table-td', numClass, className].filter(Boolean).join(' ');

  return (
    <td className={tdClass} {...rest}>
      {children}
    </td>
  );
};

// ---------------------------------------------------------------------------
// EM_DASH — ghost helper for absent values (text-3 tier, table.md §Status)
// ---------------------------------------------------------------------------

export const EM_DASH: FC = () => (
  <span className="soup-table-ghost" aria-hidden="true">
    &mdash;
  </span>
);

// ---------------------------------------------------------------------------
// TableEmpty — empty state row
// ---------------------------------------------------------------------------

export interface TableEmptyProps {
  /** Number of columns the empty row spans. */
  colSpan: number;
  /** Message to display. */
  message?: string;
  /** Optional remedy/action element (e.g. a button to clear filters). */
  remedy?: ReactNode;
}

export const TableEmpty: FC<TableEmptyProps> = ({
  colSpan,
  message = 'No results',
  remedy,
}) => (
  <tr className="soup-table-row soup-table-row--state">
    <td className="soup-table-td soup-table-td--state" colSpan={colSpan}>
      <span className="soup-table-state-msg">{message}</span>
      {remedy && <span className="soup-table-state-remedy">{remedy}</span>}
    </td>
  </tr>
);

// ---------------------------------------------------------------------------
// TableError — error state row
// ---------------------------------------------------------------------------

export interface TableErrorProps {
  colSpan: number;
  message?: string;
  /** Optional retry/action element. */
  retry?: ReactNode;
}

export const TableError: FC<TableErrorProps> = ({
  colSpan,
  message = 'Failed to load data.',
  retry,
}) => (
  <tr className="soup-table-row soup-table-row--state">
    <td className="soup-table-td soup-table-td--state soup-table-td--error" colSpan={colSpan}>
      <span className="soup-table-state-msg soup-table-state-msg--error">{message}</span>
      {retry && <span className="soup-table-state-remedy">{retry}</span>}
    </td>
  </tr>
);

// ---------------------------------------------------------------------------
// TableLoading — skeleton rows mirroring geometry (table.md §States: P2-9)
// ---------------------------------------------------------------------------

export interface TableLoadingProps {
  /** Number of skeleton rows to render. */
  rows?: number;
  /** Number of columns (used to size skeleton cells across the row). */
  colSpan: number;
}

export const TableLoading: FC<TableLoadingProps> = ({
  rows = 5,
  colSpan,
}) => (
  <>
    {Array.from({ length: rows }, (_, i) => (
      <tr key={i} className="soup-table-row soup-table-row--skeleton" aria-hidden="true">
        <td className="soup-table-td" colSpan={colSpan}>
          <span className="soup-table-skeleton-bar" />
        </td>
      </tr>
    ))}
  </>
);
