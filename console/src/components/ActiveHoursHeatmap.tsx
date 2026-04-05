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

/** 7×24 heatmap of message activity by day-of-week and hour. */
export function ActiveHoursHeatmap({ data }: { data: number[][] }) {
  const max = Math.max(...data.flat(), 1);

  return (
    <section
      className="c-card font-mono"
      style={{
        padding: 'var(--sp-4)',
        background: 'var(--color-d2)',
      }}
    >
      <div
        className="font-mono text-t4"
        style={{
          fontSize: 'var(--font-size-xs)',
          marginBottom: 'var(--sp-3)',
          textTransform: 'uppercase',
          letterSpacing: 'var(--tracking-label)',
        }}
      >
        Active Hours
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '32px repeat(24, 1fr)',
          gap: '2px',
        }}
      >
        {/* Hour header row */}
        <div />
        {HOURS.map((h) => (
          <div
            key={`h-${h}`}
            className="text-t5 font-mono leading-tight"
            style={{
              fontSize: '9px',
              textAlign: 'center',
            }}
          >
            {h % 3 === 0 ? formatHour(h) : ''}
          </div>
        ))}

        {/* Data rows */}
        {DAYS.map((day, di) => (
          <>
            <div
              key={`d-${di}`}
              className="text-t4 font-mono leading-snug"
              style={{
                fontSize: 'var(--font-size-xs)',
                paddingRight: '4px',
                textAlign: 'right',
              }}
            >
              {day}
            </div>
            {HOURS.map((h) => {
              const value = data[di]?.[h] ?? 0;
              return (
                <div
                  key={`${di}-${h}`}
                  title={`${day} ${formatHour(h)}: ${value} messages`}
                  style={{
                    background: intensityColor(value, max),
                    borderRadius: 'var(--radius-sm)',
                    height: '18px',
                  }}
                />
              );
            })}
          </>
        ))}
      </div>

      {/* Legend */}
      <div
        className="flex items-center text-t5 font-mono"
        style={{
          fontSize: '9px',
          marginTop: 'var(--sp-3)',
          gap: 'var(--sp-2)',
          justifyContent: 'flex-end',
        }}
      >
        <span>Less</span>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <div
            key={ratio}
            style={{
              width: '12px',
              height: '12px',
              borderRadius: 'var(--radius-sm)',
              background: intensityColor(ratio * max, max),
            }}
          />
        ))}
        <span>More</span>
      </div>
    </section>
  );
}
