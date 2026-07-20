import React from 'react';
import type { MetricsRange } from './line-detail/types';
import { formatShortDate } from '../lib/format-time';
import { Card } from './primitives';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function intensityColor(value: number, max: number): string {
  if (max === 0 || value === 0) return 'var(--surface-raised)';
  const ratio = value / max;
  if (ratio < 0.25) return 'color-mix(in srgb, var(--data-activity-solid) 15%, var(--surface-raised))';
  if (ratio < 0.5) return 'color-mix(in srgb, var(--data-activity-solid) 35%, var(--surface-raised))';
  if (ratio < 0.75) return 'color-mix(in srgb, var(--data-activity-solid) 60%, var(--surface-raised))';
  return 'var(--data-activity-solid)';
}

function formatHour(h: number): string {
  if (h === 0) return '12a';
  if (h < 12) return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}

function HeatmapLegend({ max }: { max: number }) {
  return (
    <div className="flex items-center text-text-2 font-mono justify-end mt-[var(--sp-3)] gap-[var(--sp-2)] text-xs">
      <span>Less</span>
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
        <div key={ratio} className="w-[var(--sp-3)] h-[var(--sp-3)] rounded-sm" style={{ background: intensityColor(ratio * max, max) }} />
      ))}
      <span>More</span>
    </div>
  );
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
export function ActiveHoursHeatmap({ data, byDate, range }: {
  data: number[][];
  byDate?: { date: string; hours: number[] }[];
  range?: MetricsRange;
}) {
  const is24h = range === '24h';
  const is7d = range === '7d';

  if (is24h) {
    const hourly = collapseToSingleDay(data);
    const max = Math.max(...hourly, 1);

    return (
      <Card variant="base" as="section" className="font-mono p-[var(--sp-4)]">
        <div
          className="font-mono text-text-2 mb-[var(--sp-3)] uppercase tracking-[var(--tracking-label)] text-xs"
        >
          Active Hours
        </div>

        {/* 24h bar chart */}
        <div
          className="flex items-end gap-[var(--bw-accent)] h-[var(--heatmap-h)]"
        >
          {hourly.map((value, h) => (
            <div
              key={h}
              title={`${formatHour(h)}: ${value} messages`}
              className="flex-1 rounded-sm rounded-b-none"
              style={{
                height: max > 0 ? `${Math.max((value / max) * 100, value > 0 ? 4 : 0)}%` : '0%',
                background: value > 0 ? intensityColor(value, max) : 'var(--btn-neutral-bg)',
                minHeight: value > 0 ? 'var(--bw-accent)' : undefined,
              }}
            />
          ))}
        </div>

        {/* Hour labels */}
        <div className="flex mt-[var(--bw-accent)]">
          {HOURS.map((h) => (
            <div
              key={h}
              className="flex-1 text-text-2 font-mono leading-tight text-center text-xs"
            >
              {h % 3 === 0 ? formatHour(h) : ''}
            </div>
          ))}
        </div>
      </Card>
    );
  }

  // 30d with per-date data — dates on X axis, hours on Y axis
  if (range === '30d' && byDate && byDate.length > 0) {
    const allValues = byDate.flatMap(d => d.hours);
    const max = Math.max(...allValues, 1);
    const labelEvery = byDate.length > 20 ? 5 : byDate.length > 10 ? 3 : 1;
    const dateLabels = byDate.map(d => formatShortDate(`${d.date}T00:00:00`));

    return (
      <Card variant="base" as="section" className="font-mono p-[var(--sp-4)]">
        <div className="font-mono text-text-2 mb-[var(--sp-3)] uppercase tracking-[var(--tracking-label)] text-xs">
          Active Hours ({byDate.length} days)
        </div>
        <div
          className="grid gap-[var(--bw-accent)]"
          style={{ gridTemplateColumns: `var(--avatar-sm) repeat(${byDate.length}, 1fr)` }}
        >
          {/* Date header row */}
          <div />
          {byDate.map(({ date }, i) => (
            <div
              key={`d-${date}`}
              title={i % labelEvery === 0 ? dateLabels[i] : undefined}
              className="text-text-2 font-mono leading-tight text-center text-xs truncate"
            >
              {i % labelEvery === 0 ? dateLabels[i] : ''}
            </div>
          ))}

          {/* Hour rows */}
          {HOURS.map((h) => (
            <React.Fragment key={`hr-${h}`}>
              <div className="text-text-2 font-mono leading-snug text-right pr-[var(--sp-1)] text-xs">
                {h % 3 === 0 ? formatHour(h) : ''}
              </div>
              {byDate.map(({ date, hours }, di) => {
                const value = hours[h] ?? 0;
                return (
                  <div
                    key={`${h}-${date}`}
                    title={`${dateLabels[di]} ${formatHour(h)}: ${value} messages`}
                    className="rounded-sm h-[var(--heatmap-cell)]"
                    style={{ background: intensityColor(value, max) }}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </div>

        <HeatmapLegend max={max} />
      </Card>
    );
  }

  // 7d / 30d — full 7×24 heatmap grid
  const max = Math.max(...data.flat(), 1);

  return (
    <Card variant="base" as="section" className="font-mono p-[var(--sp-4)]">
      <div
        className="font-mono text-text-2 mb-[var(--sp-3)] uppercase tracking-[var(--tracking-label)] text-xs"
      >
        Active Hours {!is7d ? '(weekly pattern)' : ''}
      </div>

      {is7d ? (
        /* 7d: days on Y, hours on X — compact 7-row layout */
        <div
          className="grid gap-[var(--bw-accent)]"
          style={{
            gridTemplateColumns: 'var(--avatar-sm) repeat(24, 1fr)',
          }}
        >
          {/* Hour header row */}
          <div />
          {HOURS.map((h) => (
            <div
              key={`h-${h}`}
              className="text-text-2 font-mono leading-tight text-center text-xs"
            >
              {h % 3 === 0 ? formatHour(h) : ''}
            </div>
          ))}

          {/* Day rows */}
          {DAYS.map((day, di) => (
            <React.Fragment key={`dr-${di}`}>
              <div
                className="text-text-2 font-mono leading-snug text-right pr-[var(--sp-1)] text-xs"
              >
                {day}
              </div>
              {HOURS.map((h) => {
                const value = data[di]?.[h] ?? 0;
                return (
                  <div
                    key={`${di}-${h}`}
                    title={`${day} ${formatHour(h)}: ${value} messages`}
                    className="rounded-sm h-[var(--heatmap-cell)]"
                    style={{
                      background: intensityColor(value, max),
                    }}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </div>
      ) : (
        /* 30d: hours on Y, days on X — tall layout for weekly pattern */
        <div
          className="grid gap-[var(--bw-accent)]"
          style={{
            gridTemplateColumns: `var(--avatar-sm) repeat(${DAYS.length}, 1fr)`,
          }}
        >
          {/* Day header row */}
          <div />
          {DAYS.map((day, di) => (
            <div
              key={`d-${di}`}
              className="text-text-2 font-mono leading-tight text-center text-xs"
            >
              {day}
            </div>
          ))}

          {/* Hour rows */}
          {HOURS.map((h) => (
            <React.Fragment key={`hr-${h}`}>
              <div
                className="text-text-2 font-mono leading-snug text-right pr-[var(--sp-1)] text-xs"
              >
                {h % 3 === 0 ? formatHour(h) : ''}
              </div>
              {DAYS.map((day, di) => {
                const value = data[di]?.[h] ?? 0;
                return (
                  <div
                    key={`${h}-${di}`}
                    title={`${day} ${formatHour(h)}: ${value} messages`}
                    className="rounded-sm h-[var(--heatmap-cell)]"
                    style={{
                      background: intensityColor(value, max),
                    }}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </div>
      )}

      <HeatmapLegend max={max} />
    </Card>
  );
}
