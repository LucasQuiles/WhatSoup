import type { MetricsRange } from './line-detail/types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function intensityColor(value: number, max: number): string {
  if (max === 0 || value === 0) return 'var(--color-d2)';
  const ratio = value / max;
  // 4-stop opacity ramp against the accent color
  if (ratio < 0.25) return 'color-mix(in srgb, var(--color-m-cht) 15%, var(--color-d2))';
  if (ratio < 0.5) return 'color-mix(in srgb, var(--color-m-cht) 35%, var(--color-d2))';
  if (ratio < 0.75) return 'color-mix(in srgb, var(--color-m-cht) 60%, var(--color-d2))';
  return 'var(--color-m-cht)';
}

function formatHour(h: number): string {
  if (h === 0) return '12a';
  if (h < 12) return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}

/** Collapse a 7×24 grid into a single 24-element array by summing across days. */
function collapseToSingleDay(data: number[][]): number[] {
  const collapsed = new Array<number>(24).fill(0);
  for (const row of data) {
    for (let h = 0; h < 24; h++) {
      collapsed[h] += row[h] ?? 0;
    }
  }
  return collapsed;
}

/** 7×24 heatmap of message activity, or a single 24h bar chart when range is '24h'. */
export function ActiveHoursHeatmap({ data, range }: { data: number[][]; range?: MetricsRange }) {
  const is24h = range === '24h';

  if (is24h) {
    const hourly = collapseToSingleDay(data);
    const max = Math.max(...hourly, 1);

    return (
      <section
        className="c-card font-mono p-[var(--sp-4)] bg-d2"
      >
        <div
          className="font-mono text-t4 text-[var(--font-size-xs)] mb-[var(--sp-3)] uppercase tracking-[var(--tracking-label)]"
        >
          Active Hours
        </div>

        {/* 24h bar chart */}
        <div
          className="flex items-end gap-[var(--sp-1)] h-[var(--avatar-lg)]"
        >
          {hourly.map((value, h) => (
            <div
              key={h}
              title={`${formatHour(h)}: ${value} messages`}
              className="flex-1 rounded-t-sm"
              style={{
                height: max > 0 ? `${Math.max((value / max) * 100, value > 0 ? 4 : 0)}%` : '0%',
                background: value > 0 ? intensityColor(value, max) : 'var(--color-d4)',
                minHeight: value > 0 ? '2px' : undefined,
              }}
            />
          ))}
        </div>

        {/* Hour labels */}
        <div className="flex mt-[var(--sp-0h)]">
          {HOURS.map((h) => (
            <div
              key={h}
              className="text-t5 font-mono leading-tight flex-1 text-[var(--font-size-xs)] text-center"
            >
              {h % 3 === 0 ? formatHour(h) : ''}
            </div>
          ))}
        </div>
      </section>
    );
  }

  // 7d / 30d — full 7×24 heatmap grid
  const max = Math.max(...data.flat(), 1);

  return (
    <section
      className="c-card font-mono p-[var(--sp-4)] bg-d2"
    >
      <div
        className="font-mono text-t4 text-[var(--font-size-xs)] mb-[var(--sp-3)] uppercase tracking-[var(--tracking-label)]"
      >
        Active Hours
      </div>

      <div
        className="gap-[var(--sp-1)]"
        style={{
          display: 'grid',
          gridTemplateColumns: 'var(--avatar-sm) repeat(24, 1fr)',
        }}
      >
        {/* Hour header row */}
        <div />
        {HOURS.map((h) => (
          <div
            key={`h-${h}`}
            className="text-t5 font-mono leading-tight text-[var(--font-size-xs)] text-center"
          >
            {h % 3 === 0 ? formatHour(h) : ''}
          </div>
        ))}

        {/* Data rows */}
        {DAYS.map((day, di) => (
          <>
            <div
              key={`d-${di}`}
              className="text-t4 font-mono leading-snug text-[var(--font-size-xs)] text-right pr-[var(--sp-1)]"
            >
              {day}
            </div>
            {HOURS.map((h) => {
              const value = data[di]?.[h] ?? 0;
              return (
                <div
                  key={`${di}-${h}`}
                  title={`${day} ${formatHour(h)}: ${value} messages`}
                  className="rounded-sm h-[var(--heatmap-cell-h)]"
                  style={{
                    background: intensityColor(value, max),
                  }}
                />
              );
            })}
          </>
        ))}
      </div>

      {/* Legend */}
      <div
        className="flex items-center text-t5 font-mono text-[var(--font-size-xs)] mt-[var(--sp-3)] gap-[var(--sp-2)] justify-end"
      >
        <span>Less</span>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <div
            key={ratio}
            className="w-[var(--dot-xs)] h-[var(--dot-xs)] rounded-sm"
            style={{
              background: intensityColor(ratio * max, max),
            }}
          />
        ))}
        <span>More</span>
      </div>
    </section>
  );
}
