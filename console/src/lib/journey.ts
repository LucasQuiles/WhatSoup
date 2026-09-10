import { CHANNEL_LABEL } from './transport-identity.js'

/**
 * journey — local vocabulary for the v3.5 hatch journey (T5 b-10).
 * Channel display names come from the transport-identity home (hygiene law).
 *
 * What lives here vs the server: kind presets and the name wordlist are
 * journey-local by design (14-onboarding §1/§3). Providers and provider-native
 * models come from the fleet catalogue APIs, outside this vocabulary module.
 */

/** Step-1 kind presets (14-onboarding §1: 4 archetype cards, one hint). */
export interface KindPreset {
  id: string
  label: string
  desc: string
  /** Server line type (create payload). */
  type: 'passive' | 'chat' | 'agent'
  /** Seed soul (claudeMd, agent) or system prompt (chat) — editable at step 3. */
  soulSeed: string
  hint?: boolean
}

export const KIND_PRESETS: KindPreset[] = [
  {
    id: 'community',
    label: 'Community',
    desc: 'Keeps a room tidy, answers fast, never sleeps.',
    type: 'agent',
    soulSeed: 'Keeps the community room tidy, answers fast, never sleeps.',
    hint: true,
  },
  {
    id: 'responder',
    label: 'Chat responder',
    desc: 'Replies in your voice on a single channel.',
    type: 'chat',
    soulSeed: 'You are a concise, warm responder. Answer directly; never speculate.',
  },
  {
    id: 'assistant',
    label: 'Personal assistant',
    desc: 'A calm operator for reminders, drafts, and lookups.',
    type: 'agent',
    soulSeed: 'A calm personal operator — handles reminders, drafts, and lookups with care.',
  },
  {
    id: 'custom',
    label: 'Custom',
    desc: 'Blank persona — write the soul yourself.',
    type: 'agent',
    soulSeed: '',
  },
]

/** Dice wordlist — single-word names; line names slugify from the display form. */
export const NAME_WORDLIST = [
  'Quinn', 'Lumen', 'Beacon', 'Mercy', 'Sable', 'Forge', 'Wren', 'Iris',
  'Holt', 'Sage', 'North', 'Vale', 'Ash', 'Briar', 'Cove', 'Dune',
  'Ember', 'Finch', 'Glen', 'Harbor', 'Juniper', 'Kestrel', 'Lark', 'Moss',
] as const

export function rerollName(current: string): string {
  const pool = NAME_WORDLIST.filter((n) => n !== current)
  return pool[Math.floor(Math.random() * pool.length)] ?? NAME_WORDLIST[0]!
}

/** Display name → line name (server rule: /^[a-z][a-z0-9-]*$/, 2–30). */
export function slugifyName(display: string): string {
  return display
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 30)
}

/** Channel tiles: only baileys is API-creatable today (createLine has no
 *  transport field; PATCH 409s transport changes). Every other tile renders
 *  disabled with the honest note — never a selectable fake. */
export interface ChannelTile {
  id: string
  label: string
  enabled: boolean
  note?: string
}

export const CHANNEL_TILES: ChannelTile[] = [
  { id: 'baileys', label: CHANNEL_LABEL.wa, enabled: true },
  { id: 'signal', label: 'Signal', enabled: false, note: 'CLI provisioning only — the API cannot create signal lines today' },
  { id: 'imessage', label: 'iMessage', enabled: false, note: 'CLI provisioning only — the API cannot create imessage lines today' },
  { id: 'twilio', label: 'SMS', enabled: false, note: 'CLI provisioning only — the API cannot create twilio lines today' },
  { id: 'telegram', label: 'Telegram', enabled: false, note: 'No transport exists for this channel yet' },
  { id: 'discord', label: 'Discord', enabled: false, note: 'No transport exists for this channel yet' },
  { id: 'email', label: 'Email', enabled: false, note: 'No transport exists for this channel yet' },
  { id: 'x', label: 'X', enabled: false, note: 'No transport exists for this channel yet' },
]

/** Step rail label for the crumb ctx (kept beside the step vocabulary). */
export function journeyStepLabel(current: number): string {
  return ['KIND', 'CHANNEL', 'AGENT', 'LINK', 'HATCH'][current] ?? 'HATCH'
}
