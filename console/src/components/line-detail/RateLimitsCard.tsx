import { type FC } from 'react'
import { Card, Pill, Button } from '../primitives'
import { useRateLimits } from '../../hooks/use-fleet'
import { formatRelative } from '../../lib/format-time'

/**
 * RateLimitsCard — live per-line throttle surface (D-5, PDR-5 corrected).
 * Spec: oc-re/specs/2026-07-19-rate-limits-surface-spec.md
 *
 * The `rate_limits` table is per-SENDER chat throttling (successful
 * responses vs the line's configured limit), NOT provider quota. Pills:
 * Throttled (crit when >0), Near limit (warn when >0), Excess attempts
 * (attempts − responses in window = retry/token-storm waste, #1864 class;
 * warn when >0). Fail-closed: a fleet read error renders an error panel
 * with Retry — never fake-zero pills (PDR-3 invariant). Hidden entirely
 * when the instance tables are unsupported (legacy DBs).
 */

function senderTail(jid: string): string {
  return jid.split('@')[0] ?? jid
}

export const RateLimitsCard: FC<{ lineName: string }> = ({ lineName }) => {
  const { data, isLoading, refetch, freshness } = useRateLimits(lineName)

  // Unsupported tables (legacy DB) — the card has nothing honest to say.
  if (data && data.supported === false) return null

  const limit = data?.limit ?? 0
  const limitSource = data?.limitSource ?? 'default'
  const zeroActivity = data && data.throttled === 0 && data.nearLimit === 0 && data.excessAttempts === 0

  return (
    <Card variant="base" className="overflow-hidden">
      <div className="flex items-center justify-between c-toolbar bg-surface-raised c-border-b">
        <span className="c-col-header text-text-2">Rate Limits</span>
        <span
          className={`c-label${freshness.stale || data?.readError ? ' text-s-warn' : ''}`}
          title={data ? `observed ${data.observedAt}` : undefined}
        >
          {data?.readError
            ? 'read unavailable'
            : data
              ? `observed ${formatRelative(data.observedAt)}${freshness.stale ? ' (stale)' : ''}`
              : 'not observed'}
        </span>
      </div>

      <div className="py-[var(--sp-3)] px-[var(--sp-4)]">
        {isLoading || !data ? (
          <span className="c-label">Loading…</span>
        ) : data.readError ? (
          <div className="flex items-center justify-between">
            <span className="c-label text-s-warn">
              Rate-limit data unavailable — the fleet could not read this instance's database.
            </span>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>Retry</Button>
          </div>
        ) : (
          <>
            <div className="flex items-center flex-wrap gap-[var(--sp-2)] mb-[var(--sp-2)]">
              <Pill
                variant="static"
                tone={data.throttled > 0 ? 'crit' : 'neutral'}
                size="sm"
              >
                {`Throttled ${data.throttled}`}
              </Pill>
              <Pill
                variant="static"
                tone={data.nearLimit > 0 ? 'warn' : 'neutral'}
                size="sm"
              >
                {`Near limit ${data.nearLimit}`}
              </Pill>
              <span
                title={`${data.excessAttempts} LLM attempts produced no successful response in the window — retry/token-storm waste`}
              >
                <Pill
                  variant="static"
                  tone={data.excessAttempts > 0 ? 'warn' : 'neutral'}
                  size="sm"
                >
                  {`Excess attempts ${data.excessAttempts}`}
                </Pill>
              </span>
              <span className="c-label text-text-2">
                {`${limitSource} ${limit}/h`}
              </span>
            </div>
            {zeroActivity ? (
              <span className="c-label text-text-2">No senders near the limit this window.</span>
            ) : (
              <div className="flex flex-col">
                {data.topSenders.map((s) => (
                  <div key={s.senderJid} className="flex items-center justify-between py-[var(--sp-1h)]">
                    <span className="font-mono text-data" title={s.senderJid}>
                      {senderTail(s.senderJid)}
                    </span>
                    <span className={`font-mono text-data${s.count >= limit ? ' text-s-crit' : s.count >= Math.max(1, Math.floor(limit * 0.8)) ? ' text-s-warn' : ''}`}>
                      {`${s.count}/${limit}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

export default RateLimitsCard
