/**
 * LineSpark (T5 b-03) — per-line 7d message-volume sparkbar (mockup .spark).
 *
 * Data honesty: the series is fetched lazily per row from the existing
 * /api/lines/:name/metrics?range=7d endpoint via the shared query options
 * (same cache as LineDetail). Until data lands (or if the line has no message
 * telemetry) the cell renders the EM_DASH — never fabricated bars. Bars are
 * normalized to the row's own max with a 5% floor so zero days still render
 * the mockup stub; the top quartile carries the .hi ink emphasis.
 */
import { type FC, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getMetricsQueryOptions } from '../../hooks/use-metrics';
import { EM_DASH } from '../primitives';

const BARS = 7;
/** Re-fetch cadence for a row's 7d series — the series is day-granular, so a
 *  long staleTime keeps the 200-line query fan-out bounded (perf §1). */
const SPARK_STALE_MS = 5 * 60 * 1000;

export const LineSpark: FC<{ name: string }> = ({ name }) => {
  const opts = getMetricsQueryOptions(name, '7d');
  const { data, isError } = useQuery({
    ...opts,
    staleTime: SPARK_STALE_MS,
  });

  const bars = useMemo(() => {
    if (!data?.hasMessageData) return null;
    const vals = data.messageVolume
      .slice(-BARS)
      .map((b) => b.inbound + b.outbound);
    if (vals.length === 0) return null;
    const max = Math.max(...vals, 1);
    return vals.map((v) => ({
      height: Math.max(5, Math.round((v / max) * 100)),
      hi: v > 0 && v >= max * 0.75,
    }));
  }, [data]);

  if (isError) {
    return <span title="7d series unavailable"><EM_DASH /></span>;
  }
  if (!bars) {
    return <EM_DASH />;
  }
  return (
    <span className="fleet-spark" aria-hidden="true">
      {bars.map((b, i) => (
        <i key={i} className={b.hi ? 'hi' : undefined} style={{ height: `${b.height}%` }} />
      ))}
    </span>
  );
};
