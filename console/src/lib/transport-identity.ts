/**
 * transport-identity (T5 b-07/b-08) — the console-wide home for transport→channel
 * identity. The two hygiene rules (no-whatsapp-copy-in-generic-ui,
 * no-health-whatsapp-key-read) allowlist THIS one file: every consumer routes
 * through these accessors instead of hardcoding a transport's name or reading
 * the legacy health.whatsapp key directly.
 *
 * Vocabulary note: b-03's fleet-local channel-kind.ts carries the same mapping
 * with a wider glyph set; when the b-03 and b-07 branches both land, one of the
 * two homes converges onto the other (flagged on both PRs — the mapping is
 * byte-compatible: baileys→wa, signal, imessage, twilio→sms).
 */
import type { LineInstance } from '../types.js'

export type TransportChannel =
  | 'wa'
  | 'signal'
  | 'imessage'
  | 'sms'
  | 'email'
  | 'discord'
  | 'x'
  | 'unknown'

/** Map a line's transport kind (health.transport.kind, documented Baileys
 *  fallback below) to a channel. Unknown/absent kinds stay honest — never
 *  guess a channel from thin air. */
export function channelOf(line: LineInstance | undefined): TransportChannel {
  const raw = line?.health?.transport?.kind?.toLowerCase()
  switch (raw) {
    case 'baileys':
    case 'whatsapp':
    case 'wa':
      return 'wa'
    case 'signal':
      return 'signal'
    case 'imessage':
    case 'imsg':
      return 'imessage'
    case 'twilio':
    case 'sms':
      return 'sms'
    case 'email':
    case 'smtp':
      return 'email'
    case 'discord':
      return 'discord'
    case 'x':
    case 'twitter':
      return 'x'
    default:
      return 'unknown'
  }
}

/** Per-transport display label — each channel names itself here, so generic
 *  UI never hardcodes one transport's name (the rule's reason to exist). */
export const CHANNEL_LABEL: Record<TransportChannel, string> = {
  wa: 'WhatsApp',
  signal: 'Signal',
  imessage: 'iMessage',
  sms: 'SMS',
  email: 'Email',
  discord: 'Discord',
  x: 'X',
  unknown: 'Channel',
}

/** Transport connected state: the generic transport block first; the legacy
 *  health.whatsapp read lives here alone as the documented Baileys fallback
 *  (types.ts §health — non-Baileys transports emit only the generic block).
 *  null when no health snapshot exists at all (never fabricated). */
export function transportConnectedOf(line: LineInstance | undefined): boolean | null {
  if (!line?.health) return null
  return line.health.transport?.connected ?? line.health.whatsapp?.connected ?? null
}
