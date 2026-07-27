/**
 * FleetKpis (T5 b-03) — the mockup .kpis strip: five cards in the k/v/d
 * anatomy (mono caps label, display value, mono subline). Data-honest:
 * every value comes from computeKpis / the fleet metrics endpoint; the
 * "Response p50" slot renders the EM_DASH with a no-telemetry note until
 * b-12 instrumentation exists (never a fabricated percentile).
 *
 * The carried #1881/#1879/#1762 coverage counters (Connectivity unknown /
 * Metrics unavailable / Carried health) + the query-plane freshness marker
 * move to the .fleet-kpis-meta row directly under the strip — same mono t3
 * register as the mockup's .kpi .d subline (documented derivation).
 */
import type { FC, ReactNode } from 'react';
import type { computeKpis } from '../../lib/compute-kpis';
import { formatCompact, formatCount } from '../../lib/text-utils';
import { formatRelative } from '../../lib/format-time';
import { EM_DASH } from '../primitives';

interface FleetKpisProps {
  kpis: ReturnType<typeof computeKpis>;
  lineCount: number;
  /** Fleet token total over the last 24h (input+output), null when the
   *  metrics endpoint has no token data. */
  tokens24h: number | null;
  freshness: { stale: boolean; observedAt: number | null } | null;
}

const Kpi: FC<{ k: string; v: ReactNode; d?: ReactNode; dTone?: 'up' | 'dn' }> = ({
  k,
  v,
  d,
  dTone,
}) => (
  <div className="fleet-kpi">
    <div className="fleet-kpi__k">{k}</div>
    <div className="fleet-kpi__v">{v}</div>
    {d !== undefined && (
      <div className={`fleet-kpi__d${dTone ? ` ${dTone}` : ''}`}>{d}</div>
    )}
  </div>
);

export const FleetKpis: FC<FleetKpisProps> = ({ kpis, lineCount, tokens24h, freshness }) => {
  const messagesToday = kpis.totalSent + kpis.totalReceived;
  return (
    <>
      <section className="fleet-kpis" aria-label="Fleet key indicators">
        <Kpi
          k="Lines online"
          v={
            <>
              {kpis.connected}
              <small>/{lineCount}</small>
            </>
          }
          d={
            kpis.connectivityUnknown > 0
              ? `${kpis.connectivityUnknown} unproven`
              : 'all rows proven'
          }
          dTone={kpis.connectivityUnknown > 0 ? 'dn' : 'up'}
        />
        <Kpi
          k="Agent sessions"
          v={kpis.agentSessions}
          d={`${kpis.unread} unread fleet-wide`}
        />
        <Kpi
          k="Messages today"
          v={formatCount(messagesToday)}
          d={kpis.totalMedia > 0 ? `${formatCount(kpis.totalMedia)} media` : undefined}
        />
        <Kpi
          k="Tokens (24h)"
          v={tokens24h !== null ? formatCompact(tokens24h) : <EM_DASH />}
          d={tokens24h !== null ? 'fleet in+out' : 'no token data'}
        />
        <Kpi
          k="Response p50"
          v={<EM_DASH />}
          d="no telemetry — lands with b-12"
        />
      </section>
      <div className="fleet-kpis-meta">
        <span>
          connectivity unknown {kpis.connectivityUnknown} of {lineCount}
        </span>
        <span>
          metrics unavailable {kpis.metricsUnavailable} of {lineCount}
        </span>
        <span>
          carried health {kpis.staleExcluded} of {lineCount}
        </span>
        {freshness && freshness.observedAt !== null && (
          <span
            className={freshness.stale ? 'warn' : undefined}
            title={
              freshness.stale
                ? `Fleet lines carried forward — last successful fetch ${formatRelative(new Date(freshness.observedAt).toISOString())}`
                : `Last successful fleet lines fetch ${formatRelative(new Date(freshness.observedAt).toISOString())}`
            }
          >
            {freshness.stale
              ? `stale · ${formatRelative(new Date(freshness.observedAt).toISOString())}`
              : `observed ${formatRelative(new Date(freshness.observedAt).toISOString())}`}
          </span>
        )}
      </div>
    </>
  );
};
