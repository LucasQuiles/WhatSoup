/**
 * HeartbeatRail (T5 b-03) — the activity panel's line-health strip
 * (mockup .hbw): one bar per line, status-shaped (ok bar / warn diamond-bar /
 * crit bar / idle for unproven). Distinct from the per-line HeartbeatStrip
 * (20-beat history) — this is the fleet-at-a-glance rail: one slot per line.
 */
import type { FC } from 'react';
import type { LineInstance } from '../../types';
import { statusSeverity } from '../../lib/status-severity';
import { isLineConnected } from '../../lib/compute-kpis';

function beatClass(line: LineInstance): string {
  // Status severity first: a confirmed crit/warn status reports as down/slow
  // even when the transport signal is unproven (health:null); the idle slot
  // is reserved for lines with no adverse status and no connectivity proof.
  const sev = statusSeverity(line.status);
  if (sev === 'crit') return 'down';
  if (sev === 'warn') return 'slow';
  if (isLineConnected(line)) return '';
  return 'idle';
}

export const HeartbeatRail: FC<{ lines: LineInstance[] }> = ({ lines }) => {
  const healthy = lines.filter((l) => beatClass(l) === '').length;
  return (
    <div className="fleet-hb">
      <span className="fleet-hb__label">
        line health · {lines.length} checks
      </span>
      <div
        className="fleet-hb__bars"
        role="img"
        aria-label={`Line health: ${healthy} of ${lines.length} lines healthy`}
      >
        {lines.map((l) => {
          const cls = beatClass(l);
          return <i key={l.name} className={cls || undefined} />;
        })}
      </div>
    </div>
  );
};
