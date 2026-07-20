// src/core/transport-refs.ts

/** Transport library / protocol family. */
export type ChannelKind =
  | 'whatsapp'
  | 'telegram'
  | 'sms'
  | 'signal'
  | 'imessage';
  // future: 'discord'

declare const __channelIdBrand: unique symbol;

/**
 * Per-account channel identity. Branded string of the form `${ChannelKind}:${accountName}`.
 * Examples: 'whatsapp:mw-bot', 'telegram:studio-bot'.
 *
 * Constructed via makeChannelId(); raw string assignment is a type error.
 */
export type ChannelId = string & { readonly [__channelIdBrand]: true };

/** Channel account segment pattern — shared with config validation. */
export const ACCOUNT_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * AppleID email shape — iMessage accepts iCloud / me.com / mac.com
 * addresses plus any email registered against an AppleID. We accept any
 * RFC-5322-ish shape here; the daemon/Server is the final arbiter.
 *
 * Defined in core (the transport-refs seam) so core config validation can
 * use it without a core→transport edge; re-exported by
 * src/transport/imessage/types.ts for transport-internal consumers.
 */
export const APPLEID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function makeChannelId(kind: ChannelKind, account: string): ChannelId {
  if (!ACCOUNT_RE.test(account)) {
    throw new Error(`invalid account segment: ${JSON.stringify(account)} (must match ${ACCOUNT_RE.source})`);
  }
  return `${kind}:${account}` as ChannelId;
}

export function kindOf(id: ChannelId): ChannelKind {
  return id.split(':', 1)[0] as ChannelKind;
}

export function accountOf(id: ChannelId): string {
  const i = id.indexOf(':');
  return id.slice(i + 1);
}

export interface ConversationRef {
  readonly channel: ChannelId;
  readonly id: string;
}

export interface ParticipantRef {
  readonly channel: ChannelId;
  readonly id: string;
}

export interface MessageRef {
  readonly channel: ChannelId;
  readonly conversation: string;
  readonly id: string;
}

export function refToKey(r: ConversationRef): string {
  return `${r.channel}:${r.id}`;
}

export function msgToKey(m: MessageRef): string {
  return `${m.channel}:${m.conversation}:${m.id}`;
}
