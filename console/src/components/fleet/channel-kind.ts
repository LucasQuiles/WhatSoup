/**
 * channel-kind (T5 b-03; converged onto transport-identity at the b-13 gate) —
 * the fleet glyph vocabulary. The base transport→channel mapping and its copy
 * live once, in `console/src/lib/transport-identity.ts`; this module extends
 * that vocabulary with the channels only the fleet glyph column renders, and
 * keeps the shape-mandatory fallback (the column must draw something).
 *
 * The convergence both PRs flagged (b-03's fleet-local map vs b-07's
 * console-wide home) is resolved in this direction because the inbox glyph set
 * is pinned to its own mockup SSOT — widening the shared `TransportChannel`
 * union would force glyph paths the inbox mockup does not specify.
 */
import { channelOf, baileysFallbackChannel, CHANNEL_LABEL as BASE_CHANNEL_LABEL } from '../../lib/transport-identity';
import type { TransportChannel } from '../../lib/transport-identity';
import type { LineInstance } from '../../types';

/** Fleet glyph vocabulary — the shared channels plus the extra silhouettes the
 *  lines table can draw. 'unknown' is absent by construction (see below). */
export type ChannelKind =
  | Exclude<TransportChannel, 'unknown'>
  | 'telegram'
  | 'linkedin'
  | 'reddit'
  | 'instagram'
  | 'facebook'
  | 'slack'
  | 'teams';

/** Transport kinds the shared map leaves at 'unknown' that the fleet column can
 *  still draw honestly, plus the spellings only this surface accepts
 *  ('apple' for iMessage, 'mail' for email). */
const FLEET_ONLY_KINDS: Record<string, ChannelKind> = {
  telegram: 'telegram',
  linkedin: 'linkedin',
  reddit: 'reddit',
  instagram: 'instagram',
  facebook: 'facebook',
  slack: 'slack',
  teams: 'teams',
  apple: 'imessage',
  mail: 'email',
};

/** Map a line's transport identity to a glyph kind. Resolution order: the
 *  console-wide map, then the fleet-only extensions, then the documented
 *  Baileys fallback. Unknown kinds degrade to the sms bars with the off tag —
 *  never a wrong-channel glyph (honesty over silhouette coverage). */
export function channelKindOf(line: LineInstance): ChannelKind {
  const base = channelOf(line);
  if (base !== 'unknown') return base;
  const raw = line.health?.transport?.kind?.toLowerCase();
  if (raw && raw in FLEET_ONLY_KINDS) return FLEET_ONLY_KINDS[raw];
  return baileysFallbackChannel(line);
}

/** Per-transport display label for a glyph kind — the copy variants
 *  `hygiene.no-whatsapp-copy-in-generic-ui` exists to force: each channel names
 *  itself, so Signal/iMessage lines are never mislabeled. Shared channels
 *  inherit their copy from the console-wide home (one spelling per channel,
 *  product-wide); only the fleet-only channels are named here. */
export const CHANNEL_LABEL: Record<ChannelKind, string> = {
  wa: BASE_CHANNEL_LABEL.wa,
  signal: BASE_CHANNEL_LABEL.signal,
  imessage: BASE_CHANNEL_LABEL.imessage,
  sms: BASE_CHANNEL_LABEL.sms,
  discord: BASE_CHANNEL_LABEL.discord,
  x: BASE_CHANNEL_LABEL.x,
  email: BASE_CHANNEL_LABEL.email,
  telegram: 'Telegram',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  instagram: 'Instagram',
  facebook: 'Facebook',
  slack: 'Slack',
  teams: 'Teams',
};
