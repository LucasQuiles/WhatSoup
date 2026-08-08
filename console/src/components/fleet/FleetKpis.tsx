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
  /** True while the 24h fleet-metrics query is in flight (first load, no
   *  observation yet). The Tokens (24h) card renders a skeleton instead of
   *  collapsing the in-flight state into the em-dash no-data glyph. */
  isLoading: boolean;
  /** The 24h fleet-metrics query error, null when the query is clean. When
   *  set alongside a null tokens24h the Tokens (24h) card renders a query-error
   *  glyph that is visually distinct from the em-dash no-data state — the
   *  prior ternary erased this by mapping both to the em-dash. */
  queryError: Error | null;
  /** Instances that failed to report in the 24h fleet-metrics sweep. With
   *  instancesQueried this lets the Tokens (24h) card tell total fleet
   *  failure (all-failed) apart from a genuinely empty token store (no-data),
   *  which the prior ternary also collapsed into the em-dash. */
  instancesFailed: number;
  /** Denominator of the 24h fleet-metrics sweep (failed + succeeded). */
  instancesQueried: number;
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

export const FleetKpis: FC<FleetKpisProps> = ({
  kpis,
  lineCount,
  tokens24h,
  freshness,
  isLoading,
  queryError,
  instancesFailed,
  instancesQueried,
}) => {
  const messagesToday = kpis.totalSent + kpis.totalReceived;

  // Tokens (24h) state machine — five mutually-exclusive outputs. The prior
  // `tokens24h !== null ? formatCompact : <EM_DASH/>` ternary collapsed four
  // distinct conditions (query-failure / all-failed / no-data / normal) into
  // two outputs, erasing failure and partial-coverage signal. Each branch
  // below renders a distinct value glyph + subline so a caller can tell the
  // states apart by observable DOM (see fleet-kpis-token-states.test.tsx).
  //   loading      → skeleton (query in flight, no observation yet)
  //   normal       → fleet in+out sum (hasTokenData true → tokens24h !== null)
  //   query-error  → distinct glyph (query errored with no token data)
  //   all-failed   → distinct glyph (every queried instance failed → no data)
  //   no-data      → em-dash (query clean, not all failed, no token data)
  // Order is deliberate: show data when present (stale-while-revalidate, same
  // idiom as OpsMetrics carried-forward metrics), then surface the failure
  // cause only when there is no data to show — so a refetch error over stale
  // data keeps the value visible rather than flipping to an error glyph.
  const allInstancesFailed = instancesQueried > 0 && instancesFailed >= instancesQueried;
  let tokensV: ReactNode;
  let tokensD: ReactNode;
  let tokensTone: 'up' | 'dn' | undefined;
  if (isLoading) {
    tokensV = (
      <span
        data-testid="tokens-shimmer"
        aria-hidden="true"
        className="inline-block bg-[var(--surface-inset-v35)]"
        style={{
          width: '4ch',
          height: '1em',
          verticalAlign: '-0.15em',
          borderRadius: 'var(--chrome-micro-radius)',
        }}
      />
    );
    tokensD = 'loading\u2026';
    tokensTone = undefined;
  } else if (tokens24h !== null) {
    tokensV = formatCompact(tokens24h);
    tokensD = 'fleet in+out';
    tokensTone = undefined;
  } else if (queryError) {
    tokensV = (
      <span data-testid="tokens-query-error" style={{ color: 'var(--status-crit-fg)' }}>
        !
      </span>
    );
    tokensD = 'metrics query failed';
    tokensTone = 'dn';
  } else if (allInstancesFailed) {
    tokensV = (
      <span data-testid="tokens-all-failed" style={{ color: 'var(--status-warn-fg)' }}>
        {'\u2715'}
      </span>
    );
    tokensD = 'all instances failed';
    tokensTone = 'dn';
  } else {
    tokensV = <EM_DASH />;
    tokensD = 'no token data';
    tokensTone = undefined;
  }

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
        <Kpi k="Tokens (24h)" v={tokensV} d={tokensD} dTone={tokensTone} />
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
