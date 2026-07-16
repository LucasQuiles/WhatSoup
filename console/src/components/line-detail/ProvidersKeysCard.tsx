import { type FC, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { KeyRound, ShieldOff, ShieldCheck, Zap } from 'lucide-react'
import EmptyState from '../EmptyState'
import { Card } from '../primitives'
import { useProviders, useProviderStatus } from '../../hooks/use-fleet'
import { formatRelative } from '../../lib/format-time'
import { getProvider, getProviderColor } from '../../lib/providers'
import { statusBadgeStyle } from '../../lib/status-severity'
import type { ProviderCatalogEntry, ProviderSlotStatus, ProviderStatus } from '../../types'

/**
 * Human "in Xs / Xm / Xh" string for a future epoch-ms revert time.
 * format-time.ts only models past timestamps ("Xm ago"), so the fallback
 * countdown is formatted locally here.
 */
function formatRevertIn(activeUntil: number | null, now: number): string {
  if (activeUntil === null) return 'soon'
  const remainingMs = activeUntil - now
  if (remainingMs <= 0) return 'now'
  const s = Math.floor(remainingMs / 1000)
  if (s < 60) return `in ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  return `in ${h}h`
}

function formatLastFallbackTurnAt(lastFallbackTurnAt: number | null): string | null {
  if (lastFallbackTurnAt === null || !Number.isFinite(lastFallbackTurnAt)) return null
  return `last turn ${formatRelative(new Date(lastFallbackTurnAt).toISOString())}`
}

/**
 * Read-only "Providers & Keys" card for the line-detail summary view.
 *
 * Consumes GET /api/lines/:name/provider-status (primary + fallback provider,
 * key presence, fallback-window state) and GET /api/providers (display names),
 * reusing the providers.ts catalog for any id the server catalog omits.
 *
 * Write actions (e.g. "set key") land with the credential-write backend in a
 * later PR; this surface stays read-only until then.
 */

/** Resolve a provider id to its human label, preferring the live server catalog. */
function displayName(
  id: string | null,
  catalog: ProviderCatalogEntry[] | undefined,
): string {
  if (!id) return '—'
  const fromServer = catalog?.find((p) => p.id === id)?.displayName
  if (fromServer) return fromServer
  return getProvider(id)?.displayName ?? id
}

/** Keyed/unkeyed/native-auth badge driven by the slot's `keyPresent` tri-state. */
const KeyBadge: FC<{ keyPresent: boolean | null }> = ({ keyPresent }) => {
  const spec =
    keyPresent === true
      ? { label: 'key set', icon: KeyRound, ...statusBadgeStyle('ok') }
      : keyPresent === false
      ? { label: 'no key', icon: ShieldOff, ...statusBadgeStyle('crit') }
      : { label: 'n/a — native auth', icon: ShieldCheck, color: 'var(--text-2)', bg: 'var(--surface-inset)' }
  const Icon = spec.icon
  return (
    <span
      title={spec.label}
      className="text-xs inline-flex items-center font-mono font-medium rounded-sm tracking-[var(--tracking-pill)] whitespace-nowrap gap-[var(--sp-0h)] py-[var(--bw)] px-[var(--sp-1h)]"
      style={{ color: spec.color, backgroundColor: spec.bg }}
    >
      <Icon size={9} strokeWidth={1.75} />
      {spec.label}
    </span>
  )
}

const SlotRow: FC<{
  label: string
  slot: ProviderSlotStatus
  catalog: ProviderCatalogEntry[] | undefined
  border?: boolean
}> = ({ label, slot, catalog, border }) => {
  const providerColor = getProviderColor(slot.provider ?? '').stroke
  return (
    <div className={`flex items-center justify-between py-[var(--sp-1h)] px-0${border ? ' c-border-b' : ''}`}>
      <span className="c-label">{label}</span>
      <span className="flex items-center gap-[var(--sp-2)]">
        <span className="font-mono text-data" style={{ color: providerColor }}>{displayName(slot.provider, catalog)}</span>
        <span className="font-mono text-text-2 text-data">{slot.model ?? '—'}</span>
        <KeyBadge keyPresent={slot.keyPresent} />
      </span>
    </div>
  )
}

type FallbackChainEntry = ProviderStatus['fallback']['chain'][number]

const ChainEntry: FC<{
  entry: FallbackChainEntry
  catalog: ProviderCatalogEntry[] | undefined
}> = ({ entry, catalog }) => {
  const providerColor = getProviderColor(entry.provider ?? '').stroke
  const status =
    entry.eligible === true ? 'ready' :
    entry.eligible === false ? 'unavailable' :
    'unknown'
  return (
    <span className="inline-flex items-center gap-[var(--sp-0h)] text-xs font-mono text-text-2">
      <span className="text-data" style={{ color: providerColor }}>{displayName(entry.provider, catalog)}</span>
      {entry.model && <span>{entry.model}</span>}
      <span>{status}</span>
    </span>
  )
}

/**
 * Staleness affordance (#1762 remediation 2). When the instance is `stale`
 * (the health poller is currently failing — see enrichInstance in
 * src/fleet/routes/lines.ts), the fallback counters and chain eligibility this
 * card renders are carried forward from the last successful poll. Tag them so
 * they are not misread as live, WITHOUT hiding the values (rem-1: link /
 * history persistence through an outage is the point).
 */
const StaleTag: FC<{ observedAt: string | null }> = ({ observedAt }) => (
  <span
    className="inline-flex items-center gap-[var(--sp-1)] text-xs font-mono text-s-warn"
    title={
      observedAt
        ? `Health carried forward — last live poll ${formatRelative(observedAt)}`
        : 'Health data is stale — the poller is currently failing'
    }
  >
    <span>stale</span>
    {observedAt && <span className="text-text-2">as of {formatRelative(observedAt)}</span>}
  </span>
)

export const ProvidersKeysCard: FC<{
  lineName: string
  /** Instance freshness flag threaded from SummaryTab (LineInstance.stale). */
  stale?: boolean
  /** ISO timestamp of the last live health observation (LineInstance.healthObservedAt). */
  healthObservedAt?: string | null
}> = ({ lineName, stale = false, healthObservedAt = null }) => {
  const { data: status, isLoading, error, refetch } = useProviderStatus(lineName)
  const { data: catalog } = useProviders()
  const [now, setNow] = useState(() => Date.now())

  const fallbackServerActive = !!status && status.lineReachable && status.fallback.active
  const fallbackActiveUntil = status?.fallback.activeUntil ?? null
  const fallbackActive = fallbackServerActive && (fallbackActiveUntil === null || now < fallbackActiveUntil)

  useEffect(() => {
    if (!fallbackActive) return
    const refresh = setTimeout(() => setNow(Date.now()), 0)
    const expiry = fallbackActiveUntil === null
      ? null
      : setTimeout(() => setNow(Date.now()), Math.max(0, fallbackActiveUntil - Date.now()))
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      clearTimeout(refresh)
      if (expiry !== null) clearTimeout(expiry)
      clearInterval(timer)
    }
  }, [fallbackActive, fallbackActiveUntil])

  const fallbackMetrics = status?.fallback.provider
    ? [
        typeof status.fallback.turnsServed === 'number' ? `${status.fallback.turnsServed} served` : null,
        typeof status.fallback.turnsEmpty === 'number' ? `${status.fallback.turnsEmpty} empty` : null,
        typeof status.fallback.probeAttempts === 'number' ? `${status.fallback.probeAttempts} probes` : null,
        formatLastFallbackTurnAt(status.fallback.lastFallbackTurnAt),
      ].filter((value): value is string => value !== null)
    : []
  const fallbackChain = status?.fallback.chain ?? []

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      <Card variant="base" className="overflow-hidden">
      <div className="c-toolbar bg-surface-raised c-border-b">
        <span className="c-col-header text-text-2">Providers &amp; Keys</span>
      </div>
      <div className="py-[var(--sp-3)] px-[var(--sp-4)]">
        {error ? (
          <EmptyState
            variant="error"
            title="Failed to load provider status"
            description={error.message}
            onRetry={() => { void refetch() }}
          />
        ) : isLoading || !status ? (
          <div className="text-text-2 text-sm">Loading provider status…</div>
        ) : (
          <>
            <SlotRow label="primary" slot={status.primary} catalog={catalog} border />
            <SlotRow label="fallback" slot={status.fallback} catalog={catalog} border={fallbackActive} />
            {status.fallback.provider ? (
              fallbackActive ? (
                <div className="flex items-center gap-[var(--sp-1h)] pt-[var(--sp-2)] text-s-warn text-sm">
                  <Zap size={13} strokeWidth={1.75} />
                  <span>Fallback active — reverts {formatRevertIn(status.fallback.activeUntil, now)}</span>
                </div>
              ) : (
                <div className="text-text-2 pt-[var(--sp-2)] text-sm">fallback configured</div>
              )
            ) : (
              <div className="text-text-2 pt-[var(--sp-2)] text-sm">no fallback</div>
            )}
            {fallbackMetrics.length > 0 && (
              <div
                className="flex flex-wrap items-center gap-[var(--sp-2)] pt-[var(--sp-1)] text-text-2 text-xs font-mono"
                style={stale ? { opacity: 'var(--opacity-muted)' } : undefined}
              >
                {fallbackMetrics.map((metric) => (
                  <span key={metric}>{metric}</span>
                ))}
                {stale && <StaleTag observedAt={healthObservedAt} />}
              </div>
            )}
            {fallbackChain.length > 1 && (
              <div
                className="flex flex-wrap items-center gap-[var(--sp-2)] pt-[var(--sp-1)] text-text-2 text-xs"
                style={stale ? { opacity: 'var(--opacity-muted)' } : undefined}
              >
                <span className="c-label">chain</span>
                {fallbackChain.map((entry, index) => (
                  <ChainEntry
                    key={`${entry.provider}:${entry.model ?? ''}:${index}`}
                    entry={entry}
                    catalog={catalog}
                  />
                ))}
                {stale && <StaleTag observedAt={healthObservedAt} />}
              </div>
            )}
          </>
        )}
      </div>
      </Card>
    </motion.div>
  )
}
