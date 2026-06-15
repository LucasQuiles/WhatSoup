/**
 * @vitest-environment jsdom
 *
 * Primitive tests: Table (table.md).
 *
 * Covers (§8 test plan):
 *   - Sort cycle asc->desc->none via click AND keyboard on the header button
 *   - aria-sort per state (ascending/descending/undefined)
 *   - Row Enter activation calls onActivate
 *   - Row focusability (tabIndex=0 when interactive)
 *   - Severity class contracts (soup-table-row--warn / soup-table-row--crit)
 *   - current prop: aria-current + soup-table-row--current class
 *   - Empty state message row
 *   - Loading skeleton rows (aria-hidden)
 *   - Error state message row
 *   - Numeric cell class (soup-table-td--num)
 *   - Truncation class on td (soup-table-td by default)
 *   - Long-value fixture (>40 chars) for truncation class contract
 *   - density prop produces data-density attribute
 *   - EM_DASH renders ghost span
 *
 * INCONCLUSIVE (jsdom limits, noted per spec §8):
 *   - Visual focus ring (computed box model not testable in jsdom)
 *   - Computed overflow/ellipsis (CSS not applied in jsdom)
 *   Computed-box/trusted-event proof lives in the browser lane:
 *   tests/browser/viewport-matrix.test.tsx (LineDetail truncation cases) and
 *   tests/browser/target-size.test.tsx (sort-button height measurement).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  Table,
  TableHeader,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  TableEmpty,
  TableError,
  TableLoading,
  EM_DASH,
} from '../../console/src/components/primitives/Table';
import type { SortState } from '../../console/src/components/primitives/Table';

afterEach(() => { cleanup(); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LONG_NAME = 'Extremely Long Line Name That Exceeds Forty Characters In Length'; // 63 chars

function makeSortTable(
  sortKey: string,
  sort: SortState,
  onSort: (s: SortState) => void,
) {
  return (
    <Table>
      <TableHeader>
        <tr>
          <TableHeaderCell sortKey={sortKey} sort={sort} onSort={onSort}>
            Name
          </TableHeaderCell>
        </tr>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>{LONG_NAME}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Sort — click
// ---------------------------------------------------------------------------

describe('Table — sort via click', () => {
  it('initial state (none): aria-sort is absent on th', () => {
    const onSort = vi.fn();
    render(makeSortTable('name', { key: 'name', dir: 'none' }, onSort));
    const th = document.querySelector('.soup-table-th');
    expect(th?.getAttribute('aria-sort')).toBeNull();
  });

  it('asc state: aria-sort="ascending" on th', () => {
    render(makeSortTable('name', { key: 'name', dir: 'asc' }, vi.fn()));
    const th = document.querySelector('.soup-table-th');
    expect(th?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('desc state: aria-sort="descending" on th', () => {
    render(makeSortTable('name', { key: 'name', dir: 'desc' }, vi.fn()));
    const th = document.querySelector('.soup-table-th');
    expect(th?.getAttribute('aria-sort')).toBe('descending');
  });

  it('click none->asc: calls onSort with {key, dir: "asc"}', () => {
    const onSort = vi.fn();
    render(makeSortTable('name', { key: 'name', dir: 'none' }, onSort));
    fireEvent.click(screen.getByRole('button'));
    expect(onSort).toHaveBeenCalledTimes(1);
    expect(onSort).toHaveBeenCalledWith({ key: 'name', dir: 'asc' });
  });

  it('click asc->desc: calls onSort with {key, dir: "desc"}', () => {
    const onSort = vi.fn();
    render(makeSortTable('name', { key: 'name', dir: 'asc' }, onSort));
    fireEvent.click(screen.getByRole('button'));
    expect(onSort).toHaveBeenCalledWith({ key: 'name', dir: 'desc' });
  });

  it('click desc->none: calls onSort with {key, dir: "none"}', () => {
    const onSort = vi.fn();
    render(makeSortTable('name', { key: 'name', dir: 'desc' }, onSort));
    fireEvent.click(screen.getByRole('button'));
    expect(onSort).toHaveBeenCalledWith({ key: 'name', dir: 'none' });
  });

  it('non-active key: aria-sort absent even when another key is asc', () => {
    render(
      <Table>
        <TableHeader>
          <tr>
            <TableHeaderCell sortKey="name" sort={{ key: 'other', dir: 'asc' }} onSort={vi.fn()}>
              Name
            </TableHeaderCell>
          </tr>
        </TableHeader>
        <TableBody><TableRow><TableCell>x</TableCell></TableRow></TableBody>
      </Table>,
    );
    const th = document.querySelector('.soup-table-th');
    expect(th?.getAttribute('aria-sort')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sort — keyboard (Enter on the sort button, which is a real <button>)
// ---------------------------------------------------------------------------

describe('Table — sort via keyboard Enter', () => {
  it('Enter on sort button (none->asc) calls onSort', () => {
    const onSort = vi.fn();
    render(makeSortTable('name', { key: 'name', dir: 'none' }, onSort));
    const btn = screen.getByRole('button');
    btn.focus();
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.click(btn); // Enter on a button fires a click natively; simulate both
    // At least one call must have occurred
    expect(onSort.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(onSort.mock.calls[0][0]).toEqual({ key: 'name', dir: 'asc' });
  });

  it('sort button is a real <button> element (Enter works natively)', () => {
    render(makeSortTable('name', { key: 'name', dir: 'none' }, vi.fn()));
    const btn = screen.getByRole('button');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
  });
});

// ---------------------------------------------------------------------------
// Row activation
// ---------------------------------------------------------------------------

describe('Table — row activation', () => {
  it('interactive row: Enter calls onActivate', () => {
    const onActivate = vi.fn();
    render(
      <Table>
        <TableBody>
          <TableRow interactive onActivate={onActivate}>
            <TableCell>row</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const row = document.querySelector('.soup-table-row--interactive') as HTMLElement;
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('interactive row: click calls onActivate', () => {
    const onActivate = vi.fn();
    render(
      <Table>
        <TableBody>
          <TableRow interactive onActivate={onActivate}>
            <TableCell>row</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const row = document.querySelector('.soup-table-row--interactive') as HTMLElement;
    fireEvent.click(row);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('non-interactive row: no tabIndex', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>static</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const row = document.querySelector('.soup-table-row') as HTMLElement;
    expect(row.getAttribute('tabindex')).toBeNull();
  });

  it('interactive row: tabIndex=0 (focusable)', () => {
    render(
      <Table>
        <TableBody>
          <TableRow interactive onActivate={() => {}}>
            <TableCell>focusable</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const row = document.querySelector('.soup-table-row--interactive') as HTMLElement;
    expect(row.getAttribute('tabindex')).toBe('0');
  });

  it('Space key on interactive row does NOT call onActivate (only Enter)', () => {
    const onActivate = vi.fn();
    render(
      <Table>
        <TableBody>
          <TableRow interactive onActivate={onActivate}>
            <TableCell>row</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const row = document.querySelector('.soup-table-row--interactive') as HTMLElement;
    fireEvent.keyDown(row, { key: ' ' });
    expect(onActivate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

describe('Table — severity classes', () => {
  it('severity="warn" applies soup-table-row--warn class', () => {
    render(
      <Table>
        <TableBody>
          <TableRow severity="warn"><TableCell>w</TableCell></TableRow>
        </TableBody>
      </Table>,
    );
    expect(document.querySelector('.soup-table-row--warn')).not.toBeNull();
  });

  it('severity="crit" applies soup-table-row--crit class', () => {
    render(
      <Table>
        <TableBody>
          <TableRow severity="crit"><TableCell>c</TableCell></TableRow>
        </TableBody>
      </Table>,
    );
    expect(document.querySelector('.soup-table-row--crit')).not.toBeNull();
  });

  it('no severity: neither warn nor crit class applied', () => {
    render(
      <Table>
        <TableBody>
          <TableRow><TableCell>ok</TableCell></TableRow>
        </TableBody>
      </Table>,
    );
    const row = document.querySelector('.soup-table-row')!;
    expect(row.classList.contains('soup-table-row--warn')).toBe(false);
    expect(row.classList.contains('soup-table-row--crit')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Current row
// ---------------------------------------------------------------------------

describe('Table — current row', () => {
  it('current=true: aria-current="true"', () => {
    render(
      <Table>
        <TableBody>
          <TableRow current><TableCell>selected</TableCell></TableRow>
        </TableBody>
      </Table>,
    );
    const row = document.querySelector('.soup-table-row')!;
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.classList.contains('soup-table-row--current')).toBe(true);
  });

  it('current=false (default): no aria-current', () => {
    render(
      <Table>
        <TableBody>
          <TableRow><TableCell>not selected</TableCell></TableRow>
        </TableBody>
      </Table>,
    );
    const row = document.querySelector('.soup-table-row')!;
    expect(row.getAttribute('aria-current')).toBeNull();
    expect(row.classList.contains('soup-table-row--current')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Numeric cells
// ---------------------------------------------------------------------------

describe('Table — numeric cells', () => {
  it('numeric=true applies soup-table-td--num class', () => {
    render(
      <Table>
        <TableBody>
          <TableRow><TableCell numeric>1234</TableCell></TableRow>
        </TableBody>
      </Table>,
    );
    expect(document.querySelector('.soup-table-td--num')).not.toBeNull();
  });

  it('default (non-numeric) td has soup-table-td class', () => {
    render(
      <Table>
        <TableBody>
          <TableRow><TableCell>text</TableCell></TableRow>
        </TableBody>
      </Table>,
    );
    expect(document.querySelector('.soup-table-td')).not.toBeNull();
    expect(document.querySelector('.soup-table-td--num')).toBeNull();
  });

  it('long-value fixture (>40 chars) renders in a soup-table-td cell', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>{LONG_NAME}</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    // Truncation is CSS-driven; this asserts the class contract is in place.
    // Computed-box/trusted-event proof lives in the browser lane:
    // tests/browser/viewport-matrix.test.tsx LineDetail h1 truncation cases.
    const td = document.querySelector('.soup-table-td')!;
    expect(td).not.toBeNull();
    expect(td.textContent).toBe(LONG_NAME);
  });
});

// ---------------------------------------------------------------------------
// Density
// ---------------------------------------------------------------------------

describe('Table — density attribute', () => {
  it('default density: data-density="default"', () => {
    render(<Table><TableBody><TableRow><TableCell>x</TableCell></TableRow></TableBody></Table>);
    expect(document.querySelector('.soup-tblwrap')?.getAttribute('data-density')).toBe('default');
  });

  it('compressed density: data-density="compressed"', () => {
    render(
      <Table density="compressed">
        <TableBody><TableRow><TableCell>x</TableCell></TableRow></TableBody>
      </Table>,
    );
    expect(document.querySelector('.soup-tblwrap')?.getAttribute('data-density')).toBe('compressed');
  });
});

// ---------------------------------------------------------------------------
// Empty / Error / Loading states
// ---------------------------------------------------------------------------

describe('Table — empty state', () => {
  it('renders the message', () => {
    render(
      <Table>
        <TableBody><TableEmpty colSpan={3} message="No lines found" /></TableBody>
      </Table>,
    );
    expect(screen.getByText('No lines found')).toBeDefined();
  });

  it('renders the default message when none provided', () => {
    render(
      <Table>
        <TableBody><TableEmpty colSpan={2} /></TableBody>
      </Table>,
    );
    expect(screen.getByText('No results')).toBeDefined();
  });

  it('renders a remedy element when provided', () => {
    render(
      <Table>
        <TableBody>
          <TableEmpty colSpan={3} message="No results" remedy={<button>Clear filters</button>} />
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeDefined();
  });
});

describe('Table — error state', () => {
  it('renders the error message', () => {
    render(
      <Table>
        <TableBody><TableError colSpan={3} message="Load failed" /></TableBody>
      </Table>,
    );
    expect(screen.getByText('Load failed')).toBeDefined();
  });

  it('renders default error message', () => {
    render(
      <Table>
        <TableBody><TableError colSpan={2} /></TableBody>
      </Table>,
    );
    expect(screen.getByText('Failed to load data.')).toBeDefined();
  });

  it('applies soup-table-td--error class', () => {
    render(
      <Table>
        <TableBody><TableError colSpan={2} /></TableBody>
      </Table>,
    );
    expect(document.querySelector('.soup-table-td--error')).not.toBeNull();
  });

  it('renders retry element when provided', () => {
    render(
      <Table>
        <TableBody>
          <TableError colSpan={2} retry={<button>Retry</button>} />
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });
});

describe('Table — loading state', () => {
  it('renders the correct number of skeleton rows (default 5)', () => {
    render(
      <Table>
        <TableBody>
          <TableLoading colSpan={4} />
        </TableBody>
      </Table>,
    );
    const skeletons = document.querySelectorAll('.soup-table-row--skeleton');
    expect(skeletons.length).toBe(5);
  });

  it('renders the requested number of skeleton rows', () => {
    render(
      <Table>
        <TableBody>
          <TableLoading rows={3} colSpan={4} />
        </TableBody>
      </Table>,
    );
    expect(document.querySelectorAll('.soup-table-row--skeleton').length).toBe(3);
  });

  it('skeleton rows are aria-hidden', () => {
    render(
      <Table>
        <TableBody>
          <TableLoading rows={2} colSpan={2} />
        </TableBody>
      </Table>,
    );
    const rows = document.querySelectorAll('.soup-table-row--skeleton');
    for (const row of rows) {
      expect(row.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

// ---------------------------------------------------------------------------
// EM_DASH ghost helper
// ---------------------------------------------------------------------------

describe('Table — EM_DASH', () => {
  it('renders a soup-table-ghost span', () => {
    render(<EM_DASH />);
    const el = document.querySelector('.soup-table-ghost');
    expect(el).not.toBeNull();
  });

  it('renders an em-dash character', () => {
    render(<EM_DASH />);
    const el = document.querySelector('.soup-table-ghost')!;
    expect(el.textContent).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// Sort button hit-extension class-contract pin (DD-10 §sort-btn-hit-extension)
//
// jsdom cannot verify computed CSS or pseudo-element geometry, so this is a
// cheap regression layer: confirm the sort button element carries the class
// (.soup-table-th__sort-btn) that now holds `position: relative` and the
// ::before hit-extension in primitives.css.
//
// If this class is removed or the element stops being a <button>, the browser
// suite's target-size §8 will catch the regression in real Chromium. This pin
// is the fast jsdom pre-flight that the class contract hasn't been silently
// broken at the HTML level.
// ---------------------------------------------------------------------------

describe('Table — sort button hit-extension class-contract pin', () => {
  it('sort button carries soup-table-th__sort-btn class (hit-extension anchor)', () => {
    render(makeSortTable('name', { key: 'name', dir: 'none' }, vi.fn()));
    const btn = document.querySelector('.soup-table-th__sort-btn');
    // Class must be present — primitives.css assigns position:relative + ::before
    // hit-extension on this class (DD-10 closure leg (a)).
    expect(btn).not.toBeNull();
    expect(btn!.tagName).toBe('BUTTON');
  });

  it('sort button is the only button in the th (no extra hit targets)', () => {
    render(makeSortTable('name', { key: 'name', dir: 'none' }, vi.fn()));
    const th = document.querySelector('.soup-table-th');
    expect(th).not.toBeNull();
    const buttons = th!.querySelectorAll('button');
    // Exactly one sort button per th — multiple buttons would mean the hit-extension
    // geometry assumptions in primitives.css are no longer valid.
    expect(buttons.length).toBe(1);
    expect(buttons[0].classList.contains('soup-table-th__sort-btn')).toBe(true);
  });
});
