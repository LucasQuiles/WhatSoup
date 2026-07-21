import { normalizePhoneIdentityInput, validatePhoneIdentityInput } from './validation'

export type TransportKind = 'baileys' | 'twilio' | 'signal' | 'imessage'

const SIGNAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const APPLEID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeWirePhoneIdentity(value: string): string {
  const normalized = normalizePhoneIdentityInput(value)
  return normalized ? `+${normalized}` : ''
}

export interface TransportEntry {
  readonly token: string
  readonly label: string
  readonly subLabel: string
  readonly transportClass: string
  readonly cardLabel: string
  readonly cardDescription: string
  readonly adminIdLabel: string
  readonly adminIdPlaceholder: string
  readonly adminIdHelper: string
  readonly validateAdminId: (value: string) => boolean
  readonly normalizeAdminId: (value: string) => string
}

export const TRANSPORT_MAP: Readonly<Record<TransportKind, TransportEntry>> = {
  baileys: {
    token: '--mode-passive-solid',
    label: 'WhatsApp',
    subLabel: 'Baileys',
    transportClass: 'soup-transport soup-transport--baileys',
    cardLabel: 'WhatsApp (Baileys)',
    cardDescription: 'QR-code pairing, multi-device.',
    adminIdLabel: 'Admin Phones',
    adminIdPlaceholder: 'Enter phone number',
    adminIdHelper: 'Phone numbers with full admin access. Use international format.',
    validateAdminId: (value) => validatePhoneIdentityInput(value),
    normalizeAdminId: (value) => normalizePhoneIdentityInput(value),
  },
  twilio: {
    token: '--mode-chat-solid',
    label: 'WhatsApp',
    subLabel: 'Twilio',
    transportClass: 'soup-transport soup-transport--twilio',
    cardLabel: 'WhatsApp (Twilio)',
    cardDescription: 'Cloud-hosted WhatsApp through Twilio.',
    adminIdLabel: 'Admin Phones',
    adminIdPlaceholder: 'Enter phone number',
    adminIdHelper: 'Phone numbers with full admin access. Use international format.',
    validateAdminId: (value) => validatePhoneIdentityInput(value),
    normalizeAdminId: (value) => normalizePhoneIdentityInput(value),
  },
  signal: {
    token: '--status-ok-solid',
    label: 'Signal',
    subLabel: 'signal-cli',
    transportClass: 'soup-transport soup-transport--signal',
    cardLabel: 'Signal',
    cardDescription: 'A local signal-cli JSON-RPC daemon.',
    adminIdLabel: 'Admin Signal IDs',
    adminIdPlaceholder: '+14155551234 or UUID',
    adminIdHelper: 'Use an E.164 phone number or Signal UUID.',
    validateAdminId: (value) => validatePhoneIdentityInput(value) || SIGNAL_UUID_RE.test(value.trim().toLowerCase()),
    normalizeAdminId: (value) => {
      const normalized = value.trim().toLowerCase()
      return SIGNAL_UUID_RE.test(normalized) ? normalized : normalizeWirePhoneIdentity(normalized)
    },
  },
  imessage: {
    token: '--mode-agent-solid',
    label: 'iMessage',
    subLabel: '',
    transportClass: 'soup-transport soup-transport--imessage',
    cardLabel: 'iMessage',
    cardDescription: 'A macOS imsg or BlueBubbles backend.',
    adminIdLabel: 'Admin iMessage IDs',
    adminIdPlaceholder: 'name@example.com or +14155551234',
    adminIdHelper: 'Use a lowercase AppleID email or E.164 phone number.',
    validateAdminId: (value) => validatePhoneIdentityInput(value) || APPLEID_EMAIL_RE.test(value.trim().toLowerCase()),
    normalizeAdminId: (value) => {
      const normalized = value.trim().toLowerCase()
      return APPLEID_EMAIL_RE.test(normalized) ? normalized : normalizeWirePhoneIdentity(normalized)
    },
  },
}

export const TRANSPORT_KINDS: readonly TransportKind[] = ['baileys', 'twilio', 'signal', 'imessage']

export function isTransportKind(value: unknown): value is TransportKind {
  return typeof value === 'string' && Object.hasOwn(TRANSPORT_MAP, value)
}

export function resolveTransport(value: string | null | undefined): TransportEntry {
  if (!value) return TRANSPORT_MAP.baileys
  if (isTransportKind(value)) return TRANSPORT_MAP[value]
  return { ...TRANSPORT_MAP.baileys, label: value, subLabel: 'unknown' }
}
