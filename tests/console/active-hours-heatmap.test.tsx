/**
 * ActiveHoursHeatmap — pure render coverage for the active-hours visualization.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ActiveHoursHeatmap } from '../../console/src/components/ActiveHoursHeatmap';

afterEach(() => cleanup());

const ACTIVITY_FULL = 'var(--data-activity-solid)';
const ZERO_FILL = 'var(--surface-raised)';

function zeroGrid(): number[][] {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
}

function gridWithCell(di: number, h: number, value: number): number[][] {
  const grid = zeroGrid();
  grid[di][h] = value;
  return grid;
}

// ---------------------------------------------------------------------------
// 24h range — single-day bar chart collapsed across days
// ---------------------------------------------------------------------------

describe('ActiveHoursHeatmap — 24h range', () => {
  it('collapses 7-day grid into 24 hourly bars and labels every third hour', () => {
    // Spread the same value across all 7 days at hour 9; total should be 7
    const data = zeroGrid();
    for (let di = 0; di < 7; di++) data[di][9] = 1;
    const { container } = render(<ActiveHoursHeatmap data={data} range="24h" />);

    // 24 bar divs with title attributes — count by title presence
    const bars = container.querySelectorAll('div[title]');
    expect(bars.length).toBe(24);

    const hourNineBar = container.querySelector('div[title="9a: 7 messages"]');
    expect(hourNineBar).not.toBeNull();
    const hourTenBar = container.querySelector('div[title="10a: 0 messages"]');
    expect(hourTenBar).not.toBeNull();

    // Hour labels: only hours where h % 3 === 0 carry text (12a, 3a, 6a, 9a, 12p, 3p, 6p, 9p)
    expect(container.textContent).toContain('12a');
    expect(container.textContent).toContain('3a');
    expect(container.textContent).toContain('12p');
    expect(container.textContent).toContain('9p');
  });

  it('renders the section heading and treats empty grid without throwing', () => {
    const { container } = render(<ActiveHoursHeatmap data={zeroGrid()} range="24h" />);
    expect(container.textContent).toContain('Active Hours');

    // All 24 zero bars: background should be the btn-neutral-bg (no-fill) color, not the accent
    const zeroBar = container.querySelector('div[title="12a: 0 messages"]') as HTMLElement;
    expect(zeroBar).not.toBeNull();
    expect(zeroBar.style.background).toContain('var(--btn-neutral-bg)');
    expect(zeroBar.style.height).toBe('0%');
  });

  it('formats hours across the 12a/12p boundary correctly', () => {
    const data = zeroGrid();
    data[0][0] = 5;   // 12a
    data[0][11] = 5;  // 11a
    data[0][12] = 5;  // 12p
    data[0][23] = 5;  // 11p
    const { container } = render(<ActiveHoursHeatmap data={data} range="24h" />);

    expect(container.querySelector('div[title="12a: 5 messages"]')).not.toBeNull();
    expect(container.querySelector('div[title="11a: 5 messages"]')).not.toBeNull();
    expect(container.querySelector('div[title="12p: 5 messages"]')).not.toBeNull();
    expect(container.querySelector('div[title="11p: 5 messages"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7d range — compact day-on-Y, hour-on-X grid
// ---------------------------------------------------------------------------

describe('ActiveHoursHeatmap — 7d range', () => {
  it('renders 7 day-row labels and 24 hour-column titles per row', () => {
    const { container } = render(<ActiveHoursHeatmap data={zeroGrid()} range="7d" />);

    for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(container.textContent).toContain(day);
    }

    // 7 days x 24 hours = 168 cells with titles
    const cells = container.querySelectorAll('div[title]');
    expect(cells.length).toBe(168);
  });

  it('omits the "(weekly pattern)" subheading and surfaces a hot cell color', () => {
    const data = gridWithCell(3, 14, 10); // Wed 2p
    const { container } = render(<ActiveHoursHeatmap data={data} range="7d" />);

    expect(container.textContent).toContain('Active Hours');
    expect(container.textContent).not.toContain('weekly pattern');

    const hot = container.querySelector('div[title="Wed 2p: 10 messages"]') as HTMLElement;
    expect(hot).not.toBeNull();
    expect(hot.style.background).toBe(ACTIVITY_FULL);

    const cold = container.querySelector('div[title="Sun 12a: 0 messages"]') as HTMLElement;
    expect(cold).not.toBeNull();
    expect(cold.style.background).toBe(ZERO_FILL);
  });

  it('renders the legend with five color swatches plus Less/More labels', () => {
    const { container } = render(<ActiveHoursHeatmap data={zeroGrid()} range="7d" />);
    expect(container.textContent).toContain('Less');
    expect(container.textContent).toContain('More');
    // Legend swatches use rounded-sm w-[var(--sp-3)] h-[var(--sp-3)]; identify by class
    const swatches = container.querySelectorAll('div.w-\\[var\\(--sp-3\\)\\].h-\\[var\\(--sp-3\\)\\].rounded-sm');
    expect(swatches.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 30d range with byDate — date-on-X, hour-on-Y grid
// ---------------------------------------------------------------------------

describe('ActiveHoursHeatmap — 30d with byDate', () => {
  function byDateFor(dates: string[]): { date: string; hours: number[] }[] {
    return dates.map((date) => ({ date, hours: Array.from({ length: 24 }, () => 0) }));
  }

  it('renders the day-count caption and one cell per (hour, date) pair', () => {
    const byDate = byDateFor(['2026-05-01', '2026-05-02', '2026-05-03']);
    byDate[1].hours[10] = 4;
    const { container } = render(
      <ActiveHoursHeatmap data={zeroGrid()} byDate={byDate} range="30d" />,
    );

    expect(container.textContent).toContain('Active Hours (3 days)');
    // Count grid cells by their cell-specific class. The date-header labels also
    // carry a `title` (truncation-resilience disclosure, commit ebe3a7c7), so a
    // bare `div[title]` query over-counts; the cells are the heatmap-cell divs.
    const cells = container.querySelectorAll('div.rounded-sm.h-\\[var\\(--heatmap-cell\\)\\]');
    // 3 dates x 24 hours = 72 cells
    expect(cells.length).toBe(72);

    // Regression guard: the labeled date headers must expose their full date via
    // `title` so a truncated label stays disclosed (no-unsafe-truncation guard).
    // With 3 dates labelEvery=1, so all 3 header labels carry a title.
    const headerTitles = Array.from(
      container.querySelectorAll('div.truncate[title]'),
    ).map((el) => el.getAttribute('title'));
    expect(headerTitles).toHaveLength(3);
    expect(headerTitles.every((t) => t && t.length > 0)).toBe(true);

    // Hour title incorporates locale-formatted date — match by suffix
    const hot = Array.from(cells).find((el) =>
      (el.getAttribute('title') ?? '').endsWith('10a: 4 messages'),
    ) as HTMLElement | undefined;
    expect(hot).toBeDefined();
    expect(hot!.style.background).toBe(ACTIVITY_FULL);
  });

  it('thins date labels when the range grows past 10 and 20 days', () => {
    // 12 dates → labelEvery = 3 → 4 labels visible
    const twelve = byDateFor(
      Array.from({ length: 12 }, (_, i) => `2026-05-${String(i + 1).padStart(2, '0')}`),
    );
    const { container: c12 } = render(
      <ActiveHoursHeatmap data={zeroGrid()} byDate={twelve} range="30d" />,
    );
    // 12 date header divs total, but only indices 0,3,6,9 carry text (4 labels)
    const headerRow12 = c12.querySelectorAll('div.text-text-2.font-mono.leading-tight.text-center.truncate');
    const labeled12 = Array.from(headerRow12).filter((el) => el.textContent && el.textContent.trim() !== '');
    expect(labeled12.length).toBe(4);

    // 25 dates → labelEvery = 5 → ceil(25 / 5) = 5 labels visible
    const twentyFive = byDateFor(
      Array.from({ length: 25 }, (_, i) => `2026-05-${String(i + 1).padStart(2, '0')}`),
    );
    const { container: c25 } = render(
      <ActiveHoursHeatmap data={zeroGrid()} byDate={twentyFive} range="30d" />,
    );
    const headerRow25 = c25.querySelectorAll('div.text-text-2.font-mono.leading-tight.text-center.truncate');
    const labeled25 = Array.from(headerRow25).filter((el) => el.textContent && el.textContent.trim() !== '');
    expect(labeled25.length).toBe(5);
  });

  it('falls back to the weekly-pattern grid when byDate is omitted or empty', () => {
    const { container: cMissing } = render(
      <ActiveHoursHeatmap data={zeroGrid()} range="30d" />,
    );
    expect(cMissing.textContent).toContain('weekly pattern');

    const { container: cEmpty } = render(
      <ActiveHoursHeatmap data={zeroGrid()} byDate={[]} range="30d" />,
    );
    expect(cEmpty.textContent).toContain('weekly pattern');
  });
});

// ---------------------------------------------------------------------------
// Fallback path — 7×24 weekly-pattern grid (no range / 30d without byDate)
// ---------------------------------------------------------------------------

describe('ActiveHoursHeatmap — weekly-pattern fallback', () => {
  it('uses 7-row weekly grid with hours-on-Y when range is undefined', () => {
    const data = gridWithCell(5, 18, 8); // Fri 6p
    const { container } = render(<ActiveHoursHeatmap data={data} />);

    expect(container.textContent).toContain('(weekly pattern)');
    const hot = container.querySelector('div[title="Fri 6p: 8 messages"]') as HTMLElement;
    expect(hot).not.toBeNull();
    expect(hot.style.background).toBe(ACTIVITY_FULL);

    // 7 days x 24 hours = 168 cells in the fallback grid
    const cells = container.querySelectorAll('div[title]');
    expect(cells.length).toBe(168);
  });

  it('renders sparse rows when data is shorter than DAYS or HOURS', () => {
    // Only provide 2 rows; remaining 5 days should still emit zero-value cells
    const partial: number[][] = [
      Array.from({ length: 24 }, () => 0),
      Array.from({ length: 10 }, () => 0), // truncated hour row
    ];
    const { container } = render(<ActiveHoursHeatmap data={partial} range="30d" />);
    const cells = container.querySelectorAll('div[title]');
    expect(cells.length).toBe(168);

    // Out-of-range cells nullish-coalesce to 0 and pick the zero color
    const sat23 = container.querySelector('div[title="Sat 11p: 0 messages"]') as HTMLElement;
    expect(sat23).not.toBeNull();
    expect(sat23.style.background).toBe(ZERO_FILL);
  });
});

// ---------------------------------------------------------------------------
// intensityColor ramp — pinned through the rendered cell backgrounds
// ---------------------------------------------------------------------------

describe('ActiveHoursHeatmap — intensity ramp', () => {
  it('walks through the four-stop ramp as ratio crosses 0.25 / 0.5 / 0.75 / 1.0', () => {
    // max becomes 100; place values at boundary ratios in 7d grid (Sun row)
    const data = zeroGrid();
    data[0][0] = 100; // ratio 1.0 → full accent
    data[0][1] = 74;  // ratio 0.74 → 60% mix
    data[0][2] = 49;  // ratio 0.49 → 35% mix
    data[0][3] = 24;  // ratio 0.24 → 15% mix
    data[0][4] = 0;   // ratio 0    → d2
    const { container } = render(<ActiveHoursHeatmap data={data} range="7d" />);

    const at = (h: number) =>
      (container.querySelector(`div[title="Sun ${h === 0 ? '12a' : `${h}a`}: ${data[0][h]} messages"]`) as HTMLElement)
        .style.background;

    expect(at(0)).toBe(ACTIVITY_FULL);
    expect(at(1)).toContain('60%');
    expect(at(2)).toContain('35%');
    expect(at(3)).toContain('15%');
    expect(at(4)).toBe(ZERO_FILL);
  });
});
