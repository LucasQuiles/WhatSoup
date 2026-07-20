/**
 * transport-meta.ts — ONE canonical transport map for the SOUP console.
 *
 * Mirrors the status-map.ts pattern (badge.md "One canonical map"): every
 * transport-kind renderer imports from here. The map is the single rendering
 * driver for transport identity across the wizard picker, TransportBadge,
 * LineDetail header, and the fleet table.
 *
 * Transport kinds match the server-side ChannelKind / TransportId registry
 * landed in PR #1975 (foundation-clean) — `baileys` | `twilio` | `signal` |
 * `imessage`. The console treats the kind as an opaque string from the
 * server's perspective (the `/api/fleet/lines` response carries the line's
 * transport in its config block); this module is the only place that maps a
 * kind to display metadata.
 *
 * Admin-ID validation is per-transport (S2 design): baileys/twilio use E.164
 * phones, signal accepts E.164 OR UUID, imessage accepts E.164 OR AppleID
 * email. The validators here are the client-side mirror of the server-side
 * `normalizeAdminIdsForTransport` in src/fleet/routes/ops.ts (PR 4a, S9).
 */

// ---------------------------------------------------------------------------
// Closed union type
// ---------------------------------------------------------------------------

export type TransportKind = 'baileys' | 'twilio' | 'signal' | 'imessage';

/** Sentinel for "no transport chosen yet" in the wizard picker. */
export const TRANSPORT_UNSET: unique symbol = Symbol.for('whatsoup.transport.unset');
export type TransportOrUnset = TransportKind | typeof TRANSPORT_UNSET;

// ---------------------------------------------------------------------------
// Admin-ID validation
// ---------------------------------------------------------------------------

// Signal UUID v4 (canonical 8-4-4-4-12 hex, case-insensitive). Mirrors the
// server-side SIGNAL_UUID_RE in src/transport/signal/types.ts.
const SIGNAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// AppleID email (loose: local@domain, since AppleIDs are email-shaped).
const APPLEID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalize a phone to E.164-style digits (client-side mirror of validatePhone). */
function normalizePhoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Validate E.164-style phone (10-15 digits after stripping non-digits). */
function isValidPhone(value: string): boolean {
  const d = normalizePhoneDigits(value);
  return d.length >= 10 && d.length <= 15;
}

// ---------------------------------------------------------------------------
// Transport entry
// ---------------------------------------------------------------------------

export interface TransportEntry {
  /** CSS custom property name (without `var()`) for the badge colour. */
  readonly token: string;
  /** Human-visible label (e.g. "WhatsApp", "Signal"). */
  readonly label: string;
  /** Sub-label for the badge, when distinguishable (e.g. "Baileys", "Twilio"). */
  readonly subLabel: string;
  /** Transport CSS class (primitives.css `soup-transport--<kind>`). */
  readonly transportClass: string;
  /** Wizard picker card label. */
  readonly cardLabel: string;
  /** Wizard picker card description. */
  readonly cardDescription: string;
  /** Admin-ID field label for the IdentityStep. */
  readonly adminIdLabel: string;
  /** Admin-ID field placeholder. */
  readonly adminIdPlaceholder: string;
  /** Admin-ID field helper copy. */
  readonly adminIdHelper: string;
  /** Per-transport admin-ID validator (client-side mirror of S9). */
  readonly validateAdminId: (value: string) => boolean;
  /** Normalize an admin-ID for storage (strip formatting, but pass through non-phone shapes). */
  readonly normalizeAdminId: (value: string) => string;
}

/**
 * Map: TransportKind to rendering + admin-ID metadata.
 *
 * Colour tokens reuse the existing semantic palette rather than introducing
 * brand colours (avoiding licensing concerns per design doc §3). Mode-green =
 * WhatsApp/Baileys; mode-chat (cyan) = Twilio; mode-agent (purple) = iMessage;
 * status-ok (green) for Signal (distinct from Baileys' teal).
 */
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
    adminIdHelper: 'Phone numbers with full admin access. Use international format without the +.',
    validateAdminId: isValidPhone,
    normalizeAdminId: (v) => normalizePhoneDigits(v),
  },
  twilio: {
    token: '--mode-chat-solid',
    label: 'WhatsApp',
    subLabel: 'Twilio',
    transportClass: 'soup-transport soup-transport--twilio',
    cardLabel: 'WhatsApp (Twilio)',
    cardDescription: 'API credentials, cloud-hosted.',
    adminIdLabel: 'Admin Phones',
    adminIdPlaceholder: 'Enter phone number',
    adminIdHelper: 'Phone numbers with full admin access. Use international format without the +.',
    validateAdminId: isValidPhone,
    normalizeAdminId: (v) => normalizePhoneDigits(v),
  },
  signal: {
    token: '--status-ok-solid',
    label: 'Signal',
    subLabel: 'signal-cli',
    transportClass: 'soup-transport soup-transport--signal',
    cardLabel: 'Signal',
    cardDescription: 'signal-cli daemon on this host.',
    adminIdLabel: 'Admin Signal IDs',
    adminIdPlaceholder: '+14155551234 or UUID',
    adminIdHelper: 'Signal verifies sender identity at the protocol level. Admin IDs are E.164 phone numbers or Signal UUIDs.',
    validateAdminId: (v) => isValidPhone(v) || SIGNAL_UUID_RE.test(v.trim()),
    normalizeAdminId: (v) => {
      const t = v.trim();
      return SIGNAL_UUID_RE.test(t) ? t : normalizePhoneDigits(t);
    },
  },
  imessage: {
    token: '--mode-agent-solid',
    label: 'iMessage',
    subLabel: '',
    transportClass: 'soup-transport soup-transport--imessage',
    cardLabel: 'iMessage',
    cardDescription: 'macOS host with BlueBubbles or imsg.',
    adminIdLabel: 'Admin iMessage IDs',
    adminIdPlaceholder: 'user@icloud.com or +14155551234',
    adminIdHelper: 'iMessage verifies sender identity via AppleID. Admin IDs are AppleID emails or E.164 phone numbers.',
    validateAdminId: (v) => isValidPhone(v) || APPLEID_EMAIL_RE.test(v.trim()),
    normalizeAdminId: (v) => v.trim(),
  },
} as const;

// ---------------------------------------------------------------------------
// Safe look-up helpers
// ---------------------------------------------------------------------------

/**
 * Return the TransportEntry for a known kind, or a fail-visible unknown
 * entry carrying the raw value as label (mirrors resolveStatus semantics).
 *
 * Transport defaults to `baileys` when the input is empty/undefined — this
 * preserves back-compat for lines whose server config predates the transport
 * field (the foundation PR defaults `transport: 'baileys'` in the config
 * schema, but a carried-forward health body may omit it).
 */
export function resolveTransport(value: string | null | undefined): TransportEntry {
  if (!value) return TRANSPORT_MAP.baileys;
  if (value in TRANSPORT_MAP) return TRANSPORT_MAP[value as TransportKind];
  // Fail-visible: unknown kinds fall back to baileys rendering but expose the
  // raw value via the label. This is defensive — the server registry is the
  // authority, and unknown kinds here mean the client is newer than the
  // server (forward-compat scenario).
  return { ...TRANSPORT_MAP.baileys, label: value, subLabel: 'unknown' };
}

/** Type guard: is the value a known transport kind? */
export function isTransportKind(value: unknown): value is TransportKind {
  return typeof value === 'string' && value in TRANSPORT_MAP;
}

/** All transport kinds in stable display order (wizard picker order). */
export const TRANSPORT_KINDS: readonly TransportKind[] = ['baileys', 'twilio', 'signal', 'imessage'];
