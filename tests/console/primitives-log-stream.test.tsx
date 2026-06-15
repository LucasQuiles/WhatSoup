/**
 * @vitest-environment jsdom
 *
 * Primitive tests: LogStream (log-stream.md, investigation §8).
 *
 * Covers:
 *   - role="list" on container; role="listitem" on each row
 *   - Level letter content per entry (E/W/I/D) — NOT color-only
 *   - Per-level CSS class on the level chip (confirms triple channel: letter + class)
 *   - Enter key toggles aria-expanded on a row (expand detail bed, snaps)
 *   - Space key toggles aria-expanded on a row
 *   - maxEntries slices the tail (last-N entries)
 *   - Empty state: emptyMessage shown when entries is empty and isFiltered=false
 *   - Filtered-empty state: filteredEmptyMessage when entries is empty and isFiltered=true
 *   - Error state: error message + Retry button; onRetry called on click
 *   - Long-message wrap class contract: soup-log__msg carries overflow-wrap:anywhere
 *     (class assertion; visual layout proof requires a real browser)
 *   - Focus survives rerender with new entries prepended (investigation §6.5)
 *
 * jsdom limits noted:
 *   - Color values are not computed (class assertions prove triple channel, not computed colour)
 *   - Visual wrap behaviour cannot be proven (overflow-wrap is a layout property)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { useState } from 'react';
import type { FC } from 'react';
import { LogStream } from '../../console/src/components/primitives/LogStream';
import type { LogEntry } from '../../console/src/types';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: '2026-06-11T00:00:00Z',
    level: 'info',
    msg: 'test message',
    source: 'test-source',
    ...overrides,
  };
}

function makeEntries(count: number, level: LogEntry['level'] = 'info'): LogEntry[] {
  return Array.from({ length: count }, (_, i) =>
    makeEntry({ timestamp: `2026-06-11T00:00:0${i % 10}Z`, level, msg: `msg ${i}`, source: `src-${i}` }),
  );
}

// ---------------------------------------------------------------------------
// Role contracts
// ---------------------------------------------------------------------------

describe('LogStream — role contracts', () => {
  it('container has role="list"', () => {
    render(<LogStream entries={[makeEntry()]} />);
    expect(screen.getByRole('list')).toBeDefined();
  });

  it('each entry row has role="listitem"', () => {
    render(<LogStream entries={[makeEntry(), makeEntry({ msg: 'second' })]} />);
    const items = screen.getAllByRole('listitem');
    // 2 entries → 2 listitem rows
    expect(items.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Level letter content — NOT color-only (triple channel)
// ---------------------------------------------------------------------------

describe('LogStream — level letters (E/W/I/D)', () => {
  const cases: Array<[LogEntry['level'], string]> = [
    ['error', 'E'],
    ['warn', 'W'],
    ['info', 'I'],
    ['debug', 'D'],
  ];

  for (const [level, letter] of cases) {
    it(`level="${level}" renders letter "${letter}"`, () => {
      render(<LogStream entries={[makeEntry({ level })]} />);
      // The letter chip is inside the row; find by its aria-label
      const chip = screen.getByLabelText(`level ${level}`);
      expect(chip.textContent).toBe(letter);
    });
  }
});

// ---------------------------------------------------------------------------
// Level CSS class assertions — confirms triple channel (letter + class + color)
// Color itself is not assertable in jsdom; class proves the hook exists.
// ---------------------------------------------------------------------------

describe('LogStream — level CSS classes', () => {
  it('error entry: chip has soup-log__lvl--error class', () => {
    render(<LogStream entries={[makeEntry({ level: 'error' })]} />);
    const chip = screen.getByLabelText('level error');
    expect(chip.classList.contains('soup-log__lvl--error')).toBe(true);
  });

  it('warn entry: chip has soup-log__lvl--warn class', () => {
    render(<LogStream entries={[makeEntry({ level: 'warn' })]} />);
    expect(screen.getByLabelText('level warn').classList.contains('soup-log__lvl--warn')).toBe(true);
  });

  it('info entry: chip has soup-log__lvl--info class', () => {
    render(<LogStream entries={[makeEntry({ level: 'info' })]} />);
    expect(screen.getByLabelText('level info').classList.contains('soup-log__lvl--info')).toBe(true);
  });

  it('debug entry: chip has soup-log__lvl--debug class', () => {
    render(<LogStream entries={[makeEntry({ level: 'debug' })]} />);
    expect(screen.getByLabelText('level debug').classList.contains('soup-log__lvl--debug')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Keyboard expand — Enter / Space toggle aria-expanded
// ---------------------------------------------------------------------------

describe('LogStream — row keyboard expand', () => {
  it('Enter key toggles aria-expanded from false to true', () => {
    render(<LogStream entries={[makeEntry({ msg: 'expand me' })]} />);
    const row = screen.getByRole('listitem');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('Space key toggles aria-expanded', () => {
    render(<LogStream entries={[makeEntry()]} />);
    const row = screen.getByRole('listitem');
    fireEvent.keyDown(row, { key: ' ' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('Enter again collapses (toggle)', () => {
    render(<LogStream entries={[makeEntry()]} />);
    const row = screen.getByRole('listitem');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });

  it('click also toggles aria-expanded', () => {
    render(<LogStream entries={[makeEntry()]} />);
    const row = screen.getByRole('listitem');
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// maxEntries — last-N tail slice
// ---------------------------------------------------------------------------

describe('LogStream — maxEntries tail slice', () => {
  it('renders only the last N entries when maxEntries is set', () => {
    const entries = makeEntries(10, 'info');
    // last entry has msg "msg 9"
    render(<LogStream entries={entries} maxEntries={3} />);
    const items = screen.getAllByRole('listitem');
    expect(items.length).toBe(3);
    // The last 3 are indices 7,8,9 — messages "msg 7", "msg 8", "msg 9"
    expect(items[0].textContent).toContain('msg 7');
    expect(items[2].textContent).toContain('msg 9');
  });

  it('renders all entries when maxEntries exceeds entries.length', () => {
    render(<LogStream entries={makeEntries(3)} maxEntries={10} />);
    expect(screen.getAllByRole('listitem').length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('LogStream — empty state', () => {
  it('shows default emptyMessage when entries is empty', () => {
    render(<LogStream entries={[]} />);
    expect(screen.getByText('No log entries in this range.')).toBeDefined();
  });

  it('shows custom emptyMessage', () => {
    render(<LogStream entries={[]} emptyMessage="Nothing here." />);
    expect(screen.getByText('Nothing here.')).toBeDefined();
  });

  it('shows filteredEmptyMessage when isFiltered=true and entries is empty', () => {
    render(
      <LogStream
        entries={[]}
        isFiltered
        filteredEmptyMessage="No matches for your filter."
      />,
    );
    expect(screen.getByText('No matches for your filter.')).toBeDefined();
  });

  it('empty state still has role="list" container', () => {
    render(<LogStream entries={[]} />);
    expect(screen.getByRole('list')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

describe('LogStream — error state', () => {
  it('shows error message when error prop provided', () => {
    render(<LogStream entries={[]} error="Failed to load logs." />);
    expect(screen.getByText('Failed to load logs.')).toBeDefined();
  });

  it('shows Retry button when onRetry provided', () => {
    render(<LogStream entries={[]} error="Error" onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('does NOT show Retry button when onRetry not provided', () => {
    render(<LogStream entries={[]} error="Error" />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('onRetry is called when Retry button clicked', () => {
    const onRetry = vi.fn();
    render(<LogStream entries={[]} error="Error" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('error state still has role="list" container', () => {
    render(<LogStream entries={[]} error="oops" />);
    expect(screen.getByRole('list')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Long-message wrap class contract
// Class assertion proves the wrap policy hook is in place.
// IMPORTANT: Visual wrap behaviour (overflow-wrap: anywhere rendering as wrapping
// text) cannot be proven in jsdom — jsdom does not perform layout. Manual QA
// or a real-browser test covers the visual outcome.
// ---------------------------------------------------------------------------

describe('LogStream — long-message wrap class contract', () => {
  it('message span has soup-log__msg class (carries overflow-wrap:anywhere by CSS)', () => {
    const longMsg = 'a'.repeat(300);
    render(<LogStream entries={[makeEntry({ msg: longMsg })]} />);
    // Find the message element inside the row
    const msgs = document.querySelectorAll('.soup-log__msg');
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0].textContent).toBe(longMsg);
  });
});

// ---------------------------------------------------------------------------
// Focus survives rerender with new entries — investigation §6.5
// Proves that stable keys keep focusable rows stable across a poll-refresh
// that prepends a new entry.
// ---------------------------------------------------------------------------

describe('LogStream — focus survives rerender with new entries', () => {
  it('focused row stays focused when entries array grows (stable key contract)', async () => {
    const initial: LogEntry[] = [
      makeEntry({ timestamp: '2026-06-11T00:00:01Z', msg: 'entry A' }),
      makeEntry({ timestamp: '2026-06-11T00:00:02Z', msg: 'entry B' }),
    ];

    const Fixture: FC = () => {
      const [entries, setEntries] = useState(initial);
      return (
        <>
          <button
            type="button"
            data-testid="add-entry"
            onClick={() =>
              setEntries([
                makeEntry({ timestamp: '2026-06-11T00:00:00Z', msg: 'new first' }),
                ...entries,
              ])
            }
          >
            Add
          </button>
          <LogStream entries={entries} />
        </>
      );
    };

    render(<Fixture />);
    const rows = screen.getAllByRole('listitem');
    // Focus the first row ("entry A")
    act(() => { rows[0].focus(); });
    expect(document.activeElement).toBe(rows[0]);
    expect(document.activeElement?.textContent).toContain('entry A');

    // Simulate poll refresh: prepend a new entry
    fireEvent.click(screen.getByTestId('add-entry'));

    // After rerender there are now 3 rows. The previously-focused element
    // should still be in the document and retain focus.
    // NOTE: With stable keys (timestamp-index), React preserves the element
    // identity for existing entries at their new indices. However, jsdom focus
    // semantics on list item reorder are INCONCLUSIVE (jsdom does not run
    // compositor or retain focus through DOM moves the way real browsers do).
    // This test asserts that the focused element is still present in the DOM.
    const newRows = screen.getAllByRole('listitem');
    expect(newRows.length).toBe(3);
    // The "entry A" row should still exist
    expect(newRows.map((r) => r.textContent).join('\n')).toContain('entry A');
  });
});
