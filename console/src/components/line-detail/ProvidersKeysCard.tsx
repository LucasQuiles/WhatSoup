import { type FC } from 'react'
import { motion } from 'framer-motion'
import { KeyRound, ShieldOff, ShieldCheck, Zap } from 'lucide-react'
import { useProviders, useProviderStatus } from '../../hooks/use-fleet'
import { getProvider } from '../../lib/providers'
import type { ProviderCatalogEntry, ProviderSlotStatus } from '../../types'

/**
 * Human "in Xs / Xm / Xh" string for a future epoch-ms revert time.
 * format-time.ts only models past timestamps ("Xm ago"), so the fallback
 * countdown is formatted locally here.
 */
function formatRevertIn(activeUntil: number | null): string {
  if (activeUntil === null) return 'soon'
  const remainingMs = activeUntil - Date.now()
  if (remainingMs <= 0) return 'now'
  const s = Math.floor(remainingMs / 1000)
  if (s < 60) return `in ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  return `in ${h}h`
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
      ? { label: 'key set', icon: KeyRound, color: 'var(--color-s-ok)', bg: 'var(--s-ok-wash)' }
      : keyPresent === false
      ? { label: 'no key', icon: ShieldOff, color: 'var(--color-s-crit)', bg: 'var(--s-crit-wash)' }
      : { label: 'n/a — native auth', icon: ShieldCheck, color: 'var(--color-t3)', bg: 'var(--color-d4)' }
  const Icon = spec.icon
  return (
    <span
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
}> = ({ label, slot, catalog, border }) => (
  <div className={`flex items-center justify-between py-[var(--sp-1h)] px-0${border ? ' c-border-b' : ''}`}>
    <span className="c-label">{label}</span>
    <span className="flex items-center gap-[var(--sp-2)]">
      <span className="font-mono text-m-agt text-data">{displayName(slot.provider, catalog)}</span>
      <span className="font-mono text-t3 text-data">{slot.model ?? '—'}</span>
      <KeyBadge keyPresent={slot.keyPresent} />
    </span>
  </div>
)

export const ProvidersKeysCard: FC<{ lineName: string }> = ({ lineName }) => {
  const { data: status, isLoading, error } = useProviderStatus(lineName)
  const { data: catalog } = useProviders()

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="c-card overflow-hidden"
    >
      <div className="c-toolbar bg-d3 c-border-b">
        <span className="c-col-header text-t4">Providers &amp; Keys</span>
      </div>
      <div className="py-[var(--sp-3)] px-[var(--sp-4)]">
        {error ? (
          <div className="text-s-crit text-sm">Failed to load provider status.</div>
        ) : isLoading || !status ? (
          <div className="text-t4 text-sm">Loading provider status…</div>
        ) : (
          <>
            <SlotRow label="primary" slot={status.primary} catalog={catalog} border />
            <SlotRow label="fallback" slot={status.fallback} catalog={catalog} border={status.fallback.active} />
            {status.fallback.provider ? (
              status.fallback.active ? (
                <div className="flex items-center gap-[var(--sp-1h)] pt-[var(--sp-2)] text-s-warn text-sm">
                  <Zap size={13} strokeWidth={1.75} />
                  <span>Fallback active — reverts {formatRevertIn(status.fallback.activeUntil)}</span>
                </div>
              ) : (
                <div className="text-t4 pt-[var(--sp-2)] text-sm">fallback configured</div>
              )
            ) : (
              <div className="text-t4 pt-[var(--sp-2)] text-sm">no fallback</div>
            )}
          </>
        )}
      </div>
    </motion.div>
  )
}
