/**
 * channel-kind (T5 b-03) — transport-identity → glyph-kind mapping, extracted
 * from ChannelGlyph so the component file exports only components
 * (react-refresh/only-export-components).
 */
import type { LineInstance } from '../../types';

export type ChannelKind =
  | 'wa'
  | 'signal'
  | 'imessage'
  | 'sms'
  | 'discord'
  | 'telegram'
  | 'x'
  | 'linkedin'
  | 'reddit'
  | 'instagram'
  | 'facebook'
  | 'email'
  | 'slack'
  | 'teams';

/** Map a line's transport identity (health.transport.kind, Baileys fallback)
 *  to a glyph kind. Unknown kinds degrade to the sms bars with the off tag —
 *  never a wrong-channel glyph (honesty over silhouette coverage). */
export function channelKindOf(line: LineInstance): ChannelKind {
  const raw = line.health?.transport?.kind?.toLowerCase();
  if (raw) {
    if (['baileys', 'whatsapp', 'wa'].includes(raw)) return 'wa';
    if (raw === 'signal') return 'signal';
    if (['imessage', 'imsg', 'apple'].includes(raw)) return 'imessage';
    if (['twilio', 'sms'].includes(raw)) return 'sms';
    if (raw === 'discord') return 'discord';
    if (raw === 'telegram') return 'telegram';
    if (['x', 'twitter'].includes(raw)) return 'x';
    if (raw === 'linkedin') return 'linkedin';
    if (raw === 'reddit') return 'reddit';
    if (raw === 'instagram') return 'instagram';
    if (raw === 'facebook') return 'facebook';
    if (['email', 'smtp', 'mail'].includes(raw)) return 'email';
    if (raw === 'slack') return 'slack';
    if (raw === 'teams') return 'teams';
  }
  // Baileys lines predate the generic transport block (types.ts §health).
  return line.health?.whatsapp ? 'wa' : 'sms';
}

/** Per-transport display label for a glyph kind — the copy variants the
 *  no-WhatsApp-presuming-copy rule exists to force: each channel names
 *  itself, so Signal/iMessage lines are never mislabeled. */
export const CHANNEL_LABEL: Record<ChannelKind, string> = {
  wa: 'WhatsApp',
  signal: 'Signal',
  imessage: 'iMessage',
  sms: 'SMS',
  discord: 'Discord',
  telegram: 'Telegram',
  x: 'X',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  instagram: 'Instagram',
  facebook: 'Facebook',
  email: 'Email',
  slack: 'Slack',
  teams: 'Teams',
};
