/**
 * deployments — pure derivations for the v3.5 Deployments surface (T5 b-08).
 *
 * Reality (verified against the fleet route table + v35/05 §instance-model):
 * the multi-host admin lane has zero runtime basis — "Deployments: fleet APIs
 * discover instances on ONE host. Admin lane (R3-16) has zero runtime basis —
 * fully designed concept." So the surface renders ONE deployment (local ·
 * this host) derived live from /api/lines + /api/version + /livez, with
 * org-hub and pairing anatomies rendered as honest designed-states.
 */
import type { LineInstance } from '../types.js'
import { channelOf } from './transport-identity.js'

export type DeploymentState = 'healthy' | 'degraded' | 'crit'

/** Worst-of line statuses. unreachable/config_error escalate to crit;
 *  degraded/unknown/logged_out read as warn; an empty fleet is healthy by
 *  definition (nothing is wrong yet — honest zero). */
export function deploymentStateOf(lines: readonly LineInstance[]): DeploymentState {
  let sawWarn = false
  for (const line of lines) {
    if (line.status === 'unreachable' || line.status === 'config_error') return 'crit'
    if (line.status !== 'online') sawWarn = true
  }
  return sawWarn ? 'degraded' : 'healthy'
}

export function countOnline(lines: readonly LineInstance[]): number {
  return lines.filter((l) => l.status === 'online').length
}

/** Channel histogram across the fleet (mini-tags: wa ×8 · signal ×2 …). */
export function channelCountsOf(lines: readonly LineInstance[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of lines) {
    const k = channelOf(line)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return counts
}

/** Compact channel labels for mini-tags (full names live in CHANNEL_LABEL). */
export const CHANNEL_SHORT: Record<string, string> = {
  wa: 'wa',
  signal: 'signal',
  imessage: 'imsg',
  sms: 'sms',
  email: 'email',
  discord: 'discord',
  x: 'x',
  unknown: 'channel',
}

export function agentLinesOf(lines: readonly LineInstance[]): LineInstance[] {
  return lines.filter((l) => l.mode === 'agent')
}

export function issueLinesOf(lines: readonly LineInstance[]): LineInstance[] {
  return lines.filter((l) => l.status !== 'online')
}

/** Uptime in the mockup's coarse register: 21d · 6h · 12m (never fabricated
 *  precision the source doesn't carry). */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  if (d >= 1) return `${d}d`
  const h = Math.floor(seconds / 3600)
  if (h >= 1) return `${h}h`
  const m = Math.floor(seconds / 60)
  if (m >= 1) return `${m}m`
  return `${Math.floor(seconds)}s`
}

/** First two names + "+N" overflow — the mockup's mini-tag overflow recipe. */
export function miniTagOverflow(names: readonly string[], show = 2): { shown: string[]; overflow: number } {
  return { shown: names.slice(0, show), overflow: Math.max(0, names.length - show) }
}
