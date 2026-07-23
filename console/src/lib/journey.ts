/**
 * journey — local vocabulary for the v3.5 hatch journey (T5 b-10).
 *
 * What lives here vs the server: kind presets and the name wordlist are
 * journey-local by design (14-onboarding §1/§3); providers and models wire
 * to the real catalog endpoint (GET /api/providers) with curated model
 * lists per the wizard precedent (the catalog does not enumerate models).
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

/** Curated model options per provider id (wizard precedent: the catalog
 *  does not enumerate models). Free-text fallback for CLI providers whose
 *  model strings are runtime-resolved. */
export const PROVIDER_MODELS: Record<string, Array<{ value: string; label: string }>> = {
  'claude-cli': [
    { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
    { value: 'claude-opus-4-6', label: 'claude-opus-4-6' },
    { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5' },
  ],
  'anthropic-api': [
    { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
    { value: 'claude-opus-4-6', label: 'claude-opus-4-6' },
    { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5' },
  ],
  'openai-api': [
    { value: 'gpt-4.1', label: 'gpt-4.1' },
    { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
    { value: 'gpt-4.1-nano', label: 'gpt-4.1-nano' },
  ],
}

export function defaultModelFor(providerId: string): string {
  return PROVIDER_MODELS[providerId]?.[0]?.value ?? ''
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
  { id: 'baileys', label: 'WhatsApp', enabled: true },
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
